// Path-scoped frontmatter rules: `path_rules:` in the schema adds rules that
// apply only to documents under given path prefixes. Every rule is checked for
// shape whether or not it matches a document, and a rule that cannot be
// evaluated (an unknown key, a wrong type, a regular expression that does not
// compile) is reported as a violation: a broken rule must fail the gate, never
// read as a rule that matched nothing.
import { posix, relative, resolve, sep } from "node:path";
import { type FieldValue, hasValue } from "../docs";

export interface BodyPattern {
  id: string;
  pattern: RegExp;
  message: string;
}
export interface PathRule {
  id: string;
  paths: string[];
  message: string;
  requiredFields: string[];
  allowedValues: Map<string, string[]>;
  forbiddenBodyPatterns: BodyPattern[];
}

const RULE_KEYS = new Set([
  "id",
  "paths",
  "message",
  "required_fields",
  "allowed_values",
  "forbidden_body_patterns",
]);
const PATTERN_KEYS = new Set(["id", "pattern", "message"]);

type Raw = Record<string, unknown>;
/**
 * A YAML mapping as js-yaml loads it: a plain object. A timestamp loads as a
 * Date and `!!binary` as a Uint8Array; both are objects, neither is a mapping.
 */
export const isMap = (value: unknown): value is Raw =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const textList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isText);

/** The repository-wide enums (`<field>: { values: [...] }`) a rule narrows. */
function schemaEnums(schema: Raw): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const [field, body] of Object.entries(schema))
    if (isMap(body) && textList(body.values)) enums.set(field, body.values);
  return enums;
}

/** Fields the schema declares: its enums, required lists and type-specific lists. */
function knownFields(schema: Raw, enums: Map<string, string[]>): Set<string> {
  const typeSpecific = isMap(schema.type_specific)
    ? Object.values(schema.type_specific)
    : [];
  const declared = [
    schema.required,
    schema.required_new,
    ...typeSpecific,
  ].flatMap((list) => (Array.isArray(list) ? list.filter(isText) : []));
  return new Set([...enums.keys(), ...declared]);
}

/** One rule being read: its id, the schema's vocabulary and the error sink. */
interface Reader {
  id: string;
  enums: Map<string, string[]>;
  known: Set<string>;
  errors: string[];
}
const fail = (reader: Reader, message: string) =>
  reader.errors.push(`rule '${reader.id}': ${message}`);

const isPrefix = (prefix: string) =>
  !prefix.startsWith("/") &&
  !prefix.startsWith("..") &&
  posix.normalize(prefix) === prefix;

function readPaths(rule: Raw, reader: Reader): string[] {
  if (!textList(rule.paths)) {
    fail(reader, "'paths' must be a non-empty list of prefixes");
    return [];
  }
  for (const prefix of rule.paths.filter((p) => !isPrefix(p)))
    fail(
      reader,
      `path '${prefix}' is not a normalised repository-relative prefix, so it can never match`,
    );
  return rule.paths;
}

function readAllowedField(
  field: string,
  values: unknown,
  reader: Reader,
): string[] | undefined {
  if (!reader.known.has(field))
    fail(
      reader,
      `allowed_values names '${field}', a field the schema does not declare and the rule does not require`,
    );
  if (!textList(values)) {
    fail(
      reader,
      `allowed_values '${field}' must be a non-empty list of values`,
    );
    return undefined;
  }
  const base = reader.enums.get(field) ?? values;
  for (const value of values.filter((v) => !base.includes(v)))
    fail(
      reader,
      `allowed_values '${field}' lists '${value}', which the schema's ${field} values do not include (a rule narrows the vocabulary, never widens it)`,
    );
  return values;
}

function readAllowed(rule: Raw, reader: Reader): Map<string, string[]> {
  const allowed = new Map<string, string[]>();
  if (rule.allowed_values === undefined) return allowed;
  if (!isMap(rule.allowed_values) || !Object.keys(rule.allowed_values).length) {
    fail(reader, "'allowed_values' must be a non-empty mapping");
    return allowed;
  }
  for (const [field, raw] of Object.entries(rule.allowed_values)) {
    const values = readAllowedField(field, raw, reader);
    if (values) allowed.set(field, values);
  }
  return allowed;
}

