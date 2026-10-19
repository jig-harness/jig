import { processRegistryRoots } from "./process-registry.ts";
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
  const found = new Set([pid]);
  const targets = [root];
  // Parent-first traversal is independent of provider row ordering.
  for (const parent of targets) {
    for (const row of rows) {
      if (!found.has(row.pid) && row.ppid === parent.pid) {
        found.add(row.pid);
        targets.push(row);
      }
    }
  }
  return targets.some((row) => row.start === "") ? null : targets;
}

/** A reused pid belongs to somebody else; unreadable identity never authorizes a kill. */
export async function signalIdentityTargets(
  targets: readonly Pick<ProcessRow, "pid" | "start">[],
  signal: NodeJS.Signals,
  deps: {
    table?: Table;
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  } = {},
): Promise<boolean> {
  const table = deps.table ?? processTable;
  const kill = deps.kill ?? process.kill.bind(process);
  let readable = true;
  for (const target of [...targets].reverse()) {
    if (!(await signalIdentityTarget(target, signal, table, kill)))
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
  const rows = await table();
  if (roots === null || rows === null) return null;
  const targets: ProcessRow[] = [];
  for (const root of roots) {
    const current = rows.find((row) => row.pid === root.pid);
    if (current?.start === "") return null;
    if (!current || current.start !== root.start) continue;
    const registered = await captureProcessTree(root.pid, async () => rows);
    if (registered === null) return null;
    mergeTargets(targets, registered);
  }
  return targets;
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

/** Merge new registered trees while retaining identities captured before reparenting. */
async function mergeRegisteredProcessTrees(
  targets: ProcessRow[],
  registryDir: string,
): Promise<boolean> {
  const registered = await captureRegisteredProcessTrees(registryDir);
  if (registered === null) return false;
  mergeTargets(targets, registered);
  return true;
}

async function refreshProcessTree(
  pid: number,
  targets: ProcessRow[],
  stillOwned: () => boolean,
): Promise<boolean> {
  // Include children created during grace without adopting a reused leader's tree.
  if (!stillOwned()) return true;
  const beforeForce = await processTable();
  if (beforeForce === null) return false;
  if (
    beforeForce.some(
      (row) =>
        row.pid === pid &&
        row.start === targets.find((target) => target.pid === pid)?.start,
    )
  ) {
    const latest = await captureProcessTree(pid, async () => beforeForce);
    if (latest === null) return false;
    for (const row of latest) {
      if (
        !targets.some(
          (target) => target.pid === row.pid && target.start === row.start,
        )
      )
        targets.push(row);
    }
  }
  return true;
}

/** Windows has no generic gentle CLI signal. Leave grace for cooperative exit, then force. */
export async function stopWindowsTree(
  pid: number,
  graceMs: number,
  registryDir?: string,
  stillOwned: () => boolean = () => true,
): Promise<boolean> {
  const captured = await captureProcessTree(pid);
  if (!stillOwned() || captured === null) return false;
  const targets = captured;
  const captureRegistered = (): Promise<boolean> =>
    registryDir
      ? mergeRegisteredProcessTrees(targets, registryDir)
      : Promise.resolve(true);
  const awaitRegistered = async (): Promise<boolean> => {
    const deadline = Date.now() + 30_000;
    do {
      if (await captureRegistered()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return false;
  };
  if (!(await awaitRegistered())) return false;
  if (await identityTargetsGone(targets)) return true;
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (!(await refreshProcessTree(pid, targets, stillOwned))) return false;
  if (!(await awaitRegistered())) return false;
  return forceIdentityTargetsAndWitness(targets);
}

/** Force only previously verified identities and require a readable absence. */
export async function forceIdentityTargetsAndWitness(
  targets: readonly Pick<ProcessRow, "pid" | "start">[],
): Promise<boolean> {
  await signalIdentityTargets(targets, "SIGKILL");
  const deadline = Date.now() + 30_000;
  do {
    if (await identityTargetsGone(targets)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
