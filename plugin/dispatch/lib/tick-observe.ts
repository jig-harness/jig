/**
 * The observe phase of one repository's turn: open the repository (its
 * forge target and the dispatch section on its default branch), read the
 * tracker, the forge and every host's launch claims, join the runtime's
 * sessions, and run Control's reads (each running drive's threads, each
 * waiting session's wall, the contention between drives) and, when a drive
 * fell silent, the clone's drive doctor (`sources/doctor.ts`). It hands the plan
 * one `RepoObservation`.
 *
 * The repository's target and configuration, the tracker's part and the
 * forge's part (its open pull requests with their ledgers, its merges) are
 * read through the tick's world view (`world-view.ts`), whose facts carry
 * their freshness class. The launch claims (the shared records), Control's
 * reads and the board read the forge directly. The forge's drives as this
 * host's launch records and every host's claims settle them are the
 * machine view, `RepoObservation.drives`, kept apart from the forge's read:
 * nothing of what this host did is written into a fact the view returned.
 *
 * In the direct view, opening a repository takes its target and its
 * configuration from the tick's query of it (`forge-batch.ts`), which also
 * lists its open pull requests and their comments for the forge's read; a
 * query that does not read leaves each of these to its own read.
 *
 * Every repository is observed at once, and within one the sources that do
 * not depend on each other are read side by side: the tracker beside the
 * forge, then the launch claims beside the runtime. Each read runs through
 * the tick's bounded pool (`tick-reads.ts`).
 *
 * Observing reads this machine's launch records as they stood when the tick
 * started and never the apply state, so it does not depend on what any
 * launch changes. It writes only records keyed by its own repository:
 * thread samples and a pickup's opened mark on launch records
 * (expectations.ts), waiting episodes (session-walls.ts), the owner's
 * serialization holds (sources/contention.ts) and the merges' kept reads
 * (merge-reads.ts), each in the state database, whose write lock orders
 * them against another tick's.
 *
 * While the forge's budget is low as the tick starts, the optional reads
 * are skipped: the running drives' thread samples, and serialization's
 * reads, which leaves every drive of a repository with a catalog unplaced.
 *
 * In a tick its launcher bounds, every read here keeps to the tick's bound
 * (`sources/bounded.ts`): a read the bound ended before it started is not
 * started, and goes on the report as the failed read it then is (a
 * repository refused, a tracker, forge or runtime record not ok, the
 * optional reads skipped, the board and the drive doctor not read), so the
 * tick still plans on what it read, writes its receipt and lets its locks
 * go in time; the next tick reads the rest.
 */
import type { IssueKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { heldPullRequests } from "./actions/labels.ts";
import {
  type BoardRead,
  convergedDrives,
  observeBoard,
  unstartedBoard,
} from "./board.ts";
import type { Contention } from "./contention.ts";
import {
  observeOpened,
  sampleThreads,
  tickThreadReader,
} from "./expectations.ts";
import type { LabelConfig } from "./labels.ts";
import type { ReadRecord } from "./launches.ts";
import { type MachineRepository, machineRepository } from "./machine-config.ts";
import { previousFollowupSince } from "../receipts.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReader,
  SessionsReport,
} from "./runtime/port.ts";
import { branchPattern, followupCommandOn, readSection } from "./section.ts";
import { type PhaseTimer, settled } from "./phase-timer.ts";
import {
  type RepoReflection,
  repositoryReflection,
} from "./reflection-route.ts";
import { observeWalls } from "./session-walls.ts";
import {
  type DriveClaims,
  heldElsewhere,
  type SharedContext,
} from "./shared-launches.ts";
import { observeContention } from "./sources/contention.ts";
import type { FilesObservation } from "./sources/pr-files.ts";
import { type HolderReadings, readHolders } from "./sources/doctor.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { pickupHeadroom } from "./tick-trackers.ts";
import {
  CUT_AT_BOUND,
  cutRead,
  ended,
  heldRead,
  heldTo,
  passedBefore,
  passedRead,
  type TickBound,
  within,
} from "./sources/bounded.ts";
import { emptyReport, type TickOptions } from "./tick-context.ts";
import type { ForgeRead } from "./tick-forge.ts";
import type { Tracked } from "./tick-tracker.ts";
import {
  type ConfigurationOutcome,
  type TargetOutcome,
  type WorldView,
  worldOf,
} from "./world-view.ts";
import { lowBudget, type TickReads, type TickBudget } from "./tick-reads.ts";
import { openShared, readDriveClaims, type TickShared } from "./tick-shared.ts";
import { failureText } from "./text.ts";
import { type Failure, failed, type Outcome } from "../../shared/outcome.ts";
import { clearsByWaiting } from "../../shared/outbound/failure.ts";
import {
  lastForgeReading,
  readFailureOf,
  readFailureOfError,
} from "./read-failures.ts";
import type {
  DispatchSection,
  DrivenPr,
  RefusedStep,
  RepoPhase,
  RepoReport,
  RepoTarget,
} from "./types.ts";
import { currentIso, isoFromMs } from "../../shared/time.ts";
import { observeTestLockWaits } from "./test-lock-waits.ts";

