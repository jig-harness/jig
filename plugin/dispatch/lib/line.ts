/**
 * The line as one tick found it (`LineSnapshot`), built from what the tick
 * read and did, for the dashboard. It is a pure function of those records: the
 * tick has already paid for every read, and the dashboard may run where none
 * of them can be made (`line-store.ts`).
 *
 * What no record holds is left out rather than guessed: an agent's state for a
 * headless pass, a link for an item whose tracker gives none.
 */
import type {
  LineAccount,
  LineDecision,
  LineNeed,
  LineQueued,
  LineRepo,
  LineSession,
  LineSnapshot,
  NeedCause,
  QueueGroup,
} from "./dashboard-contract.ts";
import type { ReadRecord } from "./launches.ts";
import { holds, targetOf } from "./launches.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type {
  Action,
  DrivenPr,
  Evidence,
  LaunchOutcome,
  RepoReport,
} from "./types.ts";

/** The recent ticks whose longest decides when the timer reads as stopped: a day of the default interval. */
const RECENT_TICKS = 288;

/** What one repository's tick read beside its report. */
export interface RepoLineInput {
  drives: DrivenPr[];
  /** Every pull request and item the tick read a title or a link for. */
  known: Array<{ target: string; title: string; url: string | null }>;
  sessions: SessionsReport;
}

/** A nudge and a notice as the state database holds them. */
export interface NudgeSeen {
  record: string;
  episode: string;
  at: string;
  delivery: string;
  detail: string;
}

export interface HoldSeen {
  pr: number;
  area: string;
  leader: number;
  since: string;
}

/** What the tick's stored records add, per repository. */
export interface RepoStored {
  nudges: NudgeSeen[];
  holds: HoldSeen[];
  /** When each notice key was delivered. */
  notified: Map<string, string>;
}

export interface LineInput {
  /** The needs of the tick before, whose first sightings a continuing need keeps. */
  previousNeeds?: LineNeed[];
  runId: string;
  startedAt: string;
  finishedAt: string;
  exitStatus: number;
  apply: boolean;
  applyWithheld: string | null;
  plugin: string | null;
  timeZone: string;
  machine: MachineConfig;
  reports: RepoReport[];
  /** By repository path; a repository refused before its reads has none. */
  inputs: Map<string, RepoLineInput>;
  /** By repository slug. */
  stored: (slug: string) => RepoStored;
  records: ReadRecord[];
  accounts: LineAccount[];
  lastAccount: string | null;
  /** The durations the previous line carried. */
  recentTicksMs: number[];
}

