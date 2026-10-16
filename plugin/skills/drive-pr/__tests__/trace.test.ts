import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { PASS_NOOP, runDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();

test("one drive keeps every timed gh call in its trace across helper processes", async () => {
  const { dir, stateDir } = writeFixture({
    threads: [],
    reviewedSha: scratchClean.head,
    head: scratchClean.head,
  });
  const file = join(dir, "trace.jsonl");
  const calls = join(dir, "gh-calls.log");
  const result = await runDriveIn(
    dir,
    stateDir,
    ["--no-head-sync", "--", ...PASS_NOOP],
    undefined,
    {
      env: {
        JIG_TRACE_FILE: file,
        TRACEPARENT: "",
        DRIVE_PR_STUB_GH_LOG: calls,
      },
    },
  );
  expect(result.exitCode).toBe(0);
  const rows = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(new Set(rows.map((row) => row.trace_id)).size).toBe(1);
  expect(rows.filter((row) => row.name === "drive")).toHaveLength(1);
  const gh = rows.filter((row) => row.name === "ghCall");
  // Every executed gh call, in the driver and in each helper, is timed: a
  // ghCall wraps exactly one gh process span, and a direct run has only that.
  const executed = readFileSync(calls, "utf8").trim().split("\n");
  const processes = rows.filter(
    (row) => row.name === "run" && row.attrs.command === "gh",
  );
  expect(executed.length).toBeGreaterThan(1);
  expect(processes).toHaveLength(executed.length);
  expect(gh.every((row) => row.duration_ms >= 0)).toBe(true);
  expect(
    gh.every(
      (row) =>
        typeof row.attrs.exit_code === "number" &&
        typeof row.attrs.timed_out === "boolean" &&
        row.attrs.timeout_sec > 0,
    ),
  ).toBe(true);
  const parents = new Set(rows.map((row) => row.span_id));
  expect(gh.every((row) => parents.has(row.parent_id))).toBe(true);
});
