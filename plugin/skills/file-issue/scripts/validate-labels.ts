#!/usr/bin/env bun
/**
 * Check one issue's label set against the repository's label taxonomy before
 * anything is written to the tracker.
 *
 * Usage (from the repository root):
 *     bun validate-labels.ts [--taxonomy <path>] [--json] [--check-tracker] <label>...
 *     bun validate-labels.ts --type bug --priority 2 --size small [<label>...]
 *     echo '["bug", "small"]' | bun validate-labels.ts [--json]
 *     bun validate-labels.ts [--json] --input issue.json
 *     bun validate-labels.ts --native-type Epic <label>...
 *
 * Given the issue's facets (`--type`, `--priority`, `--size`, or the issue
 * `tracker.ts create` takes, `{ labels, type, priority, size }`, on stdin or
 * in the file `--input` names),
 * the type, the size and the priority are checked as the facets they are:
 * each required (no size on an epic where the taxonomy says so), the
 * priority 1 (urgent) to 4 (low), and a type or size label among the labels
 * refused, since the tracker writes those facets itself.
 *
 * Given the issue's own tracker type (`--native-type`, or the `nativeType`
 * `get_issue.ts` prints, in the issue on stdin or in `--input`), an issue
 * whose type `issue_tracker.labels.epic_types` lists is checked as if it
 * carried the epic label, so a `requires` naming that label is met by it.
 *
 * The taxonomy is `--taxonomy`, else the repository's `issue_tracker.taxonomy`
 * (relative to the repository root), else `label-taxonomy.yaml` at the root.
 * `--check-tracker` also requires every label to name exactly one tracker
 * label, exactly and case included, as the tracker adapter does when it writes.
 * `--json` prints `{ valid, labels, errors, warnings, parsed }`.
 *
 * Exit codes: 0 the labels are valid (warnings may be printed), 3 they are
 * not, 1 the taxonomy is missing, unreadable or fails its lint, the tracker
 * could not be read, or, given an issue type, the label roles could not be
 * read, 2 usage.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  openTracker,
  type Tracker,
} from "../../do-item/scripts/lib/tracker/index.ts";
import {
  FACETS,
  type NewIssue,
  TrackerRequestError,
} from "../../do-item/scripts/lib/tracker/port.ts";
import { readConfig } from "../../../shared/consumer.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";
import { taxonomyPath } from "./lib/config.ts";
import { lintTaxonomyFile } from "./lib/taxonomy.ts";
import {
  type IssueFacetInput,
  type IssueTypeInput,
  type Validation,
  validateLabels,
} from "./lib/validate.ts";
import type { Taxonomy } from "./lib/taxonomy.ts";

const USAGE =
  "usage: validate-labels.ts [--taxonomy <path>] [--json] [--check-tracker]\n" +
  "                          [--type <type>] [--priority <1-4>] [--size <size>]\n" +
  "                          [--native-type <issue type>] <label>...\n" +
  "       (or the labels as a JSON array, or the issue as a JSON object, on stdin or in --input <file>)";

type LabelTracker = Pick<
  Tracker,
  "listLabels" | "filedAs" | "unavailableFacets"
>;

export interface Deps {
  /** The consumer's tracker, opened only for `--check-tracker`. */
  openTracker: () => LabelTracker;
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
  /** Set when a facet is given: the type, size and priority are checked as facets. */
  facets?: IssueFacetInput;
  /** A file holding what standard input would: the labels, or the issue. */
  input?: string;
  /** The issue's own tracker type, read beside the label roles. */
  nativeType?: string;
}

/** The options that take a value, as `--name value` or `--name=value`. */
const VALUED = /^--(taxonomy|input|type|priority|size|native-type)(?:=(.*))?$/;

/** Set the option `name` to `value`, or say why it cannot be. */
function setOption(
  options: Options,
  name: string,
  value: string | undefined,
): string | null {
  if (value === undefined || value.trim() === "")
    return `--${name} needs a ${name === "taxonomy" || name === "input" ? "path" : "value"}`;
  if (name === "taxonomy" || name === "input") options[name] = value;
  else if (name === "native-type") options.nativeType = value;
  else if (name !== "priority")
    options.facets = { ...options.facets, [name]: value };
  else if (/^[1-4]$/.test(value))
    options.facets = { ...options.facets, priority: Number(value) };
  else return "--priority must be 1 (urgent), 2 (high), 3 (medium) or 4 (low)";
  return null;
}

