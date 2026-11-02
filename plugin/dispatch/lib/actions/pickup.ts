/**
 * `--apply` for pickups: start a `do-item` session for each item the plan
 * wants picked up, once. A pickup starts only on a runtime that binds an
 * interactive session to the account it bills (`interactiveBinding`); on
 * any other, every pickup is reported with the runtime's reason and nothing
 * is opened, written or launched. Otherwise, for each one:
 *
 * 1. the fresh read: the item still assigned to the factory identity in a
 *    dispatch state, no running session joined to it, no launch record
 *    holding it;
 * 2. admit an account with a free slot and no wall, and check that the
 *    wrapper's environment resolves to that account's identity;
 * 3. the item's workspace: the one joined to it, else a new branch named
 *    by the repository's branch rule with the issue linked;
 * 4. the fresh read again, now that the workspace is open, and the route's
 *    model and effort;
 * 5. write the launch record, then `launch` the session under the record's
 *    token; the record gains the agent's id from the launch's receipt.
 *
 * Before any of that, a pending pickup whose launch got no answer is
 * retried once, under its own record and token, never as a fresh launch.
 * The tick writes nothing to the tracker: `do-item`'s claim does.
 */
import { renderBranchName } from "../../../skills/drive-pr/scripts/lib/pr-policy.ts";
import type { IssueKeys } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { holding } from "../holding.ts";
import { type LaunchRecord, newRecordId, newToken } from "../launches.ts";
import { pickupRoute } from "../route.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { freshPickup } from "../sources/tracker.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  DispatchSection,
  LaunchOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import {
  accountBlocked,
  admitAccount,
  type ApplyState,
  changedWhileOpening,
  type Opened,
  openWithinBudget,
  outOfTime,
  replay,
  reportedUnbound,
  rotated,
  replayable,
  startRecord,
  waits,
  workspaceOr,
} from "./launch.ts";
import { holdingRecords, pickupHold } from "./pickup-hold.ts";

/** What a repository's pickups need beyond the apply state. */
export interface PickupContext {
  section: DispatchSection;
  tracker: Tracker;
  keys: IssueKeys;
  /** `pull_requests.branch_name`. */
  branchPattern: string;
  /** The runtime's answer read afresh, for the read just before a launch. */
  sessions: () => Promise<SessionsReport>;
}

/** Why the item must not be started now; `null` when nothing changed. */
async function changed(
  state: ApplyState,
  repo: RepoTarget,
  ctx: PickupContext,
  key: string,
): Promise<{ issue: PoolIssue } | { why: string }> {
  const issue = await freshPickup(ctx.tracker, ctx.section, key);
  if (typeof issue === "string") return { why: issue };
  // Item keys repeat across repositories: only this repository's records hold it.
  const hold = pickupHold(
    key,
    state.records.filter((r) => r.record.repo === repo.slug),
  );
  if (hold.kind !== "none") return { why: hold.why };
  let sessions: SessionsReport;
  try {
    sessions = await ctx.sessions();
  } catch (error) {
    return { why: `the runtime cannot be read again: ${failureText(error)}` };
  }
  const held = holding(sessions, (w) => w.items.includes(key));
  if (held.kind === "unknown") return { why: held.reason };
  if (held.kind === "running")
    return {
      why: `a session started for it since the plan read it: ${held.workspaces.map((w) => w.path).join(", ")}`,
    };
  return { issue };
}

/** The item's workspace: the one already joined to it, else a new one on its branch. */
async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  ctx: PickupContext,
  issue: PoolIssue,
): Promise<Opened> {
  const sessions = await ctx.sessions().catch(() => null);
  const joined = sessions?.ok
    ? sessions.workspaces.find((w) => w.items.includes(issue.identifier))
    : undefined;
  if (joined !== undefined)
    return { workspace: { id: joined.id, path: joined.path } };
  return openWithinBudget(state, repo, {
    item: issue.identifier,
    branch: renderBranchName(
      ctx.branchPattern,
      ctx.keys.toBranch(issue.identifier),
      issue.title,
    ),
    tracker: ctx.tracker.adapter,
  });
}

