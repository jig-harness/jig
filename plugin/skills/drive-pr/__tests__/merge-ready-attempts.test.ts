import { describe, expect, it } from "bun:test";
import { factsQuery, parsePull } from "../scripts/lib/merge-facts.ts";
import {
  readiness,
  type MergeFacts,
  type ReadyRules,
} from "../scripts/lib/merge-ready.ts";

const HEAD = "a".repeat(40);
const RULES: ReadyRules = {
  reviewerApp: null,
  reviewerCheck: /review/,
  ciHoldLabel: null,
};

function run(
  conclusion: string,
  startedAt: string | null,
  completedAt: string | null = startedAt,
) {
  return {
    __typename: "CheckRun",
    name: "gates",
    status: conclusion === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
    conclusion,
    startedAt,
    completedAt,
    isRequired: true,
    checkSuite: { app: { slug: "github-actions" } },
  };
}

function place(runs: ReturnType<typeof run>[], mergeStateStatus = "CLEAN") {
  const pull = parsePull(
    {
      number: 12,
      headRefOid: HEAD,
      mergeable: "MERGEABLE",
      mergeStateStatus,
      authorAssociation: "MEMBER",
      latestReviews: {
        nodes: [
          {
            state: "APPROVED",
            authorAssociation: "MEMBER",
            author: { __typename: "User", login: "maintainer" },
            commit: { oid: HEAD },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              oid: HEAD,
              statusCheckRollup: { contexts: { nodes: runs } },
            },
          },
        ],
      },
    },
    { squash: true, merge: false, rebase: false },
  );
  expect(pull).not.toBeNull();
  return readiness(
    {
      ...pull,
      slug: "example-org/example-repo",
      converged: true,
      verifiedSha: HEAD,
      held: false,
    } as MergeFacts,
    RULES,
  );
}

const EARLY = "2026-11-09T10:47:00Z";
const LATE = "2026-11-09T11:01:00Z";

describe("ordinary check attempts on the head", () => {
  it("ignores superseded cancellations and failures regardless of response order", () => {
    for (const conclusion of ["CANCELLED", "FAILURE"]) {
      const runs = [run(conclusion, EARLY), run("SUCCESS", LATE)];
      for (const order of [runs, [...runs].reverse()]) {
        const result = place(order);
        expect(result.failing).toEqual([]);
        expect(result.lane).toBe("merge-now");
      }
    }
  });

  it("keeps the latest cancelled required check out of merge now and names it", () => {
    const result = place([run("SUCCESS", EARLY), run("CANCELLED", LATE)]);
    expect(result.lane).toBeNull();
    expect(result.failing).toEqual(["gates"]);
    expect(result.says).toContain("gates");
    expect(result.waitsOn).toEqual({ kind: "person", act: "re-run-check" });
  });

  it("ignores an older pending attempt after success", () => {
    expect(
      place([run("PENDING", EARLY, null), run("SUCCESS", LATE)]).lane,
    ).toBe("merge-now");
  });

  it("waits for the latest pending attempt instead of reporting an old failure", () => {
    const result = place(
      [run("FAILURE", EARLY), run("PENDING", LATE, null)],
      "BLOCKED",
    );
    expect(result.failing).toEqual([]);
    expect(result.place).toBe("stay");
  });

  it("orders by start before completion, then completion for equal starts", () => {
    expect(
      place([run("FAILURE", EARLY, LATE), run("SUCCESS", LATE, LATE)]).failing,
    ).toEqual([]);
    expect(
      place([run("FAILURE", EARLY, EARLY), run("SUCCESS", EARLY, LATE)])
        .failing,
    ).toEqual([]);
    // Missing or tied timestamps do not prove that a blocker was superseded.
    for (const start of [null, "unreadable", LATE]) {
      expect(
        place([run("FAILURE", start), run("SUCCESS", LATE)]).failing,
      ).toEqual(["gates"]);
    }
  });

  it("requests completion timestamps from the forge", () => {
    expect(factsQuery([12])).toContain("completedAt");
  });
});
