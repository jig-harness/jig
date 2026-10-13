/**
 * Whether the tracker labels a repository configures exist in its label
 * taxonomy (M9's `label-taxonomy.yaml`), and whether the configuration's
 * copies of the taxonomy's key sets still equal it.
 *
 * The taxonomy is found, not declared: a tracked `label-taxonomy.yaml` (or
 * `.yml`) outside examples and vendored code. A repository without one has
 * nothing to check here; the criteria score the absent practice.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import { probedFiles } from "./criteria.ts";
import { at, type Finding } from "./schema.ts";

const TAXONOMY_NAMES = new Set(["label-taxonomy.yaml", "label-taxonomy.yml"]);

/**
 * Label roles naming one label, and roles naming a list of them. A role's
 * older field under `review.taxonomy` declares it too. Size labels
 * (`batch_sizes`) are left out because the taxonomy has no section for them,
 * and `pattern_prefix` because it is a prefix, not a label.
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
}

/**
 * The ids of a section's entries: a list of mappings, each with an `id`. A
 * section of any other shape cannot establish the vocabulary, so it throws
 * rather than reading as empty; `types` must also be non-empty.
 *
 * An id is read exactly as M9's label-taxonomy lint reads it (`taxonomyEntry`
 * in `lib/module-gates.ts`): a string, trimmed, and not empty. A YAML number
 * or boolean (`id: 1`, `id: true`) is not a name, so the lint rejects the file
 * and this check leaves it unchecked rather than accepting it.
 */
function ids(parsed: Record<string, unknown>, name: "types" | "flags") {
  const section = parsed[name];
  if (name === "flags" && (section === undefined || section === null))
    return new Set<string>();
  if (!Array.isArray(section) || (name === "types" && !section.length))
    throw new Error(`'${name}' is not a non-empty list`);
  return new Set(
    section.map((entry) => {
      const id = isMapping(entry) ? entry.id : undefined;
      const text = typeof id === "string" ? id.trim() : "";
      if (!text) throw new Error(`a '${name}' entry has no single id`);
      return text;
    }),
  );
}

function parseTaxonomy(root: string, path: string): Taxonomy {
  const parsed: unknown = load(readFileSync(join(root, path), "utf8"));
  if (!isMapping(parsed)) throw new Error("it is not a mapping");
  return { types: ids(parsed, "types"), flags: ids(parsed, "flags") };
}

const known = (label: string, taxonomy: Taxonomy) =>
  taxonomy.types.has(label) || taxonomy.flags.has(label);

/**
 * A label passes when the taxonomy defines it, or when it is a prefixed form
 * of a defined label: a facet `<flag>:<facet>` of a defined flag, or a
 * group-prefixed `<group>:<label>` such as `type:bug`.
 */
function defined(label: string, taxonomy: Taxonomy): boolean {
  if (known(label, taxonomy)) return true;
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
  return [...SINGLE_ROLES, ...LIST_ROLES]
    .flatMap(roleFields)
    .flatMap((field) => {
      const unknown = configuredLabels(config, field).filter(
        (label) => !defined(label, taxonomy),
      );
      return unknown.length
        ? [
            {
              id: `taxonomy:${field}`,
              severity: "warning" as const,
              message: `${field} names ${unknown.join(", ")}, which ${path} does not define as a type or flag`,
            },
          ]
        : [];
    });
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
  let taxonomy: Taxonomy;
  try {
    taxonomy = parseTaxonomy(root, path);
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