/** What the observe phase needs: the run's options, the runtime, the tick's clock and this machine's launch records. */
export interface ObserveContext {
  weights?: import("./local-weights.ts").AccountWeights | undefined;
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  /** This machine's launch records as the turn starts. */
  records: ReadRecord[];
  /** What the tick reads once and shares between its repositories' observe phases. */
  reads: TickReads;
  /** What the forge and the tracker are read through (`world-view.ts`); the direct view over `reads` when absent. */
  world?: WorldView | undefined;
  /** The tick's bound: when it must have ended, less its receipt's time, and the signal that fires then; absent for a tick no launcher bounds. */
  bound?: TickBound;
}

/** A repository opened for its tick: its target, its dispatch section, its machine-file entry and the report the tick fills. */
export interface OpenedRepo {
  /** Opened once while gathering tracker scopes, reused during repository derivation. */
  tracker?: Tracker;
  repo: RepoTarget;
  values: Record<string, unknown>;
  section: DispatchSection;
  /** Where the dispatch section was read from. */
  where: string;
  report: RepoReport;
  /** The stages the machine file enables for it. */
  stages: Set<string>;
  /** Whether the machine file lists it, and whether this host owns it there. */
  listed: boolean;
  owner: boolean;
  reflection: RepoReflection["reflection"];
}

/** Everything one repository's observe phase read, handed to its plan, act and label phases. */
export interface RepoObservation {
  /** Cached forge budget from this tick, for optional act-phase evidence reads. */
  forgeBudget?: TickBudget;
  opened: OpenedRepo;
  tracked: Tracked;
  /** The dispatch labels, where the repository turns them on. */
  labels: LabelConfig | null;
  shared: TickShared;
  /** The shared records as the forge's login, for the stages that claim through them. */
  ctx: SharedContext;
  /** What the forge said: the world view's read, never rewritten by what this host did. */
  forge: ForgeRead;
  /**
   * The machine view of the forge's drives: each of `forge.drives` as the
   * plan reads it once this host's launch records and every host's claims
   * settle it (`settleDrives`). Every stage after the observe phase plans
   * from these.
   */
  drives: DrivenPr[];
  claims: DriveClaims;
  join: JoinTargets;
  sessions: SessionsReport;
  serialized: Contention;
  /** Changed-file paths and their freshness, kept in memory for planning. */
  prFiles?: FilesObservation;
  /** The pull requests a person's hold label keeps every stage off. */
  held: Set<number>;
  /** Each pull request's lock holder as this clone's drive doctor reads it, read when a drive fell silent. */
  holders?: HolderReadings;
  /** The board read: the converged pull requests placed in Ready to merge, or why they were not. */
  board?: BoardRead;
}

