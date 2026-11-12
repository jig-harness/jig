// What one nightly test invocation's failures mean against the known-failure
// baseline (baseline.ts): a failing test the baseline records for this
// platform is known; any other is new. The invocation passes when it failed
// only on known tests, and bun's report and its closing summary agree that
// those were all its failures. A failure the report cannot explain (a crash,
// a lock that refused to admit the run, a test file that failed to load,
// which bun counts but leaves out of its JUnit report, an error between
// tests) keeps the invocation's own status: the baseline excuses named tests,
// never an unnamed failure.
//
// A recorded test that passed here is stale: its entry should go. Only what
// ran in this invocation counts, so a shard never calls another shard's
// entries stale. A recorded hook failure, `(unnamed)`, is stale when its file
// ran and no hook in it failed.
import {
  caseResult,
  type CaseResult,
  type JunitReport,
} from "../../plugin/shared/junit-report.ts";
import {
  type BaselineEntry,
  isUnnamed,
  type Platform,
  type TestId,
  testKey,
} from "./baseline.ts";

/** One test case's result, under bun's name for it. */
export interface Outcome extends TestId {
  result: CaseResult;
}

/**
 * Every case in a bun JUnit report, named as bun's console names it. bun
 * writes a suite per test file, named by its path from the working
 * directory, and a nested suite per `describe` block; a case's `classname`
 * is not used, since bun writes its blocks there innermost first.
 */
export function outcomes(report: JunitReport): Outcome[] {
  return report.cases.map((c) => {
    const [file, ...blocks] = c.suites.map((i) => report.suites[i]?.name ?? "");
    return {
      file: (file ?? "").replaceAll("\\", "/"),
      name: [...blocks, c.name].join(" > "),
      result: caseResult(c),
    };
  });
}

/** A terminal colour code, which bun writes only to a terminal. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** bun's closing summary: the failures and the errors outside any test it counted. */
export interface Summary {
  fail: number;
  error: number;
}

/**
 * The counts of bun's closing summary, the block of ` <n> <what>` lines that
 * ends at `Ran <n> tests across <n> files.`, from the end of its output; none
 * when the output holds no such block, which callers read as unexplained.
 */
export function readSummary(output: string): Summary | undefined {
  const lines = output.replace(COLOUR, "").split(/\r?\n/);
  let end = lines.length - 1;
  while (
    end >= 0 &&
    !/^Ran \d+ tests? across \d+ files?\b/.test(lines[end] ?? "")
  )
    end--;
  if (end < 0) return undefined;
  const counts: Record<string, number> = {};
  for (let i = end - 1; i >= 0; i--) {
    const count = /^\s*(\d+) (\S.*?)\s*$/.exec(lines[i] ?? "");
    if (!count) break;
    counts[count[2] ?? ""] = Number(count[1]);
  }
  return { fail: counts.fail ?? 0, error: counts.error ?? counts.errors ?? 0 };
}

/** A recorded test that passed: its entry is ready to go. */
export interface StaleEntry extends TestId {
  issue: string;
}

/** What one invocation found, as the workflow's report job reads it. */
export interface NightlyResult {
  job: string;
  platform: Platform;
  /** The status the invocation exits with. */
  status: number;
  /** passed: no failure; known: recorded failures only; new: at least one unrecorded; unexplained: see `detail`. */
  verdict: "passed" | "known" | "new" | "unexplained";
  detail?: string;
  newFailures: TestId[];
  knownFailures: TestId[];
  stale: StaleEntry[];
}

export interface ClassifyInput {
  job: string;
  platform: Platform;
  /** The suite's own exit status. */
  status: number;
  /** The invocation's report, or why there is none. */
  report: JunitReport | { error: string };
  /** bun's closing summary, when its output held one. */
  summary: Summary | undefined;
  entries: readonly BaselineEntry[];
}

function unique(tests: TestId[]): TestId[] {
  const seen = new Map<string, TestId>();
  for (const { file, name } of tests)
    seen.set(testKey({ file, name }), { file, name });
  return [...seen.values()];
}

function staleEntries(
  recorded: readonly BaselineEntry[],
  ran: readonly Outcome[],
): StaleEntry[] {
  const failed = new Set(
    ran.filter((o) => o.result === "failed").map((o) => testKey(o)),
  );
  const passed = new Set(
    ran.filter((o) => o.result === "passed").map((o) => testKey(o)),
  );
  const filesRun = new Set(
    ran.filter((o) => o.result !== "skipped").map((o) => o.file),
  );
  return recorded
    .filter((entry) => !failed.has(testKey(entry)))
    .filter((entry) =>
      isUnnamed(entry.name)
        ? filesRun.has(entry.file)
        : passed.has(testKey(entry)),
    )
    .map(({ file, name, issue }) => ({ file, name, issue }));
}

/** Why a failed run's failures are not all accounted for, if they are not. */
function unexplained(
  status: number,
  failedCases: number,
  summary: Summary | undefined,
): string | undefined {
  if (!failedCases)
    return `the suite exited ${status} but its report records no failing test`;
  if (!summary)
    return "bun's closing summary is missing from its output, so the report cannot be shown complete";
  if (summary.error)
    return `bun reported ${summary.error} error(s) outside any test, such as a test file that failed to load`;
  if (summary.fail !== failedCases)
    return `bun counted ${summary.fail} failure(s) but its report lists ${failedCases}: a failure outside the report, such as a test file that failed to load`;
  return undefined;
}

/** Classify one invocation's failures against the baseline's entries for its platform. */
export function classify(input: ClassifyInput): NightlyResult {
  const { job, platform, status } = input;
  const recorded = input.entries.filter((e) => e.platform === platform);
  const base = { job, platform, newFailures: [], knownFailures: [], stale: [] };
  if ("error" in input.report)
    return status
      ? {
          ...base,
          status,
          verdict: "unexplained",
          detail: `no readable test report: ${input.report.error}`,
        }
      : { ...base, status, verdict: "passed" };
  const ran = outcomes(input.report);
  const isRecorded = new Set(recorded.map((e) => testKey(e)));
  const failing = ran.filter((o) => o.result === "failed");
  const newFailures = unique(
    failing.filter((o) => !isRecorded.has(testKey(o))),
  );
  const knownFailures = unique(
    failing.filter((o) => isRecorded.has(testKey(o))),
  );
  const stale = staleEntries(recorded, ran);
  const found = { ...base, newFailures, knownFailures, stale };
  if (!status) return { ...found, status, verdict: "passed" };
  const detail = unexplained(status, failing.length, input.summary);
  if (newFailures.length)
    return { ...found, status, verdict: "new", ...(detail ? { detail } : {}) };
  if (detail) return { ...found, status, verdict: "unexplained", detail };
  return { ...found, status: 0, verdict: "known" };
}
