/**
 * The pickups in the plan: what the tracker's assigned items want, minus
 * what the runtime's sessions and this machine's launch records hold, and
 * what the claimed items show.
 *
 * - An item in a dispatch state with no session and no launch record
 *   holding it is a pickup. One a launch record or a running session holds
 *   is running; one whose last pickup ended without claiming it is quiet
 *   until it leaves the dispatch states and comes back.
 * - An item, wanted or claimed, that more than one running session joins to
 *   (two workspaces, or a workspace beside a launch record still holding
 *   another) is a double claim: reported, nothing started for it.
 * - A claimed item (in the in-progress state) with no running session for
 *   longer than `dispatch.stalled_after` is a stalled pickup: reported,
 *   never relaunched, since a relaunch would start a second implementer on
 *   a claimed item.
 * - A session this machine launched that the runtime reports waiting for
 *   longer than `dispatch.blocked_after` is reported; it keeps its slot.
 *
 * Each report is a notification's cause, with its message and the key
 * that suppresses a repeat (`notices.ts`); `actions/notify.ts` sends it.
 */
import { agentOf, holdingRecords, pickupHold } from "./actions/pickup-hold.ts";
import { type Holding, holding, liveAgents } from "./holding.ts";
import { isInteractive, type ReadRecord, targetOf } from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import {
  type SessionsReport,
  WAITING_STATES,
  type Workspace,
} from "./runtime/port.ts";
import type {
  Action,
  ClaimedItem,
  DispatchSection,
  RepoReport,
  WantedItem,
} from "./types.ts";

export interface PickupInput {
  /** The repository's `owner/name`, which every notification names. */
  slug: string;
  section: DispatchSection;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  sessions: SessionsReport;
  launches: ReadRecord[];
  /** Since when each claimed item has been idle, as the idle clock last recorded it. */
  idleSince: ReadonlyMap<string, number>;
  nowMs: number;
}

export type PickupPlan = Pick<
  RepoReport,
  "actions" | "running" | "unplaced" | "quiet"
> & {
  /** The claimed items idle this tick: the idle clock runs for these and stops for the rest. */
  idleNow: string[];
  /** The claimed items whose idleness could not be told: their clock is neither started nor stopped. */
  idleKeep: string[];
};

/** The sessions joined to an item: running workspaces, and records holding it outside them. */
function sessionsFor(
  item: string,
  held: Holding,
  launches: ReadRecord[],
): { count: number; evidence: string; who: string } {
  const live = held.kind === "running" ? held.workspaces : [];
  const paths = new Set(live.map((w) => w.path));
  const outside = holdingRecords(item, launches).filter(
    (r) => r.record.workspace === null || !paths.has(r.record.workspace.path),
  );
  const parts = [
    ...(live.length > 0 ? [liveAgents(live)] : []),
    ...outside.map(
      (r) =>
        `launch record ${r.record.id} (${r.state.kind}) in ${r.record.workspace?.path ?? "no workspace yet"}`,
    ),
  ];
  const who = [
    ...live.map((w) => `workspace ${w.id}`),
    ...outside.map((r) => `record ${r.record.id}`),
  ]
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
  return {
    count: live.length + outside.length,
    evidence: parts.join("; "),
    who,
  };
}

function doubleClaim(
  slug: string,
  item: { key: string; state: string },
  count: number,
  evidence: string,
  who: string,
): Action {
  const reason = `double claim: ${count} running sessions join to it, so nothing starts for it`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: { sessions: evidence },
    cause: "double-claim",
    notice: pickupNotice(
      slug,
      `${item.key} double claim, in ${item.state}, between ${who}`,
      `${item.key} ${reason} (${evidence}); a person settles which session keeps it`,
    ),
  };
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

