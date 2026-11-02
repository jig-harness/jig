/**
 * What every `--apply` launch shares, a drive's pass or an interactive
 * session (a pickup's, a follow-up's):
 * the state carried across a tick's repositories, the account admitted
 * afresh against its walls and the identity check, the launch record
 * written before the runtime's `launch` and the slot it holds, and the
 * outcome each launch reports.
 */
import {
  admitRearm,
  admitTakeover,
  checkIdentity,
  type IdentityCheck,
  refreshWalls,
  type Slots,
  slotsOf,
} from "../accounts.ts";
import {
  holds,
  type LaunchAttempt,
  type LaunchRecord,
  type ReadRecord,
  removeRecord,
  writeRecord,
} from "../launches.ts";
import {
  type MachineConfig,
  OPENS_PER_TICK,
  tickDeadlineMs,
} from "../machine-config.ts";
import type {
  ItemTarget,
  LaunchStage,
  NoticesTarget,
  RuntimeReceipt,
  SessionRuntime,
} from "../runtime/port.ts";
import { PICKUP_SKILL } from "../session.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  LaunchOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";

/** What `--apply` carries across a tick's repositories. */
export interface ApplyState {
  machine: MachineConfig;
  runtime: SessionRuntime;
  /** Every launch record, the ones this tick writes appended. */
  records: ReadRecord[];
  table: Slots[];
  /** The account of the most recent launch record, where the turn resumes. */
  last: string | null;
  /** The workspaces this tick has opened so far, within `OPENS_PER_TICK`. */
  opened?: number;
  /** When the tick began, for its overall deadline. */
  startedAt?: number;
  /** The index of this tick among the applying ticks, which rotates the order of everything that shares the allowance. */
  tick?: number;
  /** How many repositories the tick walks, the radix the stages' and targets' turns count in. */
  repos?: number;
  root?: string;
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

/**
 * Why the tick has no time left to start another launch: the runtime calls
 * of a tick are not bounded by a count, so the deadline its launcher enforces
 * is also checked, less the time its receipt needs. The deadline covers the
 * tick's planning as well, so it is the launcher's, not the smaller budget of
 * its launches. `null` while time remains.
 */
export function outOfTime(state: ApplyState): string | null {
  if (state.startedAt === undefined) return null;
  const allowed =
    enforcedDeadlineMs(state.machine) - state.machine.runtimeTimeoutMs;
  return Date.now() - state.startedAt >= allowed
    ? `this tick has used the ${Math.ceil(allowed / 1000)}s its timer allows; a later tick starts this one`
    : null;
}

/** The stages a repository's tick applies (rearm, pickup, followup), for the targets' radix. */
const STAGES_PER_REPO = 3;

/** The level of the hierarchy a rotation orders; each is a digit of the tick index, the repositories the lowest. */
export type RotationLevel = "repositories" | "stages" | "targets";

/**
 * `items` in this tick's order: rotated by a digit of the tick's own index, a
 * counter that advances once per applying tick whatever the timer's interval.
 * The repositories, the stages within one and the targets within a stage share
 * the tick's allowance of opens, so each level turns once per full turn of
 * the levels above it (the index counted in mixed radix: repositories, then
 * stages, then targets). A repository that leads on every even tick then
 * leads with each of its stages in turn, and an item whose open fails every
 * time cannot keep every later one waiting.
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
        : repos * STAGES_PER_REPO;
  const start = Math.floor(state.tick / divisor) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** A pending record's launch is retried once, under its own key. */
const MAX_ATTEMPTS = 2;

export type Opened =
  | { workspace: { id: string; path: string } }
  | { waits: string }
  | { refused: string };

/**
 * Open a workspace through the runtime, within the tick's budget: a tick
 * opens at most `OPENS_PER_TICK`, one of them kept for the notices workspace, and a launch that needs another waits for
 * the next tick rather than run past the deadline the timer gives it.
 */
export async function openWithinBudget(
  state: ApplyState,
  repo: RepoTarget,
  target: ItemTarget | { pr: number; head: string } | NoticesTarget,
): Promise<Opened> {
  const late = outOfTime(state);
  if (late !== null) return { waits: late };
  const done = state.opened ?? 0;
  // One open is kept for the notices workspace, so a queue of launches never starves the notifications that reach a person.
  const keeps = state.machine.repositories.some((r) =>
    r.stages.includes("notify"),
  );
  const cap =
    "notices" in target || !keeps ? OPENS_PER_TICK : OPENS_PER_TICK - 1;
  if (done >= cap)
    return {
      waits: `this tick has opened the ${cap} workspaces its budget covers${"notices" in target || !keeps ? "" : " for launches (one is kept for notifications)"}; a later tick opens this one`,
    };
  state.opened = done + 1;
  let opened: RuntimeReceipt;
  try {
    opened = await state.runtime.openWorkspace(repo, target);
  } catch (error) {
    return {
      refused: `the workspace could not be opened: ${failureText(error)}`,
    };
  }
  if (opened.ok && opened.workspace !== undefined)
    return { workspace: opened.workspace };
  return {
    refused: `the workspace could not be opened${opened.lost ? " in time" : ""}: ${opened.detail}`,
  };
}

function attemptOf(receipt: RuntimeReceipt): LaunchAttempt {
  return {
    at: new Date().toISOString(),
    outcome: receipt.ok ? "sent" : receipt.lost ? "lost" : "failed",
    detail: receipt.detail,
  };
}

/** What the runtime starts for a record: a drive's headless pass, or a pickup's or a follow-up's interactive session. */
function stageOf(record: LaunchRecord): LaunchStage {
  if (record.action === "pickup")
    return {
      kind: "interactive",
      title: `do-item ${record.item}`,
      record: record.id,
      skill: PICKUP_SKILL,
      target: record.item as string,
      model: record.model,
      effort: record.effort,
    };
  if (record.action === "followup")
    return {
      kind: "interactive",
      title: `follow-up #${record.pr}`,
      record: record.id,
      skill: record.command ?? "",
      target: String(record.pr),
      model: record.model,
      effort: record.effort,
    };
  return {
    kind: "headless",
    title: `drive #${record.pr}`,
    record: record.id,
  };
}

/** Call the runtime's `launch` under the record's token, and keep its answer (and agent id) on the record. */
async function callLaunch(
  state: ApplyState,
  record: LaunchRecord,
): Promise<LaunchAttempt> {
  const workspace = record.workspace as { id: string; path: string };
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

function outcome(
  record: LaunchRecord,
  attempt: LaunchAttempt,
  retried: boolean,
): LaunchOutcome {
  return {
    target: record.item ?? `PR #${record.pr}`,
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
  if (action.stage === "pickup" || action.stage === "followup")
    return action.stage;
  return action.takeover === undefined ? "rearm" : "takeover";
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

/**
 * Report every wanted interactive launch, and start none, when the runtime
 * cannot bind an interactive session to the account it bills; true when it
 * reported them.
 */
export function reportedUnbound(
  state: ApplyState,
  wanted: Action[],
  report: RepoReport,
): boolean {
  const binding = state.runtime.interactiveBinding;
  if (binding.ok) return false;
  for (const action of wanted)
    report.launches.push({
      ...waits(action, binding.reason),
      outcome: "reported",
    });
  return true;
}

function refused(
  action: Action,
  detail: string,
  account: string | null,
): LaunchOutcome {
  return { ...waits(action, detail, account), outcome: "refused" };
}

/** The workspace a launch runs in, or the outcome that ends it: a budget that waits, an open that failed. */
export function workspaceOr(
  action: Action,
  opened: Opened,
  account: string,
): { workspace: { id: string; path: string } } | { outcome: LaunchOutcome } {
  if ("waits" in opened)
    return { outcome: waits(action, opened.waits, account) };
  if ("refused" in opened)
    return { outcome: refused(action, opened.refused, account) };
  return opened;
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
        record.workspace !== null &&
        kinds.includes(record.action) &&
        record.attempts.at(-1)?.outcome !== "sent" &&
        record.attempts.length < MAX_ATTEMPTS,
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
  const late = blocked ?? outOfTime(state);
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

async function identityOf(
  state: ApplyState,
  slots: Slots,
): Promise<IdentityCheck> {
  // Read afresh each time: a login file can change between two launches.
  return checkIdentity(
    slots.account,
    Math.ceil(state.machine.runtimeTimeoutMs / 1000),
  );
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
  if (slots.wallUnrecorded)
    return `${slots.account.name} ended on a wall that was not recorded`;
  if (slots.wall !== null)
    return `${slots.account.name} is walled until ${slots.wall.resetAt}`;
  const identity = await identityOf(state, slots);
  return identity.ok ? null : `identity check: ${identity.reason}`;
}

function admission(
  state: ApplyState,
  action: Action,
  excluded: ReadonlySet<string>,
) {
  if (action.stage === "pickup" || action.stage === "followup")
    return admitRearm(
      state.table,
      state.last,
      excluded,
      `an interactive ${action.stage} session`,
    );
  if (action.takeover === undefined)
    return admitRearm(state.table, state.last, excluded);
  const replaced = state.records.find((r) => r.record.id === action.takeover);
  return replaced === undefined
    ? { waits: `the launch record ${action.takeover} it replaces is gone` }
    : admitTakeover(state.table, replaced);
}

/**
 * The account a launch bills, admitted afresh against the walls and the
 * identity check. A re-arm or a pickup tries the next account when one
 * fails its identity check, so a stale login cannot starve the others; a
 * takeover has only its own account.
 */
export async function admitAccount(
  state: ApplyState,
  action: Action,
): Promise<{ slots: Slots } | { outcome: LaunchOutcome }> {
  refreshWalls(state.table, state.records, Date.now(), state.root);
  const failed = new Set<string>();
  let refusal: LaunchOutcome | null = null;
  for (;;) {
    const admitted = admission(state, action, failed);
    if ("waits" in admitted)
      return { outcome: refusal ?? waits(action, admitted.waits) };
    const slots = admitted.admitted;
    const identity = await identityOf(state, slots);
    if (identity.ok) return { slots };
    const name = slots.account.name;
    refusal ??= refused(action, `identity check: ${identity.reason}`, name);
    if (action.takeover !== undefined) return { outcome: refusal };
    failed.add(name);
  }
}

/** Opening a workspace can outlast the wall or the login the account was admitted under. */
export async function changedWhileOpening(
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

/** Call `launch` under a held record's token; a launch the runtime answered it did not start gives the slot back. */
export async function launchHeld(
  state: ApplyState,
  record: LaunchRecord,
): Promise<LaunchOutcome> {
  const attempt = await callLaunch(state, record);
  if (attempt.outcome === "failed" && releasable(record))
    release(state, record);
  return outcome(record, attempt, false);
}

/**
 * Write the record, hold its slot, then call `launch` under its token; a
 * launch the runtime answered it did not start gives the slot back.
 */
export async function startRecord(
  state: ApplyState,
  record: LaunchRecord,
  slots: Slots,
): Promise<LaunchOutcome> {
  holdRecord(state, record, slots);
  return launchHeld(state, record);
}
