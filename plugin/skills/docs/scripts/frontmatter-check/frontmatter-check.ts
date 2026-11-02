#!/usr/bin/env bun
// Schema-controlled frontmatter gate. Documents are read through the shared
// subset reader (../lib/docs.ts): a construct outside the subset is a
// violation, never a guess. The schema is a maintainer's file, so it is
// parsed once as full YAML (js-yaml, vendored in the plugin's shared/vendor/)
// and every section, `path_rules:` included, is read from what the parser
// returned. A section of the wrong shape is a schema error, never a check
// that silently drops.
import { existsSync, readFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import {
  cli,
  type FieldValue,
  type Frontmatter,
  generatedIndexPath,
  hasValue,
  isDate,
  isGeneratedIndex,
  markdownFiles,
  readDocument,
  readFrontmatter,
  splitLines,
} from "../lib/docs.ts";
import {
  applyPathRules,
  bodyOutsideFences,
  isMap,
  type PathRule,
  readPathRules,
  rulePath,
  unmatchedPrefixes,
} from "./path-rules.ts";

const ENUM_FIELDS = ["type", "status", "lifecycle", "owner"];
const MAX_TAGS = 8;
/** The closing `---` must come within this many lines of the opening one. */
const MAX_FRONTMATTER_LINES = 60;

type Load = (text: string) => unknown;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

interface Enum {
  values: string[];
  suggestions: Map<string, string>;
}

interface Schema {
  required: string[];
  requiredNew: string[];
  canonical: string[];
  adrRequired: string[];
  enums: Map<string, Enum>;
  rules: PathRule[];
  /** Sections the checker cannot use: each one fails the run. */
  errors: string[];
}

/**
 * A list of names, or an error: an absent section is empty, and anything else,
 * an explicit null included, must be a list of text items.
 */
function names(raw: unknown, at: string, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw) && raw.every(isText)) return raw;
  errors.push(`'${at}' must be a list of names`);
  return [];
}

/** An enum section: `values:` a non-empty list, `suggestions:` a map of text. */
function enumSection(field: string, raw: unknown, errors: string[]): Enum {
  const section = isMap(raw) ? raw : {};
  const values = section.values;
  if (!Array.isArray(values) || !values.length || !values.every(isText))
    errors.push(`'${field}.values' must be a non-empty list of values`);
  const suggestions = new Map<string, string>();
  const rawSuggestions =
    section.suggestions === undefined ? {} : section.suggestions;
  if (!isMap(rawSuggestions))
    errors.push(`'${field}.suggestions' must be a mapping`);
  else
    for (const [bad, good] of Object.entries(rawSuggestions))
      if (isText(good)) suggestions.set(bad, good);
      else errors.push(`'${field}.suggestions.${bad}' must name a value`);
  return {
    values: Array.isArray(values) ? values.filter(isText) : [],
    suggestions,
  };
}

/** The ADR's extra required fields, from `type_specific.adr`. */
function adrFields(raw: unknown, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!isMap(raw)) {
    errors.push("'type_specific' must be a mapping of type to fields");
    return [];
  }
  return names(raw.adr, "type_specific.adr", errors);
}

/** Every section the checker reads, from the parsed schema. */
export function schemaFrom(parsed: unknown): Schema {
  const errors: string[] = [];
  const schema = isMap(parsed) ? parsed : {};
  if (!isMap(parsed)) errors.push("the schema must be a mapping of sections");
  const { rules, errors: ruleErrors } = readPathRules(schema);
  return {
    required: names(schema.required, "required", errors),
    requiredNew: names(schema.required_new, "required_new", errors),
    canonical: names(schema.tags, "tags", errors),
    adrRequired: adrFields(schema.type_specific, errors),
    enums: new Map(
      ENUM_FIELDS.map((field) => [
        field,
        enumSection(field, schema[field], errors),
      ]),
    ),
    rules,
    errors: [...errors, ...ruleErrors],
  };
}

