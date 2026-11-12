/**
 * `--apply` for follow-ups: one headless pass per merged pull request the
 * plan wants followed up, running the repository's follow-up command
 * (`dispatch.followup_command`) on it, in its workspace. The pass runs
 * through the wrapper a drive's pass runs through (`run.ts`), bound to the
 * admitted account by its configuration directory, so it needs no runtime
 * that binds an interactive session. For each one:
 *
 * 1. the fresh read: still no trusted marker on the pull request, no
 *    running session joined to it;
 * 2. admit an account with a free slot and no wall, as a drive's pass is
 *    admitted (under the pass deadline it runs under), and check that the
 *    wrapper's environment resolves to that account's identity;
 * 3. the pull request's workspace: the one joined to it, else its head
 *    branch opened (a branch the merge deleted is cut from the base) in a
 *    workspace named for the follow-up and the pull request (`dispatched`
 *    in `runtime/port.ts`), under the launch record's id minted here, from
 *    the follow-ups' own lane (`followup-lane.ts`), whose cap and per-tick
 *    budget are checked before the account is admitted;
 * 4. write the launch record, which holds the slot from here on;
 * 5. post the marker naming the record and this host, the follow-up's
 *    shared record (`shared/records/shared.ts`), which reads it back: an
 *    earlier trusted marker wins, and this one is deleted and the record
 *    removed without starting anything; a read-back that fails, or that
 *    never lists the marker, starts nothing either;
 * 6. `launch` the pass under the record's token.
 *
 * Once the launch record ends, this host's next tick writes the follow-up's
 * answer onto the marker (`shared-launches.ts`), where another host reads
 * it. A stale claim the plan names is released first (`release-claims.ts`),
 * and nothing is launched for it in the same tick.
 *
 * A record left pending with its marker posted, by a tick that stopped
 * before the runtime's answer or whose answer was lost, is launched again
 * under the same record, token and marker once the fresh read proves that
 * safe (`retryMarked`); one it disproves is stuck, for a person
 * (`stuck-launches.ts`).
 */
import type {
  ClaimAnswer,
  SharedClaim,
  SharedTarget,
} from "../../../shared/records/shared.ts";
import { localWriter } from "../../../shared/records/writer.ts";
import { carried } from "../station-answer-store.ts";
import { admittedVendor, type Slots } from "../accounts.ts";
import { holding } from "../holding.ts";
import { sessionIdFor } from "../session.ts";
import { readMarkers } from "../followup-marker.ts";
import type { SharedContext } from "../shared-launches.ts";
import {
  type LaunchRecord,
  newRecordId,
  newToken,
  type ReadRecord,
  recordExit,
  writeRecord,
} from "../launches.ts";
import { retryable, stuckAction } from "../stuck-launches.ts";
import {
  type Dispatched,
  dispatched,
  type SessionsReport,
} from "../runtime/port.ts";
import type { Outcome } from "../../../shared/outcome.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  DispatchSection,
  LaunchOutcome,
  MarkedPr,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import {
  accountBlocked,
  admitAccount,
  type ApplyState,
  dropRecord,
  holdRecord,
  launchHeld,
  type Opened,
  openedFor,
  openWithinBudget,
  outOfTime,
  replay,
  rotated,
  waits,
} from "./launch.ts";
import { applyReleases, isRelease } from "./release-claims.ts";
import {
  joinedWorkspace,
  laneBudgetWait,
  laneCapWait,
  type WorkspaceRef,
} from "./followup-lane.ts";

/** What a repository's follow-ups need beyond the apply state. */
export interface FollowupContext {
  section: DispatchSection;
  /** The dispatcher's own login on the forge, whose markers it trusts. */
  login: string | null;
  merged: MarkedPr[];
  /** The runtime's answer read afresh, for the read just before a launch. */
  sessions: () => Promise<SessionsReport>;
  /** Why a person's label stands the dispatcher down from the pull request now, read afresh; `null` when none does, a failure when its labels do not read. */
  holdReason?: (pr: number) => Promise<Outcome<string | null>>;
  /** The shared records the marker is posted and read through. */
  shared: SharedContext;
}

const targetOf = (repo: RepoTarget, pr: number): SharedTarget => ({
  repo: repo.slug,
  pr,
});

