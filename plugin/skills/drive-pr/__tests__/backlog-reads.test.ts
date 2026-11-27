/**
 * drive-pr suite: when a bullet reads a backlog entry's recorded comment.
 */
import { describe, expect, it } from "bun:test";
import {
  type BacklogEntry,
  renderedNotBlocking,
} from "../scripts/lib/backlog.ts";

const entry = (comment: string): BacklogEntry => ({
  fingerprint: "f1",
  path: "a.ts",
  line: 3,
  severity: "medium",
  dimension: "x",
  category: "correctness",
  comment,
});
const bullet = (text: string) => ({ path: "a.ts", line: 3, text });
const run = (comment: string, rendered: string, fresh: string[] = []) =>
  renderedNotBlocking(
    [entry(comment)],
    [entry(comment)],
    [bullet(rendered)],
    new Set(),
    fresh.map(bullet),
  );

describe("reads", () => {
  it("matches a header followed by the recorded comment", () => {
    expect(
      run("Fix it", "🟡 **medium** · 🏷️ category: correctness — Fix it"),
    ).toEqual(["f1"]);
  });
  it("matches a full comment against an abbreviated record", () => {
    const full = "A long comment that goes on";
    expect(
      run(
        "A long comment…",
        `🟡 **medium** · 🏷️ category: correctness — ${full}`,
      ),
    ).toEqual(["f1"]);
    // a fresh bullet carrying the full text raises the entry again
    expect(
      run("A long comment…", "🟡 **medium** — A long comment", [
        `🟡 **medium** — ${full}`,
      ]),
    ).toEqual([]);
  });
  it("rejects prose between the bold word and the separator", () => {
    expect(run("tail", "🟡 **medium** unrelated finding — tail")).toEqual([]);
  });
});
