#!/usr/bin/env bun
// Every request input field declares a bound, and the count of those that
// do not only falls.
//
// The rule it holds. A request field with no bound (a string with no
// maximum length, a number with no maximum, an array with no maximum item
// count, a field with no type at all) accepts whatever a caller sends, and
// what it accepts the system stores, indexes, logs and forwards. The bound
// belongs in the contract, where the validator enforces it and the consumer
// reads it. A contract already carrying unbounded fields does not become
// clean in one change, so the count is held under a ratchet: it may fall,
// never rise.
//
// What it does. Reads one contract document (OpenAPI, JSON or YAML) and
// walks every operation's request inputs: the parameters (query, path,
// header, cookie) and the request body's schemas, through local `$ref`s,
// `allOf`/`oneOf`/`anyOf`, object properties, additional properties and
// array items. A `$ref` and the keywords beside it, and the parts of an
// `allOf`, all hold at once, so they are read as one schema; each part of a
// `oneOf` or `anyOf` is an alternative, judged together with the keywords
// around it, since those hold for every alternative, and with one
// alternative of every other `oneOf`/`anyOf` that holds beside it. A field
// reached through several alternatives is one field and one finding. A
// keyword that admits values the walk does not follow (`prefixItems`,
// `patternProperties`) stops it rather than leave them uncounted. Each field with no bound is a finding
// with its place (`POST /orders body.items[].name`).
// A field that is unbounded on purpose carries the `--extension` field with
// a reason and is counted as accepted; one that carries it without a reason
// is a finding at any count. With `--base`, the same count is taken over the
// document at the merge base of the base branch and the head (read from
// git, never the working tree), and the head's count may not exceed it;
// with `--max`, the count may not exceed the ceiling; with neither, any
// unbounded field fails.
//
// Exit codes: 0 the count holds, 1 it does not, 2 could not check (the
// document missing, unreadable, empty or not a contract, no operation under
// `paths`, a reference the gate cannot follow, a keyword or a request
// container present in a shape the gate cannot read, a parameter declared
// twice in one list, alternatives that combine into more cases than the
// walk's budget, a base that names no commit, a document absent at the
// base, a bad option).
//
// Usage:
//   count-unbounded-inputs.ts [--max <n>] [--base <ref>] [--repo <dir>]
//     [--extension x-unbounded] <contract>
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { type Finding, reportFindings } from "../../../../lib/findings.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import {
  followRefs,
  InputError,
  isRecord,
  type Operation,
  operations,
  optionValue,
  parseContract,
  readContract,
  resolvePointer,
} from "./shared.ts";

const RULE = "unbounded-input";
const usage =
  "usage: count-unbounded-inputs.ts [--max <n>] [--base <ref>] [--repo <dir>] [--extension <x-name>] <contract>";

/** One request field with no bound, where it is and what it lacks. */
export interface UnboundedField {
  /** `METHOD /path place`, the place a dotted path into the input. */
  location: string;
  problem: string;
}

export interface Count {
  unbounded: UnboundedField[];
  /** Fields unbounded on purpose, with a reason in the extension field. */
  accepted: number;
  /**
   * Fields that carry the extension without a reason. Each fails the gate
   * at any count: an exception is accepted only as a decision with its
   * reason beside it.
   */
  invalid: UnboundedField[];
}

/** The type names a schema's `type` may carry. */
const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);

const BOUNDS = {
  string: ["maxLength", "pattern", "format"],
  number: ["maximum", "exclusiveMaximum"],
  integer: ["maximum", "exclusiveMaximum"],
} as const;

const nonNegativeInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const nonEmptyString = (value: unknown) =>
  typeof value === "string" && value !== "";
const nonEmptyList = (value: unknown) =>
  Array.isArray(value) && value.length > 0;
const schemaLike = (value: unknown) =>
  typeof value === "boolean" || isRecord(value);
const typeName = (value: unknown) =>
  typeof value === "string" && TYPES.has(value);
const typeList = (value: unknown) =>
  typeName(value) ||
  (nonEmptyList(value) && (value as unknown[]).every(typeName));

