import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionDeadlineMs } from "../../gc/launcher.ts";
import { driveHold } from "../lib/actions/drive-hold.ts";
import {
  type LaunchExit,
  type LaunchRecord,
  type ProcessIdentity,
  pruneLaunches,
  readLaunches,
  type ReadRecord,
  writeRecord,
} from "../lib/launches.ts";
import type { DrivenPr } from "../lib/types.ts";
import { dispatchJobSpec } from "../install.ts";
import { duration } from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-records-"));
  dirs.push(dir);
  return dir;
}

const WHO: ProcessIdentity = {
  host: "h",
  bootId: "b",
  pid: 1,
  start: "s",
  claimedAt: "2026-01-01T00:00:00.000Z",
};

function record(id: string, over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id,
    token: "t",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "generation 1, exit 8, heartbeat x",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspace: null,
    attempts: [],
    ...over,
  };
}

function ended(r: LaunchRecord, code: number, at: string): ReadRecord {
  const exit: LaunchExit = { at, code, signal: null };
  return { record: r, state: { kind: "ended", exit, process: WHO } };
}

const silent = (started: string): DrivenPr => ({
  number: 7,
  url: "",
  title: "",
  head: "h",
  class: "silent",
  why: "",
  evidence: { generation: 1, exit: 8, heartbeat: "x", started } as never,
});

describe("a takeover behind a refusal", () => {
  it("is not planned again on the facts the refusal answered", () => {
    const owner = ended(
      record("20260101T000000Z-aaaaaaaa"),
      0,
      "2026-01-01T02:00:00.000Z",
    );
    const refusal = ended(
      record("20260101T010000Z-bbbbbbbb", {
        action: "takeover",
        createdAt: "2026-01-01T01:00:00.000Z",
      }),
      20,
      "2026-01-01T01:05:00.000Z",
    );
    const hold = driveHold(silent("2026-01-01T00:30:00.000Z"), [
      owner,
      refusal,
    ]);
    expect(hold.kind).toBe("refused");
  });
});

describe("retention", () => {
  it("keys the standing refusal by repository as well as number", () => {
    const dir = root();
    const a = ended(
      record("20260101T000000Z-aaaaaaaa"),
      13,
      "2026-01-01T00:00:00.000Z",
    );
    const b = ended(
      record("20260102T000000Z-bbbbbbbb", {
        repo: "o/b",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      13,
      "2026-01-02T00:00:00.000Z",
    );
    expect(pruneLaunches([a, b], Date.parse("2027-01-01"), 7, dir)).toEqual([]);
  });
});

describe("reading records", () => {
  it("leaves out a record that is incomplete or names another file", async () => {
    const dir = root();
    const good = record("20260101T000000Z-aaaaaaaa");
    writeRecord(good, dir);
    writeRecord(record("20260101T000001Z-bbbbbbbb", { createdAt: "x" }), dir);
    const { createdAt: _drop, ...partial } = record(
      "20260101T000002Z-cccccccc",
    );
    writeFileSync(
      join(dir, "launches", "20260101T000002Z-cccccccc.json"),
      JSON.stringify(partial),
    );
    writeFileSync(
      join(dir, "launches", "20260101T000003Z-dddddddd.json"),
      JSON.stringify(record("20260101T000000Z-aaaaaaaa")),
    );
    const read = await readLaunches(dir);
    expect(read.records.map((r) => r.record.id)).toEqual([good.id]);
    expect(read.unreadable).toHaveLength(3);
  });
});

describe("the timer's job", () => {
  it("keeps the Orca command configuration and an explicit budget", () => {
    const spec = dispatchJobSpec(5, null, {
      ORCA_CLI_COMMAND: " /opt/orca/bin/orca ",
      ORCA_CLI_BIN_DIR: "/opt/orca/bin",
    });
    expect(spec.env).toEqual({
      ORCA_CLI_COMMAND: "/opt/orca/bin/orca",
      ORCA_CLI_BIN_DIR: "/opt/orca/bin",
    });
    expect(spec.deadlineSec).toBeGreaterThanOrEqual(6 * 3600);
    expect(collectionDeadlineMs({ JIG_LAUNCHER_DEADLINE_SEC: "21600" })).toBe(
      21_600_000,
    );
    expect(collectionDeadlineMs({})).toBe(10_800_000);
  });

  it("holds every duration inside a timer's range", () => {
    expect(() => duration("720h", "x")).toThrow("at most 24d");
    expect(duration("576h", "x")).toBe(576 * 3_600_000);
  });
});
