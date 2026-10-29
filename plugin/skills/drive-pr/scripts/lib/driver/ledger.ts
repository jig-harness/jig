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
 * it read;
 * of the claims on one generation the earliest comment id wins and every
 * later claimant stands down, at once when it sees the earlier claim and at
 * its next check when a lagging read hid it. A claim whose owner never wrote
 * the ledger past its generation lapses after the lease window, and a retry
 * from the same clone drives by that clone's earlier claim. Every driver
 * reads the claims at each round boundary and before each pass, and exits
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
import { ExitError, fail } from "./../cli.ts";
import { removeDriverRecord, writeDriverRecord } from "./../ledger-stop.ts";
import { resolveStateDir } from "./../state/store.ts";
import { STALL_THRESHOLD_MIN_DEFAULT, stallThresholdMs } from "./../doctor.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { resolveActor } from "./../state/actor.ts";
import {
  type ClaimComment,
  type Ledger,
  type LedgerSnapshot,
  claimFloor,
  effectiveClaims,
  heldFromLedger,
  newerClaim,
} from "./../state/ledger.ts";
import {
  postClaim,
  readLedgerSnapshot,
  resolveLogin,
} from "./../state/ledger-forge.ts";
import {
  LEDGER_DRIVER_ENV,
  type LedgerDriverEnv,
  cloneId,
  ledgerDriverFromEnv,
} from "./../state/ledger-mirror.ts";
import { DRIVE_HELD_ELSEWHERE_EXIT } from "./../state/lease.ts";
import type { DriveState } from "./../state/schema.ts";
import type { DriveLock } from "./locks.ts";
import { driveState } from "./paths.ts";
import { readDriveState } from "./rearm.ts";
import { SINGLE_INSTANCE_LOCK_EXIT, TAKEN_OVER_EXIT } from "./settings.ts";
import type { TakeoverPlan } from "./takeover.ts";

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

function heartbeatAgeMs(l: Ledger, now: Date): number {
  return now.getTime() - Date.parse(l.driver.heartbeat);
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
 * The cross-clone half of `--take-over`, decided before any lock is taken
 * when no driver of this clone holds the drive. `null` when the ledger names
 * no running driver in another clone, which leaves nothing to take over.
 */
export async function admitCrossCloneTakeover(
  pr: string,
  id: LedgerIdentity,
): Promise<TakeoverPlan | null> {
  const snapshot = await readLedgerSnapshot(pr, id.login);
  if (typeof snapshot === "string")
    return fail(
      1,
      `drive.ts --take-over: PR #${pr}'s drive ledger: ${snapshot}; refusing to take over blind.`,
    );
  const ledger = readLedger(pr, snapshot);
  if (ledger === null || !otherCloneDriving(ledger, id)) return null;
  const age = heartbeatAgeMs(ledger, new Date());
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
    verdict: "STALE",
    fromActor: ledger.driver.actor,
    fromAccount: null,
    holderStarted: null,
    held: heldFromLedger(ledger.held).held,
    crossClone: true,
  };
}

/**
 * Post this clone's claim and read the claims back: the claim when it is the
 * earliest on its generation, `null` when a rival's came first. A read-back
 * that fails refuses the takeover: it cannot tell a won claim from a lost one.
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
    at: new Date().toISOString(),
  };
  const own = await postClaim(pr, claim);
  if (typeof own === "string")
    return fail(
      1,
      `drive.ts: could not post the drive claim on PR #${pr} (${own}); not starting the drive.`,
    );
  const after = await readLedgerSnapshot(pr, id.login);
  if (typeof after === "string")
    return fail(
      1,
      `drive.ts: posted claim ${own} on PR #${pr}, but ${after}, so whether an earlier claim beat it is unknown; not starting the drive.`,
      "The claim stays on the pull request, and a re-arm from this clone drives by it once the comments read.",
    );
  const mine: ClaimComment = { id: own, claim };
  const claims = after.claims.some((c) => c.id === own)
    ? after.claims
    : [...after.claims, mine];
  const winner =
    effectiveClaims(claims).find((c) => c.claim.generation === generation) ??
    mine;
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
  const age = heartbeatAgeMs(ledger, new Date());
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
 * At a round boundary and again just before a pass is dispatched:
 * `TAKEN_OVER_EXIT` when another clone's claim beats this driver's position.
 */