/**
 * The shape each keyword the walk reads must have. A keyword present in
 * another shape (`maxLength: null`, `maxItems: "many"`, an empty `enum` or
 * `allOf`, an empty `pattern`, which accepts every string) is not a bound
 * the gate can count, so the walk stops rather than guess.
 */
const SHAPES: Record<string, [valid: (value: unknown) => boolean, is: string]> =
  {
    $ref: [(value) => typeof value === "string", "a string"],
    type: [typeList, "a type name or a non-empty list of type names"],
    maxLength: [nonNegativeInteger, "a non-negative integer"],
    maxItems: [nonNegativeInteger, "a non-negative integer"],
    maximum: [finiteNumber, "a number"],
    exclusiveMaximum: [
      (value) => finiteNumber(value) || typeof value === "boolean",
      "a number, or in OpenAPI 3.0 a boolean",
    ],
    pattern: [nonEmptyString, "a non-empty regular expression"],
    format: [nonEmptyString, "a non-empty string"],
    enum: [nonEmptyList, "a non-empty list"],
    allOf: [nonEmptyList, "a non-empty list of schemas"],
    oneOf: [nonEmptyList, "a non-empty list of schemas"],
    anyOf: [nonEmptyList, "a non-empty list of schemas"],
    properties: [isRecord, "an object of schemas"],
    items: [schemaLike, "a schema"],
    additionalProperties: [schemaLike, "a schema or a boolean"],
  };

/**
 * Keywords that admit values the walk does not follow: the items of a tuple,
 * the properties a pattern names, and what the unevaluated keywords leave
 * open. Each one present, other than as `false`, which admits nothing,
 * would hide a field from the count, so the walk stops.
 */
const UNWALKED = [
  "prefixItems",
  "additionalItems",
  "patternProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
];

/** Each keyword the walk reads, in the shape it must have; else throws. */
function checkShapes(schema: Record<string, unknown>, location: string): void {
  for (const key of UNWALKED)
    if (key in schema && schema[key] !== false)
      throw new InputError(
        `${location}: \`${key}\` admits values the gate does not walk, so it cannot count them`,
      );
  for (const [key, [valid, is]] of Object.entries(SHAPES))
    if (key in schema && !valid(schema[key]))
      throw new InputError(
        `${location}: \`${key}\` is not ${is}, so the gate cannot read it: ${JSON.stringify(schema[key])}`,
      );
  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern);
    } catch (error) {
      throw new InputError(
        `${location}: \`pattern\` is not a regular expression: ${schema.pattern}`,
        { cause: error },
      );
    }
  }
}

/** What one walk carries along: the document, the count and the options. */
interface Walk {
  doc: Record<string, unknown>;
  count: Count;
  extension: string;
  /** The finding made at each field, by list and field, and its problems. */
  reported: Map<string, { finding: UnboundedField; problems: Set<string> }>;
  /** The fields counted as accepted. */
  accepted: Set<string>;
  /** How many steps the walk has taken, against `STEP_BUDGET`. */
  steps: number;
}

/**
 * How many steps one walk takes before it stops: each schema judged, and
 * each schema, `allOf` part and reference expanded into an intersection.
 * The cases multiply: each alternative of a `oneOf`/`anyOf` is judged
 * together with one alternative of every other group beside it, and a
 * schema whose `allOf` names another twice, which names another twice,
 * expands it twice per level. Thirty levels of either are a billion. A
 * contract past the budget is one the gate cannot count in bounded time, so
 * it stops (exit 2) rather than stall.
 */
const STEP_BUDGET = 100_000;

/** Take one step of the walk at `location`, or stop past the budget. */
function step(walk: Walk, location: string): void {
  if (++walk.steps > STEP_BUDGET)
    throw new InputError(
      `${location}: the schema's alternatives, \`allOf\` parts and references expand into more than ${STEP_BUDGET} steps, so the gate stops rather than run without bound`,
    );
}