function text(evidence: Evidence, field: string): string | null {
  const value = evidence[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function prNumber(target: string): number | null {
  const found = /^PR #(\d+)$/.exec(target);
  return found === null ? null : Number(found[1]);
}

/** The heading the drive prints above a framed decision: its kind, key, class and round. */
const FRAME_HEAD = /^\[[a-z]+\] \S+ · class (\S.*?) · parked at round \d+$/;

/** The text under a `## ` heading of a decision record, up to the next heading. */
function section(lines: string[], heading: string): string | null {
  const from = lines.indexOf(`## ${heading}`);
  if (from < 0) return null;
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return body === "" ? null : body;
}

/**
 * A parked decision from the lines the drive printed: the frame's heading goes
 * into the fields, and the record under it, which is Markdown indented two
 * spaces, loses the indent.
 */
export function decisionOf(park: {
  key: string;
  kind: "thread" | "finding";
  lines: string[];
}): LineDecision {
  const [head, ...record] = park.lines;
  const framed = head === undefined ? null : FRAME_HEAD.exec(head);
  const lines = (framed === null ? park.lines : record).map((l) =>
    l.startsWith("  ") ? l.slice(2) : l,
  );
  const named = framed?.[1];
  return {
    key: park.key,
    kind: park.kind,
    lines,
    question: section(lines, "Question"),
    recommendation: section(lines, "Recommended"),
    decisionClass:
      named === undefined || named === "(none recorded)" ? null : named,
  };
}

/** The stage a cause is about. */
function needStage(cause: NeedCause): LineNeed["stage"] {
  if (cause === "followup-failed") return "followup";
  if (cause === "nudge-unanswered") return "steer";
  if (
    cause === "stalled" ||
    cause === "double-claim" ||
    cause === "assigner-cannot-write"
  )
    return "pickup";
  return "rearm";
}

function isNeed(action: Action): action is Action & { cause: NeedCause } {
  return (
    action.stage === "notify" &&
    action.cause !== undefined &&
    action.cause !== "waiting" &&
    action.cause !== "drifting"
  );
}

function isItemTarget(target: string): boolean {
  return prNumber(target) === null;
}

/** A pull request's link when no read gave one: the forge is GitHub, which `lib/forge.ts` reads through `gh`. */
function pullUrl(slug: string, pr: number): string {
  return `https://github.com/${slug}/pull/${pr}`;
}

/** The lookups one repository's lines share. */
class RepoView {
  readonly slug: string;
  readonly report: RepoReport;
  readonly input: RepoLineInput | undefined;
  readonly stored: RepoStored;
  private readonly known: Map<string, { title: string; url: string | null }>;
  private readonly drives: Map<number, DrivenPr>;

  constructor(
    slug: string,
    report: RepoReport,
    input: RepoLineInput | undefined,
    stored: RepoStored,
  ) {
    this.slug = slug;
    this.report = report;
    this.input = input;
    this.stored = stored;
    this.known = new Map([
      ...(input?.drives ?? []).map(
        (d) => [`PR #${d.number}`, { title: d.title, url: d.url }] as const,
      ),
      ...(input?.known ?? []).map(
        (k) => [k.target, { title: k.title, url: k.url }] as const,
      ),
    ]);
    this.drives = new Map((input?.drives ?? []).map((d) => [d.number, d]));
  }

  drive(pr: number | null): DrivenPr | undefined {
    return pr === null ? undefined : this.drives.get(pr);
  }

  title(target: string, evidence: Evidence = {}): string | null {
    return text(evidence, "title") ?? this.known.get(target)?.title ?? null;
  }

  url(target: string, evidence: Evidence = {}): string | null {
    const read = text(evidence, "url") ?? this.known.get(target)?.url ?? null;
    if (read !== null) return read;
    const pr = prNumber(target);
    return pr === null ? null : pullUrl(this.slug, pr);
  }

  launchOf(target: string): LaunchOutcome | undefined {
    return this.report.launches.find((l) => l.target === target);
  }

  workspacesHolding(item: string): string[] {
    const { sessions } = this.input ?? {};
    return sessions?.ok === true
      ? sessions.workspaces
          .filter((w) => w.items.includes(item) && w.agents.length > 0)
          .map((w) => w.path)
      : [];
  }
}

/** When the previous tick's line first showed this need, so a need that carries on keeps its age. */
function firstSeen(
  previous: LineNeed[],
  repo: string,
  target: string,
  cause: string,
): string | undefined {
  return previous.find(
    (n) => n.repo === repo && n.target === target && n.cause === cause,
  )?.since;
}

function sightedSince(
  previous: LineNeed[],
  repo: string,
  action: { target: string; cause: string },
  nowIso: string,
): string {
  return firstSeen(previous, repo, action.target, action.cause) ?? nowIso;
}

function needsOf(
  view: RepoView,
  nowIso: string,
  previous: LineNeed[],
): LineNeed[] {
  const planned = view.report.actions.filter(isNeed).map((action): LineNeed => {
    const pr = prNumber(action.target);
    const notification = view.report.notifications.find(
      (n) => n.key === action.notice?.key,
    );
    const at =
      action.notice === undefined
        ? undefined
        : view.stored.notified.get(action.notice.key);
    return {
      cause: action.cause,
      stage: needStage(action.cause),
      repo: view.slug,
      target: action.target,
      pr,
      item: pr === null ? action.target : null,
      url: view.url(action.target, action.evidence),
      title: view.title(action.target, action.evidence),
      since:
        text(action.evidence, "heartbeat") ??
        text(action.evidence, "idleSince") ??
        at ??
        sightedSince(previous, view.slug, action, nowIso),
      reason: action.reason,
      question: text(action.evidence, "question"),
      decisions: (view.drive(pr)?.waiting ?? []).map(decisionOf),
      notified:
        notification === undefined
          ? null
          : {
              at: at ?? null,
              outcome: notification.outcome,
              workspace: notification.workspace,
            },
      workspaces:
        action.cause === "double-claim"
          ? view.workspacesHolding(action.target)
          : [],
    };
  });
  const refused = view.report.unplaced
    .filter((u) => u.cause === "assigner-cannot-write")
    .map(
      (u): LineNeed => ({
        cause: "assigner-cannot-write",
        stage: "pickup",
        repo: view.slug,
        target: u.target,
        pr: null,
        item: u.target,
        url: view.url(u.target),
        title: view.title(u.target),
        since:
          firstSeen(previous, view.slug, u.target, "assigner-cannot-write") ??
          nowIso,
        reason: u.reason,
        question: null,
        decisions: [],
        notified: null,
        workspaces: [],
      }),
    );
  return [...planned, ...refused];
}

function queued(
  view: RepoView,
  fields: Pick<LineQueued, "source" | "group" | "target" | "why"> &
    Partial<Pick<LineQueued, "stale" | "assignedBy" | "hold" | "launch">>,
  evidence: Evidence = {},
): LineQueued {
  const pr = prNumber(fields.target);
  return {
    stale: false,
    assignedBy: null,
    hold: null,
    launch: null,
    ...fields,
    repo: view.slug,
    pr,
    item: pr === null ? fields.target : null,
    url: view.url(fields.target, evidence),
    title: view.title(fields.target, evidence),
  };
}

/** The launches that hold a slot or will be retried under their record: a session, not a queue entry. */
const STARTED: ReadonlySet<LaunchOutcome["outcome"]> = new Set([
  "launched",
  "retried",
  "lost",
]);

/** Where a launch that did not start leaves its target; with no launch, a stage this tick did not try. */
function groupOf(
  launch: LaunchOutcome | undefined,
  untried: QueueGroup,
): QueueGroup {
  if (launch === undefined) return untried;
  if (launch.outcome === "reported") return "reported";
  if (launch.outcome === "refused") return "never";
  return "starts";
}

function plannedStage(view: RepoView, action: Action): LineQueued | null {
  const launch = view.launchOf(action.target);
  if (launch !== undefined && STARTED.has(launch.outcome)) return null;
  const launchFields =
    launch === undefined
      ? {}
      : { launch: { outcome: launch.outcome, detail: launch.detail } };
  if (action.stage === "rearm") {
    const labelled = view.report.labels?.commands.some(
      (c) => c.target === action.target && c.command === "drive",
    );
    return queued(
      view,
      {
        source: labelled === true ? "label drive" : "re-armable",
        group: groupOf(launch, "starts"),
        target: action.target,
        why: action.reason,
        stale: action.redrive !== undefined,
        ...launchFields,
      },
      action.evidence,
    );
  }
  if (action.stage === "pickup")
    return queued(
      view,
      {
        source: "assigned",
        group: groupOf(launch, "reported"),
        target: action.target,
        why: action.reason,
        assignedBy: text(action.evidence, "assignedBy"),
        ...launchFields,
      },
      action.evidence,
    );
  if (action.stage === "followup")
    return queued(
      view,
      {
        source: "merged",
        group: groupOf(launch, "reported"),
        target: action.target,
        why: action.reason,
        ...launchFields,
      },
      action.evidence,
    );
  return null;
}

function queueOf(view: RepoView): LineQueued[] {
  const planned = view.report.actions
    .map((action) => plannedStage(view, action))
    .filter((q): q is LineQueued => q !== null);
  const serial = (view.report.serialized?.held ?? []).map((h) =>
    queued(view, {
      source: "held",
      group: "held",
      target: h.target,
      why: h.reason,
      hold: view.stored.holds.find((s) => s.pr === prNumber(h.target)) ?? null,
    }),
  );
  const labelled = (view.report.labels?.held ?? []).map((h) =>
    queued(view, {
      source: "held",
      group: "held",
      target: h.target,
      why: h.reason,
    }),
  );
  const refused = view.report.unplaced
    .filter((u) => u.record === "tracker" && isItemTarget(u.target))
    .map((u) =>
      queued(view, {
        source: "assigned",
        group: "never",
        target: u.target,
        why: u.reason,
      }),
    );
  return [...planned, ...serial, ...labelled, ...refused];
}

function repoOf(report: RepoReport, machine: MachineConfig): LineRepo {
  const entry = machine.repositories.find((r) => r.path === report.path);
  return {
    slug: report.slug,
    path: report.path,
    stages: entry?.stages ?? [],
    refused: report.refused,
    failedReads: report.records
      .filter((r) => !r.ok)
      .map((r) => ({
        record: r.record,
        source: r.source,
        detail: r.detail,
      })),
    notes: report.records
      .filter((r) => r.ok && r.record === "tracker")
      .map((r) => r.detail),
  };
}

function reasonOf(
  view: RepoView | undefined,
  record: string,
  cause: "drifting" | "waiting",
): string | null {
  const report = view?.report;
  if (report === undefined) return null;
  const notified = report.actions.find(
    (a) => a.cause === cause && a.evidence.record === record,
  );
  if (notified !== undefined) return notified.reason;
  // A stage already notified as waiting is reported as drifting, not notified again.
  return cause === "drifting"
    ? (report.running.find(
        (r) => r.drifting === true && r.evidence.record === record,
      )?.reason ?? null)
    : null;
}

function agentOf(read: ReadRecord, view: RepoView | undefined) {
  const { record } = read;
  const { sessions } = view?.input ?? {};
  if (sessions?.ok !== true || record.agentId === null) return null;
  const agent = sessions.workspaces
    .flatMap((w) => w.agents)
    .find((a) => a.id === record.agentId);
  return agent === undefined
    ? null
    : {
        state: agent.state,
        since:
          agent.since === null ? null : new Date(agent.since).toISOString(),
      };
}

/** The usage-limit wall an interactive session last met, and the nudge that answered it. */
function wallOf(
  record: ReadRecord["record"],
  view: RepoView | undefined,
): Pick<LineSession, "episode" | "nudge"> {
  const episode = record.episodes?.at(-1);
  if (episode === undefined) return { episode: null, nudge: null };
  const nudge = view?.stored.nudges.find(
    (n) => n.record === record.id && n.episode === episode.observedAt,
  );
  return {
    episode: {
      observedAt: episode.observedAt,
      resetAt: episode.resetAt,
      evidence: episode.evidence,
      last: episode.last,
    },
    nudge:
      nudge === undefined
        ? null
        : { at: nudge.at, delivery: nudge.delivery, detail: nudge.detail },
  };
}

/** What a drive's ledger says of the session: its round and last write. */
function ledgerOf(
  evidence: Evidence,
): Pick<LineSession, "round" | "heartbeat"> {
  const round = evidence.round;
  return {
    round: typeof round === "number" ? round : null,
    heartbeat: text(evidence, "heartbeat"),
  };
}

function sessionOf(
  read: ReadRecord,
  view: RepoView | undefined,
): LineSession | null {
  const { record, state } = read;
  if (
    state.kind !== "pending" &&
    state.kind !== "alive" &&
    state.kind !== "unknown"
  )
    return null;
  const target = targetOf(record);
  const evidence = view?.drive(record.pr)?.evidence ?? {};
  return {
    record: record.id,
    account: record.account,
    vendor: record.vendor,
    repo: record.repo,
    stage: record.action,
    target,
    pr: record.pr,
    item: record.item,
    url:
      view?.url(target, evidence) ??
      (record.pr === null ? null : pullUrl(record.repo, record.pr)),
    title: view?.title(target) ?? null,
    createdAt: record.createdAt,
    launch: state.kind,
    launchReason: state.kind === "unknown" ? state.reason : null,
    agent: agentOf(read, view),
    ...ledgerOf(evidence),
    samples: record.samples ?? [],
    passTimeoutSec: record.passTimeoutSec ?? null,
    workspace: record.workspace?.path ?? null,
    replaces: record.replaces,
    ...wallOf(record, view),
    drifting: reasonOf(view, record.id, "drifting"),
    waiting: reasonOf(view, record.id, "waiting"),
  };
}

export function buildLine(input: LineInput): LineSnapshot {
  const views = input.reports.flatMap((report) =>
    report.slug === null
      ? []
      : [
          new RepoView(
            report.slug,
            report,
            input.inputs.get(report.path),
            input.stored(report.slug),
          ),
        ],
  );
  const bySlug = new Map(views.map((v) => [v.slug, v]));
  const tookMs = Math.max(
    0,
    Date.parse(input.finishedAt) - Date.parse(input.startedAt),
  );
  const recentTicksMs = [...input.recentTicksMs, tookMs].slice(-RECENT_TICKS);
  return {
    version: 1,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitStatus: input.exitStatus,
    apply: input.apply,
    applyWithheld: input.applyWithheld,
    intervalMs: input.machine.intervalMs,
    longestTickMs: Math.max(...recentTicksMs),
    recentTicksMs,
    plugin: input.plugin,
    timeZone: input.timeZone,
    accounts: input.accounts,
    lastAccount: input.lastAccount,
    sessions: input.records
      .filter((r) => holds(r.state))
      .map((r) => sessionOf(r, bySlug.get(r.record.repo)))
      .filter((s): s is LineSession => s !== null),
    needs: views.flatMap((v) =>
      needsOf(v, input.finishedAt, input.previousNeeds ?? []),
    ),
    queue: views.flatMap(queueOf),
    repos: input.reports.map((r) => repoOf(r, input.machine)),
  };
}
