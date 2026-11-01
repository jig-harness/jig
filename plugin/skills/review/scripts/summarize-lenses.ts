#!/usr/bin/env bun
/**
 * Turn the lens step's results into the review summary's lines.
 *
 *   bun summarize-lenses.ts <input.json> [--json]
 *
 * The input is one JSON object:
 *
 *   {
 *     "selection": <select-lenses --json output, or the path of the file
 *                   that holds it (the lens step's lenses.json)>,
 *     "skipped_by": "--quick",   // instead of selection, when no lens ran:
 *                                // --quick, --tier=1, --tier=2 or --skip-t3
 *     "runner": "subagents" | "command" | "same-session",
 *     "findings": [<finding>, ...],                  // what the lenses returned
 *     "semantic": "APPROVED" | "REJECTED" | "NONE",  // Tier 3's other reviews
 *     "tier1": "PASSED" | "BLOCKED",                 // optional: with tier2, adds the verdict
 *     "tier2": "PASSED" | "WARNINGS" | "BLOCKED"
 *   }
 *
 * Prints Tier 3's line, the `Lenses:` line, the verdict when both earlier
 * tiers are given, and each finding with its effective severity; `--json`
 * prints the same as one object. Exit 0; 2 when the input is malformed or a
 * finding names a lens that did not run.
 */
import { readFileSync } from "node:fs";
import { fail, runMain } from "../../../shared/cli.ts";
import { isRecord } from "../../../shared/guards.ts";
import type { LensResult } from "./lens-selection.ts";
import {
  type LensFinding,
  type LensOutcome,
  lensesLine,
  rate,
  type RatedFinding,
  type Semantic,
  SEVERITIES,
  type Severity,
  type Tier1,
  type Tier2,
  tier3,
  verdict,
} from "./lens-verdict.ts";

const USAGE = "usage: summarize-lenses.ts <input.json> [--json]";
const TEXT_FIELDS = [
  "lens",
  "file",
  "confidence",
  "scenario",
  "impact",
  "fix",
  "evidence",
] as const;

