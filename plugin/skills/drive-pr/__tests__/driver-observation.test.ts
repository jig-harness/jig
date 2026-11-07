import { reserveDeadDriver } from "../scripts/lib/driver-recovery.ts";
import { driveDb } from "../scripts/lib/state/db.ts";
import { driverRecordRow } from "./state-rows.ts";
import { writeDriverRecord } from "../scripts/lib/ledger-stop.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { thisHost } from "../../../shared/liveness.ts";
import type { ProcessRow } from "../../../shared/process-table.ts";
import {
  beginProcessRegistration,
  createProcessRegistry,
  processCompletionPath,
  publishProcessIdentity,
} from "../../../shared/process-registry.ts";
import { poll } from "../../../shared/retry.ts";
import {
  observationPath,
  observedDriverGone,
  recoverObservedDriver,
  removeDriverObservation,
  runObservedPass,
  startDriverObservation,
} from "../scripts/lib/driver-observation.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { lockRow, putLock } from "./state-rows.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jig-driver-observation-"));
  roots.push(root);
  const state = scopedStateDir(join(root, "state"));
  const started = "2026-11-07T12:00:00.000Z";
  const driver = { ...thisHost(), pid: 900001, start: "recorded-driver-start" };
  const value = {
    version: 1,
    nonce: "recorded-acquisition",
    started,
    driver,
    registry: null,
    pending: false,
    uncertain: false,
    targets: [] as ProcessRow[],
    groups: [] as number[],
  };
  const path = observationPath(state, "999", started);
  const publish = () => writeFileSync(path, JSON.stringify(value));
  putLock(state, "pr-drive-999", {
    token: value.nonce,
    pid: driver.pid,
    host: driver.host,
    start: driver.start,
    diag: { pr: "999", worktree: root, log: "", started },
  });
  publish();
  const record = { started, pid: driver.pid, host: driver.host };
  const gone = (rows: ProcessRow[] | null = []) =>
    observedDriverGone(state, "999", record, async () => rows);
  return { root, state, started, driver, value, path, publish, gone };
}

const row = (over: Partial<ProcessRow> = {}): ProcessRow => ({
  pid: 900002,
  ppid: 900001,
  pgid: 900002,
  start: "recorded-pass-start",
  stat: "R",
  args: "fixture pass",
  ...over,
});

