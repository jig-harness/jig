/**
 * The drive ledger, as the driver uses it: seeding this clone's state from
 * the pull request, refusing to drive beside another clone's live driver,
 * taking a drive over from another clone by an append-only claim, standing
 * down at a round boundary when another clone's claim beats this driver's
 * own, and writing the ledger's last word when the driver stops.
 *
 * Across clones no process can be stopped and no lock is shared, so the
 * ledger arbitrates. Its driver heartbeat is the time of its last write
 * (every round boundary, park and takeover, and through a quota sleep or a
 * mailbox pause at entry and every quarter of the shortest lease window,
 * `ledgerRenewal`); a heartbeat older than the lease
 * window, the doctor's stall threshold (`stallThresholdMs`), is what admits
 * a takeover from another clone. A driver that does not continue its own
 * clone's ledger (a takeover, a pull request with no ledger yet, another
 * clone's stopped one, or its own ledger with another clone's claim in force
 * past the position it records) posts a claim naming the ledger generation
 * it read, a claim of the shared forge-claims module
 * (`shared/records/forge-claims.ts`), which reads it back and decides it by
 * that module's one rule: of the claims on one generation the earliest
 * comment id wins and every later claimant stands down, at once when it sees
 * the earlier claim and at its next check when a lagging read hid it. A
 * read-back that never lists the driver's own claim refuses the drive, as an
 * unreadable one does. A claim whose owner never wrote the ledger past its
 * generation lapses after the lease window, and a retry from the same clone
 * drives by that clone's earlier claim. Every driver
 * reads the claims at each round boundary, before each pass and after each
 * heartbeat renewal through a wait, and exits
 * `TAKEN_OVER` when one in force from another clone is newer than its own
 * position. The arbitration holds only once every driver of a pull request
 * runs a version that reads the ledger: an older driver neither reads a
 * claim nor writes a heartbeat.
 *
 * Nothing that identifies an account is posted: no account hash in the
 * ledger or a claim, and email-shaped text and account identifiers redacted
 * from the narrative, the parked reasons and the held answers (`ledger.ts`).
 *
 * `$DRIVE_PR_LEDGER=off` runs a drive without the ledger, as a dry run does.
 * A forge that cannot be read at arm refuses the drive: whether another
 * clone drives the pull request is unknown.
 */
import { hostname } from "node:os";
import { outboundFailure } from "../../../../../shared/outbound/failure.ts";
import {
  type ForgeLimit,
  fenceOnForgeLimit,
  fencedForgeLimit,
  noteForgeAnswer,
} from "../../../../../shared/outbound/forge-limit-seen.ts";
import { ExitError, fail } from "./../cli.ts";
import {
  rememberPendingExit,
  removeDriverRecord,
  writeDriverRecord,
} from "./../ledger-stop.ts";
import { resolveStateDir } from "./../state/store.ts";
import { STALL_THRESHOLD_MIN_DEFAULT, stallThresholdMs } from "./../doctor.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { resolveActor } from "./../state/actor.ts";
import { readBack } from "../../../../../shared/records/forge-claims.ts";
import {
  type ClaimComment,
  type Ledger,
  type LedgerSnapshot,
  TAKEOVER_CLAIM,
  claimComment,
  claimFloor,
  claimRule,
  effectiveClaims,
  heldFromLedger,
  newerClaim,
  takeoverKey,
} from "./../state/ledger.ts";
import {
  postClaim,
  readLedgerSnapshot,
  resolveLogin,
} from "./../state/ledger-forge.ts";
import {
  HANDOFF_REPORT_LIMIT,
  HANDOFF_TELLS_REFUSED,
  LEDGER_DRIVER_ENV,
  type LedgerDriverEnv,
  cloneId,
  ledgerDriverFromEnv,
  handoffLimit,
} from "./../state/ledger-mirror.ts";
import { personStopFor } from "./../state/person-stop.ts";
import { DRIVE_HELD_ELSEWHERE_EXIT } from "./../state/lease.ts";
import type { DriveState } from "./../state/schema.ts";
import type { DriveLock } from "./locks.ts";
import { driveState } from "./paths.ts";
import { type DriveLabelWrite, labelDrive } from "./state-labels.ts";
import {
  type ConvergedRecheck,
  liveRecheck,
  stopAfterConvergedLabel,
} from "./converged-ci-live.ts";
import type { Ownership } from "./converged-ci.ts";
import { stopOnLimit } from "./forge-limit-wait.ts";
import { afterHandoff, writeStoppedHandoff } from "./ledger-handoff.ts";

export { afterHandoff };

