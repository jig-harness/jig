/**
 * Work types: the closed list of kinds of work a repository declares, the
 * labels that mark each, and the depth table that says how much each delivery
 * station does for an item of that type (design/work-types.md in the Jig
 * repository).
 *
 *   issue_tracker:
 *     types:                       # type → the labels that mark it
 *       bug: [bug, type:bug]       # default: issue_tracker.labels.bug
 *       feature: [feature, type:feature]
 *   do_item:
 *     work_types:                  # type → the fields of its row it overrides
 *       task: { review_skip_lines: 80 }
 *
 * The effective type set is the keys of `issue_tracker.types`, or the default
 * list when the field is unset. A default type left out of the map is dropped
 * with its row; a type outside the default list has no default row, so it
 * must carry a complete one. `unknown` is never a key: it is what the
 * derivation answers when nothing identifies the type, and its row is
 * computed from the others, field by field, as the strictest of each.
 */

import { isRecord } from "../../../../shared/guards.ts";
import { parseTrackerLabels } from "../../../../shared/tracker-labels.ts";
import { formatField } from "../../../../shared/config-layers.ts";
import { doItemSection } from "./overlay.ts";

/** The types every repository has unless `issue_tracker.types` says otherwise. */
export const DEFAULT_TYPES = [
  "bug",
  "feature",
  "improvement",
  "task",
  "spike",
] as const;

/** The type of an item none of the derivation's steps identifies. */
export const UNKNOWN_TYPE = "unknown";

/** A type name: lowercase, as labels and title prefixes are matched. */
const TYPE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * A work-type setting the loading rules refuse. The message opens with the
 * field at fault, so a caller can name the file or variable that set it.
 */
export class WorkTypesError extends Error {
  readonly code = "work_types_config";
}

/** The pre-scouts a row may name: the pattern pre-scout, the linked spec. */
export const PRE_SCOUTS = ["pattern", "spec"] as const;
/** Strictest first. */
export const TEST_FIRST = [
  "required",
  "new_behaviour",
  "as_needed",
  "none",
] as const;
export const REVIEW_TIERS = [1, 2, 3] as const;
export const CHANGE_NOTE = ["required", "not_required"] as const;
/** Strictest first. */
export const BATCHABLE = ["no", "within_batch_sizes", "yes"] as const;
/** Strictest first. */
export const AUTONOMY = ["hitl", "full"] as const;

/**
 * `review_skip_lines`: the most changed lines at which the review is skipped,
 * `never` (always reviewed), or `none` (the row has no review to skip).
 */
export type ReviewSkip = number | "never" | "none";

/** One row of the depth table. */
export interface DepthRow {
  pre_scouts: Array<(typeof PRE_SCOUTS)[number]>;
  test_first: (typeof TEST_FIRST)[number];
  review_tiers: number[];
  review_skip_lines: ReviewSkip;
  change_note: (typeof CHANGE_NOTE)[number];
  batchable: (typeof BATCHABLE)[number];
  autonomy: (typeof AUTONOMY)[number];
  pr_body_sections: string[];
}

export const DEPTH_FIELDS = [
  "pre_scouts",
  "test_first",
  "review_tiers",
  "review_skip_lines",
  "change_note",
  "batchable",
  "autonomy",
  "pr_body_sections",
] as const satisfies ReadonlyArray<keyof DepthRow>;

type DefaultType = (typeof DEFAULT_TYPES)[number];

/** The depth table's defaults. */
export const DEFAULT_ROWS: Readonly<Record<DefaultType, Readonly<DepthRow>>> = {
  bug: {
    pre_scouts: ["pattern"],
    test_first: "required",
    review_tiers: [1, 3],
    review_skip_lines: 20,
    change_note: "required",
    batchable: "within_batch_sizes",
    autonomy: "full",
    pr_body_sections: ["reproduction", "cause", "fix"],
  },
  feature: {
    pre_scouts: ["spec"],
    test_first: "new_behaviour",
    review_tiers: [1, 2, 3],
    review_skip_lines: "never",
    change_note: "required",
    batchable: "no",
    autonomy: "full",
    pr_body_sections: ["requirements_covered", "left_out"],
  },
  improvement: {
    pre_scouts: ["spec"],
    test_first: "as_needed",
    review_tiers: [1, 2, 3],
    review_skip_lines: 20,
    change_note: "required",
    batchable: "within_batch_sizes",
    autonomy: "full",
    pr_body_sections: ["before_and_after"],
  },
  task: {
    pre_scouts: [],
    test_first: "none",
    review_tiers: [1],
    review_skip_lines: 50,
    change_note: "not_required",
    batchable: "yes",
    autonomy: "full",
    pr_body_sections: ["what_changed"],
  },
  spike: {
    pre_scouts: [],
    test_first: "none",
    review_tiers: [],
    review_skip_lines: "none",
    change_note: "not_required",
    batchable: "no",
    autonomy: "hitl",
    pr_body_sections: ["findings", "recommendation"],
  },
};

