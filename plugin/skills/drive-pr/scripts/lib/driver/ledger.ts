/**
 * The drive ledger, as the driver uses it: seeding this clone's state from
 * the pull request, refusing to drive beside another clone's live driver,
 * taking a drive over from another clone by an append-only claim, and
 * standing down at a round boundary when another clone's claim is newer
 * than this driver's own.
 *
 * Across clones no process can be stopped and no lock is shared, so the
 * ledger arbitrates. Its driver heartbeat is the time of its last write
 * (every round boundary, park and takeover); a heartbeat older than the lease
 * window, the doctor's stall threshold (`stallThresholdMs`), is what admits
 * a takeover from another clone. The taker posts a claim naming the ledger
 * generation it read; of the claims on one generation the earliest comment
 * id wins and a later claimant stands down. Every driver reads the claims at
 * each round boundary and exits `TAKEN_OVER` when one in force from another
 * clone is newer than its own. The arbitration holds only once every driver
 * of a pull request runs a version that reads the ledger: an older driver
 * neither reads a claim nor writes a heartbeat.
 *
 * `$DRIVE_PR_LEDGER=off` runs a drive without the ledger, as a dry run does.
 * A forge that cannot be read starts the drive without the ledger rather
 * than refusing it, and says so; the next round boundary reads it again.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { fail } from "./../cli.ts";
import { stallThresholdMs } from "./../doctor.ts";
import { accountHash, resolveAccountIdentity } from "./../identity.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { resolveActor } from "./../state/actor.ts";
import {
  type ClaimComment,
  type Ledger,
  type LedgerSnapshot,
  claimFloor,
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
  ledgerDriverFromEnv,
} from "./../state/ledger-mirror.ts";
import { DRIVE_HELD_ELSEWHERE_EXIT } from "./../state/lease.ts";
import { driveState, driveTs } from "./paths.ts";
import { armCommand, readDriveState } from "./rearm.ts";
import { SINGLE_INSTANCE_LOCK_EXIT, TAKEN_OVER_EXIT } from "./settings.ts";
import type { TakeoverAdmission } from "./takeover.ts";

/** Who this driver is, as the ledger names it. */
export interface LedgerIdentity {
  actor: string;
  account: string | null;
  clone: string;
  login: string | null;
}

/** Whether this drive reads and writes the ledger. */
export function ledgerOn(dryRun: boolean): boolean {
  return !dryRun && (process.env.DRIVE_PR_LEDGER ?? "") !== "off";
}

/** The clone, by machine and state directory: stable across this clone's drives. */
function cloneId(stateDir: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${stateDir}`)
    .digest("hex")
    .slice(0, 16);
}

export async function ledgerIdentity(
  stateDir: string,
  agent: string[],
): Promise<LedgerIdentity> {
  return {
    actor: await resolveActor(),
    account: accountHash(resolveAccountIdentity(agent)),
    clone: cloneId(stateDir),
    login: await resolveLogin(),
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
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "malformed")
    console.error(
      `ledger: comment ${snapshot.canonical?.comment.id} carries the ledger marker but cannot be read (${parsed.reason}); treated as absent, and the next write replaces it.`,
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
): Promise<TakeoverAdmission | null> {
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
    fromAccount: ledger.driver.account,
    crossClone: true,
  };
}

/**
 * Post this clone's claim and see whether it is the earliest on its
 * generation: the claim when it is, `null` when a rival's came first.
 */
async function claimDrive(
  pr: string,
  id: LedgerIdentity,
  generation: number,
): Promise<ClaimComment | null> {
  const claim = {
    actor: id.actor,
    account: id.account,
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
  const claims: ClaimComment[] =
    typeof after === "string" ? [] : [...after.claims];
  if (!claims.some((c) => c.id === own)) claims.push({ id: own, claim });
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
  return { id: own, claim };
}

async function seed(
  pr: string,
  ledger: Ledger,
  body: string,
): Promise<number | null> {
  const local = await readDriveState(pr);
  if ((local?.ledgerGeneration ?? 0) >= ledger.generation) return null;
  const res = await run(tsArgv(driveState, ["seed-ledger", pr]), {
    stdin: body,
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code !== 0) {
    console.error(
      `ledger: could not seed this clone's state from the ledger (drive-state.ts seed-ledger exited ${res.code}).`,
    );
    return 1;
  }
  console.error(`ledger: ${res.stdout.trim()}.`);
  return null;
}

