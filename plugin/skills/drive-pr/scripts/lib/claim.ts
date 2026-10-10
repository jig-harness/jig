/**
 * The claim-file FORMAT of drive.ts's single-instance locks, and the liveness
 * rule that interprets one — shared with `drives.ts`, the read-only operator
 * surface, so the writer and the reader cannot drift apart. The
 * PROTOCOL (staging + rename, retire-by-name, recovery) stays in `drive.ts`:
 * this module knows what one claim file says and whether its owner counts as
 * live, never what taking or retiring one means.
 *
 * A claim is `claim.<nonce>` inside the lock directory. Line 1 is
 * `<pid> <hostname>` — the liveness identity, exactly what it always held, and
 * everything the protocol ever reads. Line 2, when present, is one JSON object
 * of OPERATOR DIAGNOSTICS: which PR the owner is driving, from which worktree,
 * since when, and where its durable log is. Diagnostics are advisory by
 * design: a claim with no second line (or an unparsable one) is a valid claim
 * whose owner has nothing to show — never a protocol error — so refusals and
 * listings degrade to pid/host, and nothing that decides liveness or recovery
 * reads line 2. Before an earlier change the record was pid/host only, which is why an
 * exit-11 refusal could name its holder but not what that holder was doing;
 * the do-issue arming step documented that as an ambiguity a human had to
 * resolve by hand.
 */

import { hostname } from "node:os";
import { isDigits } from "./cli.ts";
import type { AccountIdentity, AccountVendor } from "./identity.ts";
import { pidAlive } from "./proc.ts";

export const CLAIM_PREFIX = "claim.";

export function claimName(nonce: string): string {
  return `${CLAIM_PREFIX}${nonce}`;
}

/** The diagnostics line — every field required, either a string or (for
 * `account`) a shape-checked nested object; none optional. */
export interface ClaimDiag {
  /** PR number the owner is driving. */
  pr: string;
  /** `git rev-parse --show-toplevel` of the tree the owner works. */
  worktree: string;
  /** The owner's durable log file (driver narrative, not pass output). */
  log: string;
  /** ISO timestamp of the acquisition. */
  started: string;
  /** The billing account identity — resolved at arm time and
   * re-resolved on `drive.ts`'s heartbeat timer whenever no pass is
   * actively running; see `./identity.ts` for how and why. */
  account: AccountIdentity;
}

export interface ClaimRecord {
  pid: number;
  host: string;
  diag: ClaimDiag | null;
}

/**
 * Serialize a claim. The diagnostics object is written compactly on one line,
 * so line 1 stays the whole identity and a reader that only splits tokens
 * (every older parser) still lands on the same pid and host.
 */
export function formatClaim(
  pid: number,
  host: string,
  diag?: ClaimDiag,
): string {
  const head = `${pid} ${host}\n`;
  return diag === undefined ? head : `${head}${JSON.stringify(diag)}\n`;
}

/**
 * A claim written before an earlier change has no `account` key at all — a
 * legitimate TRANSITIONAL shape (an already-running driver upgraded out
 * from under, mid-drive), not corruption. Unlike a genuinely malformed
 * `account` value (`parseAccount` below, which still degrades the WHOLE
 * diag — the same "torn write or future format" reasoning `parseDiag`
 * already applies to every other field), an absent key degrades only THIS
 * one field: `pr`/`worktree`/`log`/`started` stay readable.
 *
 * That distinction is load-bearing, not cosmetic. Degrading the whole diag
 * for a merely-absent `account` (an earlier revision of this file did)
 * broke two live consumers of a pre-upgrade claim mid-drive: `drives.ts
 * --stop` refuses on `diag === null` ("claim predates an earlier change"), and
 * `ownParentDriver` (`drives.ts`) requires `diag !== null` to recognise a
 * pass as its own parent driver — a `null` diag there reproduces the
 * an earlier change stand-down bug (the pass reads its own driver as a
 * rival and burns the whole round budget refusing). Both only need
 * `pr`/`worktree`/`log`/`started`, none of which a missing `account` key
 * should have cost them (docomply-review).
 */
