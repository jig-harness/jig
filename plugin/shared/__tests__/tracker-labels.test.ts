/**
 * The tracker label vocabulary (`shared/tracker-labels.ts`): a default
 * for every role, the consumer's names in `issue_tracker.labels`, and the
 * older `review.taxonomy` fields as a fallback that may not disagree.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TRACKER_LABELS,
  labelsAsConfig,
  parseTrackerLabels,
} from "../tracker-labels.ts";

const labels = (l: unknown, taxonomy?: Record<string, unknown>) =>
  parseTrackerLabels({
    issue_tracker: { labels: l },
    ...(taxonomy === undefined ? {} : { review: { taxonomy } }),
  });

describe("parseTrackerLabels", () => {
  it("defaults every role", () => {
    expect(labelsAsConfig(DEFAULT_TRACKER_LABELS)).toEqual({
      epic: "epic",
      hitl: "hitl",
      manual_ops: "manual-ops",
      followup: "pr-followup",
      bug: ["bug", "type:bug"],
      pattern_prefix: "pattern:",
      batch_sizes: ["xs", "small", "medium"],
      extractable_tails: [
        "hitl:legal",
        "hitl:tactical",
        "manual-ops",
        "pr-followup",
      ],
    });
    expect(DEFAULT_TRACKER_LABELS.declared.size).toBe(0);
  });

  it("reads the consumer's names and derives the default tails from them", () => {
    const l = labels({
      epic: "Epic",
      hitl: "needs-human",
      manual_ops: "ops",
      followup: "review-followup",
      bug: ["Bug"],
      pattern_prefix: "pattern/",
      batch_sizes: ["S"],
    });
    expect(labelsAsConfig(l)).toEqual({
      epic: "Epic",
      hitl: "needs-human",
      manual_ops: "ops",
      followup: "review-followup",
      bug: ["Bug"],
      pattern_prefix: "pattern/",
      batch_sizes: ["S"],
      extractable_tails: [
        "needs-human:legal",
        "needs-human:tactical",
        "ops",
        "review-followup",
      ],
    });
    expect([...l.declared].sort() as string[]).toEqual(
      [
        "batch_sizes",
        "bug",
        "epic",
        "followup",
        "hitl",
        "manual_ops",
        "pattern_prefix",
      ].sort(),
    );
  });

  it("takes declared extractable tails as given", () => {
    expect(
      labels({ extractable_tails: ["waiting-on-legal"] }).extractableTails,
    ).toEqual(["waiting-on-legal"]);
  });

  it("falls back to the review taxonomy, and refuses a disagreement", () => {
    const l = labels(undefined, {
      epic_label: "Initiative",
      provenance_label: "fu",
    });
    expect(l.epic).toBe("Initiative");
    expect(l.followup).toBe("fu");
    expect(l.declared.has("epic")).toBe(true);
    expect(
      labels({ epic: "Initiative" }, { epic_label: "Initiative" }).epic,
    ).toBe("Initiative");
    expect(() =>
      labels({ epic: "Epic" }, { epic_label: "Initiative" }),
    ).toThrow(
      /issue_tracker\.labels\.epic \(Epic\) and review\.taxonomy\.epic_label \(Initiative\)/,
    );
  });

  it.each([
    [{ epics: "x" }, /issue_tracker\.labels\.epics is not a label role/],
    [{ epic: "" }, /issue_tracker\.labels\.epic must be a nonempty label name/],
    [{ bug: "bug" }, /issue_tracker\.labels\.bug must be a list/],
    [{ batch_sizes: [] }, /batch_sizes must be a list/],
    [
      { extractable_tails: ["a", "a"] },
      /extractable_tails must be a list of distinct/,
    ],
    [{ manual_ops: null }, /manual_ops must be a nonempty label name/],
    [{ epic: null }, /epic must be a nonempty label name/],
    [{ bug: null }, /bug must be a list/],
    [{ batch_sizes: null }, /batch_sizes must be a list/],
    [{ extractable_tails: null }, /extractable_tails must be a list/],
  ])("refuses %j", (l, message) => {
    expect(() => labels(l)).toThrow(message);
  });

  it("refuses the review taxonomy shapes reviewConfig() refuses", () => {
    expect(() => labels(undefined, { provenance_label: null })).toThrow(
      /review\.taxonomy\.provenance_label must be a nonempty label name/,
    );
    expect(() => labels(undefined, { epic_label: null })).toThrow(
      /review\.taxonomy\.epic_label must be a nonempty label name/,
    );
    expect(() => parseTrackerLabels({ review: { taxonomy: null } })).toThrow(
      /^review\.taxonomy must be an object$/,
    );
    expect(() => parseTrackerLabels({ review: null })).toThrow(
      /^review must be an object$/,
    );
  });

  it("refuses labels that are not a mapping", () => {
    expect(() => labels(["epic"])).toThrow(
      /issue_tracker\.labels must be a mapping/,
    );
  });

  it("refuses an issue_tracker section that is not a mapping", () => {
    for (const issue_tracker of [[], "typo", 3])
      expect(() => parseTrackerLabels({ issue_tracker })).toThrow(
        /^issue_tracker must be a mapping$/,
      );
  });

  it("reads an empty issue_tracker or labels key as absent", () => {
    expect(labelsAsConfig(parseTrackerLabels({ issue_tracker: null }))).toEqual(
      labelsAsConfig(DEFAULT_TRACKER_LABELS),
    );
    expect(labels(null).declared.size).toBe(0);
  });
});