/**
 * Where a schema sits: its location, as reported, and its field, the
 * identity a finding is counted by. The field is built from the steps that
 * reach it, each property name encoded, so two fields never share one (the
 * property `a.b` and the property `b` inside `a`), and the labels of the
 * alternatives and `allOf` parts it was reached through are no part of it.
 */
interface Spot {
  location: string;
  field: string;
}

/** The spot one step below `at`, shown as `shown` and identified by `step`. */
const below = (at: Spot, shown: string, step: string): Spot => ({
  location: `${at.location}${shown}`,
  field: `${at.field}\0${step}`,
});

/** The spot of a named property, `*` additional properties, `[]` items. */
const propertyOf = (at: Spot, name: string): Spot =>
  below(at, `.${name}`, JSON.stringify(name));
const additionalOf = (at: Spot): Spot => below(at, ".*", "*");
const itemsOf = (at: Spot): Spot => below(at, "[]", "[]");

/**
 * One finding at `at`, made once per field. A field reached again through
 * another alternative adds its problem to the first finding when it
 * differs, so the count is of fields, not of the paths that reach them.
 */
function report(
  walk: Walk,
  list: "unbounded" | "invalid",
  at: Spot,
  problem: string,
): void {
  const key = `${list}\0${at.field}`;
  const first = walk.reported.get(key);
  if (first === undefined) {
    const finding = { location: at.location, problem };
    walk.reported.set(key, { finding, problems: new Set([problem]) });
    walk.count[list].push(finding);
  } else if (!first.problems.has(problem)) {
    first.problems.add(problem);
    first.finding.problem += `; at ${at.location}: ${problem}`;
  }
}

/**
 * One part of a `oneOf` or `anyOf`, with the references it was reached
 * through at its field: a reference met again on that chain is recursion,
 * one met only beside it is not.
 */
interface Alternative {
  label: string;
  part: unknown;
  path: ReadonlySet<string>;
}

/**
 * One schema as a value must satisfy it. Its own keywords, those of the
 * schema its `$ref` points at, and those of each `allOf` part all hold at
 * once, so they are intersected into one set of keywords before it is
 * judged. Each `oneOf`/`anyOf` is a group of alternatives; every group holds,
 * so a value satisfies one alternative of each.
 */
interface Effective {
  keywords: Record<string, unknown>;
  groups: Alternative[][];
  /** A `false` part: the intersection accepts nothing. */
  empty: boolean;
  /**
   * A reference met again below itself: its own bounds and fields were
   * judged where it was first met, so it is not expanded again.
   */
  recursive: boolean;
}

/** Where a part sits: the field, the references above it, its label. */
interface Place {
  location: string;
  path: ReadonlySet<string>;
  prefix: string;
}

/** Two schemas that both hold, as one. */
function both(a: unknown, b: unknown): unknown {
  if (a === false || b === false) return false;
  if (a === true) return b;
  if (b === true) return a;
  return { allOf: [a, b] };
}

/** The type names in both lists; `integer` is the meet of it and `number`. */
function meetTypes(a: unknown, b: unknown): string[] {
  const list = (types: unknown) =>
    typeof types === "string" ? [types] : (types as string[]);
  const right = list(b);
  const met = list(a).flatMap((type) => {
    if (right.includes(type)) return [type];
    if (type === "integer" && right.includes("number")) return [type];
    if (type === "number" && right.includes("integer")) return ["integer"];
    return [];
  });
  return [...new Set(met)];
}

/** A keyword set by two parts of one intersection, as one keyword. */
function meet(key: string, a: unknown, b: unknown): unknown {
  if (key === "type") return meetTypes(a, b);
  if (key === "items" || key === "additionalProperties") return both(a, b);
  if (key === "properties") {
    const merged = { ...(a as Record<string, unknown>) };
    for (const [name, schema] of Object.entries(b as Record<string, unknown>))
      merged[name] = name in merged ? both(merged[name], schema) : schema;
    return merged;
  }
  // A bound set twice: either is a bound, and both are of a readable shape.
  return a;
}

/**
 * A field's schema, with the references the part that defined it was reached
 * through. Keywords from several parts are merged into one set, so each field
 * carries its own chain: a reference absorbed beside the part (an `allOf`
 * mixin) is not one the field sits inside.
 */
