/** An epic's children up to its width unless its plan says otherwise, and why an epic is idle. */
import {
  PERSON_HOLD,
  queueHold,
  type QueueHoldPolicy,
  type QueueItem,
} from "../queue-rank.ts";
import type { Unplaced } from "../types.ts";
import type {
  CanonicalState,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { CANONICAL_STATES } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import { isRateLimited } from "../../../shared/outbound/budget.ts";
import type { ServedPlan } from "./served-plan.ts";

/** One child's unreadable relations take one slot of the epic's width, not the whole epic; a wall still stops the read. */
export function takeUnreadSlot(
  unread: string[],
  key: string,
  error: unknown,
  note: (error: unknown) => void,
): Promise<null> {
  if (isRateLimited(error) || isUnavailable(error))
    return Promise.reject(error);
  if (!unread.includes(key)) unread.push(key);
  note(error);
  return Promise.resolve(null);
}

/** A person owns the next step, so this child takes none of a plan-less epic's width; a pickup hold stops only new starts, so a started child keeps its slot. */
export function parkedOnPerson(
  child: PoolIssue,
  tracker: Pick<Tracker, "stateName">,
  policy: QueueHoldPolicy,
): boolean {
  const context = child.nativeType ?? null;
  const states = canonicalStatesFor(tracker, child.state.name, context);
  return (
    (states.includes("ops_pending") &&
      states.every(
        (state) => state === "ops_pending" || state === "in_review",
      )) ||
    (child.state.type !== "started" &&
      policy.personHold?.(child.identifier) != null) ||
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

/** Why a child waits on its epic's plan; an epic with no plan holds its children to its width instead. */
export function childPlanHold(
  selection: ServedPlan,
  child: string,
): string | undefined {
  if (selection.error !== undefined) return selection.error;
  if (selection.holds[child] !== undefined) return selection.holds[child];
  if (selection.present)
    return selection.order.includes(child)
      ? undefined
      : "waiting on the epic execution plan";
  return undefined;
}

/** `dispatch.epic_width`'s default: how many children of an epic with no execution plan are under way at once. */
export const DEFAULT_EPIC_WIDTH = 4;

/** The epic an item is a child of when that epic has no execution plan, and the children that take its width. */
export interface Serial {
  epic: string;
  /** Children under way: started, and not waiting on a person. */
  busy: string[];
  /** Open children that could not be read: each may be under way, so each takes a slot. */
  unread: string[];
  /** The child whose read failed before the epic's children were known: none of them starts. */
  unknown?: string | undefined;
}

/** Why a serial item starts nothing now, or null while its epic has a free slot. */
function serialHold(
  serial: Serial,
  key: string,
  width: number,
  starting: ReadonlyMap<string, readonly string[]>,
): string | null {
  if (serial.unknown !== undefined)
    return `${serial.unknown} cannot be read, so whether a sibling of ${key} is in progress is unknown`;
  if (
    serial.busy.includes(key) ||
    (starting.get(serial.epic) ?? []).includes(key)
  )
    return null;
  const busy = serial.busy.filter((k) => k !== key);
  const unread = serial.unread.filter((k) => k !== key);
  const next = (starting.get(serial.epic) ?? []).filter((k) => k !== key);
  if (busy.length + unread.length + next.length < width) return null;
  return widthHoldReason(serial.epic, width, busy, unread, next);
}

/** Name the occupied slots when an epic has no remaining width. */
function widthHoldReason(
  epic: string,
  width: number,
  busy: string[],
  unread: string[],
  next: readonly string[],
): string {
  const taken = [
    ...(busy.length > 0 ? [`working ${busy.join(", ")}`] : []),
    ...(unread.length > 0
      ? [`${unread.join(", ")} cannot be read and may be under way`]
      : []),
    ...(next.length > 0 ? [`starting ${next.join(", ")}`] : []),
  ];
  const children = width === 1 ? "child" : "children";
  return `${epic} works at most ${width} ${children} at once (dispatch.epic_width): ${taken.join("; ")}`;
}

/**
 * Why the tick will not start an item whatever its epic's width (this
 * machine's ended pickup record holds it), or `null` when it may start.
 */
export type PassOver = (issue: PoolIssue) => string | null;

/** A serial epic's child the tick will not start: it keeps its own row and leaves its slot to a sibling. */
export interface PassedChild {
  epic: string;
  why: string;
}

/**
 * `ranked` best first: each serial epic keeps its best children while its
 * `width` (`dispatch.epic_width`) has room. A child `passOver` names is kept, so the pickup plan
 * reports it, but takes no slot: it is noted in `passed` and its next
 * sibling may start in its place.
 */
export interface Admission {
  serial: Serial;
  child: string;
}

/** A legacy serial constraint is the leaf's own admission when no hierarchy was supplied. */
function admissionsOf(
  item: QueueItem & { serial?: Serial | undefined; admissions?: Admission[] },
): Admission[] {
  if (item.admissions !== undefined) return item.admissions;
  return item.serial === undefined
    ? []
    : [{ serial: item.serial, child: item.issue.identifier }];
}

/** Multiple descendants of one admitted child consume just that child's existing slot. */
function reserveAdmission(
  admission: Admission,
  starting: Map<string, string[]>,
): void {
  const { serial, child } = admission;
  const next = starting.get(serial.epic) ?? [];
  if (
    next.includes(child) ||
    serial.busy.includes(child) ||
    serial.unread.includes(child)
  )
    return;
  starting.set(serial.epic, [...next, child]);
}

export function serializeEpics<
  T extends QueueItem & {
    serial?: Serial | undefined;
    admissions?: Admission[];
  },
>(
  ranked: readonly T[],
  unplaced: Unplaced[],
  width: number = DEFAULT_EPIC_WIDTH,
  passOver: PassOver = () => null,
  passed: Map<string, PassedChild> = new Map(),
): T[] {
  const starting = new Map<string, string[]>();
  const kept: T[] = [];
  for (const item of ranked) {
    const admissions = admissionsOf(item);
    const key = item.issue.identifier;
    // A child the tick will not start stays planned, so its own need is
    // raised whichever siblings hold the width, and takes no slot itself.
    const held = admissions.length === 0 ? null : passOver(item.issue);
    const first = admissions[0];
    if (first !== undefined && held !== null) {
      passed.set(key, { epic: first.serial.epic, why: held });
      kept.push(item);
      continue;
    }
    const why =
      admissions
        .map((a) => serialHold(a.serial, a.child, width, starting))
        .find((reason) => reason !== null) ?? null;
    if (why !== null) {
      unplaced.push({ target: key, record: "tracker", reason: why });
      continue;
    }
    for (const admission of admissions) reserveAdmission(admission, starting);
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
    const all = [...new Set([...walk.children, ...walk.unread])];
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
