/**
 * Check one issue's labels against the repository's label taxonomy.
 *
 * Errors (the label set may not be written):
 *   - an empty label, or one with whitespace around its name (the tracker
 *     adapter resolves names exactly, so a set is checked as it is written);
 *   - a label the taxonomy does not define (not a type, group label, flag,
 *     closed category label, or slug of an open category);
 *   - an open category's label whose slug does not match its pattern;
 *   - no type, or more than one;
 *   - more than one label of a group, or none of a required group;
 *   - a category's or flag's `requires` unmet (a facet without its umbrella);
 *   - a flag's `requires_category` unmet (a flag without any of its facets).
 * Warnings (the label set may be written):
 *   - more labels of a category than its `max`;
 *   - no label of a `recommended` category.
 */
import type { LabelCategory, Taxonomy } from "./taxonomy.ts";

/**
 * The family maps have no prototype, so a family whose id is an
 * `Object.prototype` name (`__proto__`, `constructor`) reads as absent until
 * one of its labels is added.
 */
export interface ParsedLabels {
  types: string[];
  /** Group id → its labels on the issue. */
  groups: Record<string, string[]>;
  /** Category id → its labels on the issue. */
  categories: Record<string, string[]>;
  flags: string[];
  unknown: string[];
}

export interface Validation {
  valid: boolean;
  labels: string[];
  errors: string[];
  warnings: string[];
  parsed: ParsedLabels;
}

/** The category whose prefix `label` begins with; prefixes never nest. */
function categoryOf(
  label: string,
  categories: LabelCategory[],
): LabelCategory | undefined {
  return categories.find((c) => label.startsWith(c.prefix));
}

/** A family's labels on the issue; none when the map has no entry for it. */
const of = (map: Record<string, string[]>, key: string) =>
  Object.hasOwn(map, key) ? (map[key] as string[]) : [];

const add = (map: Record<string, string[]>, key: string, label: string) => {
  map[key] = [...of(map, key), label];
};

/** Sort each label into its family; `errors` gets a bad open-category slug. */
function parse(labels: string[], taxonomy: Taxonomy, errors: string[]) {
  const parsed: ParsedLabels = {
    types: [],
    groups: Object.create(null),
    categories: Object.create(null),
    flags: [],
    unknown: [],
  };
  const flags = new Set(taxonomy.flags.map((f) => f.id));
  for (const label of labels) {
    const group = taxonomy.groups.find((g) => g.labels.includes(label));
    const category = categoryOf(label, taxonomy.categories);
    if (taxonomy.types.includes(label)) parsed.types.push(label);
    else if (group) add(parsed.groups, group.id, label);
    else if (flags.has(label)) parsed.flags.push(label);
    else if (category?.labels.includes(label))
      add(parsed.categories, category.id, label);
    else if (category?.open) {
      const slug = label.slice(category.prefix.length);
      if (slug && category.open.test(slug))
        add(parsed.categories, category.id, label);
      else
        errors.push(
          `'${label}' is not a valid '${category.prefix}' label: its slug must match ${category.open.source}`,
        );
    } else parsed.unknown.push(label);
  }
  return parsed;
}

/**
 * Whether the taxonomy defines `label`: a type, a group label, a flag, a
 * closed category label, or an open category's label whose slug matches.
 */
export function declaresLabel(taxonomy: Taxonomy, label: string): boolean {
  const errors: string[] = [];
  return (
    parse([label], taxonomy, errors).unknown.length === 0 && errors.length === 0
  );
}

/** The labels the issue lacks of `required`. */
const lacking = (present: Set<string>, required: string[]) =>
  required.filter((label) => !present.has(label));

const quoted = (labels: string[]) => labels.map((l) => `'${l}'`).join(", ");

/** Unknown labels, and the one-type rule. */
function typeErrors(parsed: ParsedLabels, taxonomy: Taxonomy): string[] {
  const errors: string[] = [];
  const { unknown, types } = parsed;
  if (unknown.length)
    errors.push(
      `unknown label${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (not in the taxonomy)`,
    );
  if (types.length === 0)
    errors.push(`no type label (one of: ${taxonomy.types.join(", ")})`);
  else if (types.length > 1)
    errors.push(`more than one type label: ${types.join(", ")} (pick one)`);
  return errors;
}

/** At most one label of each group, and one of each required group. */
function groupErrors(parsed: ParsedLabels, taxonomy: Taxonomy): string[] {
  return taxonomy.groups.flatMap((group) => {
    const found = of(parsed.groups, group.id);
    if (found.length > 1)
      return [
        `more than one label of group '${group.id}': ${found.join(", ")} (pick one)`,
      ];
    if (found.length === 0 && group.required)
      return [
        `no label of required group '${group.id}' (one of: ${group.labels.join(", ")})`,
      ];
    return [];
  });
}

/** A category's `requires` beside its labels (errors), `max` and `recommended` (warnings). */
function categoryChecks(
  category: LabelCategory,
  found: string[],
  present: Set<string>,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing = found.length ? lacking(present, category.requires) : [];
  if (missing.length) {
    const many = found.length > 1;
    errors.push(
      `${found.join(", ")} require${many ? "" : "s"} ${quoted(missing)} beside ${many ? "them" : "it"} (category '${category.id}')`,
    );
  }
  if (category.max !== null && found.length > category.max)
    warnings.push(
      `${found.length} labels of category '${category.id}', more than its recommended ${category.max}`,
    );
  if (category.recommended && found.length === 0)
    warnings.push(
      `no label of category '${category.id}' (labels beginning '${category.prefix}'); consider adding one`,
    );
  return { errors, warnings };
}

/** Each present flag's `requires` and `requires_category`. */
function flagErrors(
  parsed: ParsedLabels,
  taxonomy: Taxonomy,
  present: Set<string>,
): string[] {
  return taxonomy.flags
    .filter((flag) => present.has(flag.id))
    .flatMap((flag) => {
      const missing = lacking(present, flag.requires);
      const errors = missing.length
        ? [`'${flag.id}' requires ${quoted(missing)} beside it`]
        : [];
      for (const id of flag.requiresCategory)
        if (!of(parsed.categories, id).length) {
          const prefix = taxonomy.categories.find((c) => c.id === id)?.prefix;
          errors.push(
            `'${flag.id}' requires at least one label of category '${id}' (${prefix}…) beside it`,
          );
        }
      return errors;
    });
}

/** Whether `labels` is a label set the taxonomy allows on one issue. */
export function validateLabels(
  input: string[],
  taxonomy: Taxonomy,
): Validation {
  const errors: string[] = [];
  if (input.some((l) => !l.trim()))
    errors.push("an empty label (every label needs a name)");
  const padded = input.filter((l) => l.trim() && l.trim() !== l);
  if (padded.length)
    errors.push(
      `whitespace around ${quoted(padded)} (write the exact name: ${quoted(padded.map((l) => l.trim()))})`,
    );
  const labels = [...new Set(input.filter((l) => l.trim() === l && l))];
  const warnings: string[] = [];
  const parsed = parse(labels, taxonomy, errors);
  const present = new Set(labels);
  errors.push(
    ...typeErrors(parsed, taxonomy),
    ...groupErrors(parsed, taxonomy),
  );
  for (const category of taxonomy.categories) {
    const checks = categoryChecks(
      category,
      of(parsed.categories, category.id),
      present,
    );
    errors.push(...checks.errors);
    warnings.push(...checks.warnings);
  }
  errors.push(...flagErrors(parsed, taxonomy, present));
  return { valid: errors.length === 0, labels, errors, warnings, parsed };
}
