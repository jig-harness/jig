import { describe, expect, it } from "bun:test";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { allCards } from "./cards.ts";
import { matching, paletteEntries } from "./palette.tsx";

const CLOCK = { nowMs: Date.UTC(2026, 10, 3, 16, 47, 30), timeZone: "UTC" };

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

const entries = () =>
  paletteEntries(allCards(lineOf("merge"), CLOCK), { merge: 4 });

describe("the palette", () => {
  it("lists the views first, each with its count where it has one", () => {
    const labels = entries().map((e) => e.label);
    expect(labels.slice(0, 6)).toEqual([
      "Go to Merge (4)",
      "Go to Needs you",
      "Go to Running",
      "Go to Queue",
      "Go to History",
      "Go to Help",
    ]);
  });

  it("finds a card by #N, the exact number before a longer one", () => {
    const found = matching(entries(), "#1199");
    expect(found[0]?.run).toMatchObject({
      kind: "card",
      card: { view: "merge", target: "PR #1199" },
    });
    expect(matching(entries(), "#11").length).toBeGreaterThan(1);
  });

  it("finds a card's command by every word typed", () => {
    const [first] = matching(entries(), "merge command #461");
    expect(first?.run).toMatchObject({
      kind: "copy",
      card: { target: "PR #461" },
    });
    expect(first?.label).toBe("Copy the merge command for PR #461");
  });

  it("reaches every card view's cards", () => {
    const views = new Set(
      entries().flatMap((e) =>
        e.run.kind === "card" ? [e.run.card.view] : [],
      ),
    );
    expect([...views].sort()).toEqual(["merge", "needs", "queue", "running"]);
  });

  it("keeps everything for an empty query, and nothing for one that matches none", () => {
    expect(matching(entries(), "  ")).toHaveLength(entries().length);
    expect(matching(entries(), "no-such-thing")).toEqual([]);
  });
});
