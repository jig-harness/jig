import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  checkLedger,
  ledgerDecisions,
  parseDate,
  registryIds,
} from "./check-cost-ledger.ts";

const gate = join(import.meta.dir, "check-cost-ledger.ts"),
  fix = join(import.meta.dir, "fixtures");
const NOW = "2026-01-01";
const fixture = (name: string) => join(fix, name);
const registry = fixture("registry.yaml");

function run(args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, gate, "--now", NOW, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const cases: [string, number][] = [
  ["pass.yaml", 0],
  ["no-reopen.yaml", 1],
  ["vague-reopen.yaml", 1],
  ["no-measurement.yaml", 1],
  ["overdue-after.yaml", 1],
  ["unknown-metric.yaml", 1],
  ["duplicate-id.yaml", 1],
  ["bad-fields.yaml", 1],
  ["empty.yaml", 2],
  ["empty-list.yaml", 0],
  ["not-yaml.yaml", 2],
  ["wrong-shape.yaml", 2],
  ["no-version.yaml", 2],
];
for (const [file, code] of cases)
  test(`${file} exits ${code} with the registry`, () =>
    expectSpawnExit(run(["--metrics", registry, fixture(file)]), code, file));

test("an empty decisions list passes as nothing to check yet", () => {
  const result = run(["--metrics", registry, fixture("empty-list.yaml")]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK — 0 decision(s)");
  expect(result.stdout).toContain("nothing to check yet");
});

test("a pass names the ledger, the count and the registry", () => {
  const result = run(["--metrics", registry, fixture("pass.yaml")]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK — 2 decision(s)");
  expect(result.stdout).toContain("metrics checked against");
});

test("without a registry the metric is not checked, and the pass says so", () => {
  const result = run([fixture("unknown-metric.yaml")]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("metrics not checked against a registry");
});

test("a finding names the decision, its line, the problem and the fix", () => {
  const result = run(["--metrics", registry, fixture("overdue-after.yaml")]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("overdue-after.yaml:3: [cost-ledger]");
  expect(result.stderr).toContain(
    "tests-on-4-cores's after measurement was due by 2025-12-31",
  );
  expect(result.stderr).toContain("fix: measure it and record the number");
  expect(result.stdout).toContain("cost-ledger: 1 finding(s)");
});

test("a due date on the day the check runs still passes", () =>
  expectSpawnExit(
    run([
      "--now",
      "2025-12-31",
      "--metrics",
      registry,
      fixture("overdue-after.yaml"),
    ]),
    0,
  ));

test("every bad field is its own finding", () => {
  const { stderr } = run(["--metrics", registry, fixture("bad-fields.yaml")]);
  for (const problem of ["has no kebab-case id"])
    expect(stderr).toContain(problem);
  // The id is rejected first, so the rest of the entry is not read: an
  // entry without an identity cannot be named in a finding.
  expect(
    stderr.split("\n").filter((l) => l.includes("[cost-ledger]")),
  ).toHaveLength(1);
});

test("the fields of a named decision are each a finding", () => {
  const findings = checkLedger(
    {
      version: 1,
      decisions: [
        {
          id: "tests-on-4-cores",
          decision: "",
          measured: {
            unit: "",
            before: "nine",
            after: "five",
            windows: ["one"],
          },
          reopen: [
            {
              metric: "ci-runner-minutes",
              comparator: "~",
              threshold: "many",
              window: "soon",
            },
          ],
        },
      ],
    },
    { now: parseDate(NOW, "now"), metricIds: undefined },
  );
  expect(findings.map((f) => f.problem)).toEqual([
    "decision tests-on-4-cores says nothing",
    "decision tests-on-4-cores names no unit",
    "decision tests-on-4-cores has no before measurement",
    "decision tests-on-4-cores has an after that is not a number",
    "decision tests-on-4-cores's windows are not the two windows the numbers come from",
    "decision tests-on-4-cores's reopen condition #1 has no comparator",
    "decision tests-on-4-cores's reopen condition #1 has no numeric threshold",
    "decision tests-on-4-cores's reopen condition #1 has no window",
  ]);
});

for (const args of [
  ["--metrics", fixture("registry-no-metrics.yaml"), fixture("pass.yaml")],
  ["--metrics", fixture("does-not-exist.yaml"), fixture("pass.yaml")],
  ["--metrics", fixture("not-yaml.yaml"), fixture("pass.yaml")],
  ["--now", "2026-02-30", fixture("pass.yaml")],
  ["--now", "yesterday", fixture("pass.yaml")],
  ["--frobnicate", fixture("pass.yaml")],
  [fixture("pass.yaml"), "--metrics"],
  [fixture("pass.yaml"), "--now"],
  ["--metrics", "", fixture("pass.yaml")],
  [fixture("pass.yaml"), fixture("no-reopen.yaml")],
  [fixture("does-not-exist.yaml")],
  [fix],
  [],
])
  test(`fails closed on ${args.map((a) => a.replace(fix, "")).join(" ") || "(no arguments)"}`, () =>
    expectSpawnExit(run(args), 2));

test("a window is a count of days, weeks, months, hours or runs", () => {
  const ledger = (window: unknown) => ({
    version: 1,
    decisions: [
      {
        id: "a",
        decision: "x",
        measured: { unit: "u", before: 1, after: 2 },
        reopen: [{ metric: "m", comparator: ">", threshold: 1, window }],
      },
    ],
  });
  const now = parseDate(NOW, "now");
  for (const ok of ["30d", "4w", "6m", "12h", "100 runs"])
    expect(checkLedger(ledger(ok), { now, metricIds: undefined })).toEqual([]);
  for (const bad of ["0d", "30", "30 days", "d", 30, null, "30d "])
    expect(
      checkLedger(ledger(bad), { now, metricIds: undefined }),
    ).toHaveLength(1);
});

test("an unknown metric is a finding only against a registry", () => {
  const ledger = {
    version: 1,
    decisions: [
      {
        id: "a",
        decision: "x",
        measured: { unit: "u", before: 1, after: 2 },
        reopen: [
          { metric: "ci-money", comparator: ">", threshold: 1, window: "30d" },
        ],
      },
    ],
  };
  const now = parseDate(NOW, "now");
  expect(checkLedger(ledger, { now, metricIds: undefined })).toEqual([]);
  expect(
    checkLedger(ledger, { now, metricIds: new Set(["ci-runner-minutes"]) }),
  ).toHaveLength(1);
  expect(
    checkLedger(ledger, { now, metricIds: new Set(["ci-money"]) }),
  ).toEqual([]);
});

test("ledgerDecisions accepts a ledger and rejects the rest", () => {
  expect(ledgerDecisions({ version: 1, decisions: [{}] })).toHaveLength(1);
  expect(ledgerDecisions({ version: 1, decisions: [] })).toEqual([]);
  expect(() => ledgerDecisions({ version: 2, decisions: [{}] })).toThrow(
    "version",
  );
  expect(() => ledgerDecisions({ decisions: [{}] })).toThrow("version");
  expect(() => ledgerDecisions({ version: 1 })).toThrow("decisions");
  expect(() => ledgerDecisions([])).toThrow("mapping");
  expect(() => ledgerDecisions(null)).toThrow("mapping");
});

test("registryIds reads the ids and rejects a document without metrics", () => {
  expect(
    registryIds({ metrics: [{ id: "a" }, { id: "b" }, { name: "c" }] }),
  ).toEqual(new Set(["a", "b"]));
  expect(() => registryIds({ metrics: {} })).toThrow("metrics");
  expect(() => registryIds(null)).toThrow("metrics");
});

test("an impossible calendar date fails instead of rolling over", () => {
  for (const bad of [
    "2026-02-30",
    "2026-13-01",
    "2026-01-00",
    "2026-1-1",
    "2026-01-01T00:00:00Z",
    20260101,
  ])
    expect(() => parseDate(bad, "date")).toThrow("calendar date");
  expect(parseDate("2028-02-29", "date")).toBe(Date.UTC(2028, 1, 29));
});

test("a pending after is an explicit null; a missing after is a finding", () => {
  const ledger = (measured: Record<string, unknown>) =>
    checkLedger(
      {
        version: 1,
        decisions: [
          {
            id: "d",
            decision: "run the tests on four cores",
            measured: { unit: "minutes", before: 9, ...measured },
            reopen: [
              {
                metric: "ci-runner-minutes",
                comparator: ">",
                threshold: 10,
                window: "30d",
              },
            ],
          },
        ],
      },
      { now: parseDate(NOW, "now"), metricIds: undefined },
    ).map((f) => f.problem);
  expect(ledger({ after: null, measure_by: "2999-01-01" })).toEqual([]);
  expect(ledger({ measure_by: "2999-01-01" })).toEqual([
    "decision d has no after field",
  ]);
});
