import {
  type Dirent,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Defect, swallow } from "./errors.ts";
import { processTable, type ProcessRow } from "./process-table.ts";

export const PROCESS_REGISTRY_ENV = "JIG_PROCESS_REGISTRY_DIR";
export interface ProcessIdentity {
  pid: number;
  start: string;
  /** Durable tree-completion proof; absence never proves a vanished runner's tree gone. */
  resultFile?: string;
}

/** Each command owns a subtree; acquisition cancellation discovers every subtree. */
export function createProcessRegistry(parentDir?: string): {
  dir: string;
  dispose(): void;
} {
  const dir = mkdtempSync(join(parentDir ?? tmpdir(), "jig-processes-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function publishRegistryFile(dir: string, name: string, value: unknown): void {
  const file = join(dir, name);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
}

/** An unsuccessful owned stop remains visible to every ancestor acquisition. */
export function markProcessRegistryUnconfirmed(dir: string): string {
  const name = "owned-stop.pending";
  publishRegistryFile(dir, name, {});
  return join(dir, name);
}
export function clearProcessRegistryUnconfirmed(marker: string): void {
  rmSync(marker, { force: true });
}

/** Completion authority belongs to the acquisition, independent of launch-log retention. */
export function processCompletionPath(dir: string, entry: string): string {
  return resolve(dir, `${entry}.result.json`);
}

/** One terminal witness per unique entry; retain it until its registry is retired. */
export function publishProcessCompletion(
  dir: string,
  entry: string,
  result: { exitCode: number; treeWitnessed?: boolean },
): void {
  if (
    !Number.isInteger(result.exitCode) ||
    typeof result.treeWitnessed !== "boolean"
  )
    throw new Defect(
      "process completion requires an integer status and explicit tree witness",
    );
  writeFileSync(
    processCompletionPath(dir, entry),
    JSON.stringify({
      exitCode: result.exitCode,
      treeWitnessed: result.treeWitnessed,
    }),
    { flag: "wx" },
  );
}

/** Retain the completion location so readers can reconcile an unfinished handoff. */
export function beginProcessRegistration(
  dir: string,
  entry: string,
  resultFile: string,
): void {
  publishRegistryFile(dir, `${entry}.pending`, { resultFile });
}

export function clearPendingProcessRegistration(
  dir: string,
  entry: string,
): void {
  rmSync(join(dir, `${entry}.pending`), { force: true });
}

/** Only a captured creation identity authorizes later cancellation. */
export function publishProcessIdentity(
  dir: string,
  entry: string,
  identity: ProcessIdentity,
  resultFile?: string,
): void {
  publishRegistryFile(dir, `${entry}.json`, {
    pid: identity.pid,
    start: identity.start,
    ...(resultFile ? { resultFile } : {}),
  });
  clearPendingProcessRegistration(dir, entry);
}

/** Retry an unreadable handoff within one budget; unknown remains explicitly pending. */
export async function handoffProcessRegistration(
  dir: string,
  entry: string,
  pid: number,
  completed: () => boolean,
  stillOwned: () => boolean,
  options: {
    table?: (timeoutSec: number) => Promise<ProcessRow[] | null>;
    timeoutMs?: number;
    pollMs?: number;
    resultFile?: string;
  } = {},
): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const table = options.table ?? processTable;
  const resultFile = options.resultFile ?? registrationResultFile(dir, entry);
  do {
    if (completed()) {
      clearPendingProcessRegistration(dir, entry);
      return true;
    }
    if (!stillOwned()) return false;
    const rows = await table(
      Math.min(5, Math.max(1, deadline - Date.now()) / 1000),
    );
    const identity = rows?.find((row) => row.pid === pid);
    if (identity?.start && stillOwned()) {
      publishProcessIdentity(dir, entry, identity, resultFile);
      return true;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  } while (Date.now() < deadline);
  return false;
}

function registrationResultFile(
  dir: string,
  entry: string,
): string | undefined {
  try {
    const record: unknown = JSON.parse(
      readFileSync(join(dir, `${entry}.pending`), "utf8"),
    );
    if (
      record &&
      typeof record === "object" &&
      "resultFile" in record &&
      typeof record.resultFile === "string" &&
      isAbsolute(record.resultFile)
    )
      return record.resultFile;
  } catch (error) {
    swallow(error, "registration completion location is unavailable");
  }
  return undefined;
}

/** A vanished registered root needs its own durable completion proof. */
export function processIdentityCompleted(identity: ProcessIdentity): boolean {
  return completionWitness({ resultFile: identity.resultFile }) === true;
}

/** An explicit unknown-tree result overrides even a later force of the runner. */
export function processIdentityUnwitnessed(identity: ProcessIdentity): boolean {
  return completionWitness({ resultFile: identity.resultFile }) === false;
}

function completionWitness(record: Record<string, unknown>): boolean | null {
  if (typeof record.resultFile !== "string" || !isAbsolute(record.resultFile))
    return null;
  try {
    const result: unknown = JSON.parse(readFileSync(record.resultFile, "utf8"));
    if (
      result !== null &&
      typeof result === "object" &&
      "exitCode" in result &&
      Number.isInteger(result.exitCode) &&
      "treeWitnessed" in result &&
      typeof result.treeWitnessed === "boolean"
    )
      return result.treeWitnessed;
    return null;
  } catch (error) {
    swallow(
      error,
      "pending process registration has no readable completion witness",
    );
    return null;
  }
}

/** false means a finished pending registration; null means unknown. */
function registryFileRoot(
  path: string,
  pending: boolean,
): ProcessIdentity | false | null {
  const record: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!record || typeof record !== "object") return null;
  if (pending) {
    if (completionWitness(record as Record<string, unknown>) !== true)
      return null;
    rmSync(path, { force: true });
    return false;
  }
  const { pid, start } = record as Partial<ProcessIdentity>;
  if (
    !Number.isSafeInteger(pid) ||
    (pid ?? 0) <= 0 ||
    typeof start !== "string" ||
    start === ""
  )
    return null;
  const resultFile = "resultFile" in record ? record.resultFile : undefined;
  if (
    resultFile !== undefined &&
    (typeof resultFile !== "string" || !isAbsolute(resultFile))
  )
    return null;
  const identity: ProcessIdentity = {
    pid: pid as number,
    start,
    ...(typeof resultFile === "string" ? { resultFile } : {}),
  };
  if (processIdentityCompleted(identity)) {
    rmSync(path, { force: true });
    return false;
  }
  return identity;
}

export interface ProcessRegistrySnapshot {
  roots: ProcessIdentity[];
  complete: boolean;
}

function registryEntries(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    swallow(error, "process registry directory is unreadable");
    return null;
  }
}