/** The parsed command line, or a usage message. */
function parseArgs(argv: string[]): Options | string {
  const options: Options = { json: false, checkTracker: false, labels: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const valued = VALUED.exec(arg);
    if (valued !== null) {
      const problem = setOption(
        options,
        valued[1] as string,
        valued[2] ?? argv[++i],
      );
      if (problem !== null) return problem;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--check-tracker") options.checkTracker = true;
    else if (arg === "--") {
      options.labels.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) return `unknown option: ${arg}`;
    else options.labels.push(arg);
  }
  return options;
}

const STDIN_SHAPE =
  "standard input is not a JSON array of label names, or an issue ({ labels, type, priority, size, nativeType })";

/** What is checked: the labels, and with an issue its facets and its own type. */
interface IssueRead {
  labels: string[];
  facets?: IssueFacetInput;
  nativeType?: string | null;
  filing?: NewIssue | undefined;
  /** The draft is a child whose parent is filed after this check. */
  parentPending?: boolean;
}

/** The labels, and with an issue its facets and type, that stdin names; or a usage message. */
function stdinIssue(text: string): IssueRead | string {
  if (text.trim() === "") return "no labels given";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return STDIN_SHAPE;
  }
  const names = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((l) => typeof l === "string");
  if (names(value)) return value.length ? { labels: value } : "no labels given";
  if (value === null || typeof value !== "object") return STDIN_SHAPE;
  const issue = value as Record<string, unknown>;
  const labels = issue.labels ?? [];
  if (!names(labels) || !validFacetShape(issue)) return STDIN_SHAPE;
  const facets = {
    type: (issue.type as string | null | undefined) ?? null,
    size: (issue.size as string | null | undefined) ?? null,
    priority: (issue.priority as number | undefined) ?? 0,
  };
  return {
    labels,
    facets,
    nativeType: (issue.nativeType as string | null | undefined) ?? null,
    filing: filingDraft(issue, labels, facets),
    ...(issue.parentPending === true ? { parentPending: true } : {}),
  };
}

/** Whether the facet fields of a stdin issue have their expected shapes. */
function validFacetShape(issue: Record<string, unknown>): boolean {
  const optionalText = (v: unknown) =>
    v === undefined || v === null || typeof v === "string";
  return (
    optionalText(issue.type) &&
    optionalText(issue.size) &&
    optionalText(issue.nativeType) &&
    (issue.priority === undefined || Number.isInteger(issue.priority))
  );
}

