/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. Without
 * `--apply` a tick starts nothing: it reports what it would start, and why.
 * With it, the re-arms and takeovers a repository's machine-file entry
 * enables are launched within each account's cap (actions/drive.ts), its
 * follow-ups as headless passes the same way (actions/followup.ts), its
 * pickups where the runtime binds an interactive session to its account
 * (actions/pickup.ts), its nudges are
 * sent once per waiting episode (actions/steer.ts), and its notifications
 * are sent once per cause (actions/notify.ts); everything else is still
 * reported.
 *
 * Each repository's turn is its own module's (lib/tick-repo.ts), in
 * phases: observe (lib/tick-observe.ts), plan (lib/tick-plan.ts), the
 * outcome log (lib/tick-settle.ts), act (lib/tick-apply.ts) and the label
 * projection (lib/tick-labels.ts). The observe phases share what the tick
 * reads once (lib/tick-reads.ts): each pull request's comment listing, the
 * forge's login, the runtime's host-wide listings, and the forge's budget,
 * read as the tick closes; the reads just before a launch never come from
 * them.
 *
 * Control runs in every tick, `--apply` or not: before the plan, each
 * running drive's unresolved threads are recorded at its ledger's round
 * and each waiting interactive session's wall is read (expectations.ts,
 * session-walls.ts), so the plan can report the stages that drift and the
 * sessions a nudge is due for; after it, each launch record that ended gets
 * its row in the outcome log (log.ts, log-ended.ts), in the transaction that
 * writes its end, before any expired record is removed. Every record the
 * tick keeps is a row of the state database (lib/state.ts); at the end of
 * the tick the outcome log's new rows are copied into its month files
 * (lib/log-export.ts), and, after every launch, each class that recurs is
 * recorded as a reflection finding where reflection is on
 * (lib/reflection-route.ts).
 *
 * Where a repository turns dispatch labels on (lib/labels.ts), the open
 * pull requests are listed with their labels, a person's `hold` keeps
 * every stage off a pull request and `drive` asks for an arm, and, last,
 * each managed pull request's state label is set from its ledger
 * (lib/actions/labels.ts). With them off, no label is read or written.
 *
 * Another host may dispatch the same repository: every host's launch claims
 * and their ends are read beside this host's records, and with `--apply`
 * this host claims its own launches there and writes their ends
 * (lib/shared-launches.ts, lib/tick-shared.ts). Only the host that owns the
 * repository (`owner` in the machine file) notifies, writes the labels and
 * the history rows of what it did not launch.
 */
import { hostCodexOptIn } from "./lib/accounts.ts";
import { defectOf, logDefect } from "./lib/defect.ts";
import { accountsReport, timeLeftMs } from "./lib/actions/launch.ts";
import { applyInTurns } from "./lib/apply-order.ts";
import { settleFollowups } from "./lib/followup-outcomes.ts";
import { readLaunches } from "./lib/launches.ts";
import type { MachineConfig } from "./lib/machine-config.ts";
import { PhaseTimer } from "./lib/phase-timer.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type { SessionRuntime } from "./lib/runtime/port.ts";
import { applyState } from "./lib/tick-apply.ts";
import {
  allRecords,
  type TickContext,
  type TickOptions,
} from "./lib/tick-context.ts";
import { copyLog, writeTickLine } from "./lib/tick-line.ts";
import { fillBudgets, tickReads } from "./lib/tick-reads.ts";
import { defectReport, runTurn, startTurn } from "./lib/tick-repo.ts";
import { routeRecurrences } from "./lib/reflection-route.ts";
import { settleOutcomes } from "./lib/tick-settle.ts";
import type { Defect, RepoReport } from "./lib/types.ts";
import { takeScheduledUpgrade } from "../runtime/upgrade-record.ts";
import {
  newRunId,
  pruneReceipts,
  type TickPhase,
  type TickReceipt,
  takeTickLock,
  writeReceipt,
} from "./receipts.ts";

export type { TickOptions } from "./lib/tick-context.ts";

export type TickResult =
  | { held: string }
  | { receipt: TickReceipt; path: string };

function defaultRuntime(machine: MachineConfig | null): SessionRuntime {
  return machine === null
    ? orcaRuntime()
    : orcaRuntime({
        runtimeTimeoutMs: machine.runtimeTimeoutMs,
        workspaceTimeoutMs: machine.workspaceTimeoutMs,
      });
}

/** A tick once its launch records are read: its receipt so far, the context its turns share, and why `--apply` was withheld. */
interface StartedTick {
  receipt: TickReceipt;
  context: TickContext;
  withheld: string | undefined;
  /** Whether settling the launch records' follow-up outcomes failed; each repository's turn settles its own again, and the close retries. */
  settleFailed: boolean;
}

/**
 * The plugin upgrade the launcher ran before this tick, as the receipt's
 * field: taken out of the environment, so the sessions the tick launches
 * never carry it.
 */
function upgradeField(): Pick<TickReceipt, "upgrade"> {
  const upgrade = takeScheduledUpgrade();
  return upgrade === undefined ? {} : { upgrade };
}

