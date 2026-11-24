/**
 * The Ready predicate: each condition and each row of the placement table
 * (design/dispatch-board.md § Ready, exactly), the merge command's strict
 * forms, and the order within Ready to merge.
 */
import { describe, expect, it } from "bun:test";
import { parseAnswer } from "../scripts/lib/merge-facts.ts";
import {
  checkPattern,
  type HeadCheck,
  type MergeFacts,
  mergeCommand,
  type ReadyRules,
  readiness,
  readyOrder,
} from "../scripts/lib/merge-ready.ts";
import { trustedAutomationOf } from "../scripts/lib/trusted-automation.ts";
import { ok } from "../../../shared/outcome.ts";

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
            association: "MEMBER",
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
            association: "MEMBER",
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

describe("whose approval counts", () => {
  const rules = { ...RULES, reviewerApp: null };
  const approval = (association: string) => ({
    author: "someone",
    person: true,
    association,
    state: "APPROVED",
    commit: HEAD,
  });

  it("does not take an approval from an account outside the repository as the witness", () => {
    expect(at({ reviews: [approval("NONE")] }, rules).lane).toBe(
      "approve-first",
    );
  });

  it("does not let an outside author's second account approve it into merge now", () => {
    const r = at({
      authorAssociation: "CONTRIBUTOR",
      reviews: [approval("CONTRIBUTOR")],
    });
    expect(r.lane).toBe("approve-first");
  });

  it("takes a collaborator's approval for an outside author", () => {
    const r = at({
      authorAssociation: "CONTRIBUTOR",
      reviews: [approval("COLLABORATOR")],
    });
    expect(r.lane).toBe("merge-now");
  });
});

