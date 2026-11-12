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
  LineLinks,
  LineNeed,
  LineQueued,
  LineRepo,
  LineSession,
  LineSnapshot,
  NeedCause,
  QueueGroup,
} from "./dashboard-contract.ts";
import type { LaunchAction, ReadRecord } from "./launches.ts";
import { pullUrl } from "./forge.ts";
import { itemBases, itemLinkFrom } from "../../shared/item-links.ts";
import { actOfNeed, NEED_ACTS, type NeedAct } from "../../shared/acts.ts";
import { decisionOf } from "./line-decision.ts";
import {
  type StationContext,
  stationContextOf,
  stationDecision,
} from "./line-station.ts";
export { decisionOf } from "./line-decision.ts";
import { holds, targetOf } from "./launches.ts";
import { isFailureCause } from "./failure-notices.ts";
import { boardUnread, readyOf } from "./line-ready.ts";
import { needWorkspace } from "./line-workspace.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { SessionsReport } from "./runtime/port.ts";
import type { FinalParks } from "./park-events.ts";
import { stuckWhy, type UnclaimedClock } from "./stuck-launches.ts";
import type { WorkLinks } from "./work-links.ts";
import type {
  Action,
  DrivenPr,
  Evidence,
  LaunchOutcome,
  RepoReport,
  Unplaced,
} from "./types.ts";

/** The recent ticks whose longest decides when the timer reads as stopped: a day of the default interval. */
const RECENT_TICKS = 288;

