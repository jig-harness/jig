#!/usr/bin/env bun
/**
 * Derive an issue's work type, and the depth its row gives, from the issue
 * JSON `get_issue.ts` prints and the consumer's configuration
 * (`issue_tracker.types`, `do_item.work_types`; `lib/work-types.ts`).
 *
 * The steps, first answer wins:
 *   1. a label one type lists in `issue_tracker.types`;
 *   2. the tracker's own issue type (`nativeType`), matched to a type name
 *      ignoring case;
 *   3. the title's Conventional Commits prefix, when the repository's title
 *      convention is conventional (`pull_requests.title_format`, else
 *      derived as `pr-plan.ts` derives it);
 *   4. otherwise `unknown`, whose depth is the strictest of every field.
 * A step whose value names no type of the repository leaves the step
 * unanswered, and the evidence says what it saw.
 *
 * Type: Discovery
 * Input: JSON with the issue's `labels`, `title` and `nativeType`
 * Output: JSON `{ type, evidence, depth }`
 *
 * Usage:
 *     bun determine_type.ts <issue-json-file>
 *     bun determine_type.ts -          (reads stdin)
 *
 * Exit codes: 0 typed (`unknown` included), 2 unreadable input, 1 a
 * configuration the loading rules refuse.
 */

import { readFileSync } from "node:fs";
import {
  consumerRoot,
  readConfig,
  withSource,
} from "../../../shared/consumer.ts";
import { isRecord } from "../../../shared/guards.ts";
import { baseBranch } from "../../drive-pr/scripts/lib/overlay.ts";
import {
  detectTitleFormat,
  parsePrPolicy,
} from "../../drive-pr/scripts/lib/pr-policy.ts";
import { parseArgs, runEntry } from "./lib/cli.ts";
import {
  type DepthRow,
  depthOf,
  parseWorkTypes,
  UNKNOWN_TYPE,
  type WorkTypes,
} from "./lib/work-types.ts";

/** The Conventional Commits types that name a work type. */
export const PREFIX_TYPES: Readonly<Record<string, string>> = {
  fix: "bug",
  feat: "feature",
  chore: "task",
  docs: "task",
  refactor: "improvement",
  perf: "improvement",
};

/** `type(scope)!: summary`, the type in any case. */
const PREFIX = /^\s*([A-Za-z]+)(?:\([^()]*\))?!?:\s/;

export type Step = "label" | "tracker_type" | "title_prefix";

export interface Evidence {
  /** The step that decided, or `none` when the type is `unknown`. */
  step: Step | "none";
  /** What it matched: the label, the tracker's type or the prefix. */
  matched: string | null;
  /** One line for the status message. */
  summary: string;
  /** The steps before the deciding one that saw something but did not answer. */
  unanswered: Array<{ step: Step; reason: string }>;
}

export interface TypeVerdict {
  type: string;
  evidence: Evidence;
  depth: DepthRow;
}

export interface IssueFacts {
  labels: string[];
  title: string;
  nativeType: string | null;
}

/** The repository's title convention, and where it came from. */
export interface TitleConvention {
  value: "conventional" | "free";
  source: string;
}

const fold = (s: string) => s.trim().toLowerCase();

type Answer =
  | { type: string; matched: string; summary: string }
  | { unanswered: string }
  | { conflict: string }
  | null;

function byLabel(issue: IssueFacts, workTypes: WorkTypes): Answer {
  const hits = new Map<string, string>();
  for (const label of issue.labels)
    for (const type of workTypes.types)
      if (
        !hits.has(type) &&
        (workTypes.labels[type] ?? []).some((l) => fold(l) === fold(label))
      )
        hits.set(type, label);
  if (hits.size === 0) return null;
  const found = [...hits];
  if (found.length > 1)
    return {
      conflict: `its labels mark more than one type (${found.map(([t, l]) => `${l}: ${t}`).join(", ")})`,
    };
  const [type, label] = found[0] as [string, string];
  return {
    type,
    matched: label,
    summary: `label ${label} (issue_tracker.types.${type})`,
  };
}

function byTrackerType(issue: IssueFacts, workTypes: WorkTypes): Answer {
  if (issue.nativeType === null || issue.nativeType.trim() === "") return null;
  const type = workTypes.types.find((t) => t === fold(issue.nativeType ?? ""));
  if (type === undefined)
    return {
      unanswered: `the tracker's type ${issue.nativeType} names no type of this repository (${workTypes.types.join(", ")})`,
    };
  return {
    type,
    matched: issue.nativeType,
    summary: `the tracker's issue type ${issue.nativeType}`,
  };
}

async function byTitlePrefix(
  issue: IssueFacts,
  workTypes: WorkTypes,
  titleConvention: () => Promise<TitleConvention>,
): Promise<Answer> {
  const prefix = PREFIX.exec(issue.title)?.[1]?.toLowerCase();
  if (prefix === undefined) return null;
  const convention = await titleConvention();
  if (convention.value !== "conventional")
    return {
      unanswered: `the title starts with ${prefix}:, but the title convention is free (${convention.source})`,
    };
  const type = Object.hasOwn(PREFIX_TYPES, prefix)
    ? PREFIX_TYPES[prefix]
    : undefined;
  if (type === undefined)
    return { unanswered: `the title prefix ${prefix}: names no work type` };
  if (!workTypes.types.includes(type))
    return {
      unanswered: `the title prefix ${prefix}: means ${type}, which is not a type of this repository (${workTypes.types.join(", ")})`,
    };
  return {
    type,
    matched: `${prefix}:`,
    summary: `title prefix ${prefix}: (${convention.source})`,
  };
}

