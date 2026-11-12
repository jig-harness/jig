// The nightly workflow's last job: it reads how every other job of the run
// ended (the run's job listing) and what each test invocation found (the
// result files scripts/test.ts wrote, nightly/invocation.ts), writes the
// run's report to the job summary, and reconciles the one tracking issue
// (tracking-issue.ts): a failing run opens it or comments on it, a passing
// run closes it. The report names each job that did not succeed and how it
// ended, the new failures per job, and the recorded failures that passed,
// whose baseline entries should go.
//
// Usage: bun scripts/nightly/report.ts --results <dir>
// Reads GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA and
// GITHUB_SERVER_URL as a workflow sets them, and GH_TOKEN, a token that may
// read the run's jobs and write issues.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, strictOptions } from "../../lib/cli.ts";
import { isRecord } from "../../lib/record.ts";
import {
  ghProcess,
  type GhTransport,
} from "../../modules/M10-environments-deploy/reference/external-preconditions/deadline.ts";
import { NightlyError, type TestId } from "./baseline.ts";
import type { NightlyResult, StaleEntry } from "./classify.ts";
import { githubTracking, reconcileTrackingIssue } from "./tracking-issue.ts";

/** One job of the run, as the run's job listing gives it. */
export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
}

/** The conclusions that do not fail a run. */
const PASSING = new Set(["success", "skipped", "neutral"]);

/** How many tests one list shows before it says how many more there are. */
export const LIST_LIMIT = 40;

/** GitHub refuses an issue body or comment over 65,536 characters. */
const BODY_LIMIT = 60_000;

export const TITLE = "The nightly run fails on main";

/** The run's jobs, read in full; this job, still running, is left out. */
export function listJobs(
  api: GhTransport,
  env: Record<string, string | undefined>,
): Job[] {
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ID: run,
    GITHUB_RUN_ATTEMPT: attempt,
  } = env;
  if (!repo || !run)
    throw new NightlyError("GITHUB_REPOSITORY and GITHUB_RUN_ID are required");
  const result = api(
    [
      `repos/${repo}/actions/runs/${run}/attempts/${attempt || "1"}/jobs?per_page=100`,
    ],
    60_000,
  );
  if (!result.ok)
    throw new NightlyError(
      `the run's jobs could not be listed: ${result.stderr}`,
    );
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    value.total_count !== value.jobs.length ||
    !value.jobs.every(
      (job) =>
        isRecord(job) &&
        typeof job.name === "string" &&
        typeof job.status === "string",
    )
  )
    throw new NightlyError("the run's job listing is malformed or incomplete");
  return (value.jobs as Job[]).filter((job) => job.status === "completed");
}

function isResult(value: unknown): value is NightlyResult {
  return (
    isRecord(value) &&
    typeof value.job === "string" &&
    typeof value.verdict === "string" &&
    ["newFailures", "knownFailures", "stale"].every((key) =>
      Array.isArray(value[key]),
    )
  );
}

/** Every result file in `dir`; one that cannot be read is named in `unreadable`. */
export function readResults(dir: string): {
  results: NightlyResult[];
  unreadable: string[];
} {
  const results: NightlyResult[] = [];
  const unreadable: string[] = [];
  if (!existsSync(dir)) return { results, unreadable };
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isResult(value)) results.push(value);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { results, unreadable };
}

const line = (test: TestId & Partial<StaleEntry>) =>
  `- \`${test.file}\`: ${test.name.replaceAll("`", "'")}${test.issue ? ` (${test.issue})` : ""}`;

function capped(tests: (TestId & Partial<StaleEntry>)[]): string[] {
  const shown = tests.slice(0, LIST_LIMIT).map(line);
  if (tests.length > LIST_LIMIT)
    shown.push(`- and ${tests.length - LIST_LIMIT} more`);
  return shown;
}

function minutes(job: Job): string {
  const start = Date.parse(job.started_at ?? "");
  const end = Date.parse(job.completed_at ?? "");
  return Number.isFinite(start) && Number.isFinite(end)
    ? ` after ${Math.round((end - start) / 60_000)} min`
    : "";
}

