/**
 * The drive ledger, written from the drive state on the path that
 * regenerates the handoff file: `drive-state.ts handoff` (which the driver
 * runs at every round boundary, after a takeover and when it stops) and
 * `drive-state.ts park` each mirror the state they just wrote to the pull
 * request. `drive-state.ts seed-ledger` is the opposite direction: it lays a
 * newer ledger over this clone's state.
 *
 * Only a driver writes the ledger. `drive.ts` publishes who it is in
 * `$DRIVE_PR_LEDGER_DRIVER` (its working tree, clone, forge
 * login and claim floor) once it holds its locks, and every child inherits
 * it; a session that is not a drive's child has no such variable and leaves
 * the ledger alone.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { CLAIM_PREFIX, parseClaimText } from "../claim.ts";
import { fail } from "../cli.ts";
import { handoffNarrative, installNarrative } from "./handoff.ts";
import {
  type ClaimComment,
  type LedgerSnapshot,
  effectiveClaims,
  ledgerFromState,
  ledgerOfStoppedDriver,
  newerClaim,
  parseLedger,
  seedFromLedger,
} from "./ledger.ts";
import { writeLedger } from "./ledger-forge.ts";
import { freshState } from "./schema.ts";
import type { StateStore } from "./store.ts";

export const LEDGER_DRIVER_ENV = "DRIVE_PR_LEDGER_DRIVER";

/** What a driver publishes about itself for the ledger's writers. */
export interface LedgerDriverEnv {
  actor: string;
  clone: string;
  login: string | null;
  /**
   * This driver's own claim id, or the newest claim in force when it started;
   * `null` until the comments have been read once.
   */
  floor: number | null;
  /** This driver's own takeover claim, when it took the drive over by one. */
  claim: ClaimComment | null;
  /** Set on the driver's last write: the exit it stops with, `null` unknown. */
  stopped?: number | null;
  /** The driver's lock acquisition time. */
  started?: string;
  /**
   * Set by a stop recovery from outside the driver (`lib/ledger-stop.ts`):
   * every snapshot the write is built from must still name this driver as
   * running (`ledgerOfStoppedDriver`), so it never overwrites a successor.
   */
  recovering?: boolean;
}

export function ledgerDriverFromEnv(): LedgerDriverEnv | null {
  const raw = process.env[LEDGER_DRIVER_ENV] ?? "";
  if (raw === "") return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isRecord(v) &&
      typeof v.actor === "string" &&
      typeof v.clone === "string" &&
      (v.login === null || typeof v.login === "string") &&
      (v.floor === null || typeof v.floor === "number") &&
      (v.claim === null || isRecord(v.claim)) &&
      (v.stopped === undefined ||
        v.stopped === null ||
        typeof v.stopped === "number") &&
      (v.started === undefined || typeof v.started === "string") &&
      (v.recovering === undefined || typeof v.recovering === "boolean")
    )
      return v as unknown as LedgerDriverEnv;
  } catch {
    // An unreadable variable is no driver: the ledger is left alone.
  }
  return null;
}

/** Whether PR `pr`'s drive lock is held by the acquisition made at `started`. */
function holdsPrLock(stateDir: string, pr: string, started: string): boolean {
  const dir = join(stateDir, `pr-drive-${pr}.lock`);
  try {
    const claims = readdirSync(dir).filter(
      (n) => n.startsWith(CLAIM_PREFIX) && n.length > CLAIM_PREFIX.length,
    );
    if (claims.length !== 1) return false;
    const record = parseClaimText(
      readFileSync(join(dir, claims[0] as string), "utf8"),
    );
    return record?.diag?.started === started;
  } catch (err) {
    swallow(err, "the PR's drive lock could not be read");
    return false;
  }
}

/** Why `driver` may not write over `snapshot`; `''` when it may. */
function writeRefused(
  snapshot: LedgerSnapshot,
  driver: LedgerDriverEnv,
): string {
  if (driver.recovering === true) {
    const found = ledgerOfStoppedDriver(snapshot, {
      actor: driver.actor,
      clone: driver.clone,
      started: driver.started ?? "",
    });
    if ("why" in found)
      return `the ledger is not the stopped driver's: ${found.why}`;
  }
  // With no position yet nothing is newer than this driver: the round
  // boundary sets the position before this driver writes again.
  const claim = newerClaim(
    snapshot.claims,
    driver.floor ?? Number.POSITIVE_INFINITY,
    driver.clone,
    driver.claim,
  );
  return claim === null
    ? ""
    : `a newer takeover claim (comment ${claim.id}) from another clone is on the pull request`;
}

/**
 * Mirror this clone's state into the ledger, when a driver is running.
 * Best-effort: a forge failure is reported, never turned into a failure of
 * the state change that already landed. A newer takeover claim from another
 * clone stops the write, so a driver that has been taken over never
 * overwrites its successor's ledger.
 */
