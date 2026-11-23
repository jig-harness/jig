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
 *   dispatch states (`releaseEnded`) and comes back, or a person's label
 *   holds it while it is not claimed; an item claimed meanwhile is released
 *   when it returns;
 * - except a record whose pass recorded `waits` (the tracker's rate limit
 *   stopped it): it holds the item until the time it names, and the item is
 *   launched again after it, with no person asked;
 * - except a record of one item whose pass claimed it and recorded
 *   `waits --reason test-lock` (its push was refused only because the wait
 *   for the host's test lock ran out): it holds the item with no time to it,
 *   since the claimed item's plan relaunches the pickup in its tree
 *   (`pickup-lock-wait.ts`) rather than starting it afresh. Such a result
 *   from a pass that never claimed the item, or from a batch's pass, broke
 *   the result's rule (a claimed pickup's only, and a batch's stop stays a
 *   person's): it holds the item as any end does, with no time to it, so a
 *   person picks it up again or leaves it;
 * - except a record whose pass stopped at startup on its account's usage
 *   notice, with the account's wall recorded (`run.ts`): the wall keeps the
 *   next pickup off that account until its reset, so the item is wanted
 *   again at once, with no person asked;
 * - except a record of one item whose pass stopped on a fault of its host
 *   without claiming it (`pickup-host-fault.ts`): the item is wanted again,
 *   and the plan holds it while the host's health check fails; a pass that
 *   was itself the restart of such a stop holds the item as any end does;
 * - a record whose claim the repository's start rules refused (its
 *   `refusal`) holds the item, with the reason, only until the item's
 *   `updatedAt` moves past the time the rules saw: a person changed the
 *   item, so it is picked up again. An item read without an `updatedAt`
 *   keeps the rule above. A batch pass that named the members the rules
 *   refused holds only those, each on its own `updatedAt`; the rest of the
 *   batch is free to be picked up, and batched, again;
 * - a batch pass that ended after claiming some of its members holds only
 *   those: it worked them, whether it recorded `done` or `failed`, and the
 *   members it never claimed are wanted again under the queue's usual
 *   rules; a pass that ended on a question holds the members the question
 *   names (claimed or not) and releases the unclaimed rest, and one whose
 *   question names no member holds every member until the person answers it.
 */
import {
  holds,
  isInteractive,
  type LaunchRecord,
  type LaunchState,
  type ReadRecord,
  writeRecord,
} from "../launches.ts";
import { namedMembers } from "../batch-question.ts";
import { holdsItem } from "../launch-pickups.ts";
import { testLockNote } from "../test-lock-waits.ts";
import { refusalOf } from "../pickup-refusal.ts";
import {
  endedQuestion,
  faultedAgain,
  hostFault,
  pickupsOf,
} from "../pickup-host-fault.ts";
import { isPersonHold } from "../queue-rank.ts";
import { RUNNING_STATES, type SessionsReport } from "../runtime/port.ts";
import { currentMs, isoFromMs, parseMs } from "../../../shared/time.ts";
import type { Unplaced, WantedItem } from "../types.ts";

export { endedQuestion };

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
      exit: { at: isoFromMs(nowMs), code: null, signal: null },
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
  const wait = testLockNote(r.record);
  const what = `launch record ${r.record.id} (pickup on ${r.record.account})${wait === null ? "" : `; ${wait}`}`;
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
export function endedHow(r: ReadRecord): string {
  const s = r.state;
  const wait = testLockNote(r.record, undefined, true);
  const answer = `${r.result ?? "failed (no result recorded)"}${wait === null ? "" : `; ${wait}`}`;
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
  return pickupsOf(item, records);
}

/** Whether the item changed after its refusal: its `updatedAt` is later than the one the rules saw. */
function changedSince(updatedAt: string | undefined, seen: string): boolean {
  if (updatedAt === undefined) return false;
  const now = parseMs(updatedAt);
  return Number.isFinite(now) && now > parseMs(seen);
}

/**
 * What holds `item` from a new pickup. `assignee` is who the tracker's read
 * says the item is assigned to, `true` for an item assigned to someone the
 * read does not name; a caller that read no assignee passes none, so the
 * hold's reason never says the item is still assigned.
 */
