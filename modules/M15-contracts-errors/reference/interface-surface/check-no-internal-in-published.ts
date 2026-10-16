#!/usr/bin/env bun
// No internal operation in the published contract.
//
// The rule it holds. An interface is internal unless a named external
// consumer justifies publishing it, and the published contract document is
// what that consumer builds against. An internal operation that lands in it
// is a commitment nobody decided to make: the first integration against it
// makes its shape permanent. The published and the internal documents are
// generated from one source, each operation marked once, so this gate reads
// the published document and fails on any mark of the internal kind.
//
// What it does. Reads one contract document (OpenAPI, JSON or YAML) and
// reports each operation that carries a tag matching `--tag`, whose path
// matches `--path`, or that sets the `--extension` field (on the operation or
// its path item) to true; and each tag in the document's tag catalog that
// matches `--tag`, since a catalog entry is published documentation too. An
// operation whose `tags` is not absent or an array of strings cannot be
// read, so the gate stops rather than guess. A path item that is a local
// reference is read through it.
//
// Exit codes: 0 no internal operation, 1 findings, 2 could not check (the
// document missing, unreadable, empty or not a contract, no operation under
// `paths`, a path item or an operation that is not an object, a path item
// reference the gate cannot follow, an unreadable `tags`, a pattern that is
// not a regular expression, a bad option).
//
// Usage:
//   check-no-internal-in-published.ts [--tag '\(Internal\)$']
//     [--path '^/internal(/|$)'] [--extension x-internal] <contract>
import { cli } from "../../../../lib/cli.ts";
import { type Finding, reportFindings } from "../../../../lib/findings.ts";
import {
  InputError,
  isRecord,
  type Operation,
  operations,
  optionValue,
  readContract,
  regexOption,
} from "./shared.ts";

const RULE = "internal-in-published";
const usage =
  "usage: check-no-internal-in-published.ts [--tag <regex>] [--path <regex>] [--extension <name>] <contract>";

interface Options {
  tag: RegExp;
  path: RegExp;
  extension: string;
  contract: string;
}

function parseArgs(args: string[]): Options {
  let tag = "\\(Internal\\)$";
  let path = "^/internal(/|$)";
  let extension = "x-internal";
  const contracts: string[] = [];
  const value = (i: number, name: string) => optionValue(args, i, name, usage);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--tag") tag = value(++i, arg);
    else if (arg === "--path") path = value(++i, arg);
    else if (arg === "--extension") extension = value(++i, arg);
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else contracts.push(arg);
  }
  if (contracts.length !== 1)
    throw new InputError(`exactly one contract document is read\n${usage}`);
  if (!/^x-[\w-]+$/.test(extension))
    throw new InputError(
      `--extension must be a specification extension (x-...): ${extension}`,
    );
  return {
    tag: regexOption(tag, "--tag"),
    path: regexOption(path, "--path"),
    extension,
    contract: contracts[0] ?? "",
  };
}

/** The operation's tags; a shape that is not absent or string[] throws. */
export function tagsOf(operation: Operation): string[] {
  const tags = operation.operation.tags;
  if (tags === undefined) return [];
  if (Array.isArray(tags) && tags.every((t) => typeof t === "string"))
    return tags;
  throw new InputError(
    `${operation.method} ${operation.path}: \`tags\` is not an array of strings, so the operation cannot be classified`,
  );
}

/** The tag catalog's names (`tags:` at the root), those that are strings. */
export function catalogTags(doc: Record<string, unknown>): string[] {
  const catalog = doc.tags;
  if (!Array.isArray(catalog)) return [];
  return catalog.flatMap((entry) =>
    isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [],
  );
}

/** What marks an operation internal, in the words of the finding. */
export function internalMarks(
  operation: Operation,
  options: Pick<Options, "tag" | "path" | "extension">,
): string[] {
  const marks: string[] = [];
  for (const tag of tagsOf(operation))
    if (options.tag.test(tag)) marks.push(`the tag ${JSON.stringify(tag)}`);
  if (options.path.test(operation.path))
    marks.push(`a path matching ${options.path.source}`);
  if (operation.operation[options.extension] === true)
    marks.push(`${options.extension}: true`);
  else if (operation.pathItem[options.extension] === true)
    marks.push(`${options.extension}: true on its path item`);
  return marks;
}

export function main(args = process.argv.slice(2)): number {
  const options = parseArgs(args);
  const doc = readContract(options.contract);
  const found = operations(doc);
  const findings: Finding[] = [];
  for (const operation of found) {
    const marks = internalMarks(operation, options);
    if (marks.length > 0)
      findings.push({
        rule: RULE,
        file: options.contract,
        problem: `${operation.method} ${operation.path} is internal (${marks.join(", ")}) and is in the published contract.`,
        remedy:
          "Regenerate the published document with the internal filter, or, if the operation is now public, name its external consumer in the change and remove the mark at the source.",
      });
  }
  for (const tag of catalogTags(doc))
    if (options.tag.test(tag))
      findings.push({
        rule: RULE,
        file: options.contract,
        problem: `the tag catalog lists ${JSON.stringify(tag)}, an internal tag, in the published contract.`,
        remedy:
          "Leave internal tags out of the published document's catalog when the generator filters their operations.",
      });
  if (findings.length > 0) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `OK — ${found.length} operation(s) in ${options.contract}, none internal`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
