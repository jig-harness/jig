import { describe, expect, it } from "bun:test";
import type { RowsAnswer } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { EndedRow, EventRow } from "../../plugin/dispatch/lib/log.ts";
import { fixture } from "../fixtures.ts";
import { forgesOf } from "./links.ts";
import {
  activeFilters,
  classChips,
  metaLine,
  optionsWith,
  recurringView,
  type RowClock,
  rowView,
  windowText,
} from "./log-view.ts";
import { readFilter } from "./search.ts";
import { ROLES } from "./status.ts";

const ROW_CLOCK: RowClock = { today: "2026-11-03", timeZone: "UTC" };
const NO_FORGES = forgesOf(null);

const ENDED: EndedRow = {
  kind: "ended",
  key: "ended r1",
  at: "2026-11-03T07:22:00.000Z",
  repo: "example-org/api",
  stage: "rearm",
  target: "PR #1205",
  record: "r1",
  account: "work-a",
  model: null,
  durationMs: 74 * 60_000,
  rounds: 4,
  class: "converged",
  reason: "exit 0 (converged)",
};

const EVENT: EventRow = {
  kind: "event",
  key: "event e1",
  at: "2026-11-02T22:40:00.000Z",
  repo: "example-org/infra",
  stage: "hold",
  target: "PR #91",
  event: "hold end",
  account: null,
  class: null,
  reason: "held: serialized behind #90 in migrations",
  durationMs: 40 * 60_000,
};

const ANSWER: RowsAnswer = {
  window: "today",
  from: "2026-11-03T00:00:00.000Z",
  to: "2026-11-03T16:47:30.000Z",
  counts: {},
  total: 0,
  rows: [],
  truncated: false,
  options: {
    repo: [],
    stage: [],
    account: [],
    class: ["converged", "merged", "quota wall", "stalled"],
  },
  recurring: [],
  logHasRows: true,
};

describe("a row that ended", () => {
  const view = rowView(ENDED, ROW_CLOCK, NO_FORGES);

  it("shows its class by its own name, with its role's mark", () => {
    expect(view.label).toBe("converged");
    expect(view.role).toBe(ROLES.well);
  });

  it("states its time, length and rounds", () => {
    expect(view.time).toBe("07:22");
    expect(view.length).toBe("1 h 14 min, 4 rounds");
    expect(view.mark).toBe("↻");
  });

  it("has the record among its evidence", () => {
    expect(view.evidence).toEqual([
      { k: "duration", v: "1 h 14 min" },
      { k: "rounds", v: "4" },
      { k: "record", v: "r1", copy: "r1" },
    ]);
  });

  it("says one round in the singular", () => {
    expect(rowView({ ...ENDED, rounds: 1 }, ROW_CLOCK, NO_FORGES).length).toBe(
      "1 h 14 min, 1 round",
    );
  });

  it("leaves out a length the record does not hold", () => {
    expect(
      rowView(
        { ...ENDED, durationMs: null, rounds: null },
        ROW_CLOCK,
        NO_FORGES,
      ).length,
    ).toBe("");
  });
});

describe("an observation", () => {
  const view = rowView(EVENT, ROW_CLOCK, NO_FORGES);

  it("reads as an event when no class names it", () => {
    expect(view.label).toBe("event: hold end");
    expect(view.role).toBe(ROLES.held);
    expect(view.account).toBe("");
  });

  it("says how long a hold waited", () => {
    expect(view.length).toBe("waited 40 min");
    expect(view.evidence).toEqual([{ k: "event", v: "hold end" }]);
  });

  it("names the day of a time that is not today", () => {
    expect(view.time).toBe("Nov 2 22:40");
  });

  it("takes the class when one names it", () => {
    const parked = rowView(
      { ...EVENT, class: "parked for a person" },
      ROW_CLOCK,
      NO_FORGES,
    );
    expect(parked.label).toBe("parked for a person");
    expect(parked.role).toBe(ROLES.needs);
  });
});

describe("a row's link", () => {
  const line = fixture("loud").line;
  const forges = forgesOf(line);

  it("comes from the links the line holds for that repository", () => {
    expect(forges.pulls.get("example-org/api")).toBe("https://forge.example/");
    expect(rowView(ENDED, ROW_CLOCK, forges).url).toBe(
      "https://forge.example/example-org/api/pull/1205",
    );
  });

  it("takes the one forge the line shows for a repository it does not name", () => {
    const view = rowView(
      { ...ENDED, repo: "example-org/other" },
      ROW_CLOCK,
      forges,
    );
    expect(view.url).toBe("https://forge.example/example-org/other/pull/1205");
  });

  it("is left out when the line shows two forges and names neither for it", () => {
    const two = {
      ...NO_FORGES,
      pulls: new Map([
        ["a/b", "https://one.example/"],
        ["c/d", "https://two.example/"],
      ]),
    };
    const view = rowView({ ...ENDED, repo: "e/f" }, ROW_CLOCK, two);
    expect(view.url).toBeNull();
    expect(view.noLink).toBeNull();
  });

  it("is the row's own link and title for an item, when the row keeps them", () => {
    const view = rowView(
      {
        ...ENDED,
        stage: "pickup",
        target: "ENG-4",
        title: "Add the audit export",
        url: "https://tracker.example/acme/issue/ENG-4/add-the-audit-export",
      },
      ROW_CLOCK,
      NO_FORGES,
    );
    expect(view.url).toBe(
      "https://tracker.example/acme/issue/ENG-4/add-the-audit-export",
    );
    expect(view.title).toBe("Add the audit export");
    expect(view.goLabel).toBe("Open ENG-4");
    expect(view.noLink).toBeNull();
  });

  it("is worked out from another item link of the repository's tracker for a row that keeps none", () => {
    const view = rowView(
      { ...ENDED, repo: "example-org/api", target: "API-91" },
      ROW_CLOCK,
      forges,
    );
    expect(view.url).toBe("https://tracker.example/API-91");
    expect(view.noLink).toBeNull();
  });

  it("takes the title the line holds for the target when the row keeps none", () => {
    const view = rowView(
      { ...ENDED, repo: "example-org/api", target: "API-77" },
      ROW_CLOCK,
      forges,
    );
    expect(view.title).toBe("Add the audit export");
  });

  it("is left out with no line, and says what is missing and where to look", () => {
    expect(forgesOf(null).items.size).toBe(0);
    const item = rowView({ ...ENDED, target: "ENG-4" }, ROW_CLOCK, NO_FORGES);
    expect(item.url).toBeNull();
    expect(item.noLink).toBe(
      "No link was recorded for ENG-4, and the line holds no other link to example-org/api's tracker to work it out from: look ENG-4 up in that tracker.",
    );
    expect(item.noLink).not.toContain("tracker base");
  });

  it("says nothing of a link for a defect, which names no target", () => {
    const defect = rowView(
      { ...EVENT, target: "", event: "defect" },
      ROW_CLOCK,
      NO_FORGES,
    );
    expect(defect.noLink).toBeNull();
  });
});