export function pickupHold(
  item: string,
  records: ReadRecord[],
  updatedAt?: string,
  nowMs = currentMs(),
  assignee?: string | true,
): PickupHold {
  const mine = recordsOf(item, records);
  const holding = mine.find((r) => holds(r.state));
  if (holding !== undefined)
    return { kind: "held", record: holding, why: describe(holding) };
  const latest = mine.at(-1);
  if (latest === undefined || !holdsItem(latest.record, item))
    return { kind: "none" };
  // Conditional waits are governed by their durable pickup hold, including when it clears.
  if (latest.result === "waits" && latest.waitsFor?.condition !== undefined)
    return { kind: "none" };
  const lockWait =
    latest.result === "waits" && latest.waitsFor?.reason === "test-lock";
  if (lockWait && claimedAlone(latest.record, item))
    return {
      kind: "held",
      record: latest,
      why: `launch record ${latest.record.id} waits for the host's test lock, which held its push past the pre-push hook's wait; the pickup is relaunched in its tree once the host's validation capacity admits it`,
    };
  // A pass the tracker's rate limit stopped waits for the reset, then starts again.
  if (!lockWait && latest.result === "waits" && latest.waitsUntil !== undefined)
    return waitsHold(latest, latest.waitsUntil, nowMs);
  if (stoppedOnWall(latest)) return { kind: "none" };
  if (restartsAfterHostFault(latest, mine, item)) return { kind: "none" };
  return stoppedHold(latest, item, updatedAt, assignee);
}

/** Whether a pickup of `item` alone claimed it: only such a pickup is relaunched in its tree. */
function claimedAlone(record: LaunchRecord, item: string): boolean {
  return record.batchItems === undefined && wasClaimed(record, item);
}

/** Whether a pass stopped at startup, and the wrapper walled its account and released its work. */
function stoppedOnWall(r: ReadRecord): boolean {
  return (
    r.result === null &&
    r.state.kind === "ended" &&
    (r.state.exit.startup === "quota" ||
      r.state.exit.startup === "sign-in" ||
      r.state.exit.startup === "breaker") &&
    r.state.exit.wallUnrecorded !== true
  );
}

/**
 * Whether a pass that stopped on a fault of its host, without claiming the
 * item, leaves it wanted again: the tick holds it while the host's health
 * check fails (`plan-pickups.ts`) and picks it up afresh once it passes,
 * unless that pass was itself such a restart.
 */
function restartsAfterHostFault(
  latest: ReadRecord,
  mine: readonly ReadRecord[],
  item: string,
): boolean {
  return (
    latest.record.batchItems === undefined &&
    !wasClaimed(latest.record, item) &&
    hostFault(latest) !== null &&
    faultedAgain(latest, mine, item) === null
  );
}

/** A rate-limit wait: held until the reset it names, then nothing. */
function waitsHold(
  latest: ReadRecord,
  until: string,
  nowMs: number,
): PickupHold {
  return parseMs(until) > nowMs
    ? {
        kind: "held",
        record: latest,
        why: `launch record ${latest.record.id} waits for the issue service's rate limit to reset at ${until}; the item starts again after it`,
      }
    : { kind: "none" };
}

/** What an ended record that still holds `item` holds it for: a refusal, an end, or nothing. */
function stoppedHold(
  latest: ReadRecord,
  item: string,
  updatedAt: string | undefined,
  assignee: string | true | undefined,
): PickupHold {
  const recorded = latest.refusal ?? null;
  const refusal = recorded === null ? null : refusalOf(recorded, item);
  // The pass named the members it refused, and this is not one of them.
  if (recorded !== null && refusal === null) return { kind: "none" };
  if (refusal === null && leftUnclaimed(latest, item)) return { kind: "none" };
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
    why: endedWhy(latest, assignee),
  };
}

