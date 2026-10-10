/**
 * loop-metrics.test.ts — the outcome grammar, the growth-attribution rule, and
 * the recurrence rule.
 *
 * Those three are worth pinning and the rest is plumbing.
 *
 * The GRAMMAR, because it is a machine-read contract with an enforcer on the
 * other side of it: `reply-to-thread.ts` refuses a body that does not match, so
 * a reader that matches something looser silently admits samples the enforcer
 * never let through, and one that matches something tighter drops real replies
 * out of the harvested dataset. Both corrupt the reviewer-scoring sample rather
 * than failing.
 *
 * The ATTRIBUTION, because the whole issue turns on it. an earlier change rejects the
 * first-commit-versus-final measure by name, and a test that only asserted "the
 * numbers add up" would pass just as happily on the rejected measure. So the
 * cases below pin the DISTINCTION: a driver that pushes half its work before
 * any reviewer arrives must not have that half counted as post-review.
 *
 * The RECURRENCE rule, because the escape rate is the number the whole an earlier change
 * recall trade rests on and its inputs arrive in the wrong order. Merge order
 * does not establish finding order, so a test that only asserted "a proximate
 * later thread is a re-find" would pass on the inverted-causality measure
 * `lib/escape.ts` exists to reject.
 *
 * No network: `computeLoopMetrics` and `refindsFor` are pure over a `PrSample`,
 * which is why both live apart from the CLIs that print them.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASELINE_DOC_PATH } from "../scripts/lib/escape-baseline.ts";
import {
  anchorLine,
  isRecurrence,
  type Refind,
  refindsFor,
  supersededCandidateInOwnPr,
} from "../scripts/lib/escape.ts";
import {
  classifySiblingCommits,
  computeLoopMetrics,
  renderLoopMetrics,
  renderSeverityOutageWarnings,
} from "../scripts/lib/metrics.ts";
import {
  DECLINED_OUTCOMES,
  OUTCOMES,
  qualifyingOutcome,
} from "../scripts/lib/outcome.ts";
import {
  type CommitSample,
  count,
  initiatingFromPrefix,
  type PrSample,
  type ReviewSample,
  type ThreadSample,
  threadFrom,
} from "../scripts/lib/sample.ts";
// `renderReport`/`resolveEscapeBaseline`/`runReport` are exported from the
// CLI itself — safe to import directly because `loop-metrics.ts`
// guards its `runMain(...)` call with `isEntryPoint`, so importing it here
// does NOT also execute `main()` (which would hit the network) as a side
// effect.
import {
  type ReportDeps,
  renderReport,
  resolveEscapeBaseline,
  runReport,
  runSeverityWarnings,
} from "../scripts/loop-metrics.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "loop-metrics.ts");

function commit(
  oid: string,
  committedDate: string,
  additions: number,
  deletions = 0,
  parents = 1,
  parentOids: string[] = [],
): CommitSample {
  return {
    oid,
    committedDate,
    additions,
    deletions,
    parents,
    parentOids,
    headline: `c ${oid}`,
  };
}

const NO_SIBLING = { commits: 0, additions: 0, deletions: 0 };

function review(
  oid: string,
  submittedAt: string,
  isBot = true,
  initiating = true,
  author = isBot ? "bot-app" : "a-human",
): ReviewSample {
  return {
    oid,
    submittedAt,
    author,
    isBot,
    initiating,
  };
}

function thread(over: Partial<ThreadSample> = {}): ThreadSample {
  return {
    threadId: "t",
    path: "a.ts",
    line: 10,
    isResolved: true,
    startedBy: "bot-app",
    startedByBot: true,
    url: "https://example.invalid/1",
    outcome: "accepted",
    reason: "fixed it",
    settledBody: "fixed it",
    originalLine: null,
    diffSide: "RIGHT",
    isOutdated: false,
    createdAt: "2026-08-01T00:00:00Z",
    settledAt: "2026-08-01T01:00:00Z",
    commentsTruncated: false,
    category: "unknown",
    // A READABLE severity by default, so a probe that cares about the
    // unknown-severity rate has to say so — a fixture defaulting to `unknown`
    // would make every unrelated test contribute to the very metric an earlier change
    // added, and a 100% share would then be the baseline rather than the alarm.
    severity: "medium",
    reviewedHeadOid: null,
    ...over,
  };
}

function sample(over: Partial<PrSample> = {}): PrSample {
  return {
    pr: 1,
    title: "a pr",
    state: "OPEN",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    baseRefName: "develop",
    headRefOid: "h",
    createdAt: "2026-08-01T00:00:00Z",
    mergedAt: null,
    mergeCommitOid: "",
    commits: [],
    reviews: [],
    threads: [],
    ...over,
  };
}

describe("qualifyingOutcome — the harvest side of reply-to-thread.ts", () => {
  it("accepts every token in the closed vocabulary", () => {
    for (const t of [
      "accepted",
      "rejected",
      "wont-fix",
      "deferred",
      "moot",
    ] as const) {
      expect(qualifyingOutcome(`**${t}** — a reason`)?.outcome).toBe(t);
    }
  });

  it("strips the conventional separator from the reason", () => {
    // Left in, every rendered line reads `by coderabbitai — — valid point`.
    expect(qualifyingOutcome("**accepted** — valid point")?.reason).toBe(
      "valid point",
    );
    expect(qualifyingOutcome("**accepted** valid point")?.reason).toBe(
      "valid point",
    );
  });

  it("requires a reason with actual content", () => {
    expect(qualifyingOutcome("**accepted**")).toBeNull();
    expect(qualifyingOutcome("**accepted** —")).toBeNull();
    expect(qualifyingOutcome("**accepted** ---")).toBeNull();
  });

  it("requires a token boundary", () => {
    expect(qualifyingOutcome("**accepted**oops")).toBeNull();
  });

  it("rejects a token that is not the literal opening", () => {
    // A worked example quoted inside a longer comment is not an answer to the
    // thread it appears in — the leading-whitespace tolerance is what would
    // admit an indented one.
    expect(qualifyingOutcome("  **accepted** — indented example")).toBeNull();
    expect(
      qualifyingOutcome("see below:\n**accepted** — worked example"),
    ).toBeNull();
  });

  it("tolerates a CRLF line terminator", () => {
    // A reply composed from a CRLF file leaves `\r` on the first line, and
    // `(.*)` does not match it — a valid reply would read as unanswered.
    expect(qualifyingOutcome("**wont-fix** — declined\r\nmore")?.outcome).toBe(
      "wont-fix",
    );
  });

  it("rejects a Unicode space as the token boundary", () => {
    expect(qualifyingOutcome("**accepted**  reason")).toBeNull();
  });

  it("scopes the declined population to the shipped-anyway outcomes", () => {
    // `rejected` asserts the finding was WRONG, so nothing could have escaped;
    // counting it would inflate the defect-escape denominator with findings
    // whose non-recurrence proves nothing.
    expect([...DECLINED_OUTCOMES].sort()).toEqual(["deferred", "wont-fix"]);
  });

  it("reads every OUTCOMES member, so the two cannot drift apart", () => {
    // The reader's alternation is BUILT from `OUTCOMES` rather than restated
    // beside it. This is what makes that derivation observable: a token added
    // to the vocabulary and not recognised here is the "harvested dataset
    // disagrees with the enforcer" failure the module exists to prevent.
    for (const t of OUTCOMES) {
      expect(qualifyingOutcome(`**${t}** — a reason`)?.outcome).toBe(t);
    }
  });

  it("has a vocabulary free of regex metacharacters", () => {
    // The derivation above is a plain `join('|')`, which is exact only while
    // this holds. A future token like `wont.fix` would silently widen the
    // reader to match strings `reply-to-thread.ts` refuses to post — so assert
    // the property rather than commenting that it is true.
    for (const t of OUTCOMES) expect(t).toMatch(/^[a-z-]+$/);
  });
});

describe("computeLoopMetrics — growth attribution", () => {
  it("splits at the first BOT-reviewed head, not at the first commit", () => {
    // The case an earlier change exists for: three commits pushed, the reviewer arrives
    // at the third, and only what follows is post-review. A
    // first-commit-versus-final measure would report 900/1000 = 90%.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 100),
          commit("c2", "2026-08-01T02:00:00Z", 400),
          commit("c3", "2026-08-01T03:00:00Z", 300),
          commit("c4", "2026-08-01T05:00:00Z", 200, 30),
        ],
        reviews: [review("c3", "2026-08-01T04:00:00Z")],
      }),
      null,
      new Set(),
    );
    expect(m.attribution).toBe("commit");
    expect(m.firstReviewedHead).toBe("c3");
    expect(m.opening).toEqual({
      commits: 3,
      additions: 800,
      deletions: 0,
      merges: 0,
      octopusMerges: 0,
      sibling: NO_SIBLING,
    });
    expect(m.postReview).toEqual({
      commits: 1,
      additions: 200,
      deletions: 30,
      merges: 0,
      octopusMerges: 0,
      sibling: NO_SIBLING,
    });
    expect(m.postReviewShare).toBeCloseTo(0.2, 10);
  });

  it("excludes a merge from the churn but keeps its count", () => {
    // Measured, not hypothetical: one `Merge remote-tracking branch
    // 'origin/develop'` commit on PR #4023 reports +52,015 against its first
    // parent, on a PR whose whole net diff is 222 additions. Counted, the
    // metric says a round demanded fifty thousand lines nobody wrote — and
    // worst on exactly the long-running PRs the dials are aimed at.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 100),
          commit("m1", "2026-08-01T03:00:00Z", 52015, 11463, 2),
          commit("c2", "2026-08-01T04:00:00Z", 40),
        ],
        reviews: [review("c1", "2026-08-01T02:00:00Z")],
      }),
      null,
      new Set(),
    );
    expect(m.postReview).toEqual({
      commits: 1,
      additions: 40,
      deletions: 0,
      merges: 1,
      octopusMerges: 0,
      sibling: NO_SIBLING,
    });
    expect(m.postReviewShare).toBeCloseTo(40 / 140, 10);
    expect(renderLoopMetrics(m)).toContain("merge commit excluded");
  });

  it("ignores a human review when deciding where review started", () => {
    // Every outcome reply the driver posts creates a review authored by a User
    // — 63 of PR #4052's 120. Counting those would make the loop's own answers
    // look like the rounds that provoked them.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 100),
          commit("c2", "2026-08-01T04:00:00Z", 50),
        ],
        reviews: [
          review("c1", "2026-08-01T02:00:00Z", false),
          review("c2", "2026-08-01T05:00:00Z", true),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.firstReviewedHead).toBe("c2");
    expect(m.rounds.reviewedHeads).toBe(1);
    expect(m.postReview.additions).toBe(0);
  });

  it("reports no attributable growth before any bot has reviewed", () => {
    const m = computeLoopMetrics(
      sample({ commits: [commit("c1", "2026-08-01T01:00:00Z", 100)] }),
      null,
      new Set(),
    );
    expect(m.attribution).toBe("none");
    expect(m.opening.additions).toBe(100);
    expect(m.postReview.additions).toBe(0);
    expect(renderLoopMetrics(m)).toContain("no bot review yet");
  });

  it("falls back to timestamps — and says so — when history was rewritten", () => {
    // A force-push after a review leaves the reviewed head off the branch. The
    // split is then an approximation, and presenting it as the exact one is
    // the failure mode; the label is the fix.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("n1", "2026-08-01T01:00:00Z", 100),
          commit("n2", "2026-08-01T05:00:00Z", 60),
        ],
        reviews: [review("gone", "2026-08-01T04:00:00Z")],
      }),
      null,
      new Set(),
    );
    expect(m.attribution).toBe("time");
    expect(m.opening.additions).toBe(100);
    expect(m.postReview.additions).toBe(60);
    expect(renderLoopMetrics(m)).toContain("approximate");
  });

  it("counts distinct reviewed heads, not reviews", () => {
    const m = computeLoopMetrics(
      sample({
        reviews: [
          review("c1", "2026-08-01T01:00:00Z"),
          review("c1", "2026-08-01T02:00:00Z"),
          review("c2", "2026-08-01T03:00:00Z"),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.rounds.reviewedHeads).toBe(2);
  });
});

describe("classifySiblingCommits — merge ancestry", () => {
  it("excludes a sibling merge's imported commits from its own oid set", () => {
    const commits = [
      commit("c1", "2026-08-01T01:00:00Z", 10),
      commit("m1", "2026-08-01T02:00:00Z", 40, 5, 2, ["c1", "sib-tip"]),
      commit("c2", "2026-08-01T03:00:00Z", 5),
    ];
    const oids = classifySiblingCommits(
      commits,
      (oid) => (oid === "sib-tip" ? false : null),
      (first, second) => {
        expect(first).toBe("c1");
        expect(second).toBe("sib-tip");
        return new Set(["sib-1", "sib-2"]);
      },
    );
    expect([...oids].sort()).toEqual(["sib-1", "sib-2"]);
  });

  it("does NOT exclude anything for a base-sync merge", () => {
    // The second parent IS an ancestor of the base ref — an ordinary
    // `git merge origin/develop` — so nothing this merge imported is a
    // sibling branch's own work.
    const commits = [
      commit("m1", "2026-08-01T02:00:00Z", 52015, 11463, 2, ["c1", "base-tip"]),
    ];
    const oids = classifySiblingCommits(
      commits,
      () => true,
      () => {
        throw new Error("must not walk a base-sync merge for siblings");
      },
    );
    expect(oids.size).toBe(0);
  });

  it("leaves a merge unclassified when ancestry cannot be established", () => {
    // Best-effort, same contract as `laterFixCommits`: no local evidence is
    // never asserted as "not an ancestor".
    const commits = [
      commit("m1", "2026-08-01T02:00:00Z", 100, 0, 2, ["c1", "unknown-tip"]),
    ];
    const oids = classifySiblingCommits(
      commits,
      () => null,
      () => {
        throw new Error("must not walk an unclassifiable merge for siblings");
      },
    );
    expect(oids.size).toBe(0);
  });

  it("ignores a non-merge commit and a merge missing a second parent oid", () => {
    const commits = [
      commit("c1", "2026-08-01T01:00:00Z", 10),
      commit("m1", "2026-08-01T02:00:00Z", 40, 0, 2, ["c1"]),
    ];
    const oids = classifySiblingCommits(
      commits,
      () => false,
      () => new Set(["x"]),
    );
    expect(oids.size).toBe(0);
  });
});

describe("computeLoopMetrics — sibling-branch churn is excluded and reported", () => {
  it("pulls a sibling merge's imported commit out of postReview into sibling", () => {
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 100),
          commit("m1", "2026-08-01T04:00:00Z", 999, 0, 2, ["c1", "sib-tip"]),
          commit("sib1", "2026-08-01T03:30:00Z", 30, 5),
          commit("c2", "2026-08-01T05:00:00Z", 20),
        ],
        reviews: [review("c1", "2026-08-01T02:00:00Z")],
      }),
      null,
      new Set(["sib1"]),
    );
    expect(m.postReview).toEqual({
      commits: 1,
      additions: 20,
      deletions: 0,
      merges: 1,
      octopusMerges: 0,
      sibling: { commits: 1, additions: 30, deletions: 5 },
    });
    // Excluded from the share denominator too — it was never this branch's
    // authored churn to begin with.
    expect(m.postReviewShare).toBeCloseTo(20 / 120, 10);
    expect(renderLoopMetrics(m)).toContain(
      "imported by a sibling-branch merge",
    );
  });

  it("discloses an octopus merge rather than silently trusting its classification", () => {
    // `classifySiblingCommits` only tests the merge's first two parents —
    // `m2` has three. Its own diff is dropped from the churn like any other
    // merge (`merges`), but nothing here can tell whether `sib2` (reachable
    // only through the third parent) was correctly excluded, so the count
    // must say so rather than silently reporting a complete total.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 100),
          commit("m2", "2026-08-01T04:00:00Z", 500, 0, 3, ["c1", "sib-tip"]),
          commit("sib2", "2026-08-01T03:30:00Z", 15, 0),
        ],
        reviews: [review("c1", "2026-08-01T02:00:00Z")],
      }),
      null,
      new Set(),
    );
    expect(m.postReview.merges).toBe(1);
    expect(m.postReview.octopusMerges).toBe(1);
    expect(renderLoopMetrics(m)).toContain("octopus merge");
  });

  it("excludes nothing when the caller supplies an explicitly empty sibling set", () => {
    // `siblingCommitOids` is mandatory — an empty
    // `Set` is the caller's own explicit answer, not a silently-reproduced
    // default for a caller that never resolved ancestry.
    const commits = [
      commit("c1", "2026-08-01T01:00:00Z", 100),
      commit("sib1", "2026-08-01T02:00:00Z", 30),
    ];
    const m = computeLoopMetrics(sample({ commits }), null, new Set());
    expect(m.opening.additions).toBe(130);
    expect(m.opening.sibling).toEqual(NO_SIBLING);
  });
});

describe("computeLoopMetrics — outcome mix", () => {
  it("buckets every outcome and separates the unanswered", () => {
    const m = computeLoopMetrics(
      sample({
        threads: [
          thread({ outcome: "accepted" }),
          thread({ outcome: "accepted" }),
          thread({ outcome: "wont-fix" }),
          thread({ outcome: null, isResolved: false }),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.outcomes.accepted).toBe(2);
    expect(m.outcomes["wont-fix"]).toBe(1);
    expect(m.unanswered).toBe(1);
    expect(m.answered).toBe(3);
    // The share is over ANSWERED threads. Over the total it would drift down
    // as unanswered threads accumulate, which says nothing about the bar.
    expect(m.acceptedShare).toBeCloseTo(2 / 3, 10);
    expect(m.threads).toEqual({
      total: 4,
      resolved: 3,
      unresolved: 1,
      bot: 4,
      human: 0,
      truncated: 0,
    });
  });

  it("has no accepted share to report when nothing was answered", () => {
    const m = computeLoopMetrics(
      sample({ threads: [thread({ outcome: null })] }),
      null,
      new Set(),
    );
    // `null`, never 0 — a loop that answered nothing has not achieved a 0%
    // accepted share, and averaging that into a baseline would be a fiction.
    expect(m.acceptedShare).toBeNull();
    expect(renderLoopMetrics(m)).toContain("n/a");
  });

  it("surfaces threads whose comment list was truncated", () => {
    const m = computeLoopMetrics(
      sample({ threads: [thread({ commentsTruncated: true })] }),
      null,
      new Set(),
    );
    expect(m.threads.truncated).toBe(1);
    expect(renderLoopMetrics(m)).toContain("WITHHELD");
  });

  // The same outcome mix, cut by `ThreadSample.category`.
  it("cuts the outcome mix by category, and omits an unanswered thread from both", () => {
    const m = computeLoopMetrics(
      sample({
        threads: [
          thread({ outcome: "accepted", category: "security" }),
          thread({ outcome: "accepted", category: "security" }),
          thread({ outcome: "wont-fix", category: "ux" }),
          thread({ outcome: null, category: "ux" }),
          thread({ outcome: "rejected", category: "unknown" }),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.outcomesByCategory.security!.accepted).toBe(2);
    expect(m.outcomesByCategory.ux!["wont-fix"]).toBe(1);
    // The unanswered `ux` thread must not move ANY category's bucket — it
    // contributes to neither `outcomes` nor `outcomesByCategory`, matching the
    // top-level histogram's own scope.
    expect(m.outcomesByCategory.ux!.accepted).toBe(0);
    expect(
      Object.values(m.outcomesByCategory.ux!).reduce((a, b) => a + b, 0),
    ).toBe(1);
    expect(m.outcomesByCategory.unknown!.rejected).toBe(1);
  });

  // The ladder's own fail-open input, made visible.
  it("counts the unreadable-severity share per author, over EVERY thread", () => {
    const m = computeLoopMetrics(
      sample({
        threads: [
          // A reviewer whose format stopped being recognized: every finding
          // reads `unknown`, so its ladder is fully inert.
          thread({ startedBy: "glyph-switcher", severity: "unknown" }),
          thread({ startedBy: "glyph-switcher", severity: "unknown" }),
          // …including one nobody ever answered. `severity` is a property of
          // the finding as POSTED, so unlike `outcomesByCategory` this must
          // not wait on a reply.
          thread({
            startedBy: "glyph-switcher",
            severity: "unknown",
            outcome: null,
          }),
          thread({ startedBy: "healthy-bot", severity: "high" }),
          thread({ startedBy: "healthy-bot", severity: "low" }),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.severityByAuthor["glyph-switcher"]).toEqual({
      total: 3,
      unknown: 3,
      unknownShare: 1,
      // No `reviews` supplied in this sample, so no round can be scoped at
      // all — `recentRoundKnown` is false and `recent*` reads "not measured",
      // not a flattering 0%.
      recentRoundKnown: false,
      recentTotal: 0,
      recentUnknown: 0,
      recentUnknownShare: null,
    });
    expect(m.severityByAuthor["healthy-bot"]).toEqual({
      total: 2,
      unknown: 0,
      unknownShare: 0,
      recentRoundKnown: false,
      recentTotal: 0,
      recentUnknown: 0,
      recentUnknownShare: null,
    });
    expect(m.unknownSeverity).toEqual({ count: 3, total: 5, share: 0.6 });
  });

  // chatgpt-codex-connector, a reference-implementation pull request round 4: `recentUnknownShare === null`
  // used to be the ONLY signal for "not measured", so it could not tell "no
  // round is known for this author" apart from "their known latest round
  // produced zero findings" — both left `recentTotal === 0`. An author with
  // one unreadable finding from an EARLIER round, followed by a clean latest
  // round (a real initiating review, zero threads), must read as a clean
  // round — never as a fabricated "every finding this round" outage borrowed
  // from the stale lifetime figure.
  it("reads a known-but-empty latest round as clean, not as an outage borrowed from lifetime history", () => {
    const m = computeLoopMetrics(
      sample({
        reviews: [
          review(
            "head-1",
            "2026-08-01T00:00:00Z",
            true,
            true,
            "glyph-switcher",
          ),
          // A second initiating review from the same author, against a head
          // that raised no threads at all — the latest round is KNOWN, and it
          // is empty.
          review(
            "head-2",
            "2026-08-05T00:00:00Z",
            true,
            true,
            "glyph-switcher",
          ),
        ],
        threads: [
          thread({
            startedBy: "glyph-switcher",
            severity: "unknown",
            reviewedHeadOid: "head-1",
          }),
        ],
      }),
      null,
      new Set(),
    );
    const bucket = m.severityByAuthor["glyph-switcher"]!;
    expect(bucket.unknownShare).toBe(1);
    expect(bucket.recentRoundKnown).toBe(true);
    expect(bucket.recentTotal).toBe(0);
    // Measured and clean — 0, never `null` and never borrowed from the 100%
    // lifetime figure.
    expect(bucket.recentUnknownShare).toBe(0);

    const out = renderLoopMetrics(m);
    expect(out).toContain("glyph-switcher: 1/1 lifetime (100.0%)");
    expect(out).toContain("0 findings this round");
    expect(out).not.toContain("no longer recognized");
    expect(out).not.toContain("EVERY finding this round");
  });

  // chatgpt-codex-connector, a reference-implementation pull request: a lifetime aggregate dilutes a mid-PR
  // format switch by every readable finding that author posted BEFORE it
  // broke, so a live outage in the latest round can read far below the 100%
  // that would actually trip the warning. `recentUnknownShare` is scoped to
  // this author's own most recent initiating-review head instead.
  it("scopes the outage to the CURRENT round, not diluted by earlier readable rounds", () => {
    const m = computeLoopMetrics(
      sample({
        reviews: [
          review(
            "head-1",
            "2026-08-01T00:00:00Z",
            true,
            true,
            "glyph-switcher",
          ),
          review(
            "head-2",
            "2026-08-05T00:00:00Z",
            true,
            true,
            "glyph-switcher",
          ),
        ],
        threads: [
          // Four readable findings in an earlier round…
          thread({
            startedBy: "glyph-switcher",
            severity: "high",
            reviewedHeadOid: "head-1",
          }),
          thread({
            startedBy: "glyph-switcher",
            severity: "medium",
            reviewedHeadOid: "head-1",
          }),
          thread({
            startedBy: "glyph-switcher",
            severity: "low",
            reviewedHeadOid: "head-1",
          }),
          thread({
            startedBy: "glyph-switcher",
            severity: "high",
            reviewedHeadOid: "head-1",
          }),
          // …then every finding in the latest round is unreadable.
          thread({
            startedBy: "glyph-switcher",
            severity: "unknown",
            reviewedHeadOid: "head-2",
          }),
        ],
      }),
      null,
      new Set(),
    );
    const bucket = m.severityByAuthor["glyph-switcher"]!;
    // Lifetime share is diluted to 20% — nowhere near the alarm threshold.
    expect(bucket.unknownShare).toBe(0.2);
    // The CURRENT round is a total outage.
    expect(bucket.recentTotal).toBe(1);
    expect(bucket.recentUnknown).toBe(1);
    expect(bucket.recentUnknownShare).toBe(1);

    const out = renderLoopMetrics(m);
    expect(out).toContain("glyph-switcher: 1/5 lifetime (20.0%)");
    expect(out).toContain("1/1 this round (100.0%)");
    expect(out).toContain("no longer recognized");
  });

  it("buckets a thread with no author under a name no reviewer can own", () => {
    // Not folded into any named reviewer's rate: an unattributable thread
    // would otherwise inflate (or dilute) exactly the per-author number this
    // metric exists to read.
    const m = computeLoopMetrics(
      sample({ threads: [thread({ startedBy: null, severity: "unknown" })] }),
      null,
      new Set(),
    );
    expect(m.severityByAuthor["(unknown author)"]!.unknown).toBe(1);
  });

  it("reports a null share for no threads — not a flattering 0%", () => {
    const m = computeLoopMetrics(sample({ threads: [] }), null, new Set());
    expect(m.unknownSeverity).toEqual({ count: 0, total: 0, share: null });
    expect(m.severityByAuthor).toEqual({});
  });

  it("excludes HUMAN threads — they never had a severity format to lose", () => {
    // A human emits no severity token, so `severityOf` reads `unknown` for
    // every human thread BY CONSTRUCTION. Counting them parks every human at a
    // permanent 100% — which both defeats the "~0 → ~100% is the outage"
    // diagnostic and makes the rendered "format is no longer recognized"
    // warning a claim that is false of the person it names.
    const m = computeLoopMetrics(
      sample({
        threads: [
          thread({
            startedBy: "a-human",
            startedByBot: false,
            severity: "unknown",
          }),
          thread({
            startedBy: "a-human",
            startedByBot: false,
            severity: "unknown",
          }),
          thread({
            startedBy: "healthy-bot",
            startedByBot: true,
            severity: "high",
          }),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.severityByAuthor["a-human"]).toBeUndefined();
    expect(m.severityByAuthor["healthy-bot"]!.total).toBe(1);
    // The denominator is the BOT thread count, not `threads.total` — reading
    // the share against the latter would dilute it by however many humans
    // happened to comment.
    expect(m.unknownSeverity).toEqual({ count: 0, total: 1, share: 0 });
    expect(m.threads.total).toBe(3);
    const out = renderLoopMetrics(m);
    expect(out).not.toContain("a-human:");
    expect(out).not.toContain("no longer recognized");
  });

  it("reports a null share when every thread is human — not measured, not 0%", () => {
    const m = computeLoopMetrics(
      sample({
        threads: [
          thread({
            startedBy: "a-human",
            startedByBot: false,
            severity: "unknown",
          }),
        ],
      }),
      null,
      new Set(),
    );
    expect(m.unknownSeverity).toEqual({ count: 0, total: 0, share: null });
  });

  it("has no per-category bucket at all when every thread is unanswered", () => {
    const m = computeLoopMetrics(
      sample({ threads: [thread({ outcome: null })] }),
      null,
      new Set(),
    );
    expect(m.outcomesByCategory).toEqual({});
  });
});

describe("renderLoopMetrics", () => {
  it("labels the merged diff as net so it is not read against the churn", () => {
    const m = computeLoopMetrics(
      sample({ additions: 2777, deletions: 45, changedFiles: 2 }),
      12,
      new Set(),
    );
    const out = renderLoopMetrics(m);
    expect(out).toContain("net, not churn");
    expect(out).toContain("this clone's durable drive count: 12");
  });

  it("omits the durable count when this clone does not hold it", () => {
    expect(
      renderLoopMetrics(computeLoopMetrics(sample(), null, new Set())),
    ).not.toContain("durable drive count");
  });

  // The whole point is that the outage is VISIBLE. A share nobody
  // prints is a share nobody reads.
  it("always prints the unreadable-severity share, even at zero", () => {
    const out = renderLoopMetrics(
      computeLoopMetrics(
        sample({ threads: [thread({ severity: "high" })] }),
        null,
        new Set(),
      ),
    );
    expect(out).toContain("severity");
    expect(out).toContain("0/1 bot findings unreadable (0.0%)");
    expect(out).toContain("INERT");
    // The metric's scope is stated in the output itself, not only in the
    // source comment — a reviewer's summary-only findings carry no severity
    // signal here at all (docomply-review, a reference-implementation pull request round 5).
    expect(out).toContain("inline threads only");
    // No per-author line for a reviewer with nothing unreadable — the one
    // line that matters must not be a needle in a list of healthy zeroes.
    expect(out).not.toContain("bot-app:");
  });

  it("names a reviewer at 100% unreadable, worst first, with the outage called out", () => {
    const out = renderLoopMetrics(
      computeLoopMetrics(
        sample({
          threads: [
            thread({ startedBy: "glyph-switcher", severity: "unknown" }),
            thread({ startedBy: "glyph-switcher", severity: "unknown" }),
            thread({ startedBy: "zz-occasional", severity: "unknown" }),
            thread({ startedBy: "zz-occasional", severity: "high" }),
          ],
        }),
        null,
        new Set(),
      ),
    );
    expect(out).toContain("glyph-switcher: 2/2 lifetime (100.0%)");
    expect(out).toContain("no longer recognized");
    expect(out).toContain("zz-occasional: 1/2 lifetime (50.0%)");
    // Worst first, despite `zz-occasional` sorting later alphabetically —
    // "one reviewer at 100%" is the signal and must lead.
    expect(out.indexOf("glyph-switcher:")).toBeLessThan(
      out.indexOf("zz-occasional:"),
    );
    // The 50% reviewer is a rate, not an outage: it must NOT carry the
    // fully-inert warning.
    expect(out.split("zz-occasional:")[1]).not.toContain(
      "no longer recognized",
    );
  });

  it("renders only current-round total severity outages for round-time triage", () => {
    const warnings = renderSeverityOutageWarnings(
      computeLoopMetrics(
        sample({
          reviews: [
            review("head-1", "2026-08-01T00:00:00Z", true, true, "broken-bot"),
            review("head-2", "2026-08-02T00:00:00Z", true, true, "broken-bot"),
            review("head-3", "2026-08-03T00:00:00Z", true, true, "healthy-bot"),
          ],
          threads: [
            // A readable earlier round must not dilute the current outage.
            thread({
              startedBy: "broken-bot",
              severity: "high",
              reviewedHeadOid: "head-1",
            }),
            thread({
              startedBy: "broken-bot",
              severity: "unknown",
              reviewedHeadOid: "head-2",
            }),
            // A known empty later round is measured clean, not borrowed from
            // the earlier unknown finding.
            thread({
              startedBy: "healthy-bot",
              severity: "unknown",
              reviewedHeadOid: "head-1",
            }),
            // Humans are deliberately outside the formatter-outage population.
            thread({
              startedByBot: false,
              startedBy: "reviewer",
              severity: "unknown",
              reviewedHeadOid: "head-3",
            }),
          ],
        }),
        null,
        new Set(),
      ),
    );
    expect(warnings).toContain("⚠ EVERY finding this round — broken-bot");
    expect(warnings).toContain("1/1 this round (100.0%)");
    expect(warnings).toContain("fully inert");
    expect(warnings).not.toContain("healthy-bot");
    expect(warnings).not.toContain("— reviewer:");
  });

  // docomply-review, a reference-implementation pull request round 1: the warning used to claim "EVERY
  // finding this round" even when `recentRoundKnown` is false and the outage
  // is actually a lifetime-only measurement with no attributable current
  // round — a misleading claim about what was measured.
  it("labels a lifetime-only outage as lifetime, not as a current round it never measured", () => {
    const warnings = renderSeverityOutageWarnings(
      computeLoopMetrics(
        sample({
          threads: [thread({ startedBy: "broken-bot", severity: "unknown" })],
        }),
        null,
        new Set(),
      ),
    );
    expect(warnings).toContain(
      "⚠ EVERY attributable finding over the PR lifetime — broken-bot",
    );
    expect(warnings).not.toContain("EVERY finding this round");
  });

  it("renders the per-category outcome breakdown, unknown sorted last", () => {
    const m = computeLoopMetrics(
      sample({
        threads: [
          thread({ outcome: "accepted", category: "security" }),
          thread({ outcome: "wont-fix", category: "unknown" }),
          thread({ outcome: "deferred", category: "docs" }),
        ],
      }),
      null,
      new Set(),
    );
    const out = renderLoopMetrics(m);
    expect(out).toContain("by category");
    expect(out).toContain("docs: deferred 1");
    expect(out).toContain("security: accepted 1");
    expect(out).toContain("unknown: wont-fix 1");
    // Named categories precede the residual `unknown` bucket.
    expect(out.indexOf("docs:")).toBeLessThan(out.indexOf("unknown:"));
    expect(out.indexOf("security:")).toBeLessThan(out.indexOf("unknown:"));
  });

  it("discloses excluded merges on the no-review path too", () => {
    // `sizeOf` drops merge churn on EVERY path, so a PR with no bot review yet
    // printed a commit count that already excluded them with nothing saying so
    // — a reader comparing it against the PR's commit list got no reason for
    // the disagreement.
    const m = computeLoopMetrics(
      sample({
        commits: [
          commit("c1", "2026-08-01T01:00:00Z", 10),
          commit("m1", "2026-08-01T02:00:00Z", 52015, 11463, 2),
        ],
        reviews: [],
      }),
      null,
      new Set(),
    );
    expect(m.attribution).toBe("none");
    expect(renderLoopMetrics(m)).toContain("merge commit excluded");
  });
});

describe("loop-metrics.ts CLI output — paired with the defect-escape anchor", () => {
  // `renderReport` is the function that COMPOSES the text `main()` writes to
  // stdout — pinned here directly, not rebuilt. This block does NOT by
  // itself prove `main()` still calls it: calling `renderReport` here
  // exercises only the composition, not the wiring that hands it `main()`'s
  // real inputs and writes its result to stdout (docomply-review, a reference-implementation pull request
  // round 1 — an earlier version of this comment claimed the opposite, which
  // was false: a regression reverting `main()`'s write call back to
  // `renderLoopMetrics(metrics)` directly left every test in this block
  // green). That wiring is pinned separately, below, via `runReport` — the
  // ONE place it lives now that `main()` is reduced to argv parsing plus a
  // single call into it. The anchor content itself (recorded figure vs. the
  // "unmeasured" marker, and the parsing rule) is pinned in
  // `escape-baseline.test.ts`.
  it("never prints the loop-economy block without the defect-escape anchor trailing it", () => {
    const m = computeLoopMetrics(sample(), null, new Set());
    const block = renderReport(m, null, false);
    expect(block).toContain("── loop economy");
    expect(block).toContain("defect-escape anchor");
    // The anchor is the LAST thing printed, after the economy block's own
    // final `merged` line — never interleaved or dropped.
    expect(block.indexOf("defect-escape anchor")).toBeGreaterThan(
      block.indexOf("merged"),
    );
  });

  it("degrades to the unmeasured marker without ever throwing or going silent", () => {
    // The best-effort contract an earlier change requires: a failing escape read must
    // degrade to the marker, never to an absent line and never to an
    // exception that could make a converged drive exit nonzero.
    const block = renderReport(
      computeLoopMetrics(sample(), null, new Set()),
      null,
      false,
    );
    expect(block).toContain("defect-escape anchor");
    expect(block).toContain("unmeasured for a current window");
  });

  it("the --json branch carries escapeBaseline alongside the metrics", () => {
    const m = computeLoopMetrics(sample(), null, new Set());
    const parsed = JSON.parse(renderReport(m, null, true));
    expect(parsed).toHaveProperty("escapeBaseline", null);
    expect(parsed).toHaveProperty("pr", m.pr);

    const baseline = {
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    };
    const parsedWithBaseline = JSON.parse(renderReport(m, baseline, true));
    expect(parsedWithBaseline.escapeBaseline).toEqual(baseline);
  });

  it("resolveEscapeBaseline resolves the recorded baseline of the repository it runs in", async () => {
    // No mocking of the lookup: `resolveEscapeBaseline` asks git for the
    // top level of the working directory and reads the document there — the
    // same production path `main()` uses — in a throwaway repository holding
    // the fixture document.
    const repo = mkdtempSync(join(tmpdir(), "loop-metrics-baseline-"));
    const cwd = process.cwd();
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env))
        if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
      expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(
        0,
      );
      const at = join(repo, BASELINE_DOC_PATH);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(
        at,
        readFileSync(
          join(import.meta.dir, "fixtures", "review-loop-baseline.md"),
          "utf8",
        ),
      );
      process.chdir(repo);
      const baseline = await resolveEscapeBaseline();
      expect(baseline).toEqual({
        escaped: 2,
        total: 90,
        since: "2026-09-01",
        until: "2026-09-08",
      });
    } finally {
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("runReport — the actual sequence `main` runs", () => {
  // Every dependency `runReport` calls is faked here — no `gh`, no network,
  // no filesystem — so this exercises the REAL composition `main()` delegates
  // to, not a hand-rebuilt copy: a regression reverting `runReport`'s own
  // `deps.write(renderReport(...))` call back to
  // `deps.write(renderLoopMetrics(metrics))` (dropping the escape anchor —
  // exactly the class of regression the describe block above cannot see)
  // fails the assertion below.
  function fakeDeps(over: Partial<ReportDeps> = {}): ReportDeps & {
    written: string[];
  } {
    const written: string[] = [];
    return {
      written,
      resolveRepo: async () => ({ owner: "example-org", name: "example-repo" }),
      samplePr: async () => sample(),
      durableRounds: async () => null,
      resolveSiblingCommitOids: async () => new Set<string>(),
      resolveEscapeBaseline: async () => null,
      write: (s: string) => {
        written.push(s);
      },
      ...over,
    };
  }

  it("writes a block carrying the defect-escape anchor, through the real sequence", async () => {
    const deps = fakeDeps();
    await runReport("1", false, deps);
    expect(deps.written).toHaveLength(1);
    expect(deps.written[0]).toContain("── loop economy");
    expect(deps.written[0]).toContain("defect-escape anchor");
  });

  it("threads the resolved escape baseline through to the written block", async () => {
    const baseline = {
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    };
    const deps = fakeDeps({ resolveEscapeBaseline: async () => baseline });
    await runReport("1", false, deps);
    expect(deps.written[0]).toContain("4/155");
  });

  it("the --json call site carries escapeBaseline alongside the metrics", async () => {
    const baseline = {
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    };
    const deps = fakeDeps({ resolveEscapeBaseline: async () => baseline });
    await runReport("1", true, deps);
    const parsed = JSON.parse(deps.written[0] ?? "");
    expect(parsed.escapeBaseline).toEqual(baseline);
  });

  it("calls each dependency exactly once, in the documented order", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      resolveRepo: async () => {
        order.push("resolveRepo");
        return { owner: "example-org", name: "example-repo" };
      },
      samplePr: async () => {
        order.push("samplePr");
        return sample();
      },
      durableRounds: async () => {
        order.push("durableRounds");
        return null;
      },
      resolveSiblingCommitOids: async () => {
        order.push("resolveSiblingCommitOids");
        return new Set<string>();
      },
      resolveEscapeBaseline: async () => {
        order.push("resolveEscapeBaseline");
        return null;
      },
    });
    await runReport("1", false, deps);
    expect(order).toEqual([
      "resolveRepo",
      "samplePr",
      "durableRounds",
      "resolveSiblingCommitOids",
      "resolveEscapeBaseline",
    ]);
  });

  it("reports round-time severity outages without collecting unrelated economy data", async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      resolveRepo: async () => {
        calls.push("resolveRepo");
        return { owner: "example-org", name: "example-repo" };
      },
      samplePr: async () => {
        calls.push("samplePr");
        return sample({
          threads: [thread({ startedBy: "broken-bot", severity: "unknown" })],
        });
      },
      durableRounds: async () => {
        calls.push("durableRounds");
        return null;
      },
      resolveSiblingCommitOids: async () => {
        calls.push("resolveSiblingCommitOids");
        return new Set<string>();
      },
      resolveEscapeBaseline: async () => {
        calls.push("resolveEscapeBaseline");
        return null;
      },
    });
    await runSeverityWarnings("1", deps);
    expect(calls).toEqual(["resolveRepo", "samplePr"]);
    // No `reviews` in this sample, so no round can be attributed —
    // the lifetime-fallback wording, not the current-round claim.
    expect(deps.written).toEqual([
      expect.stringContaining(
        "⚠ EVERY attributable finding over the PR lifetime — broken-bot",
      ),
    ]);
  });
});

describe("refindsFor — a recurrence needs ORDER, not just proximity", () => {
  const decline = thread({
    path: "a.ts",
    line: 100,
    outcome: "wont-fix",
    reason: "declined on effort",
    createdAt: "2026-08-05T00:00:00Z",
    settledAt: "2026-08-05T12:00:00Z",
  });

  function later(over: Partial<ThreadSample>, pr = 2): PrSample {
    return sample({ pr, threads: [thread({ path: "a.ts", ...over })] });
  }

  // `samePath` is mandatory — every test below that
  // wants plain exact-path matching states so explicitly, matching every
  // fixture's own unoverridden `path: 'a.ts'`. Takes the whole candidate
  // thread, not just its path — see `refindsFor`'s own doc.
  const exactPath = (candidate: ThreadSample): boolean =>
    candidate.path === "a.ts";

  it("counts an accepted thread raised after the decline was settled", () => {
    const [r] = refindsFor(
      decline,
      [later({ line: 105, createdAt: "2026-08-06T00:00:00Z" })],
      exactPath,
    );
    expect(r).toMatchObject({ pr: 2, proximate: true, after: true });
    expect(isRecurrence(r as Refind)).toBe(true);
  });

  it("does NOT count one raised before the decline, however close", () => {
    // The bug this rule exists for: a long-running PR receives its accepted
    // finding days before the decline is even posted, then merges after it. Merge
    // order says "later"; the timestamps say it cannot be that decline coming
    // back.
    const [r] = refindsFor(
      decline,
      [later({ line: 100, createdAt: "2026-08-01T00:00:00Z" })],
      exactPath,
    );
    expect(r).toMatchObject({ proximate: true, after: false });
    expect(isRecurrence(r as Refind)).toBe(false);
  });

  it("measures the ordering against the SETTLING reply, not the raising", () => {
    // Raised after the decline thread was opened but before we decided to ship
    // anyway — concurrent review, not a recurrence of a decision not yet taken.
    const [r] = refindsFor(
      decline,
      [later({ line: 100, createdAt: "2026-08-05T06:00:00Z" })],
      exactPath,
    );
    expect(r?.after).toBe(false);
  });

  it("falls back to when the decline was RAISED if it never settled a stamp", () => {
    const [r] = refindsFor(
      thread({ ...decline, settledAt: null }),
      [later({ line: 100, createdAt: "2026-08-05T06:00:00Z" })],
      exactPath,
    );
    expect(r?.after).toBe(true);
  });

  it("treats an equal timestamp as not later", () => {
    const [r] = refindsFor(
      decline,
      [later({ line: 100, createdAt: "2026-08-05T12:00:00Z" })],
      exactPath,
    );
    expect(r?.after).toBe(false);
  });

  it("fails CLOSED when either timestamp is unreadable", () => {
    expect(
      refindsFor(decline, [later({ line: 100, createdAt: null })], exactPath)[0]
        ?.after,
    ).toBe(false);
    expect(
      refindsFor(
        thread({ ...decline, createdAt: null, settledAt: null }),
        [later({ line: 100, createdAt: "2026-08-09T00:00:00Z" })],
        exactPath,
      )[0]?.after,
    ).toBe(false);
  });

  it("reports a far-away match without counting it", () => {
    const [r] = refindsFor(
      decline,
      [later({ line: 900, createdAt: "2026-08-09T00:00:00Z" })],
      exactPath,
    );
    // Still visible: suppressing it would hide the coincidences the proximity
    // rule exists to explain — plain same-file matching calls a large share of
    // declines re-found, almost all of it noise on a hot file. The measured
    // share is a published baseline result and lives in
    // `review-loop-baseline.md`; the figure once restated here had already
    // drifted from it (docomply-review round 9, a reference-implementation pull request).
    expect(r).toMatchObject({ proximate: false, after: true });
    expect(isRecurrence(r as Refind)).toBe(false);
  });

  it("ignores threads on another file, and non-accepted ones", () => {
    expect(
      refindsFor(decline, [later({ path: "b.ts", line: 100 })], exactPath),
    ).toHaveLength(0);
    expect(
      refindsFor(
        decline,
        [later({ line: 100, outcome: "rejected" })],
        exactPath,
      ),
    ).toHaveLength(0);
  });

  it("has nothing to match when the decline is unanchored", () => {
    expect(
      refindsFor(
        thread({ ...decline, path: null }),
        [later({ line: 100 })],
        exactPath,
      ),
    ).toHaveLength(0);
  });

  it("discards a renamed candidate when the caller supplies an exact-path matcher", () => {
    // A `samePath` resolver that only matches exact paths is the caller's own
    // choice to make no rename allowance — the mandatory-parameter fix (PR
    // #4104) does not change this outcome, only who is answerable for it.
    expect(
      refindsFor(decline, [later({ path: "b.ts", line: 105 })], exactPath),
    ).toHaveLength(0);
  });

  it("counts a renamed candidate as a recurrence when the caller supplies samePath", () => {
    // `defect-escape.ts` resolves this via git's own rename tracking
    // (`renameEquivalents`) before calling in; `lib/escape.ts` stays pinnable
    // without git by taking the resolved predicate as a plain function.
    const samePath = (candidate: ThreadSample) =>
      candidate.path === "a.ts" || candidate.path === "b.ts";
    const [r] = refindsFor(
      decline,
      [later({ path: "b.ts", line: 105, createdAt: "2026-08-06T00:00:00Z" })],
      samePath,
    );
    expect(r).toMatchObject({
      pr: 2,
      path: "b.ts",
      proximate: true,
      after: true,
    });
    expect(isRecurrence(r as Refind)).toBe(true);
  });

  it("still applies proximity and ordering to a renamed candidate", () => {
    // The rename resolver only widens WHICH paths count as the same file — it
    // does not bypass the other two axes a recurrence still needs.
    const samePath = (candidate: ThreadSample) =>
      candidate.path === "a.ts" || candidate.path === "b.ts";
    const [tooFar] = refindsFor(
      decline,
      [later({ path: "b.ts", line: 900, createdAt: "2026-08-06T00:00:00Z" })],
      samePath,
    );
    expect(tooFar).toMatchObject({ proximate: false });
    expect(isRecurrence(tooFar as Refind)).toBe(false);

    const [tooEarly] = refindsFor(
      decline,
      [later({ path: "b.ts", line: 105, createdAt: "2026-08-01T00:00:00Z" })],
      samePath,
    );
    expect(tooEarly).toMatchObject({ proximate: true, after: false });
    expect(isRecurrence(tooEarly as Refind)).toBe(false);
  });

  it("carries the exact-match path through unchanged", () => {
    // `path` on an ordinary (non-renamed) match equals the decline's own —
    // callers use a mismatch to detect a rename-traced hit.
    const [r] = refindsFor(
      decline,
      [later({ line: 105, createdAt: "2026-08-06T00:00:00Z" })],
      exactPath,
    );
    expect(r?.path).toBe("a.ts");
  });
});

describe("anchorLine — an outdated thread keeps its anchor", () => {
  it("prefers the current line", () => {
    expect(anchorLine(thread({ line: 42, originalLine: 7 }))).toBe(42);
  });

  it("falls back to originalLine once GitHub drops the current one", () => {
    // A thread goes outdated precisely when somebody acted on it, so matching
    // on `line` alone is blind exactly where a real fix is most likely — and
    // blind in a skewed direction, not a random one. How much of the
    // population that is, and how reliably `originalLine` survives, are
    // sampling results: `review-loop-baseline.md` owns them, and restating
    // either here is the second home that already went stale once.
    expect(anchorLine(thread({ line: null, originalLine: 7 }))).toBe(7);
  });

  it("is null only when neither exists", () => {
    expect(anchorLine(thread({ line: null, originalLine: null }))).toBeNull();
  });

  it("lets an outdated accepted thread be a recurrence", () => {
    // The regression this exists to stop: the accepted fix rewrote the hunk, so
    // the thread that proves the re-find is exactly the one with no `line`.
    const decline = thread({
      line: null,
      originalLine: 100,
      outcome: "wont-fix",
      settledAt: "2026-08-05T12:00:00Z",
    });
    const [r] = refindsFor(
      decline,
      [
        sample({
          pr: 2,
          threads: [
            thread({
              line: null,
              originalLine: 104,
              createdAt: "2026-08-06T00:00:00Z",
            }),
          ],
        }),
      ],
      (candidate) => candidate.path === decline.path,
    );
    expect(isRecurrence(r as Refind)).toBe(true);
    expect(r?.line).toBe(104);
  });
});

describe("count — a malformed number is an error, not a zero", () => {
  it("accepts a finite non-negative integer, zero included", () => {
    // Zero is legitimate and must stay so: a root commit really has no parents,
    // and a PR really can have no changed files.
    expect(count(0, "parents", 1)).toBe(0);
    expect(count(42, "additions", 1)).toBe(42);
  });

  it("refuses what it used to silently read as 0", () => {
    // The damage was not uniform. A missing `parents.totalCount` read as 0, and
    // `0 < 2`, so a commit of unknown shape counted as AUTHORED churn — the
    // +52,015-line mistake `sizeOf` exists to avoid.
    for (const bad of [undefined, null, "abc", {}, Number.NaN, 1.5, -1, ""]) {
      expect(() => count(bad, "commit.parents.totalCount", 4068)).toThrow();
    }
  });

  it("refuses the two shapes a coerce-first validator would have missed", () => {
    // `Number(null)` and `Number('')` are both 0 — an integer, and non-negative.
    // A validator that coerced before type-checking would have passed exactly
    // the shapes a missing GraphQL field arrives as, which is the defect intact.
    expect(() => count(null, "additions", 4068)).toThrow();
    expect(() => count("", "additions", 4068)).toThrow();
  });

  it("names the field and the PR so the error is actionable", () => {
    const said: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => {
      said.push(a.join(" "));
    };
    try {
      expect(() => count(undefined, "commit.additions", 4068)).toThrow();
    } finally {
      console.error = original;
    }
    expect(said.join("\n")).toContain("commit.additions");
    expect(said.join("\n")).toContain("4068");
  });
});

describe("threadFrom — withholding the outcome of an unreadable thread", () => {
  const node = { id: "T1", path: "a.ts", line: 10, isResolved: true };
  const comments = [
    {
      url: "https://example.invalid/1",
      authorAssociation: "MEMBER",
      createdAt: "2026-08-01T00:00:00Z",
      author: { login: "a-human", __typename: "User" },
      body: "the finding",
    },
    {
      url: "https://example.invalid/2",
      authorAssociation: "MEMBER",
      createdAt: "2026-08-01T01:00:00Z",
      author: { login: "a-human", __typename: "User" },
      body: "**accepted** — fixed it",
    },
  ];

  it("reads the outcome when the list is complete", () => {
    const t = threadFrom(node, comments, false);
    expect(t.outcome).toBe("accepted");
    expect(t.reason).toBe("fixed it");
    expect(t.settledAt).toBe("2026-08-01T01:00:00Z");
  });

  it("WITHHOLDS it when the list is truncated, same comments", () => {
    // The whole point: identical input, and the only difference is that a
    // later reply may exist unread. Asserting this on the producer is what a
    // consumer-side fixture cannot do — handing consumers a pre-nulled thread
    // pins how they treat a withheld outcome, not whether one is withheld.
    const t = threadFrom(node, comments, true);
    expect(t.outcome).toBeNull();
    expect(t.reason).toBeNull();
    expect(t.settledAt).toBeNull();
    // Everything that does NOT depend on the unread tail still survives.
    expect(t.createdAt).toBe("2026-08-01T00:00:00Z");
    expect(t.commentsTruncated).toBe(true);
    expect(t.path).toBe("a.ts");
  });

  it("ignores an outcome from an untrusted author", () => {
    const t = threadFrom(
      node,
      [{ ...comments[1]!, authorAssociation: "NONE" }],
      false,
    );
    expect(t.outcome).toBeNull();
  });

  it("reads category off the RAISING comment, never a later reply", () => {
    const t = threadFrom(
      node,
      [
        { ...comments[0]!, body: "🟡 **medium** · 🏷️ category: performance" },
        // The settling reply carries no category token of its own — reading
        // it here (instead of comments[0]!) would silently read `unknown`.
        comments[1]!,
      ],
      false,
    );
    expect(t.category).toBe("performance");
  });

  it("reads unknown when the raising comment carries no category tag", () => {
    const t = threadFrom(node, comments, false);
    expect(t.category).toBe("unknown");
  });

  // an earlier change, end to end from the raw comment body: a reviewer switching its
  // severity glyph is a one-line change on their side, and the whole point is
  // that it must surface as a measured `unknown` rate rather than as the
  // silence of "no findings declined".
  it("samples severity off the RAISING comment, and a switched glyph reads unknown", () => {
    const recognized = threadFrom(
      node,
      [{ ...comments[0]!, body: "🟡 **medium** · a finding" }, comments[1]!],
      false,
    );
    expect(recognized.severity).toBe("medium");

    // 🔺 (U+1F53A) is NOT in the matcher, deliberately — an earlier change narrowed it
    // to the coloured circles rather than admitting every emoji, and widening
    // it back is the more dangerous failure (a severity-less title read as a
    // real severity ARMS a ladder that should have stayed inert). What must
    // change is the SIGNAL, not the matcher.
    const switched = threadFrom(
      node,
      [{ ...comments[0]!, body: "🔺 **medium** · a finding" }, comments[1]!],
      false,
    );
    expect(switched.severity).toBe("unknown");

    // …and that is exactly what reaches the metric, per author, instead of
    // vanishing into "the ladder declined nothing this round".
    const m = computeLoopMetrics(
      sample({
        threads: [
          // `startedByBot` set explicitly: this fixture's author is a User,
          // and the metric counts BOT threads only (a human never had a
          // severity format to lose).
          { ...switched, startedBy: "glyph-switcher", startedByBot: true },
          { ...recognized, startedBy: "healthy-bot", startedByBot: true },
        ],
      }),
      null,
      new Set(),
    );
    expect(m.severityByAuthor["glyph-switcher"]!.unknownShare).toBe(1);
    expect(m.severityByAuthor["healthy-bot"]!.unknownShare).toBe(0);
    expect(renderLoopMetrics(m)).toContain(
      "glyph-switcher: 1/1 lifetime (100.0%)",
    );
  });

  it("withholds severity, like category, when the raising comment was edited after the cutoff", () => {
    const t = threadFrom(
      node,
      [
        {
          ...comments[0]!,
          body: "🟡 **medium** · a finding",
          lastEditedAt: "2026-08-20T00:00:00Z",
        },
      ],
      false,
      "2026-08-10T00:00:00Z",
    );
    // The body that stood at the cutoff is unrecoverable from GitHub's
    // always-current payload, so it is withheld rather than read at either
    // version — the same posture `category` already takes.
    expect(t.severity).toBe("unknown");
  });
});

describe("a truncated thread contributes no outcome to anything", () => {
  // `sample.ts` withholds `outcome` while the comment list is incomplete, so
  // the guarantee is expressible here: a truncated thread reaches every
  // consumer with `outcome: null` and therefore cannot move a count.
  const truncated = thread({ outcome: null, commentsTruncated: true });

  it("counts as unanswered rather than as its prefix guess", () => {
    const m = computeLoopMetrics(
      sample({ threads: [truncated] }),
      null,
      new Set(),
    );
    expect(m.unanswered).toBe(1);
    expect(m.answered).toBe(0);
    expect(m.acceptedShare).toBeNull();
    expect(m.outcomes.accepted).toBe(0);
  });

  it("cannot supersede a decline", () => {
    // The consequence that made this worth fixing: `supersededInOwnPr` DROPS a
    // decline from the escape denominator, so a guessed `accepted` here would
    // silently move the published rate.
    const decline = thread({
      line: 100,
      outcome: "wont-fix",
      settledAt: "2026-08-05T12:00:00Z",
    });
    expect(
      supersededCandidateInOwnPr(decline, [
        { ...truncated, line: 103, createdAt: "2026-08-05T18:00:00Z" },
      ]),
    ).toBe(false);
  });

  it("cannot be a re-find", () => {
    const decline = thread({
      line: 100,
      outcome: "wont-fix",
      settledAt: "2026-08-05T12:00:00Z",
    });
    expect(
      refindsFor(
        decline,
        [
          sample({
            pr: 2,
            threads: [
              { ...truncated, line: 103, createdAt: "2026-08-06T00:00:00Z" },
            ],
          }),
        ],
        (candidate) => candidate.path === decline.path,
      ),
    ).toHaveLength(0);
  });
});

describe("supersededCandidateInOwnPr — a REPORTED signal, never a silent drop", () => {
  const decline = thread({
    path: "a.ts",
    line: 100,
    outcome: "wont-fix",
    settledAt: "2026-08-05T12:00:00Z",
  });

  it("flags a decline whose own PR later accepted a proximate finding", () => {
    // Flags, not drops: measured over the baseline week's 30 candidates, the
    // decline and its "superseding" acceptance were usually DIFFERENT findings.
    // The caller reports this for adjudication and keeps the decline counted.
    expect(
      supersededCandidateInOwnPr(decline, [
        decline,
        thread({ line: 103, createdAt: "2026-08-05T18:00:00Z" }),
      ]),
    ).toBe(true);
  });

  it("does not flag one whose same-PR acceptance predates the decline", () => {
    expect(
      supersededCandidateInOwnPr(decline, [
        decline,
        thread({ line: 103, createdAt: "2026-08-05T06:00:00Z" }),
      ]),
    ).toBe(false);
  });

  it("does not flag one whose same-PR acceptance is elsewhere in the file", () => {
    expect(
      supersededCandidateInOwnPr(decline, [
        decline,
        thread({ line: 900, createdAt: "2026-08-06T00:00:00Z" }),
      ]),
    ).toBe(false);
  });

  it("is not satisfied by the decline thread itself", () => {
    expect(supersededCandidateInOwnPr(decline, [decline])).toBe(false);
  });

  it("fails closed on an unanchored or undated decline", () => {
    const acceptedLater = thread({
      line: 100,
      createdAt: "2026-08-09T00:00:00Z",
    });
    expect(
      supersededCandidateInOwnPr(thread({ ...decline, line: null }), [
        acceptedLater,
      ]),
    ).toBe(false);
    expect(
      supersededCandidateInOwnPr(
        thread({ ...decline, settledAt: null, createdAt: null }),
        [acceptedLater],
      ),
    ).toBe(false);
  });
});

describe("loop-metrics.ts CLI", () => {
  it("refuses an unknown flag rather than ignoring it", () => {
    const p = Bun.spawnSync([process.execPath, SCRIPT, "--nope"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("unknown flag");
  });

  it("refuses a second PR argument instead of silently taking the last", () => {
    // `loop-metrics.ts 4052 4053` used to measure 4053 and say nothing — a
    // mistyped invocation reporting a real, confident answer about the wrong
    // pull request.
    const p = Bun.spawnSync([process.execPath, SCRIPT, "4052", "4053"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("second PR argument");
  });
});

describe("initiatingFromPrefix — what a first page of comments settles", () => {
  const reply = { replyTo: { id: "x" } };
  const own = {};

  it("counts a review with a real body as initiating", () => {
    expect(initiatingFromPrefix("found a bug", [reply], false)).toBe(true);
  });

  it("does NOT count a whitespace-only body as having said something", () => {
    // `' '` and bare line breaks are not a review body. Untrimmed, they made a
    // pure thread-reply read as initiating, inflating `reviewedHeads` and
    // potentially moving `firstReviewedHead` — the commit boundary the whole
    // attribution split hangs off (docomply-review round 6, a reference-implementation pull request).
    expect(initiatingFromPrefix(" ", [reply], false)).toBe(false);
    expect(initiatingFromPrefix("\n\t \r\n", [reply], false)).toBe(false);
    expect(initiatingFromPrefix("", [reply], false)).toBe(false);
    expect(initiatingFromPrefix(null, [reply], false)).toBe(false);
  });

  it("counts one non-reply comment as initiating, body or not", () => {
    expect(initiatingFromPrefix("", [reply, own], false)).toBe(true);
    expect(initiatingFromPrefix("  ", [own], false)).toBe(true);
  });

  it("settles reply-only as false ONLY when the prefix is the whole list", () => {
    expect(initiatingFromPrefix("", [reply, reply], false)).toBe(false);
  });

  it("refuses to settle reply-only when more comments exist", () => {
    // `comments(first:100)` is a nested connection that `graphqlPages` does not
    // follow, so an all-replies prefix proves nothing about comment 101. Read
    // as `false`, it dropped a genuinely reviewed head (docomply-review round 6
    // / backlog f6bcdc9ee45116ee, PR #4068).
    expect(initiatingFromPrefix("", [reply, reply], true)).toBe("unresolved");
  });

  it("does not pay for a top-up the prefix already answered", () => {
    // Both settle on the first page even with more to read: the whole point of
    // returning a verdict rather than always topping up.
    expect(initiatingFromPrefix("a body", [reply], true)).toBe(true);
    expect(initiatingFromPrefix("", [own], true)).toBe(true);
  });
});

describe("threadFrom — asOf freezes a recorded window", () => {
  const comment = (createdAt: string, body: string) => ({
    url: "https://example.invalid/c",
    authorAssociation: "MEMBER",
    createdAt,
    author: { login: "a-human", __typename: "User" },
    body,
  });
  const raw = { id: "t1", path: "a.ts", line: 4, isResolved: true };

  it("reads the latest reply when no cutoff is given", () => {
    const t = threadFrom(
      raw,
      [
        comment("2026-08-10T00:00:00Z", "**wont-fix** — declined"),
        comment("2026-08-20T00:00:00Z", "**accepted** — changed my mind"),
      ],
      false,
    );
    expect(t.outcome).toBe("accepted");
  });

  it("ignores a reply posted after the cutoff", () => {
    // The defect: a trusted participant edits or adds an outcome AFTER the
    // window closed, and every later re-run of that recorded window reports a
    // different outcome mix, denominator and escape rate — for a window whose
    // whole promise is that it re-measures identically.
    const t = threadFrom(
      raw,
      [
        comment("2026-08-10T00:00:00Z", "**wont-fix** — declined"),
        comment("2026-08-20T00:00:00Z", "**accepted** — changed my mind"),
      ],
      false,
      "2026-08-13T23:59:59Z",
    );
    expect(t.outcome).toBe("wont-fix");
  });

  it("excludes an undateable comment under a cutoff rather than admitting it", () => {
    // It cannot be shown to predate the boundary, so admitting it would
    // reintroduce the drift the cutoff exists to stop.
    const undateable = {
      ...comment("2026-08-10T00:00:00Z", "**accepted** — no timestamp"),
      createdAt: null,
    };
    expect(
      threadFrom(raw, [undateable], false, "2026-08-13T23:59:59Z").outcome,
    ).toBeNull();
    // ...but with no cutoff in play it is read as usual.
    expect(threadFrom(raw, [undateable], false).outcome).toBe("accepted");
  });

  it("still withholds a truncated thread regardless of cutoff", () => {
    const t = threadFrom(
      raw,
      [comment("2026-08-10T00:00:00Z", "**wont-fix** — declined")],
      true,
      "2026-08-13T23:59:59Z",
    );
    expect(t.outcome).toBeNull();
  });
});

describe("asOf survives comment EDITS, and stamp rejects junk (round 11)", () => {
  const c = (
    createdAt: string,
    body: string,
    lastEditedAt: string | null = null,
  ) => ({
    url: "https://example.invalid/c",
    authorAssociation: "MEMBER",
    createdAt,
    lastEditedAt,
    author: { login: "a-human", __typename: "User" },
    body,
  });
  const raw = { id: "t1", path: "a.ts", line: 4, isResolved: true };
  const CUT = "2026-08-13T23:59:59Z";

  it("drops a pre-cutoff reply that was EDITED after the cutoff", () => {
    // createdAt alone freezes nothing: GitHub keeps the original creation time
    // and returns the CURRENT body, so an in-place reword after the window
    // would smuggle a post-window outcome into a recorded denominator.
    const t = threadFrom(
      raw,
      [
        c("2026-08-10T00:00:00Z", "**wont-fix** — declined"),
        c(
          "2026-08-11T00:00:00Z",
          "**accepted** — reworded later",
          "2026-08-20T00:00:00Z",
        ),
      ],
      false,
      CUT,
    );
    expect(t.outcome).toBe("wont-fix");
  });

  it("keeps a reply edited BEFORE the cutoff", () => {
    const t = threadFrom(
      raw,
      [
        c(
          "2026-08-10T00:00:00Z",
          "**accepted** — fixed",
          "2026-08-11T00:00:00Z",
        ),
      ],
      false,
      CUT,
    );
    expect(t.outcome).toBe("accepted");
  });

  it("drops a comment whose lastEditedAt is unreadable", () => {
    const t = threadFrom(
      raw,
      [c("2026-08-10T00:00:00Z", "**accepted** — fixed", "not-a-date")],
      false,
      CUT,
    );
    expect(t.outcome).toBeNull();
  });

  it("ignores lastEditedAt entirely when no cutoff is in play", () => {
    const t = threadFrom(
      raw,
      [
        c(
          "2026-08-10T00:00:00Z",
          "**accepted** — fixed",
          "2026-08-20T00:00:00Z",
        ),
      ],
      false,
    );
    expect(t.outcome).toBe("accepted");
  });

  it("refuses a malformed timestamp instead of letting it sort last", () => {
    // `"zzz"` compares greater than every real ISO instant, so an unvalidated
    // stamp could manufacture a recurrence out of a malformed payload.
    const t = threadFrom(
      { ...raw },
      [c("zzz", "**accepted** — junk stamp")],
      false,
    );
    expect(t.createdAt).toBeNull();
    expect(
      threadFrom(
        { ...raw },
        [c("2026-08-10T00:00:00Z", "**accepted** — ok")],
        false,
      ).createdAt,
    ).toBe("2026-08-10T00:00:00Z");
  });

  it("withholds category when the RAISING comment was edited after the cutoff (chatgpt-codex-connector, a reference-implementation pull request)", () => {
    // The raising comment's category had the identical bug the settlement
    // filter already guards against: GitHub returns the current body
    // regardless of asOf, so an edit after the cutoff can retroactively
    // change what category a historical re-measurement reports.
    const t = threadFrom(
      raw,
      [
        c(
          "2026-08-10T00:00:00Z",
          "🟡 **medium** · 🏷️ category: security",
          "2026-08-20T00:00:00Z",
        ),
      ],
      false,
      CUT,
    );
    expect(t.category).toBe("unknown");
    // ...but with no cutoff in play the current body is read as usual.
    expect(
      threadFrom(
        raw,
        [
          c(
            "2026-08-10T00:00:00Z",
            "🟡 **medium** · 🏷️ category: security",
            "2026-08-20T00:00:00Z",
          ),
        ],
        false,
      ).category,
    ).toBe("security");
  });

  it("keeps category from a raising comment edited BEFORE the cutoff", () => {
    const t = threadFrom(
      raw,
      [
        c(
          "2026-08-10T00:00:00Z",
          "🟡 **medium** · 🏷️ category: security",
          "2026-08-11T00:00:00Z",
        ),
      ],
      false,
      CUT,
    );
    expect(t.category).toBe("security");
  });

  it("withholds category when the RAISING comment was CREATED after the cutoff — the createdAt half recoverableAsOf alone missed (chatgpt-codex-connector, a reference-implementation pull request round 5)", () => {
    // Nothing requires a thread's first comment to predate an arbitrary
    // later cutoff. A raising comment posted after CUT and never edited
    // passes `recoverableAsOf` vacuously (`lastEditedAt` is null), so the
    // category guard needs the same `createdAt` check the settlement filter
    // already has — this is what `usableAsOf` closes.
    const t = threadFrom(
      raw,
      [c("2026-08-20T00:00:00Z", "🟡 **medium** · 🏷️ category: security")],
      false,
      CUT,
    );
    expect(t.category).toBe("unknown");
  });

  it("withholds category when the RAISING comment has an unreadable createdAt", () => {
    const t = threadFrom(
      raw,
      [
        {
          ...c("2026-08-10T00:00:00Z", "🟡 **medium** · 🏷️ category: security"),
          createdAt: null,
        },
      ],
      false,
      CUT,
    );
    expect(t.category).toBe("unknown");
  });

  it("excludes a comment created marginally AFTER the cutoff even when its fractional-second suffix sorts lexically BEFORE the cutoff string (coderabbitai, PR #4527 review round 2)", () => {
    // Chronologically 0.5s after CUT ('...59Z', no fraction) — but as a
    // STRING, '...59.5Z' sorts BEFORE '...59Z' (`.` < `Z` in ASCII), so a
    // lexical `<=`/`>` comparison reads this as at-or-before the cutoff.
    // `usableAsOf`/`recoverableAsOf` must parse both sides to epoch ms before
    // comparing rather than comparing the ISO strings directly.
    const t = threadFrom(
      raw,
      [c("2026-08-13T23:59:59.5Z", "🟡 **medium** · 🏷️ category: security")],
      false,
      CUT,
    );
    expect(t.category).toBe("unknown");
  });

  it("drops a reply edited marginally AFTER the cutoff even when the edit timestamp sorts lexically before it", () => {
    // Same lexical-vs-chronological gap as the createdAt case above, through
    // `recoverableAsOf`'s `lastEditedAt` comparison instead.
    const t = threadFrom(
      raw,
      [
        c("2026-08-10T00:00:00Z", "**wont-fix** — declined"),
        c(
          "2026-08-11T00:00:00Z",
          "**accepted** — reworded later",
          "2026-08-13T23:59:59.5Z",
        ),
      ],
      false,
      CUT,
    );
    expect(t.outcome).toBe("wont-fix");
  });
});