describe("the class chips", () => {
  const answer = {
    ...ANSWER,
    counts: { merged: 1, converged: 3, "event: nudge": 9, stalled: 1 },
  };

  it("count classes only, largest first, ties in the closed list's order", () => {
    expect(
      classChips(answer, "").map((c) => [c.name, c.count, c.role.word]),
    ).toEqual([
      ["converged", 3, "finished well"],
      ["merged", 1, "finished well"],
      ["stalled", 1, "finished badly"],
    ]);
  });

  it("keep the chosen class even when it counts nothing, so it can be turned off", () => {
    expect(classChips(answer, "quota wall").at(-1)).toMatchObject({
      name: "quota wall",
      count: 0,
    });
  });

  it("do not make an observation a chip by choosing it", () => {
    expect(classChips(answer, "event: nudge").map((c) => c.name)).not.toContain(
      "event: nudge",
    );
  });
});

describe("the log's line", () => {
  it("counts the rows and the window", () => {
    expect(metaLine({ ...ANSWER, total: 5 }, ROW_CLOCK)).toBe(
      "5 rows from 00:00 to 16:47",
    );
    expect(metaLine({ ...ANSWER, total: 1 }, ROW_CLOCK)).toBe(
      "1 row from 00:00 to 16:47",
    );
  });

  it("says how much of a truncated answer it shows", () => {
    expect(
      metaLine(
        {
          ...ANSWER,
          total: 6210,
          rows: Array.from({ length: 5000 }, () => ENDED),
          truncated: true,
        },
        ROW_CLOCK,
      ),
    ).toBe(
      "newest 5000 of 6210 rows: narrow the window or a filter to see the rest",
    );
  });

  it("names the day of a window's start when it is another day", () => {
    expect(
      windowText({ ...ANSWER, from: "2026-10-04T16:47:30.000Z" }, ROW_CLOCK),
    ).toBe("Oct 4 16:47 to 16:47");
  });
});

describe("a class that recurs", () => {
  const view = recurringView({
    class: "gates failed",
    repo: "example-org/web",
    stage: "rearm",
    nights: [true, false, true, true, false, true, true],
    rows: 9,
  });

  it("counts its nights and rows", () => {
    expect(view.note).toBe("5 of 7 nights, 9 rows");
    expect(view.label).toBe("5 of the last 7 nights");
    expect(view.nights.length).toBe(7);
    expect(view.role).toBe(ROLES.badly);
  });

  it("names its stage, and filters the log to that stage's rows", () => {
    expect(view.title).toBe("gates failed on example-org/web, rearm");
    expect(view.filter).toEqual({
      repo: "example-org/web",
      stage: "rearm",
      class: "gates failed",
      window: "7d",
    });
    const other = recurringView({
      class: "gates failed",
      repo: "example-org/web",
      stage: "followup",
      nights: view.nights,
      rows: 3,
    });
    expect(other.rowKey).not.toBe(view.rowKey);
  });

  it("offers a finding to copy", () => {
    expect(view.finding).toBe(
      "Recurring: gates failed on the rearm stage of example-org/web, 5 of the last 7 nights, 9 rows",
    );
  });
});

describe("the active filters", () => {
  it("name each filter, with what clears it", () => {
    const active = activeFilters(
      readFilter("?repo=example-org/web&class=gates+failed&reason=conflict"),
    );
    expect(active.map((a) => a.label)).toEqual([
      "repository example-org/web",
      "class gates failed",
      "reason contains “conflict”",
    ]);
    expect(active[1]?.clear).toEqual({ class: "" });
  });

  it("are none with nothing chosen", () => {
    expect(activeFilters(readFilter(""))).toEqual([]);
  });
});

describe("a filter's values", () => {
  it("include what is chosen even when the window holds none of it", () => {
    expect(optionsWith(["b", "c"], "a")).toEqual(["a", "b", "c"]);
    expect(optionsWith(["b", "c"], "b")).toEqual(["b", "c"]);
    expect(optionsWith(["b"], "")).toEqual(["b"]);
  });
});
