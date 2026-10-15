/**
 * Escalation: a class of finding that keeps recurring for one owner is not
 * filed again, it is handed to one tracker issue that asks for a structural
 * fix.
 *
 * Only findings this repository owns are escalated to its tracker: a finding
 * about a shared tool is escalated by `review-reflections` run in that tool's
 * repository. The issue for a class carries the label
 * `<issue_tracker.labels.pattern_prefix><class>`; an open one takes every new
 * finding of the class, and when there is none, the class's recurrence count
 * reaching `reflection.escalate_after` asks for one to be filed. A closed
 * issue does not count: the class recurring after its fix closed is a new
 * escalation, and the new issue links the closed one.
 */
import { CLOSED_STATE_TYPES } from "../../../do-item/scripts/lib/tracker/port.ts";
import { openTracker } from "../../../do-item/scripts/lib/tracker/index.ts";
import { trackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import {
  type ComputedState,
  type DecisionEvent,
  type FindingEvent,
  decisionStamp,
  ownerOf,
  recurrence,
  type Session,
} from "./events.ts";

export interface ClassIssue {
  identifier: string;
  state: string;
}

/** What the tracker says about one class's label. */
export interface ClassIssues {
  open: ClassIssue[];
  closed: ClassIssue[];
}

/**
 * The tracker as reflection uses it. Its callers bound every call with
 * `withinTrackerDeadline`, which aborts `signal` at the deadline: an
 * implementation ends the request in flight and starts no further one, so
 * no work outlives the call.
 */
export interface TrackerLookup {
  label(className: string): string;
  issues(className: string, signal: AbortSignal): Promise<ClassIssues>;
  comment(issue: string, body: string, signal: AbortSignal): Promise<void>;
}

/** How long one tracker call may take. */
export const TRACKER_DEADLINE_MS = 60_000;

/**
 * `work`'s result, or a rejection naming `what` once the deadline passes
 * first. The deadline also aborts the signal `work` was given, so the
 * tracker stops rather than running on unobserved.
 */
export async function withinTrackerDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  what: string,
  ms = TRACKER_DEADLINE_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} did not finish within ${ms / 1000}s`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The configured tracker, or the reason there is none to ask. */
export function configuredTracker(): TrackerLookup | string {
  let prefix: string;
  let tracker: ReturnType<typeof openTracker>;
  try {
    const config = trackerConfig();
    prefix = config.labels.patternPrefix;
    tracker = openTracker(config);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return {
    label: (className) => `${prefix}${className}`,
    async issues(className, signal) {
      const found = await tracker.labelledIssues(
        `${prefix}${className}`,
        signal,
      );
      const closed = new Set<string>(CLOSED_STATE_TYPES);
      const result: ClassIssues = { open: [], closed: [] };
      for (const issue of found)
        (closed.has(issue.stateType) ? result.closed : result.open).push({
          identifier: issue.identifier,
          state: issue.stateType,
        });
      return result;
    },
    comment: (issue, body, signal) => tracker.postComment(issue, body, signal),
  };
}

export interface ClassPlan {
  class: string;
  owner: string;
  /** The recurrence count with the new findings of the class included. */
  count: number;
  /** The new findings of the class. */
  findings: string[];
  open_issue: string | null;
  closed_issues: string[];
  /**
   * attach: escalate to the open issue; file: file one, then escalate;
   * store: store as it is; unverified: due, but the tracker could not be
   * read, so whether an issue exists is unknown and none may be filed.
   */
  action: "attach" | "file" | "store" | "unverified";
  label: string | null;
}

/**
 * The escalation plan for the findings about to be contributed: per class
 * this repository owns, its count and what to do. Classes of another owner
 * are stored as they are.
 */
interface ClassIssueFacts {
  open_issue: string | null;
  closed_issues: string[];
  label: string | null;
  /** False when the tracker was asked and could not answer. */
  verified: boolean;
}

/**
 * Asks the tracker about each class's issues. A tracker that cannot answer
 * is noted, never thrown: the plan still holds every class.
 */
function issueAsker(tracker: TrackerLookup | string) {
  let note = typeof tracker === "string" ? `no tracker: ${tracker}` : "ok";
  return {
    note: () => note,
    async ask(className: string): Promise<ClassIssueFacts> {
      if (typeof tracker === "string")
        return {
          open_issue: null,
          closed_issues: [],
          label: null,
          verified: true,
        };
      let issues: ClassIssues;
      try {
        issues = await withinTrackerDeadline(
          (signal) => tracker.issues(className, signal),
          "the tracker's issue lookup",
        );
      } catch (error) {
        note = `tracker unavailable: ${error instanceof Error ? error.message : String(error)}`;
        return {
          open_issue: null,
          closed_issues: [],
          label: tracker.label(className),
          verified: false,
        };
      }
      return {
        open_issue: issues.open[0]?.identifier ?? null,
        closed_issues: issues.closed.map((issue) => issue.identifier),
        label: tracker.label(className),
        verified: true,
      };
    },
  };
}

export async function planEscalation(
  findings: readonly FindingEvent[],
  state: ComputedState,
  repository: string,
  escalateAfter: number,
  tracker: TrackerLookup | string,
): Promise<{ classes: ClassPlan[]; tracker: string }> {
  const owner = `repository:${repository}`;
  const byClass = new Map<string, FindingEvent[]>();
  for (const finding of findings.filter((f) => ownerOf(f) === owner))
    byClass.set(finding.class, [
      ...(byClass.get(finding.class) ?? []),
      finding,
    ]);
  const asker = issueAsker(tracker);
  const classes: ClassPlan[] = [];
  for (const [className, members] of [...byClass.entries()].sort()) {
    const fresh = members.filter((finding) => !state.findings.has(finding.id));
    const count = recurrence(state, owner, className) + fresh.length;
    const { verified, ...facts } = await asker.ask(className);
    const due =
      count < escalateAfter ? "store" : verified ? "file" : "unverified";
    classes.push({
      class: className,
      owner,
      count,
      findings: members.map((finding) => finding.id),
      ...facts,
      action: facts.open_issue !== null ? "attach" : due,
    });
  }
  return { classes, tracker: asker.note() };
}

export interface OwnedClassPlan {
  class: string;
  owner: string;
  count: number;
  open_issue: string | null;
  closed_issues: string[];
  /**
   * attach: escalate its open findings to the open issue; file: file one
   * first; unverified: the tracker could not be read, so none may be filed.
   */
  action: "attach" | "file" | "unverified";
  label: string | null;
}

/**
 * For a review: every class of the owners in scope whose findings recur
 * enough to escalate, or that already have an open issue their open
 * findings should go to.
 */
/** Each owner's open and deferred findings per class, in a stable order. */
function countsByOwnerClass(
  state: ComputedState,
  owners: readonly string[],
): Array<{ owner: string; class: string; count: number }> {
  const counts = new Map<
    string,
    { owner: string; class: string; count: number }
  >();
  for (const held of state.findings.values()) {
    if (!owners.includes(held.owner)) continue;
    if (held.status !== "open" && held.status !== "deferred") continue;
    const key = `${held.owner}\u0000${held.finding.class}`;
    const entry = counts.get(key) ?? {
      owner: held.owner,
      class: held.finding.class,
      count: 0,
    };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, entry]) => entry);
}

export async function planOwnedClasses(
  state: ComputedState,
  owners: readonly string[],
  escalateAfter: number,
  tracker: TrackerLookup | string,
): Promise<{ classes: OwnedClassPlan[]; tracker: string }> {
  const asker = issueAsker(tracker);
  const classes: OwnedClassPlan[] = [];
  for (const entry of countsByOwnerClass(state, owners)) {
    const { verified, ...facts } = await asker.ask(entry.class);
    if (facts.open_issue === null && entry.count < escalateAfter) continue;
    classes.push({
      ...entry,
      ...facts,
      action:
        facts.open_issue !== null ? "attach" : verified ? "file" : "unverified",
    });
  }
  return { classes, tracker: asker.note() };
}

/**
 * Escalated decisions for every finding of `className` that `owner` owns and
 * that is still open, the new ones included.
 */
export function escalationDecisions(
  className: string,
  owner: string,
  issue: string,
  fresh: readonly FindingEvent[],
  state: ComputedState,
  session: Session,
): DecisionEvent[] {
  const ids = new Set<string>();
  for (const finding of fresh)
    if (finding.class === className && ownerOf(finding) === owner)
      ids.add(finding.id);
  for (const held of state.findings.values())
    if (
      held.owner === owner &&
      held.finding.class === className &&
      (held.status === "open" || held.status === "deferred")
    )
      ids.add(held.finding.id);
  return [...ids].sort().map((finding) => ({
    v: 1,
    type: "decision",
    ...decisionStamp(state.findings.get(finding)?.latest ?? null),
    session,
    finding,
    decision: "escalated",
    reason: `the class ${className} recurs; ${issue} asks for its structural fix`,
    issue,
  }));
}
