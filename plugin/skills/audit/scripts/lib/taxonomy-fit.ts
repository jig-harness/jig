/**
 * Whether the tracker labels a repository configures exist in its label
 * taxonomy (M9's `label-taxonomy.yaml`), and whether the configuration's
 * copies of the taxonomy's key sets still equal it.
 *
 * The taxonomy is the file `issue_tracker.taxonomy` names, the one the
 * `file-issue` skill validates labels against. Without that field it is
 * found: a tracked `label-taxonomy.yaml` (or `.yml`) outside examples and
 * vendored code. A repository without one has nothing to check here; the
 * criteria score the absent practice, and the schema's path check reports a
 * configured file that does not exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { load } from "../../../../shared/yaml.ts";
import { taxonomyAt } from "../../../file-issue/scripts/lib/config.ts";
import { compileOpenPattern } from "../../../file-issue/scripts/lib/taxonomy.ts";
import { probedFiles } from "./criteria.ts";
import { at, type Finding } from "./schema.ts";

const TAXONOMY_NAMES = new Set(["label-taxonomy.yaml", "label-taxonomy.yml"]);

/**
 * Label roles naming one label, and roles naming a list of them. A role's
 * older field under `review.taxonomy` declares it too. Size labels
 * (`batch_sizes`) are checked only against a taxonomy that declares groups,
 * where a size group can hold them, and `pattern_prefix` never, because it is
 * a prefix, not a label.
 */
const SINGLE_ROLES = ["epic", "hitl", "manual_ops", "followup"];
const LIST_ROLES = ["bug", "extractable_tails"];
const LEGACY_FIELDS: Record<string, string> = {
  epic: "review.taxonomy.epic_label",
  followup: "review.taxonomy.provenance_label",
};

interface Taxonomy {
  types: Set<string>;
  flags: Set<string>;
  /** Every group label and closed category label, by full name. */
  labels: Set<string>;
  /** The group labels alone: the only labels a size can be. */
  groupLabels: Set<string>;
  /** The categories' prefixes, each with its open pattern; `null` = closed. */
  categories: { prefix: string; open: RegExp | null }[];
  hasGroups: boolean;
}

/** The taxonomy cannot establish the vocabulary: why, for the finding. */
function unreadable(reason: string): never {
  throw new Error(reason);
}

/**
 * The ids of a section's entries: a list of mappings, each with an `id`. A
 * section of any other shape cannot establish the vocabulary, so it throws
 * rather than reading as empty; `types` must also be non-empty.
 *
 * An id is read exactly as the label-taxonomy lint reads it (`taxonomyEntry`
 * in the `file-issue` skill's `scripts/lib/taxonomy.ts`): a string, trimmed,
 * and not empty. A YAML number
 * or boolean (`id: 1`, `id: true`) is not a name, so the lint rejects the file
 * and this check leaves it unchecked rather than accepting it.
 */
function ids(section: unknown, name: string, required = false) {
  if (!required && (section === undefined || section === null))
    return new Set<string>();
  if (!Array.isArray(section) || (required && !section.length))
    unreadable(`'${name}' is not a non-empty list`);
  return new Set(
    section.map((entry) => {
      const id = isMapping(entry) ? entry.id : undefined;
      const text = typeof id === "string" ? id.trim() : "";
      if (!text) unreadable(`a '${name}' entry has no single id`);
      return text;
    }),
  );
}

/** The entries of an optional section of families (`groups`, `categories`). */
function families(parsed: Record<string, unknown>, name: string) {
  const section = parsed[name];
  if (section === undefined || section === null) return [];
  if (!Array.isArray(section) || !section.every(isMapping))
    unreadable(`'${name}' is not a list of mappings`);
  return section;
}

/**
 * A category's `open:` pattern, compiled as the label validator compiles it
 * (against the whole slug); `null` for a closed category.
 */
function openPattern(value: unknown, prefix: string): RegExp | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim())
    unreadable(`category '${prefix}' has an 'open:' that is not a pattern`);
  try {
    return compileOpenPattern(value);
  } catch {
    return unreadable(
      `category '${prefix}' has an 'open:' that does not compile`,
    );
  }
}

function parseTaxonomy(root: string, path: string): Taxonomy {
  const parsed: unknown = load(readFileSync(taxonomyAt(root, path), "utf8"));
  if (!isMapping(parsed)) unreadable("it is not a mapping");
  const groups = families(parsed, "groups");
  const categories = families(parsed, "categories");
  const labels = new Set<string>();
  const groupLabels = new Set<string>();
  for (const group of groups)
    for (const id of ids(group.labels, "groups.labels")) {
      labels.add(id);
      groupLabels.add(id);
    }
  const prefixed: Taxonomy["categories"] = [];
  for (const category of categories) {
    const prefix = typeof category.prefix === "string" ? category.prefix : "";
    if (!prefix) unreadable("a category has no prefix");
    prefixed.push({ prefix, open: openPattern(category.open, prefix) });
    for (const id of ids(category.labels, "categories.labels"))
      labels.add(`${prefix}${id}`);
  }
  return {
    types: ids(parsed.types, "types", true),
    flags: ids(parsed.flags, "flags"),
    labels,
    groupLabels,
    categories: prefixed,
    hasGroups: groups.length > 0,
  };
}

const known = (label: string, taxonomy: Taxonomy) =>
  taxonomy.types.has(label) ||
  taxonomy.flags.has(label) ||
  taxonomy.labels.has(label);

