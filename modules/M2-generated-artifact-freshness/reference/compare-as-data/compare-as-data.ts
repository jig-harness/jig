#!/usr/bin/env bun
// Structured artifacts compared as parsed data (module M2).
//
// The problem it closes. A committed contract artifact (an API description,
// a schema, generated types' JSON form) is written by a generator and then
// touched by a formatter, a key sort or a line-ending rule, so its bytes
// differ from the generator's fresh output while its content does not. A
// byte comparison then reports drift on every run, every finding converges
// on "regenerate" as the fix, and real drift hides among the false ones. So
// a structured artifact is compared as the data it encodes: both copies are
// parsed, key order and formatting fall away, and what differs is named by
// its path in the data.
//
// Input. Two files, the committed artifact and the fresh output, each JSON
// or YAML by its extension (`.json`, `.yaml`, `.yml`); either may be read in
// the other syntax, so a YAML artifact can be compared with a JSON dump.
// Both sides pass through the same parse: a normalization applied to one
// side only makes every later fix to it look like drift of every committed
// artifact. YAML is read with its core schema, the JSON-compatible one, so a
// date stays the string it is written as rather than becoming an object
// whose content a comparison of keys cannot see.
//
// Findings. Each path at which the two differ: a value, a missing key, an
// extra key, a list of another length. Every difference is reported, not
// only the first, and for each the remedy is to regenerate the artifact
// from its source, never to edit it to match: derivation runs one way.
//
// Exit codes: 0 the two parse to the same data; 1 they differ; 2 a file
// cannot be read or parsed, holds no document (empty, or only comments,
// markers or a byte-order mark; an explicit `null` is a document), uses a
// list or a mapping as a mapping key, which parsing turns into a string
// (a scalar key is compared as its string, as JSON holds it), holds an integer past
// 2^53 as a value or a mapping key, which parsing may round onto its
// neighbour so that two different values or keys compare equal, or holds a number literal past the range of a double,
// which parses to infinity (YAML's own `.inf` is a value, not an overflow).
// A decimal with more significant digits than a double
// holds is rounded the same way and is not detected.
//
// Usage: compare-as-data.ts [--command <regenerate command>] <committed> <fresh>
import { extname } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import {
  CORE_SCHEMA,
  load as loadYaml,
  Type,
  types,
} from "../../../../lib/vendor/js-yaml.mjs";

/** An argument or a file this check was given that it cannot use. */
export class InputError extends Error {}

const usage =
  "usage: compare-as-data.ts [--command <regenerate command>] <committed> <fresh>";
const RULE = "compare-as-data";

/** Why a parsed number cannot be compared faithfully, or undefined when it
 * can. `literal` names it: its text for YAML, its path for JSON. */
function unfaithful(
  value: number,
  literal: string,
  nonFinite = false,
): string | undefined {
  if (!Number.isFinite(value) && !nonFinite)
    return `the number ${literal} is past the range of a double and parses to infinity, so two different values would compare equal`;
  if (Number.isInteger(value) && !Number.isSafeInteger(value))
    return `the integer ${literal} is past 2^53, which parsing may have rounded onto its neighbour, so two different values would compare equal`;
  return undefined;
}

// YAML's own infinity and not-a-number literals.
const NON_FINITE_LITERAL = /^[-+]?\.(?:inf|nan)$/i;

/** A core-schema number type that refuses, as it constructs it, a number
 * `unfaithful` names. Checking at construction covers a mapping key too:
 * the parser turns a key into its string afterwards, so two keys past 2^53
 * would otherwise become one key and nothing later could see it. */
function faithful(type: Type): Type {
  return new Type(type.tag, {
    ...type.options,
    construct: (data: string) => {
      const value = type.construct(data);
      if (typeof value !== "number") return value;
      const literal = data.trim();
      const problem = unfaithful(
        value,
        literal.length > 40 ? `${literal.slice(0, 37)}...` : literal,
        NON_FINITE_LITERAL.test(literal),
      );
      if (problem) throw new InputError(problem);
      return value;
    },
  });
}

