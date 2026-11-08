/**
 * The Ready predicate: each condition and each row of the placement table
 * (design/dispatch-board.md § Ready, exactly), the merge command's strict
 * forms, and the order within Ready to merge.
 */
import { describe, expect, it } from "bun:test";
import { parseAnswer } from "../scripts/lib/merge-facts.ts";
import {
  checkPattern,
  type MergeFacts,
  mergeCommand,
  type ReadyRules,
  readiness,
  readyOrder,
} from "../scripts/lib/merge-ready.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

const RULES: ReadyRules = {
  reviewerApp: "example-review",
  reviewerCheck: checkPattern("^ai[ _-]?review(\\s*\\(.+\\))?$"),
  ciHoldLabel: "ci:hold",
};

/** A converged pull request the reviewer app checked, mergeable and clean. */
function facts(over: Partial<MergeFacts> = {}): MergeFacts {
  return {
    slug: "example-org/example-repo",
    number: 12,
    head: HEAD,
    converged: true,
    verifiedSha: HEAD,
    held: false,
    draft: false,
    mergeable: "MERGEABLE",
    mergeState: "CLEAN",
    mergeQueue: false,
    reviewDecision: null,
    authorAssociation: "MEMBER",
    labels: [],
    unresolvedThreads: 0,
    checks: [
      {
        name: "AI review",
        app: "example-review",
        required: false,
        state: "success",
        startedAt: "2026-11-08T10:00:00Z",
      },
      {
        name: "test",
        app: "github-actions",
        required: true,
        state: "success",
        startedAt: "2026-11-08T10:00:00Z",
      },
    ],
    reviews: [],
    requested: [],
    methods: { squash: true, merge: true, rebase: false },
    partial: null,
    ...over,
  };
}

const at = (over: Partial<MergeFacts>, rules = RULES) =>
  readiness(facts(over), rules);

describe("merge now", () => {
  it("places a converged, witnessed, mergeable pull request in merge now with its pinned command", () => {
    const r = at({});
    expect([r.place, r.lane]).toEqual(["ready", "merge-now"]);
    expect(r.waitsOn).toEqual({ kind: "person", act: "merge" });
    expect(r.command).toBe(
      `gh pr merge 12 --repo example-org/example-repo --match-head-commit ${HEAD} --squash`,
    );
    expect(r.conditions.every((c) => c.met === true)).toBe(true);
  });

  it("names no method where the base requires a merge queue, and places by the queue, not the merge state", () => {
    const r = at({ mergeQueue: true, mergeState: "BLOCKED" });
    expect(r.lane).toBe("merge-now");
    expect(r.command).toBe(
      `gh pr merge 12 --repo example-org/example-repo --match-head-commit ${HEAD}`,
    );
  });

  it("takes a person's approval of the head as the witness where no reviewer app is named", () => {
    const rules = { ...RULES, reviewerApp: null };
    const approved = at(
      {
        reviews: [
          {
            author: "maintainer",
            person: true,
            state: "APPROVED",
            commit: HEAD,
          },
        ],
      },
      rules,
    );
    expect(approved.lane).toBe("merge-now");
    const stale = at(
      {
        reviews: [
          {
            author: "maintainer",
            person: true,
            state: "APPROVED",
            commit: OTHER,
          },
        ],
      },
      rules,
    );
    expect(stale.lane).toBe("approve-first");
  });
});

