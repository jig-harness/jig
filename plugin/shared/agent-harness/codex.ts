/**
 * Codex behind the agent-harness interface (`port.ts`).
 *
 * A headless pass is `codex exec <prompt>`: the bypass only on a host that
 * opted in to it (`drive.codex_bypass`), then the host's
 * `drive.codex_pass_args`, kept on the launch record at admission, then the
 * model (`-m`) and effort (its `model_reasoning_effort` setting). Codex runs
 * a skill the prompt names, so its prompt names the skill before the
 * invocation. It mints its own session id and prints it at its start. A
 * launch sets the account's directory in `CODEX_HOME`; Codex marks its
 * sessions with variables named `CODEX_…`. Its walls are read by drive-pr's
 * Codex quota adapter, keyed `codex`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMapping } from "../config-layers.ts";
import { swallow } from "../errors.ts";
import { failed } from "../outcome.ts";
import { isoFromMs } from "../time.ts";
import { resolved, tokenFingerprint, unresolved } from "./account-identity.ts";
import { routeWords } from "./route-words.ts";
import type {
  AccountIdentity,
  AgentHarness,
  HarnessCapabilities,
  HarnessEnvironment,
  InteractiveRequest,
  PassRequest,
  TranscriptQuery,
} from "./port.ts";

const NAME = "codex";

type Env = Record<string, string | undefined>;

/** The words Codex's command line runs without a sandbox and without asking. */
export const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

const DAY_MS = 86_400_000;
/** The most rollouts of one day a transcript search reads. */
const SEARCH_ENTRIES = 5000;
const SESSION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when unset: the same override the quota adapter's `sessions/` read honours. */
function effectiveCodexAuthPath(env: Env): string {
  const codexHome = env.CODEX_HOME;
  return codexHome !== undefined && codexHome !== ""
    ? join(codexHome, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

/** The `email` claim of a JWT's payload, read and never verified: a display label, not an authorization decision. */
function jwtEmailClaim(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (payload === undefined || payload === "") return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad =
      base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    const json = Buffer.from(base64 + pad, "base64").toString("utf8");
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return null;
    const email = (claims as Record<string, unknown>).email;
    return typeof email === "string" && email !== "" ? email : null;
  } catch (error) {
    swallow(error, "the id token carries no readable email claim");
    return null;
  }
}

/**
 * The Codex identity from `$CODEX_HOME/auth.json`'s `tokens.id_token` (a JWT
 * with an `email` claim), else `tokens.account_id`. `OPENAI_API_KEY` in the
 * environment is API billing against the key's owner and wins; so does a key
 * `codex login --with-api-key` persisted (`auth_mode: apikey`), which writes
 * no `tokens` at all.
 */
function accountIdentity(env: Env): AccountIdentity {
  const apiKey = env.OPENAI_API_KEY ?? "";
  if (apiKey !== "")
    return resolved(
      NAME,
      `api-key:${tokenFingerprint(apiKey)}`,
      "OPENAI_API_KEY",
    );
  const path = effectiveCodexAuthPath(env);
  const auth = readAuth(path);
  return "unresolved" in auth
    ? auth.unresolved
    : authIdentity(path, auth.value);
}

const PROVENANCE = "CODEX_HOME auth.json";

/** `auth.json` read and parsed, or the identity that says why it could not be. */
function readAuth(
  path: string,
): { value: unknown } | { unresolved: AccountIdentity } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      unresolved: unresolved(NAME, PROVENANCE, `${path} could not be read`),
    };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      unresolved: unresolved(NAME, PROVENANCE, `${path} did not parse as JSON`),
    };
  }
}

