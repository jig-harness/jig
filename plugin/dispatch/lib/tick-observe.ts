/**
 * The observe phase of one repository's turn: open the repository (its
 * forge target and the dispatch section on its default branch), read the
 * tracker, the forge and every host's launch claims, join the runtime's
 * sessions, and run Control's reads (each running drive's threads, each
 * waiting session's wall, the contention between drives). It hands the plan
 * one `RepoObservation`.
 *
 * Observing reads this machine's launch records as they stand when the turn
 * starts and never the apply state, so it does not depend on what another
 * repository's launches change. It writes only Control's own records: thread
 * samples and a pickup's opened mark on launch records (expectations.ts),
 * waiting episodes (session-walls.ts), and the owner's serialization holds
 * (sources/contention.ts), each in the state database.
 */
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { heldPullRequests } from "./actions/labels.ts";
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
  SessionsReport,
} from "./runtime/port.ts";
import { branchPattern, readSection, trackerConfigOf } from "./section.ts";
import type { PhaseTimer } from "./phase-timer.ts";
import { observeWalls } from "./session-walls.ts";
import {
  type DriveClaims,
  heldElsewhere,
  type SharedContext,
} from "./shared-launches.ts";
import { observeContention } from "./sources/contention.ts";
import type { readDrives } from "./sources/ledgers.ts";
import { readPickups } from "./sources/tracker.ts";
import { emptyReport, type TickOptions } from "./tick-context.ts";
import { type ForgeRead, readForge } from "./tick-forge.ts";
import { openShared, readDriveClaims, type TickShared } from "./tick-shared.ts";
import { failureText } from "./text.ts";
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
}

/** What the tracker gives one repository's tick. */
export interface Tracked {
  keys: IssueKeys | null;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  /** The tracker opened for the read, for the pickups' fresh reads; `null` when none was. */
  tracker: Tracker | null;
}

/** Everything one repository's observe phase read, handed to its plan, act and label phases. */
export interface RepoObservation {
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
}

/** Open a repository for its tick; the report that refuses it when its target or its dispatch section does not read. */
export async function openRepo(
  path: string,
  context: Pick<ObserveContext, "options" | "nowMs">,
): Promise<OpenedRepo | RepoReport> {
  const { options, nowMs } = context;
  const entry = machineRepository(options.machine ?? null, path);
  let repo: RepoTarget;
  try {
    repo = await repoTarget(path);
  } catch (error) {
    return emptyReport(
      path,
      `the forge cannot say which repository this is: ${failureText(error)}`,
    );
  }
  let read: ReturnType<typeof readSection>;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  try {
    read = readSection(await defaultBranchConfig(repo), where);
  } catch (error) {
    return {
      ...emptyReport(
        path,
        `the dispatch section on the default branch cannot be read, so nothing is planned: ${failureText(error)}`,
      ),
      slug: repo.slug,
    };
  }
  const { values, section } = read;
  const report: RepoReport = {
    ...emptyReport(path, ""),
    refused: null,
    slug: repo.slug,
    section,
    followupSince: followupStart(options, entry, path, nowMs),
  };
  return { repo, values, section, where, report, ...entryFacts(entry) };
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
  const { runtime, nowMs, records } = context;
  const tracked = await timer.time("tracker", () =>
    readTracker(values, repo, section, report, where),
  );

  // The forge: the open pull requests and their ledgers, the merges, and the launch claims of every host.
  const labels = section.labels.enabled ? section.labels : null;
  let shared!: ReturnType<typeof openShared>;
  const forge = await timer.time("forge", () => {
    shared = openShared(repo.slug, opened.owner);
    return readForge(repo, report, section, labels, nowMs, shared.records);
  });
  let ctx!: ReturnType<typeof shared.context>;
  const claims = await timer.time("claims", () => {
    ctx = shared.context(forge.login);
    return readDriveClaims(ctx, forge, records);
  });

  // The runtime: which of them a session holds.
  let join!: ReturnType<typeof joinTargets>;
  const sessions = await timer.time("runtime", async () => {
    join = joinTargets(tracked.keys, values, forge);
    const read = await readSessions(runtime, repo, join);
    report.records.push(runtimeRead(runtime, repo, read, section));
    return read;
  });

  let held!: ReturnType<typeof heldPullRequests>;
  const serialized = await timer.time("observe", async () => {
    held = heldPullRequests(labels, [...forge.open, ...forge.merged]);
    const threads = tickThreadReader(repo.slug);
    await observeRunning(
      { records, timeoutMs: context.options.machine?.runtimeTimeoutMs },
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
    );
  });
  return {
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
  };
}

/** What the runtime's answer reads as on the report. */
function runtimeRead(
  runtime: SessionRuntime,
  repo: RepoTarget,
  sessions: SessionsReport,
  section: DispatchSection,
): RepoReport["records"][number] {
  return {
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: `${
      sessions.ok
        ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
        : sessions.reason
    }${bindingNote(runtime, section)}`,
  };
}

/** Why the pickups this repository wants can only be reported, when the runtime cannot bind them. */
function bindingNote(
  runtime: SessionRuntime,
  section: DispatchSection,
): string {
  const binding = runtime.interactiveBinding;
  return binding.ok || section.identity === null
    ? ""
    : `; pickups are reported only: ${binding.reason}`;
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
  launches: { records: ReadRecord[]; timeoutMs: number | undefined },
  repo: RepoTarget,
  report: RepoReport,
  drives: Awaited<ReturnType<typeof readDrives>>,
  sessions: SessionsReport,
  created: ReadonlyMap<number, string>,
  threads: (pr: number) => Promise<number>,
): Promise<void> {
  const { records } = launches;
  await sampleThreads(records, repo.slug, drives, threads);
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
): Promise<Tracked> {
  const tracked: Tracked = {
    keys: null,
    pickups: [],
    claimed: null,
    tracker: null,
  };
  try {
    const config = trackerConfigOf(values, repo.slug);
    tracked.keys = issueKeysOf(config);
    const reading = await readPickups(() => {
      tracked.tracker = openTracker(config, repo.path);
      return tracked.tracker;
    }, section);
    report.records.push(reading.read);
    report.unplaced.push(...reading.unplaced);
    tracked.pickups = reading.wanted;
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

/** The runtime's answer; a rejected read is a failed report, never an escape. */
export async function readSessions(
  runtime: SessionRuntime,
  repo: RepoTarget,
  join: JoinTargets,
): Promise<SessionsReport> {
  try {
    return await runtime.sessions(repo, join);
  } catch (error) {
    return {
      ok: false,
      source: runtime.name,
      reason: `the runtime could not be read: ${failureText(error)}`,
    };
  }
}
