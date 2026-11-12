/**
 * What every `--apply` launch shares, a headless pass (a drive's, a
 * follow-up's, a pickup's):
 * the state carried across a tick's repositories, the account admitted
 * afresh against its walls and the identity check, the launch record
 * written before the runtime's `launch` and the slot it holds, and the
 * outcome each launch reports.
 */
import {
  admitRearm,
  admitTakeover,
  checkIdentity,
  type CodexOptIn,
  hostCodexOptIn,
  type IdentityCheck,
  type NotAdmitted,
  notAdmitted,
  refreshWalls,
  type Slots,
  slotsOf,
} from "../accounts.ts";
import {
  holds,
  isInteractive,
  type LaunchAttempt,
  type LaunchRecord,
  type ReadRecord,
  removeRecord,
  removeRecordIf,
  writeRecord,
} from "../launches.ts";
import {
  type MachineConfig,
  OPENS_PER_TICK,
  tickDeadlineMs,
} from "../machine-config.ts";
import {
  dispatchedMark,
  type ItemTarget,
  type LaunchStage,
  type NoticesTarget,
  type PullRequestTarget,
  type RuntimeReceipt,
  type SessionRuntime,
  tabTitle,
} from "../runtime/port.ts";
import { passTimeoutSeconds } from "../../../skills/drive-pr/scripts/lib/driver/settings.ts";
import { holderRefusal } from "../holder-notices.ts";
import { PICKUP_SKILL } from "../session.ts";
import { retryable } from "../stuck-launches.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  LaneWait,
  BusyHolder,
  LaunchOutcome,
  RepoTarget,
} from "../types.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { laneBudgetWait } from "./followup-lane.ts";
import type { LoadKind } from "../dashboard-contract.ts";
import { judge, type LoadState } from "../load.ts";

/** What `--apply` carries across a tick's repositories. */
export interface ApplyState {
  machine: MachineConfig;
  runtime: SessionRuntime;
  /** Every launch record, the ones this tick writes appended. */
  records: ReadRecord[];
  table: Slots[];
  /** The account of the most recent launch record, where the turn resumes. */
  last: string | null;
  /**
   * The pass deadline every headless pass this tick launches runs under, in
   * seconds (`0` for none): the one the tick reads (`DRIVE_PR_PASS_TIMEOUT`,
   * else the drive's default), written on the launch record and handed to
   * `drive.ts` as `--pass-timeout` (a follow-up pass's wrapper enforces it
   * itself), so the deadline admission judged is the one the pass gets.
   */
  passDeadlineSec: number;
  /**
   * This host's opt-in to Codex's bypass, read once for the tick: admission
   * judges a Codex account by it, and a headless pass's launch record keeps
   * it, so the pass command does what was judged.
   */
  codexOptIn: CodexOptIn;
  /** Each repository's sessions as its observation read them, by slug, for judging another repository's stuck records (`followup-lane.ts`). */
  sessionsOf?: Map<string, SessionsReport>;
  /** The workspaces this tick has opened so far, within `opens_per_tick`. */
  opened?: number;
  /** Opens spent on notices, which do not consume the launches' allowance. */
  noticesOpened?: number;
  /** The follow-up workspaces this tick has opened so far, within `followup_opens_per_tick`, outside `opened` (`followup-lane.ts`). */
  followupOpened?: number;
  /** When the tick began (its invocation, not its act phase), for its overall deadline. */
  startedAt?: number;
  /** The index of this tick among the applying ticks, which rotates the order of everything that shares the allowance. */
  tick?: number;
  /** How many repositories the tick walks, the radix the stages' and targets' turns count in. */
  repos?: number;
  root?: string;
  /** The host's gauges as this tick read them under the act lock, and what its launches have reserved of them (`load.ts`). */
  load?: LoadState;
}

/**
 * The machine file's accounts a drive's pass is never admitted on, for the
 * receipt: a vendor with no documented pass command, or a Codex account
 * while the pass deadline this run reads is `0` or the host has not opted in
 * to its bypass.
 */
export function accountsReport(
  machine: MachineConfig | null,
  apply: ApplyState | null,
): { accountsNotAdmitted?: NotAdmitted[] } {
  if (machine === null) return {};
  const refused = notAdmitted(
    machine.accounts,
    apply?.passDeadlineSec ?? passTimeoutSeconds(),
    apply?.codexOptIn ?? hostCodexOptIn(),
  );
  return refused.length === 0 ? {} : { accountsNotAdmitted: refused };
}

