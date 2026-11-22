/**
 * Question groups: needs whose framed decisions are identical once their own
 * target is replaced group together; a difference in any option, the
 * recommended option, the class, the act, another item named in the
 * question, or one decision of several keeps them apart.
 */
import { describe, expect, it } from "bun:test";
import type {
  LineDecision,
  LineNeed,
} from "../../dispatch/lib/dashboard-contract.ts";
import { decisionOf } from "../../dispatch/lib/line-decision.ts";
import {
  frameStationDecision,
  type StationFacts,
} from "../decisions/station.ts";
import { dispatcherDecisionDigest } from "../decisions/station-digest.ts";
import {
  questionGroupId,
  questionGroupKey,
  questionGroups,
  replaceOwnTarget,
} from "../question-group.ts";

const BASE: Omit<LineNeed, "target" | "item" | "decisions" | "cause"> = {
  stage: "pickup",
  repo: "example-org/web",
  pr: null,
  url: null,
  title: null,
  since: "2026-11-22T10:00:00Z",
  reason: "the pickup stalled",
  notified: null,
  workspaces: [],
};

/** A need whose one decision the dispatcher framed from `facts`, about `item`. */
function stationNeed(
  item: string,
  facts: StationFacts,
  repo = BASE.repo,
): LineNeed {
  const framed = frameStationDecision(facts);
  return {
    ...BASE,
    repo,
    cause: facts.kind === "pickup-ended" ? "pickup-ended" : "stalled",
    target: item,
    item,
    decisions: [
      {
        ...decisionOf({
          key: framed.key,
          kind: "finding",
          decision: framed.decision,
          digest: dispatcherDecisionDigest(framed),
          lines: [],
        }),
        answer: {
          station: "pickup",
          address: `pickup@${repo}#${item.replace(/^#/, "")}`,
          on: "issue",
          framedBy: "dispatcher",
        },
      },
    ],
  };
}

const stalled = (item: string, carriedBy: number[] = []): StationFacts => ({
  kind: "stalled",
  item,
  state: "In Progress",
  carriedBy,
});

describe("questionGroups", () => {
  it("groups two needs that differ only in their own target, listing both", () => {
    const a = stationNeed("#17", stalled("#17"));
    const b = stationNeed("#27", stalled("#27"), "example-org/api");
    expect(a.decisions[0]?.digest).not.toBe(b.decisions[0]?.digest);
    expect(questionGroups([a, b])).toEqual([[a, b]]);
    expect(questionGroupId(a)).toBe(questionGroupId(b));
    expect(questionGroupId(a)).toMatch(/^q-[0-9a-f]{28}$/);
  });

  it("groups identical decisions recorded under different causes, since the cause is each target's own", () => {
    const a = stationNeed("#17", stalled("#17"));
    const b = {
      ...stationNeed("#27", stalled("#27")),
      cause: "stopped-unknown" as const,
    };
    expect(questionGroups([a, b])).toEqual([[a, b]]);
  });

  it("keeps apart needs whose recommended option differs", () => {
    // A pull request that may carry the work makes the dispatcher recommend holding.
    const a = stationNeed("#17", stalled("#17"));
    const b = stationNeed("#27", stalled("#27", [40]));
    expect(questionGroups([a, b])).toEqual([[a], [b]]);
  });

  it("keeps apart needs whose options differ in any text", () => {
    const a = stationNeed("#17", stalled("#17"));
    const b = stationNeed("#27", stalled("#27"));
    const [d] = b.decisions;
    if (d === undefined) throw new Error("no decision");
    b.decisions = [
      {
        ...d,
        options: (d.options ?? []).map((o, i) =>
          i === 0 ? { ...o, costs: `${o.costs} And one more.` } : o,
        ),
      },
    ];
    expect(questionGroups([a, b])).toEqual([[a], [b]]);
  });

  it("keeps apart needs of another class or another act", () => {
    const a = stationNeed("#17", stalled("#17"));
    const b = stationNeed("#27", stalled("#27"));
    const c = stationNeed("#37", stalled("#37"));
    const d = (n: LineNeed): LineDecision => {
      const [first] = n.decisions;
      if (first === undefined) throw new Error("no decision");
      return first;
    };
    b.decisions = [{ ...d(b), decisionClass: "scope" }];
    c.act = "Authorize";
    expect(questionGroups([a, b, c])).toEqual([[a], [b], [c]]);
  });

  it("keeps apart questions that name another item, and groups those naming the same one", () => {
    const ask = (item: string, other: string): LineNeed => {
      const n = stationNeed(item, stalled(item));
      const [d] = n.decisions;
      if (d === undefined) throw new Error("no decision");
      n.decisions = [
        { ...d, question: `Should ${item} wait for ${other} to merge?` },
      ];
      return n;
    };
    const a = ask("#17", "#90");
    const b = ask("#27", "#90");
    const c = ask("#37", "#91");
    expect(questionGroups([a, b, c])).toEqual([[a, b], [c]]);
  });

  it("never groups a need with no framed options, or one with answers that keep it waiting", () => {
    const a = stationNeed("#17", stalled("#17"));
    const b = stationNeed("#27", stalled("#27"));
    const bare = { ...stationNeed("#37", stalled("#37")) };
    bare.decisions = bare.decisions.map((d) => ({ ...d, options: [] }));
    const stale = stationNeed("#47", stalled("#47"));
    stale.decisions = stale.decisions.map((d) => ({
      ...d,
      answerState: "stale",
    }));
    const refused = stationNeed("#57", stalled("#57"));
    refused.decisions = refused.decisions.map((d) => ({
      ...d,
      acted: {
        option: "Release the claim",
        author: "maintainer-a",
        outcome: "refused",
        detail: "the item moved",
      },
    }));
    expect(questionGroupKey(bare)).toBeNull();
    expect(questionGroupKey(stale)).toBeNull();
    expect(questionGroupKey(refused)).toBeNull();
    expect(questionGroups([a, bare, b, stale, refused])).toEqual([
      [a, b],
      [bare],
      [stale],
      [refused],
    ]);
  });
});