const PRE_DOC_7878_ACCOUNT: AccountIdentity = {
  account: null,
  vendor: null,
  provenance: "claim predates account stamping",
  reason: "claim written before the billing account was stamped",
};

/**
 * Shape-check `diag.account` when the key IS present, matching `parseDiag`'s
 * own discipline: a malformed field fails the WHOLE diag rather than
 * degrading this one field silently — a torn write or a future,
 * incompatible format is a protocol error, not a legitimate absence. See
 * `PRE_DOC_7878_ACCOUNT` above for the (different) absent-key case.
 *
 * Beyond each field's own primitive type, `./identity.ts`'s two constructors
 * (`resolved`/`unresolved`) guarantee a RELATIONAL contract this must also
 * enforce, or a claim carrying `{account:"x",vendor:null,reason:"failed"}` —
 * type-valid per field, but a shape neither constructor ever produces — would
 * parse as a resolved identity with no vendor and a spurious reason
 * (docomply-review): a resolved identity (`account !== null`) always carries
 * a real `vendor` and a `null` reason; an unresolved one (`account === null`)
 * always carries a non-null `reason` explaining the absence.
 *
 * Non-empty, not just non-null: every field `./identity.ts`'s constructors
 * actually populate — `account`, `provenance`, `reason` — is a meaningful
 * value (a fingerprint, an email, a path, an explanation), never `''`. A
 * type-only check lets `{account:"",vendor:"claude",provenance:"",
 * reason:null}` and `{account:null,vendor:null,provenance:"",reason:""}`
 * both parse as legitimate identities no real resolver call ever produces
 * (chatgpt-codex-connector, a reference-implementation pull request round 5).
 */
function parseAccount(value: unknown): AccountIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const { account, vendor, provenance, reason } = o;
  if (account !== null && (typeof account !== "string" || account === ""))
    return null;
  if (vendor !== null && vendor !== "claude" && vendor !== "codex") {
    return null;
  }
  if (typeof provenance !== "string" || provenance === "") return null;
  if (reason !== null && (typeof reason !== "string" || reason === ""))
    return null;
  if (account !== null && (vendor === null || reason !== null)) return null;
  if (account === null && reason === null) return null;
  return {
    account: account as string | null,
    vendor: vendor as AccountVendor | null,
    provenance,
    reason: reason as string | null,
  };
}

/**
 * Shape-check the diagnostics JSON. Fails to `null`, never throws: a torn
 * write, a field of the wrong type, or a future format are all "nothing to
 * show", not errors — the identity on line 1 stands on its own.
 */
function parseDiag(rest: string): ClaimDiag | null {
  const text = rest.trim();
  if (text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const { pr, worktree, log, started } = o;
  if (typeof pr !== "string" || !isDigits(pr)) return null;
  if (typeof worktree !== "string") return null;
  if (typeof log !== "string") return null;
  if (typeof started !== "string") return null;
  const account =
    "account" in o ? parseAccount(o.account) : PRE_DOC_7878_ACCOUNT;
  if (account === null) return null;
  return { pr, worktree, log, started, account };
}

/**
 * Parse a claim file's text, or `null` when it does not name an owner at all.
 * Line 1 must carry a pid that could belong to a real process — a POSITIVE
 * safe integer; the host may be absent (host-less debris predating the host
 * field reads as "this host", same as `pidAlive`).
 *
 * The positivity check is load-bearing, not pedantry: no process has pid 0,
 * and `kill(0, sig)` addresses the CALLER's entire process group — so a
 * `0 <host>` claim read as live would let `drives.ts --stop` SIGTERM the
 * operator's own session (docomply-review, a reference-implementation pull request round 1). Refused here,
 * at the one parse boundary every claim reader shares, so no liveness probe
 * or signal can ever be aimed at it.
 */
export function parseClaimText(text: string): ClaimRecord | null {
  const nl = text.indexOf("\n");
  const head = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl + 1);
  const [rawPid, rawHost = ""] = head.trim().split(/\s+/);
  if (!isDigits(rawPid ?? "")) return null;
  const pid = Number.parseInt(rawPid as string, 10);
  if (pid < 1 || !Number.isSafeInteger(pid)) return null;
  return { pid, host: rawHost, diag: parseDiag(rest) };
}

