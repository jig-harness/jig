/**
 * The facets' canonical values, and the maps between them and what a
 * tracker keeps (design/tracker-facets.md in the Jig repository).
 *
 * A priority is a number, 1 (urgent) to 4 (low), named `urgent`, `high`,
 * `medium` and `low` in the configuration. A type is a type name of the
 * repository's label taxonomy, or, with no taxonomy, a work type; a size is a
 * label of the taxonomy's size group, and with none there is no size facet.
 *
 * A value map may give a canonical value several tracker names, ignoring
 * case: every one is read as that value and the first is written. No name
 * stands for two values, so a value read back names exactly one. A canonical
 * value the map leaves out is kept under its own name.
 */

import { TrackerConfigError } from "../config-error.ts";
import { firstRepeat } from "../settings-fields.ts";

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

/** A map between a facet's canonical values and a tracker's own. */
export interface ValueMap {
  /** The tracker value a canonical value is written as: its first name. */
  toTracker(value: string): string;
  /** The canonical value a tracker value names, or `null` for none. */
  fromTracker(name: string): string | null;
  /** Every canonical value with the tracker value it is written as, in the facet's order. */
  readonly entries: ReadonlyArray<readonly [string, string]>;
  /** Every canonical value with every name it is read in, the written one first. */
  readonly names: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
}

/** A value map's entry as configured: one name, or several, the first written. */
export type MapNames = string | ReadonlyArray<string>;

/** The names an entry lists, as a list. */
export const namesIn = (names: MapNames): ReadonlyArray<string> =>
  typeof names === "string" ? [names] : names;

/**
 * The map of `values` onto a tracker's values: `explicit` where it names
 * them, else each value's own name. Refused, naming `where`: a key that is
 * no value, a value with no name, a name listed twice for one value, and a
 * name given to two values.
 */
export function valueMap(
  values: ReadonlyArray<string>,
  explicit: Readonly<Record<string, MapNames>>,
  where: string,
): ValueMap {
  for (const [key, listed] of Object.entries(explicit)) {
    if (canonical(values, key) === null)
      throw new TrackerConfigError(
        `${where}.${key}`,
        `${where}.${key} is not a value of the facet (${values.join(", ")})`,
      );
    if (namesIn(listed).length === 0)
      throw new TrackerConfigError(
        `${where}.${key}`,
        `${where}.${key} names no tracker value; list at least one, or leave the value out to keep its own name`,
      );
    const twice = firstRepeat(namesIn(listed));
    if (twice !== undefined)
      throw new TrackerConfigError(
        `${where}.${key}`,
        `${where}.${key} names '${twice}' twice`,
      );
  }
  const names = values.map((v) => {
    const key = Object.keys(explicit).find((k) => fold(k) === fold(v));
    return [
      v,
      key === undefined ? [v] : [...namesIn(explicit[key] as MapNames)],
    ] as const;
  });
  const owner = new Map<string, string>();
  for (const [value, listed] of names)
    for (const name of listed) {
      const other = owner.get(fold(name));
      if (other !== undefined)
        throw new TrackerConfigError(
          where,
          `${where} gives ${other} and ${value} the one tracker value '${name}'; each value needs its own, so a value read back names one`,
        );
      owner.set(fold(name), value);
    }
  const entries = names.map(([v, listed]) => [v, listed[0] as string] as const);
  return {
    entries,
    names,
    toTracker: (value) =>
      entries.find(([v]) => fold(v) === fold(value))?.[1] ?? value,
    fromTracker: (name) => owner.get(fold(name)) ?? null,
  };
}

/**
 * Every name of a map, each with its value, a value's written name first:
 * what a read may meet. None for no map.
 */
export function everyName(
  map: ValueMap | null,
): Array<readonly [string, string]> {
  return (map?.names ?? []).flatMap(([v, names]) =>
    names.map((n) => [v, n] as const),
  );
}

/** The distinct values that name the number `n` in some name of `map`. */
function numberOwners(map: ValueMap | null, n: number): string[] {
  return [
    ...new Set(
      everyName(map)
        .filter(([, t]) => t.trim() !== "" && Number(t) === n)
        .map(([v]) => v),
    ),
  ];
}

/**
 * The value one of whose names is the number `n` (a number field answers
 * with the number, not its configured spelling), or `null` for none, or for
 * several values naming it.
 */
export function numberedValue(map: ValueMap | null, n: number): string | null {
  const owners = numberOwners(map, n);
  return owners.length === 1 ? (owners[0] as string) : null;
}

/** The first number two values both name, or `undefined`. Equivalent names of one value are no clash. */
export function sharedNumber(map: ValueMap | null): number | undefined {
  return everyName(map)
    .map(([, t]) => (t.trim() === "" ? Number.NaN : Number(t)))
    .find((n) => Number.isFinite(n) && numberOwners(map, n).length > 1);
}

/** Whether more than one value names the number `n`. */
export function numberIsShared(map: ValueMap | null, n: number): boolean {
  return numberOwners(map, n).length > 1;
}
