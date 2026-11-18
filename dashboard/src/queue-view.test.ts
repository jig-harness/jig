import { describe, expect, it } from "bun:test";
import type {
  LineQueued,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { queueGroups } from "./queue-view.ts";
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
      "Starts when a tick finds a free slot",
      "Held behind a serialized leader",
      "Reported, not started",
      "Will not start",
    ]);
  });

  it("names an available account without predicting the weighted choice", () => {
    const [starts] = queueGroups(lineOf("queue"), CLOCK);
    expect(starts?.note).toBe(
      "Available account: codex-b. Launch weights determine the next choice.",
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
});
