#!/usr/bin/env bun
// Skip tripwire: a CI job that exists for a test suite fails unless that
// suite executed at least one test.
//
// The problem it catches. A suite that needs a real dependency (a database, a
// queue, a browser, a credential) usually skips itself when the dependency is
// missing, so the rest of the tests still run on a machine without it. In the
// CI job that provisions the dependency, that courtesy becomes a false green:
// the job passes whether the suite ran or not. A misspelt connection variable,
// a test file outside the runner's discovery root, a shard or path filter that
// matches nothing: each passes with zero tests executed, and "0 pass" in the
// log looks like every other green line. The same holds for any job that
// exists for one suite, since most runners report success for a selection
// that matched nothing.
//
// The rule. After the suite runs, read the runner's JUnit report and count the
// test cases that were not skipped. Zero fails. With `--each-suite`, every
// suite directly under the root must have executed at least one case: an
// aggregate count proves only that one of several suites ran. With
// `--suite <name>`, a suite of that name must be in the report and every suite
// bearing it must have executed a case: a file the runner never discovered is
// otherwise invisible. The count comes from the report's test cases, never
// from the runner's human summary line, whose wording changes between
// versions, and never from a suite's own `tests` and `skipped` attributes,
// which some runners leave out.
//
// Input. One or more report files written by the runner (`bun test
// --reporter=junit`, `vitest --reporter=junit`, `pytest --junitxml`,
// `gotestsum --junitfile`, Surefire's `TEST-*.xml` and the rest; the module's
// mappings list them), parsed by the plugin's shared JUnit reader
// (`plugin/shared/junit-report.ts`): a strict XML parser that reads the
// document in order against the XML grammar, then the JUnit tree from its
// elements alone. The root element is <testsuites> or a single <testsuite>;
// a <testsuite> sits under the root or another suite, a <testcase> directly
// under a <testsuite>, a <testsuites> only as the root, and a case is skipped
// when it holds a <skipped> child. The text of comments, CDATA sections and
// captured output is never read as markup, so output that quotes a tag does
// not count.
//
// Fail closed. A report that is missing, empty, not well-formed XML (any
// construct the XML grammar does not allow where it stands, an entity other
// than the five predefined ones, a DOCTYPE with an internal subset), not a
// JUnit report (a suite or a case anywhere else in the tree), or one that
// declares tests but lists no test case exits 2: input the
// check could not read never passes. A runner that finds no test file writes
// no report at all, so a missing report is the first symptom of a suite
// outside the discovery root.
//
// Exit codes: 0 every report, and every suite asked for, executed at least one
// test; 1 at least one did not; 2 a usage error or a report that could not be
// read.
//
// Usage:
//   check-tests-executed.ts [--each-suite] [--suite <name>]... <report.xml>...
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import {
  type JunitReport,
  JunitReportError,
  parseJunitReport,
} from "../../../../plugin/shared/junit-report.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";

const RULE = "tests-executed";
const USAGE =
  "usage: check-tests-executed.ts [--each-suite] [--suite <name>]... <report.xml>...";
const REMEDY =
  "check the dependency the suite needs (its variable, its connection) and that its files lie under the runner's discovery root";

export interface Suite {
  name: string;
  /** 0 for a suite directly under the root, and for a root <testsuite>. */
  depth: number;
  executed: number;
  skipped: number;
}

export interface Report {
  suites: Suite[];
  executed: number;
  skipped: number;
}

type Counted = { executed: number; skipped: number };

/** A refusal the command line prints as one message and exit code 2. */
class TestsExecutedError extends Error {}

/**
 * Refuse a report whose attributes promise test cases it never lists: the
 * count this gate trusts is the listed cases, and a runner that writes only
 * totals is one it does not know.
 */
function checkDeclared(report: JunitReport, label: string): void {
  const listed = report.cases.length;
  const declared = report.rootDeclaredTests;
  if (declared !== undefined && declared > 0 && !listed)
    throw new TestsExecutedError(
      `${label}: declares ${declared} test(s) but lists no test case; this check counts test cases`,
    );
  for (const suite of report.suites)
    if (
      suite.declaredTests !== undefined &&
      suite.declaredTests > 0 &&
      !(suite.executed + suite.skipped)
    )
      throw new TestsExecutedError(
        `${label}: suite ${suite.name} declares ${suite.declaredTests} test(s) but lists no test case; this check counts test cases`,
      );
}

