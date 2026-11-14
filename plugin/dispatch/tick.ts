/**
 * One tick, in two phases. The observe phase opens every repository first,
 * reads shared tracker queues, then derives every repository's work at once
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), each
 * repository under its observe lock and every read through one bounded pool
 * (lib/pool.ts). The act phase, under the act lock, then takes the
 * repositories one at a time in this tick's rotated order: plan wanted minus
 * running, report, and with `--apply` launch; then the tick writes its
 * receipt. Without `--apply` a tick starts nothing: it reports what it
 * would start, and why. With it, the re-arms and takeovers a repository's
 * machine-file entry enables are launched within each account's cap
 * (actions/drive.ts), its follow-ups as headless passes the same way
 * (actions/followup.ts) and its pickups as `do-item` passes
 * (actions/pickup.ts), its nudges are sent once per
 * waiting episode (actions/steer.ts), and its notifications are sent once
 * per cause (actions/notify.ts); everything else is still reported.
 *
 * The locks (receipts.ts) are taken in one order: each repository's observe
 * lock first, never waited for (a repository another tick holds is left to
 * it, and said on the receipt), then the act lock (`tick.lock`, the file
 * every earlier version took for its whole tick), waited for within
 * `ACT_LOCK_WAIT_MS`. A repository's observe lock is kept until its act
 * part is done, so a tick for one repository (a wake-up) reads and acts on
 * it while a sweep reads or acts on the others, and no two ticks act at
 * once. Everything the act phase depends on beyond the observation is read
 * again under the act lock: the launch records, from which the apply state
 * (slots, the opens' allowance, the account turn, the rotation cursor and
 * the deadline) is built, and each target just before its launch.
 *
 * Each repository's turn is its own module's (lib/tick-repo.ts), in
 * phases: observe (lib/tick-observe.ts), then, in the act phase, plan
 * (lib/tick-plan.ts), the outcome log (lib/tick-settle.ts), act
 * (lib/tick-apply.ts) and the label projection (lib/tick-labels.ts). The
 * observe phases share what the tick reads once (lib/tick-reads.ts): each
 * pull request's comment listing, the forge's login, the runtime's
 * host-wide listings, and the forge's budget, read as the tick starts; the
 * reads just before a launch never come from them. While that budget is
 * low, the optional reads (thread samples, serialization's reads) are
 * skipped, and the receipt says so.
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
 * What fails in a row is counted in the failure ledger (lib/failures.ts),
 * with `--apply` and a machine file: each label write, notice, nudge, claim
 * end and marker answer the act phase attempts, each repository's turn and
 * the tick as a whole, the last two once the exit is decided
 * (lib/tick-settle.ts). An action that keeps failing backs off, reported as
 * waiting until its next try, and a row past `failures.notify_after` is
 * notified to a person (lib/failure-notices.ts). What is wanted is still
 * derived every tick: a row only remembers failures, and goes when its
 * action succeeds or leaves the plan.
 *
 * Another host may dispatch the same repository: every host's launch claims
 * and their ends are read beside this host's records, and with `--apply`
 * this host claims its own launches there and writes their ends
 * (lib/shared-launches.ts, lib/tick-shared.ts). Only the host that owns the
 * repository (`owner` in the machine file) notifies, writes the labels and
 * the history rows of what it did not launch.
 */
