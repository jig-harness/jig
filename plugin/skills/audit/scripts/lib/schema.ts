/**
 * The configuration schema (`config-schema.yaml`): every field of
 * `.config/jig.yaml`, and the check of a repository's file against it.
 *
 * The check reports what the skills would do with each value: a key they
 * ignore (unknown, so probably misspelt), a key they refuse (in a strict map,
 * or a refused section), a value of the wrong shape, and a field kept only
 * under an older name.
 */
import { isMapping as isRecord } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import { skillDir, isSince } from "./repo.ts";

export const FIELD_TYPES = [
  "string",
  "command",
  "path",
  "regex",
  "boolean",
  "integer",
  "enum",
  "list",
  "map",
  "any",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A nested value's type: a type name, or a list or map with its own entries' types. */
export type TypeSpec =
  | FieldType
  | { type: FieldType; items?: Items; values_type?: TypeSpec };

/** A list's entries: one type for all, or mappings with a type per key. */
export type Items = TypeSpec | { fields: Record<string, TypeSpec> };

export interface Field {
  path: string;
  type: FieldType;
  values?: string[];
  min?: number;
  pattern?: string;
  nullable?: boolean;
  items?: Items;
  distinct?: boolean;
  nonempty?: boolean;
  keys?: string[];
  values_type?: TypeSpec;
  exists?: "required" | "expected";
  read_by: string[];
  repository_only?: boolean;
  default?: unknown;
  deprecated?: string;
  since?: string;
}

export interface Schema {
  strict: string[];
  refused: Record<string, string>;
  fields: Field[];
}

export type Severity = "error" | "warning" | "suggestion" | "info";

/**
 * One finding about the configuration. `id` is stable across runs, so a team
 * can decline it in the audit record as `config/<id>`.
 */
export interface Finding {
  id: string;
  severity: Severity;
  message: string;
}

const FIELD_KEYS = new Set([
  "type",
  "values",
  "min",
  "pattern",
  "nullable",
  "items",
  "distinct",
  "nonempty",
  "keys",
  "values_type",
  "exists",
  "read_by",
  "repository_only",
  "default",
  "deprecated",
  "since",
]);

function isType(v: unknown): v is FieldType {
  return (FIELD_TYPES as readonly unknown[]).includes(v);
}

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
}

type Entry = Record<string, unknown>;

const SPEC_KEYS = new Set(["type", "items", "values_type"]);

/** Whether `spec` is a type name, or a list or map spec with typed entries. */
function validSpec(spec: unknown): boolean {
  if (isType(spec)) return true;
  if (!isRecord(spec) || !isType(spec.type)) return false;
  if (Object.keys(spec).some((k) => !SPEC_KEYS.has(k))) return false;
  if (spec.type === "list" ? !validItems(spec.items) : spec.items !== undefined)
    return false;
  return spec.values_type === undefined
    ? true
    : spec.type === "map" && validSpec(spec.values_type);
}

/** Whether a list field's `items` is a type spec or maps keys to type specs. */
function validItems(items: unknown): boolean {
  if (validSpec(items)) return true;
  return (
    isRecord(items) &&
    Object.keys(items).length === 1 &&
    isRecord(items.fields) &&
    Object.values(items.fields).every(validSpec)
  );
}

/** A check that `key`, when present, is true or false. */
const flag =
  (key: string) =>
  (e: Entry): string | null =>
    e[key] !== undefined && typeof e[key] !== "boolean"
      ? `${key} must be true or false`
      : null;

/**
 * The checks of one schema entry, in order: each returns what is wrong with
 * the entry, or null. A malformed `pattern` throws the regular expression's
 * own error.
 */
