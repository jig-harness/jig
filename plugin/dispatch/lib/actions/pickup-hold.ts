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
 *   dispatch states (`releaseEnded`) and comes back; an item claimed meanwhile is released when it returns;
 * - except a record whose pass recorded `waits` (the tracker's rate limit
 *   stopped it): it holds the item until the time it names, and the item is
 *   launched again after it, with no person asked;
 * - a record whose claim the repository's start rules refused (its
 *   `refusal`) holds the item, with the reason, only until the item's
 *   `updatedAt` moves past the time the rules saw: a person changed the
 *   item, so it is picked up again. An item read without an `updatedAt`
 *   keeps the rule above. A batch pass that named the members the rules
 *   refused holds only those, each on its own `updatedAt`; the rest of the
 *   batch is free to be picked up, and batched, again.
 */
import {
  holds,
  isInteractive,
  type LaunchRecord,
  type LaunchState,
  type ReadRecord,
  writeRecord,
} from "../launches.ts";
import { refusalOf } from "../pickup-refusal.ts";
import { RUNNING_STATES, type SessionsReport } from "../runtime/port.ts";

export type PickupHold =
  | { kind: "none" }
  | { kind: "held"; record: ReadRecord; why: string }
  | { kind: "ended"; record: ReadRecord; why: string }
  | { kind: "refused"; record: ReadRecord; why: string };

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
 * End, in memory, each alive interactive record of `repo` (a pickup's)
 * whose agent the runtime reports finished: its slot and its
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
  if (s.kind === "died")
    return `its wrapper died without an exit (${s.reason}), ${answer}`;
  return `its wrapper died without an exit, ${answer}`;
}

/** The records of one item's pickups, oldest first. */
function recordsOf(item: string, records: ReadRecord[]): ReadRecord[] {
  return records
    .filter(
      (r) =>
        r.record.action === "pickup" &&
        (r.record.item === item ||
          r.record.batchItems?.some((i) => i.key === item) === true),
    )
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
}

/** Whether the item changed after its refusal: its `updatedAt` is later than the one the rules saw. */
function changedSince(updatedAt: string | undefined, seen: string): boolean {
  if (updatedAt === undefined) return false;
  const now = Date.parse(updatedAt);
  return Number.isFinite(now) && now > Date.parse(seen);
}

export function pickupHold(
  item: string,
  records: ReadRecord[],
  updatedAt?: string,
  nowMs = Date.now(),
): PickupHold {
  const mine = recordsOf(item, records);
  const holding = mine.find((r) => holds(r.state));
  if (holding !== undefined)
    return { kind: "held", record: holding, why: describe(holding) };
  const latest = mine.at(-1);
  if (latest === undefined || latest.record.released) return { kind: "none" };
  // A pass the tracker's rate limit stopped waits for the reset, then starts again.
  if (latest.result === "waits" && latest.waitsUntil !== undefined)
    return Date.parse(latest.waitsUntil) > nowMs
      ? {
          kind: "held",
          record: latest,
          why: `launch record ${latest.record.id} waits for the tracker's rate limit to reset at ${latest.waitsUntil}; the item starts again after it`,
        }
      : { kind: "none" };
  const recorded = latest.refusal ?? null;
  const refusal = recorded === null ? null : refusalOf(recorded, item);
  // The pass named the members it refused, and this is not one of them.
  if (recorded !== null && refusal === null) return { kind: "none" };
  if (refusal !== null && updatedAt !== undefined) {
    if (changedSince(updatedAt, refusal.updatedAt)) return { kind: "none" };
    return {
      kind: "refused",
      record: latest,
      why: `held: the repository's start rules refused its claim (launch record ${latest.record.id}): ${refusal.reason}; it is picked up again once the item changes (updated after ${refusal.updatedAt})`,
    };
  }
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
 *
 * An item that is claimed (in progress) keeps its record, so the question its
 * pass stopped on stays a need; the record notes that member's claim, and
 * releases it once it is back among `returned` (the dispatch states), which is
 * how a person settles that question.
 */
export function releaseEnded(
  records: ReadRecord[],
  repo: string,
  wanted: ReadonlySet<string>,
  claimed: ReadonlySet<string> = new Set(),
  returned: ReadonlySet<string> = new Set(),
  root?: string,
  served: ReadonlySet<string> = new Set(),
): void {
  for (const r of records) {
    const { record } = r;
    if (record.action !== "pickup" || record.repo !== repo) continue;
    if (record.released) continue;
    const item = record.item as string;
    // A claim seen while the pass still runs counts too: the item may be
    // back among the dispatch states by the time the record ends.
    const members = record.batchItems?.map((i) => i.key) ?? [item];
    const claimedMembers = members.filter((key) => claimed.has(key));
    // The dispatch identity's own claimed item can only be this pickup's
    // claim, seen while it ran or after it ended. A served person starts their
    // own work too: their claim counts only while this pickup's process runs,
    // never from a reservation not yet started or once the pickup has ended.
    const provable = claimedMembers.filter(
      (key) =>
        !served.has(key) ||
        r.state.kind === "alive" ||
        r.state.kind === "unknown",
    );
    if (provable.length > 0 && r.state.kind !== "pending")
      noteClaims(record, provable, root);
    if (claimedMembers.length > 0 || holds(r.state)) continue;
    if (keepsWanted(record, members, wanted, returned)) continue;
    record.released = true;
    writeRecord(record, root);
  }
}

/** Whether the item still wants its ended record kept. */
function wantsRecord(
  record: LaunchRecord,
  item: string,
  wanted: ReadonlySet<string>,
  returned: ReadonlySet<string>,
): boolean {
  if (wasClaimed(record, item)) return !returned.has(item) && wanted.has(item);
  return wanted.has(item);
}

/** Whether this batch member was seen claimed after its record ended. */
function wasClaimed(record: LaunchRecord, item: string): boolean {
  return record.claimedItems?.includes(item) ?? record.claimedSeen === true;
}

/** Whether this ended pickup actually claimed this item, rather than merely attempting it. */
export function pickupClaimed(record: LaunchRecord, item: string): boolean {
  return wasClaimed(record, item);
}

/** Remember the batch members seen claimed, without marking their siblings. */
function noteClaims(
  record: LaunchRecord,
  claimed: string[],
  root?: string,
): void {
  const seen = new Set(record.claimedItems ?? []);
  let changed = false;
  for (const item of claimed) {
    if (seen.has(item)) continue;
    seen.add(item);
    changed = true;
  }
  if (!changed) return;
  record.claimedItems = [...seen];
  writeRecord(record, root);
}

function keepsWanted(
  record: LaunchRecord,
  members: string[],
  wanted: ReadonlySet<string>,
  returned: ReadonlySet<string>,
): boolean {
  return members.some((key) => wantsRecord(record, key, wanted, returned));
}