/** How many times to attempt the final stop after the converged CI watch. */
const CONVERGED_STOP_ATTEMPTS = 3;
import { stopKey } from "../../../../../shared/pr-labels/blocked.ts";
import { readDriveState, recordDriveEvent } from "./rearm.ts";
import { driverRuntime } from "./runtime.ts";
import {
  CHECK_RUNS_UNREADABLE_EXIT,
  SINGLE_INSTANCE_LOCK_EXIT,
  TAKEN_OVER_EXIT,
} from "./settings.ts";
import type { TakeoverPlan } from "./takeover.ts";
import { standDownOnNewerClaim } from "./takeover-check.ts";
import { currentIso, currentMs, parseMs } from "../../../../../shared/time.ts";
import { DRIVE_EXIT } from "./../status/terminal-states.ts";
import { stopFinishOf } from "./../state/events.ts";

/** Who this driver is, as the ledger names it. */
export interface LedgerIdentity {
  actor: string;
  clone: string;
  login: string | null;
  /** This driver's lock acquisition time. */
  started: string;
}

/**
 * Who this driver is for the ledger; `null` when the drive runs without it
 * (a dry run, or `$DRIVE_PR_LEDGER=off`).
 */
export async function ledgerIdentity(
  dryRun: boolean,
  stateDir: string,
  started: string,
): Promise<LedgerIdentity | null> {
  if (dryRun || (process.env.DRIVE_PR_LEDGER ?? "") === "off") return null;
  return {
    actor: await resolveActor(),
    clone: cloneId(stateDir),
    login: await resolveLogin(),
    started,
  };
}

function heartbeatAgeMs(l: Ledger, now: number): number {
  return now - parseMs(l.driver.heartbeat);
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/** The canonical ledger when it is one this version reads. */
function readableLedger(snapshot: LedgerSnapshot): Ledger | null {
  const parsed = snapshot.canonical?.parsed;
  return parsed?.kind === "ledger" ? parsed.ledger : null;
}

/** A ledger naming a running driver in another clone. */
function otherCloneDriving(l: Ledger | null, id: LedgerIdentity): boolean {
  return (
    l !== null && l.driver.clone !== id.clone && l.driver.state === "running"
  );
}

function report(snapshot: LedgerSnapshot): void {
  for (const c of snapshot.untrusted)
    console.error(
      `ledger: ignoring comment ${c.id} by ${c.login || "an unknown author"} (association ${c.association || "none"}): it carries a drive marker, but its author is neither this drive's login nor an owner, member or collaborator.`,
    );
  for (const c of snapshot.malformed)
    console.error(
      `ledger: ignoring comment ${c.id}: it opens with the ledger marker but holds no ledger this drive can read; it is left as it is.`,
    );
}

/**
 * What the drive ledger says of `--take-over` when no driver of this clone
 * holds the drive's lock: a takeover of another clone's driver, admitted;
 * this clone's own driver still named `running`, in this working tree or
 * another (it released its locks as it ended, without writing its stop);
 * or no running driver at all.
 */
export type LedgerTakeover =
  | { kind: "cross-clone"; plan: TakeoverPlan }
  | { kind: "this-tree" | "other-tree"; actor: string }
  | { kind: "none" };

/**
 * The ledger's half of `--take-over`, decided before any lock is taken when
 * no driver of this clone holds the drive (`LedgerTakeover`).
 */
export async function ledgerTakeover(
  pr: string,
  id: LedgerIdentity,
): Promise<LedgerTakeover> {
  const snapshot = await readLedgerSnapshot(pr, id.login);
  if (typeof snapshot === "string")
    return fail(
      1,
      `drive.ts --take-over: PR #${pr}'s drive ledger: ${snapshot}; refusing to take over blind.`,
    );
  const ledger = readLedger(pr, snapshot);
  if (ledger === null || ledger.driver.state !== "running")
    return { kind: "none" };
  if (!otherCloneDriving(ledger, id))
    return {
      kind: ledger.driver.actor === id.actor ? "this-tree" : "other-tree",
      actor: ledger.driver.actor,
    };
  const age = heartbeatAgeMs(ledger, currentMs());
  const window = stallThresholdMs();
  if (age <= window)
    return fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: refusing to take over PR #${pr}: the drive ledger names a driver in another clone (${ledger.driver.actor}) whose heartbeat is ${minutes(age)} minute(s) old, within the ${minutes(window)}-minute lease window.`,
      "Do not drive beside a driver that is making progress; take over only once its heartbeat is older than the window.",
    );
  console.error(
    `drive.ts --take-over: PR #${pr}'s ledger heartbeat from another clone (${ledger.driver.actor}) is ${minutes(age)} minute(s) old, past the ${minutes(window)}-minute lease window; claiming the drive.`,
  );
  return {
    kind: "cross-clone",
    plan: {
      verdict: "STALE",
      fromActor: ledger.driver.actor,
      fromAccount: null,
      holderStarted: null,
      held: heldFromLedger(ledger.held).held,
      crossClone: true,
    },
  };
}

