/**
 * `jig dispatch attach <record> [--take-over]`: a person watches a process
 * run, or takes it over (design/dispatched-sessions.md § Attaching to a run).
 *
 * Without `--take-over` it prints the run's worktree, account, stage and how
 * long it has run, then follows its spool (`runs/<record>/output.log` in the
 * dispatcher's state) until the run ends: its record ended or gone, and none
 * of its recorded processes alive. Interrupting it detaches the person and
 * leaves the run going. It writes nothing.
 *
 * With `--take-over` it prints the same lines, then holds the run's target,
 * stops the run and records its end `by: person`
 * (`lib/attach-take-over.ts`), and prints the command that resumes the
 * vendor's session in the worktree under the same account's directory
 * (`lib/attach-resume.ts`). The command is printed, not run.
 *
 * Only a record whose runtime is `process` is attached to: on Orca the
 * run's tab already shows it.
 *
 * Exit codes: 0 followed to the end, or taken over (an interrupt detaches
 * and ends the command as an interrupt does, 130); 1 the hold
 * could not be written, the run's processes could not be judged or outlived
 * the stop; 2 usage, no such record, a record that does not read, one not on
 * the process runtime, a steward run to take over, or one that ended on its
 * own; 3 a tick holds the lock while the end is to be written (the run is
 * held and stopped; run the command again).
 */
import { join } from "node:path";
import { registerSignalHandler } from "../shared/cleanup.ts";
import { processTable } from "../shared/process-table.ts";
import { currentMs, parseMs } from "../shared/time.ts";
import { followSpool } from "./lib/attach-follow.ts";
import { resumeLine } from "./lib/attach-resume.ts";
import { signalMembers, stopDrive, stopService } from "./lib/attach-stop.ts";
import { takeOver, type TakeOverDeps } from "./lib/attach-take-over.ts";
import { readKeptReport } from "./lib/closing-report-store.ts";
import {
  type InspectedRow,
  inspectRow,
  isRecordId,
  type LaunchExit,
  type LaunchRecord,
} from "./lib/launches.ts";
import { readRoundSessions } from "./lib/round-sessions.ts";
import { identities, membersOf } from "./lib/runtime/process.ts";
import { existingStateDb } from "./lib/state.ts";
import { stateRoot } from "./receipts.ts";

export interface AttachDeps extends TakeOverDeps {
  /** Write the spool's output through. */
  write: (chunk: Buffer | string) => void;
  /** Aborted when the person interrupts the watch. */
  signalAbort: AbortSignal;
  /** How often the spool is read again. */
  intervalMs: number;
}

/** `ms` as hours, minutes and seconds. */
function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const parts = [
    [Math.floor(s / 3600), "h"],
    [Math.floor((s % 3600) / 60), "m"],
    [s % 60, "s"],
  ] as const;
  const shown = parts.filter(([n], i) => n > 0 || i === 2).slice(0, 2);
  return shown.map(([n, unit]) => `${n}${unit}`).join(" ");
}

/** The lines that say which run this is and where it stands. */
export function headerLines(
  row: InspectedRow & { record: LaunchRecord },
  nowMs: number,
): string[] {
  const { record, state } = row;
  const claim = "process" in state ? state.process : null;
  const since = parseMs(
    claim !== null && claim.claimedAt !== ""
      ? claim.claimedAt
      : record.createdAt,
  );
  const target = record.item ?? (record.pr === null ? "" : `PR #${record.pr}`);
  const ran =
    state.kind === "ended"
      ? `ran for ${spanText(parseMs(state.exit.at) - since)}, ended at ${state.exit.at}`
      : state.kind === "pending"
        ? `not started yet; recorded ${spanText(nowMs - since)} ago`
        : `running for ${spanText(nowMs - since)}`;
  return [
    `run: ${record.id}, ${record.action}${target === "" ? "" : ` of ${target}`} in ${record.repo}`,
    `worktree: ${record.workspace?.path ?? "none opened yet"}`,
    `account: ${record.account} (${record.vendor})`,
    `stage: ${record.action}, ${state.kind}`,
    ran,
  ];
}

