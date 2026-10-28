/**
 * Which SUBSCRIPTION ACCOUNT a drive's pass will bill against — resolved by
 * `drive.ts`, first at arm time and again on the heartbeat timer whenever no
 * pass is actively running, for the rest of the drive's life.
 *
 * WHY THIS EXISTS. `drive.ts` spawns the pass by argv directly — never through
 * a shell (see `drive.ts`'s own top-of-file comment) — so an account-switching
 * shell wrapper that injects `CLAUDE_CODE_OAUTH_TOKEN` (for example `claude() {
 * CLAUDE_CODE_OAUTH_TOKEN="$(account-switcher token)" command claude "$@"; }`)
 * never runs for a driver: the pass inherits whatever `CLAUDE_CODE_OAUTH_TOKEN`
 * / `ANTHROPIC_API_KEY` (or `~/.claude.json` `oauthAccount`, or
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) THIS PROCESS's environment held the
 * moment it was spawned. Resolving from `drives.ts` or the status board instead
 * would read a DIFFERENT process's environment — this driver's own, not the
 * pass's — so the read has to happen here and be carried in the claim's
 * diagnostics for every later reader (the claim's PR, worktree, log and start
 * time all work the same way).
 *
 * ONE READ IS NOT ENOUGH FOR EVERY BRANCH, THOUGH. `CLAUDE_CODE_OAUTH_TOKEN`
 * is this process's own environment and therefore genuinely fixed for the
 * drive's whole life — resolving it once at arm time is correct. But the
 * file-backed path (`oauthAccount` / `CODEX_HOME` auth, i.e. no token set)
 * is LIVE FILE CONTENT the pass re-reads on every fresh spawn: an operator's
 * `/login`, or the wrapper's own login swap, mid-drive changes which account the
 * NEXT pass actually bills against, while a value resolved only once at arm
 * time would keep reporting the OLD one for the rest of the drive's life —
 * defeating the whole point of this module in exactly the scenario its own
 * account-switching wrapper example opens with. `drive.ts`
 * closes that gap by re-calling `resolveAccountIdentity` on its existing
 * heartbeat timer and rewriting the claim when the answer changes
 * (`refreshAccountIdentity`, `drive.ts`) — but only while no pass is
 * actively running, so an already-spawned pass's displayed identity holds
 * steady for its whole life instead of being overwritten mid-pass with the
 * account the NEXT pass would use —
 * this module itself stays a pure, stateless resolver and knows nothing
 * about when it gets called again.
 *
 * VENDOR COMES FROM THE PASS COMMAND'S OWN ARGV[0], NEVER FROM PROBING EVERY
 * VENDOR'S STATE. `lib/quota/index.ts` deliberately does the opposite for
 * wall DETECTION — it runs every adapter and lets absent state yield nothing,
 * because inferring vendor from an arbitrary pass command is "a guess, and a
 * wrong guess reads as 'no quota wall' and re-arms straight into the wall
 * again" (that module's own comment). That reasoning does not transfer here.
 * There, a wrong guess costs a missed detection; here, a wrong guess
 * ATTRIBUTES BILLING TO THE WRONG VENDOR'S ACCOUNT — actively wrong, not
 * merely cautious. And it would not even be a guess: `drive.ts` spawns argv
 * directly, so argv[0] is exactly the binary that is about to run.
 *
 * NEVER A GUESS. Every resolver here either reads a real, on-disk identity
 * record or returns `null` with a stated reason — there is no fallback that
 * invents an account from an unrelated signal (the account switcher's own
 * "active account" record included: it names whichever account was active in
 * the switcher's OWN state at whatever moment something last asked it, not
 * necessarily the account that minted the token this process happens to hold —
 * see the wrapper comment above for why the two can diverge).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type AccountVendor = "claude" | "codex";

/** Every field required, same discipline as `ClaimDiag` (`lib/claim.ts`):
 * a resolver that cannot answer says so explicitly via `reason`, rather than
 * omitting a field a reader would otherwise have to treat as ambiguous. */