/** Read this machine's launch records and build the apply state and the receipt the tick fills. */
async function startTick(options: TickOptions): Promise<StartedTick> {
  const now = options.now ?? new Date();
  const machine = options.machine ?? null;
  const runtime = options.runtime ?? defaultRuntime(machine);
  const read = await readLaunches();
  // An ended follow-up's outcome is written before its record can expire.
  let settleFailed = false;
  let startDefect: Defect | undefined;
  try {
    settleFollowups(read.records);
  } catch (error) {
    // A failed write must not stop every repository's turn; the turns settle their own records again.
    settleFailed = true;
    startDefect = defectOf("start", error);
    logDefect("the follow-up outcomes", startDefect, error);
  }
  const attempt = applyState(
    options,
    runtime,
    read.records,
    now.getTime(),
    read.unreadable,
  );
  // `--apply` with a machine file that was then withheld says why.
  const withheld =
    attempt !== null && "withheld" in attempt ? attempt.withheld : undefined;
  const apply = attempt !== null && "tick" in attempt ? attempt : null;
  const receipt: TickReceipt = {
    version: 1,
    runId: newRunId(now),
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    completed: false,
    apply: apply !== null,
    exitStatus: 0,
    ...upgradeField(),
    ...(withheld === undefined ? {} : { applyWithheld: withheld }),
    ...accountsReport(machine, apply),
    ...(startDefect === undefined ? {} : { defect: startDefect }),
    unreadableLaunches: read.unreadable,
    repos: [],
  };
  const context: TickContext = {
    options,
    runtime,
    nowMs: now.getTime(),
    launches: apply?.records ?? read.records,
    apply,
    lineInputs: new Map(),
    reflections: [],
    pending: [],
    reads: tickReads(runtime),
  };
  return { receipt, context, withheld, settleFailed };
}

/**
 * The per-repository boundary: a defect thrown in one repository's turn
 * stops that turn only, and its report says so; the next repository runs.
 */
async function boundedTurn(
  path: string,
  context: TickContext,
): Promise<RepoReport> {
  const turn = startTurn(path);
  try {
    return await runTurn(turn, context);
  } catch (error) {
    return defectReport(turn, error);
  }
}

/** Each repository's turn, then their launches in this tick's turns. */
async function runRepos(
  receipt: TickReceipt,
  context: TickContext,
): Promise<void> {
  const { apply, options } = context;
  for (const path of options.repos)
    receipt.repos.push(await boundedTurn(path, context));
  // The launches wait until every repository is gathered, so none holds the tick's time against another's.
  await applyInTurns(context.pending, apply?.tick ?? 0);
}

/**
 * The reflection route, after every launch: each class that recurs recorded
 * where reflection is on. What it did goes on the receipt; a failure there
 * leaves the tick's exit status as it is.
 */
async function routeReflection(
  receipt: TickReceipt,
  context: TickContext,
): Promise<void> {
  const { apply } = context;
  const reflection = await routeRecurrences(context.reflections, {
    apply: apply !== null,
    nowMs: Date.now(),
    timeLeftMs: apply === null ? null : timeLeftMs(apply),
  });
  if (reflection !== null) receipt.reflection = reflection;
}

/** The closing steps: the records of repositories not read settled, the outcome log copied, the exit decided, the line written. */
async function closeTick(
  started: StartedTick,
  timer: PhaseTimer<TickPhase>,
): Promise<void> {
  const { receipt, context, withheld, settleFailed } = started;
  const machine = context.options.machine ?? null;
  // Settle again before anything expires: a record whose outcome is still unwritten is kept.
  let unsettled = settleFailed;
  if (unsettled) {
    try {
      settleFollowups(allRecords(context));
      unsettled = false;
    } catch (error) {
      logDefect("the follow-up outcomes", defectOf("close", error), error);
    }
  }
  const failed = await settleOutcomes(
    receipt,
    context,
    machine?.receiptsDays,
    unsettled,
  );
  const copied = copyLog(receipt);
  await fillBudgets(context.reads);
  await routeReflection(receipt, context);
  receipt.exitStatus =
    failed || !copied || settleFailed || withheld !== undefined ? 1 : 0;
  // A defect the start kept on the receipt stays: the tick ran, but not whole.
  receipt.completed = receipt.defect === undefined;
  receipt.finishedAt = new Date().toISOString();
  // The dashboard's copy is written here, so it carries the phases timed so far; the receipt file adds `close`.
  receipt.phasesMs = { ...timer.ms };
  writeTickLine(receipt, {
    machine,
    repos: context.options.repos,
    records: allRecords(context),
    inputs: context.lineInputs,
    codexOptIn: context.apply?.codexOptIn ?? hostCodexOptIn(),
  });
}

/**
 * A tick that found the lock held writes no receipt of its own work; one its
 * launcher ran the plugin upgrade before gets a receipt holding that upgrade
 * and the holder, so the morning report still sees it.
 */
function heldReceipt(options: TickOptions, heldBy: string): void {
  const upgrade = upgradeField();
  if (upgrade.upgrade === undefined) return;
  const now = options.now ?? new Date();
  writeReceipt({
    version: 1,
    runId: newRunId(now),
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    completed: false,
    apply: options.apply === true,
    exitStatus: 3,
    lockHeldBy: heldBy,
    repos: [],
    ...upgrade,
  });
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const lock = takeTickLock();
  if ("heldBy" in lock) {
    heldReceipt(options, lock.heldBy);
    return { held: lock.heldBy };
  }
  try {
    const timer = new PhaseTimer<TickPhase>();
    const started = await timer.time("start", () => startTick(options));
    const { receipt } = started;
    try {
      await timer.time("repos", () => runRepos(receipt, started.context));
      await timer.time("close", () => closeTick(started, timer));
    } catch (error) {
      // A defect outside every repository's turn: the receipt is still written, and says the tick did not complete.
      receipt.defect = defectOf(timer.current ?? "close", error);
      receipt.completed = false;
      receipt.exitStatus = 1;
      receipt.finishedAt = new Date().toISOString();
      logDefect("the tick", receipt.defect, error);
    }
    receipt.phasesMs = { ...timer.ms };
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, options.machine?.receiptsDays);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