const DATA_SCHEMA = CORE_SCHEMA.extend({
  implicit: [faithful(types.int), faithful(types.float)],
});

/** Each list and mapping in `value`, with how many times the data refers to
 * it; a node an alias repeats is counted per reference and walked once. */
function references(
  value: unknown,
  counts = new Map<object, number>(),
): Map<object, number> {
  if (typeof value !== "object" || value === null) return counts;
  const seen = counts.get(value) ?? 0;
  counts.set(value, seen + 1);
  if (seen === 0)
    for (const item of Object.values(value)) references(item, counts);
  return counts;
}

/** YAML's data, or `undefined` when the text holds no document: only
 * comments, directives, markers or a byte-order mark, which the parser reads
 * as an empty root node, null like an explicit `null` but with nothing read
 * and no tag. It refuses a list or mapping used as a mapping key. The parser
 * turns such a key into a string (`? [a, b]` becomes `"a,b"`), so it would
 * compare equal to that string key. Each list and mapping occurs in the text
 * once where it is written plus once per alias that names it, and every
 * occurrence is either referred to by the data or was a key, so a node that
 * occurs more often than the data refers to it was a key; an alias naming the
 * mapping it sits in (`&a { ? *a : x }`) is a second occurrence like any
 * other. A node call that closes with no kind and a list or mapping is an
 * alias. A block mapping reader that finds no colon after what it read hands
 * its child's result up unchanged (`{a: 1}` at the root, a flow collection or
 * an alias on the line under a key), and that call is the child's occurrence,
 * not a second one. A scalar key becomes its string, as a JSON key holds it:
 * `1:` and `"1":` are one key. */
function loadYamlData(text: string): unknown {
  // Each list and mapping a reader wrote, and each alias read of one.
  const written = new Set<object>();
  const aliased = new Map<object, number>();
  // One entry per open node call: the results its direct child calls closed with.
  const open: Set<unknown>[] = [];
  let content = false;
  const data = loadYaml(text, {
    schema: DATA_SCHEMA,
    listener: (event, state) => {
      if (event === "open") {
        open.push(new Set());
        return;
      }
      content = state.kind !== null || state.tag !== null;
      const node = state.result;
      const handedUp = open.pop()?.has(node) ?? false;
      open.at(-1)?.add(node);
      if (typeof node !== "object" || node === null) return;
      if (state.kind !== null) written.add(node);
      else if (!handedUp) aliased.set(node, (aliased.get(node) ?? 0) + 1);
    },
  });
  if (!content) return undefined;
  const referred = references(data);
  for (const node of new Set([...written, ...aliased.keys()]))
    if (
      (written.has(node) ? 1 : 0) + (aliased.get(node) ?? 0) >
      (referred.get(node) ?? 0)
    )
      throw new InputError(
        `a mapping key is a ${Array.isArray(node) ? "list" : "mapping"}, which parsing turns into a string, so it would compare equal to a string key`,
      );
  return data;
}

/** The data a JSON or YAML document encodes; YAML is a superset of JSON, so
 * either syntax parses either file. A number `unfaithful` names is refused:
 * YAML's as it is constructed, JSON's by a walk of the parsed values, since a
 * JSON key is always a string and JSON has no infinity literal. A YAML text
 * with no document parses to `undefined`; an explicit `null` is a document. */
export function parseData(text: string, path: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    const data = JSON.parse(text) as unknown;
    const problem = firstUnfaithful(data);
    if (problem) throw new InputError(problem);
    return data;
  }
  if (ext === ".yaml" || ext === ".yml") return loadYamlData(text);
  throw new InputError(`${path}: not .json, .yaml or .yml`);
}

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}

