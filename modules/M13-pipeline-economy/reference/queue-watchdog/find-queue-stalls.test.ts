import { expect, test } from "bun:test";
import { join } from "node:path";
import { findQueueStalls, type Job, parseJobs } from "./find-queue-stalls.ts";

const gate = join(import.meta.dir, "find-queue-stalls.ts"),
  fix = join(import.meta.dir, "fixtures");
const NOW = "2026-01-01T12:00:00Z";
function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync(
    [process.execPath, gate, "--now", NOW, ...args],
    {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}
const fixture = (name: string) => join(fix, name);

const cases: [string, number][] = [
  ["none-queued.json", 0],
  ["queued-under-bound.json", 0],
  ["queued-at-bound.json", 0],
  ["queued-over-bound.json", 1],
  ["waiting-over-bound.json", 0],
  ["slurped-pages.json", 1],
  ["jobs-page.json", 0],
  ["bad-created-at.json", 2],
  ["not-json.json", 2],
  ["unknown-shape.json", 2],
];
for (const [file, code] of cases)
  test(file, () => expect(run([fixture(file)]).code).toBe(code));

test("a stall names the job, its wait, the bound and its url", () => {
  const { out } = run([fixture("queued-over-bound.json")]);
  const lines = out.trim().split("\n");
  expect(lines[0]).toStartWith("STALLED");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("verify-main (job 6, run 600)");
  expect(lines[1]).toContain("queued 180 min (max 45)");
  expect(lines[1]).toContain(
    "https://github.com/example/app/actions/runs/600/job/6",
  );
});

test("a pass counts the queued jobs", () =>
  expect(run([fixture("queued-under-bound.json")]).out).toContain(
    "OK — 1 queued job(s), none waiting over 45 min",
  ));

test("slurped pages flatten and a repeated job counts once", () => {
  const lines = run([fixture("slurped-pages.json")])
    .out.trim()
    .split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("verify-main (job 10, run 900)");
});

test("a looser bound lets the same queue pass", () =>
  expect(
    run(["--max-wait-minutes", "240", fixture("queued-over-bound.json")]).code,
  ).toBe(0));

test("a zero bound stalls any queued job older than now", () =>
  expect(
    run(["--max-wait-minutes", "0", fixture("queued-under-bound.json")]).code,
  ).toBe(1));

for (const bad of [["-1"], ["lots"], ["4.5"], []])
  test(`--max-wait-minutes ${JSON.stringify(bad)} is a usage error`, () => {
    const result = run([
      fixture("none-queued.json"),
      "--max-wait-minutes",
      ...bad,
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--max-wait-minutes");
  });

for (const args of [
  ["--now", "tomorrow", fixture("none-queued.json")],
  ["--now", "2026-01-01T12:00:00", fixture("none-queued.json")],
  ["--frobnicate", fixture("none-queued.json")],
  [fixture("none-queued.json"), fixture("jobs-page.json")],
  [fixture("does-not-exist.json")],
])
  test(`fails closed on ${args.map((a) => a.replace(fix, "")).join(" ")}`, () =>
    expect(run(args).code).toBe(2));

test("reads stdin when no path is given", () => {
  const job = (created_at: string) =>
    JSON.stringify([{ id: 1, name: "build", status: "queued", created_at }]);
  expect(run([], job("2026-01-01T11:00:00Z")).code).toBe(1);
  expect(run(["-"], job("2026-01-01T11:50:00Z")).code).toBe(0);
  expect(run([], "").code).toBe(2);
});

const now = Date.parse(NOW);
const queued = (minutesAgo: number, status = "queued"): Job => ({
  id: minutesAgo,
  name: `job-${minutesAgo}`,
  status,
  created_at: new Date(now - minutesAgo * 60_000).toISOString(),
});

test("only queued jobs strictly over the bound stall", () => {
  const stalls = findQueueStalls(
    [
      queued(44),
      queued(45),
      queued(46),
      queued(500, "waiting"),
      queued(500, "pending"),
      queued(500, "in_progress"),
      queued(500, "completed"),
    ],
    { now, maxWaitMinutes: 45 },
  );
  expect(stalls.map((s) => s.job.id)).toEqual([46]);
  expect(stalls[0]?.waitedMinutes).toBe(46);
});

test("a queued job without created_at throws; another status does not", () => {
  expect(() =>
    findQueueStalls([{ id: 1, status: "queued" }], {
      now,
      maxWaitMinutes: 45,
    }),
  ).toThrow("created_at");
  expect(
    findQueueStalls([{ id: 1, status: "completed" }], {
      now,
      maxWaitMinutes: 45,
    }),
  ).toEqual([]);
});

test("parseJobs accepts the three shapes and rejects the rest", () => {
  const job = { id: 1, status: "queued", created_at: NOW };
  expect(parseJobs([job])).toHaveLength(1);
  expect(parseJobs([])).toHaveLength(0);
  expect(parseJobs({ jobs: [job] })).toHaveLength(1);
  expect(parseJobs([{ jobs: [job] }, { jobs: [] }])).toHaveLength(1);
  expect(() => parseJobs({ workflow_runs: [] })).toThrow();
  expect(() => parseJobs("queued")).toThrow();
  expect(() => parseJobs([{ jobs: [job] }, job])).toThrow();
  expect(() => parseJobs([{ id: 1, status: 3 }])).toThrow("status");
  expect(() => parseJobs([null])).toThrow("status");
});

test("an unknown status fails closed instead of passing", () => {
  expect(() =>
    parseJobs([{ id: 1, status: "queud", created_at: "2026-01-01T09:00:00Z" }]),
  ).toThrow("unknown status");
  for (const status of [
    "waiting",
    "requested",
    "pending",
    "in_progress",
    "completed",
  ])
    expect(parseJobs([{ id: 1, status }])).toHaveLength(1);
});

test("a job listed twice keeps its copy furthest along, in either order", () => {
  const old = { id: 7, run_id: 3, status: "queued", created_at: NOW };
  const done = { id: 7, run_id: 3, status: "completed", created_at: NOW };
  expect(parseJobs([done, old])).toEqual([done]);
  expect(parseJobs([old, done])).toEqual([done]);
  const waiting = { ...old, status: "waiting" };
  expect(parseJobs([old, waiting])).toEqual([old]);
  expect(parseJobs([waiting, old])).toEqual([old]);
});

test("every copy of a repeated job is checked", () => {
  const first = { id: 7, status: "completed", created_at: NOW };
  expect(() => parseJobs([first, { id: 7, status: "queued" }])).toThrow(
    "created_at",
  );
  expect(() =>
    parseJobs([first, { ...first, created_at: "2026-01-01T09:00:00Z" }]),
  ).toThrow("two different created_at");
});

test("an impossible calendar time fails closed instead of rolling over", () => {
  for (const stamp of [
    "2026-02-30T12:00:00Z",
    "2026-02-29T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:60Z",
    "2026-01-01T12:00:00+24:00",
  ]) {
    expect(() =>
      parseJobs([{ id: 1, status: "queued", created_at: stamp }]),
    ).toThrow("ISO 8601");
    expect(run(["--now", stamp, fixture("none-queued.json")]).code).toBe(2);
  }
  expect(
    parseJobs([
      { id: 1, status: "queued", created_at: "2028-02-29T23:59:59+05:30" },
    ]),
  ).toHaveLength(1);
});

test("an identifier of another type fails closed instead of merging jobs", () => {
  const queued = { status: "queued", created_at: "2026-01-01T09:00:00Z" };
  const done = { status: "completed", created_at: "2026-01-01T09:00:00Z" };
  for (const bad of [{ a: 1 }, [1], "", 1.5, true, null])
    for (const field of ["id", "run_id"]) {
      expect(() =>
        parseJobs([
          { id: 1, ...queued, [field]: bad },
          { id: 2, ...done, [field]: bad },
        ]),
      ).toThrow(`${field} that is not an identifier`);
    }
  expect(parseJobs([{ id: "a", run_id: 9, ...queued }])).toHaveLength(1);
});

test("identifiers that join to the same string stay separate jobs", () => {
  const at = "2026-01-01T09:00:00Z";
  const jobs = parseJobs([
    { run_id: "a", id: "b/c", status: "queued", created_at: at },
    { run_id: "a/b", id: "c", status: "completed", created_at: at },
  ]);
  expect(jobs).toHaveLength(2);
  expect(
    findQueueStalls(jobs, { now: Date.parse(NOW), maxWaitMinutes: 45 }),
  ).toHaveLength(1);
});