/** How a job that did not pass ended, with what its tests found. */
function jobOutcome(job: Job, results: NightlyResult[]): string {
  const conclusion = job.conclusion ?? "unknown";
  if (conclusion === "cancelled")
    return `cancelled${minutes(job)}, by a person or at its time limit`;
  const fresh = results.reduce((sum, r) => sum + r.newFailures.length, 0);
  const unexplained = results.find((r) => r.verdict === "unexplained");
  if (fresh) return `${conclusion}: ${fresh} new test failure(s)`;
  if (unexplained)
    return `${conclusion}: ${unexplained.detail ?? "its tests failed unexplained"}`;
  if (!results.length)
    return `${conclusion}, before its tests reported (see its log)`;
  return `${conclusion}, with no new test failure: another step failed (see its log)`;
}

const cell = (text: string) =>
  text.replaceAll("|", "\\|").replaceAll("\n", " ");

export interface ReportInput {
  runUrl: string;
  sha: string;
  jobs: Job[];
  results: NightlyResult[];
  unreadable: string[];
}

/** Whether the run failed, and its report in Markdown. */
export function buildReport(input: ReportInput): {
  red: boolean;
  text: string;
} {
  const failed = input.jobs.filter((job) => !PASSING.has(job.conclusion ?? ""));
  const red = failed.length > 0 || input.results.some((r) => r.status !== 0);
  const byJob = (name: string) => input.results.filter((r) => r.job === name);
  const sha = input.sha.slice(0, 12);
  const out: string[] = [
    `The [nightly run](${input.runUrl}) on \`main\` at ${sha} ${red ? "failed" : "passed"}.`,
  ];
  if (failed.length)
    out.push(
      "",
      "| Job | How it ended |",
      "| --- | --- |",
      ...failed.map((job) => {
        const name = job.html_url
          ? `[${cell(job.name)}](${job.html_url})`
          : cell(job.name);
        return `| ${name} | ${cell(jobOutcome(job, byJob(job.name)))} |`;
      }),
    );
  const jobsWithNew = [
    ...new Set(
      input.results.filter((r) => r.newFailures.length).map((r) => r.job),
    ),
  ];
  if (jobsWithNew.length) {
    out.push("", "### New failures");
    for (const job of jobsWithNew)
      out.push(
        "",
        `#### ${job}`,
        "",
        ...capped(byJob(job).flatMap((r) => r.newFailures)),
      );
  }
  const stale = input.results.flatMap((r) => r.stale);
  if (stale.length)
    out.push(
      "",
      "### Recorded failures that passed",
      "",
      "Remove these entries from `.config/nightly-baseline.yaml`:",
      "",
      ...capped(stale),
    );
  if (input.unreadable.length)
    out.push(
      "",
      `Result files that could not be read: ${input.unreadable.join(", ")}.`,
    );
  const text = out.join("\n");
  return {
    red,
    text:
      text.length > BODY_LIMIT
        ? `${text.slice(0, BODY_LIMIT)}\n\n(cut short; the run's job summaries hold the rest)`
        : text,
  };
}

async function main(): Promise<number> {
  const { values } = strictOptions(
    { args: process.argv.slice(2), options: { results: { type: "string" } } },
    "usage: bun scripts/nightly/report.ts --results <dir>",
  );
  if (!values.results) throw new NightlyError("--results <dir> is required");
  const env = process.env;
  const token = env.GH_TOKEN;
  if (!token) throw new NightlyError("GH_TOKEN is required");
  const api = ghProcess({ GH_TOKEN: token });
  const { results, unreadable } = readResults(values.results);
  const report = buildReport({
    runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    sha: env.GITHUB_SHA ?? "",
    jobs: listJobs(api, env),
    results,
    unreadable,
  });
  console.log(report.text);
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.text}\n`);
  const outcome = await reconcileTrackingIssue(
    githubTracking(env.GITHUB_REPOSITORY ?? "", "github-actions[bot]", api),
    { title: TITLE, red: report.red, report: report.text },
  );
  console.log(
    `tracking issue: ${outcome.action}${outcome.issue ? ` #${outcome.issue.id}` : ""}`,
  );
  return 0;
}

if (import.meta.main) cli(main);