function refused(
  action: Action,
  detail: string,
  account: string | null,
): LaunchOutcome {
  return { ...waits(action, detail, account), outcome: "refused" };
}

/** Why a person's label stands the dispatcher down now, or that the labels cannot be read; `null` when neither. */
async function heldNow(
  ctx: FollowupContext,
  pr: number,
): Promise<string | null> {
  if (ctx.holdReason === undefined) return null;
  let hold: Outcome<string | null>;
  try {
    hold = await ctx.holdReason(pr);
  } catch (error) {
    return `its labels cannot be read again: ${failureText(error)}`;
  }
  return hold.ok
    ? hold.value
    : `its labels cannot be read again: ${hold.failure.reason}`;
}

/** Why the follow-up must not be started now; `null` when nothing changed. */
async function changed(
  repo: RepoTarget,
  ctx: FollowupContext,
  pr: number,
): Promise<string | null> {
  const hold = await heldNow(ctx, pr);
  if (hold !== null) return hold;
  const claims = await ctx.shared.records.list(targetOf(repo, pr), "followup");
  if (!claims.ok) return claims.failure.reason;
  const [first] = claims.value.filter((c) => c.trusted);
  if (first !== undefined)
    return `a follow-up marker appeared since the plan read it (comment ${first.id} by ${first.login})`;
  let sessions: SessionsReport;
  try {
    sessions = await ctx.sessions();
  } catch (error) {
    return `the runtime cannot be read again: ${failureText(error)}`;
  }
  const held = holding(sessions, (w) => w.prs.includes(pr));
  if (held.kind === "unknown") return held.reason;
  return held.kind === "running"
    ? `a session started for it since the plan read it: ${held.workspaces.map((w) => w.path).join(", ")}`
    : null;
}

/** The pull request's workspace: the one joined to it, else its head branch opened within the follow-ups' lane. */
async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  pr: MarkedPr,
  named: Dispatched,
  joined: WorkspaceRef | undefined,
): Promise<Opened> {
  if (joined !== undefined) return { workspace: joined };
  return openWithinBudget(
    state,
    repo,
    { pr: pr.number, head: pr.head, purpose: "followup", dispatched: named },
    true,
  );
}

/** Why the follow-ups' lane holds this one back, and on what; `null` when it may go on to admission. */
function laneHolds(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  read: { sessions: SessionsReport; joined: WorkspaceRef | undefined },
): LaunchOutcome | null {
  const { joined } = read;
  const cap = laneCapWait(state, read.sessions, repo.slug);
  if (cap !== null) return { ...waits(action, cap), waitsOn: "lane-cap" };
  // A joined workspace needs no open, so the lane's budget does not hold it.
  const budget = joined === undefined ? laneBudgetWait(state) : null;
  return budget === null
    ? null
    : { ...waits(action, budget), waitsOn: "lane-budget" };
}

/**
 * Post the marker for a held record and read it back: `null` when this
 * record's marker is the earliest trusted one, else why nothing starts.
 * A marker that loses, or whose read-back fails, is deleted and its record
 * removed; one that cannot be deleted ends its record failed, so the next
 * tick reports a failed follow-up for a person to settle.
 */
export async function claim(
  state: ApplyState,
  repo: RepoTarget,
  ctx: FollowupContext,
  record: LaunchRecord & { pr: number },
): Promise<string | null> {
  const claimed = await ctx.shared.records.claim(
    targetOf(repo, record.pr),
    {
      stage: "followup",
      pr: record.pr,
      run: "tick",
      action: "followup",
      record: record.id,
      host: ctx.shared.host,
      owner: ctx.shared.owner,
      writer: localWriter("forge", ctx.login),
    },
    ctx.shared.rule,
  );
  if (!claimed.ok) {
    dropRecord(state, record);
    return `the follow-up marker could not be posted: ${claimed.failure.reason}`;
  }
  const seen = claimed.value;
  if (seen.kind === "held") {
    dropRecord(state, record);
    return `marker comment ${seen.by.id} holds the follow-up`;
  }
  const posted = seen.id;
  record.marker = posted;
  writeRecord(record, state.root);
  if (seen.kind === "holds") return null;
  return relinquish(state, repo, ctx, record, posted, lostWhy(seen, posted));
}

