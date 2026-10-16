#!/usr/bin/env bun
// Generated-file inventory runner (module M2): every declared check, one step.
//
// The problem it closes. A derived file's drift check protects the file only
// while CI runs it, and when that wiring is one hand-added CI step per
// generator, the next generator ships with a check nobody wired: green until
// its artifact rots. This runner reads one inventory, in which every derived
// file is declared once (its outputs, its source, its regenerate command and
// its check), and runs every declared check. Adding a generator means adding
// an entry, never a workflow step, and an entry without a check does not
// parse.
//
// Input. One YAML file, in either form:
//   * a standalone inventory: `generated:` is a list of entries;
//   * a change-area catalog (module M3): `areas:` is a map, and an area's
//     optional `generated:` is a list of the same entries, which it owns.
// An entry has `outputs` (the committed files, each declared once), `source`
// (globs of the files whose change calls for a regeneration, each matching a
// repository file), `command` (regenerates the outputs), `check` (exits 0
// when the outputs are fresh, 1 when stale) and optionally `notes`.
//
// Before running anything it checks what it can: each output is a
// repository-relative path to a file, declared once however it is spelled
// (`out/a.txt`, `./out/a.txt` and `out/../out/a.txt` are one file), each
// source glob matches a repository file (git's view
// of the current directory; a walk outside a checkout) and, in catalog form,
// each output is matched by its own area's `paths`, so a hand-edit to the
// output selects the area that checks it. Each problem is a finding.
//
// Running. Every distinct check command runs once, in order, through Bun's
// shell from the current directory, its output shown, each in a process of
// its own with a deadline (`$JIG_COMMAND_TIMEOUT_SEC`, 30 minutes unset);
// every check runs whatever the earlier ones did, and each result is
// reported. Exit 0 passed; exit 1 found the outputs stale, a finding whose
// fix is the entry's command, unless the shell reported it found no such
// command; a command the shell cannot parse could not start; any other exit,
// a killed or timed-out check included, could not decide.
//
// Exit codes: 0 every check passed and the inventory is sound; 1 a check
// found stale outputs or the inventory has a finding; 2 the inventory cannot
// be read, declares nothing, is malformed, or a check could not start or
// decide.
//
// Usage: run-generated-checks.ts [--list] <inventory.yaml>
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { runShell } from "../../../../lib/bounded-shell.ts";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile, repoFiles } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { load as loadYaml } from "../../../../lib/vendor/js-yaml.mjs";

/** An argument or an inventory this runner was given that it cannot use. */
export class InputError extends Error {}

const usage = "usage: run-generated-checks.ts [--list] <inventory.yaml>";
const RULE = "generated-files";

export interface GeneratedEntry {
  /** The committed files the generator writes, relative to the root. */
  outputs: string[];
  /** Globs of the files whose change calls for a regeneration. */
  source: string[];
  /** The command that regenerates the outputs. */
  command: string;
  /** The command that exits 0 when the outputs are fresh and 1 when stale. */
  check: string;
  notes?: string | undefined;
  /** Where the inventory declares it: `generated[1]`, `areas.docs.generated[0]`. */
  where: string;
  /** In catalog form, the owning area's `paths` globs. */
  ownerPaths?: string[] | undefined;
}

const FIELDS = ["outputs", "source", "command", "check", "notes"];

const isPathList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === "string" && x.trim() !== "");
const isCommand = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** What is wrong with one inventory entry; empty when it has the shape. */
export function entryProblems(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where}: not a mapping`];
  const problems = Object.keys(value)
    .filter((key) => !FIELDS.includes(key))
    .map((key) => `${where}: unknown field \`${key}\``);
  for (const field of ["outputs", "source"])
    if (!isPathList(value[field]))
      problems.push(`${where}.${field}: must list at least one path`);
  for (const field of ["command", "check"])
    if (!isCommand(value[field]))
      problems.push(`${where}.${field}: must be a command`);
  if (value.notes !== undefined && typeof value.notes !== "string")
    problems.push(`${where}.notes: not text`);
  return problems;
}