/**
 * A label passes when the taxonomy defines it (a type, flag, group label or
 * closed category label), or when it is a prefixed form of a defined label:
 * a facet `<flag>:<facet>` of a defined flag, or a group-prefixed
 * `<group>:<label>` such as `type:bug`. A label carrying a category's prefix
 * is that category's alone: it passes only as one of its closed labels or,
 * for an open category, as a slug its pattern matches.
 */
function defined(label: string, taxonomy: Taxonomy): boolean {
  if (known(label, taxonomy)) return true;
  const category = taxonomy.categories.find((c) => label.startsWith(c.prefix));
  if (category) {
    const slug = label.slice(category.prefix.length);
    return slug !== "" && (category.open?.test(slug) ?? false);
  }
  const colon = label.indexOf(":");
  if (colon <= 0) return false;
  return (
    taxonomy.flags.has(label.slice(0, colon)) ||
    known(label.slice(colon + 1), taxonomy)
  );
}

/** The labels the repository's own file names in one field; defaults are not the repository's choice. */
function configuredLabels(config: Record<string, unknown>, field: string) {
  const value = at(config, field);
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Every configuration field naming a role's labels. */
const roleFields = (role: string) =>
  [`issue_tracker.labels.${role}`, LEGACY_FIELDS[role]].filter(
    (f): f is string => f !== undefined,
  );

function labelFindings(
  config: Record<string, unknown>,
  taxonomy: Taxonomy,
  path: string,
): Finding[] {
  const finding = (field: string, unknown: string[], what: string) =>
    unknown.length
      ? [
          {
            id: `taxonomy:${field}`,
            severity: "warning" as const,
            message: `${field} names ${unknown.join(", ")}, which ${path} does not define as ${what}`,
          },
        ]
      : [];
  const roleChecks = [...SINGLE_ROLES, ...LIST_ROLES]
    .flatMap(roleFields)
    .flatMap((field) =>
      finding(
        field,
        configuredLabels(config, field).filter(
          (label) => !defined(label, taxonomy),
        ),
        "a label",
      ),
    );
  if (!taxonomy.hasGroups) return roleChecks;
  const sizes = roleFields("batch_sizes").flatMap((field) =>
    finding(
      field,
      configuredLabels(config, field).filter(
        (label) => !taxonomy.groupLabels.has(label),
      ),
      "a group label",
    ),
  );
  return [...roleChecks, ...sizes];
}

/**
 * A copy of a key set kept outside its source drifts silently, so the copy
 * must equal the source exactly: a subset check would miss a type added to
 * the taxonomy alone.
 */
function typeCopyFindings(
  config: Record<string, unknown>,
  taxonomy: Taxonomy,
  path: string,
): Finding[] {
  const copy = at(config, "review.taxonomy.types");
  if (!Array.isArray(copy)) return [];
  const configured = new Set(copy.filter((t) => typeof t === "string"));
  const onlyConfig = [...configured].filter((t) => !taxonomy.types.has(t));
  const onlyTaxonomy = [...taxonomy.types].filter((t) => !configured.has(t));
  if (!onlyConfig.length && !onlyTaxonomy.length) return [];
  const sides = [
    onlyConfig.length ? `not in ${path}: ${onlyConfig.join(", ")}` : "",
    onlyTaxonomy.length
      ? `missing from the configuration: ${onlyTaxonomy.join(", ")}`
      : "",
  ].filter(Boolean);
  return [
    {
      id: "taxonomy:review.taxonomy.types",
      severity: "warning",
      message: `review.taxonomy.types differs from the types in ${path} (${sides.join("; ")})`,
    },
  ];
}

/** Every finding about the configuration against the repository's label taxonomy. */
export function taxonomyFindings(
  config: Record<string, unknown>,
  root: string,
  tracked: readonly string[],
): Finding[] {
  const configured = at(config, "issue_tracker.taxonomy");
  if (typeof configured === "string" && configured.trim() !== "") {
    if (!existsSync(taxonomyAt(root, configured))) return [];
    // Read the file the file-issue skill reads; only its name in a finding is
    // spelled with forward slashes. A backslash separates only on Windows,
    // elsewhere it is part of a name, and normalizing the path that is read
    // would turn a Windows network or extended-length path into another one.
    const named =
      process.platform === "win32"
        ? configured.replaceAll("\\", "/")
        : configured;
    return checkAgainst(config, root, configured, posix.normalize(named));
  }
  const found = probedFiles(tracked).filter((f) =>
    TAXONOMY_NAMES.has(basename(f)),
  );
  const path = found[0];
  if (path === undefined) return [];
  if (found.length > 1)
    return [
      {
        id: "unchecked:label-taxonomy",
        severity: "info",
        message: `more than one label taxonomy (${found.join(", ")}); the configured labels are unchecked`,
      },
    ];
  return checkAgainst(config, root, path);
}

/**
 * The findings against the taxonomy read from `file`, relative to `root`,
 * named `path` in each finding.
 */
function checkAgainst(
  config: Record<string, unknown>,
  root: string,
  file: string,
  path = file,
): Finding[] {
  let taxonomy: Taxonomy;
  try {
    taxonomy = parseTaxonomy(root, file);
  } catch (e) {
    return [
      {
        id: "unchecked:label-taxonomy",
        severity: "warning",
        message: `${path} could not be read as a label taxonomy: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  return [
    ...labelFindings(config, taxonomy, path),
    ...typeCopyFindings(config, taxonomy, path),
  ];
}
