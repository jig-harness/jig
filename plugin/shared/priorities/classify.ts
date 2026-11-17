/**
 * Which lane each snapshot item falls in, and its allocation owner at each
 * level ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)).
 * An Urgent item is `urgent`, bug or not. An assigned bug is `bug-high` at
 * High priority and `bug-other` otherwise, whatever objective it also belongs
 * to. Other work's lane is its allocation owner's class: the first objective,
 * in record order, whose selectors match the item or one of its ancestors.
 * Every other membership is reported only. Owners at different levels must
 * name the same class, or the item is an allocation conflict and excluded;
 * a cycle or unreadable parentage is incomplete evidence and excluded too.
 */
import type { Lane, ObjectiveClass } from "./lanes.ts";
import {
  type Level,
  type PrioritiesRecord,
  refKey,
  resolvedSelectors,
} from "./record.ts";
import type { SnapshotItem } from "./snapshot.ts";

/** Where an item sits under its owner: the declared position of the epic that matched, and that epic's key. */
export interface Placement {
  level: Level;
  scope: string;
  objective: string;
  objectiveIndex: number;
  class: ObjectiveClass;
  /** The index of the matching selector entry in the objective's declared order. */
  epicPosition: number;
  /** The epic key that matched; `null` for a label match on the item itself. */
  epic: string | null;
}

export interface Classified {
  item: SnapshotItem;
  lane: Lane | "unallocated" | "excluded";
  /** The allocation owner at each level, as `level:scope:id`. */
  owners: Partial<Record<Level, string>>;
  /** The owner at the allocating level, for in-lane allocation. */
  placement: Placement | null;
  /** Every other objective the item belongs to: reporting only. */
  alsoIn: string[];
  /** Why the item is excluded or unallocated, or how it entered its lane. */
  why: string;
}

/**
 * Classify every item. `records` are the effective revisions, the
 * allocating level first; `allocationBlocked` names why objective
 * allocation is blocked (an infeasible newest revision), or is `null`.
 */
export function classify(
  items: readonly SnapshotItem[],
  records: readonly PrioritiesRecord[],
  allocationBlocked: string | null,
): Classified[] {
  const byKey = new Map(items.map((i) => [`${i.scope}#${i.key}`, i]));
  return items.map((item) =>
    classifyOne(item, byKey, records, allocationBlocked),
  );
}

function classifyOne(
  item: SnapshotItem,
  byKey: Map<string, SnapshotItem>,
  records: readonly PrioritiesRecord[],
  allocationBlocked: string | null,
): Classified {
  const base = { item, owners: {}, placement: null, alsoIn: [] as string[] };
  if (item.priority === 1)
    return { ...base, lane: "urgent", why: "Urgent: first, bug or not" };
  const ancestry = ancestors(item, byKey);
  const memberships = ancestry.ok
    ? matches(
        item,
        ancestry.keys,
        ancestorLabels(item, ancestry.keys, byKey),
        records,
      )
    : [];
  const alsoIn = memberships.map((m) => refKey(m.level, m.scope, m.objective));
  if (item.type === "bug" && item.assigned === true)
    return { ...base, ...bugLane(item), alsoIn };
  if (item.isEpic)
    return {
      ...base,
      lane: "excluded",
      alsoIn,
      why: "an epic: its children carry its rank",
    };
  if (allocationBlocked !== null)
    return { ...base, lane: "unallocated", alsoIn, why: allocationBlocked };
  if (records.length === 0)
    return {
      ...base,
      lane: "unallocated",
      why: "no priorities record names any objective",
    };
  if (!ancestry.ok) return { ...base, lane: "excluded", why: ancestry.why };
  if (memberships.length === 0)
    return {
      ...base,
      lane: "unallocated",
      why:
        item.type === "bug"
          ? "an unassigned bug outside every objective"
          : "outside every objective and not a bug",
    };
  return place(base, memberships, alsoIn, records);
}

function bugLane(item: SnapshotItem): { lane: Lane; why: string } {
  if (item.priority === 2)
    return { lane: "bug-high", why: "a High bug: ahead of the weighted lanes" };
  return {
    lane: "bug-other",
    why:
      item.priority === null
        ? "a bug with no priority (a gap): after the bugs whose priority is known"
        : "a Medium or Low bug",
  };
}

/** The lane, owners and placement of an item that belongs to at least one objective. */
function place(
  base: Pick<Classified, "item" | "owners" | "placement" | "alsoIn">,
  memberships: Placement[],
  alsoIn: string[],
  records: readonly PrioritiesRecord[],
): Classified {
  const owners: Partial<Record<Level, string>> = {};
  const firstByLevel = new Map<Level, Placement>();
  for (const m of memberships)
    if (!firstByLevel.has(m.level)) {
      firstByLevel.set(m.level, m);
      owners[m.level] = refKey(m.level, m.scope, m.objective);
    }
  const classes = new Set([...firstByLevel.values()].map((p) => p.class));
  const ownerKeys = new Set(Object.values(owners));
  const reporting = alsoIn.filter((k) => !ownerKeys.has(k));
  if (classes.size > 1)
    return {
      ...base,
      lane: "excluded",
      owners,
      alsoIn: reporting,
      why: `an allocation conflict: its owners name different classes (${[...firstByLevel.values()].map((p) => `${p.level} ${p.objective} is ${p.class}`).join(", ")})`,
    };
  const allocating = records[0]?.level;
  const placement =
    (allocating === undefined ? undefined : firstByLevel.get(allocating)) ??
    [...firstByLevel.values()][0];
  if (placement === undefined)
    return { ...base, lane: "unallocated", why: "outside every objective" };
  return {
    ...base,
    lane: placement.class,
    owners,
    placement,
    alsoIn: reporting,
    why: `allocation owner ${placement.objective} (${placement.class})`,
  };
}