describe("the ledger alone never reaches merge now", () => {
  it("puts a head its reviewer never checked in Needs you, whatever the ledger says", () => {
    const r = at({ checks: [] });
    expect([r.place, r.lane]).toEqual(["needs-you", null]);
    expect(r.waitsOn).toEqual({ kind: "person", act: "re-arm" });
    expect(r.says).toContain("not witnessed on this head");
    expect(r.command).toBeNull();
  });

  it("does not count the app's other checks, nor a skipped or failed review", () => {
    const other = at({
      checks: [
        {
          name: "AI review telemetry",
          app: "example-review",
          required: false,
          state: "success",
          startedAt: null,
        },
      ],
    });
    expect(other.place).toBe("needs-you");
    for (const state of ["skipped", "failure"] as const) {
      const r = at({
        checks: [
          {
            name: "AI review",
            app: "example-review",
            required: false,
            state,
            startedAt: null,
          },
        ],
      });
      expect(r.place).toBe("needs-you");
    }
  });

  it("does not count a check of the reviewer's name another app posted", () => {
    const r = at({
      checks: [
        {
          name: "AI review",
          app: "github-actions",
          required: false,
          state: "success",
          startedAt: null,
        },
      ],
    });
    expect(r.place).toBe("needs-you");
  });

  it("asks an outside author's pull request for a person's approval", () => {
    const r = at({ authorAssociation: "CONTRIBUTOR" });
    expect([r.place, r.lane]).toEqual(["ready", "approve-first"]);
    expect(r.waitsOn).toEqual({ kind: "person", act: "request-review" });
  });
});

