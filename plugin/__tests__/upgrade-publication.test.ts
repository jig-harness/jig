import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradesSince } from "../skills/drive-pr/scripts/lib/morning-report-upgrades.ts";

test("a dispatch receipt is new to a report from when it was written, not from when its tick started", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-publication-"));
  try {
    const started = "2026-11-07T06:00:00.000Z";
    const runId = "2026-11-07T06-00-00-000Z-1234-abcdef12";
    const dir = join(root, "receipts", "2026-11-07");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${runId}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runId,
        startedAt: started,
        finishedAt: "2026-11-07T06:10:00.000Z",
        completed: true,
        apply: true,
        exitStatus: 0,
        upgrade: {
          outcome: "updated",
          detail: "ok",
          at: "2026-11-07T05:59:00.000Z",
          from: "0.1.0",
          to: "0.2.0",
        },
        repos: [],
      }),
    );
    const published = new Date("2026-11-07T06:10:00.000Z");
    utimesSync(path, published, published);
    const reportRan = Date.parse("2026-11-07T06:05:00.000Z");
    expect(upgradesSince(reportRan, { dispatch: root }).entries).toHaveLength(
      1,
    );
    expect(
      upgradesSince(Date.parse("2026-11-07T06:11:00.000Z"), { dispatch: root })
        .entries,
    ).toHaveLength(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