import {
  DEFAULT_DISPATCHER_SHARE,
  setDispatcherShare,
} from "../shared/tracker-budget.ts";
import { hostCodexOptIn } from "./lib/accounts.ts";
import { defectOf, logDefect } from "./lib/defect.ts";
import { accountsReport, timeLeftMs } from "./lib/actions/launch.ts";
import { applyInTurns } from "./lib/apply-order.ts";
import { prepareTrackers } from "./lib/tick-trackers.ts";
import { settleFollowups } from "./lib/followup-outcomes.ts";
import { type ReadRecord, readLaunches } from "./lib/launches.ts";
import type { MachineConfig } from "./lib/machine-config.ts";
import { PhaseTimer } from "./lib/phase-timer.ts";
import { dropRepeatedLabelNeeds } from "./lib/sources/served-repo.ts";
import { dropRepeatedScopeFailures } from "./lib/sources/scope-failures.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type { SessionRuntime } from "./lib/runtime/port.ts";
import { applyState } from "./lib/tick-apply.ts";
import { loadReport } from "./lib/load.ts";
import { readTickLoad } from "./lib/tick-load.ts";
import {
  allRecords,
  type TickContext,
  type TickOptions,
} from "./lib/tick-context.ts";
import { copyLog, recordTickHealth, writeTickLine } from "./lib/tick-line.ts";
import {
  fillBudgets,
  lowBudget,
  OPTIONAL_READS,
  tickReads,
} from "./lib/tick-reads.ts";
import {
  actTurn,
  defectReport,
  type Observed,
  openTurn,
  observeOpenedTurn,
  startTurn,
} from "./lib/tick-repo.ts";
import { routeRecurrences } from "./lib/reflection-route.ts";
import {
  finalizeTickFailure,
  settleFailures,
  settleOutcomes,
} from "./lib/tick-settle.ts";
import { launchedMeanwhile } from "./lib/tick-plan.ts";
import type { RepoReport } from "./lib/types.ts";
import {
  type ScheduledUpgrade,
  takeScheduledUpgrade,
} from "../runtime/upgrade-record.ts";
import { ExitError } from "../shared/cli.ts";
import { swallow } from "../shared/errors.ts";
import {
  heldSystems,
  holdUnanswered,
  stopHolding,
} from "../shared/outbound/hold.ts";
import { join } from "node:path";
import {
  type Lock,
  newRunId,
  pruneReceipts,
  stateRoot,
  type TickPhase,
  type TickReceipt,
  takeObserveLock,
  takeRepositoryLock,
  takeTickLock,
  writeReceipt,
} from "./receipts.ts";
import { currentIso, currentMs, isoOf } from "../shared/time.ts";

export type { TickOptions } from "./lib/tick-context.ts";

export type TickResult =
  | { held: string }
  | { receipt: TickReceipt; path: string };

/** A lock this tick holds. */
type Held = Exclude<Lock, { heldBy: string }>;

/** How long the act phase waits for another tick's act lock: past it, the tick ends as one that found the lock held. */
const ACT_LOCK_WAIT_MS = 120_000;
/** How often the act phase looks at the act lock again while it waits. */
const ACT_LOCK_POLL_MS = 250;

function defaultRuntime(machine: MachineConfig | null): SessionRuntime {
  return machine === null
    ? orcaRuntime()
    : orcaRuntime({
        runtimeTimeoutMs: machine.runtimeTimeoutMs,
        workspaceTimeoutMs: machine.workspaceTimeoutMs,
      });
}

/** A tick once it started: its receipt so far, the context its turns share, and, once the act phase began, why `--apply` was withheld. */
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

/** Read this machine's launch records as the observe phase sees them, and the receipt the tick fills. */
/** Where the systems a tick held outlive it, for the next tick's probe (`shared/outbound/hold.ts`). */
const UNANSWERED_FILE = "unanswered.json";

async function startTick(options: TickOptions): Promise<StartedTick> {
  // The deadline counts from here, so the startup read below spends it too.
  const startedMs = currentMs();
  const now = options.now ?? Temporal.Now.instant();
  const machine = options.machine ?? null;
  // The tick's tracker reads keep to their share of each credential's budget.
  setDispatcherShare(machine?.trackerShare ?? DEFAULT_DISPATCHER_SHARE);
  // A system that does not answer is not asked again in this tick, and the next tick probes it once first.
  holdUnanswered(join(stateRoot(), UNANSWERED_FILE));
  const runtime = options.runtime ?? defaultRuntime(machine);
  const read = await readLaunches();
  const receipt: TickReceipt = {
    version: 1,
    runId: newRunId(now),
    startedAt: isoOf(now),
    finishedAt: isoOf(now),
    completed: false,
    apply: false,
    exitStatus: 0,
    ...upgradeField(),
    unreadableLaunches: read.unreadable,
    repos: [],
  };
  const context: TickContext = {
    options,
    runtime,
    nowMs: now.epochMilliseconds,
    startedMs,
    launches: read.records,
    apply: null,
    lineInputs: new Map(),
    reflections: [],
    pending: [],
    reads: tickReads(runtime, options.poolSize),
  };
  return { receipt, context, withheld: undefined, settleFailed: false };
}

