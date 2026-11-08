/**
 * The follow-ups' own lane: a follow-up opens its workspace from a per-tick
 * budget of its own (`followup_opens_per_tick`), beside the drive launches'
 * `opens_per_tick` and the notices workspace's reserved open, and no more of
 * them run on the host at once than `followup_concurrency`, counted from
 * the live launch records. A follow-up never spends the launches'
 * allowance, so a drive's launch never waits behind follow-ups; account
 * slots stay shared, so a follow-up still needs an admitted account with a
 * free slot.
 *
 * A follow-up the lane holds back waits for a later tick, and its outcome
 * names what it waits on (`waitsOn`): the lane's budget, the lane's cap, or
 * the accounts.
 */
import { holds } from "../launches.ts";
import type { ApplyState } from "./launch.ts";

/** Why the host runs as many follow-ups as `followup_concurrency` allows; `null` while it runs fewer. */
export function laneCapWait(state: ApplyState): string | null {
  const cap = state.machine.followupConcurrency;
  const running = state.records.filter(
    (r) => r.record.action === "followup" && holds(r.state),
  ).length;
  return running < cap
    ? null
    : `the host runs ${running} follow-ups, the ${cap} its followup_concurrency allows; a later tick starts this one`;
}

/** Why the tick has opened every workspace `followup_opens_per_tick` covers; `null` while one is left. */
export function laneBudgetWait(state: ApplyState): string | null {
  const budget = state.machine.followupOpensPerTick;
  return (state.followupOpened ?? 0) < budget
    ? null
    : `this tick has opened the ${budget} follow-up workspaces its followup_opens_per_tick covers; a later tick opens this one`;
}
