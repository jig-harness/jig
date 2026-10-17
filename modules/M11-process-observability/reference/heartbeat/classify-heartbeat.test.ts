import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Job,
  type Run,
  classify,
  heartbeat,
  parseDuration,
  parseHistory,
  parseOptions,
  parseRegistry,
  parseTime,
} from "./classify-heartbeat.ts";

const script = join(import.meta.dir, "classify-heartbeat.ts");
const fix = (name: string) => join(import.meta.dir, "fixtures", name);
const NOW_TEXT = "2026-03-10T12:00:00Z";
const NOW = Date.parse(NOW_TEXT);
const HOUR = 3_600_000;

function run(args: string[], input?: string) {
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}
const classifyFixture = (history: string, extra: string[] = []) =>
  run([
    "--registry",
    fix("registry.yaml"),
    "--history",
    fix(history),
    "--now",
    NOW_TEXT,
    ...extra,
  ]);

describe("the command", () => {
  const verdicts: [string, number][] = [
    ["good/healthy.json", 0],
    ["good/degraded.json", 0],
    ["good/running.json", 0],
    ["good/undeclared-job.json", 0],
    ["bad/stale-last-green.json", 1],
    ["bad/red.json", 1],
    ["bad/never-ran.json", 1],
    ["bad/only-cancelled.json", 1],
    ["bad/all-cancelled.json", 1],
    ["bad/empty-history.json", 1],
    ["bad/empty-file.json", 2],
    ["bad/malformed.json", 2],
    ["bad/not-array.json", 2],
    ["bad/unknown-status.json", 2],
    ["bad/no-finished-at.json", 2],
    ["bad/future-result.json", 2],
    ["bad/future-finish.json", 2],
    ["bad/zoneless-time.json", 2],
    ["bad/finished-before-started.json", 2],
    ["bad/duplicate-run.json", 2],
    ["bad/no-run-id.json", 2],
    ["bad/impossible-date.json", 2],
    ["bad/cancelled-future-finish.json", 2],
    ["bad/skipped-finished-before-started.json", 2],
    ["bad/does-not-exist.json", 2],
  ];
  for (const [history, code] of verdicts)
    test(`${history} exits ${code}`, () =>
      expectSpawnExit(classifyFixture(history), code));

  test("a job whose last run was green but is overdue is stale, not green", () => {
    const r = classifyFixture("bad/stale-last-green.json");
    expect(r.stdout).toContain("STALE    nightly — last result 3d ago");
    expect(r.stdout).toContain("GREEN    weekly");
    expect(r.stdout).toContain(
      "HEARTBEAT red — 1 of 3 job(s) red or stale: nightly",
    );
  });

  test("failures in a row reach red only at the job's own threshold", () => {
    expect(classifyFixture("bad/red.json").stdout).toContain(
      "RED      nightly — 2 failure(s) in a row (red after 2)",
    );
    expect(classifyFixture("good/degraded.json").stdout).toContain(
      "DEGRADED nightly — 1 failure(s) in a row (red after 2)",
    );
  });

  test("a job absent from the history never produced a result", () => {
    expect(classifyFixture("bad/never-ran.json").stdout).toContain(
      "STALE    weekly — never produced a result: no run in the history",
    );
  });

  test("cancelled and skipped runs are not results", () => {
    expect(classifyFixture("bad/only-cancelled.json").stdout).toContain(
      "STALE    hourly-smoke — last result 3h ago",
    );
  });

  test("a job whose every run was cancelled or skipped is stale", () => {
    const history = classifyFixture("bad/all-cancelled.json");
    expect(history.stdout).toContain(
      "STALE    hourly-smoke — never produced a result",
    );
  });

  test("the job that runs the classifier is declared but not classified", () => {
    const r = run([
      "--registry",
      fix("registry-watcher.yaml"),
      "--history",
      fix("good/watcher-failed.json"),
      "--now",
      NOW_TEXT,
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      "(not classified, watched by the external monitor: heartbeat)",
    );
    expect(r.stdout).not.toContain("RED");
    expect(r.stdout).toContain("1 job(s)");
  });

  test("a run in progress is reported as running", () => {
    expect(classifyFixture("good/running.json").stdout).toContain(
      "RUNNING  hourly-smoke",
    );
  });

  test("a job the registry does not declare is listed and ignored", () => {
    const r = classifyFixture("good/undeclared-job.json");
    expect(r.stdout).toContain("(ignored, not declared: experiment)");
    expect(r.stdout).toContain("HEARTBEAT ok");
  });

  test("an empty history makes every declared job stale, as a failed collection should", () => {
    const r = classifyFixture("bad/empty-history.json");
    expect(r.stdout).toContain("HEARTBEAT red — 3 of 3 job(s) red or stale");
  });

  test("--json carries the verdict, each job's class and the clock", () => {
    const report = JSON.parse(
      classifyFixture("bad/red.json", ["--json"]).stdout,
    );
    expect(report.verdict).toBe("red");
    expect(report.now).toBe("2026-03-10T12:00:00.000Z");
    expect(
      Object.fromEntries(
        report.jobs.map((j: { id: string; class: string }) => [j.id, j.class]),
      ),
    ).toEqual({ nightly: "red", weekly: "green", "hourly-smoke": "green" });
  });

  test("the history can be read from standard input", () => {
    const text = readFileSync(fix("good/healthy.json"), "utf8");
    expectSpawnExit(
      run(
        [
          "--registry",
          fix("registry.yaml"),
          "--history",
          "-",
          "--now",
          NOW_TEXT,
        ],
        text,
      ),
      0,
    );
  });

  const registries = [
    "registry-empty",
    "registry-no-jobs-key",
    "registry-unknown-field",
    "registry-duplicate",
    "registry-no-cadence",
    "registry-bad-cadence",
    "registry-bad-red-after",
    "registry-not-yaml",
    "registry-only-watcher",
    "registry-bad-watcher",
  ];
  for (const name of registries)
    test(`${name}.yaml is an input error, not a pass`, () => {
      const r = run([
        "--registry",
        fix(`bad/${name}.yaml`),
        "--history",
        fix("good/healthy.json"),
        "--now",
        NOW_TEXT,
      ]);
      expectSpawnExit(r, 2);
      expect(r.stdout).toBe("");
    });

  test("usage errors exit 2", () => {
    expectSpawnExit(run([]), 2);
    expectSpawnExit(run(["--registry", fix("registry.yaml")]), 2);
    expectSpawnExit(run(["--history", fix("good/healthy.json")]), 2);
    expectSpawnExit(
      run([
        "--registry",
        fix("registry.yaml"),
        "--history",
        fix("good/healthy.json"),
        "--now",
        "yesterday",
      ]),
      2,
    );
    expectSpawnExit(
      run([
        "--registry",
        fix("registry.yaml"),
        "--history",
        fix("good/healthy.json"),
        "--bogus",
      ]),
      2,
    );
  });
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j",
  cadenceMs: 24 * HOUR,
  graceMs: 2 * HOUR,
  maxRunMs: 6 * HOUR,
  redAfter: 2,
  watcher: false,
  ...over,
});
let runId = 0;
const done = (status: "success" | "failure", ago: number): Run => ({
  job: "j",
  id: String(++runId),
  status,
  startedMs: NOW - ago - 60_000,
  finishedMs: NOW - ago,
});
const going = (ago: number): Run => ({
  job: "j",
  id: String(++runId),
  status: "running",
  startedMs: NOW - ago,
  finishedMs: undefined,
});

describe("classify", () => {
  const cls = (runs: Run[], over: Partial<Job> = {}) =>
    classify(job(over), runs, NOW).class;

  test("green inside the cadence plus grace, stale one millisecond past it", () => {
    expect(cls([done("success", 26 * HOUR)])).toBe("green");
    expect(cls([done("success", 26 * HOUR + 1)])).toBe("stale");
  });

  test("red outranks stale: the last result was a failure whatever its age", () => {
    expect(cls([done("failure", 90 * HOUR), done("failure", 114 * HOUR)])).toBe(
      "red",
    );
  });

  test("a success and a failure at the same instant read as the failure, in either order", () => {
    const success = done("success", HOUR);
    const failure = {
      ...done("failure", HOUR),
      finishedMs: success.finishedMs,
    };
    expect(cls([success, failure], { redAfter: 1 })).toBe("red");
    expect(cls([failure, success], { redAfter: 1 })).toBe("red");
  });

  test("an overdue job below the red threshold is stale, not degraded", () => {
    expect(cls([done("failure", 90 * HOUR)])).toBe("stale");
  });

  test("a success ends the streak; older failures do not count", () => {
    expect(
      cls([
        done("success", HOUR),
        done("failure", 25 * HOUR),
        done("failure", 49 * HOUR),
      ]),
    ).toBe("green");
    expect(
      cls([
        done("failure", HOUR),
        done("success", 25 * HOUR),
        done("failure", 49 * HOUR),
      ]),
    ).toBe("degraded");
  });

  test("the history's order does not matter", () => {
    const runs = [done("failure", 25 * HOUR), done("failure", HOUR)];
    expect(cls(runs)).toBe(cls([...runs].reverse()));
    expect(cls(runs)).toBe("red");
  });

  test("red_after defaults to one failure", () => {
    expect(cls([done("failure", HOUR)], { redAfter: 1 })).toBe("red");
  });

  test("a run in progress shows running over green and degraded, never over red or stale", () => {
    expect(cls([done("success", HOUR), going(HOUR)])).toBe("running");
    expect(cls([done("failure", HOUR), going(HOUR)])).toBe("running");
    expect(
      cls([done("failure", HOUR), done("failure", 25 * HOUR), going(HOUR)]),
    ).toBe("red");
    expect(cls([done("success", 30 * HOUR), going(HOUR)])).toBe("stale");
  });

  test("a run in progress for longer than max_run is hung and counts as no run", () => {
    expect(cls([done("success", HOUR), going(7 * HOUR)])).toBe("green");
    expect(cls([going(7 * HOUR)])).toBe("stale");
    expect(cls([going(HOUR)])).toBe("running");
  });

  test("a cancelled or skipped run inside a streak of failures neither ends it nor extends it", () => {
    const skipped: Run = {
      ...done("success", 2 * HOUR),
      status: "skipped",
      finishedMs: undefined,
    };
    const cancelled: Run = { ...skipped, status: "cancelled" };
    const failures = [done("failure", HOUR), done("failure", 3 * HOUR)];
    expect(cls([...failures, skipped, cancelled])).toBe("red");
    expect(cls([failures[0] as Run, skipped, cancelled])).toBe("degraded");
  });

  test("a first run that never leaves the queue is stale once cadence plus grace has passed", () => {
    expect(cls([going(HOUR)])).toBe("running");
    expect(cls([going(27 * HOUR)], { maxRunMs: 48 * HOUR })).toBe("stale");
  });

  test("the watcher job is left out of the verdict", () => {
    const report = heartbeat(
      [job({ id: "w", watcher: true })],
      [done("failure", HOUR)],
      NOW,
    );
    expect(report.jobs).toEqual([]);
    expect(report.watchers).toEqual(["w"]);
  });

  test("another job's runs are not this job's", () => {
    const other: Run = { ...done("success", HOUR), job: "other" };
    expect(cls([other])).toBe("stale");
  });

  test("the verdict is red when any job is red or stale, ok otherwise", () => {
    const fresh = [done("success", HOUR)];
    expect(heartbeat([job()], fresh, NOW).verdict).toBe("ok");
    expect(heartbeat([job(), job({ id: "k" })], fresh, NOW).verdict).toBe(
      "red",
    );
  });
});

describe("the parsers", () => {
  test("durations are whole minutes, hours or days", () => {
    expect(parseDuration("90m", "x")).toBe(90 * 60_000);
    expect(parseDuration("7d", "x")).toBe(7 * 24 * HOUR);
    for (const bad of ["", "0h", "1.5h", "1w", "24", 24, "1000d", "-1h", " 1h"])
      expect(() => parseDuration(bad, "x")).toThrow();
  });

  test("the grace defaults to a quarter of the cadence", () => {
    const [j] = parseRegistry({ jobs: [{ id: "a", cadence: "24h" }] }, "r");
    expect(j).toMatchObject({
      graceMs: 6 * HOUR,
      redAfter: 1,
      maxRunMs: 6 * HOUR,
    });
  });

  test("a registry version other than 1, or a description that is not text, is refused", () => {
    const one = [{ id: "a", cadence: "1h" }];
    expect(() => parseRegistry({ version: 1, jobs: one }, "r")).not.toThrow();
    expect(() => parseRegistry({ version: 2, jobs: one }, "r")).toThrow(
      "'version' must be 1",
    );
    expect(() =>
      parseRegistry({ version: { bad: true }, jobs: one }, "r"),
    ).toThrow("'version' must be 1");
    expect(() =>
      parseRegistry(
        { jobs: [{ id: "a", cadence: "1h", description: [] }] },
        "r",
      ),
    ).toThrow("description must be text");
  });

  test("a time that names no real calendar instant is refused", () => {
    for (const bad of [
      "2026-02-30T12:00:00Z",
      "2026-02-29T12:00:00Z",
      "2026-13-01T12:00:00Z",
      "2026-03-10T24:00:00Z",
      "2026-03-10T12:60:00Z",
      "2026-03-10T12:00:60Z",
      "2026-03-10T12:00:00+24:00",
      "2026-03-10T12:00:00+02:60",
    ])
      expect(() => parseTime(bad, "t")).toThrow("not a real time");
    expect(parseTime("2028-02-29T12:00:00+02:00", "t")).toBe(
      Date.parse("2028-02-29T10:00:00Z"),
    );
  });

  test("a leap day is judged by the year as written, years below 100 included", () => {
    for (const leap of ["0000-02-29T12:00:00Z", "0096-02-29T12:00:00Z"])
      expect(parseTime(leap, "t")).toBe(Date.parse(leap));
    for (const bad of ["0100-02-29T12:00:00Z", "0097-02-29T12:00:00Z"])
      expect(() => parseTime(bad, "t")).toThrow("not a real time");
  });

  test("an optional registry field written empty is refused, not defaulted", () => {
    for (const field of [
      "grace",
      "max_run",
      "red_after",
      "watcher",
      "description",
    ])
      expect(() =>
        parseRegistry(
          { jobs: [{ id: "a", cadence: "1h", [field]: null }] },
          "r",
        ),
      ).toThrow(field);
  });

  test("one run listed twice for a job is refused; the same id on another job is not", () => {
    const entry = (job: string, id: unknown) => ({
      job,
      id,
      status: "failure",
      startedAt: "2026-03-10T11:00:00Z",
      finishedAt: "2026-03-10T11:05:00Z",
    });
    expect(() =>
      parseHistory(JSON.stringify([entry("a", 7), entry("a", "7")]), NOW),
    ).toThrow("repeats run '7'");
    expect(() =>
      parseHistory(JSON.stringify([entry("a", 7), entry("b", 7)]), NOW),
    ).not.toThrow();
    for (const bad of [undefined, "", -1, 1.5, null])
      expect(() =>
        parseHistory(JSON.stringify([entry("a", bad)]), NOW),
      ).toThrow(".id must be");
  });

  test("a cancelled or skipped run's finish time is checked too", () => {
    const at = (status: string, startedAt: string, finishedAt: string) =>
      JSON.stringify([{ job: "a", id: 1, status, startedAt, finishedAt }]);
    for (const status of ["cancelled", "skipped"]) {
      expect(() =>
        parseHistory(
          at(status, "2026-03-10T11:00:00Z", "2027-03-10T11:00:00Z"),
          NOW,
        ),
      ).toThrow("in the future");
      expect(() =>
        parseHistory(
          at(status, "2026-03-10T11:00:00Z", "2026-03-10T10:00:00Z"),
          NOW,
        ),
      ).toThrow("finished before it started");
      expect(
        parseHistory(
          at(status, "2026-03-10T11:00:00Z", "2026-03-10T11:01:00Z"),
          NOW,
        )[0]?.finishedMs,
      ).toBeUndefined();
    }
  });

  test("a registry key outside the schema is refused", () => {
    expect(() =>
      parseRegistry({ jobs: [{ id: "a", cadence: "1h" }], jobz: [] }, "r"),
    ).toThrow("unknown top-level key");
  });

  test("a history timestamp up to the clock skew ahead is accepted, beyond it refused", () => {
    const at = (t: string) =>
      JSON.stringify([
        { job: "a", id: 1, status: "success", startedAt: t, finishedAt: t },
      ]);
    expect(() => parseHistory(at("2026-03-10T12:04:00Z"), NOW)).not.toThrow();
    expect(() => parseHistory(at("2026-03-10T12:06:00Z"), NOW)).toThrow(
      "in the future",
    );
  });

  test("an offset time is read as the instant it names", () => {
    const [r] = parseHistory(
      JSON.stringify([
        {
          job: "a",
          id: 1,
          status: "success",
          startedAt: "2026-03-10T10:00:00+02:00",
          finishedAt: "2026-03-10T10:05:00+02:00",
        },
      ]),
      NOW,
    );
    expect(r?.finishedMs).toBe(Date.parse("2026-03-10T08:05:00Z"));
  });

  test("a running run may not carry a finish time", () => {
    expect(() =>
      parseHistory(
        JSON.stringify([
          {
            job: "a",
            id: 1,
            status: "running",
            startedAt: "2026-03-10T11:00:00Z",
            finishedAt: "2026-03-10T11:05:00Z",
          },
        ]),
        NOW,
      ),
    ).toThrow("running but has a finishedAt");
  });

  test("parseOptions defaults the clock and pins it with --now", () => {
    const base = ["--registry", "r", "--history", "h"];
    expect(parseOptions(base, 42).now).toBe(42);
    expect(parseOptions([...base, "--now", NOW_TEXT], 42).now).toBe(NOW);
  });
});
