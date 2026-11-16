/**
 * Compare the shape vocabulary the Protocol publishes. A stable shape keeps
 * its fields and types and may widen its accepted values. A changed keyword
 * this comparison cannot prove safe requires a chapter version change.
 */
import type { JsonSchema } from "../../plugin/shared/shapes.ts";
import type { Finding } from "../../lib/findings.ts";
import type { DataFile } from "./chapter.ts";

const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "$comment",
]);
const SPECIAL = new Set([
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "allOf",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** Changes a stable schema may not make without its chapter version moving. */
export function schemaChanges(
  before: JsonSchema,
  after: JsonSchema,
  path = "$",
): string[] {
  if (same(before, after) || before === false) return [];
  if (typeof before === "boolean" || typeof after === "boolean")
    return [`${path}: the field's shape changed type`];
  return [
    ...keywordChanges(before, after, path),
    ...fieldChanges(before, after, path),
    ...alternatives(before, after, path),
    ...constraintChanges(before, after, path),
  ];
}

type SchemaObject = Exclude<JsonSchema, boolean>;

function keywordChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(before)) {
    if (ANNOTATIONS.has(key) || SPECIAL.has(key)) continue;
    if (!same(value, after[key])) out.push(`${path}: ${key} changed`);
  }
  for (const key of Object.keys(after))
    if (!(key in before) && !ANNOTATIONS.has(key) && !SPECIAL.has(key))
      out.push(`${path}: ${key} was added`);

  return out;
}

function fieldChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out: string[] = [];
  const oldProperties = object(before.properties);
  const newProperties = object(after.properties);
  for (const [key, value] of Object.entries(oldProperties)) {
    if (!Object.hasOwn(newProperties, key))
      out.push(`${path}.${key}: the field is gone`);
    else
      out.push(
        ...schemaChanges(
          value as JsonSchema,
          newProperties[key] as JsonSchema,
          `${path}.${key}`,
        ),
      );
  }
  const oldRequired = new Set(strings(before.required));
  for (const key of strings(after.required))
    if (!oldRequired.has(key))
      out.push(`${path}.${key}: the field is newly required`);
  return [
    ...out,
    ...newPropertyChanges(before, after, path),
    ...containerChanges(before, after, path),
  ];
}

/** A named field must not restrict values the old open object already accepted. */
function newPropertyChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  if (before.additionalProperties === false) return [];
  const oldProperties = object(before.properties);
  return Object.entries(object(after.properties)).flatMap(([key, value]) => {
    if (Object.hasOwn(oldProperties, key) || value === true) return [];
    return [
      `${path}.${key}: the new field restricts previously unrestricted additional values`,
    ];
  });
}

function containerChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out: string[] = [];
  if (
    before.additionalProperties !== false &&
    after.additionalProperties === false
  )
    out.push(`${path}: additional properties are now refused`);
  if (before.items !== undefined || after.items !== undefined)
    out.push(
      ...schemaChanges(
        (before.items ?? true) as JsonSchema,
        (after.items ?? true) as JsonSchema,
        `${path}[]`,
      ),
    );
  return out;
}

function constraintChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out = rangeChanges(before, after, path);
  if (after.pattern !== undefined && after.pattern !== before.pattern)
    out.push(`${path}: pattern changed or was added`);
  if (
    Object.hasOwn(after, "const") &&
    (!Object.hasOwn(before, "const") || !same(before.const, after.const))
  )
    out.push(`${path}: const changed or was added`);
  const now = after.enum;
  const was = before.enum;
  if (
    Array.isArray(now) &&
    (!Array.isArray(was) || !was.every((v) => now.some((n) => same(v, n))))
  )
    out.push(`${path}: enum narrows accepted values`);
  return out;
}

function rangeChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out: string[] = [];
  for (const key of ["minimum", "minLength", "maximum", "maxLength"] as const) {
    const was = before[key];
    const now = after[key];
    if (now === undefined) continue;
    if (
      typeof was !== "number" ||
      typeof now !== "number" ||
      (key === "minimum" || key === "minLength" ? now > was : now < was)
    )
      out.push(`${path}: ${key} narrows accepted values`);
  }
  return out;
}

function alternatives(
  before: Exclude<JsonSchema, boolean>,
  after: Exclude<JsonSchema, boolean>,
  path: string,
): string[] {
  const out: string[] = [];
  if (Array.isArray(before.anyOf)) {
    if (!Array.isArray(after.anyOf))
      return [`${path}: accepted alternatives changed`];
    const candidates = after.anyOf as JsonSchema[];
    for (const [i, branch] of before.anyOf.entries())
      if (
        !candidates.some(
          (candidate) =>
            schemaChanges(branch as JsonSchema, candidate, path).length === 0,
        )
      )
        out.push(
          `${path}: accepted alternative ${i + 1} was removed or narrowed`,
        );
  } else if (after.anyOf !== undefined)
    out.push(`${path}: accepted alternatives changed`);
  return [...out, ...intersectionChanges(before, after, path)];
}

function intersectionChanges(
  before: SchemaObject,
  after: SchemaObject,
  path: string,
): string[] {
  const out: string[] = [];
  if (before.allOf !== undefined || after.allOf !== undefined) {
    if (
      !Array.isArray(before.allOf) ||
      !Array.isArray(after.allOf) ||
      before.allOf.length !== after.allOf.length
    )
      out.push(`${path}: combined shape constraints changed`);
    else
      before.allOf.forEach((branch, i) => {
        out.push(
          ...schemaChanges(
            branch as JsonSchema,
            (after.allOf as JsonSchema[])[i] as JsonSchema,
            `${path}.allOf[${i}]`,
          ),
        );
      });
  }
  return out;
}

/** Schema promises share the chapter's version and breaking-note rules. */
export function schemaFindings(
  file: string,
  base: DataFile,
  now: DataFile,
): Finding[] {
  return Object.entries(base.schemas ?? {}).flatMap(([name, before]) => {
    const after = now.schemas?.[name];
    const problems =
      after === undefined
        ? [`the schema ${name} the base publishes is gone`]
        : schemaChanges(before, after, name);
    return problems.map(
      (problem): Finding => ({
        rule: "protocol",
        file,
        problem,
        remedy: `keep the stable shape, or raise the chapter's version above ${base.version} and add a breaking change note naming ${base.chapter}.md`,
      }),
    );
  });
}