/** A park's decision about one finding, framed as the drive frames it. */
function finding(key: string, question: string, pick: string): LineDecision {
  return {
    key,
    kind: "finding",
    digest: `digest-${key}`,
    lines: [],
    question,
    recommendation: `${pick}: it is smaller`,
    decisionClass: "scope",
    options: [
      {
        name: "Keep",
        changes: "nothing",
        costs: "a follow-up",
        recommended: pick === "Keep",
      },
      {
        name: "Widen",
        changes: "the scope",
        costs: "a longer review",
        recommended: pick === "Widen",
      },
    ],
    steps: [],
  };
}

function park(pr: number, decisions: LineDecision[]): LineNeed {
  return {
    ...BASE,
    cause: "parked",
    stage: "rearm",
    target: `PR #${pr}`,
    item: null,
    pr,
    decisions,
  };
}

describe("a park with several decisions", () => {
  it("groups only with a park whose decisions are each identical, in order", () => {
    const first = (pr: number) =>
      finding(`f${pr}a`, `Widen PR #${pr} to the settings page?`, "Keep");
    const second = (pr: number, pick = "Widen") =>
      finding(`f${pr}b`, "Rename the flag as well?", pick);
    const a = park(7, [first(7), second(7)]);
    const b = park(8, [first(8), second(8)]);
    const otherSecond = park(9, [first(9), second(9, "Keep")]);
    const onlyFirst = park(10, [first(10)]);
    const reordered = park(11, [second(11), first(11)]);
    expect(questionGroups([a, b, otherSecond, onlyFirst, reordered])).toEqual([
      [a, b],
      [otherSecond],
      [onlyFirst],
      [reordered],
    ]);
  });
});

describe("replaceOwnTarget", () => {
  const need = { target: "#12", item: "#12", pr: null };
  it("replaces the need's own identifier and leaves a longer one alone", () => {
    expect(
      replaceOwnTarget("Release #12, not #123 or other/repo#12.", need, "X"),
    ).toBe("Release X, not #123 or other/repo#12.");
  });
  it("replaces a pull request's target as written", () => {
    expect(
      replaceOwnTarget(
        "How should the stopped drive of PR #7 go on? PR #70 waits.",
        { target: "PR #7", item: null, pr: 7 },
        "X",
      ),
    ).toBe("How should the stopped drive of X go on? PR #70 waits.");
  });
});