function readPattern(
  entry: unknown,
  index: number,
  reader: Reader,
): BodyPattern | undefined {
  const at = `forbidden_body_patterns[${index}]`;
  if (!isMap(entry) || !isText(entry.pattern) || !isText(entry.id)) {
    fail(reader, `${at} needs an 'id' and a 'pattern'`);
    return undefined;
  }
  for (const key of Object.keys(entry).filter((k) => !PATTERN_KEYS.has(k)))
    fail(reader, `${at} has unknown key '${key}'`);
  if (entry.message !== undefined && !isText(entry.message))
    fail(reader, `${at} 'message' must be text`);
  try {
    return {
      id: entry.id,
      pattern: new RegExp(entry.pattern),
      message: isText(entry.message) ? entry.message : "forbidden text",
    };
  } catch (error) {
    fail(reader, `${at} pattern does not compile: ${String(error)}`);
    return undefined;
  }
}

function readPatterns(rule: Raw, reader: Reader): BodyPattern[] {
  const list = rule.forbidden_body_patterns;
  if (list === undefined) return [];
  if (!Array.isArray(list) || !list.length) {
    fail(reader, "'forbidden_body_patterns' must be a non-empty list");
    return [];
  }
  return list.flatMap(
    (entry, index) => readPattern(entry, index, reader) ?? [],
  );
}

function readRequired(rule: Raw, reader: Reader): string[] {
  const required = rule.required_fields;
  if (required === undefined) return [];
  if (textList(required)) return required;
  fail(reader, "'required_fields' must be a non-empty list of field names");
  return [];
}

function checkRuleKeys(rule: Raw, reader: Reader): void {
  if (!isText(rule.id)) fail(reader, "needs an 'id'");
  for (const key of Object.keys(rule).filter((k) => !RULE_KEYS.has(k)))
    fail(reader, `unknown key '${key}'`);
  if (rule.message !== undefined && !isText(rule.message))
    fail(reader, "'message' must be text");
}

function readRule(
  rule: unknown,
  index: number,
  base: Reader,
): PathRule | undefined {
  if (!isMap(rule)) {
    base.errors.push(`rule #${index}: must be a mapping`);
    return undefined;
  }
  const reader = { ...base, id: isText(rule.id) ? rule.id : `#${index}` };
  checkRuleKeys(rule, reader);
  const requiredFields = readRequired(rule, reader);
  reader.known = new Set([...base.known, ...requiredFields]);
  const parsed: PathRule = {
    id: reader.id,
    paths: readPaths(rule, reader),
    message: isText(rule.message) ? rule.message : "",
    requiredFields,
    allowedValues: readAllowed(rule, reader),
    forbiddenBodyPatterns: readPatterns(rule, reader),
  };
  const restricts =
    parsed.requiredFields.length +
    parsed.allowedValues.size +
    parsed.forbiddenBodyPatterns.length;
  if (!restricts) fail(reader, "declares no restriction");
  return parsed;
}

/**
 * Read `path_rules:` from the parsed schema. A schema without the key has no
 * rules. The key is looked up in what the YAML parser returned, never spotted
 * in the text, so any YAML spelling of it counts.
 */
export function readPathRules(schema: unknown): {
  rules: PathRule[];
  errors: string[];
} {
  if (!isMap(schema) || !Object.hasOwn(schema, "path_rules"))
    return { rules: [], errors: [] };
  if (!Array.isArray(schema.path_rules))
    return { rules: [], errors: ["'path_rules' must be a list of rules"] };
  const enums = schemaEnums(schema);
  const reader: Reader = {
    id: "",
    enums,
    known: knownFields(schema, enums),
    errors: [],
  };
  const list = schema.path_rules as unknown[];
  const rules = list.flatMap(
    (raw, index) => readRule(raw, index, reader) ?? [],
  );
  return { rules, errors: reader.errors };
}