/**
 * Post this clone's claim and read the claims back through the forge-claims
 * module: the claim when it is the earliest on its generation, `null` when a
 * rival's came first. A read-back that fails, or that never lists the claim,
 * refuses the takeover: it cannot tell a won claim from a lost one.
 */
export async function claimDrive(
  pr: string,
  id: LedgerIdentity,
  generation: number,
): Promise<ClaimComment | null> {
  const claim = {
    actor: id.actor,
    clone: id.clone,
    generation,
    at: currentIso(),
  };
  const own = await postClaim(pr, claim);
  if (typeof own === "string")
    return fail(
      1,
      `drive.ts: could not post the drive claim on PR #${pr} (${own}); not starting the drive.`,
    );
  const back = await readBack(
    { repo: "{owner}/{repo}", number: Number(pr) },
    TAKEOVER_CLAIM,
    { id: own, key: takeoverKey(generation), generation, at: claim.at },
    { self: id.login, rule: claimRule() },
  );
  const won = back.ok ? back.value.winner : null;
  if (won === null)
    return fail(
      1,
      `drive.ts: posted claim ${own} on PR #${pr}, but ${back.ok ? back.value.reason : back.failure.reason}, so whether an earlier claim beat it is unknown; not starting the drive.`,
      "The claim stays on the pull request, and a re-arm from this clone drives by it once the comments read.",
    );
  const winner = claimComment(won);
  if (winner.claim.clone !== id.clone) {
    console.error(
      `drive.ts: standing down. Claim ${winner.id} from another clone (${winner.claim.actor}) was posted before this one (${own}) on the same ledger generation ${generation}, so that clone drives PR #${pr}.`,
    );
    return null;
  }
  // An earlier claim of this clone's own that never reached a ledger write
  // (a refused or failed arm) is this clone's still: the retry drives by it.
  console.error(
    `ledger: claimed PR #${pr}'s drive (comment ${winner.id}, ledger generation ${generation}).`,
  );
  return winner;
}

/**
 * Seed this clone's state from a ledger newer than it. A refusal from the
 * state store keeps its exit (`13` when another working tree holds the PR,
 * `11` for a session lease); any other failure is `1`.
 */
