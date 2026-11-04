/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. Without
 * `--apply` a tick starts nothing: it reports what it would start, and why.
 * With it, the re-arms and takeovers a repository's machine-file entry
 * enables are launched within each account's cap (actions/drive.ts), its
 * pickups and follow-ups too where the runtime binds an interactive session
 * to its account (actions/pickup.ts, actions/followup.ts), its nudges are
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
 */
import { passTimeoutSeconds } from "../skills/drive-pr/scripts/lib/driver/settings.ts";
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { parseTrackerConfig } from "../skills/do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  defaultBranchConfig,
  mergedNotClosed,
  mergedSince,
  openPullRequest,
  pullRequestLabels,
  openPullRequests,
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
import { outOfTime, rotated } from "./lib/actions/launch.ts";
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
import {
  lastAccount,
  type NotAdmitted,
  notAdmitted,
  slotTable,
} from "./lib/accounts.ts";
import { readMarkers } from "./lib/followup-marker.ts";
import { readOutcomes, settleFollowups } from "./lib/followup-outcomes.ts";
import { readIdle, updateIdle } from "./lib/idle.ts";
import type { RepoLineInput } from "./lib/line.ts";
import { hasEnded } from "./lib/log.ts";
import {
  pruneLaunches,
  readLaunches,
  type ReadRecord,
} from "./lib/launches.ts";
import { type MachineConfig, machineRepository } from "./lib/machine-config.ts";
import { holdBack, type PlanInput, planTick } from "./lib/plan.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReport,
} from "./lib/runtime/port.ts";
import { readSection } from "./lib/section.ts";
import { observeContention } from "./lib/sources/contention.ts";
import { readDrives } from "./lib/sources/ledgers.ts";
import { readPickups } from "./lib/sources/tracker.ts";
import { copyLog, lineInputOf, writeTickLine } from "./lib/tick-line.ts";
import { failureText } from "./lib/text.ts";
import type {
  ClaimedItem,
  DispatchSection,
  MarkedPr,
  MergedPr,
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

/** `pull_requests.branch_name`'s default, the branch form of an item. */
const BRANCH_PATTERN = "{key_lower}-{slug}";

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

function branchPattern(values: Record<string, unknown>): string {
  const prs = values.pull_requests;
  const pattern =
    typeof prs === "object" && prs !== null
      ? (prs as Record<string, unknown>).branch_name
      : undefined;
  return typeof pattern === "string" && pattern !== ""
    ? pattern
    : BRANCH_PATTERN;
}

async function gatherRepo(
  path: string,
  context: TickContext,
): Promise<RepoReport> {
  const { options, runtime, nowMs } = context;
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
    followupSince:
      options.followupSince ??
      entry?.followupSince ??
      previousFollowupSince(path) ??
      new Date(nowMs).toISOString(),
  };

  const tracked = await readTracker(values, repo, section, report, where);
  const { keys } = tracked;

  // The forge: the open pull requests and their ledgers, and the merges.
  const labels = section.labels.enabled ? section.labels : null;
  const forge = await readForge(repo, report, section, labels, nowMs);
  const { open, drives, merged, login } = forge;

  // The runtime: which of them a session holds.
  const join: JoinTargets = {
    keys,
    branchPattern: branchPattern(values),
    pullRequests: [
      ...open.map((p) => ({ number: p.number, head: p.headRefName })),
      ...merged.map((p) => ({ number: p.number, head: p.head })),
    ],
  };
  const sessions = await readSessions(runtime, repo, join);
  report.records.push({
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: `${
      sessions.ok
        ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
        : sessions.reason
    }${bindingNote(runtime, section)}`,
  });

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
    forge,
    allRecords(context),
    nowMs,
    threads,
  );
  const held = heldPullRequests(labels, [...open, ...merged]);
  const { inScope } = forge;
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
    ...(labels?.onlyLabeled === true ? { inScope } : {}),
  });
  if (labels?.onlyLabeled === true) report.inScope = [...inScope];
  await logRepo(context, repo.slug, report, drives);
  if (context.apply !== null)
    await applyStages(context.apply, new Set(entry?.stages ?? []), report, {
      repo,
      runtime,
      section,
      tracked,
      login,
      merged,
      join,
      sessions,
    });
  await projectLabels(context, repo.slug, report, labels, {
    ...forge,
    listed: entry !== null,
    serialized,
  });
  context.lineInputs.set(path, lineInputOf(drives, forge, tracked, sessions));
  return report;
}

/** What the forge gave one repository's tick. */
interface ForgeRead {
  /** Whether the pull requests read in full. */
  ok: boolean;
  open: Awaited<ReturnType<typeof openPullRequests>>;
  /** The open pull requests read for a ledger: under `only_labeled`, the labelled ones. */
  read: Set<number>;
  /** Under `only_labeled`, the pull requests in scope this tick: the only ones anything is done on, whatever a launch record says. */
  inScope: Set<number>;
  /** Under `only_labeled`, the pull requests whose scope this tick's listings disagree on: unplaced, nothing done or written on them. */
  disputed: Set<number>;
  /** When each pull request was created, from every observation of it, in scope or not: pickup bookkeeping reads it. */
  created: Map<number, string>;
  drives: Awaited<ReturnType<typeof readDrives>>;
  merged: MarkedPr[];
  login: string | null;
}

/**
 * The forge's part of a repository's tick: the open pull requests (with
 * their labels where `labels` is on, in the same listing) and their ledgers,
 * and the merges. Under `only_labeled`, a pull request that carries no
 * label of the set is never read for a ledger, and a merge that carries
 * none wants no follow-up; the scope itself is decided once, by
 * `decideScope`.
 */