/** The repository's types: which there are, what marks each, and each one's row. */
export interface WorkTypes {
  /** The effective type set, in the order the repository declares it. */
  types: string[];
  /** Type → the labels that mark it. */
  labels: Record<string, string[]>;
  /** Type → its effective row: the default, with the repository's overrides. */
  rows: Record<string, DepthRow>;
}

const isDefaultType = (t: string): t is DefaultType =>
  (DEFAULT_TYPES as readonly string[]).includes(t);

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  )
    throw new WorkTypesError(`${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function distinctList<T>(
  value: unknown,
  field: string,
  what: string,
  valid: (x: unknown) => x is T,
): T[] {
  if (
    !Array.isArray(value) ||
    !value.every(valid) ||
    new Set(value).size !== value.length
  )
    throw new WorkTypesError(`${field} must be a list of distinct ${what}`);
  return [...value];
}

const nonEmptyText = (x: unknown): x is string =>
  typeof x === "string" && x.trim() !== "";

/** One field of a row, validated; throws naming the field. */
function parseField<K extends keyof DepthRow>(
  key: K,
  value: unknown,
  field: string,
): DepthRow[K] {
  const parsers: { [F in keyof DepthRow]: () => DepthRow[F] } = {
    pre_scouts: () =>
      distinctList(
        value,
        field,
        `pre-scouts (${PRE_SCOUTS.join(", ")})`,
        (x): x is (typeof PRE_SCOUTS)[number] =>
          (PRE_SCOUTS as readonly unknown[]).includes(x),
      ),
    test_first: () => oneOf(value, TEST_FIRST, field),
    review_tiers: () =>
      distinctList(
        value,
        field,
        `review tiers (${REVIEW_TIERS.join(", ")})`,
        (x): x is number => (REVIEW_TIERS as readonly unknown[]).includes(x),
      ).sort((a, b) => a - b),
    review_skip_lines: () => {
      if (value === "never" || value === "none") return value;
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        return value;
      throw new WorkTypesError(
        `${field} must be a whole number of changed lines, never or none`,
      );
    },
    change_note: () => oneOf(value, CHANGE_NOTE, field),
    batchable: () => oneOf(value, BATCHABLE, field),
    autonomy: () => oneOf(value, AUTONOMY, field),
    pr_body_sections: () =>
      distinctList(value, field, "nonempty section names", nonEmptyText),
  };
  return parsers[key]() as DepthRow[K];
}

/** The type → labels map, before the rows: `issue_tracker.types` or the defaults. */
function parseTypeLabels(
  overlay: Record<string, unknown>,
): Record<string, string[]> {
  const trackerLabels = parseTrackerLabels(overlay);
  const tracker = overlay.issue_tracker;
  const raw = isRecord(tracker) ? tracker.types : undefined;
  const labels: Record<string, string[]> = Object.create(null);
  if (raw === undefined || raw === null) {
    for (const t of DEFAULT_TYPES)
      labels[t] = t === "bug" ? [...trackerLabels.bug] : [t, `type:${t}`];
    return labels;
  }
  if (!isRecord(raw) || Object.keys(raw).length === 0)
    throw new WorkTypesError(
      "issue_tracker.types must map at least one type to the labels that mark it",
    );
  for (const [type, list] of Object.entries(raw)) {
    const field = `issue_tracker.types.${formatField([type])}`;
    if (type === UNKNOWN_TYPE)
      throw new WorkTypesError(
        `${field}: unknown is not a type a repository declares; it is what an item gets when nothing identifies its type`,
      );
    if (!TYPE_NAME.test(type))
      throw new WorkTypesError(
        `${field}: a type name is lowercase letters, digits, - and _, starting with a letter`,
      );
    labels[type] = distinctList(
      list,
      field,
      "nonempty label names",
      nonEmptyText,
    );
  }
  const bug = labels.bug;
  if (
    bug !== undefined &&
    trackerLabels.declared.has("bug") &&
    !sameLabels(bug, trackerLabels.bug)
  )
    throw new WorkTypesError(
      `issue_tracker.types.bug (${bug.join(", ")}) and issue_tracker.labels.bug (${trackerLabels.bug.join(", ")}) name different labels; keep one, or make them agree`,
    );
  return labels;
}

const fold = (label: string) => label.trim().toLowerCase();

function sameLabels(a: string[], b: string[]): boolean {
  const left = new Set(a.map(fold));
  const right = new Set(b.map(fold));
  return left.size === right.size && [...left].every((l) => right.has(l));
}

/** Refuse a label two types list: the first step could not decide between them. */
function refuseSharedLabels(labels: Record<string, string[]>): void {
  const owner = new Map<string, string>();
  for (const [type, list] of Object.entries(labels))
    for (const label of list) {
      const other = owner.get(fold(label));
      if (other !== undefined && other !== type)
        throw new WorkTypesError(
          `issue_tracker.types.${formatField([type])} lists the label '${label}', which issue_tracker.types.${formatField([other])} lists too; a label marks one type`,
        );
      owner.set(fold(label), type);
    }
}

/** `do_item.work_types`, each entry checked against the type set. */
function parseOverrides(
  overlay: Record<string, unknown>,
  types: string[],
): Record<string, Partial<DepthRow>> {
  const section = doItemSection(overlay);
  if (section !== undefined && section !== null && !isRecord(section))
    throw new WorkTypesError("do_item must be a mapping");
  const raw = isRecord(section) ? section.work_types : undefined;
  const out: Record<string, Partial<DepthRow>> = Object.create(null);
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw))
    throw new WorkTypesError(
      "do_item.work_types must map a type to the fields of its row",
    );
  for (const [type, entry] of Object.entries(raw)) {
    const at = `do_item.work_types.${formatField([type])}`;
    if (type === UNKNOWN_TYPE)
      throw new WorkTypesError(
        `${at}: the unknown type's row is computed from the others, as the strictest value of each field, and cannot be set`,
      );
    if (!types.includes(type))
      throw new WorkTypesError(
        `${at}: ${type} is not a type of this repository (${types.join(", ")}); add it to issue_tracker.types or remove the entry`,
      );
    if (!isRecord(entry))
      throw new WorkTypesError(`${at} must be a mapping of depth-table fields`);
    const row: Partial<DepthRow> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!(DEPTH_FIELDS as readonly string[]).includes(key))
        throw new WorkTypesError(
          `${at}.${formatField([key])} is not a depth-table field (${DEPTH_FIELDS.join(", ")})`,
        );
      const k = key as keyof DepthRow;
      (row as Record<string, unknown>)[k] = parseField(
        k,
        value,
        `${at}.${key}`,
      );
    }
    out[type] = row;
  }
  return out;
}

