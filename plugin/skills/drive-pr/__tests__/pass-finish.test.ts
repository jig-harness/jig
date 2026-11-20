import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