/** A repository's observation that was made, as opposed to one another tick held. */
type Settled = Exclude<Observed, { busy: string }>;

/** The observe phase's result: each repository's observation by path, and the repositories another tick holds. */
interface ObservedAll {
  observed: Map<string, Settled>;
  busy: Map<string, string>;
}

/**
 * Every repository observed at once, each under its observe lock, each
 * inside its boundary: a defect stops that repository's turn only. A
 * repository whose lock another tick holds is not read.
 */
async function observeAll(
  context: TickContext,
  locks: Map<string, Held>,
): Promise<ObservedAll> {
  const out: ObservedAll = { observed: new Map(), busy: new Map() };
  // The budget decides the optional reads: read once, while the first reads run.
  void context.reads.budget();
  // A repository named twice is read once.
  // Checkouts of one repository in this tick share the repository's lock: the first holds it.
  const claimed = new Set<string>();
  const prepared: Array<
    Extract<Awaited<ReturnType<typeof openTurn>>, { turn: unknown }>
  > = [];
  // Every configuration is awaited, taking its lock included, before tracker reads begin.
  await Promise.all(
    [...new Set(context.options.repos)].map(async (path) => {
      const turn = startTurn(path);
      const own: Held[] = [];
      const give = () => {
        for (const lock of own) lock.release();
        locks.delete(path);
      };
      try {
        const lock = takeObserveLock(path);
        if ("heldBy" in lock) {
          out.busy.set(path, lock.heldBy);
          return;
        }
        own.push(lock);
        locks.set(path, {
          release: () => {
            for (const held of own) held.release();
          },
        });
        const observed = await openTurn(turn, context, (slug) => {
          if (claimed.has(slug)) return null;
          const repository = takeRepositoryLock(slug);
          if ("heldBy" in repository) return repository.heldBy;
          claimed.add(slug);
          own.push(repository);
          return null;
        });
        if ("busy" in observed) {
          out.busy.set(path, observed.busy);
          give();
        } else if ("turn" in observed) prepared.push(observed);
        else out.observed.set(path, observed);
      } catch (error) {
        out.observed.set(path, { report: defectReport(turn, error) });
      }
    }),
  );
  await prepareTrackers(
    prepared.map(({ opened }) => opened),
    context,
  );
  await Promise.all(
    prepared.map(async (opened) => {
      try {
        const observed = await observeOpenedTurn(opened, context);
        if (!("busy" in observed)) out.observed.set(opened.turn.path, observed);
      } catch (error) {
        out.observed.set(opened.turn.path, {
          report: defectReport(opened.turn, error),
        });
      }
    }),
  );
  return out;
}

/** The act lock, waited for within `waitMs`; who holds it when the wait ran out. */
async function waitForActLock(
  waitMs: number,
  context: TickContext,
): Promise<Lock> {
  const deadline = currentMs() + waitMs;
  for (;;) {
    const lock = takeTickLock();
    if (!("heldBy" in lock) || currentMs() >= deadline) return lock;
    // Another tick acts meanwhile, one of an earlier version perhaps, which takes no observe lock.
    context.actWaited = true;
    await Bun.sleep(ACT_LOCK_POLL_MS);
  }
}

/**
 * The act phase's start, under the act lock: this machine's launch records
 * read again, their follow-up outcomes settled, and the apply state built
 * from them, its deadline counted from the start of the invocation.
 */
async function startAct(started: StartedTick): Promise<void> {
  const { receipt, context } = started;
  const { options, runtime } = context;
  const read = await readLaunches();
  // A launch record the startup read did not hold was made by a tick that acted meanwhile, one of an
  // earlier version perhaps, which takes no observe lock: the free act lock does not say it did not.
  if (launchedMeanwhile(context.launches, read.records))
    context.actWaited = true;
  // An ended follow-up's outcome is written before its record can expire.
  try {
    settleFollowups(read.records);
  } catch (error) {
    // A failed write must not stop every repository's turn; the turns settle their own records again.
    started.settleFailed = true;
    receipt.defect = defectOf("start", error);
    logDefect("the follow-up outcomes", receipt.defect, error);
  }
  const attempt = applyState(
    options,
    runtime,
    read.records,
    context.nowMs,
    read.unreadable,
    context.startedMs,
  );
  // `--apply` with a machine file that was then withheld says why.
  started.withheld =
    attempt !== null && "withheld" in attempt ? attempt.withheld : undefined;
  const apply = attempt !== null && "tick" in attempt ? attempt : null;
  context.launches = read.records;
  context.apply = apply;
  receipt.apply = apply !== null;
  if (started.withheld !== undefined) receipt.applyWithheld = started.withheld;
  Object.assign(receipt, accountsReport(options.machine ?? null, apply));
  receipt.unreadableLaunches = read.unreadable;
  await readLoadUnderAct(started, read.records);
}

