/**
 * The scoreboard by release over a fixture outcome log: each release's six
 * numbers are the ones a hand count of the fixture gives, records naming no
 * release count under `null`, and an end cause new under a release names it
 * once three runs ended with it.
 */
import type { ReportCause } from "../../shared/closing-report.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  regressionsOf,
  readScoreboard,
  scoreboardOf,
} from "../lib/scoreboard.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import {
  type EndedRow,
  type EventRow,
  type LogRow,
  writeRow,
} from "../lib/log.ts";
import { closeStateDb } from "../lib/state.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-27T12:00:00.000Z");

let roots: string[] = [];
afterEach(() => {
  closeStateDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

let counter = 0;

/** An ended row; `release` is the field the records carry once the tick writes it. */
function ended(
  at: string,
  cls: EndedRow["class"],
  durationHours: number,
  more: Partial<EndedRow> & { release?: string } = {},
): LogRow {
  counter++;
  return {
    kind: "ended",
    key: `ended ${counter}`,
    at,
    repo: "example-org/web",
    stage: "rearm",
    target: `PR #${counter}`,
    record: `r-${counter}`,
    account: "a",
    model: null,
    durationMs: durationHours * HOUR,
    rounds: null,
    class: cls,
    reason: "fixture",
    ...more,
  } as LogRow;
}

function answered(at: string, waitedHours: number, release?: string): LogRow {
  counter++;
  const row: EventRow & { release?: string } = {
    kind: "event",
    key: `park ${counter}`,
    at,
    repo: "example-org/web",
    stage: "rearm",
    target: `PR #${counter}`,
    event: "park-answered",
    account: null,
    class: null,
    reason: "answered",
    durationMs: waitedHours * HOUR,
    park: {
      key: `k${counter}`,
      class: null,
      digest: null,
      parkedAt: at,
      outcome: "answered",
      form: "choose",
      recommended: true,
      note: false,
    },
    ...(release === undefined ? {} : { release }),
  };
  return row;
}

/** Two releases and the time before releases were recorded, with their numbers counted by hand in the test. */
function fixture(): LogRow[] {
  return [
    // No release named.
    ended("2026-11-21T11:00:00.000Z", "converged", 1, { rounds: 1 }),
    // 0.1.0
    ended("2026-11-22T10:00:00.000Z", "merged", 2, {
      rounds: 3,
      release: "0.1.0",
    }),
    ended("2026-11-22T15:00:00.000Z", "merged", 1, {
      rounds: 5,
      release: "0.1.0",
    }),
    ended("2026-11-23T12:00:00.000Z", "stalled", 3, {
      rounds: 8,
      release: "0.1.0",
    }),
    answered("2026-11-23T13:00:00.000Z", 1, "0.1.0"),
    answered("2026-11-23T14:00:00.000Z", 3, "0.1.0"),
    // 0.2.0
    ended("2026-11-26T09:00:00.000Z", "converged", 1, {
      rounds: 2,
      release: "0.2.0",
    }),
    ended("2026-11-26T10:00:00.000Z", "merged", 0.5, {
      rounds: 4,
      release: "0.2.0",
    }),
    ended("2026-11-26T11:00:00.000Z", "died", 0.5, { release: "0.2.0" }),
    answered("2026-11-26T12:00:00.000Z", 5, "0.2.0"),
  ];
}

describe("the scoreboard by release", () => {
  it("gives the numbers a hand count of the fixture log gives, a row per release, the newest first", () => {
    const board = scoreboardOf(fixture(), "7d", NOW - 7 * DAY, NOW, 2);
    expect(board.rows.map((r) => r.release)).toEqual(["0.2.0", "0.1.0", null]);
    const [second, first, before] = board.rows;
    expect(second).toMatchObject({
      runs: 3,
      merged: 1,
      answers: 1,
      answersPerMerge: 1,
      medianNeedAgeMs: 5 * HOUR,
      sessionHoursNotConverged: 0.5,
      medianRounds: 3,
      // 2 slots over Nov 26 08:00 to Nov 27 12:00 (28 h), 2 h held.
      idleSlotHours: 54,
    });
    expect(first).toMatchObject({
      runs: 3,
      merged: 2,
      answers: 2,
      answersPerMerge: 1,
      medianNeedAgeMs: 2 * HOUR,
      sessionHoursNotConverged: 3,
      medianRounds: 4,
      // 2 slots over Nov 22 08:00 to Nov 26 08:00 (96 h), 6 h held.
      idleSlotHours: 186,
    });
    expect(before).toMatchObject({
      release: null,
      runs: 1,
      merged: 0,
      answers: 0,
      answersPerMerge: null,
      medianNeedAgeMs: null,
      sessionHoursNotConverged: 0,
      medianRounds: 1,
      // 2 slots over Nov 21 10:00 to Nov 22 08:00 (22 h), 1 h held.
      idleSlotHours: 43,
    });
  });
});

describe("the scoreboard read from a state directory", () => {
  it("leaves the idle slot-hours unknown when no line has been written, and leaves a run outside the window out", () => {
    const rows = [
      ...fixture(),
      ended("2026-11-10T11:00:00.000Z", "merged", 1, { release: "0.0.1" }),
    ];
    const board = scoreboardOf(rows, "7d", NOW - 7 * DAY, NOW, null);
    expect(board.rows.map((r) => r.release)).not.toContain("0.0.1");
    expect(board.rows.every((r) => r.idleSlotHours === null)).toBe(true);
  });

  it("reads the log, the line's slots and the window from a state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "scoreboard-"));
    roots.push(root);
    for (const row of fixture()) writeRow(row, root);
    const line = {
      accounts: [{ cap: 1 }, { cap: 1 }],
    } as unknown as LineSnapshot;
    const board = readScoreboard(new URLSearchParams(), NOW, root, line);
    expect(board.window).toBe("7d");
    expect(board.slots).toBe(2);
    expect(board.rows.map((r) => [r.release, r.merged])).toEqual([
      ["0.2.0", 1],
      ["0.1.0", 2],
      [null, 0],
    ]);
    const month = readScoreboard(
      new URLSearchParams("window=30d"),
      NOW,
      root,
      null,
    );
    expect(month.window).toBe("30d");
    expect(month.slots).toBeNull();
    expect(
      readScoreboard(new URLSearchParams(), NOW, join(root, "none"), null).rows,
    ).toEqual([]);
  });
});

describe("a cause new under a release", () => {
  const failing = (
    at: string,
    release: string | undefined,
    cause = "tool-failed",
  ) =>
    ended(at, "refused", 0.1, {
      cause: cause as ReportCause,
      ...(release === undefined ? {} : { release }),
    });

  it("names the release once it has three runs of a cause absent for 14 days", () => {
    const rows = [
      failing("2026-11-01T00:00:00.000Z", "0.1.0", "environment"),
      failing("2026-11-26T01:00:00.000Z", "0.2.0"),
      failing("2026-11-26T02:00:00.000Z", "0.2.0"),
      failing("2026-11-26T03:00:00.000Z", "0.2.0"),
    ];
    expect(regressionsOf(rows, NOW, NOW - 7 * DAY)).toEqual([
      {
        release: "0.2.0",
        cause: "tool-failed",
        runs: 3,
        firstAt: "2026-11-26T01:00:00.000Z",
      },
    ]);
    const board = scoreboardOf(rows, "7d", NOW - 7 * DAY, NOW, null);
    expect(board.regressions.map((r) => r.release)).toEqual(["0.2.0"]);
  });

  it("names none for a cause that was already under the release before the window began", () => {
    const rows = [
      failing("2026-11-08T01:00:00.000Z", "0.1.0"),
      failing("2026-11-15T01:00:00.000Z", "0.1.0"),
      failing("2026-11-25T01:00:00.000Z", "0.1.0"),
    ];
    expect(regressionsOf(rows, NOW, NOW - 7 * DAY)).toEqual([]);
  });

  it("names none for two runs, for a cause seen in the 14 days before, or for runs that name no release", () => {
    const two = [
      failing("2026-11-26T01:00:00.000Z", "0.2.0"),
      failing("2026-11-26T02:00:00.000Z", "0.2.0"),
    ];
    expect(regressionsOf(two, NOW, NOW - 7 * DAY)).toEqual([]);
    const seen = [
      failing("2026-11-20T00:00:00.000Z", "0.1.0"),
      ...two,
      failing("2026-11-26T03:00:00.000Z", "0.2.0"),
    ];
    expect(regressionsOf(seen, NOW, NOW - 7 * DAY)).toEqual([]);
    const unnamed = [
      failing("2026-11-26T01:00:00.000Z", undefined),
      failing("2026-11-26T02:00:00.000Z", undefined),
      failing("2026-11-26T03:00:00.000Z", undefined),
    ];
    expect(regressionsOf(unnamed, NOW, NOW - 7 * DAY)).toEqual([]);
  });
});