/** The problems of a `generated:` list and of each entry in it. */
export function generatedListProblems(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return [`${where}: must be a list of entries`];
  return value.flatMap((entry, i) => entryProblems(entry, `${where}[${i}]`));
}

/** An entry whose shape `entryProblems` has passed. */
function toEntry(
  value: unknown,
  where: string,
  ownerPaths?: string[],
): GeneratedEntry {
  const entry = value as Record<string, unknown>;
  return {
    outputs: entry.outputs as string[],
    source: entry.source as string[],
    command: (entry.command as string).trim(),
    check: (entry.check as string).trim(),
    notes: typeof entry.notes === "string" ? entry.notes : undefined,
    where,
    ownerPaths,
  };
}

function standalone(doc: Record<string, unknown>): GeneratedEntry[] {
  const problems = Object.keys(doc)
    .filter((key) => key !== "generated")
    .map((key) => `unknown top-level field \`${key}\``);
  problems.push(...generatedListProblems(doc.generated, "generated"));
  if (problems.length) throw new InputError(problems.join("\n"));
  const list = doc.generated as unknown[];
  if (!list.length)
    throw new InputError("`generated:` declares no derived file");
  return list.map((entry, i) => toEntry(entry, `generated[${i}]`));
}

function catalog(doc: Record<string, unknown>): GeneratedEntry[] {
  const problems: string[] = [];
  const entries: GeneratedEntry[] = [];
  for (const [id, area] of Object.entries(doc.areas as object)) {
    if (!isRecord(area)) {
      problems.push(`areas.${id}: not a mapping`);
      continue;
    }
    if (area.generated === undefined) continue;
    const where = `areas.${id}.generated`;
    const own = generatedListProblems(area.generated, where);
    if (!isPathList(area.paths))
      own.push(`areas.${id}.paths: must list at least one glob`);
    if (own.length) {
      problems.push(...own);
      continue;
    }
    const paths = area.paths as string[];
    for (const [i, entry] of (area.generated as unknown[]).entries())
      entries.push(toEntry(entry, `${where}[${i}]`, paths));
  }
  if (problems.length) throw new InputError(problems.join("\n"));
  if (!entries.length)
    throw new InputError(
      "no area of the catalog declares a `generated:` entry",
    );
  return entries;
}

/**
 * The entries of a parsed inventory, in either form. Throws, naming every
 * problem, when the document is neither form, an entry is malformed, or
 * nothing is declared: an inventory the runner cannot read never passes.
 */
export function parseInventory(doc: unknown): GeneratedEntry[] {
  if (!isRecord(doc))
    throw new InputError(
      "the inventory is not a mapping with a `generated:` list or an `areas:` map",
    );
  if (Array.isArray(doc.generated)) return standalone(doc);
  if (isRecord(doc.areas)) return catalog(doc);
  throw new InputError(
    "the inventory has neither a `generated:` list nor an `areas:` map",
  );
}

const slashes = (path: string) => path.replaceAll("\\", "/");
const isFile = (path: string) =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;
const matches = (glob: string, file: string) => new Bun.Glob(glob).match(file);
/** The path a link resolves to, or `undefined` when nothing is there to resolve. */
const realPath = (path: string) =>
  existsSync(path) ? realpathSync(path) : undefined;
/** Whether a resolved path lies outside the repository's own resolved root. */
const outside = (root: string, real: string) => {
  const inside = relative(realPath(root) ?? resolve(root), real);
  return inside.split(sep)[0] === ".." || isAbsolute(inside);
};

/** Why a declared output does not lie inside the repository, as written or once resolved. */
function placementProblem(
  output: string,
  path: string,
  real: string | undefined,
  root: string,
): [problem: string, remedy: string] | undefined {
  if (isAbsolute(output) || posix.isAbsolute(path) || path.startsWith("../"))
    return [
      `is not a path inside the repository`,
      "declare it relative to the repository root",
    ];
  // A link before a `..` decides which directory it climbs out of, and
  // collapsing it lexically would name a different file than the filesystem.
  if (slashes(output).split("/").includes(".."))
    return [
      "climbs with `..`, which a link before it can redirect",
      "declare the path without `..`",
    ];
  if (real !== undefined && outside(root, real))
    return [
      `resolves to \`${real}\`, outside the repository`,
      "declare the file the link points at, inside the repository",
    ];
  return undefined;
}