/** Only a create payload supplies the text and optional parent for placement. */
function filingDraft(
  issue: Record<string, unknown>,
  labels: string[],
  facets: { type: string | null; size: string | null; priority: number },
): NewIssue | undefined {
  const { title, description, parent } = issue;
  if (typeof title !== "string" || typeof description !== "string")
    return undefined;
  return {
    title,
    description,
    labels,
    priority: facets.priority,
    ...(facets.type === null ? {} : { type: facets.type }),
    ...(facets.size === null ? {} : { size: facets.size }),
    ...(typeof parent === "string" ? { parent } : {}),
  };
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
  constructor(code: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The labels to check, the facets and the type: the arguments, else stdin. */
async function readIssue(options: Options, deps: Deps): Promise<IssueRead> {
  const typed =
    options.nativeType === undefined ? {} : { nativeType: options.nativeType };
  if (options.labels.length || options.facets !== undefined)
    return {
      labels: options.labels,
      ...(options.facets === undefined ? {} : { facets: options.facets }),
      ...typed,
    };
  const read = stdinIssue(
    options.input === undefined
      ? await deps.readStdin()
      : readFileSync(options.input, "utf8"),
  );
  if (typeof read === "string") throw new Stop(2, `${read}\n${USAGE}`);
  return { ...read, ...typed };
}

/** The issue's type beside the repository's epic types; none without a type. */
function issueType(
  nativeType: string | null | undefined,
): IssueTypeInput | undefined {
  if (nativeType === undefined || nativeType === null) return undefined;
  try {
    return { nativeType, epics: parseTrackerLabels(readConfig()) };
  } catch (e) {
    throw new Stop(
      1,
      `ERROR: the label roles (issue_tracker.labels) could not be read: ${reason(e)}`,
    );
  }
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
  tracker: LabelTracker,
): Promise<{ missing: string[]; ambiguous: string[] }> {
  const counts = new Map<string, number>();
  try {
    for (const { name } of await tracker.listLabels())
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

/** Check a draft's omissions against the screen its adapter would use. */
async function validateFiling(
  tracker: LabelTracker,
  issue: IssueRead,
  taxonomy: Taxonomy,
  initial: Validation,
): Promise<Validation> {
  const { labels, facets, nativeType, filing } = issue;
  const missing = FACETS.filter((facet) => initial.missing.includes(facet));
  if (
    filing === undefined ||
    nativeType != null ||
    tracker.filedAs === undefined ||
    tracker.unavailableFacets === undefined
  )
    return initial;
  try {
    // Placement decides the native type, which can satisfy a rule by itself,
    // so it is resolved even when no facet is missing.
    const placement = await tracker.filedAs(
      filing,
      issue.parentPending ? { parentPending: true } : undefined,
    );
    const unavailable =
      missing.length === 0
        ? []
        : await tracker.unavailableFacets(placement.nativeType, missing);
    return validateLabels(
      labels,
      taxonomy,
      facets,
      issueType(placement.nativeType),
      unavailable,
    );
  } catch (e) {
    throw new Stop(
      e instanceof TrackerRequestError ? 3 : 1,
      `ERROR: ${reason(e)}`,
      { cause: e },
    );
  }
}

/** Whether a planned native type could turn this invalid draft into a valid epic. */
export function placementMayChangeInvalidity(
  initial: Validation,
  taxonomy: Taxonomy,
): boolean {
  const epic = parseTrackerLabels(readConfig()).epic;
  return (
    taxonomy.groups.some(
      (group) =>
        initial.missing.includes(group.id) &&
        group.notRequiredOn.includes(epic),
    ) ||
    taxonomy.categories.some(
      (category) =>
        (initial.parsed.categories[category.id]?.length ?? 0) !== 0 &&
        category.requires.includes(epic),
    ) ||
    taxonomy.flags.some(
      (flag) =>
        initial.parsed.flags.includes(flag.id) && flag.requires.includes(epic),
    )
  );
}

/** Whether a prospective epic placement can clear every non-facet error. */
function placementCouldChangeInvalidity(
  initial: Validation,
  taxonomy: Taxonomy,
  issue: IssueRead,
): boolean {
  if (!placementMayChangeInvalidity(initial, taxonomy)) return false;
  if (initial.errors.length === initial.missing.length) return true;
  const labels = parseTrackerLabels(readConfig());
  const nativeType = labels.epicTypes[0];
  if (nativeType === undefined) return false;
  return validateLabels(issue.labels, taxonomy, issue.facets, {
    nativeType,
    epics: labels,
  }).valid;
}

/** The tracker the check reads, or the stop that says it could not be opened. */
function openLabelTracker(deps: Deps): LabelTracker {
  try {
    return deps.openTracker();
  } catch (e) {
    throw new Stop(1, `ERROR: the tracker could not be opened: ${reason(e)}`, {
      cause: e,
    });
  }
}

/**
 * The verdict with the tracker's view added: the draft's screen first, then
 * every label against the tracker's labels. An invalid set is already the
 * verdict, so the labels are not read for it: that read could only hide it
 * behind a failure of its own.
 */
async function checkTracker(
  deps: Deps,
  issue: IssueRead,
  taxonomy: Taxonomy,
  initial: Validation,
): Promise<Validation> {
  // Placement can only exempt a missing facet. Other taxonomy errors already
  // decide the result, except where its native epic type can satisfy a label
  // rule. In that case validateFiling must get the chance to revalidate it.
  if (!initial.valid && initial.errors.length > initial.missing.length) {
    let placementCanChange: boolean;
    try {
      placementCanChange = placementCouldChangeInvalidity(
        initial,
        taxonomy,
        issue,
      );
    } catch (e) {
      throw new Stop(
        1,
        `ERROR: the label roles (issue_tracker.labels) could not be read: ${reason(e)}`,
        { cause: e },
      );
    }
    if (!placementCanChange) return initial;
  }
  const tracker = openLabelTracker(deps);
  const result = await validateFiling(tracker, issue, taxonomy, initial);
  if (!result.valid) return result;
  const { missing, ambiguous } = await unresolvedInTracker(
    result.labels,
    tracker,
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
  return result;
}

async function run(argv: string[], deps: Deps): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === "string") throw new Stop(2, `${options}\n${USAGE}`);
  const issue = await readIssue(options, deps);
  const { labels, facets, nativeType } = issue;
  const taxonomy = loadTaxonomy(options.taxonomy);
  let result = validateLabels(labels, taxonomy, facets, issueType(nativeType));
  if (options.checkTracker)
    result = await checkTracker(deps, issue, taxonomy, result);
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