/**
 * The repository's work types from a parsed overlay. Throws, naming the
 * field, on a type with no complete row, a `do_item.work_types` entry for a
 * type outside the set, `unknown` as a key, a label listed under two types,
 * and any value of the wrong shape.
 */
export function parseWorkTypes(overlay: Record<string, unknown>): WorkTypes {
  const labels = parseTypeLabels(overlay);
  const types = Object.keys(labels);
  const overrides = parseOverrides(overlay, types);
  refuseSharedLabels(labels);
  const rows: Record<string, DepthRow> = Object.create(null);
  for (const type of types) {
    const own = overrides[type] ?? {};
    if (isDefaultType(type)) {
      rows[type] = { ...structuredClone(DEFAULT_ROWS[type]), ...own };
      continue;
    }
    const missing = DEPTH_FIELDS.filter((f) => own[f] === undefined);
    if (missing.length > 0)
      throw new WorkTypesError(
        `do_item.work_types.${formatField([type])}: ${type} is not a default type, so it has no default row; set every field (missing: ${missing.join(", ")})`,
      );
    rows[type] = own as DepthRow;
  }
  return { types, labels, rows };
}

function union<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (const list of lists)
    for (const x of list) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * The row of an item whose type cannot be derived: field by field, the
 * strictest of the effective rows. No single row is the deepest in every
 * field, and failing to derive a type does not show the item is not a spike,
 * so autonomy is `hitl`. An override that lightens one type cannot lighten
 * this row: the constant fields are the strictest values there are, and the
 * lists are unions.
 */
export function unknownRow(workTypes: WorkTypes): DepthRow {
  const rows = workTypes.types.map((t) => workTypes.rows[t] as DepthRow);
  return {
    pre_scouts: union(rows.map((r) => r.pre_scouts)),
    test_first: "required",
    review_tiers: union(rows.map((r) => r.review_tiers)).sort((a, b) => a - b),
    review_skip_lines: "never",
    change_note: "required",
    batchable: "no",
    autonomy: "hitl",
    pr_body_sections: union(rows.map((r) => r.pr_body_sections)),
  };
}

/** The effective row of a type, or the computed row of `unknown`. */
export function depthOf(workTypes: WorkTypes, type: string): DepthRow {
  const row = Object.hasOwn(workTypes.rows, type)
    ? workTypes.rows[type]
    : undefined;
  return row ?? unknownRow(workTypes);
}
