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

async function main(): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: process.argv.slice(2),
      options: {
        skill: { type: "string" },
        pr: { type: "string" },
        why: { type: "string" },
      },
    }).values;
  } catch {
    fail(
      2,
      "usage: confirm-step.ts [--skill <name> --pr <url> --why <one line>]",
    );
  }
  const { skill, pr, why } = values;
  const given = [skill, pr, why].filter((v) => typeof v === "string");
  if (
    (given.length !== 0 && given.length !== 3) ||
    (typeof why === "string" && /[\n\r]/.test(why))
  )
    fail(
      2,
      "confirm-step.ts: give --skill, --pr and --why together, --why on one line",
    );
  let line: string;
  let confirm: boolean;
  try {
    const a = currentAutonomy();
    line = describeAutonomy(a);
    // With no pull request behind the run there is no skip: confirm.
    confirm = a.level === "attended" || given.length !== 3;
  } catch (err) {
    fail(
      1,
      `confirm-step.ts: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  process.stdout.write(`${confirm ? "confirm" : "skip"}: ${line}\n`);
  if (given.length === 3)
    process.stdout.write(
      `${filedByLine(skill as string, pr as string, why as string)}\n`,
    );
  return 0;
}

if (import.meta.main) runMain("confirm-step", main);