describe("durable driver observations", () => {
  it("recovers only a complete acquisition whose observed work has ended", async () => {
    const f = fixture();
    f.value.targets = [row()];
    f.value.groups = [900002];
    f.publish();
    expect(await f.gone()).toBe(true);
    expect(await f.gone([row({ stat: "Z" })])).toBe(true);
  });

  it("accepts an acquisition-bound lock with an omitted Windows creation time", async () => {
    const f = fixture();
    putLock(f.state, "pr-drive-999", {
      token: f.value.nonce,
      pid: f.driver.pid,
      host: f.driver.host,
      start: "",
      diag: { pr: "999", worktree: f.root, log: "", started: f.started },
    });
    expect(await f.gone()).toBe(true);
    expect(
      await f.gone([row({ pid: f.driver.pid, start: f.driver.start })]),
    ).toBe(false);
    f.value.driver.start = "another-driver-start";
    f.publish();
    putLock(f.state, "pr-drive-999", {
      token: f.value.nonce,
      pid: f.driver.pid,
      start: "original-driver-start",
      diag: { pr: "999", worktree: f.root, log: "", started: f.started },
    });
    expect(await f.gone()).toBe(false);
  });

  it("withholds recovery for a retained helper read in another timezone", async () => {
    const f = fixture();
    f.value.targets = [row({ start: "Sat Nov 7 12:00:00 2026" })];
    f.publish();
    expect(
      await f.gone([
        row({ ppid: 1, pgid: 900003, start: "Sat Nov 7 13:00:00 2026" }),
      ]),
    ).toBe(false);
  });

  it("keeps separate paths for successive acquisitions", () => {
    const f = fixture();
    const next = observationPath(f.state, "999", `${f.started}-successor`);
    expect(next).not.toBe(f.path);
    expect(observationPath(f.state, "1000", f.started)).not.toBe(f.path);
    writeFileSync(next, "successor");
    removeDriverObservation(f.state, "999", f.started);
    expect(readFileSync(next, "utf8")).toBe("successor");
  });

  it("withholds recovery for absent, damaged, pending and uncertain records", async () => {
    const f = fixture();
    rmSync(f.path);
    expect(await f.gone()).toBe(false);
    writeFileSync(f.path, "{");
    expect(await f.gone()).toBe(false);
    for (const field of ["pending", "uncertain"] as const) {
      f.value[field] = true;
      f.publish();
      expect(await f.gone()).toBe(false);
      f.value[field] = false;
    }
  });

  it("withholds recovery for an unreadable table or foreign process namespace", async () => {
    const f = fixture();
    expect(await f.gone(null)).toBe(false);
    f.value.driver.hostId = "another-machine-id";
    f.publish();
    expect(await f.gone()).toBe(false);
  });

  it("preserves a successor that replaced the observed lock nonce", async () => {
    const f = fixture();
    putLock(f.state, "pr-drive-999", {
      token: "successor-acquisition",
      pid: f.driver.pid,
      start: f.driver.start,
      diag: { pr: "999", worktree: f.root, log: "", started: f.started },
    });
    const successor = lockRow(f.state, "pr-drive-999");
    expect(await f.gone()).toBe(false);
    expect(lockRow(f.state, "pr-drive-999")).toEqual(successor);
  });

  it("does not release a successor installed while reconciliation holds the PR slot", async () => {
    const f = fixture();
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    f.value.driver.pid = child.pid;
    f.publish();
    putLock(f.state, "pr-drive-999", {
      token: f.value.nonce,
      pid: child.pid,
      start: f.driver.start,
      diag: { pr: "999", worktree: f.root, log: "", started: f.started },
    });
    writeDriverRecord(f.state, "999", {
      started: f.started,
      pid: child.pid,
      host: f.driver.host,
      worktree: f.root,
    });
    let called = false;
    expect(
      await recoverObservedDriver(
        f.state,
        "999",
        {
          started: f.started,
          pid: child.pid,
          host: f.driver.host,
          worktree: f.root,
        },
        async () => {
          called = true;
          putLock(f.state, "pr-drive-999", {
            token: "successor-during-recovery",
          });
        },
      ),
    ).toBe(true);
    expect(called).toBe(true);
    expect(lockRow(f.state, "pr-drive-999")?.token).toBe(
      "successor-during-recovery",
    );
  });

  it("rolls back the recovery reservation when publishing its released witness fails", async () => {
    const f = fixture();
    const record = {
      worktree: f.root,
      started: f.started,
      pid: f.driver.pid,
      host: f.driver.host,
    };
    writeDriverRecord(f.state, "999", record);
    const original = lockRow(f.state, "pr-drive-999");
    const db = driveDb(f.state).db;
    db.exec(
      "CREATE TRIGGER refuse_witness BEFORE UPDATE OF released ON driver_records BEGIN SELECT RAISE(ABORT, 'fixture witness failure'); END",
    );
    try {
      await expect(
        reserveDeadDriver(
          f.state,
          "999",
          record,
          async () => {
            expect("callback ran before witness").toBe("callback withheld");
          },
          true,
        ),
      ).rejects.toThrow("fixture witness failure");
      expect(lockRow(f.state, "pr-drive-999")).toEqual(original);
      expect(driverRecordRow(f.state, "999")?.released).toBe(0);
    } finally {
      db.exec("DROP TRIGGER refuse_witness");
    }
  });

  it("does not mistake a live or unidentifiable driver for a dead one", async () => {
    const f = fixture();
    const live = row({ pid: f.driver.pid, start: f.driver.start });
    expect(await f.gone([live])).toBe(false);
    expect(await f.gone([{ ...live, start: "" }])).toBe(false);
    f.value.driver.start = "";
    f.publish();
    expect(await f.gone()).toBe(false);
  });

  it("retains a surviving pass identity or any live member of its group", async () => {
    const f = fixture();
    f.value.targets = [row()];
    f.value.groups = [900002];
    f.publish();
    expect(await f.gone([row()])).toBe(false);
    expect(await f.gone([row({ start: "" })])).toBe(false);
    expect(await f.gone([row({ pid: 900003, ppid: 1 })])).toBe(false);
    expect(await f.gone([row({ pid: 900003, pgid: 900004 })])).toBe(true);
  });

  it("rejects a retained target whose creation identity was never captured", async () => {
    const f = fixture();
    f.value.targets = [row({ start: "" })];
    f.publish();
    expect(await f.gone()).toBe(false);
  });

  it("withholds recovery for malformed retained records", async () => {
    const f = fixture();
    for (const target of [
      null,
      { ...row(), pid: null },
      { ...row(), start: 42 },
    ]) {
      writeFileSync(f.path, JSON.stringify({ ...f.value, targets: [target] }));
      expect(await f.gone()).toBe(false);
    }
  });

  it("withholds recovery for pending or still-running registered work", async () => {
    const f = fixture();
    const registry = createProcessRegistry(f.root);
    writeFileSync(
      f.path,
      JSON.stringify({ ...f.value, registry: registry.dir }),
    );
    beginProcessRegistration(
      registry.dir,
      "managed-runner",
      processCompletionPath(registry.dir, "managed-runner"),
    );
    expect(await f.gone()).toBe(false);
    publishProcessIdentity(registry.dir, "managed-runner", {
      pid: 900002,
      start: "recorded-pass-start",
    });
    expect(await f.gone([row()])).toBe(false);
  });

  it.each([false, true])(
    "persists pass identity without clearing a prior unknown launch (%s)",
    async (priorUnknown) => {
      const f = fixture();
      await startDriverObservation(
        f.state,
        "999",
        f.started,
        null,
        "live-acquisition",
      );
      if (priorUnknown) {
        const absent = await runObservedPass(
          [process.execPath, "-e", ""],
          { timeoutSec: 10 },
          async () => [],
        );
        expectSpawnExit(
          {
            exitCode: absent.code,
            stdout: absent.stdout,
            stderr: absent.stderr,
          },
          0,
        );
        expect(JSON.parse(readFileSync(f.path, "utf8")).pending).toBe(true);
      }
      const release = join(f.root, "release-pass");
      let pendingAtSpawn = false;
      const result = runObservedPass(
        [
          process.execPath,
          "-e",
          "const {existsSync}=require('node:fs');const timer=setInterval(()=>{if(existsSync(process.argv[1])){clearInterval(timer);process.exit(0)}},10)",
          release,
        ],
        {
          timeoutSec: 10,
          stdout: "pipe",
          stderr: "pipe",
          onSpawn() {
            pendingAtSpawn = JSON.parse(readFileSync(f.path, "utf8")).pending;
          },
        },
      );
      try {
        const captured = await poll(
          () => {
            const value = JSON.parse(readFileSync(f.path, "utf8"));
            return value.pending === false && value.targets.length > 0;
          },
          { deadlineMs: Date.now() + 5000, everyMs: 20, until: Boolean },
        );
        expect(captured).toBe(true);
        expect(pendingAtSpawn).toBe(true);
        const retained = JSON.parse(readFileSync(f.path, "utf8"));
        expect(
          retained.targets.map((t: unknown) => Object.keys(t as object).sort()),
        ).toEqual(retained.targets.map(() => ["pid", "start"]));
        expect(JSON.parse(readFileSync(f.path, "utf8")).uncertain).toBe(
          priorUnknown,
        );
      } finally {
        writeFileSync(release, "release");
        const stopped = await result;
        expectSpawnExit(
          {
            exitCode: stopped.code,
            stdout: stopped.stdout,
            stderr: stopped.stderr,
          },
          0,
        );
        removeDriverObservation(f.state, "999", f.started);
      }
    },
  );
});
