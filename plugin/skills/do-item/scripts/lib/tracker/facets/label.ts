/**
 * The label store: a facet kept as a label per value, on every adapter.
 *
 * A value's first label is the one written; its other labels are read as the
 * same value. Reading an issue's labels gives the one value they name: none
 * names no value, and labels of two different values name none for a type or
 * a size, as two type labels make an item `unknown`. Two priorities read as
 * the more urgent, as the GitHub adapter has always read them. Setting a
 * value writes its label and takes every other label of the facet off.
 */

import type { Facet } from "../port.ts";
import type { ResolvedFacet } from "./config.ts";
import {
  fold,
  PRIORITY_NAMES,
  priorityName,
  priorityNumber,
} from "./values.ts";

export interface LabelCodec {
  readonly facet: Facet;
  /** The value `labels` name, or `null` for none (or two). */
  read(labels: ReadonlyArray<string>): string | null;
  /** The label a value is written as. */
  labelOf(value: string): string;
  /** Whether `label` is one of the facet's labels. */
  owns(label: string): boolean;
  /** The labels to add and remove so an issue carrying `carried` holds `value` (`null`: none). */
  change(
    carried: ReadonlyArray<string>,
    value: string | null,
  ): { add: string[]; remove: string[] };
}

/** The label codec of a facet kept in labels. */
export function labelCodec(f: ResolvedFacet): LabelCodec {
  const entries = f.labels ?? [];
  const valueOfLabel = (label: string): string | null =>
    entries.find(([, ls]) => ls.some((l) => fold(l) === fold(label)))?.[0] ??
    null;
  const labelOf = (value: string): string => {
    const found = entries.find(([v]) => fold(v) === fold(value));
    return (found?.[1][0] ?? value) as string;
  };
  return {
    facet: f.facet,
    read(labels) {
      const named = [
        ...new Set(
          labels.map(valueOfLabel).filter((v): v is string => v !== null),
        ),
      ];
      if (named.length <= 1) return named[0] ?? null;
      if (f.facet !== "priority") return null;
      // The most urgent of several priorities, as GitHub has always read them.
      return (
        PRIORITY_NAMES.find((p) => named.some((n) => fold(n) === p)) ?? null
      );
    },
    labelOf,
    owns: (label) => valueOfLabel(label) !== null,
    change(carried, value) {
      const target = value === null ? null : labelOf(value);
      const add =
        target !== null && !carried.some((l) => fold(l) === fold(target))
          ? [target]
          : [];
      const remove = carried.filter(
        (l) =>
          valueOfLabel(l) !== null &&
          (target === null || fold(l) !== fold(target)),
      );
      return { add, remove };
    },
  };
}

/** A priority number from the priority facet's labels. */
export function priorityFromLabels(
  codec: LabelCodec,
  labels: ReadonlyArray<string>,
): number {
  const name = codec.read(labels);
  return name === null
    ? 0
    : priorityNumber(name as (typeof PRIORITY_NAMES)[number]);
}

/** The label a priority number is written as, or `null` for 0 (none). */
export function priorityLabel(
  codec: LabelCodec,
  priority: number,
): string | null {
  const name = priorityName(priority);
  return name === null ? null : codec.labelOf(name);
}