/** What one repository's tick read beside its report. */
export interface RepoLineInput {
  drives: DrivenPr[];
  finalParks?: FinalParks[];
  /** The open pull requests the forge listed; `null` when its listing did not read. */
  open?: number[] | null;
  /** Every pull request and item the tick read a title or a link for. */
  known: Array<{ target: string; title: string; url: string | null }>;
  sessions: SessionsReport;
  /** The repository's configured tracker; `null` when its configuration does not read. */
  tracker?: LineRepo["tracker"];
  /** What links its open pull requests to its items; `null` when the tick could not tell. */
  links?: WorkLinks | null;
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

/** The stage a cause is about. */
function needStage(cause: NeedCause): LineNeed["stage"] {
  if (cause === "followup-failed" || cause === "followup-stale")
    return "followup";
  if (cause === "nudge-unanswered") return "steer";
  if (
    cause === "stalled" ||
    cause === "double-claim" ||
    cause === "pickup-question" ||
    cause === "assigner-cannot-write"
  )
    return "pickup";
  return "rearm";
}

const LAUNCH_ACTIONS: ReadonlySet<string> = new Set<LaunchAction>([
  "rearm",
  "takeover",
  "pickup",
  "followup",
  "steward",
]);

/** The stage a need is about: the launch's own, for a cause about one launch record, else its cause's. */
function stageOfNeed(action: Action & { cause: NeedCause }): LineNeed["stage"] {
  const stage = action.evidence.stage;
  return typeof stage === "string" && LAUNCH_ACTIONS.has(stage)
    ? (stage as LaunchAction)
    : needStage(action.cause);
}

function isNeed(action: Action): action is Action & { cause: NeedCause } {
  return (
    action.stage === "notify" &&
    action.cause !== undefined &&
    action.cause !== "waiting" &&
    action.cause !== "drifting" &&
    action.cause !== "ready" &&
    !isFailureCause(action.cause)
  );
}

/** The act the steward proposed for a need, when it names one of the closed list. */
function stewardAct(action: Action): NeedAct | undefined {
  const steward = action.evidence.stewardAct;
  return typeof steward === "string" &&
    (NEED_ACTS as readonly string[]).includes(steward)
    ? (steward as NeedAct)
    : undefined;
}

/** A need's decisions: a park's drive's unanswered parks, else the one its pass or the tick framed (`line-station.ts`). */
function decisionsOf(
  view: RepoView,
  action: Action & { cause: NeedCause },
  pr: number | null,
  stuck: boolean,
): { decisions: LineDecision[]; framed: boolean } {
  if (action.cause === "parked")
    return {
      decisions: stuck ? [] : (view.drive(pr)?.waiting ?? []).map(decisionOf),
      framed: false,
    };
  const station = stationDecision(action, view.station);
  return station === null
    ? { decisions: [], framed: false }
    : { decisions: [station], framed: true };
}

/**
 * A need's open decisions and its act: a framed decision's class names the
 * act; a need with none keeps the act the steward proposed for it, else its
 * cause's, a stuck launch record nobody framed being investigated.
 */
function needDecisions(
  view: RepoView,
  action: Action & { cause: NeedCause },
  pr: number | null,
): Pick<LineNeed, "decisions"> & { act: NonNullable<LineNeed["act"]> } {
  const stuck = text(action.evidence, "stuck") !== null;
  const { decisions, framed } = decisionsOf(view, action, pr, stuck);
  const proposed = stewardAct(action);
  const own = action.cause === "parked" || framed || stuck;
  return {
    decisions,
    act:
      !own && proposed !== undefined
        ? proposed
        : actOfNeed({
            cause: action.cause,
            decisionClass: decisions[0]?.decisionClass ?? null,
            stuck: stuck && !framed,
          }),
  };
}

function isItemTarget(target: string): boolean {
  return prNumber(target) === null;
}

/** A target's title and link as the tick's reads gave them; each `null` when none did. */
export interface TargetAbout {
  title: string | null;
  url: string | null;
}

/**
 * The title and link of each target one repository's reads named: its
 * drives, the pull requests and items the forge and the tracker listed, and
 * the items the walk could not place. An item no read gave a link takes one
 * worked out from another item link of the repository's tracker
 * (`shared/item-links.ts`); a pull request takes the forge's address.
 */
export function aboutTargets(
  slug: string,
  input: RepoLineInput | undefined,
  unplaced: ReadonlyArray<Unplaced>,
): (target: string, evidence?: Evidence) => TargetAbout {
  const known = new Map<string, { title: string | null; url: string | null }>([
    ...unplaced
      .filter((u) => u.title !== undefined || u.url != null)
      .map(
        (u) =>
          [u.target, { title: u.title ?? null, url: u.url ?? null }] as const,
      ),
    ...(input?.drives ?? []).map(
      (d) => [`PR #${d.number}`, { title: d.title, url: d.url }] as const,
    ),
    ...(input?.known ?? []).map(
      (k) => [k.target, { title: k.title, url: k.url }] as const,
    ),
  ]);
  const bases = itemBases(
    [...known].map(([target, k]) => ({ target, url: k.url })),
  );
  return (target, evidence = {}) => {
    const kept = known.get(target);
    const title = text(evidence, "title") ?? kept?.title ?? null;
    const read = text(evidence, "url") ?? kept?.url ?? null;
    if (read !== null) return { title, url: read };
    const pr = prNumber(target);
    return {
      title,
      url: pr === null ? itemLinkFrom(bases, target) : pullUrl(slug, pr),
    };
  };
}

/** The lookups one repository's lines share. */
class RepoView {
  readonly slug: string;
  readonly report: RepoReport;
  readonly input: RepoLineInput | undefined;
  readonly stored: RepoStored;
  readonly records: ReadRecord[];
  private readonly about: ReturnType<typeof aboutTargets>;
  private readonly drives: Map<number, DrivenPr>;

  constructor(
    slug: string,
    report: RepoReport,
    input: RepoLineInput | undefined,
    stored: RepoStored,
    records: ReadRecord[],
  ) {
    this.slug = slug;
    this.report = report;
    this.input = input;
    this.stored = stored;
    this.records = records;
    this.about = aboutTargets(slug, input, report.unplaced);
    this.drives = new Map((input?.drives ?? []).map((d) => [d.number, d]));
  }

  drive(pr: number | null): DrivenPr | undefined {
    return pr === null ? undefined : this.drives.get(pr);
  }

  /** What a need's framed decision reads beside its action (`line-station.ts`). */
  get station(): StationContext {
    return stationContextOf(this.slug, this.input);
  }

  title(target: string, evidence: Evidence = {}): string | null {
    return this.about(target, evidence).title;
  }

  url(target: string, evidence: Evidence = {}): string | null {
    return this.about(target, evidence).url;
  }