export async function mirrorLedger(
  pr: string,
  store: StateStore,
): Promise<void> {
  const driver = ledgerDriverFromEnv();
  if (driver === null) return;
  // A child that outlived its driver keeps the driver's variable: only the
  // acquisition it names, still holding the PR's lock, writes as that driver.
  // A stop recovery writes for a driver that is gone, under its own guard.
  if (
    driver.recovering !== true &&
    driver.started !== undefined &&
    !holdsPrLock(store.stateDir, pr, driver.started)
  ) {
    console.error(
      `ledger: not written — the driver this process writes for (acquired ${driver.started}) no longer holds PR #${pr}'s lock.`,
    );
    return;
  }
  const narrative = await handoffNarrative(pr);
  const result = await writeLedger(pr, driver.login, (snapshot) => {
    if (snapshot.untrusted.length > 0)
      console.error(
        `ledger: ignored ${snapshot.untrusted.length} comment(s) carrying a drive marker from an untrusted author (ids ${snapshot.untrusted.map((c) => c.id).join(", ")}).`,
      );
    const refused = writeRefused(snapshot, driver);
    if (refused !== "") return refused;
    // Read on every attempt: a write rebuilt after another writer moved the
    // ledger carries the state that writer published, not an older read.
    const { state } = store.read();
    return ledgerFromState(state, {
      generation:
        Math.max(snapshot.maxGeneration, state.ledgerGeneration ?? 0) + 1,
      driver: {
        actor: driver.actor,
        clone: driver.clone,
        heartbeat: new Date().toISOString(),
        state: driver.stopped === undefined ? "running" : "stopped",
        ...(typeof driver.stopped === "number" ? { exit: driver.stopped } : {}),
        ...(driver.started === undefined ? {} : { started: driver.started }),
        ...(driver.floor === null ? {} : { position: driver.floor }),
      },
      narrative,
      claims: effectiveClaims(
        driver.claim === null ||
          snapshot.claims.some((c) => c.id === driver.claim?.id)
          ? snapshot.claims
          : [...snapshot.claims, driver.claim],
      ).map((c) => ({
        id: c.id,
        clone: c.claim.clone,
        generation: c.claim.generation,
      })),
    });
  });
  if (result.kind !== "written") {
    console.error(`ledger: not written — ${result.reason}.`);
    return;
  }
  const notes = [
    result.cut.length > 0 ? `cut: ${result.cut.join(", ")}` : "",
    result.deleted.length > 0
      ? `deleted this login's duplicate(s) ${result.deleted.join(", ")}`
      : "",
  ].filter((n) => n !== "");
  console.error(
    `ledger: generation ${result.generation} written to comment ${result.id}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}.`,
  );
  await store.update((s) =>
    (s.ledgerGeneration ?? 0) >= result.generation
      ? s
      : { ...s, ledgerGeneration: result.generation },
  );
}

/**
 * `drive-state.ts seed-ledger <PR>`: the ledger comment's body on standard
 * input, laid over this clone's state when it is newer than the generation
 * the state was last written or seeded at. Prints what it did.
 */
export async function seedLedgerCommand(
  store: StateStore,
  body: string,
): Promise<number> {
  const parsed = parseLedger(body);
  if (parsed === null || parsed.kind === "malformed")
    return fail(
      2,
      `seed-ledger: standard input is not a drive ledger${parsed === null ? "" : ` (${parsed.reason})`}`,
    );
  if (parsed.kind === "unknown-version")
    return fail(
      2,
      `seed-ledger: ledgerVersion ${String(parsed.version)} is not a version this drive reads`,
    );
  const ledger = parsed.ledger;
  let outcome = "";
  let invalid = "";
  await store.update((s) => {
    if ((s.ledgerGeneration ?? 0) >= ledger.generation) {
      outcome = `current: this clone's state is at generation ${s.ledgerGeneration ?? 0}`;
      return s;
    }
    const seeded = seedFromLedger(s, ledger);
    if ("error" in seeded) {
      invalid = seeded.error;
      return s;
    }
    outcome = `seeded from generation ${ledger.generation}: round ${ledger.round}, ${seeded.state.parked.length} parked, ${seeded.state.held.length} held${seeded.dropped.length > 0 ? `; held without an outcome, triaged afresh: ${seeded.dropped.join(", ")}` : ""}`;
    return seeded.state;
  });
  if (invalid !== "") return fail(1, `seed-ledger: ${invalid}`);
  // The last driver's notes travel with its state, or the next write here
  // would replace them on the pull request with this clone's older ones.
  if (outcome.startsWith("seeded"))
    await installNarrative(String(ledger.pr), ledger.narrative);
  process.stdout.write(`${outcome}\n`);
  return 0;
}

/**
 * `drive-state.ts reset`'s removal of the state file, keeping the ledger
 * generation the state had reached: without it, the next arm would read the
 * ledger as newer than the fresh state and seed back everything the reset
 * forgot. The ledger's next write then carries the reset state. A file too
 * damaged to read a generation from is removed outright.
 */
/** The clone, by machine and state directory: stable across this clone's drives. */
export function cloneId(stateDir: string): string {
  return createHash("sha256")
    .update(`${hostname()}\0${stateDir}`)
    .digest("hex")
    .slice(0, 16);
}

export function removeStateKeepingLedgerGeneration(
  store: StateStore,
  pr: number,
): void {
  let generation = 0;
  try {
    const raw: unknown = JSON.parse(readFileSync(store.file, "utf8"));
    if (isRecord(raw) && typeof raw.ledgerGeneration === "number")
      generation = raw.ledgerGeneration;
  } catch (err) {
    swallow(err, "the state file being reset holds no ledger generation");
  }
  rmSync(store.file, { force: true });
  if (Number.isInteger(generation) && generation > 0)
    store.write({ ...freshState(pr), ledgerGeneration: generation });
}
