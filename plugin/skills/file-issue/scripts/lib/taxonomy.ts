/**
 * A repository's label taxonomy (`label-taxonomy.yaml`): its schema, the lint
 * that keeps it a closed vocabulary of process triggers, and the model the
 * label validator reads.
 *
 * Schema (`version: 1`; every key below `flags` is optional):
 *
 *   version     an integer stamp
 *   types       closed, non-empty: what kind of work an issue is; exactly one
 *               per issue
 *   statuses    closed, non-empty: workflow states, not labels
 *   flags       labels that fire a process: each declares `fires`, `scope`
 *               (`shipping-item` or `container`) and `apply_when`, and may
 *               declare `do_not_apply_when`, `requires` (labels that must all
 *               be present beside it) and `requires_category` (categories of
 *               which at least one label each must be present beside it)
 *   groups      closed single-select families beyond `types` (a size, a
 *               repository): at most one label of a group per issue, and one
 *               when the group is `required`
 *   categories  prefixed multi-select families (`area:billing`): a label's
 *               name is the category's `prefix` and its id. A category lists
 *               its `labels`, accepts any slug `open` matches (a regular
 *               expression matched against the whole slug), or both; it
 *               may set `max` and `recommended` (warnings) and `requires`
 *               (labels that must all be present whenever one of its labels is)
 *
 * Every entry may also carry `notes`; any other key, at the top level or in
 * an entry, is reported, so a misspelt rule (`requred:`) is never read as an
 * absent one. A type, flag or group label may not begin with a category's
 * prefix, so every label belongs to exactly one family.
 *
 * The file is read with a full YAML parser that rejects a repeated key, so
 * every spelling of an entry (flow or block, quoted or plain) is checked
 * alike. A field must be a text or a list of non-empty texts; anything else (a
 * null list member, a list-valued id, a number) is reported, never read as
 * absent.
 */
import { readFileSync } from "node:fs";
import { load } from "../../../../shared/yaml.ts";

const TAXONOMY_KEYS = [
  "version",
  "types",
  "statuses",
  "flags",
  "groups",
  "categories",
];
const SCHEMA = TAXONOMY_KEYS.join("/");
/** The keys an entry of each kind may carry. */
const ENTRY_KEYS: Record<string, string[]> = {
  types: ["id", "notes"],
  statuses: ["id", "notes"],
  flags: [
    "id",
    "notes",
    "fires",
    "scope",
    "apply_when",
    "do_not_apply_when",
    "requires",
    "requires_category",
  ],
  groups: ["id", "notes", "required", "labels"],
  categories: [
    "id",
    "notes",
    "prefix",
    "labels",
    "open",
    "max",
    "recommended",
    "requires",
  ],
  label: ["id", "notes"],
};
const FLAG_SCOPES = ["shipping-item", "container"];

/** A single-select family: at most one of its labels per issue. */
export interface LabelGroup {
  id: string;
  required: boolean;
  labels: string[];
}

/** A prefixed multi-select family; a label's name is `prefix` + its id. */
export interface LabelCategory {
  id: string;
  prefix: string;
  /** The closed labels, by full name (prefix included). */
  labels: string[];
  /** The slug pattern an open category accepts after the prefix. */
  open: RegExp | null;
  max: number | null;
  recommended: boolean;
  requires: string[];
}

export interface LabelFlag {
  id: string;
  requires: string[];
  requiresCategory: string[];
}

/** A taxonomy that passed the lint, as the validator reads it. */
export interface Taxonomy {
  types: string[];
  statuses: string[];
  flags: LabelFlag[];
  groups: LabelGroup[];
  categories: LabelCategory[];
}

