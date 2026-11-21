/** How a tick reports a launched session that has waited too long. */
import { minutes } from "./duration.ts";
import { agentOf } from "./actions/pickup-hold.ts";
import { isInteractive, type LaunchRecord, targetOf } from "./launches.ts";
import { pickupNotice } from "./notices.ts";
import type { PickupInput, PickupPlan } from "./plan-pickups.ts";
import { WAITING_STATES } from "./runtime/port.ts";
import { isoFromMs } from "../../shared/time.ts";

/** What the tick read as a waiting session's cause: the usage-limit wall still its last record, if any. */
function waitCause(record: LaunchRecord): string {
  const latest = record.episodes?.at(-1);
  return latest?.last === true
    ? `, on its account's usage-limit wall since ${latest.observedAt} (resets ${latest.resetAt ?? "at an unknown time"})`
    : ", with no usage-limit wall read as its cause";
}

/** Each session this machine launched that has waited past `blocked_after`. */
export function planWaiting(input: PickupInput, plan: PickupPlan): void {
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
        `${target} waiting, record ${record.id} since ${isoFromMs(since)}`,
        `${target}: the ${record.action} session in ${found.workspace.path} ${reason}`,
      ),
      workspace: found.workspace.path,
    });
  }
}
