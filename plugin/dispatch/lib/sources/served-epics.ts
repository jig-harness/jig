/** Epic children's person holds and epic idle reasons; plan holds are in `epic-plan-needs.ts`. */
import { PERSON_HOLD, queueHold, type QueueHoldPolicy } from "../queue-rank.ts";
import type { Unplaced } from "../types.ts";
import type {
  CanonicalState,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { CANONICAL_STATES } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { isUnavailable } from "../../../skills/do-item/scripts/lib/tracker/unavailable.ts";
import { isRateLimited } from "../../../shared/outbound/budget.ts";

/** Report an unreadable child's relations. A tracker wall still stops the read. */
export function noteUnreadChild(
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

/**
 * A pickup hold stops new starts. A started child can keep working.
 * An unstarted epic with open children can still have running descendants. `forStart` asks whether the child may start.
 */
export function parkedOnPerson(
  child: PoolIssue,
  tracker: Pick<Tracker, "stateName">,
  policy: QueueHoldPolicy,
  forStart = false,
): boolean {
  const { personHold: _local, ...labelHolds } = policy;
  const context = child.nativeType ?? null;
  const states = canonicalStatesFor(tracker, child.state.name, context);
  return (
    (states.includes("ops_pending") &&
      states.every(
        (state) => state === "ops_pending" || state === "in_review",
      )) ||
    (child.state.type !== "started" &&
      (forStart || !child.hasOpenChildren) &&
      policy.personHold?.(child.identifier) != null) ||
    queueHold({ issue: child, blockers: [], unblocks: 0 }, labelHolds) ===
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

/** Why a local pickup record keeps an item from starting. */
export type PassOver = (issue: PoolIssue) => string | null;

export interface PassedChild {
  epic: string;
  why: string;
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
 * own, deepest epics first; one whose child the tick passed over
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