async function seed(pr: string, ledger: Ledger, body: string): Promise<void> {
  const local = await readDriveState(pr);
  if ((local?.ledgerGeneration ?? 0) >= ledger.generation) return;
  const res = await run(tsArgv(driveState, ["seed-ledger", pr]), {
    stdin: body,
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code === 0) {
    console.error(`ledger: ${res.stdout.trim()}.`);
    return;
  }
  console.error(
    `ledger: could not seed this clone's state from the ledger (drive-state.ts seed-ledger exited ${res.code}).`,
  );
  const passed = [DRIVE_HELD_ELSEWHERE_EXIT, SINGLE_INSTANCE_LOCK_EXIT];
  throw new ExitError(passed.includes(res.code) ? res.code : 1);
}

/**
 * Once this driver holds its locks and before it picks the drive up: report
 * ignored markers, refuse a ledger version this code does not read, refuse
 * to drive beside another clone's running driver, claim a cross-clone
 * takeover, seed this clone's state from a newer ledger, and publish this
 * driver for the ledger's writers. Returns the state to pick the drive up
 * from (`state`, or the seeded one); a refusal throws its exit.
 */
export async function armLedger(
  pr: string,
  id: LedgerIdentity | null,
  plan: TakeoverPlan | null,
  state: DriveState,
  takeOverCommand: string,
): Promise<DriveState> {
  if (id === null) return state;
  const crossClone = plan?.crossClone === true;
  const snapshot = await readLedgerSnapshot(pr, id.login);
  // Unread, the ledger cannot say whether another clone drives: no driver
  // is admitted on that silence.
  if (typeof snapshot === "string")
    return fail(
      1,
      `drive.ts: PR #${pr}'s drive ledger: ${snapshot}; not starting the drive, since whether another clone drives it is unknown.`,
      "Re-arm once the pull request's comments read, or set DRIVE_PR_LEDGER=off to drive without the ledger.",
    );
  const ledger = readLedger(pr, snapshot);
  refuseDamaged(pr, ledger, snapshot);
  const refusal = refuseBesideAnotherClone(
    pr,
    ledger,
    id,
    crossClone ? null : takeOverCommand,
  );
  if (refusal !== null) throw new ExitError(refusal);
  // This clone's own ledger is guarded by this clone's locks, and continues
  // from the position it records. Any other start (no ledger yet, another
  // clone's stopped one, a takeover, or another clone's claim past that
  // position, posted while this clone was away) is arbitrated by a claim, so
  // two clones arming together do not both drive.
  const continued =
    crossClone || ledger === null || ledger.driver.clone !== id.clone
      ? null
      : continuation(snapshot, ledger, id);
  let floor: number;
  let own: ClaimComment | null;
  if (continued === null) {
    own = await claimDrive(pr, id, ledger?.generation ?? 0);
    if (own === null) throw new ExitError(TAKEN_OVER_EXIT);
    floor = own.id;
  } else ({ floor, own } = continued);
  if (ledger !== null && snapshot.canonical !== null)
    state = await seeded(pr, ledger, snapshot.canonical.comment.body);
  publish(id, floor, own);
  // What a stop by signal leaves for `drives.ts` to recover from.
  const worktree = process.env.DRIVE_PR_WORKTREE ?? "";
  if (worktree !== "")
    writeDriverRecord(await resolveStateDir(), pr, {
      worktree,
      started: id.started,
      pid: process.pid,
      host: hostname(),
    });
  return state;
}

/**
 * The state to pick the drive up from once `ledger` is seeded; a state that
 * cannot be read back refuses, as one unread under the locks does.
 */
async function seeded(
  pr: string,
  ledger: Ledger,
  body: string,
): Promise<DriveState> {
  await seed(pr, ledger, body);
  return (
    (await readDriveState(pr)) ??
    fail(
      1,
      `drive.ts: cannot read PR #${pr}'s drive state after seeding it from the ledger; refusing to pick the drive up without it`,
    )
  );
}

/**
 * The position this clone's own ledger continues from: the one it records,
 * with the claim that position names when it is this clone's own. `null`
 * when another clone's claim in force is past it, or the ledger records no
 * position to measure one against: that start is arbitrated by a claim.
 */
function continuation(
  snapshot: LedgerSnapshot,
  ledger: Ledger,
  id: LedgerIdentity,
): { floor: number; own: ClaimComment | null } | null {
  const position = ledger.driver.position;
  if (position === undefined)
    return effectiveClaims(snapshot.claims).some(
      (c) => c.claim.clone !== id.clone,
    )
      ? null
      : { floor: claimFloor(snapshot.claims), own: null };
  const own =
    snapshot.claims.find(
      (c) => c.id === position && c.claim.clone === id.clone,
    ) ?? null;
  const rival = newerClaim(snapshot.claims, position, id.clone, own);
  if (rival === null) return { floor: position, own };
  console.error(
    `ledger: another clone's claim (comment ${rival.id}, ${rival.claim.actor}) is past this clone's recorded position ${position}; arbitrating the drive by a claim.`,
  );
  return null;
}

/**
 * A ledger that cannot be read is not an absent one: it may name a running
 * driver, and a start without it would drive beside that driver with none of
 * the recorded round or parked state. A readable ledger posted after the
 * damaged one does not settle that: a lost creation race leaves exactly that
 * duplicate, and its state may differ from what the damaged one recorded.
 */
function refuseDamaged(
  pr: string,
  ledger: Ledger | null,
  snapshot: LedgerSnapshot,
): void {
  const readableId = snapshot.canonical?.comment.id ?? Number.POSITIVE_INFINITY;
  if (!snapshot.malformed.some((c) => c.id < readableId)) return;
  const what =
    ledger === null
      ? "holds no ledger this drive can read"
      : "holds a ledger this drive cannot read ahead of the one it can";
  fail(
    1,
    `drive.ts: PR #${pr}'s drive ledger ${what}; not starting the drive, since whether another clone drives it is unknown.`,
    "Delete the damaged ledger comment and re-arm, or set DRIVE_PR_LEDGER=off to drive without the ledger.",
  );
}

/** Report what is ignored, and refuse a version this code does not read. */
function readLedger(pr: string, snapshot: LedgerSnapshot): Ledger | null {
  report(snapshot);
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "unknown-version")
    return fail(
      1,
      `drive.ts: PR #${pr}'s drive ledger (comment ${snapshot.canonical?.comment.id}) is ledgerVersion ${String(parsed.version)}, which this version of drive-pr does not read. Update the plugin and re-arm.`,
    );
  return readableLedger(snapshot);
}

/**
 * The exit for a drive beside another clone's running driver: a plain arm
 * (`takeOverCommand` set, printed once a takeover is admitted) refused with
 * `13`, a takeover whose holder has written again since its admission
 * refused with `11`; `null` drives on.
 */