const ENTRY_CHECKS: ((entry: Entry) => string | null)[] = [
  (e) => (isType(e.type) ? null : "unknown type"),
  (e) =>
    stringList(e.read_by) && e.read_by.length > 0
      ? null
      : "read_by must name the skills that read it",
  (e) =>
    e.type === "enum" && !stringList(e.values) ? "an enum needs values" : null,
  (e) =>
    e.values !== undefined && !stringList(e.values)
      ? "values must be a list of words"
      : null,
  (e) =>
    e.min !== undefined && typeof e.min !== "number"
      ? "min must be a number"
      : null,
  (e) => {
    if (e.pattern === undefined) return null;
    if (typeof e.pattern !== "string")
      return "pattern must be a regular expression";
    new RegExp(e.pattern);
    return null;
  },
  (e) =>
    e.keys !== undefined && !stringList(e.keys) ? "keys must be a list" : null,
  (e) =>
    e.values_type !== undefined && !validSpec(e.values_type)
      ? "values_type must be a type"
      : null,
  (e) =>
    e.type === "list" && !validItems(e.items) ? "a list needs items" : null,
  (e) =>
    e.exists !== undefined && e.exists !== "required" && e.exists !== "expected"
      ? "exists is required or expected"
      : null,
  flag("repository_only"),
  (e) =>
    e.default !== undefined &&
    typeProblem(e.default, e.type as FieldType, e as unknown as Field) !== null
      ? "default must be a value the field accepts"
      : null,
  flag("nullable"),
  flag("distinct"),
  flag("nonempty"),
  (e) =>
    e.deprecated !== undefined && typeof e.deprecated !== "string"
      ? "deprecated must be a message"
      : null,
  (e) =>
    e.since !== undefined && !isSince(e.since)
      ? "since must be a version such as 1.2.0, or next until its release"
      : null,
];

/** Parse one field entry; throws naming the field and what is wrong. */
function parseField(path: string, entry: unknown): Field {
  const at = `config schema: ${path}`;
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(path))
    throw new Error(`${at}: a field path is section.field`);
  if (!isRecord(entry)) throw new Error(`${at}: must be a mapping`);
  for (const key of Object.keys(entry))
    if (!FIELD_KEYS.has(key)) throw new Error(`${at}: unknown key ${key}`);
  for (const check of ENTRY_CHECKS) {
    const problem = check(entry);
    if (problem !== null) throw new Error(`${at}: ${problem}`);
  }
  return { path, ...entry } as unknown as Field;
}

/** Parse and check the schema; throws naming the first malformed entry. */
export function parseSchema(raw: unknown): Schema {
  if (!isRecord(raw) || raw.version !== 1)
    throw new Error("config schema: expected version: 1");
  if (!stringList(raw.strict))
    throw new Error("config schema: strict must be a list of field paths");
  if (
    !isRecord(raw.refused) ||
    Object.values(raw.refused).some((m) => typeof m !== "string")
  )
    throw new Error("config schema: refused must map a section to a message");
  if (!isRecord(raw.fields))
    throw new Error("config schema: fields must be a mapping");
  return {
    strict: raw.strict,
    refused: raw.refused as Record<string, string>,
    fields: Object.entries(raw.fields).map(([path, entry]) =>
      parseField(path, entry),
    ),
  };
}

export const SCHEMA_PATH = join(skillDir(), "config-schema.yaml");

export function loadSchema(path = SCHEMA_PATH): Schema {
  return parseSchema(load(readFileSync(path, "utf8")));
}