/** One planned pickup, through its fresh reads, admission, workspace and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  ctx: PickupContext,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const before = await changed(state, repo, ctx, action.target);
  if ("why" in before) return waits(action, before.why);
  const admitted = await admitAccount(state, action);
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const opened = workspaceOr(
    action,
    await workspaceFor(state, repo, ctx, before.issue),
    slots.account.name,
  );
  if ("outcome" in opened) return opened.outcome;
  const { workspace } = opened;
  const stale = await changedWhileOpening(state, action, slots);
  if (stale !== null) return stale;
  const after = await changed(state, repo, ctx, action.target);
  if ("why" in after) return waits(action, after.why, slots.account.name);
  const beforeRoute = outOfTime(state);
  if (beforeRoute !== null)
    return waits(action, beforeRoute, slots.account.name);
  const route = await pickupRoute(
    after.issue,
    workspace.path,
    Math.ceil(state.machine.runtimeTimeoutMs / 1000),
  );
  // Deriving the route runs a child for up to the runtime timeout.
  const pastDeadline = outOfTime(state);
  if (pastDeadline !== null)
    return waits(action, pastDeadline, slots.account.name);
  const record: LaunchRecord = {
    version: 1,
    id: newRecordId(new Date()),
    token: newToken(),
    action: "pickup",
    repo: repo.slug,
    repoPath: repo.path,
    pr: null,
    item: action.target,
    account: slots.account.name,
    vendor: slots.account.vendor,
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    replaces: null,
    facts: `state ${after.issue.state.name}, assignee ${after.issue.assignee?.name ?? "nobody"}`,
    createdAt: new Date().toISOString(),
    workspace,
    attempts: [],
    agentId: null,
    model: route.model,
    effort: route.effort,
    released: false,
    command: null,
    marker: null,
    sessionId: crypto.randomUUID(),
  };
  const launched = await startRecord(state, record, slots);
  return { ...launched, detail: `${launched.detail}; ${route.detail}` };
}

/**
 * Why a pending pickup must not be replayed: another record holds the item,
 * or a session other than the one in the record's own workspace has joined
 * it. `null` when nothing competes.
 */
async function competing(
  state: ApplyState,
  repo: RepoTarget,
  ctx: PickupContext,
  record: LaunchRecord,
): Promise<string | null> {
  const item = record.item as string;
  const other = holdingRecords(
    item,
    state.records.filter((r) => r.record.repo === repo.slug),
  ).find((r) => r.record.id !== record.id);
  if (other !== undefined)
    return `launch record ${other.record.id} also holds the item`;
  let sessions: SessionsReport;
  try {
    sessions = await ctx.sessions();
  } catch (error) {
    return `the runtime cannot be read again: ${failureText(error)}`;
  }
  const held = holding(sessions, (w) => w.items.includes(item));
  if (held.kind === "unknown") return held.reason;
  const own = record.workspace?.id;
  const rivals =
    held.kind === "running" ? held.workspaces.filter((w) => w.id !== own) : [];
  return rivals.length === 0
    ? null
    : `a session started for it elsewhere since: ${rivals.map((w) => w.path).join(", ")}`;
}

/** Retry, once and under its own key, each pending pickup of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: PickupContext,
): Promise<void> {
  for (const record of replayable(state, repo.slug, ["pickup"])) {
    const item = record.item as string;
    const fresh = await freshPickup(ctx.tracker, ctx.section, item);
    const blocked =
      typeof fresh === "string"
        ? fresh
        : ((await competing(state, repo, ctx, record)) ??
          (await accountBlocked(state, record)));
    const action = { target: item, stage: "pickup" } as Action;
    report.launches.push(await replay(state, record, action, blocked));
  }
}

/** `--apply` for one repository's pickups. */
export async function applyPickups(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: PickupContext,
): Promise<void> {
  const wanted = report.actions.filter((a) => a.stage === "pickup");
  if (reportedUnbound(state, wanted, report)) return;
  await retryPending(state, repo, report, ctx);
  for (const action of rotated(state, wanted, "targets"))
    report.launches.push(await launchOne(state, repo, action, ctx));
}