interface Chained {
  [CHAIN]: ReadonlySet<string>;
  schema: Record<string, unknown>;
}
const CHAIN = Symbol("chain");

const isChained = (value: unknown): value is Chained =>
  isRecord(value) && CHAIN in value;

/** `schema` marked with `path`; a boolean needs no chain. */
const chained = (schema: unknown, path: ReadonlySet<string>): unknown =>
  isRecord(schema) && !isChained(schema)
    ? ({ [CHAIN]: path, schema } satisfies Chained)
    : schema;

/** The field schemas in `own`, each marked with `path`. */
function withChains(
  own: Record<string, unknown>,
  path: ReadonlySet<string>,
): Record<string, unknown> {
  const marked = { ...own };
  for (const key of ["items", "additionalProperties"])
    if (key in marked) marked[key] = chained(marked[key], path);
  if (isRecord(marked.properties))
    marked.properties = Object.fromEntries(
      Object.entries(marked.properties).map(([name, schema]) => [
        name,
        chained(schema, path),
      ]),
    );
  return marked;
}

/** Add `own` keywords to the intersection's. */
function intersect(
  keywords: Record<string, unknown>,
  own: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(own))
    keywords[key] = key in keywords ? meet(key, keywords[key], value) : value;
}

/** Add one part to the intersection `into`. */
function absorb(
  walk: Walk,
  part: unknown,
  place: Place,
  into: Effective,
): void {
  step(walk, place.location);
  if (isChained(part)) {
    absorb(walk, part.schema, { ...place, path: part[CHAIN] }, into);
    return;
  }
  if (part === true) return;
  if (part === false) {
    into.empty = true;
    return;
  }
  if (!isRecord(part))
    throw new InputError(
      `${place.location}: a schema that is not an object or a boolean`,
    );
  checkShapes(part, place.location);
  const { $ref, allOf, oneOf, anyOf, ...own } = part;
  intersect(into.keywords, withChains(own, place.path));
  for (const [key, parts] of [
    ["oneOf", oneOf],
    ["anyOf", anyOf],
  ] as const)
    if (Array.isArray(parts))
      into.groups.push(
        parts.map((alternative, index) => ({
          label: `${place.prefix}<${key}[${index}]>`,
          part: alternative,
          path: place.path,
        })),
      );
  if (typeof $ref === "string") absorbRef(walk, $ref, place, into);
  if (Array.isArray(allOf))
    allOf.forEach((fragment, index) => {
      absorb(
        walk,
        fragment,
        { ...place, prefix: `${place.prefix}<allOf[${index}]>` },
        into,
      );
    });
}

/**
 * The schema `ref` points at, added to the intersection beside its siblings.
 * A reference already being walked above is marked instead of expanded, and
 * its siblings and the remaining `allOf` parts are still absorbed.
 */
function absorbRef(
  walk: Walk,
  ref: string,
  place: Place,
  into: Effective,
): void {
  if (place.path.has(ref)) {
    into.recursive = true;
    return;
  }
  absorb(
    walk,
    resolvePointer(walk.doc, ref),
    { ...place, path: new Set([...place.path, ref]) },
    into,
  );
}

/**
 * What an alternative inherits from the schema around it: its keywords and
 * the groups of alternatives still to choose from.
 */
interface Enclosing {
  keywords: Record<string, unknown>;
  groups: Alternative[][];
  recursive: boolean;
}

/**
 * Walk one schema at `at`, adding each field without a bound to
 * `walk.count`. `path` holds the references this schema was reached through:
 * a `$ref` on it is recursion, so a recursive schema's fields are counted
 * where they are first met. `enclosing` is the schema around an
 * alternative, whose keywords and other groups hold for it too.
 */