/** Why an ended record holds its item: the record, never released, and the assignment only when there is one. */
function endedWhy(
  latest: ReadRecord,
  assignee: string | true | undefined,
): string {
  const ended = `launch record ${latest.record.id} ended (${endedHow(latest)}) and has not been released, so it holds the item`;
  if (assignee === undefined)
    return `${ended}; it is not picked up again until that record is released, as when the item leaves the dispatch states and comes back`;
  const to = assignee === true ? "" : ` to ${assignee}`;
  return `${ended}, which is still assigned${to} in a dispatch state; it is not picked up again until the item leaves the dispatch states or its assignment and comes back`;
}

/**
 * Whether `item` is a member an ended batch pickup never claimed and its
 * pass has no claim on: the pass worked the members it claimed, so this one
 * is no longer its. Without a question that holds once the pass claimed a
 * sibling; a record that claimed none, or that only a legacy `claimedSeen`
 * describes, keeps every member. A pass that ended on a question keeps the
 * members the question names, and releases the others, whether it claimed
 * any or not: the question is not about them. A question that names no
 * member is about the whole batch and keeps every member until it is
 * answered, which settles them all (`releaseRecord`).
 */
function leftUnclaimed(r: ReadRecord, item: string): boolean {
  const { record } = r;
  const members = record.batchItems?.map((i) => i.key) ?? [];
  const claimed = record.claimedItems ?? [];
  if (members.length < 2 || claimed.includes(item)) return false;
  const named = namedMembers(r);
  if (named === null) return claimed.some((key) => members.includes(key));
  return named.length > 0 && !named.includes(item);
}

/**
 * The workspaces of ended batch pickups that left `item` unclaimed. A batch
 * opens its workspace under its first member, so one that left that member
 * out still shows joined to it, while the tree holds the batch's work. A
 * later pickup of the item in that tree makes it the item's again.
 */
export function leftBehindWorkspaces(
  item: string,
  records: ReadRecord[],
): Set<string> {
  const left = new Set<string>();
  for (const r of recordsOf(item, records)) {
    const path = r.record.workspace?.path;
    if (path === undefined) continue;
    if (!holds(r.state) && leftUnclaimed(r, item)) left.add(path);
    else left.delete(path);
  }
  return left;
}

/**
 * Why `repo`'s ended pickup records keep an item from starting, or `null`:
 * a slot of an epic's width is never given to a child the tick will not
 * start (`serializeEpics`).
 */