export interface AccountIdentity {
  /** The resolved identity (an email address, or a Codex `account_id` when
   * no email claim is available) — `null` when nothing could be resolved. */
  account: string | null;
  /** Which pass vendor this identity was resolved for — `null` when the pass
   * command did not name a recognized vendor at all. */
  vendor: AccountVendor | null;
  /** How `account` was resolved, e.g. `CLAUDE_CODE_OAUTH_TOKEN`,
   * `oauthAccount`, `CODEX_HOME auth.json` — present whether or not
   * `account` itself resolved, so a `null` account still says what was
   * tried. */
  provenance: string;
  /** Populated only when `account` is `null` — why nothing resolved. Never
   * used to manufacture a value; only to explain its absence. */
  reason: string | null;
}

function resolved(
  vendor: AccountVendor,
  account: string,
  provenance: string,
): AccountIdentity {
  return { account, vendor, provenance, reason: null };
}

function unresolved(
  vendor: AccountVendor | null,
  provenance: string,
  reason: string,
): AccountIdentity {
  return { account: null, vendor, provenance, reason };
}

/**
 * `$CLAUDE_CONFIG_DIR/.claude.json`, or `~/.claude.json` when unset. Mirrors
 * `lib/quota/claude.ts`'s `projectsRoot()` — same env var, same override
 * semantics — because `CLAUDE_CONFIG_DIR` relocates the whole config
 * directory `.claude.json` lives in, not just `projects/` (confirmed against
 * the installed Claude Code binary's own path-join: `.claude.json` sits
 * directly inside the effective config dir, exactly where `projects/` does).
 */
function effectiveClaudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir !== undefined && configDir !== ""
    ? join(configDir, ".claude.json")
    : join(homedir(), ".claude.json");
}

/**
 * `oauthAccount.emailAddress` from a `.claude.json` file, or `null` when the
 * file is missing, unparsable, or carries no such field — never thrown, same
 * "shape-check, degrade to null" discipline as `lib/claim.ts`'s `parseDiag`.
 */
function readOauthAccountEmail(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauthAccount = (parsed as Record<string, unknown>).oauthAccount;
  if (typeof oauthAccount !== "object" || oauthAccount === null) return null;
  const email = (oauthAccount as Record<string, unknown>).emailAddress;
  return typeof email === "string" && email !== "" ? email : null;
}

/** First 12 hex characters of the token's sha256 — enough to DISTINGUISH two
 * tokens (and therefore two accounts) side by side in a listing, never
 * enough to recover the token itself. Never verified against anything: this
 * is a display label, not an authorization decision, same posture as
 * `jwtEmailClaim` below. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Resolve the Claude identity from the effective `.claude.json` — OR, when
 * `CLAUDE_CODE_OAUTH_TOKEN` is set, from the token itself.
 *
 * These are genuinely two different reads, not one read with two labels. The
 * token, when set, is the account actually in effect, and `~/.claude.json`'s
 * `oauthAccount` can go STALE relative to it — exactly the account-switching
 * wrapper scenario this module's header comment opens with: the wrapper mints a
 * fresh token from whichever account is active in the switcher's OWN state, and
 * `~/.claude.json` reflects the LAST account a real `/login` (or the switcher's
 * own login swap) wrote, which can be a different one. There is no mechanical
 * way to decode an opaque bearer token back into an account without a network
 * round-trip this arm-time read must not make — so this reports a FINGERPRINT
 * of the token as `account` (distinguishes two drivers on two different tokens,
 * which is the whole point: the operator must be able to tell which drivers are
 * about to stop) and folds `oauthAccount`'s read into `provenance` as a
 * labelled, explicitly-hedged hint rather than the reported identity. Reporting
 * `oauthAccount` itself as the token's account would silently misattribute
 * billing the moment the two diverge — the exact failure this module exists to
 * make visible, not reproduce.
 */