  /**
   * What a row is linked to: a pull request's items, an item's open pull
   * requests. Nothing when the tick could not tell, or for a pull request
   * its read of the open ones did not hold (a merged one).
   */
  linksOf(pr: number | null, item: string | null): { links?: LineLinks } {
    const links = this.input?.links;
    if (links == null) return {};
    if (pr !== null) {
      const keys = links.itemsOf(pr);
      return keys === null
        ? {}
        : {
            links: {
              items: keys.map((key) => ({ key, url: this.url(key) })),
              prs: [],
            },
          };
    }
    if (item === null) return {};
    const prs = links.prsOf(item);
    return prs === null ? {} : { links: { items: [], prs } };
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
    const { act, decisions } = needDecisions(view, action, pr);
    const notification = view.report.notifications.find(
      (n) => n.key === action.notice?.key,
    );
    const at =
      action.notice === undefined
        ? undefined
        : view.stored.notified.get(action.notice.key);
    return {
      cause: action.cause,
      act,
      stage: stageOfNeed(action),
      repo: view.slug,
      target: action.target,
      pr,
      item: pr === null ? action.target : null,
      url: view.url(action.target, action.evidence),
      title: view.title(action.target, action.evidence),
      ...view.linksOf(pr, pr === null ? action.target : null),
      workspace: needWorkspace(
        view.report,
        action.target,
        needStage(action.cause),
        view.input?.sessions,
        view.records,
        action,
      ),
      since:
        text(action.evidence, "heartbeat") ??
        text(action.evidence, "idleSince") ??
        at ??
        sightedSince(previous, view.slug, action, nowIso),
      reason: action.reason,
      question:
        text(action.evidence, "stewardAsk") ??
        text(action.evidence, "question"),
      decisions,
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
          : text(action.evidence, "stuck") !== null &&
              action.workspace !== undefined
            ? [action.workspace]
            : [],
      stuckRecord:
        text(action.evidence, "stuck") === null
          ? null
          : text(action.evidence, "record"),
    };
  });
  const refused = view.report.unplaced
    .filter((u) => u.cause === "assigner-cannot-write")
    .map(
      (u): LineNeed => ({
        cause: "assigner-cannot-write",
        act: actOfNeed({ cause: "assigner-cannot-write" }),
        stage: "pickup",
        repo: view.slug,
        target: u.target,
        pr: null,
        item: u.target,
        url: view.url(u.target),
        title: view.title(u.target),
        ...view.linksOf(null, u.target),
        workspace: needWorkspace(
          view.report,
          u.target,
          "pickup",
          view.input?.sessions,
          view.records,
        ),
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
    ...view.linksOf(pr, pr === null ? fields.target : null),
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
      : {
          launch: {
            outcome: launch.outcome,
            detail: launch.detail,
            ...(launch.waitsOn === undefined
              ? {}
              : { waitsOn: launch.waitsOn }),
          },
        };
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

function repoOf(
  report: RepoReport,
  machine: MachineConfig,
  input: RepoLineInput | undefined,
): LineRepo {
  const entry = machine.repositories.find((r) => r.path === report.path);
  return {
    slug: report.slug,
    path: report.path,
    stages: entry?.stages ?? [],
    ...(input?.tracker === undefined ? {} : { tracker: input.tracker }),
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
    ...boardUnread(report),
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
  clock: UnclaimedClock | undefined,
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
    ...view?.linksOf(record.pr, record.item),
    createdAt: record.createdAt,
    launch: state.kind,
    launchReason: state.kind === "unknown" ? state.reason : null,
    stuck: stuckWhy(read, clock),
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
            input.records,
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
      .map((r) => {
        const view = bySlug.get(r.record.repo);
        const sessions = view?.input?.sessions;
        return sessionOf(
          r,
          view,
          sessions === undefined
            ? undefined
            : {
                nowMs: Date.parse(input.startedAt),
                unclaimedAfterMs: input.machine.unclaimedAfterMs,
                sessions,
              },
        );
      })
      .filter((s): s is LineSession => s !== null),
    needs: views.flatMap((v) =>
      needsOf(v, input.finishedAt, input.previousNeeds ?? []),
    ),
    queue: views.flatMap(queueOf),
    ready: readyOf(input.reports).map((r) => ({
      ...r,
      ...bySlug.get(r.repo)?.linksOf(r.pr, null),
    })),
    repos: input.reports.map((r) =>
      repoOf(r, input.machine, input.inputs.get(r.path)),
    ),
  };
}