/**
 * Derive an issue's type, the evidence for it and its depth. The title
 * convention is read only when the title prefix is the step left to ask,
 * since deriving it may read the repository's history.
 */
export async function deriveType(
  issue: IssueFacts,
  workTypes: WorkTypes,
  titleConvention: () => Promise<TitleConvention>,
): Promise<TypeVerdict> {
  const unanswered: Evidence["unanswered"] = [];
  const steps: Array<[Step, () => Answer | Promise<Answer>]> = [
    ["label", () => byLabel(issue, workTypes)],
    ["tracker_type", () => byTrackerType(issue, workTypes)],
    ["title_prefix", () => byTitlePrefix(issue, workTypes, titleConvention)],
  ];
  for (const [step, run] of steps) {
    const answer = await run();
    if (answer === null) continue;
    if ("unanswered" in answer) {
      unanswered.push({ step, reason: answer.unanswered });
      continue;
    }
    if ("conflict" in answer) {
      // Conflicting type labels are a choice someone must make, not one a
      // weaker signal settles.
      unanswered.push({ step, reason: answer.conflict });
      return unknown(workTypes, unanswered, answer.conflict);
    }
    return {
      type: answer.type,
      evidence: {
        step,
        matched: answer.matched,
        summary: answer.summary,
        unanswered,
      },
      depth: depthOf(workTypes, answer.type),
    };
  }
  return unknown(workTypes, unanswered, null);
}

function unknown(
  workTypes: WorkTypes,
  unanswered: Evidence["unanswered"],
  conflict: string | null,
): TypeVerdict {
  const why =
    conflict ??
    (unanswered.length === 0
      ? "no type label, tracker type or title prefix"
      : unanswered.map((u) => u.reason).join("; "));
  const remedy =
    conflict === null
      ? "a type label clears it"
      : "removing or correcting the conflicting labels clears it";
  return {
    type: UNKNOWN_TYPE,
    evidence: {
      step: "none",
      matched: null,
      summary: `nothing identifies the type: ${why}; the strictest depth applies, and ${remedy}`,
      unanswered,
    },
    depth: depthOf(workTypes, UNKNOWN_TYPE),
  };
}

/** The issue facts from `get_issue.ts`'s JSON, or the reason they cannot be read. */
export function issueFacts(data: unknown): IssueFacts | string {
  if (!isRecord(data)) return "expected a JSON object";
  const { labels, title, nativeType } = data;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || labels.some((l) => typeof l !== "string"))
  )
    return "`labels` must be an array of strings";
  if (title !== undefined && typeof title !== "string")
    return "`title` must be a string";
  if (
    nativeType !== undefined &&
    nativeType !== null &&
    typeof nativeType !== "string"
  )
    return "`nativeType` must be a string or null";
  return {
    labels: (labels ?? []) as string[],
    title: title ?? "",
    nativeType: nativeType ?? null,
  };
}

/**
 * The configuration's work types, and how to read the title convention as
 * `pr-plan.ts` reads it; a refused field's error names its source.
 */
export function typeSettings(config = readConfig()): {
  workTypes: WorkTypes;
  titleConvention: () => Promise<TitleConvention>;
} {
  let workTypes: WorkTypes;
  let policy: ReturnType<typeof parsePrPolicy>;
  try {
    workTypes = parseWorkTypes(config);
    policy = parsePrPolicy(config);
  } catch (e) {
    throw withSource(config, ["issue_tracker", "do_item", "pull_requests"], e);
  }
  const titleConvention = async () => {
    const root = consumerRoot();
    const trunk = policy.titleFormat === null ? await baseBranch(root) : null;
    return detectTitleFormat(
      root,
      policy,
      trunk === null ? null : `origin/${trunk}`,
    );
  };
  return { workTypes, titleConvention };
}

async function readAllStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

/**
 * The issue facts from the one argument a typing script takes, a file or
 * `-` for stdin; or exit 2, the message printed, when they cannot be read.
 */
export async function readIssueArg(
  argv: string[],
  script: string,
): Promise<IssueFacts | 2> {
  const parsed = parseArgs(argv, {
    flags: [],
    values: [],
    defaultPositional: "-",
    usage: `usage: ${script} [issue-json-file|-]`,
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const input = parsed.args.positional;
  let data: unknown;
  try {
    const text =
      input === "-" ? await readAllStdin() : readFileSync(input, "utf8");
    data = JSON.parse(text);
  } catch (e) {
    console.error(
      `Invalid input: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }
  const facts = issueFacts(data);
  if (typeof facts === "string") {
    console.error(`Invalid input: ${facts}`);
    return 2;
  }
  return facts;
}

/**
 * Read the issue argument, derive from it and print the result as JSON: exit
 * 0, 2 for input that cannot be read, 1 for a configuration the loading
 * rules refuse.
 */
export async function printDerived(
  script: string,
  derive: (facts: IssueFacts) => Promise<unknown>,
): Promise<number> {
  const facts = await readIssueArg(process.argv.slice(2), script);
  if (facts === 2) return 2;
  try {
    console.log(JSON.stringify(await derive(facts), null, 2));
    return 0;
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const main = () =>
  printDerived("determine_type.ts", async (facts) => {
    const { workTypes, titleConvention } = typeSettings();
    return deriveType(facts, workTypes, titleConvention);
  });

if (import.meta.main) runEntry(main);
