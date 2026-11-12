import { describe, expect, test } from "bun:test";
import { parseJunitReport } from "../../plugin/shared/junit-report.ts";
import type { BaselineEntry } from "./baseline.ts";
import {
  classify,
  outcomes,
  readSummary,
  type ClassifyInput,
} from "./classify.ts";

/** A report as bun 1.4 writes it: a suite per file, nested suites per block, classname innermost first. */
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" failures="3" skipped="1">
  <testsuite name="lib\\a.test.ts" file="lib\\a.test.ts" tests="5" failures="3">
    <testsuite name="outer" file="lib\\a.test.ts" line="2">
      <testsuite name="inner" file="lib\\a.test.ts" line="3">
        <testcase name="recorded &amp; failing" classname="inner &gt; outer" file="lib\\a.test.ts">
          <failure type="AssertionError" message="no">no</failure>
        </testcase>
        <testcase name="recorded, now passing" classname="inner &gt; outer" file="lib\\a.test.ts" />
      </testsuite>
      <testcase name="(unnamed)" classname="outer" file="lib\\a.test.ts">
        <failure type="Error" message="EBUSY">EBUSY</failure>
      </testcase>
    </testsuite>
    <testcase name="unrecorded" classname="" file="lib\\a.test.ts">
      <failure type="Error" message="new">new</failure>
    </testcase>
    <testcase name="skipped" classname="" file="lib\\a.test.ts"><skipped /></testcase>
  </testsuite>
  <testsuite name="lib/b.test.ts" file="lib/b.test.ts" tests="1">
    <testcase name="passes" classname="" file="lib/b.test.ts" />
  </testsuite>