/** The suites and counts of one JUnit report; throws on one it cannot read. */
export function parseReport(text: string, label: string): Report {
  let report: JunitReport;
  try {
    report = parseJunitReport(text);
  } catch (error) {
    if (error instanceof JunitReportError)
      throw new TestsExecutedError(`${label}: ${error.message}`, {
        cause: error,
      });
    throw error;
  }
  checkDeclared(report, label);
  const skipped = report.cases.filter((c) => c.skipped).length;
  return {
    suites: report.suites.map(({ name, depth, executed, skipped }) => ({
      name,
      depth,
      executed,
      skipped,
    })),
    executed: report.cases.length - skipped,
    skipped,
  };
}

interface Options {
  eachSuite: boolean;
  suites: string[];
  reports: string[];
}

/** The parsed command line, with the usage line added to a parsing error. */
function parsedArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        "each-suite": { type: "boolean", default: false },
        suite: { type: "string", multiple: true, default: [] },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw new TestsExecutedError(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
}

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parsedArgs(argv);
  if (!positionals.length)
    throw new TestsExecutedError(`a report file is required\n${USAGE}`);
  if (values.suite.some((name) => !name.trim()))
    throw new TestsExecutedError(`--suite must not be empty\n${USAGE}`);
  return {
    eachSuite: values["each-suite"],
    suites: values.suite,
    reports: positionals,
  };
}

const counts = (c: Counted) =>
  `${c.executed} of ${c.executed + c.skipped} test case(s) executed (${c.skipped} skipped)`;

/** A finding that a report or a suite in it executed no test case. */
const ranNothing = (file: string, problem: string): Finding => ({
  rule: RULE,
  file,
  problem,
  remedy: REMEDY,
});

/** The findings of one report: its total, and each top-level suite when asked. */
export function reportFindingsOf(
  path: string,
  report: Report,
  eachSuite: boolean,
): Finding[] {
  const total =
    report.executed === 0
      ? [
          ranNothing(
            path,
            `${counts(report)}: the suites skipped themselves, or the runner found none`,
          ),
        ]
      : [];
  const suites = eachSuite
    ? report.suites
        .filter((suite) => suite.depth === 0 && suite.executed === 0)
        .map((suite) =>
          ranNothing(path, `suite ${suite.name}: ${counts(suite)}`),
        )
    : [];
  return [...total, ...suites];
}

/** The findings for the suites named with `--suite`, across every report. */
export function namedSuiteFindings(
  reports: { path: string; report: Report }[],
  names: string[],
): Finding[] {
  const suites = reports.flatMap(({ path, report }) =>
    report.suites.map((suite) => ({ path, suite })),
  );
  const where = reports.map((r) => r.path).join(", ");
  return names.flatMap((name) => {
    const bearing = suites.filter(({ suite }) => suite.name === name);
    if (!bearing.length)
      return [
        {
          rule: RULE,
          problem: `suite ${name} is in none of the report(s) ${where}: not discovered, or named differently`,
          remedy:
            "check that its files lie under the runner's discovery root and that the name matches the report's testsuite name exactly",
        },
      ];
    return bearing
      .filter(({ suite }) => suite.executed === 0)
      .map(({ path, suite }) =>
        ranNothing(path, `suite ${name}: ${counts(suite)}`),
      );
  });
}

/** The report's text, or the reason it could not be read. */
function readReport(path: string): { text: string } | { problem: string } {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile())
    return {
      problem: `report ${path} is not a file: the runner did not write it (did it find no test file?), or the path is wrong`,
    };
  return { text: readFileSync(path, "utf8") };
}

export function checkTestsExecuted(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const o = parseOptions(argv);
  const reports: { path: string; report: Report }[] = [];
  for (const path of o.reports) {
    try {
      const read = readReport(path);
      if ("problem" in read) return couldNotCheck(RULE, read.problem, env);
      reports.push({ path, report: parseReport(read.text, path) });
    } catch (error) {
      return couldNotCheck(
        RULE,
        error instanceof Error ? error.message : String(error),
        env,
      );
    }
  }
  const findings = [
    ...reports.flatMap(({ path, report }) =>
      reportFindingsOf(path, report, o.eachSuite),
    ),
    ...namedSuiteFindings(reports, o.suites),
  ];
  if (findings.length) {
    reportFindings(findings, env);
    console.error(
      `${RULE}: ${findings.length} finding(s) in ${reports.length} report(s)`,
    );
    return 1;
  }
  for (const { path, report } of reports) {
    const topLevel = report.suites.filter((s) => s.depth === 0).length;
    console.log(`OK — ${path}: ${counts(report)} in ${topLevel} suite(s)`);
  }
  console.log(
    `${RULE}: every report executed at least one test. Counts the test cases the runner recorded; whether a case asserted anything is the suite's own business.`,
  );
  return 0;
}

if (import.meta.main) cli(() => checkTestsExecuted(process.argv.slice(2)));
