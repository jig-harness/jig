import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionDeadlineMs } from "../../runtime/launcher.ts";
import { driveHold } from "../lib/actions/drive-hold.ts";
import {
  type LaunchAttempt,
  type LaunchExit,
  type LaunchRecord,
  type LaunchClaim,
  claimRecord,
  pruneLaunches,
  readLaunches,
  recordExit,
  type ReadRecord,
  writeRecord,
} from "../lib/launches.ts";
import { markedSince } from "../lib/launch-report.ts";
import { stateDb, closeStateDb } from "../lib/state.ts";
import type { DrivenPr } from "../lib/types.ts";
import { dispatchJobSpec } from "../install.ts";
import { duration } from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-records-"));
  dirs.push(dir);
  return dir;
}

const WHO: LaunchClaim = {
  hostId: "",
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
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    ...over,
  };
}

function ended(r: LaunchRecord, code: number, at: string): ReadRecord {
  const exit: LaunchExit = { at, code, signal: null };
  return {
    record: r,
    state: { kind: "ended", exit, process: WHO },
    result: null,
  };
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

  it("keeps each change's latest re-drive record past the retention", () => {
    const dir = root();
    const redrive = (id: string, change: string, at: string) =>
      ended(
        record(id, {
          createdAt: at,
          redrive: { cause: "conflicting", change },
        }),
        0,
        at,
      );
    const old = redrive(
      "20260101T000000Z-aaaaaaaa",
      "c1",
      "2026-01-01T00:00:00.000Z",
    );
    const other = redrive(
      "20260102T000000Z-bbbbbbbb",
      "c2",
      "2026-01-02T00:00:00.000Z",
    );
    const again = redrive(
      "20260103T000000Z-cccccccc",
      "c1",
      "2026-01-03T00:00:00.000Z",
    );
    // c1 was re-driven twice (a return to an older head): only its latest
    // record stays; c2's stays as the evidence for c2.
    expect(
      pruneLaunches([old, other, again], Date.parse("2027-01-01"), 7, dir),
    ).toEqual(["20260101T000000Z-aaaaaaaa"]);
  });

  it("keeps the latest record per change a replay moved on from, not only per current change", () => {
    const dir = root();
    const redrive = (
      id: string,
      change: string,
      at: string,
      earlier?: string[],
    ) =>
      ended(
        record(id, {
          createdAt: at,
          redrive: {
            cause: "conflicting",
            change,
            ...(earlier ? { earlier } : {}),
          },
        }),
        0,
        at,
      );
    const r1 = redrive(
      "20260101T000000Z-aaaaaaaa",
      "b",
      "2026-01-01T00:00:00.000Z",
      ["a"],
    );
    const r2 = redrive(
      "20260102T000000Z-bbbbbbbb",
      "b",
      "2026-01-02T00:00:00.000Z",
    );
    // r1 is the only evidence that "a" was attempted, so it stays.
    expect(pruneLaunches([r1, r2], Date.parse("2027-01-01"), 7, dir)).toEqual(
      [],
    );
  });

  it("keeps the latest arm of a pull request with no ledger, per head, past the retention", () => {
    const dir = root();
    const arm = (id: string, head: string, at: string) =>
      ended(
        record(id, { createdAt: at, facts: `no ledger, head ${head}` }),
        0,
        at,
      );
    const old = arm(
      "20260101T000000Z-aaaaaaaa",
      "h1",
      "2026-01-01T00:00:00.000Z",
    );
    const again = arm(
      "20260102T000000Z-bbbbbbbb",
      "h1",
      "2026-01-02T00:00:00.000Z",
    );
    // Only the earlier record of the same head goes; the latest stays as evidence.
    expect(
      pruneLaunches([old, again], Date.parse("2027-01-01"), 7, dir),
    ).toEqual(["20260101T000000Z-aaaaaaaa"]);
  });

  it("keeps an unreleased pickup until it is released", () => {
    const dir = root();
    const pickup = (released: boolean) =>
      ended(
        record("20260101T000000Z-aaaaaaaa", {
          action: "pickup",
          pr: null,
          item: "#12",
          released,
        }),
        1,
        "2026-01-01T00:00:00.000Z",
      );
    const now = Date.parse("2027-01-01");
    expect(pruneLaunches([pickup(false)], now, 7, dir)).toEqual([]);
    expect(pruneLaunches([pickup(true)], now, 7, dir)).toEqual([
      "20260101T000000Z-aaaaaaaa",
    ]);
  });
});

