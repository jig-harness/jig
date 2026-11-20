/**
 * `jig dispatch attach <record> --take-over`: a person takes a process run
 * over, in this order.
 *
 * 1. Hold the run's target in the person's name, as `jig send hold` does:
 *    a pull request's hold label for a drive or a follow-up, the local
 *    pickup hold for a pickup. The run still holds its slot and its
 *    in-flight launch then, so a tick already planning the target finds it
 *    held and admits nothing, and none starts anything on it until the
 *    person releases the hold.
 * 2. Mark the run as being taken over (`take-over` in its run directory).
 * 3. Stop the run (`attach-stop.ts`) and wait until none of its recorded
 *    processes is alive.
 * 4. Under the tick lock, so no tick holding the record writes it back,
 *    record its end with a closing report `by: person`, which releases the
 *    account's slot, and remove the mark. A record that still holds its
 *    slot after its end (a stage whose cleanup was never confirmed) keeps
 *    the mark and names `jig dispatch clear`. Then, outside the lock, write
 *    the end onto this host's launch claims on the forge that have none yet,
 *    as the wrapper does at its exit; a claim whose end the wrapper already
 *    wrote keeps that end.
 *
 * Run again after dying between the hold and the end, it reconciles: the
 * hold stands (`already`), a live run is stopped, and a run already stopped
 * (its wrapper may have recorded its exit, or died) gets its end recorded.
 * A run that ended on its own, with no mark, is not taken over.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLOSING_REPORT_SCHEMA,
  type ClosingReport,
} from "../../shared/closing-report.ts";
import { shellQuote } from "../../shared/cli.ts";
import { swallow } from "../../shared/errors.ts";
import type { ProcessIdentity } from "../../shared/liveness.ts";
import type { Outcome } from "../../shared/outcome.ts";
import { currentIso, currentMs } from "../../shared/time.ts";
import { takeTickLock } from "../receipts.ts";
import { recordReport } from "./closing-report-store.ts";
import {
  holds,
  type InspectedRow,
  type LaunchRecord,
  recordExit,
} from "./launches.ts";
import type { StopStep, StopTarget } from "./attach-stop.ts";

/** A take-over's exits, as `attach.ts` documents them. */
const TAKE_OVER_EXIT = {
  DONE: 0,
  FAILED: 1,
  REFUSED: 2,
  LOCK_HELD: 3,
} as const;

/** What the take-over does through, each replaced in the suite. */
export interface TakeOverDeps {
  root: string;
  inspect: (id: string) => Promise<InspectedRow | null>;
  /** The run's processes as the process table judges them. */
  members: (row: InspectedRow) => Promise<{
    alive: number[];
    uncertain: boolean;
    identities: ProcessIdentity[];
  }>;
  hold: (address: string) => Promise<Outcome<"held" | "already", "refused">>;
  /** The stop's steps, in order: the drive's stop, then the unit's or job's. */
  stops: StopStep[];
  /** The live recorded processes and their descendants, captured before the stop; `null` when the process table does not read. */
  tree: (members: ProcessIdentity[]) => Promise<ProcessIdentity[] | null>;
  /** Whether any of the captured processes is still alive, or cannot be judged. */
  anyAlive: (members: ProcessIdentity[]) => Promise<boolean>;
  /** Write the run's end onto this host's launch claims on the forge that have none yet; why any was not written. */
  settleClaims: (id: string) => Promise<string[]>;
  /** Signal the captured processes, or their groups. */
  signal: (
    members: ProcessIdentity[],
    signal: "SIGTERM" | "SIGKILL",
  ) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** How long the run's processes get to end after each stop step. */
  graceMs: number;
  /** How long to wait for a tick to release its lock before the end is written. */
  lockWaitMs: number;
}

/** The mark that says a take-over of `id` began. */
export function takeOverMark(root: string, id: string): string {
  return join(root, "runs", id, "take-over");
}

/** The captured processes of a take-over of `id`, kept so a run that dies mid-stop still knows them. */
function takeOverMembers(root: string, id: string): string {
  return join(root, "runs", id, "take-over-members.json");
}