/** Open a repository for its tick; the report that refuses it when its target or its dispatch section does not read. */
export async function openRepo(
  path: string,
  context: Pick<
    ObserveContext,
    "options" | "nowMs" | "reads" | "bound" | "world"
  >,
): Promise<OpenedRepo | RepoReport> {
  const { options, nowMs } = context;
  const passed = (): RepoReport => {
    const cut = passedRead("this repository was opened");
    return refusedBy(
      path,
      `${cut.failure.reason}, so nothing is planned for it this tick`,
      cut.failure,
      nowMs,
      "time",
    );
  };
  if (ended(context.bound)) return passed();
  const entry = machineRepository(options.machine ?? null, path);
  // The world view's repository facts: the tick's query of it, else its view and its file read one by one.
  const world = worldOf(context);
  let target: TargetOutcome;
  try {
    target = await heldTo(() => world.target(path), context.bound);
  } catch (error) {
    if (ended(context.bound)) return passed();
    target = failed("unreadable", failureText(error), error);
  }
  if (!target.ok && target.failure.code === "passed") return passed();
  if (!target.ok)
    return refusedBy(
      path,
      `${lookupFailed(target.failure)}: ${target.failure.reason}`,
      target.failure,
      nowMs,
      "lookup",
    );
  const repo: RepoTarget = target.value.value;
  let config: ConfigurationOutcome;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  const unread = (why: string, cause?: Failure): RepoReport => ({
    ...refusedBy(
      path,
      `the dispatch section on the default branch cannot be read, so nothing is planned: ${why}`,
      cause,
      nowMs,
      "configuration",
    ),
    slug: repo.slug,
  });
  try {
    config = await heldTo(() => world.configuration(path, repo), context.bound);
  } catch (error) {
    if (ended(context.bound)) return passed();
    return unread(failureText(error));
  }
  if (!config.ok) return unread(config.failure.reason, config.failure);
  const file = config.value.value;
  const read = readSection(file, where);
  if (!read.ok) return unread(failureText(read.failure.reason));
  const { values, section } = read.value;
  const authors = options.machine?.serve?.flatMap((p) => p.forge) ?? [];
  if (authors.length > 0)
    section.adopt = {
      ...section.adopt,
      enabled: true,
      servedAuthors: authors,
    };
  const facts = entryFacts(entry);
  // The follow-up's default command applies only where this host runs the stage.
  section.followupCommand = followupCommandOn(section, facts.stages);
  const report: RepoReport = {
    ...emptyReport(path, ""),
    refused: null,
    slug: repo.slug,
    section,
    followupSince: followupStart(options, entry, path, nowMs),
  };
  const reflection = repositoryReflection(path, file, where);
  return {
    repo,
    values,
    section,
    where,
    report,
    reflection,
    ...facts,
  };
}

/**
 * What a failed lookup of which repository a path is says first: a rate
 * limit held the lookup, which clears by waiting and says nothing of the
 * repository; any other failure leaves the forge unable to say which
 * repository it is.
 */
export function lookupFailed(failure: Failure): string {
  return readFailureOf(failure)?.class === "rate-limited"
    ? "the repository lookup waits for the rate limit"
    : "the forge cannot say which repository this is";
}

/**
 * The report of a repository a failed read refused at `step`: with the
 * call's failure class when a call failed it, and the forge's last reading
 * with its age when that class clears by waiting.
 */
function refusedBy(
  path: string,
  refused: string,
  cause: Failure | undefined,
  nowMs: number,
  step: RefusedStep,
): RepoReport {
  const failure = cause === undefined ? undefined : readFailureOf(cause);
  const waits = failure !== undefined && clearsByWaiting(failure.class);
  return {
    ...emptyReport(
      path,
      `${refused}${waits ? lastForgeReading(path, nowMs) : ""}`,
    ),
    ...(failure === undefined ? {} : { refusedBy: failure }),
    refusedStep: step,
  };
}

/** When the follow-up stage started for a repository: the run's override, the machine file's, the previous receipt's, else now. */
function followupStart(
  options: TickOptions,
  entry: MachineRepository | null,
  path: string,
  nowMs: number,
): string {
  return (
    options.followupSince ??
    entry?.followupSince ??
    previousFollowupSince(path) ??
    isoFromMs(nowMs)
  );
}

