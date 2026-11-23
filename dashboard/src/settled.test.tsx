import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineSettled } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { SettledRecently } from "./settled.tsx";
import {
  byWords,
  historyQuery,
  outcomeWords,
  settledIn,
  settledToggle,
} from "./settled-view.ts";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const clock = { nowMs: NOW, timeZone: "UTC" };

function entry(fields: Partial<LineSettled> = {}): LineSettled {
  return {
    repo: "example-org/web",
    targets: ["PR #7"],
    cause: "parked",
    title: "Cache the thing",
    url: "https://forge.example/pull/7",
    question: "Keep the cache or drop it?",
    at: "2026-11-23T11:00:00.000Z",
    outcome: "left",
    by: "person",
    who: "maintainer-a",
    via: "a comment on the pull request",
    option: "Keep the cache",
    recommended: true,
    how: "@maintainer-a chose Keep the cache",
    answer: "https://forge.example/pull/7#c1",
    ...fields,
  };
}

describe("the settled list", () => {
  it("keeps what left in the last day, newest first", () => {
    const old = entry({ at: "2026-11-22T11:59:00.000Z" });
    const a = entry({ at: "2026-11-23T10:00:00.000Z" });
    const b = entry({ at: "2026-11-23T11:30:00.000Z" });
    expect(settledIn([old, a, b], clock)).toEqual([b, a]);
    expect(settledIn(undefined, clock)).toEqual([]);
  });

  it("folds to one line with the count, and names who settled each entry", () => {
    expect(settledToggle(12, false)).toBe(
      "12 settled in the last 24 hours · show",
    );
    expect(byWords(entry())).toBe(
      "maintainer-a (a comment on the pull request)",
    );
    expect(byWords(entry({ by: "tick", who: "pickup rule", via: null }))).toBe(
      "the tick (pickup rule)",
    );
    expect(
      byWords(entry({ by: "steward", who: "steward record #4", via: null })),
    ).toBe("the steward (steward record #4)");
    expect(byWords(entry({ by: "facts", who: null, via: null }))).toBe(
      "no one: its facts changed",
    );
    expect(outcomeWords(entry({ outcome: "refused" }))).toContain(
      "card still open",
    );
  });

  it("links an entry to the History rows of its target, keeping the token", () => {
    const q = historyQuery(
      "?token=t&view=needs&from=2026-01-01&class=scope",
      entry(),
      "PR #7",
    );
    const found = new URLSearchParams(q);
    expect(found.get("token")).toBe("t");
    expect(found.get("view")).toBe("history");
    expect(found.get("repo")).toBe("example-org/web");
    expect(found.get("target")).toBe("PR #7");
    expect(found.get("from")).toBeNull();
    expect(found.get("class")).toBeNull();
    expect(found.get("window")).toBe("7d");
  });
});

describe("Settled recently", () => {
  const render = (settled: LineSettled[] | undefined, open = false) =>
    renderToStaticMarkup(
      createElement(SettledRecently, {
        line: settled === undefined ? {} : { settled },
        clock,
        open,
      }),
    );

  it("renders nothing when nothing settled", () => {
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("is folded to its count, with the entries hidden", () => {
    const html = render([entry(), entry({ targets: ["PR #8"] })]);
    expect(html).toContain("2 settled in the last 24 hours · show");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<ul[^>]* hidden/);
  });

  it("lists, when open, the target, when, who, the option and how, with its History link", () => {
    const html = render(
      [
        entry({ targets: ["PR #7", "PR #8"] }),
        entry({
          outcome: "refused",
          targets: ["ENG-4"],
          by: "person",
          how: "chose Release, refused: the item is claimed; its card stays open",
          at: "2026-11-23T11:50:00.000Z",
        }),
      ],
      true,
    );
    expect(html).toContain("PR #7, PR #8");
    expect(html).toContain("1 h ago");
    expect(html).toContain("maintainer-a");
    expect(html).toContain("chose Keep the cache");
    expect(html).toContain("Refused, card still open");
    expect(html).toContain("the item is claimed");
    expect(html).toContain("History rows");
    expect(html).not.toMatch(/<ul[^>]* hidden/);
  });
});