export async function standDownOnNewerClaim(
  pr: string,
): Promise<number | null> {
  const driver = ledgerDriverFromEnv();
  if (driver === null || driver.floor === null) return null;
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  // Unread, the claims are read again at the next check. This driver's
  // ownership was established by a read at arm; a lapse here delays seeing a
  // claim, and every ledger write re-checks the claims before it lands.
  if (typeof snapshot === "string") return null;
  const claim = newerClaim(
    snapshot.claims,
    driver.floor,
    driver.clone,
    driver.claim,
  );
  if (claim === null) return null;
  console.error(
    `drive.ts: taken over. Another clone (${claim.claim.actor}) claimed PR #${pr}'s drive in comment ${claim.id}, which beats this driver's own position (${driver.claim === null ? driver.floor : `its claim ${driver.claim.id}`}); stopping at this round boundary without another pass. That clone drives now.`,
  );
  // This driver no longer writes the ledger: it is the successor's.
  delete process.env[LEDGER_DRIVER_ENV];
  return TAKEN_OVER_EXIT;
}

/** Write the ledger now (after a takeover), through the handoff command. */
export async function mirrorNow(pr: string): Promise<void> {
  if (ledgerDriverFromEnv() === null) return;
  await run(tsArgv(driveState, ["handoff", pr]), {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
}

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
 * has passed since the last. The writer refuses once another clone's claim
 * is newer than this driver's, so renewal never outlives a takeover.
 */
export function ledgerRenewal(pr: string): () => Promise<void> {
  let writtenAt: number | null = null;
  return async () => {
    const now = performance.now();
    if (writtenAt !== null && now - writtenAt < LEDGER_RENEW_MS) return;
    writtenAt = now;
    await mirrorNow(pr);
  };
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
 * released, which this removes once the stopped ledger is written. Nor is
 * it written while the drive retains its locks (`held` emptied: a pass
 * whose termination was not witnessed may still act): the ledger keeps
 * naming this driver running, its heartbeat ages toward the lease window,
 * and the record stays unmarked, so no recovery marks it stopped either.
 */
export function ledgerSettlement(
  pr: string,
  held: readonly DriveLock[],
): AsyncDisposable & {
  done(code: number): Promise<number>;
} {
  let settled = false;
  // Taken over, the driver variable is gone; the record still names it.
  const started = ledgerDriverFromEnv()?.started ?? "";
  const dropRecord = async (): Promise<void> => {
    if (started !== "")
      removeDriverRecord(await resolveStateDir(), pr, started);
  };
  const settle = async (code: number | null): Promise<void> => {
    if (settled) return;
    const driver = ledgerDriverFromEnv();
    if (code === TAKEN_OVER_EXIT) {
      settled = true;
      await dropRecord();
      return;
    }
    if (driver === null) return;
    settled = true;
    if (held.length === 0) {
      console.error(
        `ledger: PR #${pr}'s ledger is left naming this driver running: its locks are retained, so its pass may still act.`,
      );
      return;
    }
    const res = await run(tsArgv(driveState, ["handoff", pr]), {
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
      env: {
        ...process.env,
        [LEDGER_DRIVER_ENV]: JSON.stringify({ ...driver, stopped: code }),
      },
    });
    // Any other exit, `LEDGER_NOT_WRITTEN_EXIT` included, keeps the record:
    // it is the recovery's only evidence once the locks are released.
    if (res.code === 0) await dropRecord();
  };
  return {
    async done(code: number): Promise<number> {
      await settle(code);
      return code;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await settle(null);
    },
  };
}