function refuseBesideAnotherClone(
  pr: string,
  ledger: Ledger | null,
  id: LedgerIdentity,
  takeOverCommand: string | null,
): number | null {
  if (ledger === null || !otherCloneDriving(ledger, id)) {
    if (takeOverCommand !== null) return null;
    return fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: PR #${pr}'s ledger no longer names a running driver in another clone; re-arm without --take-over.`,
    );
  }
  const age = heartbeatAgeMs(ledger, currentMs());
  const stale = age > stallThresholdMs();
  if (takeOverCommand !== null) {
    console.error(
      `drive.ts: PR #${pr} is driven from another clone: its drive ledger names a running driver (${ledger.driver.actor}) with a heartbeat ${minutes(age)} minute(s) old.`,
    );
    console.error(
      stale
        ? `Its heartbeat is past the lease window, so a takeover is admitted:\n  ${takeOverCommand}`
        : "Do not drive beside it; a takeover is admitted once its heartbeat is older than the lease window.",
    );
    return DRIVE_HELD_ELSEWHERE_EXIT;
  }
  if (!stale)
    return fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: PR #${pr}'s ledger was written again by the other clone's driver (heartbeat ${minutes(age)} minute(s) old); not taking over.`,
    );
  return null;
}

function publish(
  id: Pick<LedgerDriverEnv, "actor" | "clone" | "login" | "started">,
  floor: number | null,
  claim: ClaimComment | null,
): void {
  const env: LedgerDriverEnv = { ...id, floor, claim };
  process.env[LEDGER_DRIVER_ENV] = JSON.stringify(env);
}

/**
 * Write the ledger now (after a takeover, through a wait), through the
 * handoff command: its exit, `0` with no driver to write for. With
 * `tellsRefused`, a write the guards refused exits `LEDGER_REFUSED_EXIT`
 * rather than `0`.
 */
export async function mirrorNow(
  pr: string,
  tellsRefused = false,
  watchingConvergedCi = false,
): Promise<number> {
  const driver = ledgerDriverFromEnv();
  if (driver === null) return 0;
  const res = await run(tsArgv(driveState, ["handoff", pr]), {
    stdout: watchingConvergedCi ? "pipe" : "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    ...(tellsRefused
      ? {
          env: {
            ...process.env,
            [HANDOFF_TELLS_REFUSED]: "1",
            ...(watchingConvergedCi
              ? {
                  [HANDOFF_REPORT_LIMIT]: "1",
                  [LEDGER_DRIVER_ENV]: JSON.stringify({
                    ...driver,
                    watchingConvergedCi,
                  }),
                }
              : {}),
          },
        }
      : {}),
  });
  const limit = watchingConvergedCi ? handoffLimit(res.stdout) : null;
  if (limit !== null)
    noteForgeAnswer(
      outboundFailure("rate-limited", limit.reason, { until: limit.until }),
    );
  return res.code;
}

/** How soon a renewal whose write did not land is tried again. */
const LEDGER_RETRY_MS = 5 * 60_000;

/**
 * The longest a waiting driver goes between ledger writes: a quarter of the
 * shortest lease window any clone applies. Each clone reads its own
 * `DRIVE_PR_STALL_MIN`, floored at `STALL_THRESHOLD_MIN_DEFAULT`, so only
 * that floor bounds every reader, whatever this clone's own setting.
 */
export const LEDGER_RENEW_MS = (STALL_THRESHOLD_MIN_DEFAULT * 60_000) / 4;

/**
 * The heartbeat renewal for one wait (a quota sleep, a mailbox pause): its
 * first call writes the ledger, since the wait may begin with a heartbeat
 * already aged by a long pass, and later calls write once `LEDGER_RENEW_MS`
 * has passed since the last, or `LEDGER_RETRY_MS` after a write that did not
 * land. `handoff` exits `0` on a write its guards refused too, so each write,
 * landed or not, is followed by the claims: `TAKEN_OVER_EXIT` when another
 * clone's newer claim beats this driver, which the wait returns; otherwise
 * `null`.
 */