/**
 * How long a claim whose pid is still ALIVE may go unrefreshed before it
 * counts as abandoned. Same-host only, so there is no clock skew to reason
 * about.
 *
 * This is the only portable answer to pid reuse — after a driver dies, the OS
 * can hand its pid to an unrelated long-lived process, `process.kill(pid, 0)`
 * then reports that stranger as alive, and every later start refuses forever
 * (docomply-review and chatgpt-codex-connector, a reference-implementation pull request). A real driver
 * refreshes on `drive.ts`'s own heartbeat timer; a recycled pid never does.
 *
 * The default is deliberately far longer than any real round — the failure
 * this bounds costs a refusal a human can clear in one command, while
 * guessing too eagerly costs the two concurrent drivers the lock exists to
 * prevent. What the window bounds is how long a driver may be entirely GONE —
 * killed, or its host suspended — before its claim may be recovered.
 */
export const HEARTBEAT_STALE_MIN_DEFAULT = 360;

export function heartbeatStaleMs(): number {
  const raw = process.env.DRIVE_PR_LOCK_HEARTBEAT_MIN ?? "";
  const n = isDigits(raw)
    ? Number.parseInt(raw, 10)
    : HEARTBEAT_STALE_MIN_DEFAULT;
  return Math.min(Math.max(n, 5), 10_080) * 60_000;
}

/**
 * Is the recorded owner alive, by the SAME rule `drive.ts` recovers by: a
 * dead pid is dead however young the claim; a live pid on this host counts
 * only while its refresh is inside the staleness window (a pid that answers
 * but stopped refreshing is a recycled pid, not a driver); a foreign host is
 * unanswerable and counts as alive. `ageMs === null` — an age nothing can
 * read — stays alive, since an unreadable answer is not evidence of
 * abandonment.
 */
export function claimLive(record: {
  pid: number;
  host: string;
  ageMs: number | null;
}): boolean {
  if (!pidAlive(record.pid, record.host)) return false;
  if (record.host !== "" && record.host !== hostname()) return true;
  return record.ageMs === null || record.ageMs <= heartbeatStaleMs();
}

/**
 * How long a staging directory may sit unpublished, on THIS host, before its
 * named owner counts as abandoned. Staging cannot fall back to a heartbeat
 * the way a held claim does — it is meant to exist for a few synchronous
 * syscalls and is never refreshed — so this is a short, syscall-scale window
 * rather than `heartbeatStaleMs()`'s multi-minute floor. Shared by
 * `drive.ts`'s own `sweepStaleStaging` and `migrate-state-dir.ts`'s
 * `lockClaim`, so both apply exactly one staging-liveness policy rather than
 * two independently maintained copies (docomply-review, a reference-implementation pull request round 4;
 * chatgpt-codex-connector, a reference-implementation pull request round 11).
 */
export const STAGING_STALE_MS = 5 * 60_000;

/**
 * Is a staging directory's named owner still live, by the two-tier age
 * policy `drive.ts`'s `sweepStaleStaging` reclaims by: a dead pid is dead
 * however young the directory; a live LOCAL pid ages out after
 * `STAGING_STALE_MS`; a foreign host's `pidAlive` reads unconditionally
 * `true` (unanswerable, not confirmed-alive), so it ages out only after the
 * much longer `heartbeatStaleMs()` — bounding cross-host residue without
 * guessing at clock skew. `ageMs === null` stays alive, same as `claimLive`.
 *
 * Deliberately NOT `claimLive`, which never expires a foreign-host record at
 * all — the right rule for a HELD lock (a live owner keeps refreshing it
 * forever) but wrong for staging, which nothing ever refreshes and which
 * this age fallback exists to bound.
 */
export function stagingLive(record: {
  pid: number;
  host: string;
  ageMs: number | null;
}): boolean {
  if (!pidAlive(record.pid, record.host)) return false;
  const foreign = record.host !== "" && record.host !== hostname();
  const staleAfter = foreign ? heartbeatStaleMs() : STAGING_STALE_MS;
  return record.ageMs === null || record.ageMs <= staleAfter;
}