/** What a repository's machine-file entry says of it: its stages, whether it is listed, whether this host owns it. */
function entryFacts(
  entry: MachineRepository | null,
): Pick<OpenedRepo, "stages" | "listed" | "owner"> {
  if (entry === null) return { stages: new Set(), listed: false, owner: true };
  return { stages: new Set(entry.stages), listed: true, owner: entry.owner };
}

/**
 * Observe an opened repository: the tracker, the forge and the launch claims
 * of every host, the runtime's sessions joined to them, then Control's reads,
 * each timed as its phase.
 */
export async function observeRepo(
  opened: OpenedRepo,
  context: ObserveContext,
  timer: PhaseTimer<RepoPhase>,
): Promise<RepoObservation> {
  const { repo, values, section, where, report } = opened;
  const { runtime, nowMs, records, reads } = context;
  const { pool } = reads;
  // The tracker and the forge read side by side, each into a report of its own, kept in this order.
  const side = (): RepoReport => ({ ...report, records: [], unplaced: [] });
  const trackerReport = side();
  const forgeReport = side();

  // The world view: the tracker, and the forge's open pull requests and their ledgers and its merges.
  const world = worldOf(context);
  const labels = section.labels.enabled ? section.labels : null;
  const shared = openShared(repo.slug, opened.owner, reads.comments);
  let tracked: Tracked;
  let forge: ForgeRead;
  try {
    [tracked, forge] = await settled(
      timer.time("tracker", async () => {
        try {
          const fact = await heldTo(
            () =>
              world.tracker({
                values,
                repo,
                section,
                report: trackerReport,
                where,
                people: opened.stages.has("pickup")
                  ? (context.options.machine?.serve ?? [])
                  : [],
                serveDefaults: context.options.machine?.serveDefaults,
                nowMs,
                headroom: pickupHeadroom(context, records),
                records,
                preparedTracker: opened.tracker,
              }),
            context.bound,
          );
          // Planning orders the pickups for this host: it gets its own copy, never the view's fact.
          return {
            ...fact.value,
            pickups: [...fact.value.pickups],
            claimed: fact.value.claimed && [...fact.value.claimed],
          };
        } catch (error) {
          if (context.bound?.signal.aborted !== true) throw error;
          // The bound ended the read: a failed tracker reading, beside the forge's facts.
          trackerReport.records.push({
            record: "tracker",
            source: where,
            ok: false,
            detail: cutRead("the tracker was read").failure.reason,
            failure: CUT_AT_BOUND,
          });
          const none: Tracked = {
            keys: null,
            adapter: null,
            issueRepository: null,
            pickups: [],
            claimed: null,
            tracker: null,
          };
          return none;
        }
      }),
      timer.time("forge", async () => {
        try {
          const facts = await heldTo(
            () =>
              world.forge({
                repo,
                report: forgeReport,
                section,
                labels,
                nowMs,
                shared: shared.records,
              }),
            context.bound,
          );
          return facts.value;
        } catch (error) {
          if (context.bound?.signal.aborted !== true) throw error;
          // The bound ended the read: a failed forge reading, beside the tracker's facts.
          forgeReport.records.push({
            record: "forge",
            source: `gh ${repo.slug}`,
            ok: false,
            detail: `the pull requests cannot be read: ${cutRead("the pull requests were read").failure.reason}${lastForgeReading(repo.path, nowMs)}`,
            failure: CUT_AT_BOUND,
          });
          const none: ForgeRead = {
            ok: false,
            openReadable: false,
            open: [],
            read: new Set(),
            scoped: labels?.onlyLabeled === true,
            inScope: new Set(),
            disputed: new Set(),
            created: new Map(),
            drives: [],
            merged: [],
            login: null,
          };
          return none;
        }
      }),
    );
  } finally {
    // What either read before a defect stays on the report.
    for (const read of [trackerReport, forgeReport]) {
      report.records.push(...read.records);
      report.unplaced.push(...read.unplaced);
    }
  }

  // The launch claims of every host, beside the runtime: which of them a session holds.
  const ctx = shared.context(forge.login);
  const join = joinTargets(tracked.keys, values, forge);
  // The machine view beside it: the forge's drives as this host's launch records and every host's claims settle them.
  const [{ claims, drives }, sessions] = await settled(
    timer.time("claims", () =>
      readDriveClaims(
        ctx,
        forge,
        records,
        shared.records(forge.login),
        nowMs,
        reads,
      ),
    ),
    timer.time("runtime", async () => {
      const read = await pool.run(() =>
        readSessions(runtime, repo, join, reads.sessions, context.bound),
      );
      report.records.push(runtimeRead(runtime, repo, read));
      return read;
    }),
  );

  const held = heldPullRequests(labels, [...forge.open, ...forge.merged]);
  const { serialized, prFiles } = await timer.time("observe", () =>
    pool.run(async () => {
      const skipped = await optionalSkipped(reads, context.bound);
      const threads = boundedThreads(
        tickThreadReader(repo.slug),
        context.bound,
      );
      await observeRunning(
        {
          records,
          timeoutMs: context.options.machine?.runtimeTimeoutMs,
          sample: skipped === null,
        },
        repo,
        report,
        drives,
        sessions,
        forge.created,
        threads,
        context.bound,
      );
      // The wall probes may have used what was left: the optional reads re-ask.
      const stillSkipped =
        skipped ?? (await optionalSkipped(reads, context.bound));
      return observeContention(
        repo,
        values,
        report,
        {
          ...forge,
          drives,
          heldElsewhere: heldElsewhere(claims),
          owner: ctx.owner,
        },
        records,
        nowMs,
        threads,
        stillSkipped,
        context.bound,
      );
    }),
  );
  // The board read, a query of its own whose failure touches nothing planned.
  const board = await timer.time("board", () =>
    pool.run(() =>
      ended(context.bound)
        ? Promise.resolve(
            unstartedBoard(drives, passedBefore("the board was read")),
          )
        : boardHeldTo(context.bound, drives, () =>
            observeBoard({
              slug: repo.slug,
              values,
              drives,
              open: forge.open,
              held,
              serialized,
              budget: reads.budget,
              ended: () => ended(context.bound),
            }),
          ),
    ),
  );
  if (board.ok || convergedDrives(drives).length > 0) report.board = board;
  // A silent drive's holder, read only when one fell silent.
  const holders = drives.some((d) => d.class === "silent")
    ? await timer.time("observe", () =>
        pool.run(() =>
          heldRead(context.bound, "the clone's drive doctor ran", () =>
            readHolders(
              repo.path,
              Math.ceil(
                (context.options.machine?.runtimeTimeoutMs ?? 60_000) / 1000,
              ),
            ),
          ),
        ),
      )
    : undefined;
  return {
    forgeBudget: await reads.budget(),
    opened,
    tracked,
    labels,
    shared,
    ctx,
    forge,
    drives,
    claims,
    join,
    sessions,
    serialized,
    ...(prFiles === undefined ? {} : { prFiles }),
    held,
    board,
    ...(holders === undefined ? {} : { holders }),
  };
}