/**
 * Once this driver holds its locks and before it picks the drive up: report
 * untrusted markers, refuse a ledger version this code does not read, refuse
 * to drive beside another clone's running driver, claim a cross-clone
 * takeover, seed this clone's state from a newer ledger, and publish this
 * driver for the ledger's writers. Returns an exit to stop with, else `null`.
 */
export async function armLedger(
  pr: string,
  id: LedgerIdentity,
  admission: TakeoverAdmission | null,
): Promise<number | null> {
  const snapshot = await readLedgerSnapshot(pr, id.login);
  if (typeof snapshot === "string") {
    if (admission?.crossClone === true)
      return fail(
        1,
        `drive.ts --take-over: PR #${pr}'s drive ledger: ${snapshot}; not claiming the drive.`,
      );
    console.error(
      `ledger: ${snapshot}; this drive starts without seeding from PR #${pr}'s ledger or checking another clone's driver.`,
    );
    publish(id, 0, null);
    return null;
  }
  report(snapshot);
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind === "unknown-version")
    return fail(
      1,
      `drive.ts: PR #${pr}'s drive ledger (comment ${snapshot.canonical?.comment.id}) is ledgerVersion ${String(parsed.version)}, which this version of drive-pr does not read. Update the plugin and re-arm.`,
    );
  const ledger = readableLedger(snapshot);
  const crossClone = admission?.crossClone === true;
  if (ledger !== null && otherCloneDriving(ledger, id)) {
    const age = heartbeatAgeMs(ledger, new Date());
    const stale = age > stallThresholdMs();
    if (!crossClone) {
      console.error(
        `drive.ts: PR #${pr} is driven from another clone: its drive ledger names a running driver (${ledger.driver.actor}) with a heartbeat ${minutes(age)} minute(s) old.`,
      );
      console.error(
        stale
          ? `Its heartbeat is past the lease window, so a takeover is admitted:\n  ${armCommand(driveTs, pr, " --take-over")}`
          : "Do not drive beside it; a takeover is admitted once its heartbeat is older than the lease window.",
      );
      return DRIVE_HELD_ELSEWHERE_EXIT;
    }
    if (!stale)
      return fail(
        SINGLE_INSTANCE_LOCK_EXIT,
        `drive.ts --take-over: PR #${pr}'s ledger was written again by the other clone's driver (heartbeat ${minutes(age)} minute(s) old); not taking over.`,
      );
  } else if (crossClone)
    return fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: PR #${pr}'s ledger no longer names a running driver in another clone; re-arm without --take-over.`,
    );
  let floor = claimFloor(snapshot.claims);
  let own: ClaimComment | null = null;
  if (crossClone) {
    own = await claimDrive(pr, id, ledger?.generation ?? 0);
    if (own === null) return TAKEN_OVER_EXIT;
    floor = own.id;
  }
  if (ledger !== null && snapshot.canonical !== null) {
    const seeded = await seed(pr, ledger, snapshot.canonical.comment.body);
    if (seeded !== null) return seeded;
  }
  publish(id, floor, own);
  return null;
}

function publish(
  id: LedgerIdentity,
  floor: number,
  claim: ClaimComment | null,
): void {
  const env: LedgerDriverEnv = { ...id, floor, claim };
  process.env[LEDGER_DRIVER_ENV] = JSON.stringify(env);
}

/** At a round boundary: `TAKEN_OVER_EXIT` when another clone's newer claim is in force. */
export async function standDownOnNewerClaim(
  pr: string,
): Promise<number | null> {
  const driver = ledgerDriverFromEnv();
  if (driver === null) return null;
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  // Unread, the claims are read again at the next boundary.
  if (typeof snapshot === "string") return null;
  const claim = newerClaim(
    snapshot.claims,
    driver.floor,
    driver.clone,
    driver.claim,
  );
  if (claim === null) return null;
  console.error(
    `drive.ts: taken over. Another clone (${claim.claim.actor}) claimed PR #${pr}'s drive in comment ${claim.id}, after this driver's own position (${driver.floor}); stopping at this round boundary without another pass. That clone drives now.`,
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

/** The driver's last ledger write, naming the exit it stops with. */
export async function settleLedger(pr: string, code: number): Promise<number> {
  const driver = ledgerDriverFromEnv();
  if (driver === null || code === TAKEN_OVER_EXIT) return code;
  await run(tsArgv(driveState, ["handoff", pr]), {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    env: {
      ...process.env,
      [LEDGER_DRIVER_ENV]: JSON.stringify({ ...driver, stopped: code }),
    },
  });
  return code;
}
