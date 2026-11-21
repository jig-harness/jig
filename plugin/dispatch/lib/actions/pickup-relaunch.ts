/**
 * `--apply` for a stalled pickup's relaunch (`pickup-relaunch.ts`): start
 * the pickup again, once, in the workspace that holds its tree, under a
 * launch record of its own that keeps the record it finishes and the head it
 * ran at, with the fixed prompt to push and record the work (`session.ts`).
 * Never a fresh workspace: a fresh tree would not carry the work. Before it
 * starts, it reads again what the plan read:
 *
 * 1. the launch record it finishes is still this repository's, and no
 *    other record holds the item or relaunched it at that head;
 * 2. the workspace is still open, and no session holds it or the item;
 * 3. the tree's head is still the one the plan read;
 *
 * then it admits an account under the pickup's own deadline and starts the
 * record. A lock-wait relaunch, of a pickup whose push the host's test lock
 * held past its wait (`pickup-lock-wait.ts`), is relaunched once per source
 * record rather than once per head, since its head has not moved, and the
 * host's validation capacity holds it whatever `load.enforce` says
 * (`lockWaitGauges`). The tick writes nothing to the tracker: the item is already
 * claimed, and the pass makes no second claim. A pending relaunch whose
 * launch got no answer is retried once under its own record, as a pickup's
 * is.
 */
import { holdingAgain } from "../holding.ts";
import {
  newRecordId,
  newToken,
  type LaunchRecord,
  type ReadRecord,
} from "../launches.ts";
import { readPickupTree, type TreeReader } from "../pickup-tree.ts";
import { dispatched, type SessionsReport } from "../runtime/port.ts";
import { sessionIdFor } from "../session.ts";
import type {
  Action,
  LaunchOutcome,
  PickupRelaunch,
  RepoReport,
  RepoTarget,
  DispatchSection,
} from "../types.ts";
import { admittedVendor, codexLaunchFields } from "../accounts.ts";
import {
  accountBlock,
  admitAccount,
  type ApplyState,
  loadKindOf,
  outOfTime,
  replay,
  replayable,
  startRecord,
  timeLeftMs,
  waits,
} from "./launch.ts";
import { holdsReplay, VALIDATION_GAUGES } from "../load.ts";
import { holdingRecords } from "./pickup-hold.ts";
import { currentIso, currentMs } from "../../../shared/time.ts";

/** What a relaunch needs beyond the apply state. */
export interface RelaunchContext {
  /** The runtime's answer read afresh, for the reads just before a launch. */
  sessions: () => Promise<SessionsReport>;
  /** The pickup's own deadline, in whole seconds. */
  deadlineSec: number;
  /** Reads the tree again; `readPickupTree` unless a test gives another. */
  trees?: TreeReader;
  section: Pick<DispatchSection, "stalledRelaunch">;
  rerunsHeld: string | null;
  /** Why serialization could not be decided this tick: no pending relaunch is replayed then. */
  serialUndecided?: string | null;
  serves: readonly string[];
}

/** Why the relaunch must not start now; `null` when what the plan read still holds. */
async function changed(
  state: ApplyState,
  repo: RepoTarget,
  ctx: RelaunchContext,
  item: string,
  relaunch: PickupRelaunch,
  own?: string,
): Promise<string | null> {
  return (
    recordsChanged(state, repo, ctx, { item, relaunch, own }) ??
    (await runtimeChanged(ctx, item, relaunch.workspace.path)) ??
    treeChanged(state, ctx, relaunch)
  );
}

/** Why the host's rules no longer admit the relaunch; `null` when they still do. */
function rulesChanged(
  ctx: RelaunchContext,
  relaunch: PickupRelaunch,
): string | null {
  if (
    relaunch.dependency === undefined &&
    ctx.section.stalledRelaunch === "never"
  )
    return "dispatch.stalled_relaunch is now never";
  if (ctx.rerunsHeld !== null)
    return `the host health gate is failing: ${ctx.rerunsHeld}`;
  return null;
}

/** Why another relaunch already made this one: of its source for a dependency or a lock wait, at its head otherwise; `null` when none did. */
function relaunchedAlready(
  records: readonly ReadRecord[],
  read: { item: string; relaunch: PickupRelaunch; own: string | undefined },
): string | null {
  const { item, relaunch, own } = read;
  const bySource =
    relaunch.dependency !== undefined || relaunch.lockWait === true;
  const again = records.find(
    (r) =>
      r.record.id !== own &&
      r.record.item === item &&
      r.record.relaunchOf !== undefined &&
      (bySource
        ? r.record.relaunchOf === relaunch.record
        : r.record.relaunchHead === relaunch.head),
  );
  if (again === undefined) return null;
  return relaunch.lockWait === true
    ? `launch record ${again.record.id} already relaunched ${relaunch.record}`
    : `launch record ${again.record.id} already relaunched it at ${relaunch.head}`;
}

