/**
 * The diagnostics a drive.ts driver lock carries, and the liveness rule that
 * interprets a lock's holder, shared with `drives.ts`, the read-only
 * operator surface, so the writer and the reader cannot drift apart. The
 * PROTOCOL (take, renew, recover, release) is `driver/locks.ts`'s: this
 * module knows what a lock's diagnostics say and whether its holder counts
 * as live, never what taking or recovering one means.
 *
 * A driver lock is a row of the drive database's `locks` table. Its holder
 * is the shared process identity (`shared/liveness.ts`), compared by host id
 * first, so a lock this machine wrote under an earlier host name is still
 * this host's. Its `detail` is one JSON object of OPERATOR DIAGNOSTICS:
 * which PR the holder is driving, from which worktree, since when, and where
 * its durable log is. Diagnostics are advisory by design: a lock without them
 * (or with unparsable ones) is a valid lock whose holder has nothing to show,
 * never a protocol error, so refusals and listings degrade to pid and host,
 * and nothing that decides liveness or recovery reads them.
 */

import { definedFields } from "../../../../shared/defined-fields.ts";
import {
  SESSION_LEASE_MIN,
  sameHost,
  thisHost,
} from "../../../../shared/liveness.ts";
import { isDigits } from "./cli.ts";
import {
  type AccountIdentity,
  type AccountVendor,
  formatAccountIdentity,
} from "./identity.ts";
import { pidAlive } from "./proc.ts";

/** The diagnostics line — every field required, either a string or (for
 * `account`) a shape-checked nested object, except `model` and
 * `permissionMode`, which a claim written before they were stamped lacks. */
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
  /** The model each pass runs on (`pass-model.ts`); `null` when the pass
   * command chooses its own, absent from a claim that predates it. */
  model?: string | null;
  /** The permission mode each pass runs in (`pass-args.ts`); `null` when
   * the pass command chooses its own, absent from a claim that predates it. */
  permissionMode?: string | null;
  /** The driver generation (`state/mailbox-stop.ts`) a mailbox `stop`
   * addresses; absent from a claim that predates it. */
  generation?: number;
  /** The mailbox directory the driver reads, resolved in its own environment,
   * so a stop is delivered where the driver looks; absent from a claim that
   * predates it. */
  mailbox?: string;
}

/**
 * A claim written before account stamping has no `account` key at all — a
 * legitimate TRANSITIONAL shape (an already-running driver upgraded out
 * from under, mid-drive), not corruption. Unlike a genuinely malformed
 * `account` value (`parseAccount` below, which still degrades the WHOLE
 * diag — the same "torn write or future format" reasoning `parseDiag`
 * already applies to every other field), an absent key degrades only THIS
 * one field: `pr`/`worktree`/`log`/`started` stay readable.
 *
 * That distinction is load-bearing, not cosmetic. Degrading the whole diag for
 * a merely-absent `account` would break two live consumers of a pre-upgrade
 * claim mid-drive: `drives.ts --stop` refuses on `diag === null` ("claim
 * predates diagnostics"), and `ownParentDriver` (`drives.ts`) requires
 * `diag !== null` to recognise a pass as its own parent driver — a `null` diag
 * there reproduces the stand-down bug (the pass reads its own driver as a rival
 * and burns the whole round budget refusing). Both only need
 * `pr`/`worktree`/`log`/`started`, none of which a missing `account` key should
 * cost them.
 */