/**
 * What is wrong with one declared output. `declared` maps each output's
 * identity, the real path a link resolves to or else its normalized
 * spelling, to the first entry that declared it.
 */
function outputProblems(
  entry: GeneratedEntry,
  output: string,
  declared: Map<string, string>,
  root: string,
): [problem: string, remedy: string][] {
  const problems: [string, string][] = [];
  const path = posix.normalize(slashes(output));
  const real = isAbsolute(output) ? undefined : realPath(resolve(root, path));
  const placement = placementProblem(output, path, real, root);
  if (placement)
    return [
      [`${entry.where}: output \`${output}\` ${placement[0]}`, placement[1]],
    ];
  const identity = real ?? path;
  const first = declared.get(identity);
  if (first === undefined) declared.set(identity, entry.where);
  else
    problems.push([
      `${entry.where}: output \`${output}\` is already declared by ${first}`,
      "declare each derived file once",
    ]);
  if (!isFile(resolve(root, output)))
    problems.push([
      `${entry.where}: output \`${output}\` is not a file`,
      `run \`${entry.command}\` and commit the result, or drop the output`,
    ]);
  if (entry.ownerPaths && !entry.ownerPaths.some((g) => matches(g, path)))
    problems.push([
      `${entry.where}: output \`${output}\` is matched by none of its area's \`paths\``,
      "add it to the area's paths, so an edit to it selects the area that checks it",
    ]);
  return problems;
}

/**
 * The inventory's own findings: each output a file and declared once, each
 * source glob matching a repository file, and in catalog form each output
 * matched by its area's `paths`. `inventory` is the path findings name.
 */
export function inventoryFindings(
  entries: GeneratedEntry[],
  root: string,
  inventory: string,
): Finding[] {
  const findings: Finding[] = [];
  const finding = (problem: string, remedy: string) =>
    findings.push({ rule: RULE, file: inventory, problem, remedy });
  const files = repoFiles(root).map(slashes);
  const declared = new Map<string, string>();
  for (const entry of entries) {
    for (const output of entry.outputs)
      for (const [problem, remedy] of outputProblems(
        entry,
        output,
        declared,
        root,
      ))
        finding(problem, remedy);
    for (const glob of entry.source)
      if (!files.some((file) => matches(glob, file)))
        finding(
          `${entry.where}: source \`${glob}\` matches no repository file`,
          "fix the glob, or drop it",
        );
  }
  return findings;
}

export type Outcome = "passed" | "stale" | "cannot-start" | "undecided";

/** Bun's shell reports a command it found nowhere on this line of stderr. */
const NOT_FOUND = /^bun: command not found: /m;

/**
 * How a check's exit reads: 0 passed; 1 stale, unless the shell reported it
 * found no such command; anything else, a killed check included, could not
 * decide. A check that starts and exits 1 reads as stale whatever its reason.
 */
export function outcomeOf(
  exitCode: number,
  stderr: string,
  { cannotParse = false, timedOut = false } = {},
): Outcome {
  if (cannotParse) return "cannot-start";
  if (timedOut) return "undecided";
  if (exitCode === 0) return "passed";
  if (NOT_FOUND.test(stderr)) return "cannot-start";
  return exitCode === 1 ? "stale" : "undecided";
}

function describe(result: Omit<CheckResult, "check" | "entries">): string {
  if (result.outcome === "passed") return "passed";
  if (result.outcome === "stale") return "stale (exit 1)";
  if (result.outcome === "cannot-start")
    return `could not start (${result.reason ?? "the shell found no such command"})`;
  return `could not decide (${result.reason ?? `exit ${result.exitCode}`})`;
}