/** `threads`, not started once the tick's bound has ended and given up on when it ends while one runs. */
function boundedThreads(
  threads: (pr: number) => Promise<Outcome<number>>,
  bound: TickBound | undefined,
): (pr: number) => Promise<Outcome<number>> {
  if (bound === undefined) return threads;
  return async (pr) => {
    if (ended(bound)) return passedRead("the unresolved threads were counted");
    try {
      return await within(threads(pr), bound);
    } catch (error) {
      if (!bound.signal.aborted) throw error;
      return cutRead("the unresolved threads were counted");
    }
  };
}

/** The board `read` makes, or the unread board when the tick's bound ends while it runs. */
async function boardHeldTo(
  bound: TickBound | undefined,
  drives: Parameters<typeof unstartedBoard>[0],
  read: () => Promise<BoardRead>,
): Promise<BoardRead> {
  if (bound === undefined) return read();
  try {
    return await within(read(), bound);
  } catch (error) {
    if (!bound.signal.aborted) throw error;
    return unstartedBoard(drives, cutRead("the board was read").failure.reason);
  }
}

/** Why the optional reads are skipped this tick, from the forge's budget as it started or the tick's bound; `null` while they run. */
async function optionalSkipped(
  reads: TickReads,
  bound: TickBound | undefined,
): Promise<string | null> {
  if (ended(bound))
    return `${passedBefore("serialization's reads")}, so this tick skips them`;
  const budget = await reads.budget();
  return lowBudget(budget)
    ? `the forge's budget is low (${budget.remaining} of ${budget.limit} left until ${budget.resetAt}), so this tick skips serialization's reads`
    : null;
}