/** The mark that says a drive stop is still owed for `id`: set before the stop begins, cleared once `drives.ts --stop` has succeeded. */
function driveStopOwed(root: string, id: string): string {
  return join(root, "runs", id, "take-over-drive-stop");
}

/** Whether `value` reads as a captured process. */
function isIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["pid"] === "number" &&
    typeof v["start"] === "string" &&
    typeof v["host"] === "string" &&
    typeof v["hostId"] === "string" &&
    typeof v["bootId"] === "string"
  );
}

/** The processes an earlier attempt captured: none when it kept none, the reason when what it kept does not read. */
function keptMembers(
  root: string,
  id: string,
): ProcessIdentity[] | { unreadable: string } {
  const path = takeOverMembers(root, id);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      swallow(error, "no earlier attempt kept the run's processes");
      return [];
    }
    return { unreadable: `${path} cannot be read: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { unreadable: `${path} is not valid JSON: ${String(error)}` };
  }
  if (!Array.isArray(parsed) || !parsed.every(isIdentity))
    return { unreadable: `${path} does not hold a list of processes` };
  return parsed;
}

/** Keep the captured processes, replacing what was kept whole. */
function keepMembers(root: string, id: string, members: ProcessIdentity[]) {
  const path = takeOverMembers(root, id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(members), { mode: 0o600 });
  renameSync(tmp, path);
}

/** `members` with those of `more` whose pid and start are not among them. */
function withMembers(
  members: ProcessIdentity[],
  more: ProcessIdentity[],
): ProcessIdentity[] {
  const known = new Set(members.map((m) => `${m.pid}@${m.start}`));
  return [...members, ...more.filter((m) => !known.has(`${m.pid}@${m.start}`))];
}

/** The station address of a record's target; `null` for a steward run, which has none. */
export function targetAddress(
  record: Pick<LaunchRecord, "action" | "repo" | "pr" | "item">,
): string | null {
  if (record.action === "pickup")
    return record.item === null ? null : `pickup@${record.repo}#${record.item}`;
  if (record.pr === null) return null;
  if (record.action === "followup")
    return `followup@${record.repo}#${String(record.pr)}`;
  if (record.action === "rearm" || record.action === "takeover")
    return `drive@${record.repo}#${String(record.pr)}`;
  return null;
}

/** The command that releases the hold on `address`. */
function releaseCommand(address: string): string {
  return `jig send ${shellQuote(address)} release`;
}

/** The closing report a person's take-over leaves on the run. */
function personReport(address: string): ClosingReport {
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded:
      "A person took the run over with jig dispatch attach --take-over and stopped it; its session is theirs to resume.",
    suggested_next: {
      step: `Finish the work in the resumed session, then release the hold: ${releaseCommand(address)}`,
      owner: "person",
      act: "Do",
    },
  };
}

/** Wait until none of the run's processes, recorded or captured, is alive, within `ms`; whether they are gone. */
async function gone(
  target: StopTarget,
  ms: number,
  deps: TakeOverDeps,
): Promise<boolean> {
  const until = currentMs() + ms;
  for (;;) {
    const row = await deps.inspect(target.id);
    const live = row === null ? null : await deps.members(row);
    const recordedGone =
      live === null || (live.alive.length === 0 && !live.uncertain);
    if (recordedGone && !(await deps.anyAlive(target.members))) return true;
    if (currentMs() >= until) return false;
    await deps.sleep(Math.min(500, Math.max(1, until - currentMs())));
  }
}

/** Stop the live run: each step, then its process groups if they outlive them; `driveStopFailed` when the drive's own stop did not succeed, whatever became of the processes. */
async function stopRun(
  target: StopTarget,
  deps: TakeOverDeps,
): Promise<{ gone: boolean; driveStopFailed: boolean }> {
  let driveStopFailed = false;
  for (const step of deps.stops) {
    const done = await step(target);
    if (typeof done === "string") deps.out(`stop: ${done}`);
    else {
      deps.out(`stop: ${done.note}`);
      driveStopFailed = true;
    }
    if (await gone(target, deps.graceMs, deps))
      return { gone: true, driveStopFailed };
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    deps.out(`stop: ${await deps.signal(target.members, signal)}`);
    if (await gone(target, deps.graceMs, deps))
      return { gone: true, driveStopFailed };
  }
  return { gone: false, driveStopFailed };
}

