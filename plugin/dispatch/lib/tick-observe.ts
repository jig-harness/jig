/**
 * The observe phase of one repository's turn: open the repository (its
 * forge target and the dispatch section on its default branch), read the
 * tracker, the forge and every host's launch claims, join the runtime's
 * sessions, and run Control's reads (each running drive's threads, each
 * waiting session's wall, the contention between drives) and, when a drive
 * fell silent, the clone's drive doctor (`sources/doctor.ts`). It hands the plan
 * one `RepoObservation`.
 *
 * Opening a repository takes its target and its configuration from the
 * tick's query of it (`forge-batch.ts`), which also lists its open pull
 * requests and their comments for the forge's read; a query that does not
 * read leaves each of these to its own read.
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
 */
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { heldPullRequests } from "./actions/labels.ts";
import { type BoardRead, convergedDrives, observeBoard } from "./board.ts";
import type { Contention } from "./contention.ts";
import {
  observeOpened,
  sampleThreads,
  tickThreadReader,
} from "./expectations.ts";
import { defaultBranchConfig, repoTarget } from "./forge.ts";
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
import { branchPattern, readSection, trackerConfigOf } from "./section.ts";
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
import { type HolderReadings, readHolders } from "./sources/doctor.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { batchSafePickups } from "./queue-batch-areas.ts";
import { slotTable } from "./accounts.ts";
import type { ServedPerson } from "./serve-config.ts";
import { readPickups } from "./sources/tracker.ts";
import { facetBound } from "./sources/tracker-facets.ts";
import { emptyReport, type TickOptions } from "./tick-context.ts";
import { type ForgeRead, readForge } from "./tick-forge.ts";
import {
  scopeOf,
  trackerDefaultKey,
  unlabeledModeOf,
} from "./sources/served-repo.ts";
import { lowBudget, type TickReads, type TickBudget } from "./tick-reads.ts";
import { openShared, readDriveClaims, type TickShared } from "./tick-shared.ts";
import { failureText } from "./text.ts";
import {
  type Failure,
  failed,
  ok,
  type Outcome,
} from "../../shared/outcome.ts";
import { clearsByWaiting } from "../../shared/outbound/failure.ts";
import { lastForgeReading, readFailureOf } from "./read-failures.ts";
import type {
  ClaimedItem,
  DispatchSection,
  RepoPhase,
  RepoReport,
  RepoTarget,
  WantedItem,
} from "./types.ts";

/** What the observe phase needs: the run's options, the runtime, the tick's clock and this machine's launch records. */
export interface ObserveContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  /** This machine's launch records as the turn starts. */
  records: ReadRecord[];
  /** What the tick reads once and shares between its repositories' observe phases. */
  reads: TickReads;
  /** When the tick must have ended, less its receipt's time (epoch milliseconds); absent for a tick no launcher bounds. */
  deadline?: number;
}

/** A repository opened for its tick: its target, its dispatch section, its machine-file entry and the report the tick fills. */
export interface OpenedRepo {
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

/** What the tracker gives one repository's tick. */
export interface Tracked {
  servedPolicy?: import("./sources/served.ts").ServedPolicy;
  keys: IssueKeys | null;
  /** The configured adapter (`issue_tracker.adapter`); `null` when the tracker configuration does not read. */
  adapter: string | null;
  /** For GitHub Issues, the repository the issues are in (`owner/name`); `null` for any other tracker. */
  issueRepository: string | null;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  /** The tracker opened for the read, for the pickups' fresh reads; `null` when none was. */
  tracker: Tracker | null;
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
  forge: ForgeRead;
  claims: DriveClaims;
  join: JoinTargets;
  sessions: SessionsReport;
  serialized: Contention;
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
  context: Pick<ObserveContext, "options" | "nowMs" | "reads">,
): Promise<OpenedRepo | RepoReport> {
  const { options, nowMs } = context;
  const { pool } = context.reads;
  const entry = machineRepository(options.machine ?? null, path);
  // The tick's query of the repository, else its view and its file read one by one.
  const queried = await context.reads.repository(path);
  let target: Awaited<ReturnType<typeof repoTarget>>;
  try {
    target = queried.ok
      ? ok(queried.value.target)
      : await pool.run(() => repoTarget(path));
  } catch (error) {
    target = failed("unreadable", failureText(error), error);
  }
  if (!target.ok)
    return refusedBy(
      path,
      `the forge cannot say which repository this is: ${target.failure.reason}`,
      target.failure,
      nowMs,
    );
  const repo: RepoTarget = target.value;
  let config: Awaited<ReturnType<typeof defaultBranchConfig>>;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  const unread = (why: string, cause?: Failure): RepoReport => ({
    ...refusedBy(
      path,
      `the dispatch section on the default branch cannot be read, so nothing is planned: ${why}`,
      cause,
      nowMs,
    ),
    slug: repo.slug,
  });
  try {
    config = queried.ok
      ? ok(queried.value.config)
      : await pool.run(() => defaultBranchConfig(repo));
  } catch (error) {
    return unread(failureText(error));
  }
  if (!config.ok) return unread(config.failure.reason, config.failure);
  const file = config.value;
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
    ...entryFacts(entry),
  };
}