function resolveClaudeIdentity(): AccountIdentity {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  if (token !== "") {
    const email = readOauthAccountEmail(effectiveClaudeJsonPath());
    const hint =
      email !== null
        ? `; oauthAccount reads ${email}, which may be a different, staler account than the token's`
        : "";
    return resolved(
      "claude",
      `token:${tokenFingerprint(token)}`,
      `CLAUDE_CODE_OAUTH_TOKEN${hint}`,
    );
  }
  // Claude Code's other alternative-auth env var: API-KEY billing, a COMPLETELY
  // DIFFERENT mode from a Claude subscription — pay-per-token against whichever
  // Anthropic Console account owns the key, tracked by Anthropic entirely
  // separately from a `.claude.json` OAuth session. Falling through to
  // `oauthAccount` here would attribute API-billed work to an unrelated
  // subscription. Same fingerprint treatment as the OAuth token above, for the
  // same reason: there is no mechanical way to turn an opaque secret into an
  // account without a network round-trip this arm-time read must not make, and
  // a fingerprint still discriminates concurrent drivers on different keys
  // without exposing the key itself.
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (apiKey !== "") {
    return resolved(
      "claude",
      `api-key:${tokenFingerprint(apiKey)}`,
      "ANTHROPIC_API_KEY",
    );
  }
  const path = effectiveClaudeJsonPath();
  const email = readOauthAccountEmail(path);
  if (email === null) {
    return unresolved(
      "claude",
      "oauthAccount",
      `no oauthAccount.emailAddress in ${path}`,
    );
  }
  return resolved("claude", email, "oauthAccount");
}

/**
 * `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` when unset — the same
 * override `lib/quota/codex.ts`'s `sessionsRoot()` reads.
 */
function effectiveCodexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME;
  return codexHome !== undefined && codexHome !== ""
    ? join(codexHome, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

/**
 * The `email` claim from a JWT's payload segment — read, never verified: no
 * key material is available here, and this is a display label, not an
 * authorization decision. `null` on anything that does not parse as a JWT
 * (at least a header and a payload segment) carrying a JSON payload with a
 * non-empty string `email`.
 */
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
  } catch {
    return null;
  }
}

/**
 * Resolve the Codex identity from `$CODEX_HOME/auth.json`'s
 * `tokens.id_token` (a JWT carrying an `email` claim, measured on this
 * machine's own `auth.json`) — falling back to `tokens.account_id` (a bare
 * UUID, no email) when no email claim is available, so a reader gets an
 * identifier rather than nothing when the JWT shape changes. Or, when
 * `OPENAI_API_KEY` is set in THIS process's environment, from the key
 * itself — Codex's own sibling to `resolveClaudeIdentity`'s
 * `ANTHROPIC_API_KEY` branch above, same reason: `passEnv()` forwards this
 * process's environment unchanged to a `codex` pass, so a key-authenticated
 * pass bills against the Console account that owns the key, never against
 * whatever `auth.json` happens to hold — reading `auth.json` regardless
 * would attribute API-billed work to an unrelated leftover ChatGPT identity,
 * or report `unknown`. Or, when
 * no env var is set but the CLI's own supported `codex login --with-api-key`
 * flow persisted the key instead, from THAT — verified against a real login
 * run into an isolated `$CODEX_HOME`: that flow writes
 * `{"auth_mode":"apikey","OPENAI_API_KEY":"<key>"}` at the top level, no
 * `tokens` at all, and never touches the environment, so without this branch
 * such a pass fell through to the `tokens`-based reads below — which this
 * `auth_mode` never populates — and reported `unknown` even though it was
 * billing an API account.
 */
