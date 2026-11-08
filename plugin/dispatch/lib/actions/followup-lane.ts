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
import type { SessionsReport } from "../runtime/port.ts";
import { holding } from "../holding.ts";
import { joinedTo, stuckWhy } from "../stuck-launches.ts";
import { failureText } from "../text.ts";
import type { ApplyState } from "./launch.ts";

/**
 * Why the host runs as many follow-ups as `followup_concurrency` allows;
 * `null` while it runs fewer. A record stuck pending, which the tick
 * notifies to a person and no tick launches again (`stuck-launches.ts`),
 * holds its account's slot but not a place in the lane while the runtime
 * shows no session running on its target, so one launch that never started
 * cannot hold the lane until a person clears it. A stuck record whose
 * target has a session running, or whose sessions cannot be told, keeps its
 * place: that wrapper may run its stage without having claimed the record.
 * `sessions` is the fresh listing of repository `repo`; a record of another
 * repository is judged by the listing its own observation read this tick
 * (`state.sessionsOf`), and keeps its place when there is none.
 */
export function laneCapWait(
  state: ApplyState,
  sessions: SessionsReport,
  repo: string,
): string | null {
  const cap = state.machine.followupConcurrency;
  const nowMs = Date.now();
  const running = state.records.filter((r) => {
    if (r.record.action !== "followup" || !holds(r.state)) return false;
    const seen =
      r.record.repo === repo ? sessions : state.sessionsOf?.get(r.record.repo);
    if (seen === undefined) return true;
    const clock = {
      nowMs,
      unclaimedAfterMs: state.machine.unclaimedAfterMs,
      sessions: seen,
    };
    return !(
      stuckWhy(r, clock) !== null &&
      holding(seen, joinedTo(r.record)).kind === "free"
    );
  }).length;
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

/** A workspace, as a launch record names it. */
export type WorkspaceRef = { id: string; path: string };

/**
 * The runtime's sessions read afresh by `read`, and the workspace joined to
 * pull request `pr` (`undefined` when none is); or why they could not be
 * read. A listing that fails cannot say no workspace is joined, so the
 * follow-up waits rather than spend the lane's budget opening one on a guess.
 */
export async function joinedWorkspace(
  read: () => Promise<SessionsReport>,
  pr: number,
): Promise<
  | { sessions: SessionsReport; joined: WorkspaceRef | undefined }
  | { failed: string }
> {
  let sessions: SessionsReport;
  try {
    sessions = await read();
  } catch (error) {
    return { failed: failureText(error) };
  }
  if (!sessions.ok) return { failed: sessions.reason };
  const joined = sessions.workspaces.find((w) => w.prs.includes(pr));
  return {
    sessions,
    joined:
      joined === undefined ? undefined : { id: joined.id, path: joined.path },
  };
}