function show(value: unknown): string {
  const text =
    typeof value === "number" && !Number.isFinite(value)
      ? String(value)
      : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Scalar equality; NaN, which YAML's `.nan` parses to, is the one value unequal to itself. */
const sameScalar = (a: unknown, b: unknown) =>
  a === b || (Number.isNaN(a) && Number.isNaN(b));

/** Every path at which `committed` and `fresh` differ, as data. */
export function differences(
  committed: unknown,
  fresh: unknown,
  path = "$",
): string[] {
  if (isRecord(committed) && isRecord(fresh))
    return recordDifferences(committed, fresh, path);
  if (Array.isArray(committed) && Array.isArray(fresh))
    return listDifferences(committed, fresh, path);
  if (kind(committed) !== kind(fresh))
    return [`${path}: ${kind(committed)} committed, ${kind(fresh)} fresh`];
  if (!sameScalar(committed, fresh))
    return [`${path}: ${show(committed)} committed, ${show(fresh)} fresh`];
  return [];
}

function recordDifferences(
  committed: Record<string, unknown>,
  fresh: Record<string, unknown>,
  path: string,
): string[] {
  const keys = [
    ...new Set([...Object.keys(committed), ...Object.keys(fresh)]),
  ].sort();
  return keys.flatMap((key) => {
    const at = `${path}.${key}`;
    if (!Object.hasOwn(fresh, key))
      return [`${at}: committed has it, fresh does not`];
    if (!Object.hasOwn(committed, key))
      return [`${at}: fresh has it, committed does not`];
    return differences(committed[key], fresh[key], at);
  });
}

function listDifferences(
  committed: unknown[],
  fresh: unknown[],
  path: string,
): string[] {
  const found =
    committed.length === fresh.length
      ? []
      : [
          `${path}: a list of ${committed.length} committed, ${fresh.length} fresh`,
        ];
  const shared = Math.min(committed.length, fresh.length);
  for (let i = 0; i < shared; i++)
    found.push(...differences(committed[i], fresh[i], `${path}[${i}]`));
  return found;
}

interface Options {
  command: string;
  committedPath: string;
  freshPath: string;
}

function parseArgs(args: string[]): Options {
  let command = "the generator";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--command") {
      const value = args[++i];
      if (!value) throw new InputError(usage);
      command = value;
    } else if (arg.startsWith("-")) throw new InputError(usage);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new InputError(usage);
  const [committedPath, freshPath] = positional as [string, string];
  return { command, committedPath, freshPath };
}

/** Why the first number in parsed JSON `unfaithful` names cannot be
 * compared, or undefined when every number can. */
export function firstUnfaithful(
  value: unknown,
  path = "$",
): string | undefined {
  if (typeof value === "number") return unfaithful(value, `at ${path}`);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [`${path}[${i}]`, item])
    : isRecord(value)
      ? Object.entries(value).map(([key, item]) => [`${path}.${key}`, item])
      : [];
  for (const [at, item] of entries) {
    const problem = firstUnfaithful(item, at);
    if (problem) return problem;
  }
  return undefined;
}

/** One side's data, or why it cannot be checked: unreadable, unparsable, or no document. */
function loadData(what: string, path: string): { data: unknown } | Error {
  let text: string;
  try {
    text = readRegularFile(path);
  } catch (error) {
    return new Error(
      `cannot read the ${what} file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!text.trim()) return new Error(`the ${what} file ${path} is empty`);
  let data: unknown;
  try {
    data = parseData(text, path);
  } catch (error) {
    return new Error(
      `cannot parse the ${what} file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (data === undefined)
    return new Error(`the ${what} file ${path} holds no document`);
  return { data };
}

function main(args: string[]): number {
  const { command, committedPath, freshPath } = parseArgs(args);
  const committed = loadData("committed", committedPath);
  if (committed instanceof Error) return couldNotCheck(RULE, committed.message);
  const fresh = loadData("fresh", freshPath);
  if (fresh instanceof Error) return couldNotCheck(RULE, fresh.message);
  const found = differences(committed.data, fresh.data);
  if (found.length) {
    const findings: Finding[] = found.map((problem) => ({
      rule: RULE,
      file: committedPath,
      problem: `differs from the fresh output at ${problem}`,
      remedy: `regenerate it with ${command}; never edit it to match`,
    }));
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${committedPath} and ${freshPath} encode the same data`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
