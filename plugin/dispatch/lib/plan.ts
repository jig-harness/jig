/**
 * The plan: what the records want, minus what the runtime reports running.
 * Every item or pull request gets at most one action, naming the record
 * that wants it and its evidence. A target the tick cannot place (a record
 * it could not read, a runtime answer it cannot trust, a workspace whose
 * terminals the runtime cannot read) is reported and never planned.
 */
import { driveHold, factsOf } from "./actions/drive-hold.ts";
import type { ReadRecord } from "./launches.ts";
import {
  RUNNING_STATES,
  type SessionsReport,
  type Workspace,
} from "./runtime/port.ts";
import type {
  Action,
  DispatchSection,
  DrivenPr,
  LedgerClass,
  MergedPr,
  RepoReport,
  Running,
  Stage,
  WantedItem,
} from "./types.ts";

export interface PlanInput {
  section: DispatchSection;
  pickups: WantedItem[];
  drives: DrivenPr[];
  merged: MergedPr[];
  sessions: SessionsReport;
  /** This machine's launch records for the repository. */
  launches: ReadRecord[];
}

type Plan = Pick<RepoReport, "actions" | "running" | "unplaced" | "quiet">;

/** The ledger classes that need nothing from the tick but a line in the report. */
const QUIET: ReadonlySet<LedgerClass> = new Set([
  "driven",
  "silent",
  "done",
  "stopped-by-person",
  "refused",
]);

/** The ledger classes a person must settle: notified, never re-armed. */
const NOTIFY: ReadonlySet<LedgerClass> = new Set([
  "stopped-unknown",
  "parked",
  "needs-person",
]);

type Holding =
  | { kind: "free"; evidence: string | null }
  | { kind: "running"; workspaces: Workspace[] }
  | { kind: "unknown"; reason: string };

/** Whether a running session holds the target, from the workspaces joined to it. */
function holding(
  sessions: SessionsReport,
  joined: (w: Workspace) => boolean,
): Holding {
  if (!sessions.ok) return { kind: "unknown", reason: sessions.reason };
  const mine = sessions.workspaces.filter(joined);
  const unreadable = mine.find((w) => w.unverifiableTerminals > 0);
  if (unreadable !== undefined)
    return {
      kind: "unknown",
      reason: `workspace ${unreadable.path} has ${unreadable.unverifiableTerminals} terminal(s) whose agents the runtime cannot report`,
    };
  const live = mine.filter((w) =>
    w.agents.some((a) => RUNNING_STATES.has(a.state)),
  );
  if (live.length > 0) return { kind: "running", workspaces: live };
  const finished = mine.flatMap((w) =>
    w.agents.map((a) => `${w.branch || w.path}: ${a.state}`),
  );
  return {
    kind: "free",
    evidence: finished.length > 0 ? finished.join("; ") : null,
  };
}

function runningCount(held: Holding): number {
  return held.kind === "running" ? liveAgentCount(held.workspaces) : 0;
}

/** The running agents across workspaces. */
function liveAgentCount(workspaces: Workspace[]): number {
  return workspaces.reduce(
    (n, w) => n + w.agents.filter((a) => RUNNING_STATES.has(a.state)).length,
    0,
  );
}

function liveAgents(workspaces: Workspace[]): string {
  return workspaces
    .map(
      (w) =>
        `${w.branch || w.path} (${w.agents
          .filter((a) => RUNNING_STATES.has(a.state))
          .map((a) => a.state)
          .join(", ")})`,
    )
    .join("; ");
}

