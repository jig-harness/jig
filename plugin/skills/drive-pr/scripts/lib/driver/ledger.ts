/**
 * The drive ledger, as the driver uses it: seeding this clone's state from
 * the pull request, refusing to drive beside another clone's live driver,
 * taking a drive over from another clone by an append-only claim, standing
 * down at a round boundary when another clone's claim beats this driver's
 * own, and writing the ledger's last word when the driver stops.
 *
 * Across clones no process can be stopped and no lock is shared, so the
 * ledger arbitrates. Its driver heartbeat is the time of its last write
 * (every round boundary, park and takeover); a heartbeat older than the lease
 * window, the doctor's stall threshold (`stallThresholdMs`), is what admits
 * a takeover from another clone. The taker posts a claim naming the ledger
 * generation it read; of the claims on one generation the earliest comment
 * id wins and every later claimant stands down, at once when it sees the
 * earlier claim and at its next round boundary when a lagging read hid it.
 * Every driver reads the claims at each round boundary and exits
 * `TAKEN_OVER` when one in force from another clone is newer than its own
 * position. The arbitration holds only once every driver of a pull request
 * runs a version that reads the ledger: an older driver neither reads a
 * claim nor writes a heartbeat.
 *
 * Nothing that identifies an account is posted: no account hash in the
 * ledger or a claim, and email-shaped text redacted from the narrative and
 * the parked reasons (`ledger.ts`).
 *
 * `$DRIVE_PR_LEDGER=off` runs a drive without the ledger, as a dry run does.
 * A forge that cannot be read starts the drive without the ledger rather
 * than refusing it, and says so; the first round boundary that reads it sets
 * this driver's position.
 */
import { ExitError, fail } from "./../cli.ts";
import { stallThresholdMs } from "./../doctor.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { resolveActor } from "./../state/actor.ts";
import {
  type ClaimComment,
  type Ledger,
  type LedgerSnapshot,
  claimFloor,
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
  report(snapshot);
  const ledger = readableLedger(snapshot);
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
      `drive.ts --take-over: could not post the takeover claim on PR #${pr} (${own}); not taking over.`,
    );
  const after = await readLedgerSnapshot(pr, id.login);
  if (typeof after === "string")
    return fail(
      1,
      `drive.ts --take-over: posted claim ${own} on PR #${pr}, but ${after}, so whether an earlier claim beat it is unknown; not taking over.`,
      "The claim stays on the pull request. Re-arm with --take-over once the comments read.",
    );
  const mine: ClaimComment = { id: own, claim };
  const claims = after.claims.some((c) => c.id === own)
    ? after.claims
    : [...after.claims, mine];
  const first = claims
    .filter((c) => c.claim.generation === generation)
    .sort((a, b) => a.id - b.id)[0];
  if (first !== undefined && first.id !== own) {
    console.error(
      `drive.ts --take-over: standing down. Claim ${first.id} from another clone (${first.claim.actor}) was posted before this one (${own}) on the same ledger generation ${generation}, so that clone drives PR #${pr}.`,
    );
    return null;
  }
  console.error(
    `ledger: claimed PR #${pr}'s drive (comment ${own}, ledger generation ${generation}).`,
  );
  return mine;
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
  state: DriveState | null,
  takeOverCommand: string,
): Promise<DriveState | null> {
  if (id === null) return state;
  const crossClone = plan?.crossClone === true;
  const snapshot = await readLedgerSnapshot(pr, id.login);
  if (typeof snapshot === "string") {
    if (crossClone)
      return fail(
        1,
        `drive.ts --take-over: PR #${pr}'s drive ledger: ${snapshot}; not claiming the drive.`,
      );
    console.error(
      `ledger: ${snapshot}; this drive starts without seeding from PR #${pr}'s ledger or checking another clone's driver, and takes its claim position from the first round boundary that reads it.`,
    );
    publish(id, null, null);
    return state;
  }
  const ledger = readLedger(pr, snapshot);
  const refusal = refuseBesideAnotherClone(
    pr,
    ledger,
    id,
    crossClone ? null : takeOverCommand,
  );
  if (refusal !== null) throw new ExitError(refusal);
  let floor = claimFloor(snapshot.claims);
  let own: ClaimComment | null = null;
  if (crossClone) {
    own = await claimDrive(pr, id, ledger?.generation ?? 0);
    if (own === null) throw new ExitError(TAKEN_OVER_EXIT);
    floor = own.id;
  }
  if (ledger !== null && snapshot.canonical !== null) {
    await seed(pr, ledger, snapshot.canonical.comment.body);
    state = await readDriveState(pr);
  }
  publish(id, floor, own);
  return state;
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
 * At a round boundary: `TAKEN_OVER_EXIT` when another clone's claim beats
 * this driver's position. A driver that started without reading the
 * comments takes its position from the first read here instead.
 */
export async function standDownOnNewerClaim(
  pr: string,
): Promise<number | null> {
  const driver = ledgerDriverFromEnv();
  if (driver === null) return null;
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  // Unread, the claims are read again at the next boundary.
  if (typeof snapshot === "string") return null;
  if (driver.floor === null) {
    publish(driver, claimFloor(snapshot.claims), driver.claim);
    return null;
  }
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
 * The driver's last ledger write, marking it stopped, however the drive's
 * code ends it: `done(code)` on a returned exit, the dispose on a thrown
 * refusal or a crash (its exit unknown here, so none is named). Written
 * once; not at all after `TAKEN_OVER`, when the ledger is the successor's.
 * A stop by signal or by `drives.ts --stop` writes nothing: once shutdown
 * begins the process starts no new command (`shared/cleanup.ts`), so its
 * ledger keeps saying "running" until the heartbeat ages past the lease
 * window, as a process killed outright does.
 */
export function ledgerSettlement(pr: string): AsyncDisposable & {
  done(code: number): Promise<number>;
} {
  let settled = false;
  const settle = async (code: number | null): Promise<void> => {
    const driver = ledgerDriverFromEnv();
    if (settled || driver === null || code === TAKEN_OVER_EXIT) return;
    settled = true;
    await run(tsArgv(driveState, ["handoff", pr]), {
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
      env: {
        ...process.env,
        [LEDGER_DRIVER_ENV]: JSON.stringify({ ...driver, stopped: code }),
      },
    });
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