/**
 * The host's gauges, read once under the act lock so two ticks never spend
 * the same headroom; an `--apply` tick's launches are admitted against
 * them. A reading that fails leaves admission to the accounts, and says so.
 */
async function readLoadUnderAct(
  started: StartedTick,
  records: ReadRecord[],
): Promise<void> {
  const { receipt, context } = started;
  const machine = context.options.machine ?? null;
  if (machine === null) return;
  const { apply } = context;
  const load = readTickLoad({
    machine,
    records,
    ...(apply === null ? {} : { table: apply.table }),
    budget: await context.reads.budget(),
    codexOptIn: apply?.codexOptIn ?? hostCodexOptIn(),
    nowMs: context.nowMs,
    sample: apply !== null,
  });
  if (!load.ok) {
    receipt.loadUnread = load.failure.reason;
    return;
  }
  if (apply !== null) apply.load = load.value;
  receipt.load = loadReport(load.value);
}

/**
 * The act phase: each observed repository's act part, in this tick's
 * rotated order, inside its boundary; a repository's observe lock is given
 * up once its act part is done.
 */
async function actAll(
  started: StartedTick,
  observe: ObservedAll,
  locks: Map<string, Held>,
): Promise<void> {
  await startAct(started);
  const { receipt, context } = started;
  const { apply, options } = context;
  const order = options.repos;
  const acted: string[] = [];
  const reports = [...new Set(order)].flatMap((path) => {
    const observed = observe.observed.get(path);
    if (observed === undefined) return [];
    return ["report" in observed ? observed.report : observed.opened.report];
  });
  dropRepeatedScopeFailures(reports);
  dropRepeatedLabelNeeds(reports);
  for (const path of new Set(order)) {
    const observed = observe.observed.get(path);
    if (observed === undefined) continue;
    receipt.repos.push(await boundedAct(observed, context));
    acted.push(path);
  }
  // The launches wait until every repository is gathered, so none holds the tick's time against another's.
  await applyInTurns(context.pending, apply?.tick ?? 0);
  // A repository's observe lock is kept until its launches and close are done.
  for (const path of acted) {
    locks.get(path)?.release();
    locks.delete(path);
  }
  // In the order the repositories were named, not the order their reads finished.
  const busy = [...new Set(order)].flatMap((path) => {
    const heldBy = observe.busy.get(path);
    return heldBy === undefined ? [] : [{ path, heldBy }];
  });
  if (busy.length > 0) receipt.busy = busy;
}

/** One repository's act part inside the per-repository boundary. */
async function boundedAct(
  observed: Settled,
  context: TickContext,
): Promise<RepoReport> {
  if ("report" in observed) return observed.report;
  try {
    return await actTurn(observed, context);
  } catch (error) {
    return defectReport(observed.turn, error);
  }
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
  // In the order the repositories were named, not the order their reads finished.
  const named = [...new Set(context.options.repos)];
  const rank = (path: string) => named.indexOf(path);
  const ordered = [...context.reflections].sort(
    (a, b) => rank(a.path) - rank(b.path),
  );
  const reflection = await routeRecurrences(ordered, {
    apply: apply !== null,
    nowMs: currentMs(),
    timeLeftMs: apply === null ? null : timeLeftMs(apply),
  });
  if (reflection !== null) receipt.reflection = reflection;
}

