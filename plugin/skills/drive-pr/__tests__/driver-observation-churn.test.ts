import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  processTable,
  type ProcessRow,
} from "../../../shared/process-table.ts";
import { poll } from "../../../shared/retry.ts";
import {
  observationPath,
  removeDriverObservation,
  runObservedPass,
  startDriverObservation,
} from "../scripts/lib/driver-observation.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

it("retires dead history while retaining timezone-shifted and unreadable identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "jig-observation-churn-"));
  const state = scopedStateDir(join(root, "state"));
  const started = "2026-11-07T12:00:00.000Z";
  const path = observationPath(state, "999", started);
  const release = join(root, "release");
  let childPid: number | undefined;
  let phase = 0;
  const snapshot = () => JSON.parse(readFileSync(path, "utf8"));
  await startDriverObservation(
    state,
    "999",
    started,
    null,
    "churn-acquisition",
  );
  const result = runObservedPass(
    [
      process.execPath,
      "-e",
      "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.exit(0)}},10)",
      release,
    ],
    {
      timeoutSec: 15,
      stdout: "pipe",
      stderr: "pipe",
      onSpawn(handle) {
        childPid = handle.pid;
      },
    },
    async () => {
      const rows = await processTable();
      const child = rows?.find((r) => r.pid === childPid);
      if (!rows || !child) return rows;
      const helper = (pid: number, start: string): ProcessRow => ({
        pid,
        start,
        ppid: phase === 0 ? child.pid : 1,
        pgid: pid,
        stat: "R",
        args: "fixture helper",
      });
      return [
        ...rows,
        ...(phase === 0 ? [helper(1900000001, "dead-helper")] : []),
        helper(
          1900000002,
          phase === 0 ? "Sat Nov 7 12:00:00 2026" : "Sat Nov 7 13:00:00 2026",
        ),
        helper(1900000003, phase === 0 ? "unreadable-helper" : ""),
      ];
    },
  );
  try {
    expect(
      await poll(() => snapshot().targets.length >= 4, {
        deadlineMs: Date.now() + 5000,
        everyMs: 20,
        until: Boolean,
      }),
    ).toBe(true);
    phase = 1;
    expect(
      await poll(
        () =>
          !snapshot().targets.some(
            (r: { pid: number }) => r.pid === 1900000001,
          ),
        {
          deadlineMs: Date.now() + 5000,
          everyMs: 20,
          until: Boolean,
        },
      ),
    ).toBe(true);
    expect(snapshot().targets.map((r: { pid: number }) => r.pid)).toContain(
      1900000002,
    );
    expect(snapshot().targets.map((r: { pid: number }) => r.pid)).toContain(
      1900000003,
    );
  } finally {
    writeFileSync(release, "release");
    const stopped = await result;
    removeDriverObservation(state, "999", started);
    rmSync(root, { recursive: true, force: true });
    expectSpawnExit(
      {
        exitCode: stopped.code,
        stdout: stopped.stdout,
        stderr: stopped.stderr,
      },
      0,
    );
  }
});