function readRegistryFile(
  path: string,
  pending: boolean,
): ProcessIdentity | false | null {
  try {
    return registryFileRoot(path, pending);
  } catch (error) {
    swallow(error, "process registry record is unreadable");
    return null;
  }
}

/** Retain terminal authority files while collecting actionable identity records. */
function collectRegistryFile(
  entry: Dirent,
  path: string,
  snapshot: ProcessRegistrySnapshot,
): void {
  // Publication temporaries never authorize cancellation; a pending marker
  // protects an unfinished identity handoff until the record is renamed.
  if (entry.isFile() && entry.name.endsWith(".tmp")) return;
  if (!entry.isFile()) {
    snapshot.complete = false;
    return;
  }
  if (entry.name.endsWith(".result.json")) {
    if (completionWitness({ resultFile: resolve(path) }) !== true)
      snapshot.complete = false;
    return;
  }
  const root = readRegistryFile(path, entry.name.endsWith(".pending"));
  if (root === null) snapshot.complete = false;
  else if (root !== false) snapshot.roots.push(root);
}

function registryDirectorySnapshot(
  dir: string,
  directories: string[],
  ignoreMarker?: string,
): ProcessRegistrySnapshot {
  const entries = registryEntries(dir);
  const snapshot: ProcessRegistrySnapshot = {
    roots: [],
    complete: entries !== null,
  };
  for (const entry of entries ?? []) {
    const path = join(dir, entry.name);
    if (path === ignoreMarker) continue;
    if (entry.isDirectory()) {
      directories.push(path);
      continue;
    }
    collectRegistryFile(entry, path, snapshot);
  }
  return snapshot;
}

/** Keep verified roots even when another registration remains unresolved. */
export function processRegistrySnapshot(
  dir: string,
  ignoreMarker?: string,
): ProcessRegistrySnapshot {
  const snapshot: ProcessRegistrySnapshot = { roots: [], complete: true };
  const directories = [dir];
  for (const directory of directories) {
    const found = registryDirectorySnapshot(
      directory,
      directories,
      ignoreMarker,
    );
    snapshot.roots.push(...found.roots);
    snapshot.complete = snapshot.complete && found.complete;
  }
  return snapshot;
}

/** Pending launch markers or unreadable records withhold any termination witness. */
export function processRegistryRoots(dir: string): ProcessIdentity[] | null {
  const snapshot = processRegistrySnapshot(dir);
  return snapshot.complete ? snapshot.roots : null;
}