/**
 * The deadline the installed launcher enforces on the tick, in milliseconds:
 * the one it was installed with (`JIG_LAUNCHER_DEADLINE_SEC`, whole seconds,
 * which the launcher passes on to the tick), else the one the machine file's
 * limits calculate for a tick run outside a launcher.
 */
export function enforcedDeadlineMs(
  machine: MachineConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const installed = env.JIG_LAUNCHER_DEADLINE_SEC ?? "";
  return /^[1-9][0-9]*$/.test(installed)
    ? Number(installed) * 1000
    : tickDeadlineMs(machine);
}

/** The kill grace a timed-out child may take beyond its timeout before it settles. */
const KILL_GRACE_MS = 2000;

/** The longest `calls` runtime calls of `timeoutMs` each take to settle: a call rounds up to whole seconds and may spend its kill grace. */
export function settleMs(timeoutMs: number, calls = 1): number {
  return calls * (Math.ceil(timeoutMs / 1000) * 1000 + KILL_GRACE_MS);
}

/** The runtime calls one launch makes after its timeout: the mark, the terminal, the run tab and the agent read-back. */
const LAUNCH_CALLS = 4;

/** What the tick has left of its launcher's deadline, less the time its receipt needs; `null` for a tick that keeps no start. */
export function timeLeftMs(state: ApplyState): number | null {
  if (state.startedAt === undefined) return null;
  const allowed =
    enforcedDeadlineMs(state.machine) - state.machine.runtimeTimeoutMs;
  return allowed - (Date.now() - state.startedAt);
}

/** What the tick has left for reads that still leaves a runtime launch its room; `null` for a tick that keeps no start. */
export function readRoomMs(state: ApplyState): number | null {
  const left = timeLeftMs(state);
  return left === null
    ? null
    : left - settleMs(state.machine.runtimeTimeoutMs, LAUNCH_CALLS);
}

/**
 * Why the tick cannot settle a runtime launch now; `null` when it can. The
 * launch is admitted on its settlement bound, not its timeout, and the
 * receipt's reserve is already out of the time left.
 */
export function launchRoom(state: ApplyState): string | null {
  const left = timeLeftMs(state);
  return left !== null &&
    left < settleMs(state.machine.runtimeTimeoutMs, LAUNCH_CALLS)
    ? "the tick deadline has no room for the launch and its receipt; a later tick retries this one"
    : null;
}

/**
 * Why the tick has no time left to start another launch: the runtime calls
 * of a tick are not bounded by a count, so the deadline its launcher enforces
 * is also checked, less the time its receipt needs. The deadline covers the
 * tick's planning as well, so it is the launcher's, not the smaller budget of
 * its launches. `null` while time remains.
 */
export function outOfTime(state: ApplyState): string | null {
  const left = timeLeftMs(state);
  if (left === null || left > 0) return null;
  const allowed =
    enforcedDeadlineMs(state.machine) - state.machine.runtimeTimeoutMs;
  return `this tick has used the ${Math.ceil(allowed / 1000)}s its timer allows; a later tick starts this one`;
}

/** Two launch groups and two background stages per repository complete a target turn. */
const TARGET_TURN_PER_REPO = 4;

/** The level of the hierarchy a rotation orders; each is a digit of the tick index, the repositories the lowest. */
export type RotationLevel = "repositories" | "stages" | "targets";

/**
 * `items` in this tick's order: rotated by a digit of the tick's own index, a
 * counter that advances once per applying tick whatever the timer's interval.
 * Target order advances after both launch groups and both background stages
 * have led every repository. A failed open at the front of one stage then
 * cannot keep every later target waiting across successive opportunities.
 * The global repository and stage order is applied by `apply-order.ts`.
 */