/** The value at a dotted path of a configuration, or undefined. */
export function at(config: Record<string, unknown>, path: string): unknown {
  let node: unknown = config;
  for (const part of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Edit distance, for the "did you mean" on an unknown key. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

function suggestion(key: string, candidates: string[]): string {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = distance(key, candidate);
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best !== null && bestDistance <= Math.max(2, key.length / 3)
    ? ` Did you mean ${best}?`
    : "";
}

const isText = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

function textProblem(value: unknown, field?: Field): string | null {
  if (!isText(value)) return "must be a nonempty string";
  if (field?.pattern && !new RegExp(field.pattern).test(value))
    return `must match ${field.pattern}`;
  return null;
}

function regexProblem(value: unknown): string | null {
  if (!isText(value)) return "must be a regular expression";
  try {
    new RegExp(value);
    return null;
  } catch (e) {
    return `is not a valid regular expression: ${e instanceof Error ? e.message : e}`;
  }
}

function integerProblem(value: unknown, field?: Field): string | null {
  const words = field?.values ?? [];
  if (typeof value === "string" && words.includes(value)) return null;
  const min = field?.min ?? Number.NEGATIVE_INFINITY;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min)
    return null;
  const bound =
    field?.min === undefined ? "a whole number" : `a whole number ≥ ${min}`;
  return `must be ${[bound, ...words].join(" or ")}`;
}

function enumProblem(value: unknown, field?: Field): string | null {
  const values = field?.values ?? [];
  return values.includes(value as string)
    ? null
    : `must be one of ${values.join(", ")}`;
}

/** What is wrong with a value of a nested type spec, or null. */
function specProblem(value: unknown, spec: TypeSpec): string | null {
  return typeof spec === "string"
    ? typeProblem(value, spec)
    : typeProblem(value, spec.type, spec as Field);
}

/** What is wrong with entry `label` of a list whose items are of `items`. */
function listEntryProblem(
  entry: unknown,
  items: Items,
  label: string,
): string | null {
  if (typeof items === "string" || !("fields" in items)) {
    const problem = specProblem(entry, items);
    return problem ? `${label} ${problem}` : null;
  }
  if (!isRecord(entry)) return `${label} must be a mapping`;
  for (const key of Object.keys(entry))
    if (!Object.hasOwn(items.fields, key))
      return `${label} has unknown key ${key} (known: ${Object.keys(items.fields).join(", ")})`;
  for (const [key, keyType] of Object.entries(items.fields)) {
    const problem =
      entry[key] === undefined
        ? "is missing"
        : specProblem(entry[key], keyType);
    if (problem) return `${label}: ${key} ${problem}`;
  }
  return null;
}

function listProblem(value: unknown, field?: Field): string | null {
  if (!Array.isArray(value)) return "must be a list";
  if (field?.nonempty && value.length === 0) return "must not be empty";
  if (field?.distinct && new Set(value).size !== value.length)
    return "must hold distinct entries";
  const items = field?.items ?? "any";
  for (const [i, entry] of value.entries()) {
    const problem = listEntryProblem(entry, items, `entry ${i + 1}`);
    if (problem) return problem;
  }
  return null;
}

function mapProblem(value: unknown, field?: Field): string | null {
  if (!isRecord(value)) return "must be a mapping";
  for (const [key, entry] of Object.entries(value)) {
    if (field?.keys && !field.keys.includes(key))
      return `has unknown key ${key} (known: ${field.keys.join(", ")})`;
    const problem = specProblem(entry, field?.values_type ?? "string");
    if (problem) return `entry ${key} ${problem}`;
  }
  return null;
}

/** What is wrong with a value of each type, or null. */
const TYPE_PROBLEMS: Record<
  FieldType,
  (value: unknown, field?: Field) => string | null
> = {
  string: textProblem,
  command: textProblem,
  path: textProblem,
  regex: regexProblem,
  boolean: (value) =>
    typeof value === "boolean" ? null : "must be true or false",
  integer: integerProblem,
  enum: enumProblem,
  list: listProblem,
  map: mapProblem,
  any: () => null,
};

function typeProblem(
  value: unknown,
  type: FieldType,
  field?: Field,
): string | null {
  return TYPE_PROBLEMS[type](value, field);
}

/** What the walk over a configuration knows about the schema. */
interface SchemaIndex {
  schema: Schema;
  byPath: Map<string, Field>;
  /** Every section path above a field, such as `review` and `review.taxonomy`. */
  prefixes: Set<string>;
}

function indexSchema(schema: Schema): SchemaIndex {
  const prefixes = new Set<string>();
  for (const field of schema.fields) {
    const parts = field.path.split(".");
    for (let i = 1; i < parts.length; i++)
      prefixes.add(parts.slice(0, i).join("."));
  }
  return {
    schema,
    byPath: new Map(schema.fields.map((f) => [f.path, f])),
    prefixes,
  };
}

/** The keys the schema knows directly under `prefix` (the top level for ""). */
function knownKeys(index: SchemaIndex, prefix: string): string[] {
  if (!prefix) return [...index.prefixes].filter((p) => !p.includes("."));
  return [...index.byPath.keys(), ...index.prefixes]
    .filter((p) => p.startsWith(`${prefix}.`))
    .map((p) => p.slice(prefix.length + 1).split(".")[0] ?? "");
}

/** A known field's value: null where it is not nullable, the wrong shape, an older name. */
function knownFieldFindings(
  path: string,
  value: unknown,
  field: Field,
): Finding[] {
  const findings: Finding[] = [];
  const problem = value === null ? null : typeProblem(value, field.type, field);
  if (value === null && !field.nullable)
    findings.push({
      id: `null:${path}`,
      severity: "info",
      message: `${path} is null, which the skills read as not set; remove it or give it a value`,
    });
  if (problem)
    findings.push({
      id: `type:${path}`,
      severity: "error",
      message: `${path} ${problem}`,
    });
  if (field.deprecated)
    findings.push({
      id: `deprecated:${path}`,
      severity: "warning",
      message: `${path} is an older name: ${field.deprecated}`,
    });
  return findings;
}

function unknownKeyFinding(
  index: SchemaIndex,
  prefix: string,
  key: string,
  path: string,
): Finding {
  const strict = index.schema.strict.includes(prefix);
  return {
    id: `unknown:${path}`,
    severity: strict ? "error" : "warning",
    message: `${path} is not a Jig field: ${
      strict
        ? "the skills refuse an unknown key here."
        : "the skills ignore it, so a misspelt field keeps its default."
    }${suggestion(key, knownKeys(index, prefix))}`,
  };
}

/** A section's findings: none when null, an error when not a mapping, else its keys'. */
function sectionFindings(
  index: SchemaIndex,
  path: string,
  value: unknown,
): Finding[] {
  if (value === null) return [];
  if (!isRecord(value))
    return [
      {
        id: `type:${path}`,
        severity: "error",
        message: `${path} must be a mapping`,
      },
    ];
  return walk(index, value, path);
}

/** The findings for one key of the configuration. */
function keyFindings(
  index: SchemaIndex,
  prefix: string,
  key: string,
  value: unknown,
): Finding[] {
  const path = prefix ? `${prefix}.${key}` : key;
  if (!prefix && Object.hasOwn(index.schema.refused, key))
    return [
      {
        id: `refused:${key}`,
        severity: "error",
        message: `${key} is refused: ${index.schema.refused[key]}`,
      },
    ];
  const field = index.byPath.get(path);
  if (field) return knownFieldFindings(path, value, field);
  if (index.prefixes.has(path)) return sectionFindings(index, path, value);
  return [unknownKeyFinding(index, prefix, key, path)];
}

function walk(
  index: SchemaIndex,
  node: Record<string, unknown>,
  prefix: string,
): Finding[] {
  return Object.entries(node).flatMap(([key, value]) =>
    keyFindings(index, prefix, key, value),
  );
}

/**
 * Check a parsed configuration against the schema. Reports every key the
 * schema does not know (an error inside a strict map, a warning elsewhere,
 * since the skills ignore it there), every refused section, every value of
 * the wrong shape and every field kept under a deprecated name.
 */
export function checkConfig(
  config: Record<string, unknown>,
  schema: Schema,
): Finding[] {
  return walk(indexSchema(schema), config, "");
}