describe("reading records", () => {
  it("leaves out a record that is incomplete or names another row", async () => {
    const dir = root();
    const good = record("20260101T000000Z-aaaaaaaa");
    writeRecord(good, dir);
    writeRecord(record("20260101T000001Z-bbbbbbbb", { createdAt: "x" }), dir);
    const { createdAt: _drop, ...partial } = record(
      "20260101T000002Z-cccccccc",
    );
    const raw = stateDb(dir).query(
      `INSERT INTO launches (id, repo, action, pr, item, created_at, record)
       VALUES (?, 'o/a', 'rearm', 7, NULL, '2026-01-01T00:00:00.000Z', ?)`,
    );
    raw.run("20260101T000002Z-cccccccc", JSON.stringify(partial));
    raw.run(
      "20260101T000003Z-dddddddd",
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

describe("the marked records a report reads", () => {
  const mark = "⚙ dispatched · rearm #7 · launch 20260101T000000Z-aaaaaaaa";
  const sent: LaunchAttempt = {
    at: "2026-01-01T00:00:00.000Z",
    outcome: "sent",
    detail: "",
  };

  it("holds every marked record of the window, each with how its launch went", () => {
    const dir = root();
    writeRecord(
      record("20260101T000000Z-aaaaaaaa", { mark, attempts: [sent] }),
      dir,
    );
    // Claimed by its wrapper, though the tick never saved the launch's answer.
    writeRecord(record("20260101T000001Z-bbbbbbbb", { mark }), dir);
    expect(claimRecord("20260101T000001Z-bbbbbbbb", WHO, dir)).toBe(true);
    writeRecord(
      record("20260101T000002Z-cccccccc", {
        mark,
        attempts: [{ ...sent, outcome: "lost" }],
      }),
      dir,
    );
    writeRecord(
      record("20260101T000003Z-dddddddd", {
        mark,
        attempts: [{ ...sent, outcome: "failed" }],
      }),
      dir,
    );
    // Ended before any launch, as a follow-up whose marker could not be given back.
    writeRecord(record("20260101T000004Z-eeeeeeee", { mark }), dir);
    recordExit(
      "20260101T000004Z-eeeeeeee",
      { at: "2026-01-01T00:00:00.000Z", code: null, signal: null },
      dir,
    );
    // Outside the window, and written before records kept the mark.
    writeRecord(
      record("20250101T000000Z-ffffffff", {
        mark,
        attempts: [sent],
        createdAt: "2025-01-01T00:00:00.000Z",
      }),
      dir,
    );
    writeRecord(
      record("20260101T000005Z-abababab", { mark: null, attempts: [sent] }),
      dir,
    );
    const { records, unreadable } = markedSince(
      Date.parse("2026-01-01T00:00:00.000Z"),
      dir,
    );
    expect(unreadable).toEqual([]);
    expect(records.map((r) => [r.record.id, r.launch])).toEqual([
      ["20260101T000000Z-aaaaaaaa", "started"],
      ["20260101T000001Z-bbbbbbbb", "started"],
      ["20260101T000002Z-cccccccc", "lost"],
      ["20260101T000003Z-dddddddd", "not started"],
      ["20260101T000004Z-eeeeeeee", "not started"],
    ]);
  });

  it("lists a launch by the night it was recorded, not by when it was replayed", () => {
    const dir = root();
    writeRecord(
      record("20251231T000000Z-99999999", {
        mark,
        createdAt: "2025-12-31T00:00:00.000Z",
        attempts: [
          { ...sent, at: "2025-12-31T00:00:01.000Z", outcome: "lost" },
          { ...sent, at: "2026-01-01T00:00:05.000Z" },
        ],
      }),
      dir,
    );
    const { records } = markedSince(
      Date.parse("2026-01-01T00:00:00.000Z"),
      dir,
    );
    expect(records).toEqual([]);
    const night = markedSince(Date.parse("2025-12-31T00:00:00.000Z"), dir);
    expect(night.records.map((r) => [r.record.id, r.launch])).toEqual([
      ["20251231T000000Z-99999999", "started"],
    ]);
  });

  it("does not take a claim that does not read as proof of a launch, and names it", () => {
    const dir = root();
    writeRecord(record("20260101T000000Z-aaaaaaaa", { mark }), dir);
    stateDb(dir)
      .query("UPDATE launches SET claim = '{}' WHERE id = ?")
      .run("20260101T000000Z-aaaaaaaa");
    const { records, unreadable } = markedSince(
      Date.parse("2026-01-01T00:00:00.000Z"),
      dir,
    );
    expect(records.map((r) => [r.record.id, r.launch])).toEqual([
      ["20260101T000000Z-aaaaaaaa", "not started"],
    ]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain("claim of launch record");
  });
});
