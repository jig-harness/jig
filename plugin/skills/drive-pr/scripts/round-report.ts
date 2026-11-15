#!/usr/bin/env bun
/**
 * End a drive pass's round with its round report.
 *
 * Usage: bun round-report.ts <file|->
 *
 * The file (or standard input, for `-`) holds the round's report as JSON,
 * with the fields of a closing report (`closing-report/v1`,
 * `shared/closing-report.ts`): what the round concluded, the question for a
 * person and its framed decision where one must decide, the next step it
 * suggests, the cause when the round fell short, and references as evidence.
 * It is redacted and checked as `jig dispatch report` checks a report, then
 * kept in the drive's state directory, stamped with the pass's launch
 * (`JIG_LAUNCH`) and round (`DRIVE_PR_ROUND`), which the driver hands every
 * pass, and replacing the report before it (`lib/state/round-report.ts`).
 * When the drive stops, `drive.ts` reads the last one of its own launch into
 * its closing report. It never goes into the handoff narrative.
 *
 * It prints one JSON line naming the pull request, the launch and the round.
 *
 * Exit codes: 0 kept; 2 usage, not run by a drive's pass (no
 * `DRIVE_PR_TARGET`, `DRIVE_PR_ROUND` or `JIG_LAUNCH`), a report that cannot
 * be read, or one the check refuses, with every problem named so the pass
 * can fix it and run the command again.
 */
import { readFileSync } from "node:fs";
import {
  type ClosingReport,
  closingReportOf,
} from "../../../shared/closing-report.ts";
import { launchOf } from "../../../shared/launched-session.ts";
import { currentIso } from "../../../shared/time.ts";
import { fail, isDigits, readStdinAll, runMain } from "./lib/cli.ts";
import {
  ROUND_REPORT_SCHEMA,
  writeRoundReport,
} from "./lib/state/round-report.ts";
import { resolveStateDir } from "./lib/state/store.ts";

const NAME = "round-report.ts";
const USAGE = `usage: ${NAME} <file|->`;

interface PassStamp {
  pr: number;
  launch: string;
  round: number;
}

/** The pass's pull request, launch and round, from what its driver hands it; a usage error outside a drive's pass. */
function passStamp(env: Record<string, string | undefined>): PassStamp {
  const pr = env.DRIVE_PR_TARGET ?? "";
  const round = env.DRIVE_PR_ROUND ?? "";
  const launch = launchOf(env) ?? "";
  if ([pr, round].every(isDigits) && launch !== "")
    return { pr: Number(pr), launch, round: Number(round) };
  return fail(
    2,
    `${NAME}: only a drive's pass writes a round report: DRIVE_PR_TARGET, DRIVE_PR_ROUND and JIG_LAUNCH, which its driver sets, are not all here`,
  );
}

/** The file argument; a usage error for any other command line. */
function fileArg(argv: string[]): string {
  const [file, ...extra] = argv;
  return file !== undefined && extra.length === 0 ? file : fail(2, USAGE);
}

/** The report's text, from the file or from standard input. */
async function readReport(file: string): Promise<string> {
  const from = file === "-" ? "standard input" : file;
  try {
    return file === "-" ? await readStdinAll() : readFileSync(file, "utf8");
  } catch (error) {
    return fail(
      2,
      `${NAME}: the report could not be read from ${from}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The report `text` holds, redacted and checked; refused with every problem named. */
function checkedReport(text: string): ClosingReport {
  const report = closingReportOf(text);
  return report.ok
    ? report.value
    : fail(2, `${NAME}: the report was not kept: ${report.failure.reason}`);
}

async function main(argv: string[]): Promise<number> {
  const file = fileArg(argv);
  const stamp = passStamp(process.env);
  const report = checkedReport(await readReport(file));
  const stateDir = process.env.DRIVE_PR_STATE_DIR || (await resolveStateDir());
  writeRoundReport(stateDir, {
    schema: ROUND_REPORT_SCHEMA,
    ...stamp,
    at: currentIso(),
    report,
  });
  console.log(JSON.stringify({ ...stamp, report: "kept" }));
  return 0;
}

if (import.meta.main) runMain(NAME, () => main(process.argv.slice(2)));