/** Why a posted marker that does not hold the follow-up stands down. */
function lostWhy(seen: ClaimAnswer, posted: number): string {
  if (seen.kind === "unreadable")
    return `the markers could not be read back after posting: ${seen.reason}`;
  if (seen.kind === "missing")
    return `the read-back does not list the posted marker (comment ${posted})`;
  if (seen.kind === "earlier")
    return `an earlier marker (comment ${seen.by.id} by ${seen.by.login}) claimed it first; this one stands down`;
  return `the posted marker (comment ${posted}) no longer names this record`;
}

/**
 * Give a record's posted marker back: the marker is deleted and the record
 * removed, so nothing starts and no slot stays held. A marker that cannot be
 * deleted ends its record failed, so the next tick reports a failed follow-up
 * for a person to settle. Returns why nothing started.
 */
async function relinquish(
  state: ApplyState,
  repo: RepoTarget,
  ctx: FollowupContext,
  record: LaunchRecord,
  posted: number,
  why: string,
): Promise<string> {
  const deleted = await ctx.shared.records.release(
    targetOf(repo, Number(record.pr)),
    posted,
  );
  if (deleted.ok) {
    dropRecord(state, record);
    return why;
  }
  recordExit(
    record.id,
    { at: new Date().toISOString(), code: null, signal: null },
    state.root,
  );
  return `${why}; its own marker (comment ${posted}) could not be deleted (${deleted.failure.reason}), so its record ends failed`;
}

/** The launch record of a follow-up, before it holds its slot. */
function newFollowupRecord(
  state: ApplyState,
  repo: RepoTarget,
  pr: MarkedPr,
  ctx: FollowupContext,
  slots: Slots,
  workspace: { id: string; path: string },
  named: { id: string; mark: string },
  action: Pick<Action, "facts" | "standing">,
): LaunchRecord & { pr: number } {
  return {
    version: 1,
    id: named.id,
    mark: named.mark,
    token: newToken(),
    action: "followup",
    repo: repo.slug,
    repoPath: repo.path,
    pr: pr.number,
    item: null,
    account: slots.account.name,
    vendor: admittedVendor(slots.account),
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    passTimeoutSec: state.passDeadlineSec,
    codexBypass: state.codexOptIn.on,
    replaces: null,
    // A run again of a follow-up that died or stopped on a routine question says so in its facts: a second failure is a person's.
    facts: action.facts ?? `merged ${pr.mergedAt}`,
    createdAt: new Date().toISOString(),
    workspace,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: ctx.section.followupCommand,
    marker: null,
    sessionId: sessionIdFor(admittedVendor(slots.account)),
    routineTags: true,
    ...(action.standing === undefined ? {} : { standing: action.standing }),
    ...carried(repo.slug, `PR #${pr.number}`, named.id),
  };
}

/** One planned follow-up, through its fresh read, admission, workspace, marker and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  ctx: FollowupContext,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const pr = ctx.merged.find((m) => `PR #${m.number}` === action.target);
  if (pr === undefined)
    return waits(action, "the merged pull request is not in this tick's read");
  const before = await changed(repo, ctx, pr.number);
  if (before !== null) return waits(action, before);
  const read = await joinedWorkspace(ctx.sessions, pr.number);
  if ("failed" in read)
    return waits(
      action,
      `the runtime's sessions could not be listed again, so whether a workspace is joined to it cannot be told: ${read.failed}`,
    );
  const held = laneHolds(state, repo, action, read);
  if (held !== null) return held;
  const admitted = await admitAccount(state, repo.slug, action);
  if ("outcome" in admitted) return admitted.outcome;
  const { slots } = admitted;
  const id = newRecordId(new Date());
  const named = dispatched("followup", `#${pr.number}`, id);
  const opened = await openedFor(
    state,
    action,
    slots,
    workspaceFor(state, repo, pr, named, read.joined),
  );
  if ("outcome" in opened) return opened.outcome;
  const after = await changed(repo, ctx, pr.number);
  if (after !== null) return waits(action, after, slots.account.name);
  const record = newFollowupRecord(
    state,
    repo,
    pr,
    ctx,
    slots,
    opened.workspace,
    { id, mark: named.mark },
    action,
  );
  return claimAndLaunch(state, repo, action, ctx, record, slots);
}

/** A launch's outcome, saying what started: a headless pass, and the account and directory it is bound to. */
function headless(outcome: LaunchOutcome, record: LaunchRecord): LaunchOutcome {
  if (outcome.outcome !== "launched" && outcome.outcome !== "retried")
    return outcome;
  return {
    ...outcome,
    detail: `a headless follow-up pass bound to account ${record.account} (${record.configDir}): ${outcome.detail}`,
  };
}