describe("the review witness, run by run", () => {
  it("does not carry a review while its replacement is still running", () => {
    const r = at({
      reviewCarriedFrom: OTHER,
      checks: [
        {
          name: "AI review",
          app: "example-review",
          required: false,
          state: "pending",
          startedAt: null,
        },
      ],
    });
    expect(r.place).toBe("needs-you");
  });

  it("explains when a carried review cannot be checked without a checkout", () => {
    const r = at({ checks: [], reviewCarriedUnavailable: true });
    expect(r.says).toContain("could not be verified without a checkout");
  });

  it("takes a reviewer run not started yet as the newest, over an older success", () => {
    const r = at({
      checks: [
        {
          name: "AI review",
          app: "example-review",
          required: false,
          state: "success",
          startedAt: "2026-11-08T09:00:00Z",
        },
        {
          name: "AI review",
          app: "example-review",
          required: false,
          state: "pending",
          startedAt: null,
        },
      ],
    });
    expect(r.place).toBe("needs-you");
  });

  it("does not carry a review when duplicate reviewer attempts have unreadable ordering", () => {
    const r = at({
      reviewCarriedFrom: OTHER,
      checks: [
        {
          name: "AI review",
          app: "example-review",
          required: false,
          state: "success",
          startedAt: "2026-11-08T09:00:00Z",
        },
        {
          name: "AI review",
          app: "example-review",
          required: false,
          state: "pending",
          startedAt: null,
        },
      ],
    });
    expect(r.place).toBe("needs-you");
    expect(r.says).toContain("attempt order on this head could not be read");
  });

  it("keeps a required review owed under a merge queue", () => {
    const r = at({ mergeQueue: true, reviewDecision: "REVIEW_REQUIRED" });
    expect(r.lane).toBe("approve-first");
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

  it("reads checks read on another commit than the head as partial", () => {
    const node = {
      number: 12,
      headRefOid: HEAD,
      commits: { nodes: [{ commit: { oid: OTHER, statusCheckRollup: null } }] },
    };
    const pull = parseAnswer(
      { data: { repository: { pr12: node } } },
      [12],
    ).pulls.get(12);
    expect(pull?.partial).toContain("another commit");
  });

  it("does not treat a null check rollup without its commit ID as complete", () => {
    const node = {
      number: 12,
      headRefOid: HEAD,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    };
    const pull = parseAnswer(
      { data: { repository: { pr12: node } } },
      [12],
    ).pulls.get(12);
    expect(pull?.partial).toContain("not read on the head commit");
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
                  pageInfo: { hasNextPage: false },
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

describe("required checks and reviewer attempts", () => {
  it("waits on required queue checks, even when approval is owed", () => {
    for (const reviewDecision of [null, "REVIEW_REQUIRED"]) {
      const f = facts({
        mergeQueue: true,
        mergeState: "BLOCKED",
        reviewDecision,
      });
      f.checks = f.checks.map((c, i) =>
        i === 1 ? { ...c, state: "pending" } : c,
      );
      expect(readiness(f, RULES).place).toBe("stay");
    }
  });
  it("ignores an earlier required reviewer attempt the later attempt replaced", () => {
    const f = facts({ mergeState: "BLOCKED" });
    const [review, ci] = f.checks as [HeadCheck, HeadCheck];
    f.checks = [
      { ...review, id: 1, required: true, state: "pending" },
      { ...review, id: 2, required: true, state: "success" },
      ci,
    ];
    const r = readiness(f, RULES);
    expect([r.place, r.waitsOn]).toEqual([
      "needs-you",
      { kind: "person", act: "open-pr" },
    ]);
  });
  it("lets an optional failure of another app's check with a reviewer check's name not override CLEAN", () => {
    const f = facts({ mergeState: "CLEAN" });
    const [review, ci] = f.checks as [HeadCheck, HeadCheck];
    f.checks = [
      { ...review, id: 1, required: true, state: "failure" },
      { ...review, id: 2, required: true, state: "success" },
      {
        ...ci,
        name: review.name,
        app: "other-ci",
        required: false,
        state: "failure",
      },
    ];
    const r = readiness(f, RULES);
    expect([r.place, r.lane]).toEqual(["ready", "merge-now"]);
  });
  it("names the required failures, not the optional ones, when they override CLEAN", () => {
    const f = facts({ mergeState: "CLEAN" });
    const [review, ci] = f.checks as [HeadCheck, HeadCheck];
    f.checks = [
      review,
      { ...ci, name: "lint", required: false, state: "failure" },
      { ...ci, required: true, state: "failure" },
    ];
    const r = readiness(f, RULES);
    expect(r.place).toBe("needs-you");
    expect(r.says).toBe(
      "a required check failed after the drive converged (test); other failing checks: lint: re-run it, or re-arm the drive",
    );
    expect(r.failing).toEqual(["lint", "test"]);
  });
  it("keeps a failing optional check that shares its name with a required one", () => {
    const f = facts({ mergeState: "CLEAN" });
    const [review, ci] = f.checks as [HeadCheck, HeadCheck];
    f.checks = [
      review,
      { ...ci, id: 11, app: "ci-a", required: true, state: "failure" },
      { ...ci, id: 12, app: "ci-b", required: false, state: "failure" },
    ];
    const r = readiness(f, RULES);
    expect(r.says).toBe(
      `a required check failed after the drive converged (${ci.name} (ci-a)); other failing checks: ${ci.name} (ci-b): re-run it, or re-arm the drive`,
    );
    expect(r.failing).toEqual([`${ci.name} (ci-a)`, `${ci.name} (ci-b)`]);
  });
  it("tells same-app collisions apart by run id, and unidentified ones by an ambiguity label", () => {
    const f = facts({ mergeState: "CLEAN" });
    const [review, ci] = f.checks as [HeadCheck, HeadCheck];
    f.checks = [
      review,
      { ...ci, id: 21, app: "ci-a", required: true, state: "failure" },
      { ...ci, id: 22, app: "ci-a", required: false, state: "failure" },
      { ...ci, name: "lint", id: null, app: null, state: "failure" },
      (() => {
        const { id: _omitted, ...noId } = {
          ...ci,
          name: "lint",
          app: null,
          state: "failure" as const,
        };
        return noId;
      })(),
    ];
    const r = readiness(f, RULES);
    expect(r.failing).toEqual([
      `${ci.name} (run 21)`,
      `${ci.name} (run 22)`,
      "lint (ambiguous run) (x2)",
    ]);
  });
  it("does not let an optional pending check hide an approval request", () => {
    const f = facts({
      mergeState: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    });
    f.checks = f.checks.map((c, i) =>
      i === 1 ? { ...c, state: "pending" } : c,
    );
    f.checks = f.checks.map((c, i) =>
      i === 1 ? { ...c, required: false } : c,
    );
    expect(readiness(f, RULES).lane).toBe("approve-first");
  });
  it("takes the newest attempt id regardless of its start time", () => {
    const f = facts();
    f.checks = [
      {
        name: "AI review",
        app: "example-review",
        required: false,
        id: 12,
        state: "failure",
        startedAt: "2026-11-08T10:00:00Z",
      },
      {
        name: "AI review",
        app: "example-review",
        required: false,
        id: 11,
        state: "success",
        startedAt: "2026-11-09T10:00:00Z",
      },
    ];
    expect(readiness(f, RULES).place).toBe("needs-you");
  });
});

it("requires every distinct reviewer check and reduces retries within each name", () => {
  for (const state of ["failure", "pending", "skipped"] as const) {
    const f = facts();
    const base = facts().checks.find((c) => c.app === "example-review");
    if (base === undefined) throw new Error("fixture has no reviewer check");
    f.checks = [
      { ...base, name: "AI review (security)", id: 10, state },
      { ...base, name: "AI review (correctness)", id: 11 },
    ];
    expect(readiness(f, RULES).lane).not.toBe("merge-now");
    f.checks.push({ ...base, name: "AI review (security)", id: 12 });
    expect(readiness(f, RULES).lane).toBe("merge-now");
  }
  const f = facts();
  const base = f.checks.find((c) => c.app === "example-review");
  if (base === undefined) throw new Error("fixture has no reviewer check");
  f.checks.push({ ...base, name: "AI review (security)" });
  expect(readiness(f, RULES).lane).toBe("merge-now");
});

describe("condition 8 for trusted automation", () => {
  const TRUSTED: ReadyRules = {
    ...RULES,
    trustedAutomation: trustedAutomationOf({
      pull_requests: { trusted_automation: ["renovate[bot]"] },
    }),
  };
  const bot = (over: Partial<MergeFacts> = {}): Partial<MergeFacts> => ({
    authorAssociation: "NONE",
    author: "renovate[bot]",
    crossRepository: false,
    base: "main",
    automation: ok({
      head: HEAD,
      commits: [
        {
          sha: HEAD,
          login: "renovate[bot]",
          committer: "renovate[bot]",
          verified: true,
        },
      ],
      files: [{ path: "pnpm-lock.yaml", previous: null, patch: null }],
    }),
    ...over,
  });
  const authorCondition = (r: ReturnType<typeof readiness>) =>
    r.conditions.find((c) => c.name === "own author or approved");

  it("places a listed bot's converged pull request in merge now when every rule holds", () => {
    const r = at(bot(), TRUSTED);
    expect([r.place, r.lane]).toEqual(["ready", "merge-now"]);
    expect(authorCondition(r)).toEqual({
      name: "own author or approved",
      met: true,
      fact: "trusted automation renovate[bot]: same repository, 1 commit allowed, 1 file within its paths",
    });
  });

  it("leaves it in approve first, naming the rule, when a rule fails", () => {
    const r = at(
      bot({
        automation: ok({
          head: HEAD,
          commits: [
            {
              sha: HEAD,
              login: "outsider",
              committer: "outsider",
              verified: true,
            },
          ],
          files: [],
        }),
      }),
      TRUSTED,
    );
    expect(r.lane).toBe("approve-first");
    expect(authorCondition(r)).toMatchObject({
      met: false,
      fact: "renovate[bot] is trusted automation, but commit aaaaaaa is by outsider",
    });
  });

  it("leaves it in approve first where its commits and files were not read", () => {
    const { automation: _unread, ...unread } = bot();
    const r = at(unread, TRUSTED);
    expect(r.lane).toBe("approve-first");
    expect(authorCondition(r)?.fact).toContain("were not read");
  });

  it("grants nothing where no reviewer app is named: a person's approval is the witness", () => {
    const r = at(bot(), { ...TRUSTED, reviewerApp: null });
    expect(r.lane).toBe("approve-first");
    expect(authorCondition(r)?.met).toBe(false);
    expect(authorCondition(r)?.fact).toContain("no reviewer app is named");
  });

  it("says why a bot is not trusted when the list does not read", () => {
    const r = at(bot(), {
      ...RULES,
      trustedAutomation: trustedAutomationOf({
        pull_requests: { trusted_automation: "renovate[bot]" },
      }),
    });
    expect(r.lane).toBe("approve-first");
    expect(authorCondition(r)?.fact).toBe(
      "pull_requests.trusted_automation must be a list",
    );
  });

  it("reads a bot the list does not name as an outside author", () => {
    const r = at(bot({ author: "dependabot[bot]" }), TRUSTED);
    expect(r.lane).toBe("approve-first");
    expect(authorCondition(r)?.fact).toBe("outside author (NONE)");
  });

  it("still lets a person's approval of the head meet the condition when a rule fails", () => {
    const r = at(
      bot({
        crossRepository: true,
        reviews: [
          {
            author: "maintainer",
            person: true,
            association: "MEMBER",
            state: "APPROVED",
            commit: HEAD,
          },
        ],
      }),
      TRUSTED,
    );
    expect(r.lane).toBe("merge-now");
    expect(authorCondition(r)?.fact).toBe(
      "outside author, approved by a person",
    );
  });
});

describe("the board query's author, fork flag and base commit", () => {
  it("reads a bot author as <name>[bot], the fork flag and the base commit", () => {
    const none = { pageInfo: { hasNextPage: false }, nodes: [] };
    const read = parseAnswer(
      {
        data: {
          repository: {
            pr7: {
              number: 7,
              headRefOid: HEAD,
              author: { __typename: "Bot", login: "renovate" },
              isCrossRepository: false,
              baseRefOid: HEAD,
              labels: none,
              reviewThreads: none,
              reviewRequests: none,
              latestReviews: none,
              commits: { nodes: [] },
            },
          },
        },
      },
      [7],
    );
    const f = read.pulls.get(7);
    expect([f?.author, f?.crossRepository, f?.baseOid]).toEqual([
      "renovate[bot]",
      false,
      HEAD,
    ]);
  });
});