export function ledgerRenewal(
  pr: string,
  onWatchRenewal?: (written: boolean) => void,
): () => Promise<number | null> {
  let dueAt = Number.NEGATIVE_INFINITY;
  return async () => {
    if (performance.now() < dueAt || fencedForgeLimit() !== null) return null;
    const code = await mirrorNow(pr, true, onWatchRenewal !== undefined);
    if (fencedForgeLimit() !== null) return null;
    // A write the guards refused is not a failed one: the ledger is another's, and the claims below say whether to stand down.
    const landed = afterHandoff(code) !== "unwritten";
    if (afterHandoff(code) === "label") {
      if (onWatchRenewal === undefined)
        await labelOwnDrive(pr, { armed: true });
      else onWatchRenewal(true);
    } else if (landed) {
      onWatchRenewal?.(false);
    }
    dueAt = performance.now() + (landed ? LEDGER_RENEW_MS : LEDGER_RETRY_MS);
    if (!landed) {
      console.error(
        `ledger: PR #${pr}'s heartbeat write did not land (drive-state.ts handoff exited ${code}); trying again in ${minutes(LEDGER_RETRY_MS)} minute(s).`,
      );
    }
    return await standDownOnNewerClaim(pr);
  };
}

/**
 * Publish before a long first status probe, so an operator can stop this
 * acquisition; once the running ledger is out, the pull request's state
 * label follows it before the first round, best effort. A drive with no
 * ledger publishes and labels nothing.
 */
export async function publishStartup(pr: string): Promise<void> {
  if (ledgerDriverFromEnv() === null) return;
  const publication = await mirrorNow(pr, true);
  const next = afterHandoff(publication);
  if (next === "label") await labelOwnDrive(pr, { armed: true });
  // A write the guards refused leaves a ledger that is not this driver's.
  if (next !== "unwritten") return;
  console.error(
    `ledger: initial running-ledger publication failed (exit ${publication}); stop requests remain refused until this acquisition publishes, and round-boundary writes retry it.`,
  );
}

/**
 * Whether this acquisition still drives the pull request: no takeover claim
 * newer than its own is on it. A clone that takes the drive over claims it
 * before it writes the ledger or a label, so a driver that read no such
 * claim just before its label write is not overwriting a successor's.
 * `lost` for a driver that no longer writes the ledger (taken over) or that
 * a newer claim displaced; `unreadable` for a listing that does not read.
 */
async function ledgerOwnership(pr: string): Promise<Ownership> {
  if (fencedForgeLimit() !== null) return "unreadable";
  const driver = ledgerDriverFromEnv();
  if (driver === null) return "lost";
  // No position among the claims, so none can be newer.
  if (driver.floor === null) return "ours";
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  if (typeof snapshot === "string") {
    console.error(`ledger: PR #${pr}'s ownership did not read: ${snapshot}.`);
    return "unreadable";
  }
  return newerClaim(
    snapshot.claims,
    driver.floor,
    driver.clone,
    driver.claim,
  ) === null
    ? "ours"
    : "lost";
}

/** Whether a write may go ahead: only a proven ownership allows one. */
async function ledgerIsOurs(pr: string): Promise<boolean> {
  return (await ledgerOwnership(pr)) === "ours";
}

/** The state label for a ledger this driver just wrote, written only while that ledger is still its own. */
async function labelOwnDrive(
  pr: string,
  moment: Parameters<typeof labelDrive>[1],
): Promise<DriveLabelWrite | null> {
  // A drive with no ledger labels nothing.
  if (ledgerDriverFromEnv() === null) return null;
  return await labelDrive(pr, moment, undefined, () => ledgerIsOurs(pr));
}

/** Write the running ledger now and, once it landed, the state label that follows it; what `handoff` exited with. */
export async function publishRunning(pr: string): Promise<number> {
  const code = await mirrorNow(pr, true);
  if (afterHandoff(code) === "label") await labelOwnDrive(pr, { armed: true });
  return code;
}

/**
 * What follows the stopped ledger's write: a write that landed, or one the
 * guards refused (nothing left to write), drops the driver record; any other
 * exit, `LEDGER_NOT_WRITTEN_EXIT` included, keeps it, as the recovery's only
 * evidence once the locks are released. Only a ledger this driver wrote gets
 * its state label, best effort.
 */
async function afterStopWrite(
  pr: string,
  handoff: number,
  code: number | null,
  started: string,
  dropRecord: () => Promise<void>,
  pending: boolean,
): Promise<StopWrite> {
  const next = afterHandoff(handoff);
  if (next === "unwritten") return { written: false, limit: null };
  if (next === "label") {
    const { value: leavesPending, limit } = await fenceOnForgeLimit(() =>
      stopLabelLeavesPending(pr, code, started, pending),
    );
    if (limit !== null || leavesPending) return { written: false, limit };
  }
  await dropRecord();
  return { written: true, limit: null };
}

type StopWrite = { written: boolean; limit: ForgeLimit | null };

