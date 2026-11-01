/**
 * `--apply` for follow-ups: one interactive session per merged pull request
 * the plan wants followed up, running the repository's follow-up command
 * (`dispatch.followup_command`) on it, in its workspace. A follow-up is an
 * interactive session, so it starts only on a runtime that binds one to
 * the account it bills (`interactiveBinding`); on any other every follow-up
 * is reported, and nothing is written, posted or launched. Otherwise, for
 * each one:
 *
 * 1. the fresh read: still no trusted marker on the pull request, no
 *    running session joined to it;
 * 2. admit an account with a free slot and no wall, and check that the
 *    wrapper's environment resolves to that account's identity;
 * 3. the pull request's workspace: the one joined to it, else its head
 *    branch opened (a branch the merge deleted is cut from the base);
 * 4. write the launch record, which holds the slot from here on;
 * 5. post the marker naming the record, then read the markers back: an
 *    earlier trusted marker wins, and this one is deleted and the record
 *    removed without starting anything; a read-back that fails starts
 *    nothing either;
 * 6. `launch` the session under the record's token.
 *
 * The marker is the one thing the dispatcher writes to the forge.
 */
import type { Slots } from "../accounts.ts";
import { holding } from "../holding.ts";
import {
  deleteMarker,
  readBack,
  postMarker,
  readMarkers,
  tickMarker,
  trustedMarkers,
} from "../followup-marker.ts";
import {
  type LaunchRecord,
  newRecordId,
  newToken,
  recordExit,
  writeRecord,
} from "../launches.ts";
import type { SessionsReport } from "../runtime/port.ts";
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
  admitAccount,
  type ApplyState,
  changedWhileOpening,
  dropRecord,
  holdRecord,
  launchHeld,
  type Opened,
  openWithinBudget,
  outOfTime,
  reportedUnbound,
  rotated,
  waits,
  workspaceOr,
} from "./launch.ts";

/** What a repository's follow-ups need beyond the apply state. */
export interface FollowupContext {
  section: DispatchSection;
  /** The dispatcher's own login on the forge, whose markers it trusts. */
  login: string | null;
  merged: MarkedPr[];
  /** The runtime's answer read afresh, for the read just before a launch. */
  sessions: () => Promise<SessionsReport>;
}

function refused(
  action: Action,
  detail: string,
  account: string | null,
): LaunchOutcome {
  return { ...waits(action, detail, account), outcome: "refused" };
}

/** Why the follow-up must not be started now; `null` when nothing changed. */
async function changed(
  repo: RepoTarget,
  ctx: FollowupContext,
  pr: number,
): Promise<string | null> {
  const markers = await readMarkers(repo.slug, pr, ctx.login);
  if ("unreadable" in markers) return markers.unreadable;
  const trusted = trustedMarkers(markers);
  if (trusted.length > 0)
    return `a follow-up marker appeared since the plan read it (comment ${trusted[0]?.id} by ${trusted[0]?.login})`;
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

/** The pull request's workspace: the one joined to it, else its head branch opened. */
async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  ctx: FollowupContext,
  pr: MarkedPr,
): Promise<Opened> {
  const sessions = await ctx.sessions().catch(() => null);
  const joined = sessions?.ok
    ? sessions.workspaces.find((w) => w.prs.includes(pr.number))
    : undefined;
  if (joined !== undefined)
    return { workspace: { id: joined.id, path: joined.path } };
  return openWithinBudget(state, repo, { pr: pr.number, head: pr.head });
}

/**
 * Post the marker for a held record and read it back: `null` when this
 * record's marker is the earliest trusted one, else why nothing starts.
 * A marker that loses, or whose read-back fails, is deleted and its record
 * removed; one that cannot be deleted ends its record failed, so the next
 * tick reports a failed follow-up for a person to settle.
 */