/** Hold the record, claim on the forge, launch: the deadline is checked before the claim and before the launch. */
async function claimAndLaunch(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  ctx: FollowupContext,
  record: LaunchRecord & { pr: number },
  slots: Slots,
): Promise<LaunchOutcome> {
  const name = slots.account.name;
  const before = outOfTime(state);
  if (before !== null) return waits(action, before, name);
  holdRecord(state, record, slots);
  const lost = await claim(state, repo, ctx, record);
  if (lost !== null) return refused(action, lost, name);
  const after = outOfTime(state);
  if (after === null) return headless(await launchHeld(state, record), record);
  // Past the deadline nothing launches: the claim goes back rather than wait on a later tick's replay.
  const gone = await relinquish(
    state,
    repo,
    ctx,
    record,
    record.marker as number,
    after,
  );
  return waits(action, gone, name);
}

/**
 * A follow-up record that holds its slot with no marker and no attempt: a
 * tick died between writing it and recording its marker, so nothing was ever
 * started under it. A marker posted in that interval is on the forge and names
 * the record, so the forge is read first: that marker is given back with the
 * record, and a forge that cannot be read leaves the record for the next tick.
 * Otherwise it would hold an account slot for good.
 */
async function dropUnmarked(
  state: ApplyState,
  repo: RepoTarget,
  ctx: FollowupContext,
): Promise<Set<number>> {
  const unsettled = new Set<number>();
  const unmarked = state.records.filter(
    (r) =>
      r.record.action === "followup" &&
      r.record.stewardResume === undefined &&
      r.record.repo === repo.slug &&
      r.record.marker === null &&
      r.record.attempts.length === 0 &&
      r.state.kind === "pending",
  );
  for (const r of unmarked) {
    const pr = r.record.pr;
    if (pr === null) {
      dropRecord(state, r.record);
      continue;
    }
    const markers = await readMarkers(ctx.shared.records, repo.slug, pr);
    if ("unreadable" in markers) {
      unsettled.add(pr);
      continue;
    }
    const own = markers.find(
      (m) => m.run.kind === "tick" && m.run.record === r.record.id,
    );
    if (own === undefined) dropRecord(state, r.record);
    else
      await relinquish(
        state,
        repo,
        ctx,
        r.record,
        own.id,
        "a marker posted before the record was written down",
      );
  }
  return unsettled;
}

/** Why a marked record's replay waits (`wait`), or can never be proven safe (`never`); `null` when it may go ahead. */
type ReplaySafety = { wait: string } | { never: string } | null;

type Marked = LaunchRecord & { pr: number; marker: number };

/**
 * The fresh read a marked record's replay needs: no hold on the pull
 * request, the record's own marker still the earliest trusted one, naming
 * it and carrying no end, and no session joined to the pull request. A read
 * that fails waits; one that finds otherwise can never prove the replay
 * safe.
 */
async function replaySafety(
  repo: RepoTarget,
  ctx: FollowupContext,
  record: Marked,
): Promise<ReplaySafety> {
  const hold = await heldNow(ctx, record.pr);
  if (hold !== null) return { wait: hold };
  const claims = await ctx.shared.records.list(
    targetOf(repo, record.pr),
    "followup",
  );
  if (!claims.ok) return { wait: claims.failure.reason };
  const lost = markerLost(record, claims.value);
  if (lost !== null) return { never: lost };
  return sessionsFree(ctx, record.pr);
}