const PRE_STAMPING_ACCOUNT: AccountIdentity = {
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
 * `PRE_STAMPING_ACCOUNT` above for the (different) absent-key case.
 *
 * Beyond each field's own primitive type, `./identity.ts`'s two constructors
 * (`resolved`/`unresolved`) guarantee a RELATIONAL contract this must also
 * enforce, or a claim carrying `{account:"x",vendor:null,reason:"failed"}` —
 * type-valid per field, but a shape neither constructor ever produces — would
 * parse as a resolved identity with no vendor and a spurious reason:
 * a resolved identity (`account !== null`) always carries
 * a real `vendor` and a `null` reason; an unresolved one (`account === null`)
 * always carries a non-null `reason` explaining the absence.
 *
 * Non-empty, not just non-null: every field `./identity.ts`'s constructors
 * actually populate — `account`, `provenance`, `reason` — is a meaningful
 * value (a fingerprint, an email, a path, an explanation), never `''`. A
 * type-only check lets `{account:"",vendor:"claude",provenance:"",
 * reason:null}` and `{account:null,vendor:null,provenance:"",reason:""}`
 * both parse as legitimate identities no real resolver call ever produces.
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
 * Shape-check a lock's diagnostics JSON. Fails to `null`, never throws: a
 * field of the wrong type, or a future format, is "nothing to show", not an
 * error: the lock's holder stands on its own.
 */
export function parseDiagText(rest: string): ClaimDiag | null {
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
    "account" in o ? parseAccount(o.account) : PRE_STAMPING_ACCOUNT;
  if (account === null) return null;
  return {
    pr,
    worktree,
    log,
    started,
    account,
    ...definedFields({
      model: claimLabel(o.model),
      permissionMode: claimLabel(o.permissionMode),
      generation: claimGeneration(o.generation),
      mailbox:
        typeof o.mailbox === "string" && o.mailbox !== ""
          ? o.mailbox
          : undefined,
    }),
  };
}

/** A claim's driver generation: absent when the claim has none, or one that is not a positive whole number. */
function claimGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * A claim's pass model or permission mode: absent when the claim has none,
 * and read as absent when it is not a nonempty string or `null`. Each only
 * labels a listing, so a bad one costs its own line, never the record
 * `--stop` and the parent-driver check read.
 */
function claimLabel(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A pass model or permission mode as a listing shows it. */
function formatLabel(value: string | null | undefined, what: string): string {
  if (value === undefined) return `unknown (claim predates the ${what})`;
  return value ?? "chosen by the pass command";
}

/** A live drive's diagnostics as `drives.ts` lists them, one indented line each. */
export function diagLines(diag: ClaimDiag): string[] {
  return [
    `    worktree: ${diag.worktree}`,
    `    since:    ${diag.started}`,
    `    log:      ${diag.log}`,
    `    account:  ${formatAccountIdentity(diag.account)}`,
    `    model:    ${formatLabel(diag.model, "model")}`,
    `    permissions: ${formatLabel(diag.permissionMode, "permission mode")}`,
    `    generation: ${diag.generation ?? "unknown (claim predates driver generations)"}`,
  ];
}

/** The host a claim was written on, as the shared identity compares it. */
interface ClaimHost {
  host: string | null;
  hostId?: string | undefined;
}

/** Whether a claim was written on this machine: by host id first, an empty host being this one. */
function onThisHost(record: ClaimHost): boolean {
  return sameHost(
    { host: record.host ?? "", hostId: record.hostId },
    thisHost(),
  );
}

/** A host can expose multiple PID namespaces (native Windows and WSL).
 * Untagged older claims are POSIX-compatible; Windows cannot bind them safely. */
export function samePidNamespace(
  record: ClaimHost & { platform?: string | null },
): boolean {
  if (!onThisHost(record)) return false;
  return record.platform == null
    ? process.platform !== "win32"
    : record.platform === process.platform;
}

/**
 * Is this claim's owner the driver that spawned ME? `drive.ts` exports
 * $DRIVE_PR_SESSION as its own pid before spawning each round's agent, so a
 * pass finding a live holder with that exact pid is looking at its own parent,
 * never a competing driver — and the second-driver rule (SKILL.md § 6) does not
 * apply to it. `drives.ts` reads it to tell a pass its listing's driver is its
 * own, and `attach.ts` to let a pass attach under the locks its driver holds.
 *
 * Pid equality is only meaningful on the host that wrote the claim, compared
 * by host id first, so a differing or absent host answers false — failing
 * toward the safe reading (a foreign driver), never toward "proceed". An
 * unset $DRIVE_PR_SESSION means the reader is not a pass at all, which
 * answers false for the same reason.
 *
 * A pid is REUSED, though, and that is the gap this function closes second: a
 * dead driver's still-fresh claim whose pid the OS handed to this pass's own
 * parent reads live to `claimLive` and matches $DRIVE_PR_SESSION, so pid+host
 * alone would grant `self` over a lock the parent never took. `drive.ts`
 * therefore exports its claim's own acquisition token as
 * $DRIVE_PR_SESSION_STARTED, and when the claim carries a `started` of its own
 * the two must be EQUAL — the same instance-token correlation `drives.ts`
 * uses to tie a worktree lock to a PR lock.
 *
 * The token is required whenever THIS process's environment supplies one — not
 * only when the on-disk claim also happens to carry one. `drive.ts` always
 * exports both together, so a pass holding $DRIVE_PR_SESSION_STARTED is
 * necessarily a pass whose own parent writes diagnostics into every claim it
 * takes; a live claim matching pid+host but carrying no `started` at all is
 * therefore proven to be a DIFFERENT process's claim — the exact pid-recycling
 * case this token exists to catch — and must answer false, not fall back to the
 * legacy heuristic (the prior `token !== '' && diag !== null` guard let a
 * diagnostics-free claim ride pid+host to `self` even with a token present).
 * Only a harness opting in by hand (`DRIVE_PR_SESSION=<agent pid>`, SKILL.md §
 * 6), which exports no token at all, still falls back to pid+host — demanding a
 * token there would answer false for every pass under that configuration, which
 * is the stand-down bug this whole mechanism exists to prevent, in the one
 * direction that is silent.
 *
 * That fallback is narrower than "no token on our side", though: it is
 * sanctioned ONLY for the genuine older legacy case, which by construction
 * writes a diagnostics-free claim of its own — so the fallback must
 * additionally require `diag === null`. A claim that DOES carry diagnostics can
 * never be that harness's own write (only `drive.ts`'s `acquire` stamps
 * diagnostics, and it always exports the token alongside them), so a
 * diagnostics-bearing claim matching pid+host while OUR OWN env carries no
 * token is proof of an unrelated process — most plausibly a modern,
 * still-diagnosed claim from a dead driver whose pid got recycled — and must
 * answer false rather than silently trusting pid+host over evidence that
 * contradicts it.
 */
export function ownParentDriver(record: {
  pid: number;
  host: string;
  hostId?: string | undefined;
  platform?: string | null;
  diag: ClaimDiag | null;
}): boolean {
  const { pid, host, diag } = record;
  const session = process.env.DRIVE_PR_SESSION ?? "";
  if (
    session === "" ||
    String(pid) !== session ||
    host === "" ||
    !samePidNamespace(record)
  ) {
    return false;
  }
  const token = process.env.DRIVE_PR_SESSION_STARTED ?? "";
  if (token !== "") return diag !== null && diag.started === token;
  return diag === null;
}

/**
 * How long a claim whose pid is still ALIVE may go unrefreshed before it
 * counts as abandoned. Same-host only, so there is no clock skew to reason
 * about.
 *
 * This is the only portable answer to pid reuse — after a driver dies, the OS
 * can hand its pid to an unrelated long-lived process, `process.kill(pid, 0)`
 * then reports that stranger as alive, and every later start refuses forever.
 * A real driver
 * refreshes on `drive.ts`'s own heartbeat timer; a recycled pid never does.
 *
 * The default is deliberately far longer than any real round — the failure
 * this bounds costs a refusal a human can clear in one command, while
 * guessing too eagerly costs the two concurrent drivers the lock exists to
 * prevent. What the window bounds is how long a driver may be entirely GONE —
 * killed, or its host suspended — before its claim may be recovered.
 */
export const HEARTBEAT_STALE_MIN_DEFAULT = SESSION_LEASE_MIN;

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
export function claimLive(
  record: ClaimHost & {
    pid: number;
    platform?: string | null;
    ageMs: number | null;
  },
): boolean {
  if (!samePidNamespace(record)) return true;
  return (
    pidAlive(record.pid, "") &&
    (record.ageMs === null || record.ageMs <= heartbeatStaleMs())
  );
}