function visit(
  walk: Walk,
  schema: unknown,
  at: Spot,
  path: ReadonlySet<string>,
  enclosing?: Enclosing,
): void {
  step(walk, at.location);
  // `false` accepts nothing, so it is bounded.
  if (schema === false) return;
  if (schema === undefined || schema === true) {
    report(
      walk,
      "unbounded",
      at,
      schema === true
        ? "a `true` schema, which accepts anything"
        : "no schema at all",
    );
    return;
  }
  const effective: Effective = {
    keywords: { ...enclosing?.keywords },
    groups: [...(enclosing?.groups ?? [])],
    empty: false,
    recursive: enclosing?.recursive ?? false,
  };
  const place = { location: at.location, path, prefix: "" };
  absorb(walk, schema, place, effective);
  // Types with nothing in common, like a `false` part, accept no value.
  const { type } = effective.keywords;
  if (effective.empty || (Array.isArray(type) && type.length === 0)) return;
  judge(walk, effective, at);
}

/** The intersection's bounds: its exception, alternatives and types. */
function judge(walk: Walk, effective: Effective, at: Spot): void {
  const { keywords, groups } = effective;
  if (walk.extension in keywords) {
    noteException(walk, keywords[walk.extension], at);
    return;
  }
  const [group, ...rest] = groups;
  if (group !== undefined) {
    // A value satisfies the keywords here and one alternative of every
    // group, so each alternative of the first group is judged as that
    // intersection, carrying the other groups along, and these keywords are
    // judged only through them.
    const around: Enclosing = {
      keywords,
      groups: rest,
      recursive: effective.recursive,
    };
    for (const { label, part, path } of group)
      visit(
        walk,
        part === true ? {} : part,
        { location: `${at.location}${label}`, field: at.field },
        path,
        around,
      );
    return;
  }
  if (effective.recursive) {
    visitFields(walk, keywords, at);
    return;
  }
  if ("enum" in keywords || "const" in keywords) return;
  const types = typesOf(keywords);
  if (types === undefined) {
    report(walk, "unbounded", at, "no type");
    return;
  }
  for (const type of types) judgeType(walk, effective, type, at);
}

/**
 * The non-null types a value may take: each named in `type`, or, with no
 * `type`, those `items` and `properties` imply. None named: no type at all.
 */
function typesOf(keywords: Record<string, unknown>): string[] | undefined {
  const type = keywords.type;
  if (type !== undefined)
    return [
      ...new Set(typeof type === "string" ? [type] : (type as string[])),
    ].filter((name) => name !== "null");
  const implied: string[] = [];
  if ("items" in keywords) implied.push("array");
  if ("properties" in keywords || "additionalProperties" in keywords)
    implied.push("object");
  return implied.length > 0 ? implied : undefined;
}

/**
 * The chain a field is visited with. Every field schema carries its own
 * (`Chained`), which replaces this one when it is absorbed.
 */
const FIELD_CHAIN: ReadonlySet<string> = new Set();

/**
 * The fields the keywords beside a recursive reference add. The reference's
 * own bounds and fields were judged where it was first met, and keywords
 * beside it can only narrow those, so only the fields they name are walked.
 */
function visitFields(
  walk: Walk,
  keywords: Record<string, unknown>,
  at: Spot,
): void {
  if (isRecord(keywords.properties))
    for (const [name, property] of Object.entries(keywords.properties))
      visit(walk, property, propertyOf(at, name), FIELD_CHAIN);
  if (isRecord(keywords.additionalProperties))
    visit(walk, keywords.additionalProperties, additionalOf(at), FIELD_CHAIN);
  if (keywords.items !== undefined)
    visit(walk, keywords.items, itemsOf(at), FIELD_CHAIN);
}

/** A field unbounded on purpose counts as accepted only with a reason. */
function noteException(walk: Walk, reason: unknown, at: Spot): void {
  if (typeof reason !== "string" || reason.trim() === "")
    report(walk, "invalid", at, `${walk.extension} carries no reason`);
  else if (!walk.accepted.has(at.field)) {
    walk.accepted.add(at.field);
    walk.count.accepted++;
  }
}

