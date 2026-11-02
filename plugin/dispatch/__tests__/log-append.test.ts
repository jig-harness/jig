import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, type LogRow } from "../lib/log.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function row(key: string, reason = "r"): LogRow {
  return {
    kind: "event",
    key,
    at: "2026-01-02T03:04:05.000Z",
    repo: "o/r",
    stage: "steer",
    target: "t",
    event: "nudge",
    account: null,
    class: null,
    reason,
  };
}

describe("appending a row to the outcome log", () => {
  it("writes a key once, however large the file is, and finds a key past a chunk boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-log-"));
    roots.push(root);
    expect(appendRow(row("first", "é".repeat(2_000)), root)).toBe(true);
    for (let i = 0; i < 40; i++)
      appendRow(row(`k${i}`, "x".repeat(40_000)), root);
    expect(appendRow(row("first"), root)).toBe(false);
    expect(appendRow(row("k39"), root)).toBe(false);
    expect(appendRow(row("k40"), root)).toBe(true);
    const file = join(root, "log-2026-01.jsonl");
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(
      42,
    );
  });

  it("propagates a failure to read instead of treating the key as absent", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-log-"));
    roots.push(root);
    writeFileSync(join(root, "log-2026-01.jsonl"), "");
    // A directory where the month file should be cannot be opened for append.
    rmSync(join(root, "log-2026-01.jsonl"));
    mkdirSync(join(root, "log-2026-01.jsonl"));
    expect(() => appendRow(row("a"), root)).toThrow();
  });
});
