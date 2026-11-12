import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NightlyResult } from "./classify.ts";
import {
  buildReport,
  type Job,
  LIST_LIMIT,
  listJobs,
  readResults,
} from "./report.ts";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const job = (name: string, conclusion: string, minutes = 10): Job => ({
  name,
  status: "completed",
  conclusion,
  started_at: "2026-11-11T11:00:00Z",
  completed_at: new Date(
    Date.parse("2026-11-11T11:00:00Z") + minutes * 60_000,
  ).toISOString(),
  html_url: `https://github.com/team/project/actions/runs/1/job/${name.length}`,
});

const result = (overrides: Partial<NightlyResult>): NightlyResult => ({
  job: "gates (windows, 3/7)",
  platform: "windows",
  status: 0,
  verdict: "known",
  newFailures: [],
  knownFailures: [],
  stale: [],
  ...overrides,
});

const base = {
  runUrl: "https://github.com/team/project/actions/runs/1",
  sha: "0123456789abcdef",
  unreadable: [],
};

describe("the nightly run's report", () => {
  test("a new failure on Windows fails the run and is named under its job", () => {
    const { red, text } = buildReport({
      ...base,
      jobs: [
        job("gates (windows, 3/7)", "failure"),
        job("gates (macos)", "success"),
      ],
      results: [
        result({
          status: 1,
          verdict: "new",
          newFailures: [
            { file: "lib/a.test.ts", name: "outer > breaks on Windows" },
          ],
        }),
      ],
    });
    expect(red).toBe(true);
    expect(text).toContain(
      "[nightly run](https://github.com/team/project/actions/runs/1) on `main` at 0123456789ab failed.",
    );
    expect(text).toContain(
      "| [gates (windows, 3/7)](https://github.com/team/project/actions/runs/1/job/20) | failure: 1 new test failure(s) |",
    );
    expect(text).toContain(
      "#### gates (windows, 3/7)\n\n- `lib/a.test.ts`: outer > breaks on Windows",
    );
    expect(text).not.toContain("gates (macos)");
  });

  test("names how each job that did not pass ended, with or without its tests' results", () => {
    const { text } = buildReport({
      ...base,
      jobs: [
        job("drive-pr suite (windows, 1/4)", "cancelled", 35),
        job("gates (macos)", "failure"),
        job("website (windows)", "failure"),
        job("gates (windows, 1/7)", "failure"),
      ],
      results: [
        result({ job: "gates (macos)", platform: "macos" }),
        result({
          job: "gates (windows, 1/7)",
          status: 1,
          verdict: "unexplained",
          detail: "bun reported 1 error(s) outside any test",
        }),
      ],
    });
    expect(text).toContain(
      "cancelled after 35 min, by a person or at its time limit",
    );
    expect(text).toContain(
      "failure, with no new test failure: another step failed (see its log)",
    );
    expect(text).toContain("failure, before its tests reported (see its log)");
    expect(text).toContain("failure: bun reported 1 error(s) outside any test");
  });

  test("a job that timed out fails the run though no test failed", () => {
    const { red, text } = buildReport({
      ...base,
      jobs: [job("drive-pr suite (windows, 1/4)", "cancelled", 45)],
      results: [
        result({ job: "drive-pr suite (windows, 1/4)", verdict: "passed" }),
      ],
    });
    expect(red).toBe(true);
    expect(text).toContain("failed.");
  });

  test("a passing run lists the recorded failures that passed, for their entries to go", () => {
    const { red, text } = buildReport({
      ...base,
      jobs: [
        job("gates (macos)", "success"),
        job("website (macos)", "skipped"),
      ],
      results: [
        result({
          job: "gates (macos)",
          platform: "macos",
          verdict: "passed",
          stale: [
            {
              file: "plugin/dispatch/__tests__/a.test.ts",
              name: "notifies `once`",
              issue: "#818",
            },
          ],
        }),
      ],
    });
    expect(red).toBe(false);
    expect(text).toContain("passed.");
    expect(text).toContain(
      "Remove these entries from `.config/nightly-baseline.yaml`:\n\n- `plugin/dispatch/__tests__/a.test.ts`: notifies 'once' (#818)",
    );
    expect(text).not.toContain("| Job |");
  });

  test("a long list says how many more it holds", () => {
    const newFailures = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => ({
      file: "a.test.ts",
      name: `case ${i}`,
    }));
    const { text } = buildReport({
      ...base,
      jobs: [job("gates (macos)", "failure")],
      results: [
        result({
          job: "gates (macos)",
          status: 1,
          verdict: "new",
          newFailures,
        }),
      ],
    });
    expect(text).toContain(`case ${LIST_LIMIT - 1}\n- and 3 more`);
    expect(text).not.toContain(`case ${LIST_LIMIT}\n`);
  });

  test("reads every result file, and names one it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-nightly-results-"));
    temporary.push(dir);
    writeFileSync(join(dir, "result-a.json"), JSON.stringify(result({})));
    writeFileSync(join(dir, "result-b.json"), "{");
    writeFileSync(join(dir, "result-c.json"), JSON.stringify({ job: "x" }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const { results, unreadable } = readResults(dir);
    expect(results).toHaveLength(1);
    expect(unreadable).toEqual(["result-b.json", "result-c.json"]);
    expect(readResults(join(dir, "missing"))).toEqual({
      results: [],
      unreadable: [],
    });
  });

  test("lists the run's finished jobs, and refuses a listing that is not complete", () => {
    const env = {
      GITHUB_REPOSITORY: "team/project",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "2",
    };
    const calls: string[][] = [];
    const listing =
      (jobs: unknown[], total = jobs.length) =>
      (args: string[]) => {
        calls.push(args);
        return {
          ok: true,
          stdout: JSON.stringify({ total_count: total, jobs }),
          stderr: "",
        };
      };
    const running = { name: "report", status: "in_progress", conclusion: null };
    expect(
      listJobs(listing([job("gates (macos)", "failure"), running]), env).map(
        (j) => j.name,
      ),
    ).toEqual(["gates (macos)"]);
    expect(calls[0]).toEqual([
      "repos/team/project/actions/runs/42/attempts/2/jobs?per_page=100",
    ]);
    expect(() => listJobs(listing([running], 101), env)).toThrow("incomplete");
    expect(() =>
      listJobs(() => ({ ok: false, stdout: "", stderr: "HTTP 403" }), env),
    ).toThrow("HTTP 403");
    expect(() => listJobs(listing([]), {})).toThrow("GITHUB_RUN_ID");
  });
});