export function rotated<T>(
  state: ApplyState,
  items: T[],
  level: RotationLevel = "repositories",
): T[] {
  if (items.length < 2 || state.tick === undefined) return items;
  const repos = Math.max(1, state.repos ?? 1);
  const divisor =
    level === "repositories"
      ? 1
      : level === "stages"
        ? repos
        : repos * TARGET_TURN_PER_REPO;
  const start = Math.floor(state.tick / divisor) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export type Opened =
  | { workspace: { id: string; path: string }; cleanupFailure?: string }
  | { waits: string; waitsOn?: LaneWait }
  | { refused: string; holder?: BusyHolder };

/** Total and launch-specific allowances count notices once. */
function openAllowance(state: ApplyState) {
  const done = state.opened ?? 0;
  const keeps = state.machine.repositories.some((r) =>
    r.stages.includes("notify"),
  );
  const budget = state.machine.opensPerTick ?? OPENS_PER_TICK;
  return {
    done,
    keeps,
    budget,
    cap: keeps ? budget - 1 : budget,
    launches: done - (state.noticesOpened ?? 0),
  };
}

/** Why the next workspace open would exhaust this tick's allowance. */
function openBudgetWait(state: ApplyState, notice: boolean): string | null {
  const { done, keeps, budget, cap, launches } = openAllowance(state);
  if (done < budget && (notice || launches < cap)) return null;
  const reservation =
    notice || !keeps ? "" : " for launches (one is kept for notifications)";
  return `this tick has opened the ${notice ? budget : cap} workspaces its per-tick budget covers${reservation}; a later tick opens this one`;
}

/** Why the tick deadline has no room for another open; `null` while it has. */
function openRoomWait(state: ApplyState): string | null {
  if (state.startedAt === undefined) return null;
  const left =
    enforcedDeadlineMs(state.machine) - (Date.now() - state.startedAt);
  const needed =
    state.machine.workspaceTimeoutMs +
    2 * state.machine.runtimeTimeoutMs +
    2 * KILL_GRACE_MS;
  return left < needed
    ? "the tick deadline has no room for the repository lookup, another workspace_timeout and its receipt; a later tick opens this one"
    : null;
}

/** Count one open against its allowance (the follow-ups' lane's, else the launches' or the notices'); why it waits when that allowance is spent. */
function takeOpen(
  state: ApplyState,
  notice: boolean,
  lane: boolean,
): { waits: string; waitsOn?: LaneWait } | null {
  if (lane) {
    const spent = laneBudgetWait(state);
    if (spent !== null) return { waits: spent, waitsOn: "lane-budget" };
    state.followupOpened = (state.followupOpened ?? 0) + 1;
    return null;
  }
  const waiting = openBudgetWait(state, notice);
  if (waiting !== null) return { waits: waiting };
  state.opened = (state.opened ?? 0) + 1;
  if (notice) state.noticesOpened = (state.noticesOpened ?? 0) + 1;
  return null;
}

/**
 * Open a workspace through the runtime, within the tick's budget: a tick
 * opens at most `opens_per_tick` (four by default), one of them kept for the notices workspace, and a launch that needs another waits for
 * the next tick rather than run past the deadline the timer gives it. A
 * follow-up's open (`lane`) is counted against `followup_opens_per_tick`
 * instead, and never against the launches' allowance or the notices'
 * reservation.
 */
export async function openWithinBudget(
  state: ApplyState,
  repo: RepoTarget,
  target: ItemTarget | PullRequestTarget | NoticesTarget,
  lane = false,
  reserveNotice = true,
): Promise<Opened> {
  const late = outOfTime(state) ?? openRoomWait(state);
  if (late !== null) return { waits: late };
  const spent = takeOpen(state, reserveNotice && "notices" in target, lane);
  if (spent !== null) return spent;
  let opened: RuntimeReceipt;
  try {
    opened = await state.runtime.openWorkspace(repo, target);
  } catch (error) {
    return {
      refused: `the workspace could not be opened: ${failureText(error)}`,
    };
  }
  if (opened.ok && opened.workspace !== undefined)
    return {
      workspace: opened.workspace,
      ...(opened.cleanupFailure === undefined
        ? {}
        : { cleanupFailure: opened.cleanupFailure }),
    };
  return {
    refused: `the workspace could not be opened${opened.lost ? " in time" : ""}: ${opened.detail}`,
    ...(opened.busyHolder === undefined ? {} : { holder: opened.busyHolder }),
  };
}

function attemptOf(receipt: RuntimeReceipt): LaunchAttempt {
  return {
    at: new Date().toISOString(),
    outcome: receipt.ok ? "sent" : receipt.lost ? "lost" : "failed",
    detail: receipt.detail,
  };
}

/** What the dispatcher's names call a record's target: the item's key, else `#<pr>`. */
function nameKey(
  record: Pick<LaunchRecord, "item" | "pr"> &
    Partial<Pick<LaunchRecord, "action">>,
): string {
  if (record.action === "steward") return "line";
  return record.item ?? `#${String(record.pr)}`;
}

/** The mark a record carries: the one it was written with, else the convention's for it. */
function markOf(record: LaunchRecord): string {
  return (
    record.mark ?? dispatchedMark(record.action, nameKey(record), record.id)
  );
}

/** What the runtime starts for a record: a headless pass (a drive's, a follow-up's, a pickup's), or an interactive pickup an earlier release recorded, which a runtime that cannot bind one refuses. */
function stageOf(record: LaunchRecord): LaunchStage {
  const named = {
    title: tabTitle(record.action, nameKey(record)),
    mark: markOf(record),
  };
  if (isInteractive(record))
    return {
      kind: "interactive",
      ...named,
      record: record.id,
      skill: PICKUP_SKILL,
      target: record.item as string,
      model: record.model,
      effort: record.effort,
    };
  return { kind: "headless", ...named, record: record.id };
}

/** Call the runtime's `launch` under the record's token, and keep its answer (and agent id) on the record. */
async function callLaunch(
  state: ApplyState,
  record: LaunchRecord,
): Promise<LaunchAttempt> {
  const workspace = record.workspace as { id: string; path: string };
  // A record an older plugin wrote has no mark; the launch marks its workspace, so the record keeps the same one.
  record.mark = markOf(record);
  record.launchCalled = true;
  // Persist before the runtime is called: a tick that dies awaiting its answer must still find what this launch acts on (a replay's change history included).
  writeRecord(record, state.root);
  let receipt: RuntimeReceipt;
  try {
    receipt = await state.runtime.launch(
      workspace,
      stageOf(record),
      record.account,
      record.token,
      record.sessionId ?? undefined,
    );
  } catch (error) {
    receipt = { ok: false, lost: true, detail: failureText(error) };
  }
  const attempt = attemptOf(receipt);
  record.attempts.push(attempt);
  if (receipt.agentId !== undefined) record.agentId = receipt.agentId;
  writeRecord(record, state.root);
  return attempt;
}

/** Whether a takeover shares the slot of the record it replaces, which still holds it. */
function sharesSlot(state: ApplyState, record: LaunchRecord): boolean {
  const replaced = state.records.find((r) => r.record.id === record.replaces);
  return replaced !== undefined && holds(replaced.state);
}

/**
 * Whether every launch before the latest one is a known failure. An earlier
 * attempt whose answer was lost may still have started the wrapper, so a
 * record carrying one is kept until its claim or exit settles it.
 */
function releasable(record: LaunchRecord): boolean {
  return record.attempts.slice(0, -1).every((a) => a.outcome === "failed");
}

/** Release the slot of a record the runtime answered it started nothing for. */
function release(state: ApplyState, record: LaunchRecord): void {
  removeRecord(record.id, state.root);
  state.records = state.records.filter((r) => r.record.id !== record.id);
  const slots = slotsOf(state.table, record);
  if (slots !== undefined && !sharesSlot(state, record)) slots.held -= 1;
}

/** What a record acts on, as a launch's outcome names it. */
function targetOfRecord(record: LaunchRecord): string {
  if (record.action === "steward") return "the steward";
  return record.item ?? `PR #${record.pr}`;
}

function outcome(
  record: LaunchRecord,
  attempt: LaunchAttempt,
  retried: boolean,
): LaunchOutcome {
  return {
    target: targetOfRecord(record),
    action: record.action,
    outcome:
      attempt.outcome === "sent"
        ? retried
          ? "retried"
          : "launched"
        : attempt.outcome,
    account: record.account,
    record: record.id,
    detail: attempt.detail,
  };
}

/** The launch an action asks for. */
function kindOf(action: Action): LaunchOutcome["action"] {
  if (action.stage === "steward") return "steward";
  if (action.stage === "pickup" || action.stage === "followup")
    return action.stage;
  return isTakeover(action) ? "takeover" : "rearm";
}

/** Whether a drive's action takes over a driver: one this host's record started, one another host's claim did, or one no launch started whose run this host shows ended or whose holder this clone's doctor reads dead or wedged. */
export function isTakeover(action: Action): boolean {
  return (
    action.takeover !== undefined ||
    action.takeoverClaim !== undefined ||
    action.takeoverHolder !== undefined ||
    action.takeoverGone !== undefined
  );
}

export function waits(
  action: Action,
  detail: string,
  account: string | null = null,
): LaunchOutcome {
  return {
    target: action.target,
    action: kindOf(action),
    outcome: "waits",
    account,
    record: null,
    detail,
  };
}

function refused(
  action: Action,
  detail: string,
  account: string | null,
): LaunchOutcome {
  return { ...waits(action, detail, account), outcome: "refused" };
}

/** The workspace a launch runs in, or the outcome that ends it: a budget that waits, an open that failed. */
function workspaceOr(
  action: Action,
  opened: Opened,
  account: string,
): { workspace: { id: string; path: string } } | { outcome: LaunchOutcome } {
  if ("waits" in opened)
    return {
      outcome: {
        ...waits(action, opened.waits, account),
        ...(opened.waitsOn === undefined ? {} : { waitsOn: opened.waitsOn }),
      },
    };
  if ("refused" in opened)
    return {
      outcome:
        opened.holder === undefined
          ? refused(action, opened.refused, account)
          : {
              ...refused(action, holderRefusal(opened.holder), account),
              holder: opened.holder,
            },
    };
  return opened;
}

/**
 * The workspace a launch runs in once `opening` settles, with the admitted
 * account checked again after it, since an open can outlast the account's
 * wall or login; or the outcome that ends the launch.
 */
export async function openedFor(
  state: ApplyState,
  action: Action,
  slots: Slots,
  opening: Promise<Opened>,
): Promise<
  { workspace: { id: string; path: string } } | { outcome: LaunchOutcome }
> {
  const opened = workspaceOr(action, await opening, slots.account.name);
  if ("outcome" in opened) return opened;
  const stale = await changedWhileOpening(state, action, slots);
  return stale === null ? opened : { outcome: stale };
}

/** The pending records of `repo` whose launch got no answer and may be replayed once, of the actions `kinds` names. */
export function replayable(
  state: ApplyState,
  repo: string,
  kinds: ReadonlyArray<LaunchRecord["action"]>,
): LaunchRecord[] {
  return state.records
    .filter(
      ({ record, state: s }) =>
        record.repo === repo &&
        s.kind === "pending" &&
        kinds.includes(record.action) &&
        retryable(record),
    )
    .map((r) => r.record);
}

/** Replay a pending record's launch under its own record and key, unless `blocked` says why not. */
export async function replay(
  state: ApplyState,
  record: LaunchRecord,
  action: Action,
  blocked: string | null,
): Promise<LaunchOutcome> {
  const late = blocked ?? outOfTime(state) ?? launchRoom(state);
  if (late !== null)
    return waits(
      action,
      `the pending launch of ${record.id} is not replayed: ${late}`,
      record.account,
    );
  const attempt = await callLaunch(state, record);
  if (attempt.outcome === "failed" && releasable(record))
    release(state, record);
  return outcome(record, attempt, true);
}

/** An identity check's answer, or that the tick has no time for one: a deferral, not a verdict on the account. */
type IdentityAnswer = IdentityCheck | { waits: string };

async function identityOf(
  state: ApplyState,
  slots: Slots,
): Promise<IdentityAnswer> {
  // Every identity check, including the one after an open, must leave the receipt's reserve intact,
  // and a resolver that must be killed takes its grace beyond the timeout.
  const timeoutSec = Math.ceil(state.machine.runtimeTimeoutMs / 1000);
  const left = timeLeftMs(state);
  if (left !== null && left < settleMs(state.machine.runtimeTimeoutMs))
    return {
      waits:
        "the tick deadline has no room for the identity check and its receipt; a later tick retries this one",
    };
  // Read afresh each time: a login file can change between two launches.
  return checkIdentity(slots.account, timeoutSec);
}

/** Why the account a pending record names cannot take its replayed launch now; `null` when it can. */
export async function accountBlocked(
  state: ApplyState,
  record: LaunchRecord,
): Promise<string | null> {
  refreshWalls(state.table, state.records, Date.now(), state.root);
  const slots = slotsOf(state.table, record);
  if (slots === undefined)
    return `${record.account} is no longer in the machine file`;
  if (
    slots.account.vendor !== record.vendor ||
    slots.account.configDir !== record.configDir
  )
    return `${slots.account.name} no longer has the vendor and directory the launch was recorded with`;
  if (record.vendor === "codex" && !state.codexOptIn.on)
    return `${slots.account.name}: ${state.codexOptIn.why}`;
  if (slots.wallUnrecorded)
    return `${slots.account.name} ended on a wall that was not recorded`;
  if (slots.wall !== null)
    return `${slots.account.name} is walled until ${slots.wall.resetAt}`;
  const identity = await identityOf(state, slots);
  if ("waits" in identity) return identity.waits;
  return identity.ok ? null : `identity check: ${identity.reason}`;
}

function admission(
  state: ApplyState,
  action: Action,
  excluded: ReadonlySet<string>,
  pickupDeadlineSec: number,
) {
  const codex = state.codexOptIn;
  // A pickup is a headless pass under its own deadline (`dispatch.pickup_deadline`).
  if (action.stage === "pickup" || action.stage === "steward")
    return admitRearm(
      state.table,
      state.last,
      { kind: "pass", deadlineSec: pickupDeadlineSec, codex },
      excluded,
    );
  // A follow-up is a headless pass, admitted as a drive's pass is: under the pass deadline it runs under.
  if (action.takeover === undefined)
    return admitRearm(
      state.table,
      state.last,
      { kind: "pass", deadlineSec: state.passDeadlineSec, codex },
      excluded,
    );
  const replaced = state.records.find((r) => r.record.id === action.takeover);
  return replaced === undefined
    ? { waits: `the launch record ${action.takeover} it replaces is gone` }
    : admitTakeover(state.table, replaced, state.passDeadlineSec, codex);
}

/** The kind of launch whose reservation an action counts. */
function loadKindOf(action: Action): LoadKind {
  if (action.stage === "steward") return "steward";
  if (action.stage === "pickup" || action.stage === "followup")
    return action.stage;
  return "drive";
}

/** The admitted account, unless the host's load holds the launch. */
function byLoad(
  state: ApplyState,
  repo: string,
  action: Action,
  slots: Slots,
): { slots: Slots } | { outcome: LaunchOutcome } {
  if (state.load === undefined) return { slots };
  const held = judge(state.load, loadKindOf(action), repo, action.target);
  return held === null
    ? { slots }
    : { outcome: waits(action, held, slots.account.name) };
}

/**
 * The account a launch bills, admitted afresh against the walls and the
 * identity check, then against the host's load (`load.ts`): under
 * `load.enforce` a launch a gauge refuses waits, and otherwise it starts and
 * is reported as one the load factor would hold. A re-arm or a pickup tries the next account when one
 * fails its identity check, so a stale login cannot starve the others; a
 * takeover has only its own account. A pickup is admitted as a headless
 * pass under `pickupDeadlineSec`, the repository's `dispatch.pickup_deadline`.
 */
export async function admitAccount(
  state: ApplyState,
  repo: string,
  action: Action,
  pickupDeadlineSec = 0,
): Promise<{ slots: Slots } | { outcome: LaunchOutcome }> {
  refreshWalls(state.table, state.records, Date.now(), state.root);
  const failed = new Set<string>();
  let refusal: LaunchOutcome | null = null;
  for (;;) {
    const admitted = admission(state, action, failed, pickupDeadlineSec);
    if ("waits" in admitted)
      return {
        outcome: refusal ?? {
          ...waits(action, admitted.waits),
          // A follow-up says what it waits on: here, the accounts.
          ...(action.stage === "followup" ? { waitsOn: "accounts" } : {}),
        },
      };
    const slots = admitted.admitted;
    const identity = await identityOf(state, slots);
    if ("waits" in identity)
      return { outcome: waits(action, identity.waits, slots.account.name) };
    if (identity.ok) return byLoad(state, repo, action, slots);
    const name = slots.account.name;
    refusal ??= refused(action, `identity check: ${identity.reason}`, name);
    if (action.takeover !== undefined) return { outcome: refusal };
    failed.add(name);
  }
}

/** Opening a workspace can outlast the wall or the login the account was admitted under. */
async function changedWhileOpening(
  state: ApplyState,
  action: Action,
  slots: Slots,
): Promise<LaunchOutcome | null> {
  refreshWalls(state.table, state.records, Date.now(), state.root);
  const name = slots.account.name;
  if (slots.wallUnrecorded)
    return waits(
      action,
      `${name} ended on a wall that was not recorded while the workspace opened`,
      name,
    );
  if (slots.wall !== null)
    return waits(
      action,
      `${name} was walled until ${slots.wall.resetAt} while the workspace opened`,
      name,
    );
  const after = await identityOf(state, slots);
  if ("waits" in after) return waits(action, after.waits, name);
  // The launch that follows is a runtime call of its own.
  const late = after.ok ? launchRoom(state) : null;
  if (late !== null) return waits(action, late, name);
  return after.ok
    ? null
    : refused(
        action,
        `identity check after the workspace opened: ${after.reason}`,
        name,
      );
}

/**
 * Write the record and hold its slot, before anything that acts for it:
 * from here on the record holds its stage and its account's slot.
 */
export function holdRecord(
  state: ApplyState,
  record: LaunchRecord,
  slots: Slots,
): void {
  writeRecord(record, state.root);
  if (!sharesSlot(state, record)) slots.held += 1;
  state.records.push({ record, state: { kind: "pending" }, result: null });
  state.last = slots.account.name;
}

/** Give back the slot and remove the record of a held launch that is not going ahead. */
export function dropRecord(state: ApplyState, record: LaunchRecord): void {
  release(state, record);
}

/**
 * Give a pending record back only while its row still reads as pending: a
 * wrapper that claimed it, or an exit written, since leaves it in place.
 * Returns whether it was given back.
 */
export function dropPendingRecord(
  state: ApplyState,
  record: LaunchRecord,
): boolean {
  if (!removeRecordIf(record.id, { claim: null, exit: null }, state.root, true))
    return false;
  state.records = state.records.filter((r) => r.record.id !== record.id);
  const slots = slotsOf(state.table, record);
  if (slots !== undefined && !sharesSlot(state, record)) slots.held -= 1;
  return true;
}

/** Call `launch` under a held record's token; a launch the runtime answered it did not start gives the slot back. */
export async function launchHeld(
  state: ApplyState,
  record: LaunchRecord,
): Promise<LaunchOutcome> {
  // The claim and every wait before this point may have spent the time admitted for the launch.
  const late = launchRoom(state);
  if (late !== null) {
    release(state, record);
    return {
      target: targetOfRecord(record),
      action: record.action,
      outcome: "waits",
      account: record.account,
      record: null,
      detail: late,
    };
  }
  const attempt = await callLaunch(state, record);
  if (attempt.outcome === "failed" && releasable(record))
    release(state, record);
  return outcome(record, attempt, false);
}

/**
 * How a launch claims its stage where another host reads it
 * (`shared-launches.ts`): the claim, or why it was refused; and its release
 * when the launch starts nothing.
 */
export interface LaunchClaimer {
  /** `replay` claims a record already made once; `uncertain` marks a refusal that is no other claim's standing (a read that failed), which gives nothing back. */
  claim(
    record: LaunchRecord,
    replay?: boolean,
  ): Promise<{ claim: number } | { refused: string; uncertain?: boolean }>;
  release(record: LaunchRecord, claim: number): Promise<void>;
}

/**
 * Write the record, hold its slot, claim the launch through `claimer` where
 * one is given, then call `launch` under its token. A claim refused, or a
 * launch the runtime answered it did not start, gives the slot back, and
 * the claim with it.
 */
export async function startRecord(
  state: ApplyState,
  record: LaunchRecord,
  slots: Slots,
  claimer?: LaunchClaimer,
): Promise<LaunchOutcome> {
  holdRecord(state, record, slots);
  const taken = claimer === undefined ? null : await claimer.claim(record);
  if (taken !== null && "refused" in taken) {
    if (record.cancelledAt !== undefined) dropPendingRecord(state, record);
    else dropRecord(state, record);
    return {
      target: targetOfRecord(record),
      action: record.action,
      outcome: "refused",
      account: record.account,
      record: null,
      detail: taken.refused,
    };
  }
  const launched = await launchHeld(state, record);
  const gone = !state.records.some((r) => r.record.id === record.id);
  if (taken !== null && gone) await claimer?.release(record, taken.claim);
  return launched;
}