/** One of the value's types: what bounds it, and what it holds. */
function judgeType(
  walk: Walk,
  effective: Effective,
  type: string,
  at: Spot,
): void {
  const { keywords } = effective;
  if (type === "array") {
    if (!("maxItems" in keywords))
      report(walk, "unbounded", at, "an array with no maxItems");
    visit(walk, keywords.items, itemsOf(at), FIELD_CHAIN);
  } else if (type === "string" || type === "number" || type === "integer") {
    const bounds = BOUNDS[type];
    // `exclusiveMaximum: true` (OpenAPI 3.0) bounds nothing without `maximum`.
    if (
      !bounds.some(
        (key) => key in keywords && typeof keywords[key] !== "boolean",
      )
    )
      report(
        walk,
        "unbounded",
        at,
        `${type === "integer" ? "an" : "a"} ${type} with no ${bounds.join(", ")} or enum`,
      );
  } else if (type === "object") {
    visitObject(walk, keywords, at);
  }
  // A boolean is bounded by its two values.
}

/**
 * An object's fields: each named property, and its additional properties,
 * which hold whatever the named ones do not. Those are closed by `false`
 * or bounded by a schema, which is walked; `true` or absent is open.
 */
function visitObject(
  walk: Walk,
  keywords: Record<string, unknown>,
  at: Spot,
): void {
  if (isRecord(keywords.properties))
    for (const [name, property] of Object.entries(keywords.properties))
      visit(walk, property, propertyOf(at, name), FIELD_CHAIN);
  const additional = keywords.additionalProperties;
  if (isRecord(additional))
    visit(walk, additional, additionalOf(at), FIELD_CHAIN);
  else if (additional !== false)
    report(
      walk,
      "unbounded",
      at,
      "an object with additionalProperties open (neither false nor a schema)",
    );
}

/**
 * Walk one schema at `location`, adding each field without a bound to
 * `count`; `extension` is the field that marks one unbounded on purpose.
 */
export function walkSchema(
  doc: Record<string, unknown>,
  schema: unknown,
  location: string,
  count: Count,
  extension: string,
): void {
  visit(
    {
      doc,
      count,
      extension,
      reported: new Map(),
      accepted: new Set(),
      steps: 0,
    },
    schema,
    { location, field: location },
    new Set(),
  );
}

/** The locations a parameter may sit in. */
const PARAMETER_LOCATIONS = new Set(["query", "path", "header", "cookie"]);

/**
 * A parameter, through its references, and its identity (`query:limit`).
 * One that is not an object, or has no name or no known location, throws.
 */
function parameter(
  doc: Record<string, unknown>,
  raw: unknown,
  where: string,
): [key: string, node: Record<string, unknown>] {
  const node = followRefs(doc, raw);
  if (!isRecord(node))
    throw new InputError(`${where}: a parameter that is not an object`);
  const { name, in: place } = node;
  if (
    !nonEmptyString(name) ||
    typeof place !== "string" ||
    !PARAMETER_LOCATIONS.has(place)
  )
    throw new InputError(
      `${where}: a parameter with no name or no location (query, path, header, cookie)`,
    );
  return [`${place}:${String(name)}`, node];
}

/**
 * The parameters of one list into `into`. An absent list is none; one that
 * is not a list, or that declares one parameter twice, throws.
 */
function parameterList(
  doc: Record<string, unknown>,
  list: unknown,
  where: string,
  into: Map<string, Record<string, unknown>>,
): void {
  if (list === undefined) return;
  if (!Array.isArray(list))
    throw new InputError(`${where}: \`parameters\` is not a list`);
  const keys = new Set<string>();
  for (const raw of list) {
    const [key, node] = parameter(doc, raw, where);
    if (keys.has(key))
      throw new InputError(
        `${where}: the parameter ${key} is declared twice in one list`,
      );
    keys.add(key);
    into.set(key, node);
  }
}

/** The operation's parameters by location and name, its own winning. */
function parametersOf(
  doc: Record<string, unknown>,
  operation: Operation,
  where: string,
): Map<string, Record<string, unknown>> {
  const parameters = new Map<string, Record<string, unknown>>();
  parameterList(
    doc,
    operation.pathItem.parameters,
    `${where} (its path item)`,
    parameters,
  );
  parameterList(doc, operation.operation.parameters, where, parameters);
  return parameters;
}