/** Say on the receipt that the optional reads were skipped, when the forge's budget was low as the tick started. */
async function noteBudget(
  receipt: TickReceipt,
  context: TickContext,
): Promise<void> {
  const budget = await context.reads.budget();
  if (lowBudget(budget))
    receipt.lowBudget = {
      remaining: budget.remaining,
      limit: budget.limit,
      skipped: [...OPTIONAL_READS],
    };
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
  await noteBudget(receipt, context);
  await routeReflection(receipt, context);
  receipt.exitStatus =
    failed || !copied || settleFailed || withheld !== undefined ? 1 : 0;
  const held = [...heldSystems()].map(([system, f]) => ({
    system,
    class: f.code,
    reason: f.reason,
  }));
  if (held.length > 0) receipt.unanswered = held;
  // A defect the start kept on the receipt stays: the tick ran, but not whole.
  receipt.completed = receipt.defect === undefined;
  settleFailures(receipt, context);
  receipt.finishedAt = currentIso();
  // The dashboard's copy is written here, so it carries the phases timed so far; the receipt file adds `close`.
  receipt.phasesMs = { ...timer.ms };
  writeTickLine(receipt, {
    machine,
    asked: context.options.repos,
    repos: readRepos(receipt, context),
    records: allRecords(context),
    inputs: context.lineInputs,
    codexOptIn: context.apply?.codexOptIn ?? hostCodexOptIn(),
  });
  // Writing the line can set the exit to 1: the tick's failure row follows it.
  finalizeTickFailure(receipt, context);
}

/** The repositories this tick read: one another tick held was not. */
function readRepos(receipt: TickReceipt, context: TickContext): string[] {
  const busy = new Set((receipt.busy ?? []).map((b) => b.path));
  return context.options.repos.filter((path) => !busy.has(path));
}

/**
 * A tick that found its repositories or the act lock held writes no receipt of
 * its own work; one its launcher ran the plugin upgrade before gets a receipt
 * holding that upgrade and the holder, so the morning report still sees it.
 */
function heldReceipt(started: StartedTick, heldBy: string): void {
  const { options } = started.context;
  const { upgrade } = started.receipt;
  if (upgrade === undefined) return;
  const now = options.now ?? Temporal.Now.instant();
  writeReceipt({
    version: 1,
    runId: newRunId(now),
    startedAt: isoOf(now),
    finishedAt: currentIso(),
    completed: false,
    apply: options.apply === true,
    exitStatus: 3,
    lockHeldBy: heldBy,
    repos: [],
    upgrade,
  });
}

/** The dashboard's line after a tick that found every repository it was asked for held: its heartbeat and busy history, with each repository's part kept. */
function lineOfHeldTick(
  started: StartedTick,
  observe: ObservedAll,
  heldBy: string,
  timer: PhaseTimer<TickPhase>,
): void {
  const { receipt, context } = started;
  // The receipt the line stores says what the invocation did: it held back, and exits as held.
  receipt.exitStatus = 3;
  receipt.completed = false;
  receipt.apply = context.options.apply === true;
  receipt.lockHeldBy = heldBy;
  receipt.busy = [...observe.busy].map(([path, heldBy]) => ({ path, heldBy }));
  receipt.finishedAt = currentIso();
  receipt.phasesMs = { ...timer.ms };
  writeTickLine(receipt, {
    machine: context.options.machine ?? null,
    asked: context.options.repos,
    repos: [],
    records: allRecords(context),
    inputs: context.lineInputs,
    codexOptIn: context.apply?.codexOptIn ?? hostCodexOptIn(),
  });
}

/** The act phase and the close under the act lock, and the receipt written. */
async function actAndClose(
  started: StartedTick,
  observe: ObservedAll,
  locks: Map<string, Held>,
  timer: PhaseTimer<TickPhase>,
): Promise<{ receipt: TickReceipt; path: string }> {
  const { receipt, context } = started;
  try {
    await timer.time("act", () => actAll(started, observe, locks));
    await timer.time("close", () => closeTick(started, timer));
  } catch (error) {
    // A defect outside every repository's turn: the receipt is still written, and says the tick did not complete.
    receipt.defect = defectOf(timer.current ?? "close", error);
    receipt.completed = false;
    receipt.exitStatus = 1;
    receipt.finishedAt = currentIso();
    logDefect("the tick", receipt.defect, error);
    settleFailures(receipt, context);
    receipt.phasesMs = { ...timer.ms };
    if (context.options.machine)
      recordTickHealth(receipt, context.options.machine);
    finalizeTickFailure(receipt, context);
  }
  receipt.phasesMs = { ...timer.ms };
  const path = writeReceipt(receipt);
  pruneReceipts(currentMs(), undefined, context.options.machine?.receiptsDays);
  return { receipt, path };
}