/** Why the host's rules or launch records no longer admit the relaunch; `null` when they still do. */
function recordsChanged(
  state: ApplyState,
  repo: RepoTarget,
  ctx: RelaunchContext,
  read: { item: string; relaunch: PickupRelaunch; own: string | undefined },
): string | null {
  const { item, relaunch, own } = read;
  const rules = rulesChanged(ctx, relaunch);
  if (rules !== null) return rules;
  const records = state.records.filter((r) => r.record.repo === repo.slug);
  const source = records.find((r) => r.record.id === relaunch.record);
  if (source === undefined)
    return `the launch record it finishes, ${relaunch.record}, is no longer this host's`;
  const served = source.record.servedPerson;
  if (served !== undefined && !ctx.serves.includes(served))
    return `${served} is no longer served by this host`;
  const again = relaunchedAlready(records, read);
  if (again !== null) return again;
  const other = holdingRecords(item, records).find((r) => r.record.id !== own);
  return other === undefined
    ? null
    : `launch record ${other.record.id} holds the item`;
}

/** Why the runtime no longer leaves the tree's workspace open and free; `null` when it does. */
async function runtimeChanged(
  ctx: RelaunchContext,
  item: string,
  path: string,
): Promise<string | null> {
  const { sessions, held } = await holdingAgain(
    ctx.sessions,
    (w) => w.path === path || w.items.includes(item),
  );
  if (
    sessions?.ok === true &&
    !sessions.workspaces.some((w) => w.path === path)
  )
    return `no open workspace holds its tree ${path} now; a fresh tree would not carry the work`;
  if (held.kind === "unknown") return held.reason;
  if (held.kind === "running")
    return `a session started since the plan read it: ${held.workspaces.map((w) => w.path).join(", ")}`;
  return null;
}

/** Why the tree no longer stands at the head the plan read; `null` when it does. */
function treeChanged(
  state: ApplyState,
  ctx: RelaunchContext,
  relaunch: PickupRelaunch,
): string | null {
  const left = timeLeftMs(state);
  const tree = (ctx.trees ?? readPickupTree)(
    relaunch.workspace.path,
    left === null ? undefined : currentMs() + Math.max(0, left),
  );
  if (tree.kind === "unread") return tree.why;
  return tree.head === relaunch.head
    ? null
    : `its tree moved from ${relaunch.head} to ${tree.head} since the plan read it`;
}

/** The relaunch's record: the pickup it finishes, under a record, token and account of its own. */
function relaunchRecord(
  state: ApplyState,
  source: LaunchRecord,
  relaunch: PickupRelaunch,
  slots: Parameters<typeof startRecord>[2],
): LaunchRecord {
  const vendor = admittedVendor(slots.account);
  const id = newRecordId();
  const record: LaunchRecord = {
    ...source,
    id,
    token: newToken(),
    account: slots.account.name,
    vendor,
    configDir: slots.account.configDir,
    createdAt: currentIso(),
    facts: `${relaunchKind(relaunch)} pickup relaunch of ${source.id} at ${relaunch.head}`,
    workspace: relaunch.workspace,
    replaces: null,
    attempts: [],
    agentId: null,
    released: false,
    noReplay: null,
    command: null,
    marker: null,
    relaunchOf: source.id,
    relaunchHead: relaunch.head,
    sessionId: sessionIdFor(vendor),
    mark: dispatched("pickup", source.item ?? "", id).mark,
  };
  for (const field of [
    "endedAt",
    "cancelledAt",
    "runEndedAt",
    "stewardResume",
    "stewardContext",
    "stewardDecision",
    "answered",
    "relaunchFault",
    "relaunchDependency",
    "relaunchLockWait",
    "testLockWait",
    "releasedItems",
    "codexPassArgs",
  ] as const)
    delete record[field];
  if (relaunch.fault !== undefined) record.relaunchFault = relaunch.fault;
  if (relaunch.dependency !== undefined)
    record.relaunchDependency = relaunch.dependency;
  if (relaunch.lockWait === true) record.relaunchLockWait = true;
  // Admission judged the account by this tick's Codex opt-in, not the source's.
  return { ...record, ...codexLaunchFields(state.codexOptIn) };
}

