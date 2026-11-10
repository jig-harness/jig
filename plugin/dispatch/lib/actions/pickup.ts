/**
 * `--apply` for pickups: start a headless `do-item` pass for each item the
 * plan wants picked up, once. The pass runs through the wrapper a
 * follow-up's pass runs through (`run.ts`), bound to the admitted account
 * by its configuration directory, so it needs no runtime that binds an
 * interactive session. For each one:
 *
 * 1. the fresh read: the item still assigned to the factory identity in a
 *    dispatch state, no running session joined to it, no launch record
 *    holding it;
 * 2. admit an account with a free slot and no wall, as a headless pass
 *    under the pickup's own deadline (`dispatch.pickup_deadline`), and
 *    check that the wrapper's environment resolves to that account's
 *    identity; a Codex account only on a host opted in to its bypass;
 * 3. the item's workspace: the one joined to it, else a new branch named
 *    by the repository's branch rule with the issue linked, the workspace
 *    named for the pickup and the item (`dispatched` in `runtime/port.ts`)
 *    under the launch record's id minted here;
 * 4. the fresh read again, now that the workspace is open, and the route's
 *    model and effort, which the record keeps for the report and the
 *    line: the pass itself keeps the agent's own, and `do-item` forwards
 *    the route to its implementer (`session.ts`);
 * 5. write the launch record, then `launch` the pass under the record's
 *    token.
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
import { batchItemsOf } from "../queue-batch.ts";
import { admittedVendor } from "../accounts.ts";
import { holding } from "../holding.ts";
import { sessionIdFor } from "../session.ts";
import { type LaunchRecord, newRecordId, newToken } from "../launches.ts";
import { pickupRoute } from "../route.ts";
import {
  type Dispatched,
  dispatched,
  type SessionsReport,
} from "../runtime/port.ts";
import { freshServedPickup } from "../sources/served.ts";
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
  type Opened,
  openedFor,
  openWithinBudget,
  outOfTime,
  replay,
  rotated,
  replayable,
  startRecord,
  waits,
} from "./launch.ts";
import { holdingRecords, pickupHold } from "./pickup-hold.ts";

/** What a repository's pickups need beyond the apply state. */
export interface PickupContext {
  servedPolicy?: import("../sources/served.ts").ServedPolicy;
  section: DispatchSection;
  tracker: Tracker;
  keys: IssueKeys;
  /** `pull_requests.branch_name`. */
  branchPattern: string;
  /** The runtime's answer read afresh, for the read just before a launch. */
  sessions: () => Promise<SessionsReport>;
}

/** Why the item must not be started now; `null` when nothing changed. */
export async function changed(
  state: ApplyState,
  repo: RepoTarget,
  ctx: PickupContext,
  key: string,
  served?: { servedPerson?: string; ancestorEpic?: string },
): Promise<{ issue: PoolIssue } | { why: string }> {
  const issue =
    served?.servedPerson === undefined
      ? await freshPickup(ctx.tracker, ctx.section, key)
      : await freshServedPickup(
          ctx.tracker,
          key,
          served.servedPerson,
          served.ancestorEpic,
          ctx.servedPolicy,
        );
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
  named: Dispatched,
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
    dispatched: named,
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
  const batchRead = batchItemsOf(action.evidence.batchItems);
  if (!batchRead.ok) return waits(action, batchRead.failure.reason);
  const batch = batchRead.value;
  const checkBatch = async () => {
    for (const member of batch ?? []) {
      const fresh = await changed(state, repo, ctx, member.key, {
        servedPerson: member.person,
        ...(member.ancestor === undefined
          ? {}
          : { ancestorEpic: member.ancestor }),
      });
      if ("why" in fresh) return `${member.key}: ${fresh.why}`;
    }
    return null;
  };
  const beforeBatch = await checkBatch();
  if (beforeBatch !== null) return waits(action, beforeBatch);
  const served = {
    ...(typeof action.evidence.servedPerson === "string"
      ? { servedPerson: action.evidence.servedPerson }
      : {}),
    ...(typeof action.evidence.ancestorEpic === "string"
      ? { ancestorEpic: action.evidence.ancestorEpic }
      : {}),
  };
  const before = await changed(state, repo, ctx, action.target, served);
  if ("why" in before) return waits(action, before.why);
  const admitted = await admitAccount(
    state,
    repo.slug,
    action,
    deadlineSec(ctx),
  );
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const id = newRecordId(new Date());
  const named = dispatched("pickup", action.target, id);
  const opened = await openedFor(
    state,
    action,
    slots,
    workspaceFor(state, repo, ctx, before.issue, named),
  );
  if ("outcome" in opened) return opened.outcome;
  const { workspace } = opened;
  const after = await changed(state, repo, ctx, action.target, served);
  if ("why" in after) return waits(action, after.why, slots.account.name);
  const afterBatch = await checkBatch();
  if (afterBatch !== null) return waits(action, afterBatch, slots.account.name);
  const beforeRoute = outOfTime(state);
  if (beforeRoute !== null)
    return waits(action, beforeRoute, slots.account.name);
  const vendor = admittedVendor(slots.account);
  const route = await pickupRoute(
    after.issue,
    workspace.path,
    Math.ceil(state.machine.runtimeTimeoutMs / 1000),
    { vendor, configDir: slots.account.configDir },
  );
  // Deriving the route runs a child for up to the runtime timeout.
  const pastDeadline = outOfTime(state);
  if (pastDeadline !== null)
    return waits(action, pastDeadline, slots.account.name);
  const record: LaunchRecord = {
    version: 1,
    id,
    token: newToken(),
    action: "pickup",
    repo: repo.slug,
    repoPath: repo.path,
    pr: null,
    item: action.target,
    account: slots.account.name,
    vendor,
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    passTimeoutSec: deadlineSec(ctx),
    codexBypass: state.codexOptIn.on,
    headless: true,
    ...served,
    ...(batch === undefined ? {} : { batchItems: batch }),
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
    sessionId: sessionIdFor(vendor),
    mark: named.mark,
  };
  const launched = headless(await startRecord(state, record, slots), record);
  return { ...launched, detail: `${launched.detail}; ${route.detail}` };
}

