import { describe, expect, it } from "bun:test";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import {
  DISMISSED_KEPT,
  flashOf,
  keepDismissed,
  mergeCount,
  mergeLanes,
  mergeNowCount,
  mergeNowKeys,
} from "./merge-view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

describe("the Merge view's lanes", () => {
  it("puts merge now first, then approve first and update next", () => {
    const lanes = mergeLanes(lineOf("merge"), NOW);
    expect(lanes.map((l) => l.title)).toEqual([
      "Merge now",
      "Approve first",
      "Update next",
    ]);
    expect(lanes[0]?.cards.map((c) => c.target)).toEqual([
      "PR #461",
      "PR #1199",
    ]);
  });

  it("copies the pinned merge command in merge now, and the jig ask line elsewhere", () => {
    const [now, approve] = mergeLanes(lineOf("merge"), NOW);
    expect(now?.cards[0]?.command).toBe(
      "gh pr merge 461 --repo example-org/web --match-head-commit 3f2a91c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9 --squash",
    );
    expect(now?.cards[0]?.merges).toBe(true);
    expect(approve?.cards[0]?.command).toBe(
      "jig ask drive@example-org/api#1201",
    );
    expect(approve?.cards[0]?.act).toBe("approve");
  });

  it("leaves out a lane with nothing in it, and counts what Ready to merge holds", () => {
    const line = lineOf("loud");
    expect(mergeLanes(line, NOW).map((l) => l.lane)).toEqual([
      "approve-first",
      "update-next",
    ]);
    expect(mergeCount(line)).toBe(2);
    expect(mergeNowCount(line)).toBe(0);
    expect(mergeCount(lineOf("merge"))).toBe(4);
    expect(mergeNowCount(lineOf("merge"))).toBe(2);
    expect(mergeLanes(null, NOW)).toEqual([]);
  });
});

describe("the merge flash", () => {
  it("names every pull request in merge now", () => {
    expect(flashOf(lineOf("merge"), new Set())?.text).toBe(
      "2 pull requests are safe to merge: #461, #1199",
    );
  });

  it("is absent while merge now holds nothing", () => {
    expect(flashOf(lineOf("loud"), new Set())).toBeNull();
    expect(flashOf(null, new Set())).toBeNull();
  });

  it("stays hidden once dismissed, until a pull request reaches merge now at a new head", () => {
    const line = lineOf("merge");
    const dismissed = new Set(mergeNowKeys(line));
    expect(flashOf(line, dismissed)).toBeNull();
    const moved: LineSnapshot = {
      ...line,
      ready: (line.ready ?? []).map((r) =>
        r.pr === 1199 ? { ...r, head: "0000000aaaa" } : r,
      ),
    };
    expect(flashOf(moved, dismissed)?.text).toContain("#1199");
  });
});

describe("the dismissed set's bound", () => {
  it("keeps the newest earlier heads that still fit beside the current ones", () => {
    const old = Array.from({ length: DISMISSED_KEPT }, (_, i) => `old${i}`);
    const kept = [...keepDismissed(new Set(old), ["a", "b"])];
    expect(kept.length).toBe(DISMISSED_KEPT);
    expect(kept).toContain("a");
    expect(kept).not.toContain("old0");
    expect(kept).toContain(`old${DISMISSED_KEPT - 1}`);
  });

  it("keeps every current head and no earlier one when they fill the bound", () => {
    const current = Array.from(
      { length: DISMISSED_KEPT + 5 },
      (_, i) => `c${i}`,
    );
    const kept = keepDismissed(new Set(["old"]), current);
    expect(kept.size).toBe(DISMISSED_KEPT + 5);
    expect(kept.has("old")).toBe(false);
  });
});