/** One planned relaunch, through its fresh reads, admission and launch. */
async function relaunchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action & { relaunch: PickupRelaunch },
  ctx: RelaunchContext,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const { relaunch } = action;
  const before = await changed(state, repo, ctx, action.target, relaunch);
  if (before !== null) return waits(action, before);
  const source = state.records.find(
    (r) => r.record.id === relaunch.record,
  )?.record;
  if (source === undefined)
    return waits(action, `launch record ${relaunch.record} is gone`);
  const admitted = await admitAccount(
    state,
    repo.slug,
    action,
    source.passTimeoutSec ?? ctx.deadlineSec,
  );
  if ("outcome" in admitted) return admitted.outcome;
  const after = await changed(state, repo, ctx, action.target, relaunch);
  if (after !== null) return waits(action, after, admitted.slots.account.name);
  const record = relaunchRecord(state, source, relaunch, admitted.slots);
  const started = await startRecord(state, record, admitted.slots);
  const begun = started.outcome === "launched" || started.outcome === "retried";
  return begun
    ? { ...started, detail: relaunchedDetail(source.id, relaunch, started) }
    : started;
}

/** What a begun relaunch says: whose work it finishes, where and to what end. */
function relaunchedDetail(
  id: string,
  relaunch: PickupRelaunch,
  started: { detail: string },
): string {
  const kind = relaunchKind(relaunch);
  const to = {
    stalled: "push and record",
    "host-fault": "resume",
    "lock-wait": "push and go on with",
  }[kind];
  return `the ${kind} pickup ${id} relaunched in its tree ${relaunch.workspace.path} at ${relaunch.head}, to ${to} its work: ${started.detail}`;
}

/** Which relaunch it is: of a stall, a host fault, or a push the host's test lock held. */
function relaunchKind(
  relaunch: PickupRelaunch,
): "stalled" | "host-fault" | "lock-wait" {
  if (relaunch.lockWait === true) return "lock-wait";
  return relaunch.fault === undefined ? "stalled" : "host-fault";
}

/** Why the host's mandatory gauges hold a lock-wait relaunch's replay; `null` when they leave room. */
function lockWaitHold(
  state: ApplyState,
  repo: string,
  action: Action,
  record: LaunchRecord,
): string | null {
  if (state.load === undefined) return null;
  return holdsReplay(
    state.load,
    loadKindOf(action),
    repo,
    action.target,
    (record.passTimeoutSec ?? 0) * 1000,
    VALIDATION_GAUGES,
    true,
  );
}

/** Retry, once and under its own record, each pending relaunch of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: RelaunchContext,
): Promise<void> {
  for (const record of replayable(state, repo.slug, ["pickup"])) {
    // A steward's resume of a relaunch is the steward's to replay.
    if (
      record.relaunchOf === undefined ||
      record.relaunchHead === undefined ||
      record.stewardResume !== undefined ||
      record.workspace === null
    )
      continue;
    const item = record.item as string;
    const relaunch: PickupRelaunch = {
      record: record.relaunchOf,
      workspace: record.workspace,
      head: record.relaunchHead,
      ...(record.relaunchDependency === undefined
        ? {}
        : { dependency: record.relaunchDependency }),
      ...(record.relaunchFault === undefined
        ? {}
        : { fault: record.relaunchFault }),
      ...(record.relaunchLockWait === true ? { lockWait: true as const } : {}),
    };
    let blocked =
      ctx.serialUndecided ??
      (await changed(state, repo, ctx, item, relaunch, record.id)) ??
      (await accountBlock(state, record));
    const action = { target: item, stage: "pickup", relaunch } as Action;
    // A lock-wait relaunch replays only into room the mandatory gauges still show.
    if (blocked === null && relaunch.lockWait === true)
      blocked = lockWaitHold(state, repo.slug, action, record);
    report.launches.push(await replay(state, record, action, blocked));
  }
}

/** `--apply` for one repository's stalled-pickup relaunches. */
export async function applyRelaunches(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  ctx: RelaunchContext,
): Promise<void> {
  await retryPending(state, repo, report, ctx);
  for (const action of report.actions)
    if (action.stage === "pickup" && action.relaunch !== undefined)
      report.launches.push(
        await relaunchOne(
          state,
          repo,
          action as Action & { relaunch: PickupRelaunch },
          ctx,
        ),
      );
}