/**
 * The schema of a parameter: `schema`, else the one media type of its
 * `content`, else none. A `content` that is not a map of exactly one media
 * type throws.
 */
function schemaOf(node: Record<string, unknown>, where: string): unknown {
  if ("schema" in node) return node.schema;
  if (!("content" in node)) return undefined;
  const media = isRecord(node.content) ? Object.values(node.content) : [];
  const [first] = media;
  if (media.length !== 1 || !isRecord(first))
    throw new InputError(
      `${where}: a parameter's \`content\` is not a map of exactly one media type`,
    );
  return first.schema;
}

/**
 * The request body's schema under each media type, through its `$ref`.
 * No request body is none; a body that is not an object, or whose
 * `content` is not a non-empty map of media types, throws.
 */
function bodySchemas(
  doc: Record<string, unknown>,
  operation: Operation,
  where: string,
): [label: string, schema: unknown][] {
  if (!("requestBody" in operation.operation)) return [];
  const body = followRefs(doc, operation.operation.requestBody);
  const content = isRecord(body) ? body.content : undefined;
  if (!isRecord(content) || Object.keys(content).length === 0)
    throw new InputError(
      `${where}: a request body whose \`content\` is not a map of media types`,
    );
  const entries = Object.entries(content);
  return entries.map(([media, type]) => {
    if (!isRecord(type))
      throw new InputError(
        `${where}: the request body's media type ${media} is not an object`,
      );
    return [entries.length === 1 ? "body" : `body(${media})`, type.schema];
  });
}

/** An empty count. */
const emptyCount = (): Count => ({ unbounded: [], accepted: 0, invalid: [] });

/** Every unbounded request input of one operation. */
export function countOperation(
  doc: Record<string, unknown>,
  operation: Operation,
  extension: string,
): Count {
  const count = emptyCount();
  const where = `${operation.method} ${operation.path}`;
  for (const [key, node] of parametersOf(doc, operation, where))
    walkSchema(
      doc,
      schemaOf(node, `${where} ${key}`),
      `${where} ${key}`,
      count,
      extension,
    );
  for (const [label, schema] of bodySchemas(doc, operation, where))
    walkSchema(doc, schema, `${where} ${label}`, count, extension);
  return count;
}

/** The whole document's count. */
export function countContract(
  doc: Record<string, unknown>,
  extension: string,
): Count & { operations: number } {
  const total = emptyCount();
  const found = operations(doc);
  for (const operation of found) {
    const count = countOperation(doc, operation, extension);
    total.unbounded.push(...count.unbounded);
    total.accepted += count.accepted;
    total.invalid.push(...count.invalid);
  }
  return { ...total, operations: found.length };
}

/** The ambient environment without the variables that redirect git. */
function gitEnv(): Record<string, string | undefined> {
  const leaky = new Set<string>(LEAKY_GIT_ENV);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env))
    if (!leaky.has(key.toUpperCase())) env[key] = value;
  return env;
}

