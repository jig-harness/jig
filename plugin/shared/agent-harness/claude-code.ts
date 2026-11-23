/**
 * Claude Code behind the agent-harness interface (`port.ts`).
 *
 * A headless pass is `claude -p <prompt>`, with the session id the launch
 * minted (`--session-id`), the model and effort, then the host's
 * `drive.pass_args` before `-p`. A plugin skill runs from its slash
 * command, so a prompt carries the invocation as written. A launch sets the
 * account's directory in `CLAUDE_CONFIG_DIR`; Claude Code marks its own
 * sessions with `CLAUDECODE`. Its walls are read by drive-pr's Claude quota
 * adapter, keyed `claude`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { swallow } from "../errors.ts";
import { failed } from "../outcome.ts";
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

const NAME = "claude";

type Env = Record<string, string | undefined>;

/** The most project directories a transcript search reads. */
const SEARCH_ENTRIES = 5000;

/**
 * `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` when unset: the
 * variable relocates the whole configuration directory `.claude.json` lives
 * in, the same override the quota adapter's `projects/` read honours.
 */
function effectiveClaudeJsonPath(env: Env): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && configDir !== ""
    ? join(configDir, ".claude.json")
    : join(homedir(), ".claude.json");
}

/** `oauthAccount.emailAddress` from a `.claude.json` file, or `null` when the file is missing, unparsable or carries none. */
function readOauthAccountEmail(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    swallow(error, "no .claude.json to read an account from");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    swallow(error, ".claude.json does not read as JSON");
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauthAccount = (parsed as Record<string, unknown>).oauthAccount;
  if (typeof oauthAccount !== "object" || oauthAccount === null) return null;
  const email = (oauthAccount as Record<string, unknown>).emailAddress;
  return typeof email === "string" && email !== "" ? email : null;
}

/**
 * The Claude identity from the effective `.claude.json`, or, when
 * `CLAUDE_CODE_OAUTH_TOKEN` is set, from the token itself.
 *
 * The token, when set, is the account in effect, and `oauthAccount` can be
 * stale relative to it: an account-switching wrapper mints the token from
 * the account active in its own state, while `.claude.json` reflects the last
 * login. An opaque token cannot be turned into an account without a network
 * round-trip, so the token's fingerprint is the account and `oauthAccount`'s
 * read is a hedged hint in `provenance`. `ANTHROPIC_API_KEY` is API billing,
 * a different mode from a subscription, and gets the same fingerprint.
 */
function accountIdentity(env: Env): AccountIdentity {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  if (token !== "") {
    const email = readOauthAccountEmail(effectiveClaudeJsonPath(env));
    const hint =
      email !== null
        ? `; oauthAccount reads ${email}, which may be a different, staler account than the token's`
        : "";
    return resolved(
      NAME,
      `token:${tokenFingerprint(token)}`,
      `CLAUDE_CODE_OAUTH_TOKEN${hint}`,
    );
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (apiKey !== "")
    return resolved(
      NAME,
      `api-key:${tokenFingerprint(apiKey)}`,
      "ANTHROPIC_API_KEY",
    );
  const path = effectiveClaudeJsonPath(env);
  const email = readOauthAccountEmail(path);
  if (email === null)
    return unresolved(
      NAME,
      "oauthAccount",
      `no oauthAccount.emailAddress in ${path}`,
    );
  return resolved(NAME, email, "oauthAccount");
}

function sessionWords(sessionId: string | null | undefined): string[] {
  return sessionId == null ? [] : ["--session-id", sessionId];
}

function model(value: string): string[] {
  return ["--model", value];
}

function effort(value: string): string[] {
  return ["--effort", value];
}

function route(request: {
  model?: string | null;
  effort?: string | null;
}): string[] {
  return routeWords(request, model, effort);
}

const environment: HarnessEnvironment = {
  directoryVariable: "CLAUDE_CONFIG_DIR",
  credentialVariables: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  isSessionMarker: (variable) => variable === "CLAUDECODE",
  sessionMarkers: () => ({ CLAUDECODE: "1" }),
};

const capabilities: HarnessCapabilities = {
  sessionId: "minted",
  turnCap: true,
  bypassOptIn: false,
  hostArgsAt: "launch",
  signInProbe: true,
  backgroundTasks: true,
  subagents: true,
  hooks: true,
  slashCommands: true,
  permissionModes: true,
  structuredQuestion: true,
  usage: false,
  classifyStop: false,
};

/** Claude Code's transcript of the session under the account's directory, in any project. */
function transcript(query: TranscriptQuery): string | null {
  const root = join(query.configDir, "projects");
  let found: string | null = null;
  let entries = 0;
  query.walk(root, (entry) => {
    if (++entries > SEARCH_ENTRIES) return false;
    if (!entry.isDirectory()) return true;
    const path = join(root, entry.name, `${query.session}.jsonl`);
    if (existsSync(path)) found = path;
    return found === null;
  });
  return found;
}

const NOT_SUPPLIED = (operation: string) =>
  failed(
    "not-supplied" as const,
    `Claude Code's ${operation} is not read yet: no caller needs it`,
  );

export const claudeCode: AgentHarness = {
  name: NAME,
  label: "Claude Code",
  program: "claude",
  runtime: "claude-code",
  identify: () => ({
    name: NAME,
    label: "Claude Code",
    program: "claude",
    runtime: "claude-code",
    versions: null,
  }),
  passCommand: (request: PassRequest) => [
    "claude",
    ...sessionWords(request.sessionId),
    ...route(request),
    ...(request.hostArgs ?? []),
    "-p",
    request.prompt,
  ],
  interactiveCommand: (request: InteractiveRequest) => [
    "claude",
    ...sessionWords(request.sessionId),
    ...route(request),
    request.prompt,
  ],
  resumeCommand: (session) => ["claude", "--resume", session],
  skillPrompt: (invocation) => invocation,
  model,
  effort,
  modelFlags: ["--model"],
  withModel: (argv, value, firstAt) => {
    const at = firstAt ?? 1;
    return [...argv.slice(0, at), ...model(value), ...argv.slice(at)];
  },
  environment,
  accountIdentity,
  wallReader: NAME,
  sessionIdIn: () => null,
  transcript,
  usage: () => NOT_SUPPLIED("usage"),
  classifyStop: () => NOT_SUPPLIED("stop classification"),
  capabilities,
};