/** The pickup's own deadline, in whole seconds. */
function deadlineSec(ctx: PickupContext): number {
  return Math.ceil(ctx.section.pickupDeadlineMs / 1000);
}

/** A launch's outcome, saying what started: a headless pass, and the account and directory it is bound to. */
function headless(outcome: LaunchOutcome, record: LaunchRecord): LaunchOutcome {
  const started =
    outcome.outcome === "launched" || outcome.outcome === "retried";
  if (!started || record.headless !== true) return outcome;
  return {
    ...outcome,
    detail: `a headless do-item pass bound to account ${record.account} (${record.configDir}) under its ${record.passTimeoutSec}s deadline: ${outcome.detail}`,
  };
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
    const unauthorized = servedAuthorization(state, ctx, record, item);
    const fresh =
      record.servedPerson === undefined
        ? await freshPickup(ctx.tracker, ctx.section, item)
        : await freshServedPickup(
            ctx.tracker,
            item,
            record.servedPerson,
            record.ancestorEpic,
            ctx.servedPolicy,
          );
    const batchBlock = await pendingBatchBlock(state, repo, ctx, record);
    const blocked =
      unauthorized ??
      batchBlock ??
      (typeof fresh === "string"
        ? fresh
        : ((await competing(state, repo, ctx, record)) ??
          (await accountBlocked(state, record))));
    const action = { target: item, stage: "pickup" } as Action;
    report.launches.push(
      headless(await replay(state, record, action, blocked), record),
    );
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
  await retryPending(state, repo, report, ctx);
  for (const action of wanted.some((a) => a.evidence.servedPerson !== undefined)
    ? wanted
    : rotated(state, wanted, "targets"))
    report.launches.push(await launchOne(state, repo, action, ctx));
}

export function servedAuthorization(
  state: ApplyState,
  ctx: PickupContext,
  record: LaunchRecord,
  item: string,
): string | null {
  const members =
    record.batchItems ??
    (record.servedPerson === undefined
      ? []
      : [{ key: item, person: record.servedPerson }]);
  const removed = members.find(
    (m) =>
      !(state.machine.serve ?? []).some(
        (p) =>
          p.tracker[ctx.tracker.adapter as "github" | "linear" | "jira"] ===
          m.person,
      ),
  );
  return removed === undefined
    ? null
    : `${removed.person} is no longer served by this host`;
}

export async function pendingBatchBlock(
  state: ApplyState,
  repo: RepoTarget,
  ctx: PickupContext,
  record: LaunchRecord,
): Promise<string | null> {
  let batchBlock: string | null = null;
  for (const member of record.batchItems ?? []) {
    const check = await freshServedPickup(
      ctx.tracker,
      member.key,
      member.person,
      member.ancestor,
      ctx.servedPolicy,
    );
    batchBlock =
      typeof check === "string"
        ? `${member.key}: ${check}`
        : await competing(state, repo, ctx, { ...record, item: member.key });
    if (batchBlock !== null) break;
  }
  return batchBlock;
}