export interface CheckResult {
  check: string;
  /** The entries that declare this check. */
  entries: GeneratedEntry[];
  exitCode: number;
  outcome: Outcome;
  /** Why a check could not start or decide, when its exit code does not say. */
  reason?: string | undefined;
}

/** One check's result; an error starting it is a result, not an exception. */
async function runCheck(
  check: string,
  cwd: string,
): Promise<Omit<CheckResult, "check" | "entries">> {
  try {
    const result = await runShell(check, { cwd, echo: true });
    const outcome = outcomeOf(result.exitCode, result.stderr, result);
    const reason = result.timedOut
      ? "timed out"
      : result.cannotParse
        ? "the shell cannot parse it"
        : undefined;
    return { exitCode: result.exitCode, outcome, reason };
  } catch (error) {
    return {
      exitCode: -1,
      outcome: "cannot-start",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run every distinct check once, in declaration order, from `cwd`, showing
 * its output. Every check runs whatever the earlier ones did, a check that
 * cannot start or times out included, so one run reports every stale
 * artifact.
 */
export async function runChecks(
  entries: GeneratedEntry[],
  cwd: string,
): Promise<CheckResult[]> {
  const byCheck = new Map<string, GeneratedEntry[]>();
  for (const entry of entries)
    byCheck.set(entry.check, [...(byCheck.get(entry.check) ?? []), entry]);
  const results: CheckResult[] = [];
  for (const [check, owners] of byCheck) {
    console.log(`[${results.length + 1}/${byCheck.size}] ${check}`);
    const result = await runCheck(check, cwd);
    console.log(`  ${describe(result)}`);
    results.push({ check, entries: owners, ...result });
  }
  return results;
}

function listEntry(entry: GeneratedEntry): string {
  return [
    `${entry.where}: ${entry.outputs.join(", ")}`,
    `  source: ${entry.source.join(", ")}`,
    `  command: ${entry.command}`,
    `  check: ${entry.check}`,
    ...(entry.notes ? [`  notes: ${entry.notes}`] : []),
  ].join("\n");
}

function parseArgs(args: string[]): { list: boolean; path: string } {
  let list = false;
  let path: string | undefined;
  for (const arg of args) {
    if (arg === "--list") list = true;
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else if (path !== undefined)
      throw new InputError(`more than one inventory\n${usage}`);
    else path = arg;
  }
  if (path === undefined) throw new InputError(usage);
  return { list, path };
}

/** The runner; `cwd` is the root the commands run from and paths resolve against. */
export async function main(
  args: string[],
  { cwd = process.cwd() }: { cwd?: string } = {},
): Promise<number> {
  const { list, path } = parseArgs(args);
  const inventory = resolve(cwd, path);
  const entries = parseInventory(loadYaml(readRegularFile(inventory)));
  if (list) {
    for (const entry of entries) console.log(listEntry(entry));
    return 0;
  }
  const findings = inventoryFindings(entries, cwd, repoPath(cwd, inventory));
  const results = await runChecks(entries, cwd);
  for (const result of results)
    if (result.outcome === "stale")
      for (const entry of result.entries)
        findings.push({
          rule: RULE,
          file: entry.outputs[0],
          problem: `stale: \`${result.check}\` exited 1 for ${entry.outputs.join(", ")}`,
          remedy: `run \`${entry.command}\` and commit the result`,
        });
  reportFindings(findings);
  const outputs = entries.reduce((n, entry) => n + entry.outputs.length, 0);
  const undecided = results.filter(
    (r) => r.outcome === "cannot-start" || r.outcome === "undecided",
  );
  if (undecided.length)
    return couldNotCheck(
      RULE,
      `${undecided.length} of ${results.length} check(s) could not decide: ${undecided
        .map((r) => `\`${r.check}\` ${describe(r)}`)
        .join("; ")}`,
    );
  if (findings.length) {
    console.error(
      `${RULE}: ${findings.length} finding(s) over ${results.length} check(s) and ${outputs} declared output(s)`,
    );
    return 1;
  }
  console.log(
    `${RULE}: OK — ${results.length} check(s) passed for ${outputs} declared output(s) in ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