export function endedPassOver(
  records: readonly ReadRecord[],
  repo: string,
  nowMs: number,
): (issue: {
  identifier: string;
  updatedAt?: string;
  assignee?: { name: string } | null;
}) => string | null {
  const mine = records.filter((r) => r.record.repo === repo);
  return (issue) => {
    const hold = pickupHold(
      issue.identifier,
      mine,
      issue.updatedAt,
      nowMs,
      issue.assignee?.name,
    );
    return hold.kind === "ended" || hold.kind === "refused" ? hold.why : null;
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
 * The items whose ended pickup records stay held, for `releaseEnded`: the
 * pickups the tick wants, and the items the read left out (who assigned it
 * could not be read, or not by a person with write access), which are still
 * assigned, so only leaving the dispatch states releases their records. An
 * item a person's label holds is not among them: holding it ends its ended
 * record, so releasing the hold picks it up again. A pickup that recorded
 * `done` handed its item on (a pull request opened), so a hold never
 * releases its record.
 */
export function recordsWanted(
  pickups: ReadonlyArray<{ key: string }>,
  unplaced: ReadonlyArray<Unplaced>,
  records: ReadonlyArray<ReadRecord> = [],
): Set<string> {
  // The latest record that still holds an item decides whether it was handed on.
  const latest = new Map<string, ReadRecord>();
  for (const r of records) {
    if (r.record.action !== "pickup") continue;
    for (const key of r.record.batchItems?.map((i) => i.key) ?? [
      r.record.item,
    ]) {
      if (key === null || !holdsItem(r.record, key)) continue;
      const seen = latest.get(key);
      if (seen === undefined || r.record.createdAt >= seen.record.createdAt)
        latest.set(key, r);
    }
  }
  const handedOn = new Set(
    [...latest].filter(([, r]) => r.result === "done").map(([key]) => key),
  );
  return new Set([
    ...pickups.map((p) => p.key),
    ...unplaced
      .filter((u) => !isPersonHold(u.reason) || handedOn.has(u.target))
      .map((u) => u.target),
  ]);
}

/**
 * Release every ended pickup record of `repo` whose item is no longer
 * wanted, so a later assignment of that item is a pickup again. Called after
 * a read whose claims are known.
 *
 * An item that is claimed (in progress) keeps its record, so the question its
 * pass stopped on stays a need; the record notes that member's claim, and
 * releases it once it is back among `returned` (the dispatch states), which is
 * how a person settles that question.
 *
 * With `partial`, the read left some wanted items out, so an item missing
 * from `wanted` may still be wanted: only that return releases a record.
 */
export function releaseEnded(
  records: ReadRecord[],
  repo: string,
  wanted: ReadonlySet<string>,
  claimed: ReadonlySet<string> = new Set(),
  returned: ReadonlySet<string> = new Set(),
  root?: string,
  served: ReadonlySet<string> = new Set(),
  partial = false,
): void {
  for (const r of records) {
    const { record } = r;
    if (record.action !== "pickup" || record.repo !== repo) continue;
    if (record.released) continue;
    const item = record.item as string;
    // A claim seen while the pass still runs counts too: the item may be
    // back among the dispatch states by the time the record ends.
    // A member already released alone no longer counts toward holding its siblings' record.
    const members = (record.batchItems?.map((i) => i.key) ?? [item]).filter(
      (key) => holdsItem(record, key),
    );
    const claimedMembers = members.filter((key) => claimed.has(key));
    noteProvableClaims(r, claimedMembers, served, root);
    if (holds(r.state)) continue;
    // A claimed member keeps its own place; the record's other members
    // release one by one.
    const unclaimed = members.filter((key) => !claimedMembers.includes(key));
    const dropped = unclaimed.filter(
      (key) =>
        leftUnclaimed(r, key) ||
        !wantsRecord(record, key, partial ? null : wanted, returned),
    );
    if (dropped.length === 0) continue;
    // A member no longer wanted is released alone, so its siblings keep the
    // question they wait on.
    if (dropped.length === members.length) record.released = true;
    else record.releasedItems = [...(record.releasedItems ?? []), ...dropped];
    writeRecord(record, root);
  }
}

/**
 * Note the claims on a record's members that this pickup can prove. The
 * dispatch identity's own claimed item can only be this pickup's claim, seen
 * while it ran or after it ended. A served person starts their own work too:
 * their claim counts only while this pickup's process runs, never from a
 * reservation not yet started or once the pickup has ended.
 */
function noteProvableClaims(
  r: ReadRecord,
  claimedMembers: string[],
  served: ReadonlySet<string>,
  root?: string,
): void {
  const provable = claimedMembers.filter(
    (key) =>
      !served.has(key) ||
      r.state.kind === "alive" ||
      r.state.kind === "unknown",
  );
  if (provable.length > 0 && r.state.kind !== "pending")
    noteClaims(r.record, provable, root);
}

/** Whether the item still wants its ended record kept. */
function wantsRecord(
  record: LaunchRecord,
  item: string,
  wanted: ReadonlySet<string> | null,
  returned: ReadonlySet<string>,
): boolean {
  // An unknown wanted set (a partial read) keeps every record it would judge.
  const stillWanted = wanted === null || wanted.has(item);
  if (wasClaimed(record, item)) return !returned.has(item) && stillWanted;
  return stillWanted;
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

/**
 * Who the tracker says an item is assigned to, or nothing for an unassigned
 * one. `assignee` names who its claim assigns it to, which for an item from
 * the ready pool, an epic's inherited child or a pulled blocker is not yet
 * anyone, so the tracker's read decides where the plan has one.
 */
export function assigneeOf(item: WantedItem): string | undefined {
  if (item.queueIssue !== undefined) return item.queueIssue.assignee?.name;
  const unassigned =
    item.pooled === true ||
    item.factoryAncestor !== undefined ||
    item.ancestorEpic !== undefined ||
    item.blockingFor !== undefined;
  return unassigned ? undefined : item.assignee;
}
