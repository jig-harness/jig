/**
 * dispatch: the board read in one tick, run as the installed command in a
 * child with its own home: a converged pull request reaches merge now with
 * its pinned command and a `ready` notification keyed by its head, and a
 * board read that fails leaves the tick's launches as they were.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
review:
  reviewer_app: example-review
dispatch:
  identity: factory-bot
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #7 converged at its verified head; PR #8 quota-parked, which the tick re-arms. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [
    openPr(7, "feature/7-ready"),
    openPr(8, "feature/8-parked"),
  ]);
  w.setComments(7, [
    ledgerComment(701, stoppedLedger(7, 0, { verifiedSha: HEAD_SHA })),
  ]);
  w.setComments(8, [ledgerComment(801, stoppedLedger(8, 16))]);
  w.setPrs("merged", []);
  return w;
}

/** The board query's answer: PR #7 clean, the reviewer app's check on its head. */
function boardAnswer(w: World, checked = true): void {
  const pr7 = {
    number: 7,
    headRefOid: HEAD_SHA,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    authorAssociation: "MEMBER",
    isMergeQueueEnabled: false,
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
    latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: HEAD_SHA,
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: checked
                  ? [
                      {
                        __typename: "CheckRun",
                        name: "AI review",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        startedAt: "2026-11-08T10:00:00Z",
                        isRequired: false,
                        checkSuite: { app: { slug: "example-review" } },
                      },
                    ]
                  : [],
              },
            },
          },
        },
      ],
    },
  };
  writeFileSync(
    join(w.dir, "board.json"),
    JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4900, limit: 5000 },
        repository: {
          squashMergeAllowed: true,
          mergeCommitAllowed: false,
          rebaseMergeAllowed: false,
          pr7,
        },
      },
    }),
  );
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--repo", w.repo, "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const actions = (receipt: TickReceipt) =>
  (receipt.repos[0]?.actions ?? []).map((a) => [a.stage, a.target]);

describe("the board read in a tick", () => {
  it("places a converged, witnessed, mergeable pull request in merge now with its pinned command, and notifies it keyed by its head", async () => {
    const w = fixture();
    boardAnswer(w);
    const receipt = await tick(w);
    const board = receipt.repos[0]?.board;
    expect(board?.ok).toBe(true);
    expect(board?.cards.map((c) => [c.number, c.lane, c.command])).toEqual([
      [
        7,
        "merge-now",
        `gh pr merge 7 --repo ${SLUG} --match-head-commit ${HEAD_SHA} --squash`,
      ],
    ]);
    const ready = receipt.repos[0]?.actions.find((a) => a.cause === "ready");
    expect(ready?.target).toBe("PR #7");
    expect(ready?.notice?.key).toBe(`${SLUG} PR #7 ready at ${HEAD_SHA}`);
  });

  it("puts one whose ledger claims a head its reviewer never checked in Needs you", async () => {
    const w = fixture();
    boardAnswer(w, false);
    const receipt = await tick(w);
    expect(
      receipt.repos[0]?.board?.cards.map((c) => [c.place, c.lane]),
    ).toEqual([["needs-you", null]]);
    expect(receipt.repos[0]?.actions.some((a) => a.cause === "ready")).toBe(
      false,
    );
  });

  it("leaves the tick's launches as they were when the board read fails", async () => {
    const read = fixture();
    boardAnswer(read);
    const withBoard = actions(await tick(read)).filter(
      ([stage]) => stage !== "notify",
    );
    read.close();
    const failing = fixture();
    writeFileSync(join(failing.dir, "board-fail"), "");
    const receipt = await tick(failing);
    expect(receipt.repos[0]?.board?.ok).toBe(false);
    expect(receipt.repos[0]?.board?.reason).toContain("HTTP 422");
    expect(actions(receipt)).toEqual(withBoard);
    expect(withBoard).toEqual([["rearm", "PR #8"]]);
  });
});
