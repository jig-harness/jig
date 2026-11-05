/**
 * Control's parts on their own: the outcome log's table and its text copy,
 * its classifier, the dashboard's address check, and the screen check before a
 * nudge is typed.
 */
import { closeStateDb } from "../lib/state.ts";
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
import { exportLog } from "../lib/log-export.ts";
import {
  writeRow,
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
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
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

describe("the outcome log's table", () => {
  it("writes a row once, by its key, and reads rows by their time", () => {
    const dir = root();
    expect(writeRow(row("one"), dir)).toBe(true);
    expect(writeRow(row("one"), dir)).toBe(false);
    expect(writeRow(row("oct", "2026-10-31T23:59:59.000Z"), dir)).toBe(true);
    expect(readRows(undefined, undefined, dir).map((r) => r.key)).toEqual([
      "one",
      "oct",
    ]);
    expect(
      readRows(Date.parse("2026-11-01T00:00:00.000Z"), Infinity, dir).map(
        (r) => r.key,
      ),
    ).toEqual(["one"]);
  });

  it("copies each row into the file of its month once, keeping the lines a file already held", () => {
    const dir = root();
    writeRow(row("oct", "2026-10-31T23:59:59.000Z"), dir);
    writeRow(row("nov", "2026-11-01T00:00:00.000Z"), dir);
    expect(exportLog(dir)).toBe(2);
    const october = logFile("2026-10-31T23:59:59.000Z", dir);
    expect(october).toEndWith("log-2026-10.jsonl");
    const november = logFile("2026-11-01T00:00:00.000Z", dir);
    expect(readFileSync(october, "utf8")).toBe(
      `${JSON.stringify(row("oct", "2026-10-31T23:59:59.000Z"))}\n`,
    );
    // A line the copy already holds (one from before the database, or not a row) stays as it is.
    appendFileSync(november, "not a row\n{}");
    writeRow(row("later", "2026-11-02T00:00:00.000Z"), dir);
    expect(exportLog(dir)).toBe(1);
    expect(exportLog(dir)).toBe(0);
    expect(readFileSync(november, "utf8").split("\n")).toEqual([
      JSON.stringify(row("nov", "2026-11-01T00:00:00.000Z")),
      "not a row",
      "{}",
      JSON.stringify(row("later", "2026-11-02T00:00:00.000Z")),
      "",
    ]);
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
      [9, "gates failed"],
      [12, "gates failed"],
      [99, "unknown"],
      [null, "died"],
    ];
    for (const [code, cls] of cases)
      expect([code, classifyEnded(exited(code), AT, NONE).class]).toEqual([
        code,
        cls,
      ]);
    // The reason is what tells a conflict from the rest of its class.
    expect(classifyEnded(exited(9), AT, NONE).reason).toBe(
      "exit 9 (conflicting with its base)",
    );
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
    // A draft line shaped like a rule is still the draft, bordered or not.
    expect(
      screenNotReady([
        "╭────╮",
        "│ >  │",
        "│ --- │",
        "│ delete the old records │",
        "╰────╯",
      ]),
    ).toBe("the input box holds text below its first line");
    expect(
      screenNotReady([rule, "> ", "---", "  delete the old records", rule]),
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
    // A draft whose first line is text and whose second is a prompt-shaped line is still a draft.
    expect(
      screenNotReady([
        "╭────╮",
        "│ > delete the old records │",
        "│ >  │",
        "╰────╯",
      ]),
    ).toBe("the input box holds text below its first line");
    // A bar-only continuation line in a box that is not wholly framed is draft text.
    expect(screenNotReady([rule, "> ", "│ │", rule])).toBe(
      "the input box holds text below its first line",
    );
    // A draft line shaped like a rule makes the boundaries ambiguous; nothing is sent.
    expect(
      screenNotReady([
        "────────",
        "> ",
        "────────",
        "  delete the old records",
        "────────",
      ]),
    ).toBe("the screen shows more than one input box boundary pair");
    // A draft that holds a rule and a prompt-shaped line cannot redefine where the box begins.
    expect(
      screenNotReady([
        "────────",
        "> delete the old records",
        "────────",
        ">",
        "────────",
      ]),
    ).toBe("the screen shows more than one input box boundary pair");
    // A boundary above the last lines is not hidden by the proximity limit.
    expect(
      screenNotReady([
        "────────",
        "> delete the old records",
        ...Array<string>(7).fill(""),
        "────────",
        ">",
        "────────",
      ]),
    ).toBe("the screen shows more than one input box boundary pair");
    // A lone vertical bar is draft text unless the line is framed at both ends.
    expect(screenNotReady([rule, "> |", rule])).toBe(
      "the input line holds text",
    );
    expect(screenNotReady([rule, "> │", rule])).toBe(
      "the input line holds text",
    );
    expect(screenNotReady(["╭────╮", "│ > │", "╰────╯"])).toBeNull();
  });
});