export function planTick(input: PlanInput): Plan {
  const plan: Plan = { actions: [], running: [], unplaced: [], quiet: [] };
  const { sessions } = input;

  /** One wanted stage for one target, minus what is running. */
  function want(action: Action, joined: (w: Workspace) => boolean): void {
    const held = holding(sessions, joined);
    if (held.kind === "unknown") {
      plan.unplaced.push({
        target: action.target,
        record: "runtime",
        reason: held.reason,
      });
      return;
    }
    if (held.kind === "running") {
      plan.running.push({
        target: action.target,
        stage: action.stage,
        reason: `a session is running for it: ${liveAgents(held.workspaces)}`,
        evidence: { workspaces: held.workspaces.map((w) => w.path).join(", ") },
      } satisfies Running);
      return;
    }
    plan.actions.push(
      held.evidence === null
        ? action
        : {
            ...action,
            evidence: { ...action.evidence, finishedSessions: held.evidence },
          },
    );
  }

  for (const item of input.pickups) {
    const joined = (w: Workspace) => w.items.includes(item.key);
    const held = holding(sessions, joined);
    const liveCount = runningCount(held);
    if (held.kind === "running" && liveCount > 1) {
      plan.actions.push({
        stage: "notify",
        target: item.key,
        record: "runtime",
        reason: `double claim: ${liveCount} running sessions join to it, so nothing starts for it`,
        evidence: { workspaces: liveAgents(held.workspaces) },
      });
      continue;
    }
    want(
      {
        stage: "pickup",
        target: item.key,
        record: "tracker",
        reason: `assigned to ${item.assignee} by ${item.assignedBy}, in ${item.state}, with no running session`,
        evidence: {
          title: item.title,
          url: item.url,
          state: item.state,
          assignee: item.assignee,
          assignedBy: item.assignedBy,
        },
      },
      joined,
    );
  }

  // A pull request in both populations merged between the two reads: the
  // merged state wins, so it gets its follow-up and no re-arm.
  const mergedNumbers = new Set(input.merged.map((m) => m.number));
  for (const pr of input.drives.filter((d) => !mergedNumbers.has(d.number)))
    planDrive(pr, input.launches, plan, want);

  if (input.section.followupCommand !== null)
    for (const pr of input.merged)
      want(
        {
          stage: "followup",
          target: `PR #${pr.number}`,
          record: "forge",
          reason: `merged ${pr.mergedAt}; run ${input.section.followupCommand} ${pr.number}`,
          evidence: { url: pr.url, head: pr.head, mergedAt: pr.mergedAt },
        },
        (w) => w.prs.includes(pr.number),
      );
  return plan;
}

type Want = (action: Action, joined: (w: Workspace) => boolean) => void;

/** One driven pull request: quiet, unplaced, held by a launch record, or wanted. */
function planDrive(
  pr: DrivenPr,
  launches: ReadRecord[],
  plan: Plan,
  want: Want,
): void {
  const target = `PR #${pr.number}`;
  const hold = driveHold(pr, launches);
  if (hold.kind === "held") {
    plan.running.push({
      target,
      stage: "rearm",
      reason: hold.why,
      evidence: { record: hold.record.record.id },
    });
    return;
  }
  if (hold.kind === "refused") {
    plan.quiet.push({ target, class: "refused", why: hold.why });
    return;
  }
  const takeover = hold.kind === "takeover" ? hold.record.record.id : null;
  if (QUIET.has(pr.class) && takeover === null) {
    plan.quiet.push({ target, class: pr.class, why: pr.why });
    return;
  }
  if (pr.class === "unplaced") {
    plan.unplaced.push({ target, record: "forge", reason: pr.why });
    return;
  }
  const stage: Stage = NOTIFY.has(pr.class) ? "notify" : "rearm";
  want(
    {
      stage,
      target,
      record: "forge",
      reason:
        takeover === null
          ? `drive ledger ${pr.class}: ${pr.why}`
          : `drive ledger silent, and this machine's launch record ${takeover} started its driver: take it over (drive.ts --take-over decides)`,
      evidence: { url: pr.url, head: pr.head, ...pr.evidence },
      ...(stage === "rearm" ? { facts: factsOf(pr) } : {}),
      ...(takeover === null ? {} : { takeover }),
    },
    (w) => w.prs.includes(pr.number),
  );
}