function mapping(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The identity a parsed `auth.json` names: a persisted key, the id token's email, else the account id. */
function authIdentity(path: string, parsed: unknown): AccountIdentity {
  const auth = mapping(parsed);
  const persistedKey = auth?.OPENAI_API_KEY;
  if (
    auth?.auth_mode === "apikey" &&
    typeof persistedKey === "string" &&
    persistedKey !== ""
  )
    return resolved(
      NAME,
      `api-key:${tokenFingerprint(persistedKey)}`,
      `${PROVENANCE} (auth_mode: apikey)`,
    );
  const tokens = mapping(auth?.tokens);
  const idToken = tokens?.id_token;
  const email = typeof idToken === "string" ? jwtEmailClaim(idToken) : null;
  if (email !== null) return resolved(NAME, email, PROVENANCE);
  const accountId = tokens?.account_id;
  if (typeof accountId === "string" && accountId !== "")
    return resolved(
      NAME,
      accountId,
      `${PROVENANCE} (account_id — no email claim)`,
    );
  return unresolved(
    NAME,
    PROVENANCE,
    `${path} carries no id_token email claim or account_id`,
  );
}

/** The escape character a terminal's color codes start with. */
const ESC = String.fromCharCode(27);

/** `text` without a terminal's color codes. */
function withoutColor(text: string): string {
  return text
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("");
}

function threadId(line: string): string | null {
  if (!line.startsWith("{") || !line.includes('"thread.started"')) return null;
  try {
    const event: unknown = JSON.parse(line);
    return isMapping(event) &&
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
      ? event.thread_id
      : null;
  } catch (error) {
    swallow(error, "Codex's startup event does not read as JSON");
    return null;
  }
}

/** The session id from Codex's text header (`session id: …`) or its JSON startup event. */
export function codexSessionIn(text: string | undefined): string | null {
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = withoutColor(raw).trim();
    const id = /^session id:\s*(\S+)$/i.exec(line)?.[1] ?? threadId(line);
    if (id !== null && SESSION.test(id)) return id.toLowerCase();
  }
  return null;
}

/** Codex's rollout of the session, in the day directories around when the run was made. */
function transcript(query: TranscriptQuery): string | null {
  const suffix = `-${query.session}.jsonl`;
  for (const offset of [0, -1, 1]) {
    const [year, month, day] = isoFromMs(query.startedMs + offset * DAY_MS)
      .slice(0, 10)
      .split("-") as [string, string, string];
    const dir = join(query.configDir, "sessions", year, month, day);
    let found: string | null = null;
    let entries = 0;
    query.walk(dir, (entry) => {
      if (++entries > SEARCH_ENTRIES) return false;
      if (entry.isFile() && entry.name.endsWith(suffix))
        found = join(dir, entry.name);
      return found === null;
    });
    if (found !== null) return found;
  }
  return null;
}

function model(value: string): string[] {
  return ["-m", value];
}

function effort(value: string): string[] {
  return ["-c", `model_reasoning_effort="${value}"`];
}

function route(request: {
  model?: string | null;
  effort?: string | null;
}): string[] {
  return routeWords(request, model, effort);
}

const environment: HarnessEnvironment = {
  directoryVariable: "CODEX_HOME",
  credentialVariables: ["OPENAI_API_KEY"],
  isSessionMarker: (variable) => variable.startsWith("CODEX_"),
  sessionMarkers: (configDir) => ({ CODEX_HOME: configDir }),
};

const capabilities: HarnessCapabilities = {
  sessionId: "printed",
  turnCap: false,
  bypassOptIn: true,
  hostArgsAt: "admission",
  signInProbe: false,
  backgroundTasks: false,
  subagents: true,
  hooks: true,
  slashCommands: false,
  permissionModes: false,
  structuredQuestion: false,
  usage: false,
  classifyStop: false,
};

const NOT_SUPPLIED = (operation: string) =>
  failed(
    "not-supplied" as const,
    `Codex's ${operation} is not read yet: no caller needs it`,
  );

export const codex: AgentHarness = {
  name: NAME,
  label: "Codex",
  program: "codex",
  runtime: "codex",
  identify: () => ({
    name: NAME,
    label: "Codex",
    program: "codex",
    runtime: "codex",
    versions: null,
  }),
  passCommand: (request: PassRequest) => [
    "codex",
    "exec",
    ...(request.bypass === true ? [CODEX_BYPASS] : []),
    ...(request.hostArgs ?? []),
    ...route(request),
    request.prompt,
  ],
  interactiveCommand: (request: InteractiveRequest) => [
    "codex",
    ...route(request),
    request.prompt,
  ],
  resumeCommand: (session) => ["codex", "resume", session],
  skillPrompt: (invocation) => {
    const skill = /^\/(\S+)/.exec(invocation)?.[1] ?? invocation;
    return `Use the ${skill} skill: ${invocation}`;
  },
  model,
  effort,
  modelFlags: ["--model", "-m"],
  withModel: (argv, value) => {
    const at = argv[1] === "exec" ? 2 : 1;
    return [...argv.slice(0, at), ...model(value), ...argv.slice(at)];
  },
  environment,
  accountIdentity,
  wallReader: NAME,
  sessionIdIn: codexSessionIn,
  transcript,
  usage: () => NOT_SUPPLIED("usage"),
  classifyStop: () => NOT_SUPPLIED("stop classification"),
  capabilities,
};
