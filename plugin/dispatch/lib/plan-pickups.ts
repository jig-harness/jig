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
 *   a claimed item. A served person's item is a pickup's claim only when a
 *   pickup of this machine claimed it: its claim, noted on its launch record
 *   where `tracker.ts claim` made it (`pickup-claim.ts`), or seen while it
 *   ran. The rest of their work in progress is their own, and quiet.
 * - A session this machine launched that the runtime reports waiting for
 *   longer than `dispatch.blocked_after` is reported; it keeps its slot.
 * - An item whose latest pickup pass ended on a question, without recording
 *   `done`, is a need: its `Question:` line is notified, and nothing is
 *   started for it, whether it was claimed or is still in a dispatch state.
 *
 * Each report is a notification's cause, with its message and the key
 * that suppresses a repeat (`notices.ts`); `actions/notify.ts` sends it.
 */
import { batchPickups } from "./queue-batch.ts";
import {
  agentOf,
  holdingRecords,
  pickupClaimed,
  type PickupHold,
  pickupHold,
} from "./actions/pickup-hold.ts";
import { type Holding, holding, liveAgents } from "./holding.ts";
import {
  isInteractive,
  type LaunchRecord,
  type ReadRecord,
  targetOf,
} from "./launches.ts";
import { holdsItem } from "./launch-pickups.ts";
import { pickupNotice } from "./notices.ts";
import { questionOf } from "./session.ts";
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
  values?: Record<string, unknown>;
  /** The repository's checkout: the label taxonomy the size facet's values come from is read here. */
  root?: string;
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
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
    const hold = pickupHold(item.key, launches, item.updatedAt, input.nowMs);
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
    if (hold.kind !== "none") {
      planStopped(input.slug, item, hold, launches, plan);
      continue;
    }
    plan.actions.push(pickupAction(item, held.evidence));
  }

  for (const item of input.claimed ?? [])
    planClaimed(item, input, plan, joined(item.key));
  planWaiting(input, plan);
  if (input.values !== undefined && input.root !== undefined)
    plan.actions = batchPickups(
      plan.actions,
      input.pickups,
      input.values,
      input.root,
    );
  return plan;
}

/**
 * An item whose latest pickup ended without claiming it: held while the
 * repository's start rules refused it, a need when its pass stopped on a
 * question, else quiet.
 */
function planStopped(
  slug: string,
  item: WantedItem,
  hold: Extract<PickupHold, { kind: "ended" | "refused" }>,
  launches: ReadRecord[],
  plan: PickupPlan,
): void {
  const why = hold.why;
  if (hold.kind === "refused") {
    plan.quiet.push({ target: item.key, class: "pickup-refused", why });
    return;
  }
  const asked = questionAsked(slug, item, launches);
  if (asked !== null) plan.actions.push(asked);
  else plan.quiet.push({ target: item.key, class: "pickup-ended", why });
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
  const pickup = pickupHold(item.key, input.launches, undefined, input.nowMs);
  // A rate-limit wait holds an ended pickup, which claims nothing by waiting.
  const endedUnclaimed =
    (pickup.kind === "ended" ||
      (pickup.kind === "held" && pickup.record.result === "waits")) &&
    !pickupClaimed(pickup.record.record, item.key);
  if (item.served === true && (pickup.kind === "none" || endedUnclaimed)) {
    plan.quiet.push({
      target: item.key,
      class: "claimed-by-person",
      why: `in ${item.state}, started by its served person: no pickup of this machine claimed it`,
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
  const asked = questionAsked(input.slug, item, input.launches);
  if (asked !== null) {
    plan.actions.push(asked);
    return;
  }
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

/**
 * The need an item's latest pickup raises when its pass ended on a
 * question without recording `done`: the question, notified once per
 * launch record; `null` otherwise.
 */
function questionAsked(
  slug: string,
  item: { key: string; title: string; state: string },
  launches: ReadRecord[],
): Action | null {
  const latest = launches
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        (r.record.item === item.key ||
          r.record.batchItems?.some((i) => i.key === item.key) === true) &&
        holdsItem(r.record, item.key),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .at(-1);
  if (
    latest === undefined ||
    latest.result === "done" ||
    latest.result === "waits"
  )
    return null;
  // A pass that framed its decision asks its question there, whether or not it also ended on a question line.
  const question =
    questionOf(latest.state) ??
    (latest.result === "failed"
      ? (latest.framed?.decision.call.question ?? null)
      : null);
  if (question === null) return null;
  const { record } = latest;
  const reason = `the pickup stopped on a question for a person: ${question}`;
  return {
    stage: "notify",
    target: item.key,
    record: "runtime",
    reason,
    evidence: {
      record: record.id,
      stage: "pickup",
      title: item.title,
      state: item.state,
      account: record.account,
      question,
    },
    cause: "pickup-question",
    ...(latest.framed === undefined ? {} : { framed: latest.framed }),
    notice: pickupNotice(
      slug,
      `${item.key} question, record ${record.id}`,
      `${item.key} (${item.title}): ${reason}; nothing starts for it until the item leaves the dispatch states and comes back`,
    ),
    ...(record.workspace === null ? {} : { workspace: record.workspace.path }),
    // The pass's ended row in the outcome log already holds how it ended.
    launched: true,
  };
}

/** What the tick read as a waiting session's cause: the usage-limit wall still its last record, if any. */
function waitCause(record: LaunchRecord): string {
  const latest = record.episodes?.at(-1);
  return latest?.last === true
    ? `, on its account's usage-limit wall since ${latest.observedAt} (resets ${latest.resetAt ?? "at an unknown time"})`
    : ", with no usage-limit wall read as its cause";
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
    const reason = `session waiting: its agent has been ${found.agent.state} for ${minutes(input.nowMs - since)} (dispatch.blocked_after ${minutes(input.section.blockedAfterMs)})${waitCause(record)}; it keeps its slot until it ends or a person ends it`;
    plan.actions.push({
      stage: "notify",
      target,
      record: "runtime",
      reason,
      evidence: {
        record: record.id,
        stage: record.action,
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

function pickupAction(
  item: WantedItem,
  finishedSessions: string | null,
): Action {
  return {
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
      ...(item.servedPerson === undefined
        ? {}
        : { servedPerson: item.servedPerson }),
      ...(item.ancestorEpic === undefined
        ? {}
        : { ancestorEpic: item.ancestorEpic }),
      ...(item.blockingFor === undefined
        ? {}
        : { blockingFor: item.blockingFor }),
      ...(finishedSessions === null
        ? {}
        : { finishedSessions: finishedSessions }),
    },
  };
}
