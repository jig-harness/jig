import { expect, it } from "bun:test";
import { observeTestLockWaits, testLockNote } from "../lib/test-lock-waits.ts";
import type { ReadRecord } from "../lib/launches.ts";
import { planDrift } from "../lib/expectations.ts";
import type { DispatchSection } from "../lib/types.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeLockWait,
  readLockWaits,
} from "../../shared/resource-lock-waits.ts";
import { decodeIdentity } from "../../shared/liveness.ts";
import { endedHow } from "../lib/actions/pickup-hold.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { byPlatform } from "../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

it("reads a live wait's portable workspace and timestamp, refusing a reused identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-wait-reading-"));
  try {
    const announcement = encodeLockWait();
    const data: unknown = JSON.parse(announcement);
    expect(isMapping(data) && typeof data.since === "string").toBe(true);
    if (!isMapping(data) || typeof data.since !== "string") return;
    expect(decodeIdentity(announcement)?.pid).toBe(process.pid);
    const path = join(dir, `jig-lock.heavy.waiting.${process.pid}`);
    writeFileSync(path, announcement);
    const expected = [
      { pid: process.pid, workspace: process.cwd(), since: data.since },
    ];
    expect(
      JSON.stringify(readLockWaits(dir, join(dir, "jig-lock.heavy"))),
    ).toBe(
      byPlatform(
        "Windows identity verification must read process creation time before attributing waits",
        { windows: "[]", posix: JSON.stringify(expected) },
      ),
    );
    writeFileSync(
      path,
      JSON.stringify({
        ...data,
        start: "different process",
      }),
    );
    expect(readLockWaits(dir, join(dir, "jig-lock.heavy"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("attributes a wait longer than the pass has left and names it in drift", () => {
  const r = {
    record: {
      id: "p",
      action: "pickup",
      repo: "o/r",
      item: "#7",
      createdAt: "2026-11-01T10:00:00.000Z",
      passTimeoutSec: 10800,
      workspace: { id: "w", path: "/work/w" },
    },
    state: { kind: "alive" },
    result: null,
  } as unknown as ReadRecord;
  const now = Temporal.Instant.from(
    "2026-11-01T12:59:00.000Z",
  ).epochMilliseconds;
  const waits = [
    { pid: 12, workspace: "/work/w", since: "2026-11-01T12:00:00.000Z" },
  ];
  observeTestLockWaits([r], "o/r", waits, now, () => undefined);
  expect(r.record.testLockWait).toMatchObject({
    pid: 12,
    since: "2026-11-01T12:00:00.000Z",
  });
  const drift = planDrift({
    slug: "o/r",
    section: { pickupWithinMs: 3600000 } as DispatchSection,
    launches: [r],
    sessions: {
      ok: true,
      source: "test",
      workspaces: [
        {
          id: "w",
          path: "/work/w",
          prs: [],
          agents: [],
          branch: "",
          items: [],
          name: "w",
          comment: "",
          unread: null,
          unverifiableTerminals: 0,
        },
      ],
    },
    created: new Map(),
    itemStates: new Map(),
    waiting: new Set(),
    nowMs: now,
  });
  expect(drift.actions[0]?.reason).toContain(
    "waiting for the test lock for 59m",
  );
  expect(drift.actions[0]?.reason).not.toContain("opened no pull request");
  observeTestLockWaits([r], "o/r", [], now + 60000, () => undefined);
  expect(testLockNote(r.record, now + 60000)).toContain("last seen waiting");
  expect(testLockNote(r.record, now + 60000)).not.toContain("is waiting");
  r.state = {
    kind: "ended",
    exit: { at: "2026-11-01T13:00:00.000Z", code: null },
  } as ReadRecord["state"];
  expect(endedHow(r)).toContain("last seen waiting for the test lock for 59m");
});

it("does not attribute a workspace's old wait to a later launch", () => {
  const r = {
    record: {
      repo: "o/r",
      createdAt: "2026-11-01T12:00:00.000Z",
      workspace: { path: "/work/w" },
    },
    state: { kind: "alive" },
  } as unknown as ReadRecord;
  observeTestLockWaits(
    [r],
    "o/r",
    [{ pid: 12, workspace: "/work/w", since: "2026-11-01T11:00:00.000Z" }],
    Temporal.Instant.from("2026-11-01T13:00:00.000Z").epochMilliseconds,
    () => undefined,
  );
  expect(r.record.testLockWait).toBeUndefined();
});

it("does not attribute a wait shared by two eligible live launches", () => {
  const record = {
    repo: "o/r",
    createdAt: "2026-11-01T10:00:00.000Z",
    workspace: { path: "/work/w" },
  };
  const records = ["one", "two"].map((id) => ({
    record: { ...record, id },
    state: { kind: "alive" },
  })) as unknown as ReadRecord[];
  const now = Temporal.Instant.from(
    "2026-11-01T12:00:00.000Z",
  ).epochMilliseconds;
  observeTestLockWaits(
    records,
    "o/r",
    [{ pid: 12, workspace: "/work/w", since: "2026-11-01T11:00:00.000Z" }],
    now,
    () => undefined,
  );
  expect(records.map((r) => r.record.testLockWait)).toEqual([
    undefined,
    undefined,
  ]);
});

it("attributes a wait from a directory inside the workspace, not from a sibling", () => {
  const records = [
    { id: "inside", path: "/work/w" },
    { id: "sibling", path: "/work/w2" },
  ].map(({ id, path }) => ({
    record: {
      id,
      repo: "o/r",
      createdAt: "2026-11-01T10:00:00.000Z",
      workspace: { path },
    },
    state: { kind: "alive" },
  })) as unknown as ReadRecord[];
  const now = Temporal.Instant.from(
    "2026-11-01T12:00:00.000Z",
  ).epochMilliseconds;
  observeTestLockWaits(
    records,
    "o/r",
    [
      {
        pid: 12,
        workspace: "/work/w/plugin",
        since: "2026-11-01T11:00:00.000Z",
      },
    ],
    now,
    () => undefined,
  );
  expect(records.map((r) => r.record.testLockWait?.pid)).toEqual([
    12,
    undefined,
  ]);
});

it("reads waits without taking on the lock's signal handlers", () => {
  // The dashboard server imports the outcome log, which names waits; a signal
  // handler from the lock would turn its clean stop on SIGTERM into exit 143.
  const log = join(import.meta.dir, "..", "lib", "log.ts");
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(log)}); console.log(process.listenerCount("SIGTERM"));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(probe, 0);
  expect(probe.stdout.toString().trim()).toBe("0");
});

it("names a wait in a follow-up's drift reason", () => {
  const now = Temporal.Instant.from(
    "2026-11-01T12:59:00.000Z",
  ).epochMilliseconds;
  const r = {
    record: {
      id: "f",
      action: "followup",
      repo: "o/r",
      createdAt: "2026-11-01T10:00:00.000Z",
      workspace: { path: "/work/f" },
      testLockWait: {
        pid: 12,
        workspace: "/work/f",
        since: "2026-11-01T12:00:00.000Z",
        observedAt: "2026-11-01T12:59:00.000Z",
        waiting: true,
      },
    },
    state: { kind: "alive" },
    result: null,
  } as unknown as ReadRecord;
  const drift = planDrift({
    slug: "o/r",
    section: { followupWithinMs: 3600000 } as DispatchSection,
    launches: [r],
    sessions: { ok: true, source: "test", workspaces: [] },
    created: new Map(),
    itemStates: new Map(),
    waiting: new Set(),
    nowMs: now,
  });
  expect(drift.actions[0]?.reason).toContain(
    "waiting for the test lock for 59m",
  );
});

it("reads no announcement once the deadline has passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-wait-deadline-"));
  try {
    writeFileSync(
      join(dir, `jig-lock.heavy.waiting.${process.pid}`),
      encodeLockWait(),
    );
    expect(
      readLockWaits(dir, join(dir, "jig-lock.heavy"), performance.now() - 1),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads no oversized announcement and none whose name carries no pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-wait-bound-"));
  try {
    const announcement = encodeLockWait();
    const padded = announcement + " ".repeat(8192);
    writeFileSync(join(dir, `jig-lock.heavy.waiting.${process.pid}`), padded);
    writeFileSync(join(dir, "jig-lock.heavy.waiting.invalid"), announcement);
    expect(readLockWaits(dir, join(dir, "jig-lock.heavy"))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads no FIFO announcement and does not block on one", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-wait-fifo-"));
  try {
    const made = Bun.spawnSync(
      ["mkfifo", `jig-lock.heavy.waiting.${process.pid}`],
      {
        cwd: dir,
      },
    );
    if (made.exitCode !== 0) return;
    const module = join(import.meta.dir, "../../shared/resource-lock-waits.ts");
    const script = `const { readLockWaits } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(readLockWaits(${JSON.stringify(dir)}, ${JSON.stringify(join(dir, "jig-lock.heavy"))})));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
      killSignal: "SIGKILL",
    });
    expectSpawnExit(child, 0, "a FIFO announcement");
    expect(child.stdout.toString().trim()).toBe("[]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
