#!/usr/bin/env bun
// Registered facts (module M2): every count stated in prose equals the count
// derived from its source, and nothing generated is committed.
//
// The problem it closes. A number that describes a list the repository
// holds ("120 skills", "the 6 passes") is a cache of that list written by
// hand: it drifts the moment the list changes, and a reader acts on the
// stale copy. Dropping the number is the first choice. A number that earns
// its place is declared once in a registry, with the source it is derived
// from and the phrasings a stated copy may take, and this check re-derives
// it in memory on every run and fails when a stated copy disagrees. It flags
// drift, never presence: a fact nobody states has nothing to check.
//
// Registry (YAML):
//
//   facts:
//     - id: guides
//       files: "guides/**/*.md"      # count of repository files matching
//       exclude: ["**/index.md"]     # optional, same form
//       phrasings:
//         - "N guides total"         # literal text; N stands for the number
//         - "a total of N guides"
//     - id: tools
//       command: "ls tools | wc -l"  # a command that prints the count
//       phrasings: ["N tools listed"]
//
// A phrasing is literal text with exactly one `N` standing alone (beside
// spaces or punctuation, as in `(N) guides` or `N, guides`), matched
// whole-word, regardless of letter case and of how much whitespace, a line
// break included, separates its words, so "3 guides total", "3  Guides
// total" and "3 guides" wrapped before "total" all count as stated copies of
// `N guides total` and "13 guides total" does not. A number two phrasings of
// one fact both match is one stated copy. Each fact derives by exactly one of
// `files` (globs over the repository's files present on disk, relative to the
// root, each of which must match a file) and `command` (one command, run in
// the root with the deadline of `$JIG_COMMAND_TIMEOUT_SEC`, 30 minutes unset;
// its output is the count). Code spans and fenced blocks are never stated
// copies.
//
// Exit codes: 0 every stated copy agrees, or none is stated; 1 a stated copy
// disagrees; 2 the registry cannot be read or does not parse, a fact's
// source cannot be derived (a `files` glob that matches nothing is a wrong
// path, not an empty set; a command that fails, times out or prints no
// integer, or one past 2^53), or a
// prose file cannot be read or is empty.
//
// Usage: check-registered-facts.ts [--root <dir>] <registry.yaml> <prose-file>...
import { resolve } from "node:path";
import { runShell } from "../../../../lib/bounded-shell.ts";
import { cli } from "../../../../lib/cli.ts";
import {
  blankCode,
  readRegularFile,
  repoFiles,
} from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { load as loadYaml } from "../../../../lib/vendor/js-yaml.mjs";

/** An argument or a registry this check was given that it cannot use. */
export class InputError extends Error {}

const usage =
  "usage: check-registered-facts.ts [--root <dir>] <registry.yaml> <prose-file>...";
const RULE = "registered-fact";

/** The number's place in a phrasing: an `N` with no word character or hyphen beside it. */
const PLACEHOLDER = /(?<![\w-])N(?![\w-])/g;

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface Fact {
  id: string;
  /** How the fact derives: globs over the repository's files, or a command. */
  source: { files: string[]; exclude: string[] } | { command: string };
  phrasings: string[];
}

function strings(value: unknown, what: string): string[] {
  const list = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((item) => typeof item === "string" && item.trim())
  )
    throw new InputError(
      `${what} must be a string or a non-empty list of strings`,
    );
  return list as string[];
}

/** How one fact derives, from the fields of its entry. */
function parseSource(
  at: string,
  fields: { files: unknown; exclude: unknown; command: unknown },
): Fact["source"] {
  const { files, exclude, command } = fields;
  if ((files === undefined) === (command === undefined))
    throw new InputError(`${at} derives by exactly one of files, command`);
  if (command !== undefined) {
    if (exclude !== undefined)
      throw new InputError(`${at}: exclude goes with files, not command`);
    if (typeof command !== "string" || !command.trim())
      throw new InputError(`${at}.command must be one command, as a string`);
    return { command };
  }
  return {
    files: strings(files, `${at}.files`),
    exclude: exclude === undefined ? [] : strings(exclude, `${at}.exclude`),
  };
}