async function loadYaml(): Promise<Load> {
  try {
    return (await import("../../../../shared/vendor/js-yaml.mjs")).load;
  } catch (error) {
    throw new Error(
      `the schema is read with shared/vendor/js-yaml.mjs, which did not load: ${String(error)}`,
    );
  }
}

/**
 * Parse the schema file; a file that is not valid YAML is one schema error. A
 * file that cannot be read is an operational error, thrown.
 */
export async function readSchema(
  file: string,
  yaml: () => Promise<Load> = loadYaml,
): Promise<Schema> {
  if (!existsSync(file)) throw new Error(`schema not found: ${file}`);
  const load = await yaml();
  const text = readFileSync(file, "utf8");
  try {
    return schemaFrom(load(text));
  } catch (error) {
    return {
      ...schemaFrom({}),
      errors: [`schema is not valid YAML: ${String(error)}`],
    };
  }
}

const scalar = (value: FieldValue | undefined): string =>
  typeof value === "string" ? value : "";

function checkEnums(schema: Schema, fields: Map<string, FieldValue>): string[] {
  return [...schema.enums].flatMap(([field, { values, suggestions }]) => {
    const value = fields.get(field);
    if (Array.isArray(value))
      return [`${field} must be a single value, not a list`];
    if (!value || values.includes(value)) return [];
    const hint = suggestions.get(value);
    return [
      `invalid ${field} '${value}' (${hint ? `did you mean '${hint}'?` : "not in schema enum"})`,
    ];
  });
}

function checkTags(schema: Schema, value: FieldValue | undefined): string[] {
  if (!hasValue(value)) return [];
  if (!Array.isArray(value))
    return ["tags must be a list: [a, b] or one '- tag' line per member"];
  const errs = value
    .filter((tag) => !schema.canonical.includes(tag))
    .map(
      (tag) =>
        `unknown tag '${tag}' (not in the canonical tag list; add it there or use a listed tag)`,
    );
  if (value.length > MAX_TAGS)
    errs.push(`too many tags (${value.length} > ${MAX_TAGS})`);
  return errs;
}

function missing(
  keys: string[],
  fields: Map<string, FieldValue>,
  label: string,
) {
  return keys
    .filter((key) => !hasValue(fields.get(key)))
    .map((key) => `${label}: ${key}`);
}

function dateErrors(field: string, value: FieldValue | undefined): string[] {
  if (Array.isArray(value))
    return [`${field} must be a single date, not a list`];
  const text = scalar(value);
  return text && !isDate(text)
    ? [`${field} '${text}' is not a YYYY-MM-DD date`]
    : [];
}

/** The ADR fields where `~` (none) is a value: an ADR may supersede nothing. */
const ADR_NULLABLE = new Set(["supersedes", "superseded_by"]);

/**
 * ADR fields must be present with a value; only the supersession fields may
 * hold `~` (or `null`), as in `supersedes: ~`. A blank one is still missing.
 */
function adrErrors(schema: Schema, frontmatter: Frontmatter): string[] {
  const { fields, blank } = frontmatter;
  if (scalar(fields.get("type")) !== "adr") return [];
  const nullable = (key: string) =>
    ADR_NULLABLE.has(key) && fields.get(key) === null && !blank.has(key);
  const absent = (key: string) => !nullable(key) && !hasValue(fields.get(key));
  return [
    ...schema.adrRequired
      .filter(absent)
      .map((key) => `adr missing required field: ${key}`),
    ...dateErrors("decision_date", fields.get("decision_date")),
  ];
}

function checkFields(
  schema: Schema,
  frontmatter: Frontmatter,
  isNew: boolean,
): string[] {
  const { fields } = frontmatter;
  return [
    ...missing(schema.required, fields, "missing required field"),
    ...(isNew
      ? missing(schema.requiredNew, fields, "new doc missing required field")
      : []),
    ...checkEnums(schema, fields),
    ...dateErrors("last_updated", fields.get("last_updated")),
    ...checkTags(schema, fields.get("tags")),
    ...adrErrors(schema, frontmatter),
  ];
}