class InputError extends Error {
  override name = "InputError";
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (!allowed.includes(value as T))
    throw new InputError(`${what} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function finding(value: unknown, i: number): LensFinding {
  const what = `findings[${i}]`;
  if (!isRecord(value)) throw new InputError(`${what} must be an object`);
  for (const key of TEXT_FIELDS)
    if (typeof value[key] !== "string")
      throw new InputError(`${what}.${key} must be text`);
  const line = value.line;
  if (
    line !== null &&
    !(typeof line === "number" && Number.isSafeInteger(line) && line > 0)
  )
    throw new InputError(`${what}.line must be a line number or null`);
  return {
    ...(value as Record<(typeof TEXT_FIELDS)[number], string>),
    line,
    severity: oneOf<Severity>(value.severity, SEVERITIES, `${what}.severity`),
  };
}

function parsed(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(
      `${what} is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The selection, given inline or as the path of the file that holds it. */
function selection(entry: unknown): LensResult[] {
  const value =
    typeof entry === "string"
      ? parsed(readFileSync(entry, "utf8"), entry)
      : entry;
  if (!isRecord(value) || !Array.isArray(value.lenses))
    throw new InputError("selection must be select-lenses's --json output");
  for (const lens of value.lenses) {
    if (
      !isRecord(lens) ||
      typeof lens.runs !== "boolean" ||
      typeof lens.reason !== "string"
    )
      throw new InputError(
        "selection.lenses holds an entry without runs and reason",
      );
    if (
      lens.runs &&
      !(
        typeof lens.id === "string" &&
        lens.id !== "" &&
        typeof lens.version === "number" &&
        Number.isSafeInteger(lens.version) &&
        lens.version > 0
      )
    )
      throw new InputError(
        "selection.lenses holds a running entry without a valid id and version",
      );
  }
  return value.lenses as LensResult[];
}

export interface Input {
  outcome: LensOutcome;
  semantic: Semantic;
  tiers: [Tier1, Tier2] | null;
}

function outcomeOf(input: Record<string, unknown>): LensOutcome {
  const skippedBy =
    input.skipped_by === undefined
      ? null
      : oneOf(
          input.skipped_by,
          ["--quick", "--tier=1", "--tier=2", "--skip-t3"],
          "skipped_by",
        );
  if ((skippedBy === null) === (input.selection === undefined))
    throw new InputError("give either selection or skipped_by");
  const lenses = skippedBy === null ? selection(input.selection) : [];
  const supplied: unknown = input.findings ?? [];
  if (!Array.isArray(supplied)) throw new InputError("findings must be a list");
  const findings = supplied.map((entry: unknown, i: number) =>
    finding(entry, i),
  );
  const ran = new Set(
    lenses.filter((l) => l.runs).map((l) => `${l.id}@${l.version}`),
  );
  for (const f of findings)
    if (!ran.has(f.lens))
      throw new InputError(`a finding names ${f.lens}, which did not run`);
  const runner =
    input.runner === undefined
      ? "subagents"
      : oneOf(input.runner, ["subagents", "command", "same-session"], "runner");
  return {
    skippedBy,
    lenses,
    sharedContext: runner === "same-session",
    findings: findings.map((f) => rate(f)),
  };
}

export function decode(text: string): Input {
  const value = parsed(text, "the input");
  if (!isRecord(value)) throw new InputError("the input must be an object");
  const tier1 =
    value.tier1 === undefined
      ? undefined
      : oneOf<Tier1>(value.tier1, ["PASSED", "BLOCKED"], "tier1");
  const tier2 =
    value.tier2 === undefined
      ? undefined
      : oneOf<Tier2>(value.tier2, ["PASSED", "WARNINGS", "BLOCKED"], "tier2");
  return {
    outcome: outcomeOf(value),
    semantic: oneOf<Semantic>(
      value.semantic,
      ["APPROVED", "REJECTED", "NONE"],
      "semantic",
    ),
    tiers: tier1 && tier2 ? [tier1, tier2] : null,
  };
}

function findingLine(f: RatedFinding): string {
  const where =
    f.line === null ? `${f.file} (non-inline)` : `${f.file}:${f.line}`;
  const notes = [
    f.unverified
      ? `unverified: its evidence field is empty; reported ${f.severity}`
      : "",
    f.effective !== f.severity && !f.unverified
      ? `reported ${f.severity}; capped, the lens is not promoted`
      : "",
  ].filter(Boolean);
  return `- ${f.effective}  ${f.lens}  ${where}${notes.length ? `  (${notes.join("; ")})` : ""}\n  ${f.scenario}\n  Impact: ${f.impact}\n  Confidence: ${f.confidence}\n  Evidence: ${f.evidence || "(empty)"}\n  Fix: ${f.fix}\n`;
}

export interface Summary {
  tier3: string;
  lenses: string;
  verdict: string | null;
  findings: RatedFinding[];
}

export function summarize(input: Input): Summary {
  const state = tier3(input.semantic, input.outcome);
  return {
    tier3: state,
    lenses: lensesLine(input.outcome),
    verdict: input.tiers ? verdict(...input.tiers, state) : null,
    findings: input.outcome.findings,
  };
}

/** The summary's lines, then each lens finding with its effective severity. */
export function renderText(summary: Summary): string {
  const verdictLine = summary.verdict ? `VERDICT: ${summary.verdict}\n` : "";
  const findings = summary.findings.length
    ? `\nLens findings:\n${summary.findings.map((f) => findingLine(f)).join("")}`
    : "";
  return `Tier 3 (Semantic):      ${summary.tier3}\n${summary.lenses}\n${verdictLine}${findings}`;
}

function readInput(path: string): Input {
  try {
    return decode(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof InputError)
      fail(2, `summarize-lenses: ${error.message}`);
    throw error;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const path = args.find((arg) => !arg.startsWith("--"));
  const json = args.includes("--json");
  if (path === undefined || args.length !== (json ? 2 : 1)) fail(2, USAGE);
  const summary = summarize(readInput(path));
  process.stdout.write(
    json ? `${JSON.stringify(summary, null, 2)}\n` : renderText(summary),
  );
  return 0;
}

if (import.meta.main) runMain("summarize-lenses", main);
