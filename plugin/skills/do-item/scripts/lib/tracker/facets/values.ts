/**
 * The facets' canonical values, and the maps between them and what a
 * tracker keeps (design/tracker-facets.md in the Jig repository).
 *
 * A priority is a number, 1 (urgent) to 4 (low), named `urgent`, `high`,
 * `medium` and `low` in the configuration. A type is a type name of the
 * repository's label taxonomy, or, with no taxonomy, a work type; a size is a
 * label of the taxonomy's size group, and with none there is no size facet.
 *
 * A value map is one to one, ignoring case: a value read back names exactly
 * one canonical value. A canonical value the map leaves out is kept under
 * its own name.
 */

import { TrackerConfigError } from "../config-error.ts";

/** The priorities, 1 (urgent) to 4 (low), by the names the configuration uses. */
export const PRIORITY_NAMES = ["urgent", "high", "medium", "low"] as const;
export type PriorityName = (typeof PRIORITY_NAMES)[number];

/** The work types every repository has unless `issue_tracker.types` says otherwise. */
export const DEFAULT_TYPES = [
  "bug",
  "feature",
  "improvement",
  "task",
  "spike",
] as const;

/** A name as values are compared: trimmed, ignoring case. */
export const fold = (s: string): string => s.trim().toLowerCase();

/** The name of priority 1 to 4, or `null` for 0 (none). */
export function priorityName(priority: number): PriorityName | null {
  return priority === 0 ? null : (PRIORITY_NAMES[priority - 1] ?? null);
}

/** The number of a priority name. */
export function priorityNumber(name: PriorityName): number {
  return PRIORITY_NAMES.indexOf(name) + 1;
}

/**
 * The canonical value `value` names among `values`, ignoring case, or
 * `null` when it names none.
 */
export function canonical(
  values: ReadonlyArray<string>,
  value: string,
): string | null {
  return values.find((v) => fold(v) === fold(value)) ?? null;
}

/** A one-to-one map between a facet's canonical values and a tracker's own. */
export interface ValueMap {
  /** The tracker value a canonical value is kept as. */
  toTracker(value: string): string;
  /** The canonical value a tracker value names, or `null` for none. */
  fromTracker(name: string): string | null;
  /** Every canonical value with its tracker value, in the facet's order. */
  readonly entries: ReadonlyArray<readonly [string, string]>;
}

/**
 * The map of `values` onto a tracker's values: `explicit` where it names
 * one, else each value's own name. Refused, naming `where`: a key that is
 * no value, and two values given one tracker value.
 */
export function valueMap(
  values: ReadonlyArray<string>,
  explicit: Readonly<Record<string, string>>,
  where: string,
): ValueMap {
  for (const key of Object.keys(explicit))
    if (canonical(values, key) === null)
      throw new TrackerConfigError(
        `${where}.${key}`,
        `${where}.${key} is not a value of the facet (${values.join(", ")})`,
      );
  const entries = values.map((v) => {
    const key = Object.keys(explicit).find((k) => fold(k) === fold(v));
    return [v, key === undefined ? v : (explicit[key] as string)] as const;
  });
  const owner = new Map<string, string>();
  for (const [value, name] of entries) {
    const other = owner.get(fold(name));
    if (other !== undefined)
      throw new TrackerConfigError(
        where,
        `${where} gives ${other} and ${value} the one tracker value '${name}'; each value needs its own, so a value read back names one`,
      );
    owner.set(fold(name), value);
  }
  return {
    entries,
    toTracker: (value) =>
      entries.find(([v]) => fold(v) === fold(value))?.[1] ?? value,
    fromTracker: (name) => owner.get(fold(name)) ?? null,
  };
}