/** One registry entry as a fact, or the reason it is not one. */
function parseFact(entry: unknown, index: number, ids: Set<string>): Fact {
  const at = `facts[${index}]`;
  if (!isRecord(entry)) throw new InputError(`${at} must be a map`);
  const { id, files, exclude, command, phrasings, ...rest } = entry;
  if (typeof id !== "string" || !id.trim())
    throw new InputError(`${at} needs an id`);
  if (ids.has(id))
    throw new InputError(`${at}: the id "${id}" is declared twice`);
  ids.add(id);
  const unknown = Object.keys(rest);
  if (unknown.length)
    throw new InputError(`${at} (${id}): unknown field ${unknown.join(", ")}`);
  const source = parseSource(`${at} (${id})`, { files, exclude, command });
  const said = strings(phrasings, `${at} (${id}).phrasings`);
  for (const phrasing of said)
    if ((phrasing.match(PLACEHOLDER) ?? []).length !== 1)
      throw new InputError(
        `${at} (${id}): the phrasing "${phrasing}" needs exactly one N for the number`,
      );
  return { id, source, phrasings: said };
}

/** The facts of a registry text, or the reason it is not one. */
export function parseRegistry(text: string): Fact[] {
  if (!text.trim()) throw new InputError("the registry is empty");
  let parsed: unknown;
  try {
    parsed = loadYaml(text);
  } catch (error) {
    throw new InputError(`the registry is not YAML: ${reason(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.facts) || !parsed.facts.length)
    throw new InputError("the registry must hold a non-empty `facts:` list");
  const ids = new Set<string>();
  return parsed.facts.map((entry: unknown, index: number) =>
    parseFact(entry, index, ids),
  );
}

/** Literal text, its whitespace runs matching any whitespace. */
const literal = (text: string) =>
  text
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");

/** The pattern of one phrasing: literal words, `N` the number, any spacing.
 * `N` is found by the same `PLACEHOLDER` the registry is validated with. */
export function phrasingPattern(phrasing: string): RegExp {
  const [before = "", after = ""] = phrasing.trim().split(PLACEHOLDER);
  const body = `${literal(before)}(\\d+)${literal(after)}`;
  return new RegExp(`(?<![\\w-])${body}(?![\\w-])`, "dgi");
}

/** The count a command prints, or the reason it does not print one. */
async function commandCount(
  id: string,
  command: string,
  root: string,
): Promise<number | Error> {
  let result: Awaited<ReturnType<typeof runShell>>;
  try {
    result = await runShell(command, { cwd: root });
  } catch (error) {
    return new Error(`the command of "${id}" could not run: ${reason(error)}`);
  }
  const output = result.stdout.trim();
  if (result.timedOut) return new Error(`the command of "${id}" timed out`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || output;
    return new Error(
      `the command of "${id}" exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (result.stdoutTruncated)
    return new Error(
      `the command of "${id}" printed more output than is kept, not a count`,
    );
  if (!/^\d+$/.test(output))
    return new Error(`the command of "${id}" printed "${output}", not a count`);
  const count = Number(output);
  if (!Number.isSafeInteger(count))
    return new Error(
      `the command of "${id}" printed ${output}, past 2^53, which a number cannot hold exactly`,
    );
  return count;
}

/** The repository files the globs match, less the excluded; each glob must match one. */
function filesCount(
  id: string,
  source: { files: string[]; exclude: string[] },
  root: string,
): number | Error {
  const files = repoFiles(root);
  const matched = new Set<string>();
  for (const pattern of source.files) {
    const glob = new Bun.Glob(pattern);
    const hits = files.filter((file) => glob.match(file));
    if (!hits.length)
      return new Error(
        `the files glob "${pattern}" of "${id}" matches no repository file under ${root}: a wrong glob, not an empty set`,
      );
    for (const hit of hits) matched.add(hit);
  }
  const exclude = source.exclude.map((glob) => new Bun.Glob(glob));
  const count = [...matched].filter(
    (file) => !exclude.some((glob) => glob.match(file)),
  ).length;
  if (count === 0)
    return new Error(
      `the files of "${id}" (${source.files.join(", ")}) are all excluded under ${root}: nothing left to count`,
    );
  return count;
}

/** The count a fact derives to, or the reason it cannot be derived. */
export function derive(fact: Fact, root: string): Promise<number | Error> {
  return "command" in fact.source
    ? commandCount(fact.id, fact.source.command, root)
    : Promise.resolve(filesCount(fact.id, fact.source, root));
}

function describe(fact: Fact): string {
  return "command" in fact.source
    ? `\`${fact.source.command}\``
    : fact.source.files.join(", ");
}

/** The 1-based line of `offset` in `text`. */
const lineAt = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;

/** Each stated copy of one fact in `text`, by the offset of its number: one
 * copy per number, however many of the fact's phrasings match it. */
function copiesOf(fact: Fact, text: string): Map<number, RegExpExecArray> {
  const copies = new Map<number, RegExpExecArray>();
  for (const phrasing of fact.phrasings)
    for (const match of text.matchAll(phrasingPattern(phrasing))) {
      const at = match.indices?.[1]?.[0] ?? match.index;
      if (!copies.has(at)) copies.set(at, match);
    }
  return copies;
}

/** The stated copies of each fact in one file's prose, with the drifted ones.
 * The whole text is matched, not line by line, so a phrasing wrapped across
 * lines is still seen; a finding's line is counted from the number's offset. */
export function scanProse(
  content: string,
  facts: Map<Fact, number>,
  file: string,
): { stated: number; findings: Finding[] } {
  let stated = 0;
  const findings: Finding[] = [];
  const text = blankCode(content);
  for (const [fact, derived] of facts)
    for (const [at, match] of copiesOf(fact, text)) {
      stated++;
      // Compared exactly: a stated number past 2^53 must not round onto the count.
      if (BigInt(match[1] ?? "") === BigInt(derived)) continue;
      findings.push({
        rule: RULE,
        file,
        line: lineAt(text, at),
        problem: `states "${match[0].replace(/\s+/g, " ")}", but ${fact.id} (${describe(fact)}) has ${derived}`,
        remedy: `drop the number and let the list speak, or restate it as ${derived}; the source is ${describe(fact)}`,
      });
    }
  findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { stated, findings };
}

/** A prose file's text, or why it cannot be checked: unreadable or empty.
 * `shown` is the path as the caller wrote it, for the message. */
export function readProse(path: string, shown = path): string | Error {
  let content: string;
  try {
    content = readRegularFile(path);
  } catch (error) {
    return new Error(`cannot read ${shown}: ${reason(error)}`);
  }
  return content.trim()
    ? content
    : new Error(`${shown} is empty: nothing to check`);
}

interface Options {
  root: string;
  registryPath: string;
  proseFiles: string[];
}

function parseArgs(args: string[]): Options {
  let root = process.cwd();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--root") {
      const dir = args[++i];
      if (!dir) throw new InputError(usage);
      root = resolve(dir);
    } else if (arg.startsWith("-")) throw new InputError(usage);
    else positional.push(arg);
  }
  const [registryPath, ...proseFiles] = positional;
  if (!registryPath || !proseFiles.length) throw new InputError(usage);
  return { root, registryPath, proseFiles };
}

