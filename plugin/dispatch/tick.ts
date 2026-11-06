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
 * Control runs in every tick, `--apply` or not: before the plan, each
 * running drive's unresolved threads are recorded at its ledger's round
 * and each waiting interactive session's wall is read (expectations.ts,
 * session-walls.ts), so the plan can report the stages that drift and the
 * sessions a nudge is due for; after it, each launch record that ended gets
 * its row in the outcome log (log.ts, log-ended.ts), in the transaction that
 * writes its end, before any expired record is removed. Every record the
 * tick keeps is a row of the state database (lib/state.ts); at the end of
 * the tick the outcome log's new rows are copied into its month files
 * (lib/log-export.ts).
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
import { passTimeoutSeconds } from "../skills/drive-pr/scripts/lib/driver/settings.ts";
import { openTracker } from "../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  defaultBranchConfig,
  mergedNotClosed,
  openPullRequest,
  pullRequestLabels,
  repoTarget,
} from "./lib/forge.ts";
import {
  applySteers,
  planSteers,
  readNudges,
  settlePending,
} from "./lib/actions/steer.ts";
import {
  observeOpened,
  sampleThreads,
  tickThreadReader,
} from "./lib/expectations.ts";
import { logEnded } from "./lib/log-ended.ts";
import { observeWalls } from "./lib/session-walls.ts";
import type { Tracker } from "../skills/do-item/scripts/lib/tracker/port.ts";
import {
  type ApplyState,
  applyDrives,
  type FreshDrive,
} from "./lib/actions/drive.ts";
import { applyFollowups } from "./lib/actions/followup.ts";
import { accountsReport, outOfTime, rotated } from "./lib/actions/launch.ts";
import {
  heldPullRequests,
  planLabels,
  type ProjectionInput,
  writeLabels,
} from "./lib/actions/labels.ts";
import { carriesSet, hasCommand, type LabelConfig } from "./lib/labels.ts";
import { applyNotices } from "./lib/actions/notify.ts";
import { applyPickups } from "./lib/actions/pickup.ts";
import { releaseEnded, settleAgents } from "./lib/actions/pickup-hold.ts";
import { hostCodexOptIn, lastAccount, slotTable } from "./lib/accounts.ts";
import { readOutcomes, settleFollowups } from "./lib/followup-outcomes.ts";
import { readReleases, reconcileReleases } from "./lib/followup-releases.ts";
import { readIdle, updateIdle } from "./lib/idle.ts";
import type { RepoLineInput } from "./lib/line.ts";
import { hasEnded } from "./lib/log.ts";
import {
  pruneLaunches,
  readLaunches,
  type ReadRecord,
} from "./lib/launches.ts";
import {
  type MachineConfig,
  type MachineRepository,
  machineRepository,
} from "./lib/machine-config.ts";
import { holdBack, type PlanInput, planTick } from "./lib/plan.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReport,
} from "./lib/runtime/port.ts";
import { branchPattern, readSection, trackerConfigOf } from "./lib/section.ts";
import {
  heldElsewhere,
  launchClaimer,
  type SharedContext,
} from "./lib/shared-launches.ts";
import { observeContention } from "./lib/sources/contention.ts";
import { readDrives } from "./lib/sources/ledgers.ts";
import { adoptionOf } from "./lib/adopt.ts";
import { readPickups } from "./lib/sources/tracker.ts";
import { type ForgeRead, readForge } from "./lib/tick-forge.ts";
import { copyLog, lineInputOf, writeTickLine } from "./lib/tick-line.ts";
import {
  endOwnClaims,
  openShared,
  readDriveClaims,
  sharedReport,
} from "./lib/tick-shared.ts";
import { failureText } from "./lib/text.ts";
import type {
  ClaimedItem,
  DispatchSection,
  MarkedPr,
  RepoReport,
  RepoTarget,
  WantedItem,
} from "./lib/types.ts";
import {
  newRunId,
  previousFollowupSince,
  pruneReceipts,
  type TickReceipt,
  nextTickIndex,
  takeTickLock,
  writeReceipt,
} from "./receipts.ts";

export interface TickOptions {
  repos: string[];
  /** Overrides the follow-up window's start for every repository. */
  followupSince?: string;
  /** Launch what the machine file enables; needs `machine`. */
  apply?: boolean;
  machine?: MachineConfig | null;
  now?: Date;
  runtime?: SessionRuntime;
}

