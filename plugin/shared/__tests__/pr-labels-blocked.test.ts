/**
 * The `blocked` output of the pull request state projection, as pure
 * decisions: which items a pull request links, what its ledger asks of each,
 * and the marker that brings an item back.
 */
import { describe, expect, test } from "bun:test";
import {
  blockedMarkerLine,
  blockedMarkersIn,
  blockingComment,
  decideItem,
  type ItemReading,
  linkedKeys,
  newestMarker,
  parkCauses,
  stopKey,
  wantOf,
} from "../pr-labels/blocked.ts";

const JIRA_KEY = "(?<!\\w)ENG-\\d+(?!\\w)";
const GITHUB_KEY = "(?<![\\w&#])#[1-9]\\d*(?!\\w)";

const item = (over: Partial<ItemReading> = {}): ItemReading => ({
  key: "ENG-123",
  canonical: "in_progress",
  stateName: "In Progress",
  closed: false,
  ...over,
});

describe("linkedKeys", () => {
  test("reads each Closes and Refs link once, in order", () => {
    const body = [
      "Closes ENG-123",
      "| Closes ENG-124 | `a1b2c3d` | Paged the refund list |",
      "refs ENG-125, and Closes ENG-123 again",
      "Part of ENG-200",
    ].join("\n");
    expect(linkedKeys(body, JIRA_KEY)).toEqual([
      "ENG-123",
      "ENG-124",
      "ENG-125",
    ]);
  });

  test("a description that links no item gives none", () => {
    expect(linkedKeys("Part of #12\nNo link here.", GITHUB_KEY)).toEqual([]);
    expect(linkedKeys("", JIRA_KEY)).toEqual([]);
  });

  test("reads a GitHub key", () => {
    expect(linkedKeys("Closes #747\nRefs #740", GITHUB_KEY)).toEqual([
      "#747",
      "#740",
    ]);
  });
});

describe("wantOf", () => {
  test("parked asks for blocked; driving, converged and stale ask to return", () => {
    expect(wantOf({ state: "parked" })).toBe("blocked");
    for (const state of ["driving", "converged", "stale"] as const)
      expect(wantOf({ state })).toBe("unblocked");
  });

  test("a state it cannot tell, no ledger, and held ask nothing", () => {
    expect(wantOf("unknown")).toBe("none");
    expect(wantOf({ state: null })).toBe("none");
    expect(wantOf({ state: "held" })).toBe("none");
  });
});

describe("decideItem", () => {
  test("blocks an open item, recording the state it left and the stop", () => {
    expect(
      decideItem({
        want: "blocked",
        pr: 7,
        stop: "2026-11-11T09:00:00Z",
        item: item(),
        marker: null,
      }),
    ).toEqual({
      move: "block",
      marker: { pr: 7, stop: "2026-11-11T09:00:00Z", from: "in_progress" },
    });
  });

  test("returns an item its own marker blocked to the recorded state", () => {
    expect(
      decideItem({
        want: "unblocked",
        pr: 7,
        stop: "",
        item: item({ canonical: "blocked", stateName: "Blocked" }),
        marker: { pr: 7, stop: "s1", from: "pr_open" },
      }),
    ).toEqual({ move: "return", to: "pr_open" });
  });

  test("an item a person moved out while the same stop stands is left", () => {
    const d = decideItem({
      want: "blocked",
      pr: 7,
      stop: "s1",
      item: item(),
      marker: { pr: 7, stop: "s1", from: "in_progress" },
    });
    expect(d.move).toBe("none");
  });

  test("a later stop blocks the item again", () => {
    const d = decideItem({
      want: "blocked",
      pr: 7,
      stop: "s2",
      item: item(),
      marker: { pr: 7, stop: "s1", from: "in_progress" },
    });
    expect(d.move).toBe("block");
  });

  test("an item a person blocked, or another pull request's marker blocked, is not returned", () => {
    const blocked = item({ canonical: "blocked", stateName: "Blocked" });
    expect(
      decideItem({
        want: "unblocked",
        pr: 7,
        stop: "",
        item: blocked,
        marker: null,
      }).move,
    ).toBe("none");
    expect(
      decideItem({
        want: "unblocked",
        pr: 7,
        stop: "",
        item: blocked,
        marker: { pr: 8, stop: "s1", from: "todo" },
      }).move,
    ).toBe("none");
  });

  test("a closed item, and one in no canonical state, are left", () => {
    expect(
      decideItem({
        want: "blocked",
        pr: 7,
        stop: "s1",
        item: item({ canonical: "done", stateName: "Done", closed: true }),
        marker: null,
      }).move,
    ).toBe("none");
    expect(
      decideItem({
        want: "blocked",
        pr: 7,
        stop: "s1",
        item: item({ canonical: null, stateName: "Waiting on vendor" }),
        marker: null,
      }).move,
    ).toBe("none");
  });
});

describe("the marker", () => {
  test("round-trips through the blocking comment, the newest winning", () => {
    const marker = { pr: 7, stop: "s1", from: "in_progress" };
    const comment = blockingComment({
      pr: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      causes: [
        {
          class: "human-decision",
          reason: "Should the migration run\nbefore the deploy?",
        },
      ],
      fromName: "In Progress",
      marker,
    });
    expect(comment).toContain(
      "- `human-decision`: Should the migration run before the deploy?",
    );
    expect(comment).toContain("It returns to In Progress");
    expect(blockedMarkersIn(comment)).toEqual([marker]);
    const later = { pr: 7, stop: "s2", from: "pr_open" };
    expect(
      newestMarker([
        { body: comment },
        { body: "unrelated" },
        { body: blockedMarkerLine(later) },
      ]),
    ).toEqual(later);
  });

  test("a malformed marker, or one naming a closed state, is skipped", () => {
    expect(blockedMarkersIn("<!-- jig:blocked {not json} -->")).toEqual([]);
    expect(
      blockedMarkersIn(blockedMarkerLine({ pr: 7, stop: "s1", from: "done" })),
    ).toEqual([]);
  });
});

test("stopKey prefers the run's acquisition time, else its round", () => {
  expect(stopKey("2026-11-11T09:00:00Z", 3)).toBe("2026-11-11T09:00:00Z");
  expect(stopKey(null, 3)).toBe("round 3");
  expect(stopKey("", 4)).toBe("round 4");
});

test("parkCauses reads each park's decision record, else the stop's own cause", () => {
  const fallback = { class: "needs-person", reason: "exit 5" };
  expect(parkCauses([], fallback)).toEqual([fallback]);
  expect(
    parkCauses(
      [
        {
          class: "scope",
          reason: "old reason",
          decision: { class: "scope", call: { question: "Ship it now?" } },
        },
        { class: "escalated", reason: "Which owner decides?" },
      ],
      fallback,
    ),
  ).toEqual([
    { class: "scope", reason: "Ship it now?" },
    { class: "escalated", reason: "Which owner decides?" },
  ]);
});