/** Every fact with its derived count, or the first reason one cannot be. */
async function deriveAll(
  facts: Fact[],
  root: string,
): Promise<Map<Fact, number> | Error> {
  const derived = new Map<Fact, number>();
  for (const fact of facts) {
    const value = await derive(fact, root);
    if (value instanceof Error) return value;
    derived.set(fact, value);
  }
  return derived;
}

async function main(args: string[]): Promise<number> {
  const { root, registryPath, proseFiles } = parseArgs(args);
  let facts: Fact[];
  try {
    facts = parseRegistry(readRegularFile(resolve(root, registryPath)));
  } catch (error) {
    return couldNotCheck(RULE, `${registryPath}: ${reason(error)}`);
  }
  const derived = await deriveAll(facts, root);
  if (derived instanceof Error) return couldNotCheck(RULE, derived.message);
  const findings: Finding[] = [];
  let stated = 0;
  for (const prose of proseFiles) {
    const path = resolve(root, prose);
    const content = readProse(path, prose);
    if (content instanceof Error) return couldNotCheck(RULE, content.message);
    const result = scanProse(content, derived, repoPath(root, path));
    stated += result.stated;
    findings.push(...result.findings);
  }
  for (const [fact, value] of derived)
    console.log(
      `${RULE}: ${fact.id} derives to ${value} from ${describe(fact)}`,
    );
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${stated} stated cop${stated === 1 ? "y" : "ies"} of ${derived.size} fact(s) in ${proseFiles.length} file(s); none disagrees`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