/** What one repository's gathering needs beyond its path. */
interface TickContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  launches: ReadRecord[];
  apply: ApplyState | null;
  /** What each repository's tick read beside its report, by path, for the line. */
  lineInputs: Map<string, RepoLineInput>;
}

function emptyReport(path: string, refused: string): RepoReport {
  return {
    path,
    slug: null,
    refused,
    section: null,
    followupSince: null,
    records: [],
    actions: [],
    running: [],
    unplaced: [],
    launches: [],
    notifications: [],
    quiet: [],
  };
}

/** A repository opened for its tick: its target, its dispatch section, its machine-file entry and the report the tick fills. */
interface OpenedRepo {
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

/** Open a repository for its tick; the report that refuses it when its target or its dispatch section does not read. */
async function openRepo(
  path: string,
  context: TickContext,
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

async function gatherRepo(
  path: string,
  context: TickContext,
): Promise<RepoReport> {
  const opened = await openRepo(path, context);
  if (!("repo" in opened)) return opened;
  const { repo, values, section, where, report } = opened;
  const { runtime, nowMs } = context;
  const tracked = await readTracker(values, repo, section, report, where);

  // The forge: the open pull requests and their ledgers, the merges, and the launch claims of every host.
  const labels = section.labels.enabled ? section.labels : null;
  const shared = openShared(repo.slug, opened.owner);
  const forge = await readForge(
    repo,
    report,
    section,
    labels,
    nowMs,
    shared.records,
  );
  const ctx = shared.context(forge.login);
  const claims = await readDriveClaims(ctx, forge, allRecords(context));
  const { open, drives, merged, login } = forge;

  // The runtime: which of them a session holds.
  const join = joinTargets(tracked.keys, values, forge);
  const sessions = await readSessions(runtime, repo, join);
  report.records.push(runtimeRead(runtime, repo, sessions, section));

  const { created } = forge;
  const threads = tickThreadReader(repo.slug);
  await observeRunning(
    context,
    repo,
    report,
    drives,
    sessions,
    created,
    threads,
  );
  const serialized = await observeContention(
    repo,
    values,
    report,
    {
      ...forge,
      heldElsewhere: heldElsewhere(claims),
      owner: ctx.owner,
    },
    allRecords(context),
    nowMs,
    threads,
  );
  const held = heldPullRequests(labels, [...open, ...merged]);
  const { inScope } = forge;
  const onlyLabeled = labels?.onlyLabeled === true;
  planRepo(context, repo.slug, report, {
    slug: repo.slug,
    section,
    pickups: tracked.pickups,
    claimed: tracked.claimed,
    drives,
    merged,
    sessions,
    created,
    held,
    serialized,
    shared: { host: ctx.host, drives: claims, owner: ctx.owner },
    ...(onlyLabeled ? { inScope } : {}),
  });
  if (onlyLabeled) report.inScope = [...inScope];
  await logRepo(context, repo.slug, report, drives);
  if (context.apply !== null) {
    await endOwnClaims(ctx, report, {
      claims,
      forge,
      records: allRecords(context),
      outcomes: readOutcomes(repo.slug),
      nowMs,
    });
    await applyStages(context.apply, opened.stages, report, {
      repo,
      runtime,
      section,
      tracked,
      login,
      merged,
      join,
      sessions,
      shared: ctx,
    });
  }
  // The labels are the owner's to write, as its board, notifications and history rows are.
  await projectLabels(context, repo.slug, report, labels, {
    ...forge,
    listed: opened.listed && ctx.owner,
    serialized,
  });
  report.shared = await sharedReport(shared, ctx, claims, forge);
  context.lineInputs.set(path, lineInputOf(drives, forge, tracked, sessions));
  return report;
}

/**
 * The projection, last in a repository's tick: each managed pull request's
 * state label set from its ledger, written only with `--apply` for a
 * repository the machine file lists, and only where its labels disagree.
 * Nothing where the labels are off, or the pull requests did not read.
 */
async function projectLabels(
  context: TickContext,
  slug: string,
  report: RepoReport,
  labels: LabelConfig | null,
  forge: ForgeRead & {
    listed: boolean;
    serialized: NonNullable<ProjectionInput["serialized"]>;
  },
): Promise<void> {
  if (labels === null || !forge.ok) return;
  const followedUp = new Set(
    report.quiet
      .filter((q) => q.class === "followup-done")
      .map((q) => Number(q.target.replace(/^PR #/, ""))),
  );
  const planned = planLabels({
    config: labels,
    open: forge.open.filter((p) => !forge.disputed.has(p.number)),
    read: forge.read,
    drives: forge.drives,
    merged: forge.merged.filter((p) => !forge.disputed.has(p.number)),
    followedUp,
    serialized: forge.serialized,
  });
  const apply = context.apply;
  planned.report.held = report.labels?.held ?? [];
  planned.report.writes = await writeLabels(slug, planned.changes, {
    apply: apply !== null && forge.listed,
    late: () => (apply === null ? null : outOfTime(apply)),
  });
  report.labels = planned.report;
}

/** What `--apply` acts on for one repository, as its tick read it. */
interface ApplyInputs {
  repo: RepoTarget;
  runtime: SessionRuntime;
  section: DispatchSection;
  tracked: Tracked;
  login: string | null;
  merged: MarkedPr[];
  join: JoinTargets;
  sessions: SessionsReport;
  shared: SharedContext;
}

/**
 * `--apply` for one repository: the launch stages its machine-file entry
 * enables, in this tick's turn, then its notifications, which open no
 * session and so share no turn.
 */
async function applyStages(
  apply: ApplyState,
  enabled: ReadonlySet<string>,
  report: RepoReport,
  inputs: ApplyInputs,
): Promise<void> {
  const { repo, runtime, section, tracked, login, join } = inputs;
  const fresh = () => readSessions(runtime, repo, join);
  const labels = section.labels.enabled ? section.labels : null;
  const drive: FreshDrive = {
    read: async (pr) => {
      // The pull request read again too: a stale drive's head and mergeability are its facts, and a hold label may have appeared.
      const listed = await openPullRequest(repo.slug, pr, {
        labels: labels !== null,
      });
      if (
        labels?.onlyLabeled === true &&
        !carriesSet(labels, listed.labels ?? [])
      )
        return null;
      const [again] = await readDrives(
        repo.slug,
        login,
        [listed],
        Date.now(),
        labels,
        adoptionOf(section, login),
      );
      return again ?? null;
    },
    held: (pr) => labels !== null && hasCommand(labels, pr.labels, "hold"),
    claimer: launchClaimer(inputs.shared),
  };
  const stages = [
    async () => {
      if (enabled.has("rearm"))
        await applyDrives(apply, repo, report, inputs.sessions, drive);
    },
    async () => {
      const { tracker, keys } = tracked;
      if (enabled.has("pickup") && tracker !== null && keys)
        await applyPickups(apply, repo, report, {
          section,
          tracker,
          keys,
          branchPattern: join.branchPattern,
          sessions: fresh,
        });
    },
    async () => {
      if (enabled.has("followup"))
        await applyFollowups(apply, repo, report, {
          section,
          login,
          merged: inputs.merged,
          sessions: fresh,
          shared: inputs.shared,
          ...(labels === null
            ? {}
            : {
                holdReason: async (pr: number) => {
                  const now = await pullRequestLabels(repo.slug, pr);
                  if (hasCommand(labels, now, "hold"))
                    return "a person's hold label is on it now";
                  return labels.onlyLabeled && !carriesSet(labels, now)
                    ? "it carries no dispatch label now"
                    : null;
                },
              }),
        });
    },
  ];
  for (const stage of rotated(apply, stages, "stages")) await stage();
  // The nudges first: a nudge that went unanswered is notified in the same tick.
  if (enabled.has("steer")) await applySteers(apply, repo.slug, report);
  // A host that does not own the repository never notifies for it: the owner does, once.
  if (enabled.has("notify") && inputs.shared.owner)
    await applyNotices(apply, repo, report, inputs.sessions, {
      lingerMs: section.noticesLingerMs,
      renotifyAfterMs: section.renotifyAfterMs,
      branch: section.noticesBranch,
    });
}

/** This machine's launch records, the ones this tick writes included. */
function allRecords(context: TickContext): ReadRecord[] {
  return context.apply?.records ?? context.launches;
}

/**
 * What Control reads while this machine's stages run, before the plan: each
 * running drive's unresolved threads at its ledger's round, and the wall
 * each waiting interactive session met.
 */
async function observeRunning(
  context: TickContext,
  repo: RepoTarget,
  report: RepoReport,
  drives: Awaited<ReturnType<typeof readDrives>>,
  sessions: SessionsReport,
  created: ReadonlyMap<number, string>,
  threads: (pr: number) => Promise<number>,
): Promise<void> {
  const records = allRecords(context);
  await sampleThreads(records, repo.slug, drives, threads);
  observeOpened(records, repo.slug, sessions, created);
  const timeoutSec = Math.ceil(
    (context.options.machine?.runtimeTimeoutMs ?? 60_000) / 1000,
  );
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

/** The ended rows of this repository's records that ended, read beside its ledgers. */
async function logRepo(
  context: TickContext,
  slug: string,
  report: RepoReport,
  drives: Awaited<ReturnType<typeof readDrives>>,
): Promise<void> {
  const all = allRecords(context);
  const failed = await logEnded(
    all.filter((r) => r.record.repo === slug),
    {
      all,
      drives,
      merged: (pr) => mergedNotClosed(slug, pr).catch(() => null),
      nowIso: new Date(context.nowMs).toISOString(),
    },
  );
  for (const reason of failed)
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
}

/** What the tracker gives one repository's tick. */
interface Tracked {
  keys: IssueKeys | null;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  /** The tracker opened for the read, for the pickups' fresh reads; `null` when none was. */
  tracker: Tracker | null;
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

/**
 * Plan one repository's tick into its report, with this machine's launch
 * records read beside the sessions; then keep the idle clock and release
 * the ended pickups whose item left the dispatch states, when the claimed
 * items were read whole.
 */
function planRepo(
  context: TickContext,
  repo: string,
  report: RepoReport,
  input: Omit<PlanInput, "launches" | "idleSince" | "nowMs" | "outcomes">,
): void {
  const { nowMs } = context;
  const records = settleRecords(context, repo, input.sessions, nowMs);
  // A follow-up that ended keeps its outcome past its record.
  settleFollowups(records);
  const plan = planTick({
    ...input,
    outcomes: readOutcomes(repo),
    releases: reconcileReleases(
      readReleases(
        repo,
        input.merged.map((pr) => pr.number),
      ),
      input.merged,
    ),
    launches: records,
    idleSince: readIdle(repo),
    nowMs,
  });
  report.actions.push(...plan.actions);
  report.running.push(...plan.running);
  const nudges = readNudges(repo);
  for (const reason of settlePending(nudges))
    report.unplaced.push({
      target: "the outcome log",
      record: "runtime",
      reason,
    });
  const steers = planSteers({
    slug: repo,
    launches: records,
    sessions: input.sessions,
    nudges,
    nowMs,
  });
  // The nudges stand down for a held or not-known-labelled pull request like every other action.
  const nudged = {
    actions: steers.actions,
    held: plan.held,
    withheld: plan.withheld,
  };
  holdBack(nudged, input.held ?? new Set(), input.inScope);
  report.actions.push(...nudged.actions);
  report.withheld = plan.withheld;
  report.serialized?.held.push(...plan.serialHeld);
  report.running.push(...steers.running);
  report.unplaced.push(...plan.unplaced);
  report.quiet.push(...plan.quiet);
  if (input.section.labels.enabled)
    report.labels = {
      prefix: input.section.labels.prefix,
      onlyLabeled: input.section.labels.onlyLabeled,
      unlabeled: 0,
      states: [],
      commands: [],
      held: plan.held,
      writes: [],
    };
  if (input.claimed === null) return;
  updateIdle(repo, plan.idleNow, nowMs, undefined, plan.idleKeep);
  // An item the read left out (who assigned it could not be read, or not by a
  // person with write access) is still assigned: only leaving the dispatch
  // states releases its record.
  releaseEnded(
    records,
    repo,
    new Set([
      ...input.pickups.map((p) => p.key),
      ...report.unplaced.map((u) => u.target),
    ]),
  );
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

/**
 * This machine's launch records for `repo`, each pickup's read beside its
 * agent: one whose agent the runtime reports finished no longer holds its
 * slot, so the slot table is counted again.
 */
function settleRecords(
  context: TickContext,
  repo: string,
  sessions: SessionsReport,
  nowMs: number,
): ReadRecord[] {
  const all = context.apply?.records ?? context.launches;
  if (settleAgents(all, repo, sessions, nowMs) && context.apply !== null)
    context.apply.table = slotTable(
      context.apply.machine.accounts,
      context.apply.records,
      nowMs,
    );
  return all.filter((r) => r.record.repo === repo);
}

/**
 * Give each record of a repository this tick did not read its ended row
 * before the record can expire, without a ledger to count rounds by, and
 * prune the records whose rows are in the log; whether the tick failed.
 */
async function settleOutcomes(
  receipt: TickReceipt,
  context: TickContext,
  days: number | undefined,
): Promise<boolean> {
  const records = allRecords(context);
  // A repository this tick read gave its records their rows in `logRepo`,
  // with its ledgers beside them; the rest get the row without them.
  const read = new Set(
    receipt.repos.filter((r) => r.refused === null).map((r) => r.slug),
  );
  const unlogged = await logEnded(
    records.filter((r) => !read.has(r.record.repo)),
    {
      all: records,
      drives: null,
      merged: async () => null,
      nowIso: new Date(context.nowMs).toISOString(),
    },
  );
  if (unlogged.length > 0) receipt.unloggedOutcomes = unlogged;
  // A record that ended without its outcome row in the log is kept: its end is written with the row.
  pruneLaunches(
    records.filter((r) => !hasEnded(r) || r.record.endedAt !== undefined),
    context.nowMs,
    days ?? 30,
  );
  return (
    unlogged.length > 0 ||
    receipt.repos.some(
      (r) =>
        r.refused !== null ||
        r.records.some((x) => !x.ok) ||
        r.unplaced.some((u) => u.target === "the outcome log"),
    )
  );
}

/** The runtime's answer; a rejected read is a failed report, never an escape. */
async function readSessions(
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

export type TickResult =
  | { held: string }
  | { receipt: TickReceipt; path: string };

function applyState(
  options: TickOptions,
  runtime: SessionRuntime,
  records: ReadRecord[],
  nowMs: number,
  unreadable: string[],
): ApplyState | { withheld: string } | null {
  const machine = options.machine ?? null;
  if (!options.apply || machine === null) return null;
  // A record that cannot be read may belong to a live wrapper, so its slot and
  // pull request cannot be told apart from a free one: launch nothing.
  if (unreadable.length > 0)
    return {
      withheld: `${unreadable.length} launch record(s) do not read, so no slot can be told free`,
    };
  // A rotation cursor that cannot be recorded would repeat: launch nothing.
  const tick = nextTickIndex();
  if (typeof tick !== "number")
    return { withheld: `the rotation cursor cannot be kept: ${tick.failed}` };
  return {
    machine,
    runtime,
    records,
    table: slotTable(machine.accounts, records, nowMs),
    last: lastAccount(records),
    passDeadlineSec: passTimeoutSeconds(),
    codexOptIn: hostCodexOptIn(),
    startedAt: Date.now(),
    tick,
    repos: options.repos.length,
  };
}

function defaultRuntime(machine: MachineConfig | null): SessionRuntime {
  return machine === null
    ? orcaRuntime()
    : orcaRuntime({
        runtimeTimeoutMs: machine.runtimeTimeoutMs,
        workspaceTimeoutMs: machine.workspaceTimeoutMs,
      });
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const lock = takeTickLock();
  if ("heldBy" in lock) return { held: lock.heldBy };
  try {
    const now = options.now ?? new Date();
    const machine = options.machine ?? null;
    const runtime = options.runtime ?? defaultRuntime(machine);
    const read = await readLaunches();
    const days = machine?.receiptsDays;
    // An ended follow-up's outcome is written before its record can expire.
    settleFollowups(read.records);
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
      ...(withheld === undefined ? {} : { applyWithheld: withheld }),
      ...accountsReport(machine, apply),
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
    };
    const order =
      apply === null ? options.repos : rotated(apply, options.repos);
    for (const path of order)
      receipt.repos.push(await gatherRepo(path, context));
    const failed = await settleOutcomes(receipt, context, days);
    const copied = copyLog(receipt);
    receipt.exitStatus = failed || !copied || withheld !== undefined ? 1 : 0;
    receipt.completed = true;
    receipt.finishedAt = new Date().toISOString();
    writeTickLine(receipt, {
      machine,
      repos: options.repos,
      records: allRecords(context),
      inputs: context.lineInputs,
      codexOptIn: apply?.codexOptIn ?? hostCodexOptIn(),
    });
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, days);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
