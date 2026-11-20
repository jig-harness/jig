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
 *    account's slot, and remove the mark.
 *
 * Run again after dying between the hold and the end, it reconciles: the
 * hold stands (`already`), a live run is stopped, and a run already stopped
 * (its wrapper may have recorded its exit, or died) gets its end recorded.
 * A run that ended on its own, with no mark, is not taken over.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSING_REPORT_SCHEMA,
  type ClosingReport,
} from "../../shared/closing-report.ts";
import type { ProcessIdentity } from "../../shared/liveness.ts";
import type { Outcome } from "../../shared/outcome.ts";
import { currentIso, currentMs } from "../../shared/time.ts";
import { takeTickLock } from "../receipts.ts";
import { recordReport } from "./closing-report-store.ts";
import {
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
  /** Signal the recorded processes' groups. */
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

/** The closing report a person's take-over leaves on the run. */
function personReport(address: string): ClosingReport {
  return {
    schema: CLOSING_REPORT_SCHEMA,
    concluded:
      "A person took the run over with jig dispatch attach --take-over and stopped it; its session is theirs to resume.",
    suggested_next: {
      step: `Finish the work in the resumed session, then release the hold: jig send '${address}' release`,
      owner: "person",
      act: "Do",
    },
  };
}

/** Wait until none of the run's processes is alive, within `ms`; whether they are gone. */
async function gone(
  id: string,
  ms: number,
  deps: TakeOverDeps,
): Promise<boolean> {
  const until = currentMs() + ms;
  for (;;) {
    const row = await deps.inspect(id);
    if (row === null) return true;
    const live = await deps.members(row);
    if (live.alive.length === 0 && !live.uncertain) return true;
    if (currentMs() >= until) return false;
    await deps.sleep(Math.min(500, Math.max(1, until - currentMs())));
  }
}

/** Stop the live run: each step, then its process groups if they outlive them. */
async function stopRun(
  target: StopTarget,
  deps: TakeOverDeps,
): Promise<boolean> {
  for (const step of deps.stops) {
    deps.out(`stop: ${await step(target)}`);
    if (await gone(target.id, deps.graceMs, deps)) return true;
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    deps.out(`stop: ${await deps.signal(target.members, signal)}`);
    if (await gone(target.id, deps.graceMs, deps)) return true;
  }
  return false;
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
    recordReport(id, personReport(address), "person", deps.root);
    rmSync(takeOverMark(deps.root, id), { force: true });
    deps.out(`end: recorded by person; the account's slot is free`);
    return TAKE_OVER_EXIT.DONE;
  } finally {
    release();
  }
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
  const mark = takeOverMark(deps.root, id);
  if (row.state.kind === "ended" && !existsSync(mark)) {
    deps.err(
      `jig dispatch attach: ${id} ended on its own at ${row.state.exit.at}; there is no run to take over`,
    );
    return TAKE_OVER_EXIT.REFUSED;
  }
  const held = await deps.hold(address);
  if (!held.ok) {
    deps.err(
      `jig dispatch attach: ${address} could not be held, so the run was left going: ${held.failure.reason}`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  deps.out(
    held.value === "held"
      ? `hold: ${address} is held in your name; release it with jig send '${address}' release`
      : `hold: ${address} was already held`,
  );
  mkdirSync(join(deps.root, "runs", id), { recursive: true, mode: 0o700 });
  writeFileSync(mark, `${currentIso()}\n`, { mode: 0o600 });
  const live = await deps.members(row);
  if (live.uncertain) {
    deps.err(
      `jig dispatch attach: ${id}'s processes cannot be judged from here, so the run was not stopped; the hold stands`,
    );
    return TAKE_OVER_EXIT.FAILED;
  }
  if (live.alive.length > 0) {
    const target: StopTarget = {
      id,
      drivePr:
        record.action === "rearm" || record.action === "takeover"
          ? record.pr
          : null,
      repoPath: record.repoPath,
      members: live.identities,
    };
    if (!(await stopRun(target, deps))) {
      deps.err(
        `jig dispatch attach: ${id}'s processes outlived the stop; the hold stands, and running the command again stops it`,
      );
      return TAKE_OVER_EXIT.FAILED;
    }
  } else deps.out("stop: none of the run's processes is alive");
  return recordEnd(id, address, deps);
}