/**
 * One error per prefix that no document in the tree starts with. A typo in a
 * prefix would otherwise leave its rule covering nothing, which reads exactly
 * like a rule every document passes.
 */
export function unmatchedPrefixes(
  rules: PathRule[],
  paths: string[],
): string[] {
  return rules.flatMap((rule) =>
    rule.paths
      .filter((prefix) => !paths.some((path) => path.startsWith(prefix)))
      .map(
        (prefix) =>
          `rule '${rule.id}': path '${prefix}' matches no document in the tree, so the rule covers nothing`,
      ),
  );
}

/** A document's path as a rule prefix sees it: repository-relative, `/`-separated. */
export function rulePath(file: string, root = process.cwd()): string {
  return relative(root, resolve(root, file)).split(sep).join("/");
}

interface Fence {
  char: string;
  length: number;
}
const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence a line opens (at most 3 spaces in; a backtick info string holds no backtick). */
function opensFence(line: string): Fence | undefined {
  const [, marker = "", info = ""] = FENCE_RUN.exec(line) ?? [];
  if (!marker || (marker[0] === "`" && info.includes("`"))) return undefined;
  return { char: marker[0] ?? "", length: marker.length };
}

/** A closing fence: the opener's character, at least as long, nothing after it. */
function closesFence(line: string, fence: Fence): boolean {
  const [, marker = "", rest = ""] = FENCE_RUN.exec(line) ?? [];
  return (
    marker[0] === fence.char && marker.length >= fence.length && !rest.trim()
  );
}

/** Body lines (1-based numbers) outside fenced code blocks. */
export function bodyOutsideFences(
  lines: string[],
  start: number,
): [number, string][] {
  const body: [number, string][] = [];
  let fence: Fence | undefined;
  lines.slice(start).forEach((line, offset) => {
    if (fence) fence = closesFence(line, fence) ? undefined : fence;
    else {
      fence = opensFence(line);
      if (!fence) body.push([start + offset + 1, line]);
    }
  });
  return body;
}

/**
 * A required field holds content: a non-blank scalar, or a list with at least
 * one non-blank member. An empty list carries nothing a reader could use.
 */
function filled(value: FieldValue | undefined): boolean {
  if (Array.isArray(value)) return value.some((member) => hasValue(member));
  return hasValue(value);
}

function missingFields(rule: PathRule, fields: Map<string, FieldValue>) {
  return rule.requiredFields
    .filter((field) => !filled(fields.get(field)))
    .map((field) => `missing required field: ${field}`);
}

function disallowedValues(rule: PathRule, fields: Map<string, FieldValue>) {
  return [...rule.allowedValues].flatMap(([field, allowed]) => {
    const value = fields.get(field) ?? null;
    const values = value === null ? [] : [value].flat();
    return values
      .filter((v) => !allowed.includes(v))
      .map(
        (v) =>
          `${field} '${v}' is not allowed here (allowed: ${allowed.join(", ")})`,
      );
  });
}

function forbiddenLines(rule: PathRule, body: [number, string][]) {
  return rule.forbiddenBodyPatterns.flatMap((pattern) =>
    body
      .filter(([, line]) => pattern.pattern.test(line))
      .map(
        ([number]) =>
          `line ${number}: ${pattern.message} (pattern '${pattern.id}', path rule '${rule.id}')`,
      ),
  );
}

/** The violations a document's fields and body give under the matching rules. */
export function applyPathRules(
  rules: PathRule[],
  path: string,
  fields: Map<string, FieldValue>,
  body: [number, string][],
): string[] {
  return rules
    .filter((rule) => rule.paths.some((prefix) => path.startsWith(prefix)))
    .flatMap((rule) => {
      const tail = ` (path rule '${rule.id}')${rule.message ? ` — ${rule.message}` : ""}`;
      return [
        ...[
          ...missingFields(rule, fields),
          ...disallowedValues(rule, fields),
        ].map((error) => error + tail),
        ...forbiddenLines(rule, body),
      ];
    });
}