async function claim(
  state: ApplyState,
  repo: RepoTarget,
  ctx: FollowupContext,
  record: LaunchRecord & { pr: number },
): Promise<string | null> {
  const posted = await postMarker(repo.slug, record.pr, tickMarker(record.id));
  if (typeof posted === "string") {
    dropRecord(state, record);
    return `the follow-up marker could not be posted: ${posted}`;
  }
  record.marker = posted;
  writeRecord(record, state.root);
  const seen = readBack(
    await readMarkers(repo.slug, record.pr, ctx.login),
    posted,
  );
  if (seen.kind === "stands") return null;
  const why =
    seen.kind === "unreadable"
      ? `the markers could not be read back after posting: ${seen.reason}`
      : seen.kind === "missing"
        ? `the read-back does not list the posted marker (comment ${posted})`
        : `an earlier marker (comment ${seen.marker.id} by ${seen.marker.login}) claimed it first; this one stands down`;
  const deleted = await deleteMarker(repo.slug, posted);
  if (deleted === "") {
    dropRecord(state, record);
    return why;
  }
  recordExit(
    record.id,
    { at: new Date().toISOString(), code: null, signal: null },
    state.root,
  );
  return `${why}; its own marker (comment ${posted}) could not be deleted (${deleted}), so its record ends failed`;
}

/** The launch record of a follow-up, before it holds its slot. */
function newFollowupRecord(
  state: ApplyState,
  repo: RepoTarget,
  pr: MarkedPr,
  ctx: FollowupContext,
  slots: Slots,
  workspace: { id: string; path: string },
): LaunchRecord & { pr: number } {
  return {
    version: 1,
    id: newRecordId(new Date()),
    token: newToken(),
    action: "followup",
    repo: repo.slug,
    repoPath: repo.path,
    pr: pr.number,
    item: null,
    account: slots.account.name,
    vendor: slots.account.vendor,
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    replaces: null,
    facts: `merged ${pr.mergedAt}`,
    createdAt: new Date().toISOString(),
    workspace,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: ctx.section.followupCommand,
    marker: null,
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
  const admitted = await admitAccount(state, action);
  if ("outcome" in admitted) return admitted.outcome;
  const { slots } = admitted;
  const opened = workspaceOr(
    action,
    await workspaceFor(state, repo, ctx, pr),
    slots.account.name,
  );
  if ("outcome" in opened) return opened.outcome;
  const stale = await changedWhileOpening(state, action, slots);
  if (stale !== null) return stale;
  const after = await changed(repo, ctx, pr.number);
  if (after !== null) return waits(action, after, slots.account.name);
  const record = newFollowupRecord(
    state,
    repo,
    pr,
    ctx,
    slots,
    opened.workspace,
  );
  return claimAndLaunch(state, repo, action, ctx, record, slots);
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
  // The claim stands on the forge: past the deadline the record stays held, and the next tick reconciles it.
  const after = outOfTime(state);
  return after === null
    ? launchHeld(state, record)
    : waits(action, after, name);
}

/**
 * A follow-up record that holds its slot with no marker and no attempt: a
 * tick died between writing it and posting its marker, so nothing was ever
 * started under it. It is removed, or it would hold an account slot for good.
 */
function dropUnmarked(state: ApplyState, repo: RepoTarget): void {
  for (const r of [...state.records])
    if (
      r.record.action === "followup" &&
      r.record.repo === repo.slug &&
      r.record.marker === null &&
      r.record.attempts.length === 0 &&
      r.state.kind === "pending"
    )
      dropRecord(state, r.record);
}

/** `--apply` for one repository's follow-ups. */
export async function applyFollowups(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: FollowupContext,
): Promise<void> {
  const wanted = report.actions.filter((a) => a.stage === "followup");
  if (reportedUnbound(state, wanted, report)) return;
  dropUnmarked(state, repo);
  for (const action of rotated(state, wanted, "targets"))
    report.launches.push(await launchOne(state, repo, action, ctx));
}
