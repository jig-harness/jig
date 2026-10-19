import {
  liveOrUnknownTargets,
  partitionProcessTree,
  trackPartitionUncertainty,
  trackUnknownDescendants,
} from "./process-uncertainty.ts";
import {
  processRegistryRoots,
  processIdentityCompleted,
  processIdentityUnwitnessed,
  processRegistrySnapshot,
} from "./process-registry.ts";
import { processTable, type ProcessRow } from "./process-table.ts";

type Table = () => Promise<ProcessRow[] | null>;
/** Capture descendants while their parent links still exist. Unreadable means unknown. */
export async function captureProcessTree(
  pid: number,
  table: Table = processTable,
): Promise<ProcessRow[] | null> {
  const rows = await table();
  if (rows === null) return null;
  const root = rows.find((row) => row.pid === pid);
  if (!root) return null;
  const captured = partitionProcessTree(root.pid, rows);
  return captured.uncertain.length > 0 ? null : captured.targets;
}

/** A reused pid belongs to somebody else; unreadable identity never authorizes a kill. */
export async function signalIdentityTargets(
  targets: readonly Pick<ProcessRow, "pid" | "start">[],
  signal: NodeJS.Signals,
  deps: ProcessTreeControl = {},
): Promise<boolean> {
  const context = operation(deps);
  let readable = true;
  for (const target of [...targets].reverse()) {
    if (context.remaining() === 0) return false;
    if (
      !(await signalIdentityTarget(
        target,
        signal,
        context.snapshot,
        (pid, signal) => {
          const result = context.kill(pid, signal);
          deps.onKilled?.(target);
          return result;
        },
      ))
    )
      readable = false;
  }
  return readable;
}

