/** Launch and process evidence for checkouts whose opener shares admission. */
import { resolve } from "node:path";
import { isMapping } from "../shared/config-layers.ts";
import { isAlive, type ProcessIdentity } from "../shared/liveness.ts";
import { parseMs } from "../shared/time.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import { readWorktreeOwner } from "../shared/process-worktree-owner.ts";
import { asClaim } from "../dispatch/lib/launch-supervision.ts";
import {
  isLaunchRecord,
  type LaunchRecord,
  type LaunchRow,
} from "../dispatch/lib/launches.ts";
import { readOnlyStateDb } from "../dispatch/lib/state.ts";
import type { WorktreeIdentity } from "./kinds/worktree-proof.ts";

type Launch = { row: LaunchRow; record: LaunchRecord };

/** A malformed row may name this tree, so no unreadable row is discarded. */
function indexedLaunches(rows: LaunchRow[]): Outcome<Map<string, Launch>> {
  const launches = new Map<string, Launch>();
  for (const row of rows) {
    const record: unknown = JSON.parse(row.record);
    if (!isLaunchRecord(record) || record.id !== row.id)
      return failed("launch-unreadable", `launch ${row.id} cannot be read`);
    launches.set(row.id, { row, record });
  }
  return ok(launches);
}

function readableExit(value: unknown): boolean {
  return (
    isMapping(value) &&
    typeof value.at === "string" &&
    Number.isFinite(parseMs(value.at)) &&
    (value.signal === null || typeof value.signal === "string") &&
    (value.code === null || Number.isInteger(value.code))
  );
}

/** An ended wrapper cannot stand in for its unacknowledged child handoff. */
function claimedProcesses(row: LaunchRow): Outcome<ProcessIdentity[]> {
  if (row.claim === null)
    return failed("launch-unreadable", `launch ${row.id} has no process claim`);
  const claim = asClaim(JSON.parse(row.claim));
  if (claim === null)
    return failed(
      "launch-unreadable",
      `launch ${row.id} has an unreadable process claim`,
    );
  const handoff = claim.supervision;
  if (handoff === undefined) return ok([claim]);
  if (
    handoff.uncertain ||
    handoff.supervisor === null ||
    handoff.child === null
  )
    return failed(
      "launch-unreadable",
      `launch ${row.id} has no completed process handoff`,
    );
  return ok([claim, handoff.supervisor, handoff.child]);
}

function launchProcesses(
  launch: Launch,
  path: string,
  repository: string,
): Outcome<ProcessIdentity[]> {
  const { row, record } = launch;
  if (
    resolve(record.repoPath) !== resolve(repository) ||
    record.workspace === null ||
    resolve(record.workspace.path) !== resolve(path)
  )
    return failed(
      "launch-mismatch",
      `owner launch ${row.id} does not name this checkout`,
    );
  if (row.exit === null)
    return failed("launch-live", `launch ${row.id} has not recorded its exit`);
  if (!readableExit(JSON.parse(row.exit)))
    return failed(
      "launch-unreadable",
      `launch ${row.id} has an unreadable exit`,
    );
  return claimedProcesses(row);
}

async function deadProcesses(
  identities: ProcessIdentity[],
): Promise<Outcome<void>> {
  for (const identity of identities) {
    const alive = await isAlive(identity);
    if (!alive.ok) return alive;
    if (alive.value.state !== "dead")
      return failed(
        "process-live",
        `a recorded process is ${alive.value.state}: ${alive.value.reason}`,
      );
  }
  return ok(undefined);
}

/** Every launch naming the checkout counts, including one absent from its owner. */
function processesOfLaunches(
  launches: Map<string, Launch>,
  path: string,
  repository: string,
  owned: string[],
): Outcome<ProcessIdentity[]> {
  const ids = new Set(owned);
  for (const [id, { record }] of launches)
    if (
      record.workspace !== null &&
      resolve(record.workspace.path) === resolve(path)
    )
      ids.add(id);
  const identities: ProcessIdentity[] = [];
  for (const id of ids) {
    const launch = launches.get(id);
    if (launch === undefined)
      return failed("launch-missing", `owner launch ${id} is missing`);
    const processes = launchProcesses(launch, path, repository);
    if (!processes.ok) return processes;
    identities.push(...processes.value);
  }
  return ok(identities);
}

/**
 * Missing rows never prove a launch ended. Recorded identities must be dead
 * even after an exit. Called under exclusive admission and again after hooks.
 */
export async function processWorktreeIdle(
  path: string,
  repository: string,
  identity: WorktreeIdentity,
): Promise<Outcome<void>> {
  const read = readWorktreeOwner(identity.admin);
  if (!read.ok) return read;
  const owner = read.value;
  if (owner === null)
    return failed(
      "owner-missing",
      "the process worktree's owner record is missing",
    );
  if (
    resolve(owner.repository) !== resolve(repository) ||
    (identity.name !== "HEAD" && owner.branch !== identity.name)
  )
    return failed(
      "owner-mismatch",
      "the process worktree's owner names another repository or branch",
    );
  const opened = readOnlyStateDb();
  if (!opened.ok) return opened;
  if (opened.value === null)
    return failed("launch-missing", "the launch database is missing");
  const db = opened.value.db;
  try {
    const rows = db
      .query(
        `SELECT id, record, claim, exit FROM launches
         UNION ALL
         SELECT id, record, claim, exit FROM process_worktree_completions`,
      )
      .all() as LaunchRow[];
    const launches = indexedLaunches(rows);
    if (!launches.ok) return launches;
    const processes = processesOfLaunches(
      launches.value,
      path,
      repository,
      owner.launches,
    );
    return processes.ok
      ? deadProcesses([...owner.processes, ...processes.value])
      : processes;
  } catch (error) {
    return failed(
      "launch-unreadable",
      "the process worktree's launch evidence cannot be read",
      error,
    );
  } finally {
    db.close();
  }
}