/**
 * The receipt of a tick a throw stopped before its act phase (a state
 * database refused at the start, a lock that could not be taken), so `jig
 * status` and `jig doctor` read the failure rather than the tick before it.
 * Best effort: the throw it records is what the tick reports.
 */
function abortedReceipt(
  options: TickOptions,
  at: Temporal.Instant,
  phase: TickPhase,
  error: unknown,
  upgrade?: ScheduledUpgrade,
): void {
  try {
    writeReceipt({
      version: 1,
      runId: newRunId(at),
      startedAt: isoOf(at),
      finishedAt: currentIso(),
      completed: false,
      apply: options.apply === true,
      exitStatus: error instanceof ExitError ? error.code : 1,
      ...(upgrade === undefined ? upgradeField() : { upgrade }),
      defect: defectOf(phase, error),
      repos: [],
    });
    // A timer that fails every tick would otherwise never prune; the receipt
    // just written is the newest, so the latest failure survives.
    pruneReceipts(currentMs(), undefined, options.machine?.receiptsDays);
  } catch (unwritten) {
    swallow(unwritten, "the receipt of a tick a throw stopped");
  }
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  // A plugin host may run inside Electron. Its Node mode and crash reporter
  // belong to that host, not to programs this tick starts.
  for (const key of Object.keys(process.env))
    if (
      key === "ELECTRON_RUN_AS_NODE" ||
      key.startsWith("ELECTRON_CRASH") ||
      key === "CHROME_CRASHPAD_PIPE_NAME"
    )
      delete process.env[key];
  const timer = new PhaseTimer<TickPhase>();
  const at = options.now ?? Temporal.Now.instant();
  // The act phase writes its own receipt, a defect's included.
  const tick: { acting: boolean; upgrade?: ScheduledUpgrade } = {
    acting: false,
  };
  try {
    return await lockedTick(options, timer, tick);
  } catch (error) {
    if (!tick.acting)
      abortedReceipt(
        options,
        at,
        timer.current ?? "start",
        error,
        tick.upgrade,
      );
    throw error;
  } finally {
    stopHolding();
  }
}

/** The tick under its observe and act locks: every repository read, then acted on and closed. */
async function lockedTick(
  options: TickOptions,
  timer: PhaseTimer<TickPhase>,
  tick: { acting: boolean; upgrade?: ScheduledUpgrade },
): Promise<TickResult> {
  const started = await timer.time("start", () => startTick(options));
  // The scheduled upgrade is taken once, so a throw after this carries it.
  if (started.receipt.upgrade !== undefined)
    tick.upgrade = started.receipt.upgrade;
  const locks = new Map<string, Held>();
  try {
    const observe = await timer.time("observe", () =>
      observeAll(started.context, locks),
    );
    // Another tick holds every repository: it reads and acts on them, and this one has nothing to do.
    if (
      options.repos.length > 0 &&
      observe.busy.size === new Set(options.repos).size
    ) {
      const heldBy = [...observe.busy.values()].join("; ");
      lineOfHeldTick(started, observe, heldBy, timer);
      // A line that could not be written is the tick's own failure: its receipt says why the dashboard stays stale.
      if (started.receipt.lineFailed !== undefined)
        return {
          receipt: started.receipt,
          path: writeReceipt(started.receipt),
        };
      heldReceipt(started, heldBy);
      return { held: heldBy };
    }
    const act = await timer.time("wait", () =>
      waitForActLock(
        options.actLockWaitMs ?? ACT_LOCK_WAIT_MS,
        started.context,
      ),
    );
    if ("heldBy" in act) {
      heldReceipt(started, act.heldBy);
      return { held: act.heldBy };
    }
    tick.acting = true;
    try {
      return await actAndClose(started, observe, locks, timer);
    } finally {
      act.release();
    }
  } finally {
    for (const lock of locks.values()) lock.release();
  }
}
