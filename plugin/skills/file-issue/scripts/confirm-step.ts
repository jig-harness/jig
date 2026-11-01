#!/usr/bin/env bun
/**
 * Whether this run of `file-issue` asks a person before it writes, from the
 * autonomy level in force (`plugin/shared/autonomy.ts`), and the line an
 * issue filed without asking carries.
 *
 * Under `attended`, the default and every interactive session unless its
 * person chose otherwise, the skill shows the plan and writes only after the
 * person accepts it. Under `unattended`, which a driver pass reads when the
 * repository allows it, nobody is there to answer: the skill writes without
 * the confirmation, and the issue's body says which skill filed it, from
 * which pull request, and why, so a person who reads it can close it.
 *
 * Usage:
 *   confirm-step.ts [--skill <name> --pr <url> --why <one line>]
 *
 * Prints `skip: <level line>` only under `unattended` with all three options
 * given (a run with no pull request behind it always confirms), else
 * `confirm: <level line>`; then, when the
 * three options are given, the filed-by line for the body.
 *
 * Exit codes: 0 printed, 1 the autonomy configuration is invalid, 2 usage.
 */
import { parseArgs } from "node:util";
import { describeAutonomy, currentAutonomy } from "../../../shared/autonomy.ts";
import { fail, runMain } from "../../../shared/cli.ts";

/** The line an issue body carries when a skill filed it without asking. */
export function filedByLine(skill: string, pr: string, why: string): string {
  return `Filed by \`/jig:${skill}\` from ${pr}, without a person's confirmation: ${why}`;
}

const isSkillName = (v: unknown): boolean =>
  typeof v === "string" && /^[a-z][a-z0-9-]*$/.test(v);

/** An \`http(s)\` url whose path ends at a pull or merge request's number. */
function isPullRequestUrl(v: unknown): boolean {
  if (typeof v !== "string" || !URL.canParse(v)) return false;
  const url = new URL(v);
  return (
    /^https?:$/.test(url.protocol) &&
    /\/(pull|pulls|merge_requests)\/\d+\/?$/.test(url.pathname)
  );
}

const isOneLine = (v: unknown): boolean =>
  typeof v === "string" && v.trim() !== "" && !/[\n\r]/.test(v);

/**
 * What keeps the three options from naming a run's provenance, or \`null\`: a
 * skill name, a pull request's url, and a reason on one line. Values that
 * name nothing (empty, blank, not a pull request) would let a run with no
 * pull request behind it skip the confirmation.
 */
export function provenanceFault(
  skill: unknown,
  pr: unknown,
  why: unknown,
): string | null {
  if (!isSkillName(skill))
    return "--skill must name a skill (lower-case words joined by hyphens)";
  if (!isPullRequestUrl(pr)) return "--pr must be a pull request's url";
  if (!isOneLine(why)) return "--why must be one nonempty line";
  return null;
}

const USAGE =
  "usage: confirm-step.ts [--skill <name> --pr <url> --why <one line>]";

/** The three options as given; usage fails on any other argument. */
function parsed(args: string[]): Record<string, string | boolean | undefined> {
  try {
    return parseArgs({
      args,
      options: {
        skill: { type: "string" },
        pr: { type: "string" },
        why: { type: "string" },
      },
    }).values;
  } catch {
    fail(2, USAGE);
  }
}

/**
 * The provenance the options name, or `null` when none is given; usage
 * fails on part of it, or on a part that names nothing.
 */
function provenance(
  args: string[],
): { skill: string; pr: string; why: string } | null {
  const { skill, pr, why } = parsed(args);
  if ([skill, pr, why].every((v) => v === undefined)) return null;
  const fault = provenanceFault(skill, pr, why);
  if (fault !== null)
    fail(2, `confirm-step.ts: give --skill, --pr and --why together: ${fault}`);
  return { skill: skill as string, pr: pr as string, why: why as string };
}

async function main(): Promise<number> {
  const given = provenance(process.argv.slice(2));
  let line: string;
  let confirm: boolean;
  try {
    const a = currentAutonomy();
    line = describeAutonomy(a);
    // With no pull request behind the run there is no skip: confirm.
    confirm = a.level === "attended" || given === null;
  } catch (err) {
    fail(
      1,
      `confirm-step.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.stdout.write(`${confirm ? "confirm" : "skip"}: ${line}\n`);
  if (given !== null)
    process.stdout.write(`${filedByLine(given.skill, given.pr, given.why)}\n`);
  return 0;
}

if (import.meta.main) runMain("confirm-step", main);