/** The output of a git command in `repo`; a failed one throws. */
function git(repo: string, args: string[], what: string): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error)
    throw new InputError(`git could not run: ${result.error.message}`);
  if (result.status !== 0)
    throw new InputError(`${what}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The contract as the merge base of `base` and HEAD holds it. */
export function contractAtBase(
  repo: string,
  base: string,
  contract: string,
): Record<string, unknown> {
  const top = git(
    repo,
    ["rev-parse", "--show-toplevel"],
    `--repo is not a git repository: ${repo}`,
  ).trim();
  // Both real paths: a repository reached through a link or a Windows 8.3
  // short name must still resolve its own files inside it.
  const full = realpathSync.native(
    isAbsolute(contract) ? contract : resolve(repo, contract),
  );
  const path = relative(realpathSync.native(top), full).replaceAll("\\", "/");
  if (path.startsWith("..") || isAbsolute(path))
    throw new InputError(
      `the contract lies outside the repository: ${contract}`,
    );
  const mergeBase = git(
    repo,
    ["merge-base", base, "HEAD"],
    `--base and HEAD have no merge base (does ${base} name a commit?)`,
  ).trim();
  const text = git(
    repo,
    ["show", `${mergeBase}:${path}`],
    `the contract is absent at the merge base, so there is no count to hold it to; use --max for a new contract`,
  );
  return parseContract(text, `${path} at ${mergeBase.slice(0, 7)}`);
}

interface Options {
  max: number | undefined;
  base: string | undefined;
  repo: string;
  extension: string;
  contract: string;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    max: undefined,
    base: undefined,
    repo: process.cwd(),
    extension: "x-unbounded",
    contract: "",
  };
  const contracts: string[] = [];
  const value = (i: number, name: string) => optionValue(args, i, name, usage);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--max") {
      const raw = value(++i, arg);
      if (!/^\d+$/.test(raw))
        throw new InputError(`--max must be a whole number: ${raw}`);
      options.max = Number(raw);
    } else if (arg === "--base") options.base = value(++i, arg);
    else if (arg === "--repo") options.repo = value(++i, arg);
    else if (arg === "--extension") options.extension = value(++i, arg);
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else contracts.push(arg);
  }
  if (contracts.length !== 1)
    throw new InputError(`exactly one contract document is read\n${usage}`);
  if (!/^x-[\w-]+$/.test(options.extension))
    throw new InputError(
      `--extension must be a specification extension (x-...): ${options.extension}`,
    );
  options.contract = contracts[0] ?? "";
  return options;
}

/** The limits the head's count is held to, and whether it exceeds one. */
function holdCount(
  n: number,
  options: Options,
): { limits: string[]; over: boolean } {
  const limits: string[] = [];
  let over = false;
  if (options.base !== undefined) {
    const base = countContract(
      contractAtBase(options.repo, options.base, options.contract),
      options.extension,
    ).unbounded.length;
    limits.push(`${base} at the base`);
    if (n > base) over = true;
  }
  if (options.max !== undefined) {
    limits.push(`a ceiling of ${options.max}`);
    if (n > options.max) over = true;
  }
  return { limits, over: limits.length === 0 ? n > 0 : over };
}

/** The findings of one list, each with the remedy it takes. */
function findingsOf(
  fields: UnboundedField[],
  options: Options,
  remedy: string,
): Finding[] {
  return fields.map(({ location, problem }) => ({
    rule: RULE,
    file: options.contract,
    problem: `${location}: ${problem}.`,
    remedy,
  }));
}

export function main(args = process.argv.slice(2)): number {
  const options = parseArgs(args);
  const head = countContract(
    readContract(options.contract, options.repo),
    options.extension,
  );
  const n = head.unbounded.length;
  const { limits, over } = holdCount(n, options);
  const accepted =
    head.accepted > 0 ? `; ${head.accepted} accepted with a reason` : "";
  const { extension } = options;
  const findings = [
    ...(over
      ? findingsOf(
          head.unbounded,
          options,
          `Declare the bound in the schema (maxLength, pattern, format, enum, maximum, maxItems, a type, additionalProperties: false), or ${extension}: "<reason>" where the field is unbounded on purpose.`,
        )
      : []),
    ...findingsOf(
      head.invalid,
      options,
      `Give ${extension} the reason the field is unbounded on purpose, or declare its bound and remove ${extension}.`,
    ),
  ];
  if (findings.length > 0) {
    reportFindings(findings);
    if (over)
      console.error(
        `${n} unbounded input field(s) across ${head.operations} operation(s) in ${options.contract}${accepted}; the count must not exceed ${limits.join(" or ") || "0"}.`,
      );
    if (head.invalid.length > 0)
      console.error(
        `${head.invalid.length} field(s) carry ${extension} without a reason; an exception needs its reason at any count.`,
      );
    return 1;
  }
  console.log(
    `OK — ${n} unbounded input field(s) across ${head.operations} operation(s) in ${options.contract}${accepted}${limits.length > 0 ? `; within ${limits.join(" and ")}` : ""}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
