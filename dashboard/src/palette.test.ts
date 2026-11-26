import { describe, expect, it } from "bun:test";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { allCards, tabCounts } from "./cards.ts";
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

  it("includes converged PRs placed in needs-you on Needs you, not Merge", () => {
    const base = lineOf("quiet");
    const line: LineSnapshot = {
      ...base,
      needs: [],
      ready: [
        {
          repo: "example-org/web",
          pr: 509,
          url: "https://forge.example/example-org/web/pull/509",
          title: "Require signed commits",
          head: "b".repeat(40),
          place: "needs-you",
          lane: null,
          says: "the forge blocks the merge (BLOCKED) on a rule the board cannot tell: open the pull request",
          act: "open-pr",
          waitingFor: null,
          command: null,
          withheld: null,
          requested: [],
          failing: [],
          failingOmitted: 0,
          conditions: [],
          unblocks: [],
          since: "2026-11-03T15:00:00.000Z",
        },
      ],
    };
    const counts = tabCounts(line, CLOCK, null);
    expect(counts.merge).toBe(0);
    expect(counts.needs).toBe(1);
    const list = paletteEntries(allCards(line, CLOCK), counts);
    expect(matching(list, "#509")[0]?.run).toMatchObject({
      kind: "card",
      card: {
        view: "needs",
        target: "PR #509",
        command: "jig ask drive@example-org/web#509",
      },
    });
  });
});

describe("a need's answers in the palette", () => {
  it("carries what the card's Copy takes from the answers kept for it", () => {
    const needs = allCards(lineOf("merge"), CLOCK).filter(
      (c) => c.view === "needs" && c.command?.startsWith("answer ") === true,
    );
    const kept = allCards(lineOf("merge"), CLOCK, (need) => ({
      text: `answer ${need.rows[0]?.key}: go with B`,
      label: "answers",
      answers: [],
      guarded: [],
      faults: [],
      picked: 0,
      free: 1,
    })).filter((c) => c.command?.includes("go with B"));
    expect(kept.length).toBeGreaterThan(0);
    expect(needs.length).toBe(kept.length);
    expect(kept.every((c) => c.committedOnCard === false)).toBe(true);
  });

  it("copies through the card when a guarded pick or a fault holds the copy", () => {
    const held = allCards(lineOf("merge"), CLOCK, (need) => ({
      text: `answer ${need.rows[0]?.key}: choose Drop`,
      label: "answers",
      answers: [],
      guarded: [],
      faults: [{ key: need.rows[0]?.key ?? "", place: 1, fault: "too long" }],
      picked: 1,
      free: 0,
    })).filter((c) => c.view === "needs" && c.committedOnCard === true);
    expect(held.length).toBeGreaterThan(0);
  });
});