/** Take the tick lock, waiting up to `lockWaitMs` for a tick to finish. */
async function lockFor(deps: TakeOverDeps): Promise<(() => void) | string> {
  const until = currentMs() + deps.lockWaitMs;
  for (;;) {
    const lock = takeTickLock(deps.root);
    if (!("heldBy" in lock)) return lock.release;
    if (currentMs() >= until) return lock.heldBy;
    await deps.sleep(1000);
  }
}

/** The writes of a person's end, under the tick lock: the exit code of the first that fails, else null. */
async function writeEnd(
  id: string,
  address: string,
  deps: TakeOverDeps,
): Promise<number | null> {
  const row = await deps.inspect(id);
  if (row === null) {
    deps.err(`jig dispatch attach: launch record ${id} is gone`);
    return TAKE_OVER_EXIT.FAILED;
  }
  const live = await deps.members(row);
  if (live.alive.length > 0 || live.uncertain) {
    deps.err(
      `jig dispatch attach: ${id} has processes alive again or unjudged; run the command again`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  recordExit(
    id,
    {
      at: currentIso(),
      code: null,
      signal: "SIGTERM",
      context: "a person took the run over",
    },
    deps.root,
  );
  if (!recordReport(id, personReport(address), "person", deps.root)) {
    deps.err(
      `jig dispatch attach: the person's report could not be kept on ${id}; running the command again records it`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  const ended = await deps.inspect(id);
  if (ended !== null && holds(ended.state)) {
    deps.err(
      `jig dispatch attach: ${id} is stopped and its end recorded, but it still holds its slot (${ended.state.kind}${"reason" in ended.state ? `: ${ended.state.reason}` : ""}); free it with jig dispatch clear ${id}`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  rmSync(takeOverMark(deps.root, id), { force: true });
  rmSync(takeOverMembers(deps.root, id), { force: true });
  rmSync(driveStopOwed(deps.root, id), { force: true });
  deps.out("end: recorded by person; the account's slot is free");
  return null;
}

/** Record the run's end as a person's, under the tick lock. */
async function recordEnd(
  id: string,
  address: string,
  deps: TakeOverDeps,
): Promise<number> {
  const release = await lockFor(deps);
  if (typeof release === "string") {
    deps.err(
      `jig dispatch attach: a tick holds the lock (${release}); the run is held and stopped, and running the command again records its end`,
    );
    return TAKE_OVER_EXIT.LOCK_HELD;
  }
  try {
    const failed = await writeEnd(id, address, deps);
    if (failed !== null) return failed;
  } finally {
    release();
  }
  for (const failure of await deps.settleClaims(id))
    deps.out(
      `end: not yet on the forge's launch claim, which the next tick writes: ${failure}`,
    );
  return TAKE_OVER_EXIT.DONE;
}

/** Mark and hold the run's target: the exit code that ends the take-over, else null. */
async function holdTarget(
  row: InspectedRow & { record: LaunchRecord },
  id: string,
  address: string,
  deps: TakeOverDeps,
): Promise<number | null> {
  const mark = takeOverMark(deps.root, id);
  const markWasThere = existsSync(mark);
  if (row.state.kind === "ended" && !existsSync(mark)) {
    deps.err(
      `jig dispatch attach: ${id} ended on its own at ${row.state.exit.at}; there is no run to take over. A hold from an earlier take-over may still stand on ${address}: ${releaseCommand(address)} releases it`,
    );
    return TAKE_OVER_EXIT.REFUSED;
  }
  // The mark first: a take-over interrupted after the hold is written finds
  // it and finishes, where one with the hold and no mark would be refused.
  mkdirSync(join(deps.root, "runs", id), { recursive: true, mode: 0o700 });
  if (!existsSync(mark))
    writeFileSync(mark, `${currentIso()}\n`, { mode: 0o600 });
  const held = await deps.hold(address);
  if (!held.ok) {
    if (!markWasThere) rmSync(mark, { force: true });
    deps.err(
      `jig dispatch attach: ${address} could not be held, so the run was left going: ${held.failure.reason}`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  deps.out(
    held.value === "held"
      ? `hold: ${address} is held in your name; release it with ${releaseCommand(address)}`
      : `hold: ${address} was already held`,
  );
  return null;
}

/** The exit code when the stop did not finish, else null. */
function stopFailure(
  id: string,
  stopped: { gone: boolean; driveStopFailed: boolean },
  deps: TakeOverDeps,
): number | null {
  if (!stopped.gone) {
    deps.err(
      `jig dispatch attach: ${id}'s processes outlived the stop; the hold stands, and running the command again stops it`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  if (stopped.driveStopFailed) {
    deps.err(
      `jig dispatch attach: the run's processes are gone, but drives.ts --stop did not stop the drive, so its ledger may not read stopped; the end is not recorded and the hold stands. Stop the drive with drives.ts --stop, then run the command again`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  return null;
}

/** Stop the run's processes and the drive it runs for: the exit code that ends the take-over, else null. */
async function stopTarget(
  row: InspectedRow & { record: LaunchRecord },
  live: { alive: unknown[]; identities: ProcessIdentity[] },
  kept: ProcessIdentity[],
  deps: TakeOverDeps,
): Promise<number | null> {
  const { record } = row;
  const id = record.id;
  const drivePr =
    record.action === "rearm" || record.action === "takeover"
      ? record.pr
      : null;
  const owedMark = driveStopOwed(deps.root, id);
  const owed = existsSync(owedMark);
  const keptAlive = kept.length > 0 && (await deps.anyAlive(kept));
  if (live.alive.length > 0 || keptAlive || owed) {
    // Captured before the first step: a process the stop reparents is still known.
    const captured =
      live.alive.length > 0 ? await deps.tree(live.identities) : null;
    const target: StopTarget = {
      id,
      drivePr,
      repoPath: record.repoPath,
      members: withMembers(captured ?? live.identities, kept),
    };
    // Kept before the first step: a descendant the stop reparents is still known after an interruption.
    keepMembers(deps.root, id, target.members);
    // Owed before the first destructive step, cleared only once the drive's stop is verified: a take-over that dies mid-stop retries it.
    if (drivePr !== null && !owed)
      writeFileSync(owedMark, `${currentIso()}\n`, { mode: 0o600 });
    const stopped = await stopRun(target, deps);
    const failed = stopFailure(id, stopped, deps);
    if (failed !== null) return failed;
    rmSync(owedMark, { force: true });
  } else deps.out("stop: none of the run's processes is alive");
  return null;
}

/**
 * Take the run over: hold, mark, stop, record the end. `alreadyTaken` is a
 * run whose end a person's take-over already recorded, which only needs its
 * resume line again.
 */
export async function takeOver(
  row: InspectedRow & { record: LaunchRecord },
  alreadyTaken: boolean,
  deps: TakeOverDeps,
): Promise<number> {
  const { record } = row;
  const id = record.id;
  const address = targetAddress(record);
  if (address === null) {
    deps.err(
      `jig dispatch attach: ${id} is a ${record.action} run with no target to hold, so it cannot be taken over`,
    );
    return TAKE_OVER_EXIT.REFUSED;
  }
  if (alreadyTaken) return TAKE_OVER_EXIT.DONE;
  const refused = await holdTarget(row, id, address, deps);
  if (refused !== null) return refused;
  const live = await deps.members(row);
  if (live.uncertain) {
    deps.err(
      `jig dispatch attach: ${id}'s processes cannot be judged from here, so the run was not stopped; the hold stands`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  const kept = keptMembers(deps.root, id);
  if (!Array.isArray(kept)) {
    deps.err(
      `jig dispatch attach: the processes an earlier attempt captured for ${id} cannot be read (${kept.unreadable}), so the end is not recorded and the hold stands; check them, remove the file, then run the command again`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  const failed = await stopTarget(row, live, kept, deps);
  if (failed !== null) return failed;
  return recordEnd(id, address, deps);
}
