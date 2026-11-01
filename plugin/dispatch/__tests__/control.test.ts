/**
 * Control's parts on their own: the outcome log's file rules and its
 * classifier, the dashboard's address check, and the screen check before a
 * nudge is typed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { parseListen } from "../lib/listen.ts";
import {
  appendRow,
  classifyEnded,
  type EndedRow,
  type OutcomeClass,
  logFile,
  readRows,
} from "../lib/log.ts";
import {
  MachineConfigError,
  readMachineConfig,
} from "../lib/machine-config.ts";
import { screenNotReady } from "../lib/runtime/orca-steer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-control-"));
  dirs.push(dir);
  return dir;
}

function row(key: string, at = "2026-11-01T10:00:00.000Z"): EndedRow {
  return {
    kind: "ended",
    key,
    at,
    repo: "o/a",
    stage: "rearm",
    target: "PR #7",
    record: key,
    account: "a",
    model: null,
    durationMs: 1,
    rounds: null,
    class: "converged",
    reason: "exit 0 (converged)",
  };
}

describe("the outcome log's file", () => {
  it("writes a row once, cuts a torn last line, and keeps an unterminated one that parses", () => {
    const dir = root();
    expect(appendRow(row("one"), dir)).toBe(true);
    expect(appendRow(row("one"), dir)).toBe(false);
    const file = logFile("2026-11-01T10:00:00.000Z", dir);
    appendFileSync(file, '{"kind":"ended","key":"tor');
    expect(appendRow(row("two"), dir)).toBe(true);
    appendFileSync(file, JSON.stringify(row("three")));
    expect(appendRow(row("four"), dir)).toBe(true);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(readRows(undefined, undefined, dir).map((r) => r.key)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("cuts a torn last line longer than any window, and finds a key far back in the file", () => {
    const dir = root();
    appendRow(row("first"), dir);
    const file = logFile("2026-11-01T10:00:00.000Z", dir);
    appendFileSync(file, `${"x".repeat(600 * 1024)}`);
    expect(appendRow(row("after"), dir)).toBe(true);
    for (let i = 0; i < 3000; i++) appendRow(row(`filler-${i}`), dir);
    expect(appendRow(row("first"), dir)).toBe(false);
    const keys = readRows(undefined, undefined, dir).map((r) => r.key);
    expect(keys.slice(0, 2)).toEqual(["first", "after"]);
    expect(keys.filter((k) => k === "first")).toHaveLength(1);
  });

  it("puts a row in the file of its month, and a reader skips a line that is not a row", () => {
    const dir = root();
    appendRow(row("oct", "2026-10-31T23:59:59.000Z"), dir);
    appendRow(row("nov", "2026-11-01T00:00:00.000Z"), dir);
    expect(logFile("2026-10-31T23:59:59.000Z", dir)).toEndWith(
      "log-2026-10.jsonl",
    );
    appendFileSync(logFile("2026-11-01T00:00:00.000Z", dir), "not a row\n{}\n");
    expect(
      readRows(Date.parse("2026-11-01T00:00:00.000Z"), Infinity, dir).map(
        (r) => r.key,
      ),
    ).toEqual(["nov"]);
  });
});

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id: "20261101T000000Z-aaaaaaaa",
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
    facts: "",
    createdAt: "2026-11-01T00:00:00.000Z",
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

const AT = "2026-11-01T01:00:00.000Z";
const NONE = { takenOver: false, merged: null };

function exited(
  code: number | null,
  over: Partial<LaunchRecord> = {},
): ReadRecord {
  return {
    record: record(over),
    state: {
      kind: "ended",
      exit: { at: AT, code, signal: code === null ? "SIGKILL" : null },
      process: null,
    },
    result: null,
  };
}

describe("the outcome classifier", () => {
  it("places each drive exit in its class, first match in table order", () => {
    const cases: Array<[number | null, OutcomeClass]> = [
      [0, "converged"],
      [16, "quota wall"],
      [8, "parked for a person"],
      [14, "stalled"],
      [6, "stalled"],
      [11, "refused"],
      [18, "refused"],
      [1, "gates failed"],
      [12, "gates failed"],
      [99, "unknown"],
      [null, "died"],
    ];
    for (const [code, cls] of cases)
      expect([code, classifyEnded(exited(code), AT, NONE).class]).toEqual([
        code,
        cls,
      ]);
    expect(
      classifyEnded(exited(5), AT, { takenOver: false, merged: true }).class,
    ).toBe("merged");
    expect(
      classifyEnded(exited(5), AT, { takenOver: false, merged: false }).class,
    ).toBe("refused");
    expect(classifyEnded(exited(5), AT, NONE)).toEqual({
      class: "unknown",
      reason:
        "exit 5, and whether the pull request merged or closed could not be read",
    });
    expect(
      classifyEnded(exited(20), AT, { takenOver: true, merged: null }),
    ).toEqual({
      class: "stalled",
      reason: "taken over (exit 20)",
    });
  });

  it("classes an interactive session by its result, else by the wall it still waited on", () => {
    const pickup = { action: "pickup" as const, pr: null, item: "#12" };
    const done = { ...exited(0, pickup), result: "done" as const };
    expect(classifyEnded(done, AT, NONE).class).toBe("converged");
    const failed = { ...exited(0, pickup), result: "failed" as const };
    expect(classifyEnded(failed, AT, NONE).class).toBe("gates failed");
    const episode = {
      observedAt: "2026-11-01T00:30:00.000Z",
      evidence: "You've hit your session limit",
      last: true,
      readAt: AT,
    };
    const walled = exited(0, {
      ...pickup,
      episodes: [{ ...episode, resetAt: "2026-11-01T03:00:00.000Z" }],
    });
    expect(classifyEnded(walled, AT, NONE).class).toBe("quota wall");
    const reopened = exited(0, {
      ...pickup,
      episodes: [{ ...episode, resetAt: "2026-11-01T00:45:00.000Z" }],
    });
    expect(classifyEnded(reopened, AT, NONE)).toEqual({
      class: "died",
      reason: "no result recorded; its session exited 0",
    });
  });
});

describe("the dashboard's address", () => {
  it("takes an address in the private or loopback ranges, and refuses any other", () => {
    expect(parseListen("127.0.0.1")).toEqual({ host: "127.0.0.1", port: null });
    expect(parseListen("100.101.12.3:8765")).toEqual({
      host: "100.101.12.3",
      port: 8765,
    });
    expect(parseListen("[fd7a:115c::1]:80")).toEqual({
      host: "fd7a:115c::1",
      port: 80,
    });
    expect(() => parseListen("8.8.8.8:80")).toThrow("outside the private");
    expect(() => parseListen("0.0.0.0")).toThrow("outside the private");
    expect(() => parseListen("host.example:80")).toThrow("names no IP address");
  });

  it("refuses a machine file whose dashboard.listen is public", () => {
    const file = join(root(), "dispatch.yaml");
    writeFileSync(file, "dashboard:\n  listen: 203.0.113.9:8765\n");
    expect(() => readMachineConfig(file)).toThrow(MachineConfigError);
    writeFileSync(file, "dashboard:\n  listen: 192.168.1.20:8765\n");
    expect(readMachineConfig(file)?.dashboardListen).toEqual({
      host: "192.168.1.20",
      port: 8765,
    });
  });
});

describe("the screen check before a nudge", () => {
  it("passes only an empty input line with no menu or question on screen", () => {
    const rule = "──────────────";
    expect(
      screenNotReady(["limit reached", rule, "> ", rule, "  ? for shortcuts"]),
    ).toBeNull();
    expect(screenNotReady(["╭────╮", "│ >  │", "╰────╯"])).toBeNull();
    expect(
      screenNotReady([
        "╭────╮",
        "│ >  │",
        "│ delete the old records │",
        "╰────╯",
      ]),
    ).toBe("the input box holds text below its first line");
    expect(screenNotReady([rule, "> ", "  delete the old records", rule])).toBe(
      "the input box holds text below its first line",
    );
    expect(screenNotReady([rule, "> ", "", rule])).toBeNull();
    expect(screenNotReady([rule, "> continue please", rule])).toBe(
      "the input line holds text",
    );
    expect(
      screenNotReady([
        "What do you want to do?",
        "❯ 1. Stop and wait",
        "  2. Upgrade",
      ]),
    ).toBe("a menu or a question is on the screen");
    expect(screenNotReady(["$ "])).toBe("the screen shows no input prompt");
  });
});