/** What the lint found: the problems, and how many entries each section has. */
export interface TaxonomyLint {
  /** The file linted, when the lint read one. */
  path?: string;
  problems: string[];
  count: Record<string, number>;
  /** Set only when there are no problems. */
  taxonomy: Taxonomy | null;
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A field's values: one text, or a list of texts. An absent, null or empty
 * field has none. `undefined` means the field holds something else (a number,
 * a mapping, a list with a null or empty member), which the caller reports
 * rather than reading as absent.
 */
function textValues(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  return items.every(Boolean) ? items : undefined;
}

type Entry = { id: string; entry: Record<string, unknown> };

/** One entry with its id, or the problem that keeps it from having one. */
function taxonomyEntry(where: string, entry: unknown): Entry | string {
  if (!isMapping(entry)) return `a '${where}' entry is not a mapping`;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (id) return { id, entry };
  return [undefined, null, ""].includes(entry.id as string)
    ? `a '${where}' entry has no id`
    : `a '${where}' entry has an id that is not a single name`;
}

/** The keys of an entry its kind does not allow. */
function unknownKeys(where: string, { id, entry }: Entry, kind: string) {
  const allowed = ENTRY_KEYS[kind] ?? [];
  return Object.keys(entry)
    .filter((key) => !allowed.includes(key))
    .map(
      (key) =>
        `'${where}' entry '${id}' has an unknown key '${key}:' (allowed: ${allowed.join(", ")})`,
    );
}

/**
 * A list's entries with their ids, and the problems of those without one or
 * with a key their kind does not allow.
 */
function entriesOf(where: string, list: unknown[], kind: string) {
  const found = list.map((entry) => taxonomyEntry(where, entry));
  const entries = found.filter((f): f is Entry => typeof f !== "string");
  return {
    entries,
    problems: [
      ...found.filter((f): f is string => typeof f === "string"),
      ...entries.flatMap((e) => unknownKeys(where, e, kind)),
    ],
  };
}

/** One section's entries: its list, or a problem saying why it has none. */
function sectionEntries(
  doc: Record<string, unknown>,
  section: string,
): { list: unknown[]; problem?: string } {
  const value = doc[section],
    required = section === "types" || section === "statuses";
  if (value === undefined && required)
    return {
      list: [],
      problem: `missing required top-level key '${section}:'`,
    };
  if (value !== undefined && value !== null && !Array.isArray(value))
    return { list: [], problem: `'${section}:' is not a list` };
  const list = Array.isArray(value) ? value : [];
  return required && !list.length
    ? {
        list,
        problem: `'${section}:' is empty (must be a closed, non-empty list)`,
      }
    : { list };
}

/** A field's text values, reporting a value that is not text. */
function texts(
  problems: string[],
  what: string,
  entry: Record<string, unknown>,
  name: string,
): string[] {
  const found = textValues(entry[name]);
  if (found) return found;
  problems.push(
    `${what} has a '${name}:' that is not a text or a list of non-empty texts`,
  );
  return [];
}

/** A boolean field, or `false` when absent; reports any other value. */
function flagField(
  problems: string[],
  what: string,
  entry: Record<string, unknown>,
  name: string,
): boolean {
  const value = entry[name];
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  problems.push(`${what} has a '${name}:' that is not true or false`);
  return false;
}

/** What is wrong with one flag on its own, and what it requires. */
function readFlag({ id, entry }: Entry, problems: string[]): LabelFlag {
  const what = `flag '${id}'`;
  const values = (name: string) => {
    const found = textValues(entry[name]);
    if (!found)
      problems.push(
        `${what} has a '${name}:' that is not a text or a list of non-empty texts`,
      );
    return found;
  };
  if (values("fires")?.length === 0)
    problems.push(
      `${what} declares no 'fires:' (a flag label with no process trigger is folksonomy)`,
    );
  const scope = values("scope");
  if (scope?.length === 0)
    problems.push(
      `${what} declares no 'scope:' (${FLAG_SCOPES.join(" or ")}: which item the flag goes on)`,
    );
  else if (scope && (scope.length > 1 || !FLAG_SCOPES.includes(scope[0] || "")))
    problems.push(
      `${what} has scope '${scope.join(", ")}' (must be ${FLAG_SCOPES.join(" or ")})`,
    );
  if (values("apply_when")?.length === 0)
    problems.push(
      `${what} declares no 'apply_when:' (when the flag applies must be a rule, not habit)`,
    );
  if (
    Object.hasOwn(entry, "do_not_apply_when") &&
    values("do_not_apply_when")?.length === 0
  )
    problems.push(`${what} has an empty 'do_not_apply_when:'`);
  return {
    id,
    requires: values("requires") ?? [],
    requiresCategory: values("requires_category") ?? [],
  };
}

/** A group: its own fields and its labels' ids. */
function readGroup({ id, entry }: Entry, problems: string[]): LabelGroup {
  const what = `group '${id}'`;
  const required = flagField(problems, what, entry, "required");
  let labels: string[] = [];
  if (!Array.isArray(entry.labels) || entry.labels.length === 0)
    problems.push(`${what} declares no 'labels:' (must be a non-empty list)`);
  else {
    const read = entriesOf(`groups.${id}.labels`, entry.labels, "label");
    problems.push(...read.problems);
    labels = read.entries.map((e) => e.id);
  }
  return { id, required, labels };
}

/** A category's closed labels, by full name. */
function categoryLabels(
  what: string,
  { id, entry }: Entry,
  prefix: string,
  problems: string[],
): string[] {
  if (entry.labels === undefined || entry.labels === null) return [];
  if (!Array.isArray(entry.labels)) {
    problems.push(`${what} has a 'labels:' that is not a list`);
    return [];
  }
  const read = entriesOf(`categories.${id}.labels`, entry.labels, "label");
  problems.push(...read.problems);
  return read.entries.map((e) => `${prefix}${e.id}`);
}

/**
 * An `open:` pattern as it applies: to the whole slug, so `[a-z]+` accepts
 * `flaky` but not `Foo bar`. A pattern that anchors itself is unchanged in
 * effect. Throws when it does not compile.
 */
export function compileOpenPattern(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

/** A category's `open:` pattern, compiled; `null` when absent or broken. */
function openPattern(
  what: string,
  value: unknown,
  problems: string[],
): RegExp | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    problems.push(`${what} has an 'open:' that is not a regular expression`);
    return null;
  }
  try {
    return compileOpenPattern(value);
  } catch (e) {
    problems.push(
      `${what} has an 'open:' that does not compile: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** A category's `max:`, a positive integer; `null` when absent or wrong. */
function maxField(what: string, value: unknown, problems: string[]) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1)
    return value;
  problems.push(`${what} has a 'max:' that is not a positive integer`);
  return null;
}

/** A category: its prefix, its closed labels by full name, and its rules. */
function readCategory(read: Entry, problems: string[]): LabelCategory {
  const { id, entry } = read;
  const what = `category '${id}'`;
  const prefix = typeof entry.prefix === "string" ? entry.prefix : "";
  if (!prefix.trim())
    problems.push(`${what} declares no 'prefix:' (a non-empty text)`);
  const labels = categoryLabels(what, read, prefix, problems);
  const open = openPattern(what, entry.open, problems);
  // A category with no labels and no `open:` value (absent or `null`)
  // accepts nothing.
  if (!labels.length && (entry.open === undefined || entry.open === null))
    problems.push(
      `${what} declares neither 'labels:' nor 'open:' (a category needs one or both)`,
    );
  return {
    id,
    prefix,
    labels,
    open,
    max: maxField(what, entry.max, problems),
    recommended: flagField(problems, what, entry, "recommended"),
    requires: texts(problems, what, entry, "requires"),
  };
}

/** Each repeat of a name in `names`, once per repeat. */
function repeats(names: string[], message: (name: string) => string) {
  const seen = new Set<string>();
  return names.flatMap((name) => {
    if (seen.has(name)) return [message(name)];
    seen.add(name);
    return [];
  });
}

/** No category's prefix may begin another's, or a label could be either's. */
function prefixProblems(categories: LabelCategory[]): string[] {
  const problems: string[] = [];
  for (const a of categories)
    for (const b of categories)
      if (a !== b && a.prefix && b.prefix.startsWith(a.prefix))
        if (
          a.prefix !== b.prefix ||
          categories.indexOf(a) < categories.indexOf(b)
        )
          problems.push(
            `category '${a.id}' has prefix '${a.prefix}', which begins category '${b.id}''s prefix '${b.prefix}'`,
          );
  return problems;
}

/**
 * No type, flag or group label may begin with a category's prefix: the
 * validator would read it as the explicit label and never apply the
 * category's rules to it.
 */
function prefixedNameProblems(
  names: string[],
  categories: LabelCategory[],
): string[] {
  return names.flatMap((name) =>
    categories
      .filter((c) => c.prefix && name.startsWith(c.prefix))
      .map(
        (c) =>
          `label '${name}' begins category '${c.id}''s prefix '${c.prefix}' (a category's prefix is its own: rename the label or make it one of the category's labels)`,
      ),
  );
}

const NOT_DEFINED =
  "which is not a type, group label, flag or category label in this file";

/** A flag's `requires` and `requires_category` must name what the file defines. */
function flagReferenceProblems(
  flag: LabelFlag,
  categoryIds: Set<string>,
  labels: Set<string>,
): string[] {
  const problems = flag.requires.flatMap((required) => {
    if (required === flag.id) return [`flag '${flag.id}' requires itself`];
    return labels.has(required)
      ? []
      : [`flag '${flag.id}' requires '${required}', ${NOT_DEFINED}`];
  });
  for (const category of flag.requiresCategory)
    if (!categoryIds.has(category))
      problems.push(
        `flag '${flag.id}' has requires_category '${category}', which is not a category in this file`,
      );
  return problems;
}

/** A category's `requires` must name labels the file defines, not its own. */
function categoryReferenceProblems(
  category: LabelCategory,
  labels: Set<string>,
): string[] {
  return category.requires.flatMap((required) => {
    if (category.labels.includes(required))
      return [
        `category '${category.id}' requires '${required}', one of its own labels`,
      ];
    return labels.has(required)
      ? []
      : [`category '${category.id}' requires '${required}', ${NOT_DEFINED}`];
  });
}

/** Every `requires` and `requires_category` must name what the file defines. */
function referenceProblems(
  flags: LabelFlag[],
  categories: LabelCategory[],
  labels: Set<string>,
): string[] {
  const categoryIds = new Set(categories.map((c) => c.id));
  return [
    ...flags.flatMap((f) => flagReferenceProblems(f, categoryIds, labels)),
    ...categories.flatMap((c) => categoryReferenceProblems(c, labels)),
  ];
}

/** Every problem in a parsed taxonomy, and the taxonomy when there are none. */
export function lintTaxonomy(doc: unknown): TaxonomyLint {
  const count: Record<string, number> = {};
  if (!isMapping(doc))
    return {
      count,
      taxonomy: null,
      problems: [`the file is not a mapping (schema is ${SCHEMA})`],
    };
  const problems = Object.keys(doc)
    .filter((key) => !TAXONOMY_KEYS.includes(key))
    .map((key) => `unknown top-level key '${key}:' (schema is ${SCHEMA})`);
  const sections: Record<string, Entry[]> = {};
  for (const section of TAXONOMY_KEYS.slice(1)) {
    const { list, problem } = sectionEntries(doc, section);
    if (problem) problems.push(problem);
    count[section] = list.length;
    const read = entriesOf(section, list, section);
    problems.push(...read.problems);
    sections[section] = read.entries;
  }
  const ids = (section: string) => (sections[section] ?? []).map((e) => e.id);
  const flags = (sections.flags ?? []).map((e) => readFlag(e, problems));
  const groups = (sections.groups ?? []).map((e) => readGroup(e, problems));
  const categories = (sections.categories ?? []).map((e) =>
    readCategory(e, problems),
  );
  const names = [
    ...ids("types"),
    ...ids("statuses"),
    ...ids("flags"),
    ...groups.flatMap((g) => g.labels),
    ...categories.flatMap((c) => c.labels),
  ];
  problems.push(...repeats(names, (name) => `duplicate label id '${name}'`));
  problems.push(
    ...repeats(
      ["types", "statuses", "flags", ...ids("groups"), ...ids("categories")],
      (id) =>
        `duplicate family id '${id}' (each group and category needs its own id, other than types, statuses and flags)`,
    ),
  );
  problems.push(...prefixProblems(categories));
  problems.push(
    ...prefixedNameProblems(
      [...ids("types"), ...ids("flags"), ...groups.flatMap((g) => g.labels)],
      categories,
    ),
  );
  const labels = new Set([
    ...ids("types"),
    ...ids("flags"),
    ...groups.flatMap((g) => g.labels),
    ...categories.flatMap((c) => c.labels),
  ]);
  problems.push(...referenceProblems(flags, categories, labels));
  return {
    count,
    problems,
    taxonomy: problems.length
      ? null
      : {
          types: ids("types"),
          statuses: ids("statuses"),
          flags,
          groups,
          categories,
        },
  };
}

/** A YAML parse failure as a lint problem; a repeated key names the key. */
function yamlProblem(e: unknown, raw: string): string {
  const { reason, mark, message } = e as {
    reason?: string;
    mark?: { line: number; column: number };
    message?: string;
  };
  if (reason !== "duplicated mapping key" || !mark)
    return `not valid YAML: ${reason || message || String(e)}`;
  const at = (raw.split("\n")[mark.line] || "").slice(mark.column);
  const key = at.match(/^["']?([^"':]+)["']?\s*:/)?.[1] || at.trim();
  return mark.column === 0
    ? `duplicate top-level key '${key}:'`
    : `duplicate '${key}:' field on line ${mark.line + 1}`;
}

/** The lint over a taxonomy's text. */
export function lintTaxonomyText(raw: string): TaxonomyLint {
  try {
    return lintTaxonomy(load(raw));
  } catch (e) {
    return { count: {}, taxonomy: null, problems: [yamlProblem(e, raw)] };
  }
}

/** The lint over a taxonomy file; throws when the file cannot be read. */
export function lintTaxonomyFile(path: string): TaxonomyLint {
  return lintTaxonomyText(readFileSync(path, "utf8"));
}
