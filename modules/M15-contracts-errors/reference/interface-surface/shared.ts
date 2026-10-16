// Shared by the two interface-surface gates: the typed error their exit-code
// boundary maps to "could not check", the reader and parser of a contract
// document (an OpenAPI document as JSON or YAML), the walk over its
// operations and the resolver of a local reference.
import { isAbsolute, resolve } from "node:path";
import { readRegularFile } from "../../../../lib/files.ts";
import { isRecord } from "../../../../lib/record.ts";

/**
 * An input the gate cannot read or use. The boundary (`lib/cli.ts`) prints
 * its message and exits 2, so a bad input never reads as a pass.
 */
export class InputError extends Error {}

/** A plain object, as the document's nodes are: the shared guard. */
export { isRecord } from "../../../../lib/record.ts";

/** The HTTP methods an OpenAPI path item carries operations under. */
export const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export interface Operation {
  /** Upper case, as a finding names it. */
  method: string;
  path: string;
  operation: Record<string, unknown>;
  /** The path item the operation sits in, for its shared parameters. */
  pathItem: Record<string, unknown>;
}

/**
 * The contract `text`, parsed as JSON when `name` ends in `.json` and as
 * YAML otherwise. Empty text, text that does not parse, or a document whose
 * root is not an object throws: the gate must not pass on nothing.
 */
export function parseContract(
  text: string,
  name: string,
): Record<string, unknown> {
  if (text.trim() === "")
    throw new InputError(`the contract is empty: ${name}`);
  let parsed: unknown;
  try {
    parsed = name.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (error) {
    throw new InputError(`the contract does not parse: ${name}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed))
    throw new InputError(`the contract's root is not an object: ${name}`);
  return parsed;
}

/**
 * The contract document at `path` (relative to `root`, default the working
 * directory). A file that is missing or unreadable throws, as does what
 * `parseContract` refuses.
 */
export function readContract(
  path: string,
  root = process.cwd(),
): Record<string, unknown> {
  const full = isAbsolute(path) ? path : resolve(root, path);
  let text: string;
  try {
    text = readRegularFile(full);
  } catch (error) {
    throw new InputError(`the contract cannot be read: ${path}`, {
      cause: error,
    });
  }
  return parseContract(text, path);
}

/**
 * Every operation under `paths`, in document order. A path item that is a
 * local reference (`$ref: "#/components/pathItems/Orders"`) is read through
 * it, its own fields beside the reference added to the referenced item's.
 * A document without a `paths` object, a path item or an operation that is
 * not an object, a path item reference the gate cannot follow, or a
 * document with no operation throws: a generator that produced nothing, or
 * something the gate cannot read, is not a clean contract.
 */
export function operations(doc: Record<string, unknown>): Operation[] {
  const paths = doc.paths;
  if (!isRecord(paths))
    throw new InputError("the contract has no `paths` object");
  const found: Operation[] = [];
  for (const [path, raw] of Object.entries(paths)) {
    // The paths object carries specification extensions beside its paths.
    if (path.startsWith("x-")) continue;
    const item = pathItem(doc, raw, path);
    for (const method of METHODS) {
      if (!(method in item)) continue;
      const operation = item[method];
      if (!isRecord(operation))
        throw new InputError(
          `${method.toUpperCase()} ${path}: an operation that is not an object`,
        );
      found.push({
        method: method.toUpperCase(),
        path,
        operation,
        pathItem: item,
      });
    }
  }
  if (found.length === 0)
    throw new InputError("the contract declares no operation under `paths`");
  return found;
}

/**
 * The path item at `path`, through a chain of local references. A field the
 * item sets beside its reference that the referenced item sets too has no
 * defined meaning, so it throws, as does an item that is not an object.
 */
function pathItem(
  doc: Record<string, unknown>,
  raw: unknown,
  path: string,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (!isRecord(raw))
    throw new InputError(`${path}: a path item that is not an object`);
  if (!("$ref" in raw)) return raw;
  const { $ref, ...own } = raw;
  if (typeof $ref !== "string" || seen.has($ref))
    throw new InputError(
      `${path}: a path item reference the gate cannot follow: ${String($ref)}`,
    );
  const target = pathItem(
    doc,
    resolvePointer(doc, $ref),
    path,
    new Set([...seen, $ref]),
  );
  for (const key of Object.keys(own))
    if (key in target)
      throw new InputError(
        `${path}: \`${key}\` is set both on the path item and on the item its reference points at`,
      );
  return { ...target, ...own };
}

/**
 * `node` through a chain of local references (a parameter or a request
 * body defined once under `components`). A reference loop throws.
 */
export function followRefs(
  doc: Record<string, unknown>,
  node: unknown,
): unknown {
  const seen = new Set<string>();
  let current = node;
  while (isRecord(current) && "$ref" in current) {
    const ref = current.$ref;
    if (typeof ref === "string" && seen.has(ref))
      throw new InputError(`a reference loop: ${ref}`);
    if (typeof ref === "string") seen.add(ref);
    current = resolvePointer(doc, ref);
  }
  return current;
}

/**
 * The node a local reference (`#/components/schemas/Order`) points at. A
 * reference to another document, or to a node that is not there, throws:
 * a bound the gate cannot see is not a bound it can count.
 */
export function resolvePointer(
  doc: Record<string, unknown>,
  ref: unknown,
): unknown {
  if (typeof ref !== "string" || !ref.startsWith("#/"))
    throw new InputError(
      `a reference the gate cannot follow (only local \`#/…\` references are read): ${String(ref)}`,
    );
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isRecord(node)) node = node[key];
    else node = undefined;
    if (node === undefined)
      throw new InputError(`a reference to nothing: ${ref}`);
  }
  return node;
}

/** The value after the option `name` at `index`; a missing one throws. */
export function optionValue(
  args: readonly string[],
  index: number,
  name: string,
  usage: string,
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--"))
    throw new InputError(`${name} needs a value\n${usage}`);
  return value;
}

/** A regular expression from an option, or a could-not-check. */
export function regexOption(value: string, name: string): RegExp {
  try {
    return new RegExp(value);
  } catch (error) {
    throw new InputError(`${name} is not a regular expression: ${value}`, {
      cause: error,
    });
  }
}