/** What the runtime's answer reads as on the report. */
function runtimeRead(
  runtime: SessionRuntime,
  repo: RepoTarget,
  sessions: SessionsReport,
): RepoReport["records"][number] {
  return {
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: `${
      sessions.ok
        ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
        : sessions.reason
    }`,
    ...(!sessions.ok && sessions.failure !== undefined
      ? { failure: sessions.failure }
      : {}),
  };
}

/** Which workspace a session runtime joins to which item or pull request. */
function joinTargets(
  keys: IssueKeys | null,
  values: Record<string, unknown>,
  forge: ForgeRead,
): JoinTargets {
  return {
    keys,
    branchPattern: branchPattern(values),
    pullRequests: [
      ...forge.open.map((p) => ({ number: p.number, head: p.headRefName })),
      ...forge.merged.map((p) => ({ number: p.number, head: p.head })),
    ],
  };
}

/**
 * What Control reads while this machine's stages run, before the plan: each
 * running drive's unresolved threads at its ledger's round, and the wall
 * each waiting interactive session met.
 */
async function observeRunning(
  launches: {
    records: ReadRecord[];
    timeoutMs: number | undefined;
    /** Whether the threads are sampled: not while the forge's budget is low. */
    sample: boolean;
  },
  repo: RepoTarget,
  report: RepoReport,
  drives: Awaited<ReturnType<typeof readDrives>>,
  sessions: SessionsReport,
  created: ReadonlyMap<number, string>,
  threads: (pr: number) => Promise<Outcome<number>>,
  bound?: TickBound,
): Promise<void> {
  const { records } = launches;
  observeTestLockWaits(
    records,
    repo.slug,
    undefined,
    undefined,
    undefined,
    bound,
  );
  if (launches.sample) await sampleThreads(records, repo.slug, drives, threads);
  observeOpened(records, repo.slug, sessions, created);
  const timeoutSec = Math.ceil((launches.timeoutMs ?? 60_000) / 1000);
  for (const { reason, failure } of await observeWalls(
    records,
    repo.slug,
    sessions,
    timeoutSec,
    undefined,
    bound,
  ))
    report.unplaced.push({
      target: "a waiting session",
      record: "runtime",
      reason,
      ...(failure === undefined ? {} : { readFailed: true as const, failure }),
    });
}

/**
 * The runtime's answer, through `read` where the observe phase passes the
 * tick's reader, kept to `bound` where the tick has one; a read the bound
 * ended is a failed report, not started when it ended first, and a
 * rejected read is one too, never an escape.
 */
export async function readSessions(
  runtime: SessionRuntime,
  repo: RepoTarget,
  join: JoinTargets,
  read: SessionsReader = (r, j, s) => runtime.sessions(r, j, s),
  bound?: TickBound,
): Promise<SessionsReport> {
  if (ended(bound))
    return {
      ok: false,
      source: runtime.name,
      reason: passedBefore("the runtime was read"),
      failure: CUT_AT_BOUND,
    };
  try {
    const sessions = await heldTo((signal) => read(repo, join, signal), bound);
    // A listing the bound's signal cut short is the bound's failure, whatever words the runtime used.
    if (sessions.ok) return { ...sessions, observedAt: currentIso() };
    return sessions.failure !== undefined || !ended(bound)
      ? sessions
      : { ...sessions, failure: CUT_AT_BOUND };
  } catch (error) {
    const cause = readFailureOfError(error);
    return {
      ok: false,
      source: runtime.name,
      reason: `the runtime could not be read: ${failureText(error)}`,
      ...(ended(bound)
        ? { failure: cause ?? CUT_AT_BOUND }
        : cause === undefined
          ? {}
          : { failure: cause }),
    };
  }
}
