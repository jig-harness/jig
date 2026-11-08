/**
 * Where a pull request stands, from what the page already holds: the newest
 * tick's line (sessions, needs, queue) and, when the forge answered, its
 * state. The line comes from the host that holds the credentials, so a page
 * served without any still says what the dispatcher is doing with the PR.
 */
import type {
  LineNeed,
  LineQueued,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";
import { ago } from "./format.ts";
import { queuedFollowup } from "./followup-view.ts";
import { type Clock, sessionKind } from "./view.ts";

/** The icon a standing shows; one per kind, so colour is never the only signal. */
export type StandingKind =
  | "driving"
  | "following-up"
  | "waiting"
  | "needs-person"
  | "queued"
  | "held"
  | "merged"
  | "closed"
  | "draft"
  | "open"
  | "unknown";

/** The colour family a kind is drawn in. */
export type StandingTone = "go" | "wait" | "bad" | "needs" | "done" | "quiet";

export interface Standing {
  kind: StandingKind;
  tone: StandingTone;
  /** The state in a few words, for the popover's head and the icon's name. */
  label: string;
  /** What else is known, one fact per entry. */
  facts: string[];
}

const NEED_LABEL: Record<LineNeed["cause"], string> = {
  parked: "Parked: waiting on a decision",
  stalled: "Stalled: the drive stopped",
  "needs-person": "Needs a person",
  "stopped-unknown": "Stopped, cause unknown",
  "followup-failed": "Follow-up failed",
  "followup-stale": "Follow-up claim went stale",
  "nudge-unanswered": "Nudge unanswered",
  "double-claim": "Claimed twice",
  "assigner-cannot-write": "Assigned by someone who cannot write",
};

const KIND_TONE: Record<StandingKind, StandingTone> = {
  driving: "go",
  "following-up": "go",
  waiting: "wait",
  "needs-person": "needs",
  queued: "quiet",
  held: "quiet",
  merged: "done",
  closed: "bad",
  draft: "quiet",
  open: "quiet",
  unknown: "quiet",
};

const SESSION_LABEL: Record<ReturnType<typeof sessionKind>, string> = {
  working: "Driving",
  takeover: "Taking over a stalled drive",
  pending: "Launching",
  stuck: "Launch stuck",
  waitWall: "Waiting out a usage limit",
  waitOther: "Waiting",
  drift: "Drifting from its expectation",
  unknown: "Launch record unreadable",
};

/** A standing as chosen from the line; `followup` marks progress a finished forge state must not hide. */
type Found = Omit<Standing, "tone"> & { followup?: true };

function sessionStanding(
  s: LineSession,
  clock: Clock,
): Pick<Found, "kind" | "label" | "followup"> {
  const kind = sessionKind(s, clock.nowMs);
  const label = SESSION_LABEL[kind];
  const followup = s.stage === "followup" ? { followup: true as const } : {};
  if (kind === "stuck" || kind === "unknown")
    return { kind: "needs-person", label, ...followup };
  if (kind === "waitWall" || kind === "waitOther" || kind === "drift")
    return { kind: "waiting", label, ...followup };
  if (s.stage === "followup")
    return {
      kind: "following-up",
      label: "Following up after the merge",
      ...followup,
    };
  return { kind: "driving", label };
}

function threadFact(s: LineSession): string[] {
  const latest = s.samples.at(-1);
  if (latest === undefined) return [];
  if (latest.threads === 0) return ["No unresolved threads at the last count"];
  return [
    `${latest.threads} unresolved ${latest.threads === 1 ? "thread" : "threads"} at the last count`,
  ];
}

/** How long the runtime has had the session waiting or blocked. */
function agentWaitFact(s: LineSession, clock: Clock): string[] {
  const agent = s.agent;
  if (agent?.since == null) return [];
  if (agent.state !== "waiting" && agent.state !== "blocked") return [];
  const word = agent.state === "blocked" ? "Blocked" : "Waiting";
  return [`${word} ${ago(Date.parse(agent.since), clock.nowMs)}`];
}

function sessionFacts(s: LineSession, clock: Clock): string[] {
  const recorded = [s.stuck, s.launchReason, s.drifting, s.waiting];
  return [
    `Stage ${s.stage} on ${s.account}`,
    ...(s.round === null ? [] : [`Round ${s.round}`]),
    ...threadFact(s),
    ...(s.heartbeat === null
      ? []
      : [`Last ledger write ${ago(Date.parse(s.heartbeat), clock.nowMs)} ago`]),
    ...recorded.filter((reason) => reason != null),
    ...agentWaitFact(s, clock),
  ];
}

function needFacts(n: LineNeed, clock: Clock): string[] {
  return [
    n.reason,
    `Waiting ${ago(Date.parse(n.since), clock.nowMs)}`,
    ...(n.decisions.length === 0
      ? []
      : [
          `${n.decisions.length} unanswered ${n.decisions.length === 1 ? "decision" : "decisions"}`,
        ]),
  ];
}

const GROUP_LABEL: Record<LineQueued["group"], string> = {
  starts: "Queued",
  held: "Held back",
  reported: "Reported, not started",
  never: "Refused, will not start",
};

function queuedStanding(
  q: LineQueued,
  clock: Clock,
): Pick<Found, "kind" | "label" | "facts" | "followup"> {
  const wait =
    q.hold === null
      ? []
      : [`Waited ${ago(Date.parse(q.hold.since), clock.nowMs)}`];
  const facts = [q.why, ...wait];
  if (q.source === "merged")
    return {
      kind: "merged",
      label: queuedFollowup(q.group),
      facts,
      followup: true,
    };
  if (q.source === "held" || q.group === "held")
    return { kind: "held", label: "Held back", facts };
  return {
    kind: "queued",
    label: q.stale ? "Converged, then went stale" : GROUP_LABEL[q.group],
    facts,
  };
}

function needStanding(n: LineNeed, clock: Clock): Found {
  return {
    kind: "needs-person",
    label: NEED_LABEL[n.cause],
    facts: needFacts(n, clock),
  };
}

/** What the newest tick's line says of a PR; `null` when it holds no record of it. */
function lineStanding(
  line: LineSnapshot | null,
  repo: string,
  pr: number,
  clock: Clock,
): Found | null {
  const need = line?.needs.find((n) => n.repo === repo && n.pr === pr);
  const session = line?.sessions.find((s) => s.repo === repo && s.pr === pr);
  const queued = line?.queue.find((q) => q.repo === repo && q.pr === pr);
  // A launch record stuck on the PR is a session's story, not a need's.
  if (need !== undefined && need.stuckRecord == null)
    return needStanding(need, clock);
  if (session !== undefined)
    return {
      ...sessionStanding(session, clock),
      facts: sessionFacts(session, clock),
    };
  if (need !== undefined) return needStanding(need, clock);
  if (queued !== undefined) return queuedStanding(queued, clock);
  return null;
}

/** A PR the forge says is finished; `null` for one still open or not read. */
function finishedStanding(fact: DashboardPr | null): Found | null {
  if (fact?.state === "MERGED")
    return { kind: "merged", label: "Merged", facts: [] };
  if (fact?.state === "CLOSED")
    return { kind: "closed", label: "Closed", facts: [] };
  return null;
}

/** A finished PR keeps what still needs a person, such as a failed follow-up. */
function withFinished(finished: Found, found: Found | null): Standing {
  if (
    found === null ||
    (found.kind !== "needs-person" && found.followup !== true)
  )
    return withTone(finished);
  return {
    ...withTone(found),
    label: `${finished.label}; ${found.label.toLowerCase()}`,
  };
}

function forgeOnly(fact: DashboardPr | null): Found {
  if (fact === null)
    return {
      kind: "unknown",
      label: "Not in the dispatcher's line",
      facts: [
        "The newest tick holds no session, need or queue entry for it, and the forge was not read.",
      ],
    };
  return {
    kind: fact.isDraft ? "draft" : "open",
    label: `${fact.isDraft ? "Draft" : "Open"}, not in the dispatcher's line`,
    facts: [],
  };
}

/** What the page knows of one PR; `line` and `fact` may each be missing. */
export function prStanding(
  line: LineSnapshot | null,
  repo: string,
  pr: number,
  fact: DashboardPr | null,
  clock: Clock,
): Standing {
  const found = lineStanding(line, repo, pr, clock);
  const finished = finishedStanding(fact);
  const chosen = finished
    ? withFinished(finished, found)
    : withTone(found ?? forgeOnly(fact));
  const read =
    fact === null ? [] : [`Forge read ${fact.checkedAt.slice(0, 16)}Z`];
  return { ...chosen, facts: [...chosen.facts, ...read] };
}

function withTone(found: Found): Standing {
  const { followup: _followup, ...standing } = found;
  return { ...standing, tone: KIND_TONE[found.kind] };
}