/** Whether a stop-label write leaves a pending converged exit for recovery. */
async function stopLabelLeavesPending(
  pr: string,
  code: number | null,
  started: string,
  pending: boolean,
): Promise<boolean> {
  const stoppedByPerson =
    personStopFor(await resolveStateDir(), pr, started).personStop !==
    undefined;
  if (pending && code === DRIVE_EXIT.CONVERGED && !stoppedByPerson)
    return false;
  let unreadable = false;
  const label = await labelStop(pr, code, started, async () => {
    const owner = await ledgerOwnership(pr);
    unreadable ||= owner === "unreadable";
    return owner === "ours";
  });
  // A missing projection can mean either a confirmed successor owns the
  // ledger, or that the label operation itself was unavailable. Keep the
  // pending exit for the latter so recovery can retry the publication.
  return (
    pending &&
    (unreadable ||
      label?.write.outcome === "refused" ||
      (label === null && (await ledgerOwnership(pr)) !== "lost"))
  );
}

async function labelStop(
  pr: string,
  code: number | null,
  started: string,
  stillOurs: () => Promise<boolean> = () => ledgerIsOurs(pr),
): Promise<DriveLabelWrite | null> {
  return labelDrive(
    pr,
    async () => {
      const state = await readDriveState(pr);
      return {
        stopped: code,
        byPerson:
          personStopFor(await resolveStateDir(), pr, started).personStop !==
          undefined,
        verifiedSha: state?.verifiedSha ?? "",
        stop: stopKey(started, state?.rounds ?? 0),
        parks: state?.parked ?? [],
      };
    },
    undefined,
    stillOurs,
  );
}

async function settleConvergedStop(
  pr: string,
  started: string,
  recheck: ConvergedRecheck,
  dropRecord: () => Promise<void>,
  writeStop: (code: number | null, attempts?: number) => Promise<StopWrite>,
): Promise<number> {
  let renewedAt = Number.NEGATIVE_INFINITY;
  const renew = ledgerRenewal(pr, (written) => {
    renewedAt = written ? performance.now() : Number.NEGATIVE_INFINITY;
  });
  const owned = async (): Promise<Ownership> => {
    const owner = await ledgerOwnership(pr);
    return owner === "ours" &&
      performance.now() - renewedAt >= STALL_THRESHOLD_MIN_DEFAULT * 60_000
      ? "unreadable"
      : owner;
  };
  const initial = await fenceOnForgeLimit(async () => {
    await renew();
    return owned();
  });
  let ownership = initial.value;
  let finalExit =
    initial.limit === null
      ? DRIVE_EXIT.INDETERMINATE
      : stopOnLimit(
          pr,
          initial.limit,
          "the converged stop's lease check met the limit",
        );
  if (initial.limit === null && ownership === "ours") {
    const watched = await stopAfterConvergedLabel(
      pr,
      () =>
        labelStop(
          pr,
          DRIVE_EXIT.CONVERGED,
          started,
          async () => (await owned()) === "ours",
        ),
      recheck,
      owned,
      renew,
    );
    finalExit = watched.exit;
    ownership = watched.ownership;
  }
  if (ownership === "lost") {
    await dropRecord();
    return TAKEN_OVER_EXIT;
  }
  rememberPendingExit(await resolveStateDir(), pr, started, finalExit);
  const { written, limit } = await writeStop(
    finalExit,
    CONVERGED_STOP_ATTEMPTS,
  );
  if (limit !== null) return DRIVE_EXIT.FORGE_RATE_LIMITED;
  return written || finalExit === DRIVE_EXIT.FORGE_RATE_LIMITED
    ? finalExit
    : DRIVE_EXIT.INDETERMINATE;
}

/**
 * The driver's last ledger write, marking it stopped, however the drive's
 * code ends it: `done(code)` on a returned exit, the dispose on a thrown
 * refusal or a crash (its exit unknown here, so none is named). Written
 * once; not at all after `TAKEN_OVER`, when the ledger is the successor's.
 * A stop by signal or by `drives.ts --stop` cannot write it here: once
 * shutdown begins the process starts no new command (`shared/cleanup.ts`).
 * `drives.ts` writes it from outside instead (`lib/ledger-stop.ts`), from
 * the driver record written at arm and marked released as the PR's lock is
 * released, which this removes once the stopped ledger is written unless a
 * retained CI hold still needs the termination witness. Nor is
 * it written while the drive retains its locks (`held` emptied: a pass
 * whose termination was not witnessed may still act): the ledger keeps
 * naming this driver running, its heartbeat ages toward the lease window,
 * and the record stays unmarked, so no recovery marks it stopped either.
 * Recovery also handles a stop that could not be written.
 *
 * A stop labelled `converged` watches the head's CI before publishing its
 * final stop. The drive holds its locks and renews its ledger lease while it
 * watches the runs the label write can start (`converged-ci-live.ts`). When
 * those runs leave CI unsettled after their one re-run, the stop is settled
 * as `HITL_PARKED` (`INDETERMINATE` when the park could not be recorded).
 */