</testsuites>
`;

const entry = (
  file: string,
  name: string,
  platform: BaselineEntry["platform"] = "windows",
): BaselineEntry => ({
  platform,
  file,
  name,
  reason: "a reason",
  issue: "#9",
});

const RECORDED = [
  entry("lib/a.test.ts", "outer > inner > recorded & failing"),
  entry("lib/a.test.ts", "outer > inner > recorded, now passing"),
  entry("lib/a.test.ts", "outer > (unnamed)"),
];

function input(overrides: Partial<ClassifyInput>): ClassifyInput {
  return {
    job: "gates (windows, 1/7)",
    platform: "windows",
    status: 1,
    report: parseJunitReport(REPORT),
    summary: { fail: 3, error: 0 },
    entries: [...RECORDED, entry("lib/a.test.ts", "unrecorded")],
    ...overrides,
  };
}

describe("a nightly invocation's failures against the baseline", () => {
  test("names every case as bun's console does: the file with forward slashes, then its blocks outermost first", () => {
    expect(outcomes(parseJunitReport(REPORT))).toEqual([
      {
        file: "lib/a.test.ts",
        name: "outer > inner > recorded & failing",
        result: "failed",
      },
      {
        file: "lib/a.test.ts",
        name: "outer > inner > recorded, now passing",
        result: "passed",
      },
      { file: "lib/a.test.ts", name: "outer > (unnamed)", result: "failed" },
      { file: "lib/a.test.ts", name: "unrecorded", result: "failed" },
      { file: "lib/a.test.ts", name: "skipped", result: "skipped" },
      { file: "lib/b.test.ts", name: "passes", result: "passed" },
    ]);
  });

  test("reads the counts of bun's closing summary, and nothing without one", () => {
    const output =
      "(fail) x\n 1 fail\n\n 4 pass\n 1 skip\n 2 fail\n 1 error\n 5 expect() calls\nRan 8 tests across 2 files. [3.00ms]\n";
    expect(readSummary(output)).toEqual({ fail: 2, error: 1 });
    expect(
      readSummary(
        "\u001b[32m 3 pass\u001b[0m\r\nRan 3 tests across 1 file. [1ms]\r\n",
      ),
    ).toEqual({ fail: 0, error: 0 });
    expect(readSummary(" 2 fail\n")).toBeUndefined();
  });

  test("a run that failed only on recorded tests passes, and lists them", () => {
    const result = classify(input({}));
    expect(result).toMatchObject({
      status: 0,
      verdict: "known",
      newFailures: [],
    });
    expect(result.knownFailures.map((t) => t.name)).toEqual([
      "outer > inner > recorded & failing",
      "outer > (unnamed)",
      "unrecorded",
    ]);
  });

  test("a failure the baseline does not record keeps the run's status and is named", () => {
    const result = classify(input({ entries: RECORDED }));
    expect(result).toMatchObject({
      status: 1,
      verdict: "new",
      newFailures: [{ file: "lib/a.test.ts", name: "unrecorded" }],
    });
  });

  test("an entry for another platform excuses nothing", () => {
    const macos = [...RECORDED, entry("lib/a.test.ts", "unrecorded", "macos")];
    expect(classify(input({ entries: macos })).verdict).toBe("new");
  });

  test("a recorded test that passed is stale, and a recorded hook is stale once its file ran without one failing", () => {
    expect(classify(input({})).stale).toEqual([
      {
        file: "lib/a.test.ts",
        name: "outer > inner > recorded, now passing",
        issue: "#9",
      },
    ]);
    const hooks = [
      entry("lib/b.test.ts", "(unnamed)"),
      entry("lib/c.test.ts", "(unnamed)"),
    ];
    expect(classify(input({ status: 0, entries: hooks })).stale).toEqual([
      { file: "lib/b.test.ts", name: "(unnamed)", issue: "#9" },
    ]);
  });

  test("an entry for a test this invocation did not run is never stale", () => {
    const elsewhere = [
      entry("lib/c.test.ts", "runs in another shard"),
      entry("lib/a.test.ts", "skipped"),
    ];
    expect(classify(input({ status: 0, entries: elsewhere })).stale).toEqual(
      [],
    );
  });

  test.each([
    [
      "no report",
      { report: { error: "the report is empty" } },
      /no readable test report/,
    ],
    [
      "a report with no failing test",
      {
        report: parseJunitReport(
          '<testsuites><testsuite name="a.test.ts"><testcase name="x"/></testsuite></testsuites>',
        ),
      },
      /records no failing test/,
    ],
    ["no closing summary", { summary: undefined }, /summary is missing/],
    [
      "an error outside any test",
      { summary: { fail: 3, error: 1 } },
      /outside any test/,
    ],
    [
      "more failures counted than reported",
      { summary: { fail: 4, error: 0 } },
      /counted 4 failure\(s\) but its report lists 3/,
    ],
  ])("a failed run with %s keeps its status", (_what, overrides, detail) => {
    const result = classify(input({ status: 1, ...overrides }));
    expect(result.status).toBe(1);
    expect(result.verdict).toBe("unexplained");
    expect(result.detail).toMatch(detail);
  });

  test("an abnormal exit is never excused, even beside a complete report", () => {
    const result = classify(input({ status: 137 }));
    expect(result).toMatchObject({ status: 137, verdict: "unexplained" });
    expect(result.detail).toMatch(/exited 137/);
  });

  test("a hook entry goes stale only when a test ran in its scope and no hook in the file failed", () => {
    const nested = entry("lib/a.test.ts", "never ran > (unnamed)");
    const sibling = entry("lib/a.test.ts", "outer > inner > (unnamed)");
    const stale = (entries: BaselineEntry[]) =>
      classify(input({ status: 0, entries })).stale.map((s) => s.name);
    // The file ran, but nothing ran under "never ran".
    expect(stale([nested])).toEqual([]);
    // A hook elsewhere in the file failed: the report cannot say it was not this one.
    expect(stale([sibling])).toEqual([]);
    expect(stale([entry("lib/b.test.ts", "(unnamed)")])).toEqual(["(unnamed)"]);
  });

  test("a run that passed stays passed, whatever its report", () => {
    expect(
      classify(input({ status: 0, report: { error: "missing" } })),
    ).toMatchObject({ status: 0, verdict: "passed" });
  });
});