function resolveCodexIdentity(): AccountIdentity {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (apiKey !== "") {
    return resolved(
      "codex",
      `api-key:${tokenFingerprint(apiKey)}`,
      "OPENAI_API_KEY",
    );
  }
  const path = effectiveCodexAuthPath();
  const provenance = "CODEX_HOME auth.json";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return unresolved("codex", provenance, `${path} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unresolved("codex", provenance, `${path} did not parse as JSON`);
  }
  const parsedObj =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (parsedObj?.auth_mode === "apikey") {
    const persistedKey = parsedObj.OPENAI_API_KEY;
    if (typeof persistedKey === "string" && persistedKey !== "") {
      return resolved(
        "codex",
        `api-key:${tokenFingerprint(persistedKey)}`,
        `${provenance} (auth_mode: apikey)`,
      );
    }
  }
  const tokens = parsedObj?.tokens;
  const tokensObj =
    typeof tokens === "object" && tokens !== null
      ? (tokens as Record<string, unknown>)
      : undefined;
  const idToken = tokensObj?.id_token;
  const email = typeof idToken === "string" ? jwtEmailClaim(idToken) : null;
  if (email !== null) return resolved("codex", email, provenance);
  const accountId = tokensObj?.account_id;
  if (typeof accountId === "string" && accountId !== "") {
    return resolved(
      "codex",
      accountId,
      `${provenance} (account_id — no email claim)`,
    );
  }
  return unresolved(
    "codex",
    provenance,
    `${path} carries no id_token email claim or account_id`,
  );
}

/**
 * A trailing platform binary extension, stripped so `claude.exe`/`codex.cmd`
 * match the same way the extension-less Unix names do.
 */
const BINARY_EXT_RE = /\.(exe|cmd|bat|ps1)$/i;

/**
 * The vendor a pass command names, from its own argv[0] alone — see this
 * file's header comment for why that is the right signal here and not a
 * guess.
 */
export function passVendor(passArgv: readonly string[]): AccountVendor | null {
  const first = passArgv[0];
  if (first === undefined || first === "") return null;
  const name = basename(first).replace(BINARY_EXT_RE, "");
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  return null;
}

/** Resolve the account a pass command will bill against — see this file's
 * header comment for the full design. */
export function resolveAccountIdentity(
  passArgv: readonly string[],
): AccountIdentity {
  const vendor = passVendor(passArgv);
  if (vendor === "claude") return resolveClaudeIdentity();
  if (vendor === "codex") return resolveCodexIdentity();
  // Only argv[0]'s basename, never the full command line: an unrecognized
  // pass command can be an operator's own wrapper (`env VAR=secret claude
  // -p ...`), and this reason string is persisted into the claim file on
  // disk and echoed by every `drives.ts` listing and exit-11 refusal for the
  // life of the drive — embedding the whole argv would leak whatever that
  // wrapper's own arguments carried.
  const label =
    passArgv[0] !== undefined && passArgv[0] !== ""
      ? basename(passArgv[0])
      : "(empty)";
  return unresolved(
    null,
    "pass command",
    `pass command '${label}' does not name a recognized vendor (claude/codex)`,
  );
}

/**
 * The account a pass bills, as a stable hash: what a quota park records and a
 * re-arm compares, so the state file names whose wall it is without carrying
 * an email address or a token fingerprint in clear. `null` when the identity
 * did not resolve: an unknown account is never equal to another.
 */
export function accountHash(identity: AccountIdentity): string | null {
  if (identity.account === null || identity.vendor === null) return null;
  const digest = createHash("sha256")
    .update(`${identity.vendor}:${identity.account}`)
    .digest("hex");
  return `acct-${digest.slice(0, 16)}`;
}

/** The shape `accountHash` produces, for the readers of a stored hash. */
export function isAccountHash(value: unknown): value is string {
  return typeof value === "string" && /^acct-[0-9a-f]{16}$/.test(value);
}

/**
 * One-line, log-shaped rendering of an identity — shared by `drive.ts`'s
 * exit-11 refusal message and `drives.ts`'s human listing, so writer and
 * reader can never drift apart (the same reason `lib/claim.ts` gives for
 * sharing `claimLive` between `drive.ts` and `drives.ts`).
 */
export function formatAccountIdentity(identity: AccountIdentity): string {
  if (identity.account !== null) {
    const vendor = identity.vendor ?? "unknown vendor";
    return `${identity.account} (${vendor}, from ${identity.provenance})`;
  }
  return `unknown (${identity.reason})`;
}
