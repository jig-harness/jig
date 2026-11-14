/** An epic's children one at a time unless its plan says otherwise, and why an epic is idle. */
import { PERSON_HOLD, queueHold, type QueueItem } from "../queue-rank.ts";
import type { Unplaced } from "../types.ts";
import type {
  CanonicalState,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { CANONICAL_STATES } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { ServedPlan } from "./served-plan.ts";

/** A person owns the next step, so this child cannot occupy a plan-less epic's working slot. */
export function parkedOnPerson(
  child: PoolIssue,
  tracker: Pick<Tracker, "stateName">,
  policy: { hitl?: string; manualOps?: string },
): boolean {
  const context = child.nativeType ?? null;
  const states = canonicalStatesFor(tracker, child.state.name, context);
  return (
    (states.includes("ops_pending") &&
      states.every(
        (state) => state === "ops_pending" || state === "in_review",
      )) ||
    queueHold({ issue: child, blockers: [], unblocks: 0 }, policy) ===
      PERSON_HOLD
  );
}

/** The canonical states this native name can mean in the child's workflow. */
function canonicalStatesFor(
  tracker: Pick<Tracker, "stateName">,
  name: string,
  context: string | null,
): CanonicalState[] {
  const native = name.trim().toLowerCase();
  return CANONICAL_STATES.filter(
    (state) =>
      tracker.stateName(state, context)?.trim().toLowerCase() === native,
  );
}

/** Why a child waits on its epic's plan, or, with no plan, on an unreadable sibling. */
export function childPlanHold(
  selection: ServedPlan,
  child: string,
  unread: readonly string[],
): string | undefined {
  if (selection.error !== undefined) return selection.error;
  if (selection.holds[child] !== undefined) return selection.holds[child];
  if (selection.present)
    return selection.order.includes(child)
      ? undefined
      : "waiting on the epic execution plan";
  // A child that cannot be read may be the one in progress, so no sibling starts on a guess.
  return unread.length > 0
    ? `${unread[0]} cannot be read, so whether a sibling is in progress is unknown`
    : undefined;
}

/** The epic an item is a child of when that epic has no execution plan, and its child already in progress. */
export interface Serial {
  epic: string;
  busy?: string | undefined;
  /** An open child that could not be read: it may be the one in progress. */
  unread?: string | undefined;
}

/** Why a serial item starts nothing now, or null when it may be the epic's one child. */
function serialHold(
  serial: Serial,
  key: string,
  leader: ReadonlyMap<string, string>,
): string | null {
  if (serial.unread !== undefined)
    return `${serial.unread} cannot be read, so whether a sibling of ${key} is in progress is unknown`;
  if (serial.busy !== undefined)
    return `${serial.epic} is working ${serial.busy}; it takes one child at a time`;
  const first = leader.get(serial.epic);
  return first === undefined
    ? null
    : `waiting on ${first}; ${serial.epic} takes one child at a time`;
}

/**
 * Why the tick will not start an item whatever its epic's slot (this
 * machine's ended pickup record holds it), or `null` when it may start.
 */
export type PassOver = (issue: PoolIssue) => string | null;

/** A serial epic's child the tick will not start: it keeps its own row and leaves the epic's slot to a sibling. */
export interface PassedChild {
  epic: string;
  why: string;
}

/**
 * `ranked` best first: each serial epic keeps its first child, and none
 * while a child is in progress. A child `passOver` names is kept, so the
 * pickup plan reports it, but takes no slot: it is noted in `passed` and
 * its next sibling may lead.
 */
export function serializeEpics<
  T extends QueueItem & { serial?: Serial | undefined },
>(
  ranked: readonly T[],
  unplaced: Unplaced[],
  passOver: PassOver = () => null,
  passed: Map<string, PassedChild> = new Map(),
): T[] {
  const leader = new Map<string, string>();
  const kept: T[] = [];
  for (const item of ranked) {
    const serial = item.serial;
    const key = item.issue.identifier;
    // A child the tick will not start stays planned, so its own need is
    // raised whichever sibling holds the slot, and takes no slot itself.
    const held = serial === undefined ? null : passOver(item.issue);
    if (serial !== undefined && held !== null) {
      passed.set(key, { epic: serial.epic, why: held });
      kept.push(item);
      continue;
    }
    const why = serial === undefined ? null : serialHold(serial, key, leader);
    if (why !== null) {
      unplaced.push({ target: key, record: "tracker", reason: why });
      continue;
    }
    if (serial !== undefined) leader.set(serial.epic, key);
    kept.push(item);
  }
  return kept;
}

export interface EpicWalk {
  key: string;
  children: string[];
  /** Open children that could not be read; they are reported on their own. */
  unread: string[];
  /** A child is already in progress: the epic is working, not idle. */
  working: boolean;
  /** Children whose next step belongs to a person rather than an agent. */
  parked: string[];
}

/**
 * An epic none of whose open children can start reports one reason of its
 * own, deepest epics first; one whose child `serializeEpics` passed over
 * names that child and why it is held.
 */
export function summarizeEpics(
  walks: readonly EpicWalk[],
  wanted: ReadonlySet<string>,
  unplaced: Unplaced[],
  passed: ReadonlyMap<string, PassedChild> = new Map(),
): void {
  const byKey = new Map(walks.map((w) => [w.key, w]));
  const reach = (
    key: string,
    path: ReadonlySet<string>,
    test: (walk: EpicWalk) => boolean,
  ): boolean => {
    const walk = byKey.get(key);
    if (walk === undefined || path.has(key)) return false;
    const next = new Set(path).add(key);
    return test(walk) || walk.children.some((c) => reach(c, next, test));
  };
  const startable = (key: string): boolean =>
    wanted.has(key) ||
    reach(key, new Set(), (w) => w.children.some((c) => wanted.has(c)));
  const rowOf = (
    child: string,
  ): Pick<Unplaced, "target" | "reason"> | undefined => {
    const own = unplaced.find((u) => u.target === child);
    if (own !== undefined) return own;
    const pass = passed.get(child);
    return pass === undefined ? undefined : { target: child, reason: pass.why };
  };
  for (const walk of [...walks].reverse()) {
    const skipped = walk.children.find((c) => passed.get(c)?.epic === walk.key);
    // A child in progress anywhere below keeps the epic working, not idle.
    if (startable(walk.key) || reach(walk.key, new Set(), (w) => w.working)) {
      if (skipped !== undefined)
        unplaced.push({
          target: walk.key,
          record: "tracker",
          reason: `${skipped} is held, so it does not hold its siblings: ${passed.get(skipped)?.why ?? ""}`,
        });
      continue;
    }
    const all = [...walk.children, ...walk.unread];
    const held = all.map(rowOf).find((u) => u !== undefined);
    const parked = walk.parked[0];
    const first = parked ?? held?.target ?? all[0];
    const why =
      parked === undefined
        ? (held?.reason ?? "not ready to start")
        : "waiting on a person";
    unplaced.push({
      target: walk.key,
      record: "tracker",
      reason: `none of its ${all.length} open children can start; first, ${first}: ${why}`,
    });
  }
}
