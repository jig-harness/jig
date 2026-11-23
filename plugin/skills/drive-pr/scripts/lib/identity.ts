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
import { basename } from "node:path";
import {
  type AccountIdentity,
  type HarnessName,
  harnessOfProgram,
  programList,
} from "../../../../shared/agent-harness/index.ts";
import { unresolved } from "../../../../shared/agent-harness/account-identity.ts";

/** The harness an account bills through, by its registered name (`shared/agent-harness`). */
export type AccountVendor = HarnessName;

/** Every field required, same discipline as `ClaimDiag` (`lib/claim.ts`):
 * a resolver that cannot answer says so explicitly via `reason`, rather than
 * omitting a field a reader would otherwise have to treat as ambiguous. The
 * readers are each harness's own (`accountIdentity`). */
export type { AccountIdentity };

/**
 * The vendor a pass command names, from its own argv[0] alone — see this
 * file's header comment for why that is the right signal here and not a
 * guess.
 */
export function passVendor(passArgv: readonly string[]): AccountVendor | null {
  return harnessOfProgram(passArgv[0])?.name ?? null;
}

/** Resolve the account a pass command will bill against — see this file's
 * header comment for the full design. */
export function resolveAccountIdentity(
  passArgv: readonly string[],
): AccountIdentity {
  const harness = harnessOfProgram(passArgv[0]);
  if (harness !== null) return harness.accountIdentity(process.env);
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
    `pass command '${label}' does not name a recognized vendor (${programList()})`,
  );
}

/** The labels `tokenFingerprint` identities carry. */
const CREDENTIAL_FINGERPRINT = /^(token|api-key):/;

/**
 * The account a pass bills, as a stable hash: what a quota park records and a
 * re-arm compares, so the stored state names whose wall it is without carrying
 * an email address in clear. `null` when the identity did not resolve, and
 * when it is only a credential's fingerprint (`token:`, `api-key:`): two
 * credentials can bill one account, and one account can switch between a
 * token and a file-backed login, so a fingerprint is a display label and
 * never proves which account a wall belongs to. An unknown account is never
 * equal to another.
 */
export function accountHash(identity: AccountIdentity): string | null {
  if (identity.account === null || identity.vendor === null) return null;
  if (CREDENTIAL_FINGERPRINT.test(identity.account)) return null;
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
