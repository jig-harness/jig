import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Report } from "../scripts/lib/finish-round-report.ts";
import {
  clearPassFinish,
  readPassFinish,
  writePassFinish,
} from "../scripts/lib/state/pass-finish.ts";

test("a cleared finish record reads as absent for the retried pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "pass-finish-"));
  try {
    const report = { state: "CHECK_RUNS_UNREADABLE" } as unknown as Report;
    writePassFinish(dir, 7, "launch-1", 2, report);
    expect(readPassFinish(dir, "7", "launch-1", 2)).not.toBeNull();
    clearPassFinish(dir, "7");
    expect(readPassFinish(dir, "7", "launch-1", 2)).toBeNull();
    // Clearing what is not there is not an error.
    clearPassFinish(dir, "7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record for another pull request, launch or round, or one whose envelope is malformed, reads as absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pass-finish-"));
  try {
    const report = { state: "CHECK_RUNS_UNREADABLE" } as unknown as Report;
    writePassFinish(dir, 7, "launch-1", 2, report);
    expect(readPassFinish(dir, "7", "launch-1", 2)).toEqual(report);
    expect(readPassFinish(dir, "7", "launch-2", 2)).toBeNull();
    expect(readPassFinish(dir, "7", "launch-1", 3)).toBeNull();
    expect(readPassFinish(dir, "8", "launch-1", 2)).toBeNull();
    // An envelope naming another pull request, found in this one's file.
    const file = join(dir, "drive-pr-7.pass-finish.json");
    for (const text of [
      "not json",
      JSON.stringify({
        schema: "drive-pass-finish/v1",
        pr: 8,
        launch: "launch-1",
        round: 2,
        report,
      }),
      JSON.stringify({
        schema: "drive-pass-finish/v0",
        pr: 7,
        launch: "launch-1",
        round: 2,
        report,
      }),
      JSON.stringify({
        schema: "drive-pass-finish/v1",
        pr: 7,
        launch: "launch-1",
        round: 2,
      }),
    ]) {
      writeFileSync(file, text);
      expect(readPassFinish(dir, "7", "launch-1", 2)).toBeNull();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