/**
 * The report of a repository a failed read refused: with the call's
 * failure class when a call failed it, and the forge's last reading with
 * its age when that class clears by waiting.
 */
function refusedBy(
  path: string,
  refused: string,
  cause: Failure | undefined,
  nowMs: number,
): RepoReport {
  const failure = cause === undefined ? undefined : readFailureOf(cause);
  const waits = failure !== undefined && clearsByWaiting(failure.class);
  return {
    ...emptyReport(
      path,
      `${refused}${waits ? lastForgeReading(path, nowMs) : ""}`,
    ),
    ...(failure === undefined ? {} : { refusedBy: failure }),
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
    new Date(nowMs).toISOString()
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

  // The forge: the open pull requests and their ledgers, the merges, and the launch claims of every host.
  const labels = section.labels.enabled ? section.labels : null;
  const shared = openShared(repo.slug, opened.owner, reads.comments);
  let tracked: Tracked;
  let forge: ForgeRead;
  try {
    [tracked, forge] = await settled(
      timer.time("tracker", () =>
        pool.run(() =>
          readTracker(
            values,
            repo,
            section,
            trackerReport,
            where,
            context.deadline,
            opened.stages.has("pickup")
              ? (context.options.machine?.serve ?? [])
              : [],
            context.options.machine?.serveDefaults,
            nowMs,
            context.options.machine == null ||
              slotTable(context.options.machine.accounts, records, nowMs).some(
                (s) =>
                  s.held < s.account.maxPerAccount &&
                  s.wall === null &&
                  !s.wallUnrecorded,
              ),
            reads,
          ),
        ),
      ),
      timer.time("forge", () =>
        readForge(
          repo,
          forgeReport,
          section,
          labels,
          nowMs,
          shared.records,
          reads,
        ),
      ),
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
  const [claims, sessions] = await settled(
    timer.time("claims", () =>
      readDriveClaims(ctx, forge, records, shared.records(forge.login), nowMs),
    ),
    timer.time("runtime", async () => {
      const read = await pool.run(() =>
        readSessions(runtime, repo, join, reads.sessions),
      );
      report.records.push(runtimeRead(runtime, repo, read));
      return read;
    }),
  );

  const held = heldPullRequests(labels, [...forge.open, ...forge.merged]);
  const serialized = await timer.time("observe", () =>
    pool.run(async () => {
      const skipped = await optionalSkipped(reads);
      const threads = tickThreadReader(repo.slug);
      await observeRunning(
        {
          records,
          timeoutMs: context.options.machine?.runtimeTimeoutMs,
          sample: skipped === null,
        },
        repo,
        report,
        forge.drives,
        sessions,
        forge.created,
        threads,
      );
      return observeContention(
        repo,
        values,
        report,
        {
          ...forge,
          heldElsewhere: heldElsewhere(claims),
          owner: ctx.owner,
        },
        records,
        nowMs,
        threads,
        skipped,
      );
    }),
  );
  // The board read, a query of its own whose failure touches nothing planned.
  const board = await timer.time("board", () =>
    pool.run(() =>
      observeBoard({
        slug: repo.slug,
        values,
        drives: forge.drives,
        open: forge.open,
        held,
        serialized,
        budget: reads.budget,
      }),
    ),
  );
  if (board.ok || convergedDrives(forge.drives).length > 0)
    report.board = board;
  // A silent drive's holder, read only when one fell silent.
  const holders = forge.drives.some((d) => d.class === "silent")
    ? await timer.time("observe", () =>
        pool.run(() =>
          readHolders(
            repo.path,
            Math.ceil(
              (context.options.machine?.runtimeTimeoutMs ?? 60_000) / 1000,
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
    claims,
    join,
    sessions,
    serialized,
    held,
    board,
    ...(holders === undefined ? {} : { holders }),
  };
}

/** Why the optional reads are skipped this tick, from the forge's budget as it started; `null` while they run. */
async function optionalSkipped(reads: TickReads): Promise<string | null> {
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
): Promise<void> {
  const { records } = launches;
  if (launches.sample) await sampleThreads(records, repo.slug, drives, threads);
  observeOpened(records, repo.slug, sessions, created);
  const timeoutSec = Math.ceil((launches.timeoutMs ?? 60_000) / 1000);
  for (const reason of await observeWalls(
    records,
    repo.slug,
    sessions,
    timeoutSec,
  ))
    report.unplaced.push({
      target: "a waiting session",
      record: "runtime",
      reason,
    });
}

/** The tracker's part of a repository's tick: the pickups wanted, and the items claimed. */
async function readTracker(
  values: Record<string, unknown>,
  repo: RepoTarget,
  section: DispatchSection,
  report: RepoReport,
  where: string,
  deadline: number | undefined,
  people: readonly ServedPerson[],
  serveDefaults: Readonly<Record<string, string>> | undefined,
  nowMs: number,
  headroom: boolean,
  reads: Pick<TickReads, "budget" | "servedViews">,
): Promise<Tracked> {
  const tracked: Tracked = {
    keys: null,
    adapter: null,
    issueRepository: null,
    pickups: [],
    claimed: null,
    tracker: null,
  };
  try {
    const config = trackerConfigOf(values, repo.slug);
    tracked.keys = issueKeysOf(config);
    tracked.adapter = config.adapter;
    tracked.issueRepository =
      config.adapter === "github" ? config.github.repository : null;
    const item = values.do_item as
      | { execution_plan_block?: unknown }
      | undefined;
    const scope = scopeOf(values);
    tracked.servedPolicy = {
      hitl: config.labels.hitl,
      manualOps: config.labels.manualOps,
      ...(typeof item?.execution_plan_block === "string"
        ? { executionPlanBlock: item.execution_plan_block }
        : {}),
      ...(scope === undefined ? {} : { repoScope: scope }),
      unlabeled: unlabeledModeOf({
        scope,
        adapter: config.adapter,
        team: config.team ?? "",
        site: config.jira.site,
        defaults: serveDefaults,
        repoPath: repo.path,
      }),
      trackerNamespace: trackerDefaultKey(
        config.adapter,
        config.team ?? "",
        config.jira.site,
      ),
    };
    const reading = await readPickups(
      () => {
        tracked.tracker = openTracker(config, repo.path);
        return tracked.tracker;
      },
      section,
      { bound: () => facetBound(deadline) },
      {
        people,
        nowMs,
        headroom,
        ...tracked.servedPolicy,
        ...(reads.servedViews === undefined
          ? {}
          : { views: reads.servedViews }),
      },
    );
    report.records.push(reading.read);
    report.unplaced.push(...reading.unplaced);
    tracked.pickups = await batchSafePickups(
      repo,
      values,
      reading.wanted,
      !lowBudget(await reads.budget()),
    );
    if (reading.read.ok) tracked.claimed = reading.claimed;
  } catch (error) {
    report.records.push({
      record: "tracker",
      source: where,
      ok: false,
      detail: `the tracker cannot be opened: ${failureText(error)}`,
    });
  }
  return tracked;
}

/** The runtime's answer, through `read` where the observe phase passes the tick's reader; a rejected read is a failed report, never an escape. */
export async function readSessions(
  runtime: SessionRuntime,
  repo: RepoTarget,
  join: JoinTargets,
  read: SessionsReader = (r, j) => runtime.sessions(r, j),
): Promise<SessionsReport> {
  try {
    return await read(repo, join);
  } catch (error) {
    return {
      ok: false,
      source: runtime.name,
      reason: `the runtime could not be read: ${failureText(error)}`,
    };
  }
}
