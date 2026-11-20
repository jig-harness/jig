import { describe, expect, it } from "bun:test";
import type {
  LineQueued,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import {
  queueGroups,
  queueSections,
  reasonCounts,
  refusalReason,
} from "./queue-view.ts";
import { ROLES } from "./status.ts";
import type { Clock } from "./view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

const ITEM: LineQueued = {
  source: "re-armable",
  group: "starts",
  repo: "example-org/web",
  target: "PR #7",
  pr: 7,
  item: null,
  url: "https://forge.example/example-org/web/pull/7",
  title: "Fix the thing",
  why: "stopped 16; its wall has lifted",
  stale: false,
  assignedBy: null,
  hold: null,
  launch: null,
};

describe("the queue", () => {
  it("leads with a refused launch's own detail, with the overlap beside it", () => {
    const refused: LineQueued = {
      ...ITEM,
      group: "never",
      why: "assigned to factory-bot · waits on overlap",
      launch: { outcome: "refused", detail: "the account is at its cap" },
      overlap: {
        relation: "waits on overlap",
        item: "PR #7",
        on: [],
        count: 1,
        text: "overlaps #9",
      },
    };
    const [group] = queueGroups(
      { ...lineOf("queue"), queue: [refused] },
      CLOCK,
    );
    expect(group?.items[0]?.why).toBe(
      "the account is at its cap · overlaps #9",
    );
  });

  it("is ordered by what will happen, with a heading for each", () => {
    expect(queueGroups(lineOf("queue"), CLOCK).map((g) => g.title)).toEqual([
      "Starts next",
      "Held",
      "Reported, not started",
      "Will not start",
    ]);
  });

  it("names an available account without predicting the weighted choice", () => {
    const [starts] = queueGroups(lineOf("queue"), CLOCK);
    expect(starts?.note).toBe(
      "When a tick finds a free slot. Available account: codex-b. Launch weights determine the next choice.",
    );
  });

  it("says when no account is free", () => {
    const line = lineOf("queue");
    const [starts] = queueGroups(
      {
        ...line,
        accounts: line.accounts.map((a) => ({ ...a, held: a.cap })),
      },
      CLOCK,
    );
    expect(starts?.note).toBe("No account can take a new launch; these wait.");
  });

  it("reports a wait when every account is paused even with free slots", () => {
    const line = lineOf("queue");
    const [starts] = queueGroups(
      {
        ...line,
        accounts: line.accounts.map((account) => ({
          ...account,
          held: 0,
          weight: { configured: 0, effective: 0, reason: "host-local pause" },
        })),
      },
      CLOCK,
    );
    expect(starts?.note).toBe("No account can take a new launch; these wait.");
  });

  it("lists holds longest wait first, with leader, area and wait", () => {
    const held = queueGroups(lineOf("queue"), CLOCK).find(
      (g) => g.group === "held",
    );
    expect(held?.items.map((i) => [i.target, i.wait, i.why])).toEqual([
      ["PR #1218", "waited 3 h", "held: serialized behind #1203 in migrations"],
      [
        "PR #1214",
        "waited 40 min",
        "held: serialized behind #1203 in migrations",
      ],
    ]);
  });

  it("holds a pull request behind a person's label with its own reason", () => {
    const [group] = queueGroups(
      {
        ...lineOf("quiet"),
        queue: [
          { ...ITEM, source: "held", group: "held", why: "a person held it" },
        ],
      },
      CLOCK,
    );
    expect(group?.items[0]?.why).toBe("a person held it");
    expect(group?.items[0]?.wait).toBeNull();
  });

  it("gives a reported group one sentence from the first launch that says one, and keeps it visible", () => {
    const reported = queueGroups(lineOf("queue"), CLOCK).find(
      (g) => g.group === "reported",
    );
    expect(reported?.note).toContain(
      "Waiting for a tick will not start these.",
    );
    expect(reported?.keepNote).toBe(true);
  });

  it("marks a stale drive stale, and any other held back", () => {
    const items = queueGroups(lineOf("loud"), CLOCK).flatMap((g) => g.items);
    expect(items[0]?.role).toBe(ROLES.stale);
    expect(items[1]?.role).toBe(ROLES.held);
  });

  it("carries the source as it is recorded", () => {
    const [starts] = queueGroups(lineOf("loud"), CLOCK);
    expect(starts?.items.map((i) => i.source)).toEqual([
      "re-armable",
      "label drive",
    ]);
  });

  it("says why a pickup waits on overlap, with the work it waits on, and its unknown footprint beside it", () => {
    const pickup: LineQueued = {
      ...ITEM,
      source: "assigned",
      target: "#12",
      pr: null,
      item: "#12",
      why: "assigned to factory-bot",
      overlap: {
        relation: "waits on the overlap bound",
        item: "#12",
        on: [
          {
            kind: "pull request",
            ref: "#20",
            state: "open",
            url: "https://forge.example/pull/20",
          },
          { kind: "pickup", ref: "#30", state: "claimed", url: null },
        ],
        count: 2,
        text: "waits on the overlap bound: 2 in flight already change src/a.ts (#20, #30); starts when no other work can take a slot",
      },
      footprint:
        "footprint unknown: no footprint record; derived from its area labels (dispatch)",
    };
    const line = { ...lineOf("quiet"), queue: [pickup] };
    const [item] = queueGroups(line, CLOCK).flatMap((g) => g.items);
    expect(item?.why).toBe(
      "waits on the overlap bound: 2 in flight already change src/a.ts (#20, #30); starts when no other work can take a slot · footprint unknown: no footprint record; derived from its area labels (dispatch)",
    );
    expect(item?.evidence.slice(-4)).toEqual([
      { k: "waits on the overlap bound", v: "2" },
      { k: "pull request", v: "#20 (open) https://forge.example/pull/20" },
      { k: "pickup", v: "#30 (claimed)" },
      {
        k: "footprint",
        v: "footprint unknown: no footprint record; derived from its area labels (dispatch)",
      },
    ]);
  });

  it("has no groups when nothing is queued", () => {
    expect(queueGroups(lineOf("quiet"), CLOCK)).toEqual([]);
  });

  it("says whether a target is a pull request or an item", () => {
    const items = queueGroups(lineOf("queue"), CLOCK).flatMap((g) => g.items);
    expect(items.find((i) => i.target === "PR #477")?.kind).toBe(
      "pull request",
    );
    expect(items.find((i) => i.target === "WEB-412")?.kind).toBe("item");
  });
});

/** A line whose queue is these targets, in this order. */
function groupsOf(queue: LineQueued[]) {
  return queueGroups({ ...lineOf("quiet"), queue }, CLOCK);
}

function refused(n: number, why: string, repo = "example-org/web"): LineQueued {
  return {
    ...ITEM,
    source: "assigned",
    group: "never",
    repo,
    target: `ENG-${n}`,
    pr: null,
    item: `ENG-${n}`,
    url: null,
    why,
  };
}

const CANNOT_WRITE = (n: number) =>
  `assigned to factory by contractor-${n}, who cannot write to ENG; only a person with write access starts a pickup`;

describe("the queue's sections", () => {
  const targets = (sections: ReturnType<typeof queueSections>) =>
    sections.flatMap((s) => s.items.map((i) => i.target));

  it("leads with what starts next, which alone never folds", () => {
    const sections = queueSections(
      queueGroups(lineOf("queue"), CLOCK),
      "group",
    );
    expect(sections.map((s) => [s.value, s.fixed])).toEqual([
      ["starts", true],
      ["held", false],
      ["reported", false],
      ["never", false],
    ]);
  });

  it("starts the refused group folded only above five cards", () => {
    const of = (count: number) =>
      queueSections(
        groupsOf(
          Array.from({ length: count }, (_, n) => refused(n, CANNOT_WRITE(n))),
        ),
        "group",
      )[0]?.startsFolded;
    expect(of(5)).toBe(false);
    expect(of(6)).toBe(true);
  });

  it("says why the refused group will not start, in counts", () => {
    const [never] = queueSections(
      groupsOf([
        refused(1, CANNOT_WRITE(1)),
        refused(2, "who assigned it cannot be read again: timed out"),
        refused(3, CANNOT_WRITE(3)),
      ]),
      "group",
    );
    expect(never?.reasons).toBe(
      "2 assigned by someone who cannot write, 1 who assigned it cannot be read again",
    );
  });

  it("groups by repository, each in the dispatcher's order, and folds none shut", () => {
    const groups = groupsOf([
      { ...ITEM, repo: "example-org/web", target: "PR #1" },
      { ...ITEM, repo: "example-org/api", target: "PR #2" },
      refused(3, CANNOT_WRITE(3), "example-org/web"),
      refused(4, CANNOT_WRITE(4), "example-org/api"),
    ]);
    const sections = queueSections(groups, "repo");
    expect(sections.map((s) => [s.title, targets([s])])).toEqual([
      ["example-org/api", ["PR #2", "ENG-4"]],
      ["example-org/web", ["PR #1", "ENG-3"]],
    ]);
    expect(sections.every((s) => !s.fixed && !s.startsFolded)).toBe(true);
  });

  it("groups by source in the vocabulary's order", () => {
    const sections = queueSections(
      groupsOf([
        refused(1, CANNOT_WRITE(1)),
        { ...ITEM, source: "held", group: "held", target: "PR #2" },
        { ...ITEM, target: "PR #3" },
      ]),
      "source",
    );
    expect(sections.map((s) => s.value)).toEqual([
      "re-armable",
      "held",
      "assigned",
    ]);
  });

  it("lists every target once, in the dispatcher's order, with no grouping", () => {
    const groups = queueGroups(lineOf("queue"), CLOCK);
    const sections = queueSections(groups, "none");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBeNull();
    expect(targets(sections)).toEqual(
      groups.flatMap((g) => g.items.map((i) => i.target)),
    );
  });

  it("gives back the same order after any other grouping", () => {
    const groups = queueGroups(lineOf("queue"), CLOCK);
    const before = targets(queueSections(groups, "group"));
    queueSections(groups, "repo");
    queueSections(groups, "source");
    expect(targets(queueSections(groups, "group"))).toEqual(before);
  });
});

describe("why a target will not start", () => {
  it("names the kind of refusal, not the person", () => {
    expect(refusalReason(refused(1, CANNOT_WRITE(1)))).toBe(
      "assigned by someone who cannot write",
    );
    expect(
      refusalReason(
        refused(
          2,
          "moved to Ready by contractor-c, who cannot write to ENG; only an item a person with write access made ready is picked up from the pool",
        ),
      ),
    ).toBe("moved by someone who cannot write");
  });

  it("reads a refused launch's own detail", () => {
    expect(
      refusalReason({
        ...refused(1, "assigned by maintainer-a"),
        launch: { outcome: "refused", detail: "identity check: no account" },
      }),
    ).toBe("identity check");
  });

  it("counts the commonest first and gathers what is left", () => {
    expect(reasonCounts(["a", "b", "b", "c", "d", "b", "a"])).toBe(
      "3 b, 2 a, 2 for other reasons",
    );
    expect(reasonCounts([])).toBe("");
  });
});