/** What the resume line reads beside the record: its sessions, its report and its exit. */
function runColumns(
  id: string,
  root: string,
): { sessions: string | null; report: string | null } {
  const db = existingStateDb(root);
  const row = db
    ?.query("SELECT sessions, report FROM launches WHERE id = ?")
    .get(id) as { sessions: string | null; report: string | null } | null;
  return row ?? { sessions: null, report: null };
}

function exitOf(row: InspectedRow): LaunchExit | null {
  return row.state.kind === "ended" ? row.state.exit : null;
}

/** Whether the run is over: its record gone, or ended or died with none of its processes alive. */
async function runOver(id: string, deps: AttachDeps): Promise<boolean> {
  const row = await deps.inspect(id);
  if (row === null) return true;
  const { kind } = row.state;
  if (kind === "pending" || kind === "alive") return false;
  const live = await deps.members(row);
  return live.alive.length === 0 && !live.uncertain;
}

/** The suite's seams, as the command uses them. */
function attachDeps(root: string, signalAbort: AbortSignal): AttachDeps {
  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      const stop = () => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(() => {
        signalAbort.removeEventListener("abort", stop);
        done();
      }, ms);
      signalAbort.addEventListener("abort", stop, { once: true });
    });
  return {
    root,
    inspect: (id) => inspectRow(id, root),
    members: async (row) => {
      const rows = await processTable();
      const judged = membersOf(row, rows);
      const alive = new Set(judged.alive);
      return {
        ...judged,
        identities: identities(row).filter((m) => alive.has(m.pid)),
      };
    },
    hold: async (address) =>
      (await import("../send/cli.ts")).holdTarget(address),
    stops: [stopDrive, stopService],
    signal: signalMembers,
    sleep,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    write: (chunk) => process.stdout.write(chunk),
    signalAbort,
    intervalMs: 1000,
    graceMs: 30_000,
    lockWaitMs: 60_000,
  };
}

export async function attachMain(
  id: string,
  options: { takeOver: boolean },
  given?: AttachDeps,
): Promise<number> {
  if (!isRecordId(id)) {
    (given?.err ?? console.error)(
      `jig dispatch attach: ${id} is not a launch record id`,
    );
    return 2;
  }
  if (given !== undefined) return attachRun(id, options, given);
  const controller = new AbortController();
  let finished: Promise<number> = Promise.resolve(0);
  // An interrupt detaches a watch, which prints its last line; a take-over
  // runs on to its end, each of its waits bounded. Then the process ends as
  // interrupted.
  using _interrupt = registerSignalHandler(async () => {
    if (!options.takeOver) controller.abort();
    await finished;
  });
  finished = attachRun(id, options, attachDeps(stateRoot(), controller.signal));
  return await finished;
}

async function attachRun(
  id: string,
  options: { takeOver: boolean },
  deps: AttachDeps,
): Promise<number> {
  const row =
    existingStateDb(deps.root) === null ? null : await deps.inspect(id);
  if (row === null) {
    deps.err(`jig dispatch attach: no launch record ${id}`);
    return 2;
  }
  const { record } = row;
  if (record === null) {
    deps.err(`jig dispatch attach: launch record ${id} does not read`);
    return 2;
  }
  if (record.runtime !== "process") {
    deps.err(
      `jig dispatch attach: ${id} runs on Orca, whose tab already shows the run; attach is for the process runtime`,
    );
    return 2;
  }
  const read = { ...row, record };
  for (const line of headerLines(read, currentMs())) deps.out(line);
  if (!options.takeOver) {
    const spool = join(deps.root, "runs", id, "output.log");
    const how = await followSpool(spool, {
      over: () => runOver(id, deps),
      write: deps.write,
      sleep: deps.sleep,
      signal: deps.signalAbort,
      intervalMs: deps.intervalMs,
    });
    deps.out(
      how === "ended" ? "the run has ended" : "detached; the run goes on",
    );
    return 0;
  }
  const before = runColumns(id, deps.root);
  const taken = readKeptReport(before.report)?.by === "person";
  const code = await takeOver(read, taken && row.state.kind === "ended", deps);
  if (code !== 0) return code;
  const after = await deps.inspect(id);
  const columns = runColumns(id, deps.root);
  deps.out(
    `resume: ${resumeLine({
      record: after?.record ?? record,
      sessions: readRoundSessions(columns.sessions),
      exit: after === null ? null : exitOf(after),
    })}`,
  );
  return 0;
}