/** Why the record's own marker no longer holds its follow-up for it; `null` while it does. */
function markerLost(
  record: Marked,
  claims: readonly SharedClaim[],
): string | null {
  const [first] = claims.filter((c) => c.trusted);
  const own = `its marker (comment ${record.marker})`;
  if (first === undefined) return `${own} is gone from the pull request`;
  if (first.id !== record.marker)
    return `${own} is no longer the earliest trusted one (comment ${first.id} by ${first.login} is)`;
  if (!first.says.ok || first.says.value.record !== record.id)
    return `${own} no longer names this record`;
  return first.says.value.end === null ? null : `${own} already carries an end`;
}

/** Whether no session is joined to the pull request, read afresh. */
async function sessionsFree(
  ctx: FollowupContext,
  pr: number,
): Promise<ReplaySafety> {
  let sessions: SessionsReport;
  try {
    sessions = await ctx.sessions();
  } catch (error) {
    return { wait: `the runtime cannot be read again: ${failureText(error)}` };
  }
  const held = holding(sessions, (w) => w.prs.includes(pr));
  if (held.kind === "unknown") return { wait: held.reason };
  return held.kind === "running"
    ? {
        never: `a session is joined to its pull request: ${held.workspaces.map((w) => w.path).join(", ")}`,
      }
    : null;
}

/** Whether a read record is a pending follow-up of `repo` with its marker posted. */
function isMarkedPending(
  r: ReadRecord,
  repo: RepoTarget,
): r is ReadRecord & { record: Marked } {
  return (
    r.record.action === "followup" &&
    r.record.repo === repo.slug &&
    r.record.pr !== null &&
    r.record.marker !== null &&
    r.state.kind === "pending"
  );
}

/**
 * Replay the launch of each pending follow-up of `repo` whose marker is
 * posted, under its own record, token and marker, once `replaySafety` and
 * the account allow it; the wrapper's claim on the record keeps a launch
 * that did start meanwhile from running twice. One the fresh read can never
 * prove safe is marked so (`noReplay`) and notified in this tick. Returns
 * the pull requests such a record holds, by the record, which no new
 * follow-up starts for.
 */
async function retryMarked(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: FollowupContext,
): Promise<Map<number, string>> {
  const held = new Map<number, string>();
  const marked = state.records.filter((r) => isMarkedPending(r, repo));
  for (const r of marked) {
    const { record } = r;
    held.set(record.pr, record.id);
    if (record.stewardResume !== undefined) continue;
    if (!retryable(record)) continue;
    const action = { target: `PR #${record.pr}`, stage: "followup" } as Action;
    if (ctx.section.followupCommand === null) {
      report.launches.push({
        ...waits(
          action,
          `no dispatch.followup_command: the pending launch of ${record.id} is not replayed while follow-ups are not configured`,
          record.account,
        ),
        record: record.id,
      });
      continue;
    }
    const safety = await replaySafety(repo, ctx, record);
    if (safety !== null && "never" in safety) {
      record.noReplay = safety.never;
      writeRecord(record, state.root);
      report.actions.push(stuckAction(repo.slug, r, safety.never));
      report.launches.push({
        ...refused(
          action,
          `the pending launch of ${record.id} is never replayed: ${safety.never}`,
          record.account,
        ),
        record: record.id,
      });
      continue;
    }
    const blocked = safety?.wait ?? (await accountBlocked(state, record));
    report.launches.push(
      headless(await replay(state, record, action, blocked), record),
    );
  }
  return held;
}

/** `--apply` for one repository's follow-ups. */
export async function applyFollowups(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: FollowupContext,
): Promise<void> {
  await applyReleases(state, repo, report, ctx);
  const wanted = report.actions.filter(
    (a) => a.stage === "followup" && !isRelease(a),
  );
  const unsettled = await dropUnmarked(state, repo, ctx);
  const held = await retryMarked(state, repo, report, ctx);
  for (const action of rotated(state, wanted, "targets")) {
    const pr = Number(action.target.replace(/\D/g, ""));
    const holder = held.get(pr);
    if (unsettled.has(pr))
      report.launches.push(
        waits(
          action,
          "an unmarked record's marker could not be read; it is reconciled first",
        ),
      );
    else if (holder !== undefined)
      report.launches.push(
        waits(action, `launch record ${holder} still holds its follow-up`),
      );
    else report.launches.push(await launchOne(state, repo, action, ctx));
  }
}