export function planPickups(input: PickupInput): PickupPlan {
  const plan: PickupPlan = {
    actions: [],
    running: [],
    unplaced: [],
    quiet: [],
    idleNow: [],
    idleKeep: [],
  };
  const { sessions, launches } = input;
  const joined = (key: string) => (w: Workspace) => w.items.includes(key);

  for (const item of input.pickups) {
    const held = holding(sessions, joined(item.key));
    const { count, evidence, who } = sessionsFor(item.key, held, launches);
    if (count > 1) {
      plan.actions.push(doubleClaim(input.slug, item, count, evidence, who));
      continue;
    }
    const hold = pickupHold(item.key, launches);
    if (hold.kind === "held") {
      plan.running.push({
        target: item.key,
        stage: "pickup",
        reason: hold.why,
        evidence: { record: hold.record.record.id },
      });
      continue;
    }
    if (held.kind === "unknown") {
      plan.unplaced.push({
        target: item.key,
        record: "runtime",
        reason: held.reason,
      });
      continue;
    }
    if (held.kind === "running") {
      plan.running.push({
        target: item.key,
        stage: "pickup",
        reason: `a session is running for it: ${evidence}`,
        evidence: { workspaces: held.workspaces.map((w) => w.path).join(", ") },
      });
      continue;
    }
    if (hold.kind === "ended") {
      plan.quiet.push({
        target: item.key,
        class: "pickup-ended",
        why: hold.why,
      });
      continue;
    }
    plan.actions.push({
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
        ...(held.evidence === null ? {} : { finishedSessions: held.evidence }),
      },
    });
  }

  for (const item of input.claimed ?? [])
    planClaimed(item, input, plan, joined(item.key));
  planWaiting(input, plan);
  return plan;
}

/** One claimed item: a double claim, running, idle, or stalled. */
function planClaimed(
  item: ClaimedItem,
  input: PickupInput,
  plan: PickupPlan,
  joined: (w: Workspace) => boolean,
): void {
  const held = holding(input.sessions, joined);
  const { count, evidence, who } = sessionsFor(item.key, held, input.launches);
  if (count > 1) {
    plan.actions.push(doubleClaim(input.slug, item, count, evidence, who));
    return;
  }
  if (count === 1) {
    plan.quiet.push({
      target: item.key,
      class: "claimed",
      why: `in ${item.state}, a session holds it: ${evidence}`,
    });
    return;
  }
  if (held.kind === "unknown") {
    plan.idleKeep.push(item.key);
    plan.unplaced.push({
      target: item.key,
      record: "runtime",
      reason: held.reason,
    });
    return;
  }
  plan.idleNow.push(item.key);
  const since = input.idleSince.get(item.key) ?? input.nowMs;
  const idle = input.nowMs - since;
  if (idle < input.section.stalledAfterMs) {
    plan.quiet.push({
      target: item.key,
      class: "claimed-idle",
      why: `in ${item.state} with no running session for ${minutes(idle)}; reported as stalled after ${minutes(input.section.stalledAfterMs)}`,
    });
    return;
  }
  const reason = `stalled pickup: in ${item.state} with no running session for ${minutes(idle)} (dispatch.stalled_after ${minutes(input.section.stalledAfterMs)}); never relaunched, a person settles it`;
  plan.actions.push({
    stage: "notify",
    target: item.key,
    record: "tracker",
    reason,
    evidence: {
      title: item.title,
      state: item.state,
      idleSince: new Date(since).toISOString(),
      ...(held.kind === "free" && held.evidence !== null
        ? { finishedSessions: held.evidence }
        : {}),
    },
    cause: "stalled",
    notice: pickupNotice(
      input.slug,
      `${item.key} stalled, idle since ${new Date(since).toISOString()}`,
      `${item.key} (${item.title}): ${reason}`,
    ),
  });
}

/** Each session this machine launched that has waited past `blocked_after`. */
function planWaiting(input: PickupInput, plan: PickupPlan): void {
  for (const r of input.launches) {
    const { record, state } = r;
    if (!isInteractive(record) || record.agentId === null) continue;
    if (state.kind !== "alive") continue;
    const found = agentOf(input.sessions, record.agentId);
    if (found === undefined || !WAITING_STATES.has(found.agent.state)) continue;
    const since = found.agent.since;
    if (since === null || input.nowMs - since < input.section.blockedAfterMs)
      continue;
    const target = targetOf(record);
    const reason = `session waiting: its agent has been ${found.agent.state} for ${minutes(input.nowMs - since)} (dispatch.blocked_after ${minutes(input.section.blockedAfterMs)}); it keeps its slot until it ends or a person ends it`;
    plan.actions.push({
      stage: "notify",
      target,
      record: "runtime",
      reason,
      evidence: {
        record: record.id,
        agent: record.agentId,
        workspace: found.workspace.path,
        account: record.account,
      },
      cause: "waiting",
      notice: pickupNotice(
        input.slug,
        `${target} waiting, record ${record.id} since ${new Date(since).toISOString()}`,
        `${target}: the ${record.action} session in ${found.workspace.path} ${reason}`,
      ),
      workspace: found.workspace.path,
    });
  }
}
