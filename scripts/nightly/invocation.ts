// The nightly run's part in `bun run test` (scripts/test.ts). The nightly
// workflow names the known-failure baseline in JIG_NIGHTLY_BASELINE, the job
// in JIG_NIGHTLY_JOB and a directory for results in JIG_NIGHTLY_RESULTS; with
// the baseline named, an invocation captures the end of bun's output, then
// classifies its failures (classify.ts), prints what it found, writes it as
// JSON for the workflow's report job and as Markdown to the job's step
// summary, and exits 0 when it failed on recorded tests alone. Without it,
// `bun run test` behaves as it always has. The variables never reach the
// tests themselves, so a test that runs `bun run test` on a fixture is never
// classified.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { formatFinding, githubAnnotation } from "../../lib/findings.ts";
import { swallow } from "../../plugin/shared/errors.ts";
import {
  parseJunitReport,
  type JunitReport,
} from "../../plugin/shared/junit-report.ts";
import { platformName, readBaseline, type TestId } from "./baseline.ts";
import { classify, type NightlyResult, readSummary } from "./classify.ts";

export const BASELINE_ENV = "JIG_NIGHTLY_BASELINE";
export const RESULTS_ENV = "JIG_NIGHTLY_RESULTS";
export const JOB_ENV = "JIG_NIGHTLY_JOB";
const NIGHTLY_ENV = [BASELINE_ENV, RESULTS_ENV, JOB_ENV];

/** The script that keeps the end of bun's output for its summary. */
export const CAPTURE_SCRIPT = join(import.meta.dir, "capture-output.ts");

type Env = Record<string, string | undefined>;

/** The environment without the nightly's variables, for the tests. */
export function withoutNightlyEnv<T extends Env>(env: T): T {
  const clean = { ...env };
  for (const name of NIGHTLY_ENV) delete clean[name];
  return clean;
}

/** The command run through the capture script, which keeps its output's end in `tail`. */
export function capturedCommand(command: string[], tail: string): string[] {
  return [process.execPath, CAPTURE_SCRIPT, tail, ...command];
}

const at = (test: TestId) => `${test.file}: ${test.name}`;

/** Workflow-command message escaping, as lib/findings.ts escapes an error's. */
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** What the invocation found, for its log: new failures as findings, stale entries as warnings. */
export function printResult(
  result: NightlyResult,
  env: Env = process.env,
): void {
  const findings = result.newFailures.map((test) => ({
    rule: "nightly-new-failure",
    file: test.file,
    problem: `${test.name} failed on ${result.platform}, and the nightly baseline does not record it`,
    remedy:
      "fix it, or record it with a reason and its issue in .config/nightly-baseline.yaml",
  }));
  for (const finding of findings) console.error(formatFinding(finding));
  const actions = env.GITHUB_ACTIONS === "true";
  if (actions)
    for (const finding of findings) console.log(githubAnnotation(finding));
  for (const test of result.stale) {
    const text = `${at(test)} passed on ${result.platform}; remove its entry from .config/nightly-baseline.yaml (${test.issue})`;
    console.error(`nightly baseline: stale: ${text}`);
    if (actions)
      console.log(
        `::warning title=nightly baseline entry passes::${escapeData(text)}`,
      );
  }
  console.error(
    `nightly baseline: ${result.verdict}: ${result.newFailures.length} new, ${result.knownFailures.length} recorded failure(s), ${result.stale.length} stale entr${result.stale.length === 1 ? "y" : "ies"}${result.detail ? `; ${result.detail}` : ""}`,
  );
}

const list = (tests: TestId[]) =>
  tests.map((test) => `- \`${test.file}\`: ${test.name.replaceAll("`", "'")}`);

/** The invocation's step summary, in Markdown. */
export function summaryMarkdown(result: NightlyResult): string {
  return [
    `### Tests on ${result.platform}: ${result.verdict}`,
    "",
    ...(result.detail ? [result.detail, ""] : []),
    `${result.knownFailures.length} failure(s) the nightly baseline records.`,
    ...(result.newFailures.length
      ? ["", "New failures:", "", ...list(result.newFailures)]
      : []),
    ...(result.stale.length
      ? [
          "",
          "Recorded failures that passed (remove their entries):",
          "",
          ...list(result.stale),
        ]
      : []),
    "",
  ].join("\n");
}

function readReport(path: string): JunitReport | { error: string } {
  try {
    return parseJunitReport(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A file's text, or nothing when it was never written, which the caller reads as missing. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    swallow(error, `${path} is unreadable; read as empty`);
    return "";
  }
}

/**
 * Classify an invocation that ran under the nightly's variables, record what
 * it found, and return the status it exits with. A baseline that cannot be
 * read excuses nothing: the suite's own status stands.
 */
export function settle(
  status: number,
  files: { report: string; tail: string },
  env: Env = process.env,
  platform: string = process.platform,
): number {
  const path = env[BASELINE_ENV] ?? "";
  const { entries, problems } = readBaseline(readText(path) || "{}");
  for (const { where, problem } of problems)
    console.error(`nightly baseline ${path}: ${where}: ${problem}`);
  const result = classify({
    job: env[JOB_ENV] || "(unnamed job)",
    platform: platformName(platform),
    status,
    report: readReport(files.report),
    summary: readSummary(readText(files.tail)),
    entries: problems.length ? [] : entries,
  });
  printResult(result, env);
  const dir = env[RESULTS_ENV];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    // Every job's files land in one folder for the report: names never collide.
    const name = `result-${crypto.randomUUID()}.json`;
    writeFileSync(join(dir, name), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(result));
  return result.status;
}