/** The labels the item's available ancestors carry. */
function ancestorLabels(
  item: SnapshotItem,
  keys: readonly string[],
  byKey: Map<string, SnapshotItem>,
): string[] {
  return keys.flatMap((key) => byKey.get(`${item.scope}#${key}`)?.labels ?? []);
}

/** The item's ancestor keys, nearest first; a cycle or an unreadable parent is incomplete evidence. */
function ancestors(
  item: SnapshotItem,
  byKey: Map<string, SnapshotItem>,
): { ok: true; keys: string[] } | { ok: false; why: string } {
  if (item.gaps.includes("parent"))
    return {
      ok: false,
      why: "incomplete evidence: its parent could not be read",
    };
  const keys: string[] = [];
  const seen = new Set([item.key]);
  let parent = item.parent;
  while (parent !== null) {
    if (seen.has(parent))
      return {
        ok: false,
        why: `incomplete evidence: its parents form a cycle through ${parent}`,
      };
    seen.add(parent);
    keys.push(parent);
    const next = byKey.get(`${item.scope}#${parent}`);
    if (next === undefined) break;
    if (next.gaps.includes("parent"))
      return {
        ok: false,
        why: `incomplete evidence: the parent of ${parent} could not be read`,
      };
    parent = next.parent;
  }
  return { ok: true, keys };
}

/** Every objective the item belongs to, in record order within each level. */
function matches(
  item: SnapshotItem,
  ancestorKeys: readonly string[],
  ancestorLabels: readonly string[],
  records: readonly PrioritiesRecord[],
): Placement[] {
  const out: Placement[] = [];
  for (const record of records)
    record.objectives.forEach((objective, objectiveIndex) => {
      const found = findPosition(
        item,
        ancestorKeys,
        ancestorLabels,
        resolvedSelectors(objective, records),
      );
      if (found !== null)
        out.push({
          level: record.level,
          scope: record.scope,
          objective: objective.id,
          objectiveIndex,
          class: objective.class,
          epicPosition: found.position,
          epic: found.epic,
        });
    });
  return out;
}

interface Found {
  position: number;
  epic: string | null;
  depth: number;
}

/** Where `item` sits in an objective's selectors: the nearest named ancestor, else the first label match. */
function findPosition(
  item: SnapshotItem,
  ancestorKeys: readonly string[],
  ancestorLabels: readonly string[],
  selectors: ReturnType<typeof resolvedSelectors>,
): Found | null {
  let position = 0;
  let named: Found | null = null;
  let byLabel: Found | null = null;
  for (const selector of selectors) {
    const keys = selector.keys ?? [];
    const labels = selector.labels ?? [];
    if (selector.scope === item.scope) {
      named = nearestKey(keys, position, named, item, ancestorKeys);
      const at = position + keys.length;
      byLabel ??= firstLabel(labels, at, item, ancestorLabels);
    }
    position += keys.length + labels.length;
  }
  return named ?? byLabel;
}

/** `found`, or the selector's key that sits closer above `item` than it, whose positions start at `from`. */
function nearestKey(
  keys: readonly string[],
  from: number,
  found: Found | null,
  item: SnapshotItem,
  ancestorKeys: readonly string[],
): Found | null {
  let best = found;
  keys.forEach((key, i) => {
    const depth = keyDepth(item, ancestorKeys, key);
    if (closer(depth, best)) best = { position: from + i, epic: key, depth };
  });
  return best;
}

/** The first of a selector's labels that `item` or an ancestor carries, whose positions start at `from`. */
function firstLabel(
  labels: readonly string[],
  from: number,
  item: SnapshotItem,
  ancestorLabels: readonly string[],
): Found | null {
  const i = labels.findIndex((l) => carriesLabel(item, ancestorLabels, l));
  return i < 0 ? null : { position: from + i, epic: null, depth: 0 };
}

function carriesLabel(
  item: SnapshotItem,
  ancestorLabels: readonly string[],
  label: string,
): boolean {
  return item.labels.includes(label) || ancestorLabels.includes(label);
}

/** How far `key` sits above the item: 0 for the item itself, -1 when it is not an ancestor. */
function keyDepth(
  item: SnapshotItem,
  ancestorKeys: readonly string[],
  key: string,
): number {
  if (key === item.key) return 0;
  const at = ancestorKeys.indexOf(key);
  return at < 0 ? -1 : at + 1;
}

/** Whether an ancestor at `depth` beats what is found so far. */
function closer(depth: number, found: Found | null): boolean {
  return depth >= 0 && (found === null || depth < found.depth);
}
