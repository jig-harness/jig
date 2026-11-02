/**
 * What this machine's launch records say about one item's pickup:
 *
 * - an interactive session's record is read beside its agent: while its
 *   wrapper is alive, the agent the runtime reports under the record's
 *   agent id holds the stage and the slot while it works or waits, and the
 *   record ends when the runtime reports that agent finished, with the
 *   session's recorded result, else as failed;
 * - a record that holds its stage (pending, alive, unknown) holds the item:
 *   nothing else is launched for it;
 * - the item's latest record that ended, and has not been released, holds
 *   it too: a session that stopped without claiming the item (a refusal, a
 *   crash, a question) is not launched again until the item leaves the
 *   dispatch states (`releaseEnded`) and comes back.
 */
import {
  holds,
  isInteractive,
  type LaunchState,
  type ReadRecord,
  writeRecord,
} from "../launches.ts";
import { RUNNING_STATES, type SessionsReport } from "../runtime/port.ts";

export type PickupHold =
  | { kind: "none" }
  | { kind: "held"; record: ReadRecord; why: string }
  | { kind: "ended"; record: ReadRecord; why: string };

/** The agent the runtime reports under `id`, in any of the repository's workspaces. */
export function agentOf(sessions: SessionsReport, id: string) {
  if (!sessions.ok) return undefined;
  for (const w of sessions.workspaces) {
    const agent = w.agents.find((a) => a.id === id);
    if (agent !== undefined) return { workspace: w, agent };
  }
  return undefined;
}

/**
 * End, in memory, each alive interactive record of `repo` (a pickup's, a
 * follow-up's) whose agent the runtime reports finished: its slot and its
 * target are free again. Returns whether any record changed.
 */
export function settleAgents(
  records: ReadRecord[],
  repo: string,
  sessions: SessionsReport,
  nowMs: number,
): boolean {
  let changed = false;
  for (const r of records) {
    const { record, state } = r;
    if (!isInteractive(record) || record.repo !== repo) continue;
    if (state.kind !== "alive" || record.agentId === null) continue;
    const found = agentOf(sessions, record.agentId);
    if (found === undefined || RUNNING_STATES.has(found.agent.state)) continue;
    const ended: LaunchState = {
      kind: "ended",
      exit: { at: new Date(nowMs).toISOString(), code: null, signal: null },
      process: state.process,
      agent: found.agent.state,
    };
    r.state = ended;
    changed = true;
  }
  return changed;
}

function describe(r: ReadRecord): string {
  const s = r.state;
  const what = `launch record ${r.record.id} (pickup on ${r.record.account})`;
  if (s.kind === "unknown") return `${what} is unknown: ${s.reason}`;
  if (s.kind === "alive")
    return `${what} is running, pid ${s.process.pid}${r.record.agentId === null ? "" : `, agent ${r.record.agentId}`}`;
  if (s.kind === "pending") {
    const last = r.record.attempts.at(-1);
    return `${what} is pending${last === undefined ? ", its launch not yet answered" : `, its last launch ${last.outcome}: ${last.detail}`}`;
  }
  return what;
}

/** How a record that no longer holds its stage ended, in words. */
function endedHow(r: ReadRecord): string {
  const s = r.state;
  const answer = r.result ?? "failed (no result recorded)";
  if (s.kind === "ended")
    return s.agent === undefined
      ? `its session exited, ${answer}`
      : `its agent is ${s.agent}, ${answer}`;
  return `its wrapper died without an exit, ${answer}`;
}

/** The records of one item's pickups, oldest first. */
function recordsOf(item: string, records: ReadRecord[]): ReadRecord[] {
  return records
    .filter((r) => r.record.action === "pickup" && r.record.item === item)
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
}

export function pickupHold(item: string, records: ReadRecord[]): PickupHold {
  const mine = recordsOf(item, records);
  const holding = mine.find((r) => holds(r.state));
  if (holding !== undefined)
    return { kind: "held", record: holding, why: describe(holding) };
  const latest = mine.at(-1);
  if (latest === undefined || latest.record.released) return { kind: "none" };
  return {
    kind: "ended",
    record: latest,
    why: `launch record ${latest.record.id} ended (${endedHow(latest)}) while the item stayed assigned in a dispatch state; it is not picked up again until the item leaves the dispatch states or its assignment and comes back`,
  };
}

/** The pickup records of an item that hold their stage. */
export function holdingRecords(
  item: string,
  records: ReadRecord[],
): ReadRecord[] {
  return recordsOf(item, records).filter((r) => holds(r.state));
}

/**
 * Release every ended pickup record of `repo` whose item is no longer
 * wanted, so a later assignment of that item is a pickup again. Called only
 * after a whole read of the tracker.
 */
export function releaseEnded(
  records: ReadRecord[],
  repo: string,
  wanted: ReadonlySet<string>,
  root?: string,
): void {
  for (const r of records) {
    const { record } = r;
    if (record.action !== "pickup" || record.repo !== repo) continue;
    if (record.released || holds(r.state)) continue;
    if (wanted.has(record.item as string)) continue;
    record.released = true;
    writeRecord(record, root);
  }
}
