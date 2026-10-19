#!/usr/bin/env bun
/**
 * Check one issue's label set against the repository's label taxonomy before
 * anything is written to the tracker.
 *
 * Usage (from the repository root):
 *     bun validate-labels.ts [--taxonomy <path>] [--json] [--check-tracker] <label>...
 *     echo '["bug", "small"]' | bun validate-labels.ts [--json]
 *
 * The taxonomy is `--taxonomy`, else the repository's `issue_tracker.taxonomy`
 * (relative to the repository root), else `label-taxonomy.yaml` at the root.
 * `--check-tracker` also requires every label to name exactly one tracker
 * label, exactly and case included, as the tracker adapter does when it writes.
 * `--json` prints `{ valid, labels, errors, warnings, parsed }`.
 *
 * Exit codes: 0 the labels are valid (warnings may be printed), 3 they are
 * not, 1 the taxonomy is missing, unreadable or fails its lint, or the tracker
 * could not be read, 2 usage.
 */
import { existsSync } from "node:fs";
import {
  openTracker,
  type Tracker,
} from "../../do-item/scripts/lib/tracker/index.ts";
import { taxonomyPath } from "./lib/config.ts";
import { lintTaxonomyFile } from "./lib/taxonomy.ts";
import { type Validation, validateLabels } from "./lib/validate.ts";
import type { Taxonomy } from "./lib/taxonomy.ts";

const USAGE =
  "usage: validate-labels.ts [--taxonomy <path>] [--json] [--check-tracker] <label>...\n" +
  "       (or the labels as a JSON array on stdin)";

export interface Deps {
  /** The consumer's tracker, opened only for `--check-tracker`. */
  openTracker: () => Pick<Tracker, "listLabels">;
  /** Standard input, read only when no label is given as an argument. */
  readStdin: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const defaultDeps: Deps = {
  openTracker: () => openTracker(),
  readStdin,
};

interface Options {
  taxonomy?: string;
  json: boolean;
  checkTracker: boolean;
  labels: string[];
}

/** The parsed command line, or a usage message. */
function parseArgs(argv: string[]): Options | string {
  const options: Options = { json: false, checkTracker: false, labels: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") options.json = true;
    else if (arg === "--check-tracker") options.checkTracker = true;
    else if (arg === "--taxonomy") {
      const value = argv[++i];
      if (value === undefined || value === "") return "--taxonomy needs a path";
      options.taxonomy = value;
    } else if (arg.startsWith("--taxonomy="))
      options.taxonomy = arg.slice("--taxonomy=".length);
    else if (arg === "--") {
      options.labels.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) return `unknown option: ${arg}`;
    else options.labels.push(arg);
  }
  return options;
}

/** The labels a JSON array on stdin names, or a usage message. */
function stdinLabels(text: string): string[] | string {
  if (text.trim() === "") return "no labels given";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "standard input is not a JSON array of label names";
  }
  if (!Array.isArray(value) || !value.every((l) => typeof l === "string"))
    return "standard input is not a JSON array of label names";
  return value.length ? value : "no labels given";
}

function print(result: Validation, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    result.valid
      ? `VALID (${result.labels.length} label${result.labels.length === 1 ? "" : "s"})`
      : "INVALID",
  );
  for (const error of result.errors) console.log(`  ERROR: ${error}`);
  for (const warning of result.warnings) console.log(`  WARNING: ${warning}`);
}

/** Ends the run with an exit code and a message for standard error. */
class Stop extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The labels to check: the arguments, else a JSON array on stdin. */
async function readLabels(options: Options, deps: Deps): Promise<string[]> {
  if (options.labels.length) return options.labels;
  const read = stdinLabels(await deps.readStdin());
  if (typeof read === "string") throw new Stop(2, `${read}\n${USAGE}`);
  return read;
}

/** The taxonomy at `--taxonomy`, else the configured one, if it passes its lint. */
function loadTaxonomy(option: string | undefined): Taxonomy {
  let path: string;
  try {
    path = option ?? taxonomyPath();
  } catch (e) {
    throw new Stop(1, `ERROR: ${reason(e)}`);
  }
  if (!existsSync(path))
    throw new Stop(
      1,
      `ERROR: label taxonomy not found: ${path} (set issue_tracker.taxonomy, or pass --taxonomy)`,
    );
  let lint: ReturnType<typeof lintTaxonomyFile>;
  try {
    lint = lintTaxonomyFile(path);
  } catch (e) {
    throw new Stop(
      1,
      `ERROR: label taxonomy not readable: ${path}: ${reason(e)}`,
    );
  }
  if (lint.taxonomy === null)
    throw new Stop(
      1,
      `ERROR: the label taxonomy ${path} fails its lint, so no label can be checked against it:\n${lint.problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  return lint.taxonomy;
}

/**
 * The labels the tracker has none of, and those it has more than one of, by
 * the rule the tracker adapter writes with: a name matches a tracker label
 * exactly, case included, and must match exactly one.
 */
async function unresolvedInTracker(
  labels: string[],
  deps: Deps,
): Promise<{ missing: string[]; ambiguous: string[] }> {
  const counts = new Map<string, number>();
  try {
    for (const { name } of await deps.openTracker().listLabels())
      counts.set(name, (counts.get(name) ?? 0) + 1);
  } catch (e) {
    throw new Stop(
      1,
      `ERROR: the tracker's labels could not be read: ${reason(e)}`,
    );
  }
  const unique = [...new Set(labels)];
  return {
    missing: unique.filter((l) => !counts.has(l)),
    ambiguous: unique.filter((l) => (counts.get(l) ?? 0) > 1),
  };
}

async function run(argv: string[], deps: Deps): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") throw new Stop(2, `${options}\n${USAGE}`);
  const labels = await readLabels(options, deps);
  const result = validateLabels(labels, loadTaxonomy(options.taxonomy));
  if (options.checkTracker) {
    const { missing, ambiguous } = await unresolvedInTracker(
      result.labels,
      deps,
    );
    if (missing.length)
      result.errors.push(
        `not in the tracker: ${missing.join(", ")} (create ${missing.length > 1 ? "them" : "it"} there, or fix the name; names match exactly, case included)`,
      );
    if (ambiguous.length)
      result.errors.push(
        `more than one tracker label named: ${ambiguous.join(", ")} (rename or merge them in the tracker so each name is one label)`,
      );
    if (missing.length || ambiguous.length) result.valid = false;
  }
  print(result, options.json);
  return result.valid ? 0 : 3;
}

export async function main(
  argv: string[],
  deps: Deps = defaultDeps,
): Promise<number> {
  try {
    return await run(argv, deps);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(e.message);
    return e.code;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