function checkDocument(
  schema: Schema,
  file: string,
  options: { isNew: boolean; index: string },
): string[] {
  const text = readDocument(file);
  if (resolve(file) === options.index && isGeneratedIndex(text)) return [];
  const lines = splitLines(text);
  const frontmatter = readFrontmatter(text);
  if (!frontmatter.present) return ["no frontmatter (must open with ---)"];
  if (frontmatter.end < 0 || frontmatter.end >= MAX_FRONTMATTER_LINES)
    return [
      `frontmatter not closed within first ${MAX_FRONTMATTER_LINES} lines`,
    ];
  return [
    ...frontmatter.errors.map((error) => `unsupported YAML: ${error}`),
    ...checkFields(schema, frontmatter, options.isNew),
    ...applyPathRules(
      schema.rules,
      rulePath(file),
      frontmatter.fields,
      bodyOutsideFences(lines, frontmatter.end + 1),
    ),
  ];
}

function report(file: string, errors: string[]): number {
  if (!errors.length) return 0;
  console.log(
    `FAIL ${file}\n${errors.map((error) => `  - ${error}`).join("\n")}`,
  );
  return 1;
}

/**
 * Schema errors, with every rule prefix checked against the documents on disk
 * under the docs tree as well as the files named, so a run on a few files
 * still catches a prefix that matches nothing.
 */
function schemaErrors(
  schema: Schema,
  tree: string[],
  files: string[],
): string[] {
  const paths = [...tree, ...files].map((file) => rulePath(file));
  return [...schema.errors, ...unmatchedPrefixes(schema.rules, paths)];
}

/**
 * The new documents: one path per line, so a name may hold spaces. An entry
 * that names no checked file is an error rather than a silently skipped
 * `description` requirement: a space-separated list, or a name git printed
 * quoted, would otherwise match nothing.
 */
function newDocs(
  list: string | undefined,
  files: string[],
): { paths: Set<string>; errors: string[] } {
  const checked = new Set(files.filter(Boolean).map((file) => normalize(file)));
  const paths = new Set<string>();
  const errors: string[] = [];
  for (const entry of (list ?? "").split("\n").filter(Boolean)) {
    const path = normalize(entry);
    if (checked.has(path)) paths.add(path);
    else errors.push(`'${entry}' is not among the files checked`);
  }
  return { paths, errors };
}

export async function checkFrontmatter(
  args = process.argv.slice(2),
  env = process.env,
): Promise<number> {
  const schemaFile = env.SCHEMA || "docs/.frontmatter-schema.yaml";
  const schema = await readSchema(schemaFile);
  const tree = markdownFiles(env.DOCS_DIR || "docs");
  const files = args.length ? args : tree;
  const unusable = schemaErrors(schema, tree, files);
  if (unusable.length) {
    // Against a section it already rejected, every document would fail the
    // check read as empty, burying the errors that name what to fix.
    report(`${schemaFile} (the schema cannot be used as written)`, unusable);
    console.log(
      `ERROR: the schema cannot be used as written, so no document was checked: ${unusable.join("; ")}`,
    );
    return 2;
  }
  let errors = 0;
  const fresh = newDocs(env.NEW_DOCS, files);
  errors += report("NEW_DOCS", fresh.errors);
  const index = resolve(generatedIndexPath(env));
  for (const file of files.filter(Boolean))
    errors += report(
      file,
      checkDocument(schema, file, {
        isNew: fresh.paths.has(normalize(file)),
        index,
      }),
    );
  if (errors) {
    console.log(`\n${errors} file(s) failed frontmatter validation.`);
    return 1;
  }
  console.log("OK — frontmatter valid");
  return 0;
}
if (import.meta.main) cli(() => checkFrontmatter());