async function signalIdentityTarget(
  target: Pick<ProcessRow, "pid" | "start">,
  signal: NodeJS.Signals,
  table: Table,
  kill: (pid: number, signal: NodeJS.Signals) => unknown,
): Promise<boolean> {
  const rows = await table();
  if (rows === null || target.start === "") return false;
  const current = rows.find((row) => row.pid === target.pid);
  if (current?.start === "") return false;
  if (!current || current.start !== target.start) return true;
  try {
    kill(target.pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Confirm each captured identity disappeared; command success alone proves nothing. */
export async function identityTargetsGone(
  targets: readonly Pick<ProcessRow, "pid" | "start">[],
  table: Table = processTable,
): Promise<boolean> {
  const rows = await table();
  return (
    rows !== null &&
    targets.every((target) => target.start !== "") &&
    targets.every(
      (target) =>
        !rows.some(
          (row) =>
            row.pid === target.pid &&
            !row.stat.startsWith("Z") &&
            (row.start === "" || row.start === target.start),
        ),
    )
  );
}

/** Registered runners remain owned after their launcher leaves the parent's tree. */
export async function captureRegisteredProcessTrees(
  registryDir: string,
  table: Table = processTable,
): Promise<ProcessRow[] | null> {
  const roots = processRegistryRoots(registryDir);
  if (roots === null) return null;
  if (roots.length === 0) return [];
  const captured = await registeredTrees(roots, table);
  return captured.complete ? captured.targets : null;
}

async function registeredTrees(
  roots: NonNullable<ReturnType<typeof processRegistryRoots>>,
  table: Table,
  forced = new Set<string>(),
  uncertain = new Set<string>(),
  unknown = new Set<number>(),
): Promise<{ targets: ProcessRow[]; complete: boolean }> {
  const rows = await table();
  if (rows === null) {
    for (const root of roots) uncertain.add(`${root.pid}:${root.start}`);
    return { targets: [], complete: false };
  }
  trackUnknownDescendants([], rows, unknown);
  const targets: ProcessRow[] = [];
  let complete = true;
  for (const root of roots) {
    const captured = registeredRoot(root, rows, forced, uncertain, unknown);
    if (!captured.complete) complete = false;
    mergeTargets(targets, captured.targets);
  }
  return { targets, complete: complete && unknown.size === 0 };
}

function registeredRoot(
  root: NonNullable<ReturnType<typeof processRegistryRoots>>[number],
  rows: ProcessRow[],
  forced: Set<string>,
  uncertain: Set<string>,
  unknown: Set<number>,
): { targets: ProcessRow[]; complete: boolean } {
  const key = `${root.pid}:${root.start}`;
  const failedWitness = processIdentityUnwitnessed(root);
  const current = rows.find((row) => row.pid === root.pid);
  if (current?.start === "") {
    trackPartitionUncertainty(
      partitionProcessTree(root.pid, rows),
      rows,
      unknown,
    );
    uncertain.add(key);
    return { targets: [], complete: false };
  }
  if (!current || current.start !== root.start) {
    const observed = !uncertain.has(key) && forced.has(key);
    return {
      targets: [],
      complete: !failedWitness && (observed || processIdentityCompleted(root)),
    };
  }
  const captured = partitionProcessTree(current.pid, rows);
  trackPartitionUncertainty(captured, rows, unknown);
  const complete = !failedWitness && captured.uncertain.length === 0;
  if (complete) uncertain.delete(key);
  else uncertain.add(key);
  return { targets: captured.targets, complete };
}

function mergeTargets(targets: ProcessRow[], incoming: ProcessRow[]): void {
  for (const row of incoming) {
    if (
      !targets.some(
        (target) => target.pid === row.pid && target.start === row.start,
      )
    )
      targets.push(row);
  }
}

/** Captured identities remain owned even after their leader leaves the process table. */
export interface WindowsTreeState {
  root: Pick<ProcessRow, "pid" | "start"> | null;
  targets: ProcessRow[];
  complete?: boolean;
  uncertainRegistered?: Set<string>;
  unknownDescendants?: Set<number>;
  forcedIdentities?: Set<string>;
}

export interface ProcessTreeControl {
  table?: (timeoutSec?: number) => Promise<ProcessRow[] | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  registryRoots?: typeof processRegistryRoots;
  registrySnapshot?: typeof processRegistrySnapshot;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  deadline?: number;
  timeoutMs?: number;
  state?: WindowsTreeState;
  killOwned?: () => void;
  onKilled?: (target: Pick<ProcessRow, "pid" | "start">) => void;
}

/** One deadline covers enumeration, identity checks, forced termination and its witness. */
function operation(control: ProcessTreeControl = {}) {
  const now = control.now ?? Date.now;
  const deadline = control.deadline ?? now() + (control.timeoutMs ?? 30_000);
  const remaining = () => Math.max(0, deadline - now());
  const table = control.table ?? processTable;
  const snapshot = async (): Promise<ProcessRow[] | null> => {
    const left = remaining();
    if (left === 0) return null;
    const rows = await table(Math.min(5, left / 1000));
    return remaining() > 0 ? rows : null;
  };
  const pause = async (ms: number): Promise<void> => {
    const wait = Math.min(ms, remaining());
    if (wait === 0) return;
    await (
      control.pause ??
      ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
    )(wait);
  };
  return {
    now,
    deadline,
    remaining,
    snapshot,
    pause,
    kill: control.kill ?? process.kill.bind(process),
    registry:
      control.registrySnapshot ??
      ((dir: string) => {
        if (!control.registryRoots) return processRegistrySnapshot(dir);
        const roots = control.registryRoots(dir);
        return { roots: roots ?? [], complete: roots !== null };
      }),
  };
}
type Operation = ReturnType<typeof operation>;

async function captureRootOnce(
  pid: number,
  state: WindowsTreeState,
  owned: () => boolean,
  context: Operation,
): Promise<void> {
  if (!owned()) return;
  const rows = await context.snapshot();
  if (rows === null) {
    state.complete = false;
    return;
  }
  const current = rows.find((row) => row.pid === pid);
  if (!current?.start) {
    state.unknownDescendants ??= new Set();
    const captured = partitionProcessTree(pid, rows);
    trackPartitionUncertainty(captured, rows, state.unknownDescendants);
    state.complete = false;
    return;
  }
  if (state.root === null) {
    // The first binding requires a still-owned OS child handle. A later snapshot
    // may arrive after exit: its established creation identity remains usable.
    if (!owned()) return;
    state.root = { pid, start: current.start };
  }
  if (current.start !== state.root.start) {
    state.complete = false;
    return;
  }
  const captured = partitionProcessTree(current.pid, rows);
  state.unknownDescendants ??= new Set();
  trackPartitionUncertainty(captured, rows, state.unknownDescendants);
  state.complete = captured.uncertain.length === 0;
  mergeTargets(state.targets, captured.targets);
}

async function captureRoot(
  pid: number,
  state: WindowsTreeState,
  owned: () => boolean,
  context: Operation,
): Promise<void> {
  for (let attempt = 0; attempt < 3 && context.remaining() > 0; attempt++) {
    await captureRootOnce(pid, state, owned, context);
    if (state.root !== null || !owned()) return;
    if (attempt < 2) await context.pause(100);
  }
}

async function captureRegistry(
  dir: string | undefined,
  state: WindowsTreeState,
  context: Operation,
): Promise<boolean> {
  if (!dir) return true;
  const { roots, complete } = context.registry(dir);
  if (roots.length === 0 && !state.unknownDescendants?.size) return complete;
  state.uncertainRegistered ??= new Set();
  state.unknownDescendants ??= new Set();
  state.forcedIdentities ??= new Set();
  const captured = await registeredTrees(
    roots,
    context.snapshot,
    state.forcedIdentities,
    state.uncertainRegistered,
    state.unknownDescendants,
  );
  mergeTargets(state.targets, captured.targets);
  return complete && captured.complete;
}

/** Preserve partial ownership while reporting unreadable registrations separately. */
export async function captureRegisteredTreeSnapshot(
  dir: string,
  control: ProcessTreeControl = {},
): Promise<{ targets: ProcessRow[]; complete: boolean }> {
  const state = control.state ?? { root: null, targets: [] };
  const complete = await captureRegistry(dir, state, operation(control));
  return { targets: [...state.targets], complete };
}

/** Record only identity-validated successful force calls, preserving the caller's observer. */
function forceControl(
  state: WindowsTreeState,
  control: ProcessTreeControl,
  deadline: number,
): ProcessTreeControl {
  return {
    ...control,
    deadline,
    onKilled: (target) => {
      state.forcedIdentities ??= new Set();
      state.forcedIdentities.add(`${target.pid}:${target.start}`);
      control.onKilled?.(target);
    },
  };
}

/** Windows has no generic gentle CLI signal. Keep observed targets while retrying unknown reads. */
export async function stopWindowsTree(
  pid: number,
  graceMs: number,
  registryDir?: string,
  stillOwned: () => boolean = () => true,
  control: ProcessTreeControl = {},
): Promise<boolean> {
  const context = operation(control);
  const state = control.state ?? { root: null, targets: [] };
  const forceAt = context.now() + graceMs;
  while (context.remaining() > 0) {
    await captureRoot(pid, state, stillOwned, context);
    let registryReadable = await captureRegistry(registryDir, state, context);
    if (context.now() < forceAt) {
      await context.pause(forceAt - context.now());
      continue;
    }
    const signalled = await signalIdentityTargets(
      state.targets,
      "SIGKILL",
      forceControl(state, control, context.deadline),
    );
    registryReadable =
      (await captureRegistry(registryDir, state, context)) && registryReadable;
    if (
      !signalled ||
      state.root === null ||
      state.complete === false ||
      !registryReadable
    )
      control.killOwned?.();
    const gone =
      state.targets.length === 0 ||
      (await identityTargetsGone(state.targets, context.snapshot));
    if (gone && registryReadable && (state.root !== null || !stillOwned()))
      return (
        state.root !== null &&
        state.complete !== false &&
        !state.unknownDescendants?.size
      );
    await context.pause(100);
  }
  control.killOwned?.();
  return false;
}

/** Force only previously verified identities within one aggregate deadline. */
export async function forceIdentityTargetsAndWitness(
  targets: readonly Pick<ProcessRow, "pid" | "start">[],
  control: ProcessTreeControl = {},
): Promise<boolean> {
  const context = operation(control);
  await signalIdentityTargets(targets, "SIGKILL", {
    ...control,
    deadline: context.deadline,
  });
  while (context.remaining() > 0) {
    if (await identityTargetsGone(targets, context.snapshot)) return true;
    await context.pause(100);
  }
  return false;
}

/** Reap registered runners without extending the cancellation budget per target. */
export async function reapRegisteredProcessTrees(
  dir: string,
  control: ProcessTreeControl = {},
): Promise<{ survived: boolean; confirmed: boolean }> {
  const context = operation(control);
  const state = control.state ?? { root: null, targets: [] };
  let survived = false;
  while (context.remaining() > 0) {
    const complete = await captureRegistry(dir, state, context);
    if (state.targets.length > 0) {
      const rows = await context.snapshot();
      if (rows !== null)
        state.targets = liveOrUnknownTargets(state.targets, rows);
    }
    survived ||=
      !complete || state.targets.length > 0 || !!state.unknownDescendants?.size;
    const gone =
      state.targets.length === 0 ||
      (await forceIdentityTargetsAndWitness(
        state.targets,
        forceControl(state, control, context.deadline),
      ));
    const confirmed = await captureRegistry(dir, state, context);
    if (!gone || !confirmed || state.unknownDescendants?.size)
      return { survived, confirmed: false };
    if (
      state.targets.length === 0 ||
      (await identityTargetsGone(state.targets, context.snapshot))
    )
      return { survived, confirmed: true };
  }
  return { survived, confirmed: false };
}