describe("the placement table, first match", () => {
  const rows: Array<[string, Partial<MergeFacts>, string, string | null]> = [
    ["a draft", { draft: true }, "needs-you", "mark-ready"],
    ["the CI hold label", { labels: ["ci:hold"] }, "needs-you", "remove-label"],
    ["a person's hold", { held: true }, "needs-you", "remove-label"],
    ["an unresolved thread", { unresolvedThreads: 2 }, "needs-you", "answer"],
    [
      "changes requested",
      { reviewDecision: "CHANGES_REQUESTED" },
      "needs-you",
      "re-arm",
    ],
    [
      "a check failing",
      {
        mergeState: "BLOCKED",
        checks: [
          ...facts().checks,
          {
            name: "lint",
            app: "github-actions",
            required: true,
            state: "failure",
            startedAt: null,
          },
        ],
      },
      "needs-you",
      "re-run-check",
    ],
    [
      "a required check running",
      {
        mergeState: "BLOCKED",
        checks: [
          ...facts().checks,
          {
            name: "lint",
            app: "github-actions",
            required: true,
            state: "pending",
            startedAt: null,
          },
        ],
      },
      "stay",
      null,
    ],
    [
      "the forge still computing",
      { mergeable: "UNKNOWN", mergeState: "UNKNOWN" },
      "stay",
      null,
    ],
    ["behind its base", { mergeState: "BEHIND" }, "ready", "update-branch"],
    [
      "a required review",
      { mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" },
      "ready",
      "request-review",
    ],
    [
      "blocked for no read reason",
      { mergeState: "BLOCKED" },
      "needs-you",
      "open-pr",
    ],
    ["a head past the verified one", { head: OTHER }, "coming", null],
    [
      "a conflict",
      { mergeable: "CONFLICTING", mergeState: "DIRTY" },
      "coming",
      null,
    ],
    [
      "read in part",
      { partial: "more checks than one read holds" },
      "stay",
      null,
    ],
    ["not converged", { converged: false }, "stay", null],
  ];
  for (const [name, over, place, act] of rows)
    it(`places ${name}`, () => {
      const r = at(over);
      expect(r.place).toBe(place as typeof r.place);
      expect(r.waitsOn.kind === "person" ? r.waitsOn.act : null).toBe(
        act as never,
      );
    });

  it("names a failing check, never the reviewer's own", () => {
    const r = at({
      mergeState: "UNSTABLE",
      checks: [
        ...facts().checks,
        {
          name: "lint",
          app: "github-actions",
          required: false,
          state: "failure",
          startedAt: null,
        },
      ],
    });
    expect(r.failing).toEqual(["lint"]);
  });

  it("puts a held pull request ahead of its failing checks: held, never failing", () => {
    const r = at({
      labels: ["ci:hold"],
      mergeState: "BLOCKED",
      checks: [
        ...facts().checks,
        {
          name: "test",
          app: "github-actions",
          required: true,
          state: "failure",
          startedAt: null,
        },
      ],
    });
    expect(r.says).toContain("held");
    expect(r.waitsOn).toEqual({ kind: "person", act: "remove-label" });
  });

  it("names who was asked in approve first, and that other protection rules are unread", () => {
    const r = at({
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
      requested: ["reviewer-one", "platform-team"],
    });
    expect([r.lane, r.waitsOn]).toEqual([
      "approve-first",
      { kind: "person", act: "approve" },
    ]);
    expect(r.says).toContain("requested from reviewer-one, platform-team");
    expect(r.says).toContain(
      "not read the repository's other protection rules",
    );
    const nobody = at({
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(nobody.says).toContain("nobody is asked");
  });

  it("says in update next that an approval is still owed", () => {
    const r = at({ mergeState: "BEHIND", authorAssociation: "CONTRIBUTOR" });
    expect(r.lane).toBe("update-next");
    expect(r.says).toContain("an approval is still owed");
  });
});

describe("the merge command's strict forms", () => {
  it("withholds the command over a value that fails its form, and says which", () => {
    expect(mergeCommand(facts({ slug: "x; rm -rf /" }))).toEqual({
      command: null,
      withheld: "the repository's name",
    });
    expect(mergeCommand(facts({ verifiedSha: "ABC" })).withheld).toBe(
      "the verified head",
    );
    expect(mergeCommand(facts({ number: -1 })).withheld).toBe(
      "the pull request's number",
    );
    expect(
      mergeCommand(
        facts({ methods: { squash: false, merge: false, rebase: false } }),
      ).withheld,
    ).toContain("allows none");
  });

  it("takes the first method the repository allows", () => {
    expect(
      mergeCommand(
        facts({ methods: { squash: false, merge: true, rebase: true } }),
      ).command,
    ).toEndWith("--merge");
  });
});

describe("the order within Ready to merge", () => {
  it("orders by lane, then those that unblock others, then the longest wait", () => {
    const cards = [
      {
        number: 1,
        lane: "approve-first" as const,
        since: "2026-11-01",
        unblocks: [],
      },
      {
        number: 2,
        lane: "merge-now" as const,
        since: "2026-11-05",
        unblocks: [],
      },
      {
        number: 3,
        lane: "merge-now" as const,
        since: "2026-11-07",
        unblocks: [9],
      },
      {
        number: 4,
        lane: "merge-now" as const,
        since: "2026-11-02",
        unblocks: [],
      },
    ];
    expect(readyOrder(cards).map((c) => c.number)).toEqual([3, 4, 2, 1]);
  });
});

describe("the forge's facts", () => {
  it("reads a pull request whose connection has another page as partial, never whole", () => {
    const node = {
      number: 12,
      headRefOid: HEAD,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      authorAssociation: "MEMBER",
      reviewThreads: {
        pageInfo: { hasNextPage: true },
        nodes: [{ isResolved: false }],
      },
      commits: { nodes: [] },
    };
    const read = parseAnswer(
      { data: { repository: { squashMergeAllowed: true, pr12: node } } },
      [12],
    );
    const pull = read.pulls.get(12);
    expect(pull?.partial).toContain("review threads");
    expect(pull?.unresolvedThreads).toBe(1);
    expect(at({ ...pull, partial: pull?.partial ?? null }).place).toBe("stay");
  });

  it("reads check runs and commit statuses with their app and state", () => {
    const node = {
      number: 12,
      headRefOid: HEAD,
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "AI review",
                      status: "COMPLETED",
                      conclusion: "NEUTRAL",
                      startedAt: "2026-11-08T10:00:00Z",
                      isRequired: false,
                      checkSuite: { app: { slug: "example-review" } },
                    },
                    {
                      __typename: "CheckRun",
                      name: "test",
                      status: "IN_PROGRESS",
                      isRequired: true,
                    },
                    {
                      __typename: "StatusContext",
                      context: "deploy",
                      state: "ERROR",
                      isRequired: false,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    };
    const pull = parseAnswer(
      { data: { repository: { pr12: node } } },
      [12],
    ).pulls.get(12);
    expect(
      pull?.checks.map((c) => [c.name, c.app, c.state, c.required]),
    ).toEqual([
      ["AI review", "example-review", "neutral", false],
      ["test", null, "pending", true],
      ["deploy", null, "failure", false],
    ]);
  });
});