export function ledgerSettlement(
  pr: string,
  held: readonly DriveLock[],
  dryRun = false,
  recheck: ConvergedRecheck = liveRecheck,
): AsyncDisposable & {
  done(code: number): Promise<number>;
} {
  let settled = false;
  // Taken over, the driver variable is gone; the record still names it.
  const started = ledgerDriverFromEnv()?.started ?? "";
  const dropRecord = async (): Promise<void> => {
    if (started !== "")
      removeDriverRecord(await resolveStateDir(), pr, started, true);
  };
  const settle = async (code: number | null): Promise<number | null> => {
    if (settled) return code;
    const driver = ledgerDriverFromEnv();
    if (code === TAKEN_OVER_EXIT) {
      settled = true;
      await dropRecord();
      return code;
    }
    settled = true;
    if (driver !== null && held.length === 0) {
      console.error(
        `ledger: PR #${pr}'s ledger is left naming this driver running: its locks are retained, so its pass may still act.`,
      );
      return code;
    }
    if (code !== DRIVE_EXIT.CONVERGED || driver === null) {
      const { limit } = await writeStop(code);
      return limit === null ? code : DRIVE_EXIT.FORGE_RATE_LIMITED;
    }

    return await settleConvergedStop(
      pr,
      started,
      recheck,
      dropRecord,
      writeStop,
    );
  };

  /** Record stop `code` in the drive state, then the stopped ledger (up to `attempts` writes) and its label. */
  const recordStop = (code: number | null) =>
    // The exit goes into the state before the ledger's last write, which
    // mirrors the state's events: an unknown exit names none in the driver
    // record, so a report reading the ledger falls back to those events, and
    // the previous run's stop must not be the last of them. A dry run (no
    // ledger driver either) records nothing. An unrecorded stop writes no
    // ledger and keeps the record: the recovery (`lib/ledger-stop.ts`)
    // records the stop and then writes the ledger, in that order.
    dryRun ||
    recordDriveEvent(
      pr,
      "stop",
      String(code ?? "unknown"),
      {
        ...driverRuntime.stopLeftWork,
        ...(code === DRIVE_EXIT.REVIEWER_FAILED
          ? driverRuntime.reviewerFailure
          : null),
      },
      code === CHECK_RUNS_UNREADABLE_EXIT
        ? driverRuntime.stopListingPages
        : null,
      driverRuntime.stopLimitedUntil,
      driverRuntime.stopProbe?.code === code ? driverRuntime.stopProbe : null,
      code === DRIVE_EXIT.STALLED
        ? (stopFinishOf(driverRuntime.stallFinish) ?? null)
        : null,
    );

  const recordProjectionLimit = async (
    limit: ForgeLimit,
  ): Promise<StopWrite> => {
    const priorReset = parseMs(driverRuntime.stopLimitedUntil ?? "");
    if (priorReset >= limit.until) return { written: false, limit };
    const limited = stopOnLimit(
      pr,
      limit,
      "a read during stopped-ledger settlement met the limit",
    );
    rememberPendingExit(await resolveStateDir(), pr, started, limited);
    await recordStop(limited);
    return { written: false, limit };
  };

  const writeStop = async (
    code: number | null,
    attempts = 1,
  ): Promise<StopWrite> => {
    const driver = ledgerDriverFromEnv();
    const recorded = await recordStop(code);
    if (driver === null) return { written: true, limit: null };
    if (!recorded) {
      console.error(
        `ledger: PR #${pr}'s ledger is left naming this driver running: its stop is not in the drive state, so the recovery writes both.`,
      );
      return { written: false, limit: null };
    }
    if (
      attempts > 1 &&
      code === DRIVE_EXIT.FORGE_RATE_LIMITED &&
      parseMs(driverRuntime.stopLimitedUntil ?? "") > currentMs()
    )
      return { written: false, limit: null };
    const { handoff, limit } = await writeStoppedHandoff(
      pr,
      driver,
      code,
      attempts,
    );
    if (limit !== null) return recordProjectionLimit(limit);
    const result = await afterStopWrite(
      pr,
      handoff,
      code,
      started,
      dropRecord,
      attempts > 1,
    );
    if (result.limit !== null) return recordProjectionLimit(result.limit);
    return result;
  };
  return {
    async done(code: number): Promise<number> {
      return (await settle(code)) ?? code;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await settle(null);
    },
  };
}