async function readForge(
  repo: RepoTarget,
  report: RepoReport,
  section: DispatchSection,
  labels: LabelConfig | null,
  nowMs: number,
): Promise<ForgeRead> {
  const read = { labels: labels !== null };
  const managed = <T extends { labels?: string[] }>(prs: T[]): T[] =>
    labels?.onlyLabeled === true
      ? prs.filter((p) => carriesSet(labels, p.labels ?? []))
      : prs;
  const out: ForgeRead = {
    ok: false,
    open: [],
    read: new Set(),
    inScope: new Set(),
    disputed: new Set(),
    created: new Map(),
    drives: [],
    merged: [],
    login: null,
  };
  const remember = (prs: readonly { number: number; createdAt?: string }[]) => {
    for (const p of prs)
      if (p.createdAt !== undefined) out.created.set(p.number, p.createdAt);
  };
  try {
    out.open = await openPullRequests(repo.slug, read);
    remember(out.open);
    out.login = await resolveLogin();
    const toRead = managed(out.open);
    const unlabeled = out.open.length - toRead.length;
    out.drives = await readDrives(repo.slug, out.login, toRead, nowMs, labels);
    const since = report.followupSince as string;
    out.read = new Set(toRead.map((p) => p.number));
    const listed =
      section.followupCommand === null
        ? []
        : await mergedSince(repo.slug, since, read);
    remember(listed);
    out.merged = await withMarkers(repo.slug, out.login, managed(listed));
    if (labels?.onlyLabeled === true)
      decideScope(out, report, labels, [out.open, listed]);
    out.ok = true;
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: true,
      detail: `${out.open.length} open pull request(s), ${out.drives.length} with a drive ledger${labelNote(labels, unlabeled)}; ${
        section.followupCommand === null
          ? "no dispatch.followup_command: no follow-ups"
          : `${out.merged.length} merged since ${since}`
      }`,
    });
  } catch (error) {
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: false,
      detail: `the pull requests cannot be read: ${failureText(error)}`,
    });
    out.drives = [];
    out.merged = [];
    out.inScope = new Set();
    out.disputed = new Set();
  }
  return out;
}

/**
 * Under `only_labeled`, the scope is decided once per tick, from the
 * listings that hold each pull request (the open one, the merged one): a
 * pull request is in scope when each of them finds a label of the set on
 * it. One they disagree on is unplaced for this tick, as any record the
 * tick cannot place: reported, no action and no label written on it, its
 * notice records kept, and read again at the next tick. A launch's fresh
 * read is the observation that launch acts on, so it decides again there.
 */
function decideScope(
  out: ForgeRead,
  report: RepoReport,
  labels: LabelConfig,
  listings: ReadonlyArray<ReadonlyArray<{ number: number; labels?: string[] }>>,
): void {
  const seen = new Map<number, Set<boolean>>();
  for (const listing of listings)
    for (const p of listing) {
      const views = seen.get(p.number) ?? new Set<boolean>();
      views.add(carriesSet(labels, p.labels ?? []));
      seen.set(p.number, views);
    }
  for (const [n, views] of seen) {
    if (views.size > 1) {
      out.disputed.add(n);
      report.unplaced.push({
        target: `PR #${n}`,
        record: "forge",
        reason:
          "the open and the merged listing disagree on whether it carries a dispatch label, so whether it is in scope cannot be told this tick",
      });
    } else if (views.has(true)) out.inScope.add(n);
  }
}

function labelNote(labels: LabelConfig | null, unlabeled: number): string {
  if (labels === null) return "";
  return labels.onlyLabeled
    ? ` (dispatch labels on, only labelled pull requests: ${unlabeled} carry no label of the set and are not read)`
    : " (dispatch labels on)";
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
      );
      return again ?? null;
    },
    held: (pr) => labels !== null && hasCommand(labels, pr.labels, "hold"),
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
  if (enabled.has("notify"))
    await applyNotices(apply, repo, report, inputs.sessions);
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

/** Each merged pull request with its follow-up markers; a pull request whose comments do not read carries why. */
async function withMarkers(
  slug: string,
  login: string | null,
  merged: MergedPr[],
): Promise<MarkedPr[]> {
  const out: MarkedPr[] = [];
  for (const pr of merged)
    out.push({ ...pr, markers: await readMarkers(slug, pr.number, login) });
  return out;
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
    const parsed = parseTrackerConfig(values);
    // GitHub Issues with no repository named are the forge repository's own.
    const config =
      parsed.adapter === "github" && parsed.github.repository === null
        ? { ...parsed, github: { ...parsed.github, repository: repo.slug } }
        : parsed;
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
  // A follow-up whose agent finished this tick keeps its outcome past its record.
  settleFollowups(records);
  const plan = planTick({
    ...input,
    outcomes: readOutcomes(repo),
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

/**
 * The machine file's accounts a drive's pass is never admitted on, for the
 * receipt: a vendor with no documented pass command, or a Codex account
 * while the pass deadline this run reads is `0`.
 */
function accountsReport(
  machine: MachineConfig | null,
  apply: ApplyState | null,
): { accountsNotAdmitted?: NotAdmitted[] } {
  if (machine === null) return {};
  const deadline =
    apply === null ? passTimeoutSeconds() : apply.passDeadlineSec;
  const refused = notAdmitted(machine.accounts, deadline);
  return refused.length === 0 ? {} : { accountsNotAdmitted: refused };
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
    });
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, days);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
