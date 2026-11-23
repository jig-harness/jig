/**
 * dispatch: the board read in one tick, run as the installed command in a
 * child with its own home: a converged pull request reaches merge now with
 * its pinned command and a `ready` notification keyed by its head, and a
 * board read that fails leaves the tick's launches as they were.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  forgeComment,
  ledgerBody,
} from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  headMarker,
  OPENER,
} from "../../skills/drive-pr/scripts/lib/announce.ts";
import { parseLedger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
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
import {
  account,
  exitWritten,
  machineFile,
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";

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
function boardAnswer(
  w: World,
  checked = true,
  head = HEAD_SHA,
  ci?: "pending" | "success" | "failure",
): void {
  const pr7 = {
    number: 7,
    headRefOid: head,
    baseRefOid: readFileSync(join(w.dir, "base-head"), "utf8"),
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
            oid: head,
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  ...(checked
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
                    : []),
                  ...(ci === undefined
                    ? []
                    : [
                        {
                          __typename: "CheckRun",
                          name: "test",
                          status:
                            ci === "pending" ? "IN_PROGRESS" : "COMPLETED",
                          conclusion:
                            ci === "pending"
                              ? null
                              : ci === "failure"
                                ? "FAILURE"
                                : "SUCCESS",
                          startedAt: "2026-11-08T10:00:00Z",
                          isRequired: true,
                          checkSuite: { app: { slug: "example-ci" } },
                        },
                      ]),
                ],
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

const BRANCH = "feature/7-ready";
const REFRESH_CONFIG = `${CONFIG}ci:
  required_checks: [test]
`;

function git(w: World, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Jig Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { cwd: w.repo, env: w.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0, `git ${args[0]}`);
  return result.stdout.toString().trim();
}

/** A stopped ledger and its announcement, followed by a real base-branch merge. */
function afterBaseMerge(edited = false): {
  w: World;
  verified: string;
  head: string;
} {
  const w = world();
  current = w;
  w.setConfig(REFRESH_CONFIG);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  const overlay = join(w.repo, ".config", "jig.yaml");
  writeFileSync(overlay, REFRESH_CONFIG);
  w.env.JIG_OVERLAY = overlay;
  git(w, "add", ".config");
  git(w, "commit", "-m", "Configure checks");
  git(w, "switch", "-c", BRANCH);
  writeFileSync(join(w.repo, "feature.txt"), "the reviewed change\n");
  git(w, "add", "feature.txt");
  git(w, "commit", "-m", "Feature");
  const verified = git(w, "rev-parse", "HEAD");
  git(w, "switch", "main");
  writeFileSync(join(w.repo, "base.txt"), "an independent base change\n");
  git(w, "add", "base.txt");
  git(w, "commit", "-m", "Advance main");
  const base = git(w, "rev-parse", "HEAD");
  git(w, "switch", BRANCH);
  git(w, "merge", "--no-edit", "main");
  if (edited) {
    writeFileSync(join(w.repo, "feature.txt"), "the change moved\n");
    git(w, "commit", "-am", "Edit PR");
  }
  const head = git(w, "rev-parse", "HEAD");
  git(w, "switch", "main");
  w.setPrs("open", [
    {
      ...openPr(7, BRANCH, { headRefOid: head }),
      baseRefOid: base,
      isDraft: false,
    },
  ]);
  w.setComments(7, [
    forgeComment(
      701,
      ledgerBody(stoppedLedger(7, 0, { verifiedSha: verified })),
      "drive-bot",
    ),
    forgeComment(702, `${OPENER}\n\n${headMarker(verified)}`, "drive-bot"),
  ]);
  w.setBaseHead(base);
  writeFileSync(
    join(w.dir, `ci-${verified}.json`),
    JSON.stringify([
      {
        id: 106,
        name: "AI review",
        head_sha: verified,
        status: "completed",
        conclusion: "success",
        started_at: "2026-11-08T09:00:00Z",
        completed_at: "2026-11-08T09:02:00Z",
        app: { slug: "example-review", id: 18 },
      },
    ]),
  );
  w.setWorkspaces([
    { branch: BRANCH, linkedPR: 7, path: join(w.root, "ws-7") },
  ]);
  git(w, "fetch", "origin", "main");
  machineFile(w, [account(w, "a", "a@example.com")]);
  return { w, verified, head };
}

function checkEvidence(
  w: World,
  head: string,
  status: "pending" | "success" | "failure" | "unregistered",
): void {
  // The new head has CI evidence and no new reviewer-app check.
  boardAnswer(w, false, head, status === "unregistered" ? undefined : status);
  const pending = status === "pending";
  const failure = status === "failure";
  writeFileSync(
    join(w.dir, `ci-${head}.json`),
    JSON.stringify(
      status === "unregistered"
        ? []
        : [
            {
              id: 107,
              name: "test",
              head_sha: head,
              status: pending ? "in_progress" : "completed",
              conclusion: pending ? null : failure ? "failure" : "success",
              started_at: "2026-11-08T10:00:00Z",
              completed_at: pending ? null : "2026-11-08T10:02:00Z",
              app: { slug: "example-ci", id: 19 },
            },
          ],
    ),
  );
}

async function apply(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--repo", w.repo, "--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

function comments(w: World): ReturnType<typeof forgeComment>[] {
  return JSON.parse(
    readFileSync(join(w.dir, "comments-7.json"), "utf8"),
  ) as ReturnType<typeof forgeComment>[];
}

const commentBodies = (w: World): string[] =>
  comments(w).map(({ body }) => body);

describe("refreshing convergence after a base merge", () => {
  it("waits for the new head's required checks, refreshes the ledger and pins the board command without rounds", async () => {
    const { w, verified, head } = afterBaseMerge();
    checkEvidence(w, head, "pending");
    const pending = await apply(w);
    expect(pending.repos[0]?.launches).toEqual([]);
    expect(commentBodies(w).map(parseLedger).find(Boolean)).toMatchObject({
      kind: "ledger",
      ledger: { verifiedSha: verified },
    });
    expect(
      (pending.repos[0]?.board?.cards ?? []).some(
        (c) => c.lane === "merge-now",
      ),
    ).toBe(false);

    checkEvidence(w, head, "success");
    const ready = await apply(w);
    expect(ready.repos[0]?.launches).toEqual([]);
    expect(terminalCreates(w)).toEqual([]);
    expect(git(w, "rev-parse", BRANCH)).toBe(head);
    expect(commentBodies(w).map(parseLedger).find(Boolean)).toMatchObject({
      kind: "ledger",
      ledger: { verifiedSha: head, reviewCarriedFrom: verified },
    });
    expect(
      commentBodies(w)
        .filter((body) => body.startsWith(OPENER))
        .map((body) => body.endsWith(headMarker(head))),
    ).toEqual([true]);
    expect(ready.repos[0]?.board?.cards).toContainEqual(
      expect.objectContaining({
        number: 7,
        lane: "merge-now",
        command: `gh pr merge 7 --repo ${SLUG} --match-head-commit ${head} --squash`,
      }),
    );
  }, 90_000);

  it("waits for CI to register and completes an announcement interrupted before the ledger update", async () => {
    const { w, verified, head } = afterBaseMerge();
    checkEvidence(w, head, "unregistered");
    expect((await apply(w)).repos[0]?.launches).toEqual([]);
    expect(commentBodies(w).map(parseLedger).find(Boolean)).toMatchObject({
      kind: "ledger",
      ledger: { verifiedSha: verified },
    });

    checkEvidence(w, head, "success");
    const prior = forgeComment(
      703,
      `${OPENER}\n\n${headMarker(head)}`,
      "drive-bot",
    );
    w.setComments(7, [...comments(w), prior]);
    expect((await apply(w)).repos[0]?.launches).toEqual([]);
    expect(terminalCreates(w)).toEqual([]);
    expect(commentBodies(w).map(parseLedger).find(Boolean)).toMatchObject({
      kind: "ledger",
      ledger: { verifiedSha: head, reviewCarriedFrom: verified },
    });
    expect(comments(w).filter(({ body }) => body.startsWith(OPENER))).toEqual([
      prior,
    ]);
  }, 90_000);

  it("withdraws a stale announcement after the refreshed ledger is already current", async () => {
    const { w, verified, head } = afterBaseMerge();
    checkEvidence(w, head, "success");
    await apply(w);
    w.setComments(7, [
      ...comments(w),
      forgeComment(704, `${OPENER}\n\n${headMarker(verified)}`, "drive-bot"),
    ]);

    await apply(w);

    expect(commentBodies(w).filter((body) => body.startsWith(OPENER))).toEqual([
      expect.stringContaining(headMarker(head)),
    ]);
  }, 90_000);

  it("withdraws a stale announcement after the pull request becomes a draft", async () => {
    const { w, verified, head } = afterBaseMerge();
    checkEvidence(w, head, "success");
    await apply(w);
    w.setComments(7, [
      ...comments(w),
      forgeComment(704, `${OPENER}\n\n${headMarker(verified)}`, "drive-bot"),
    ]);
    w.setPrs("open", [
      {
        ...openPr(7, BRANCH, { headRefOid: head }),
        baseRefOid: readFileSync(join(w.dir, "base-head"), "utf8"),
        isDraft: true,
      },
    ]);

    await apply(w);

    expect(commentBodies(w).filter((body) => body.startsWith(OPENER))).toEqual([
      expect.stringContaining(headMarker(head)),
    ]);
  }, 90_000);

  it("withdraws a stale announcement when the current head's checks turn red", async () => {
    const { w, verified, head } = afterBaseMerge();
    checkEvidence(w, head, "success");
    await apply(w);
    w.setComments(7, [
      ...comments(w),
      forgeComment(704, `${OPENER}\n\n${headMarker(verified)}`, "drive-bot"),
    ]);
    checkEvidence(w, head, "failure");

    await apply(w);

    expect(commentBodies(w).filter((body) => body.startsWith(OPENER))).toEqual([
      expect.stringContaining(headMarker(head)),
    ]);
  }, 90_000);

  it("does not refresh a clean converged drive without stale announcement evidence", async () => {
    const { w, head } = afterBaseMerge();
    checkEvidence(w, head, "success");
    await apply(w);

    writeFileSync(join(w.dir, "gh-calls.log"), "");
    await apply(w);

    expect(readFileSync(join(w.dir, "gh-calls.log"), "utf8")).not.toContain(
      "pr view 7 --json state,headRefOid,baseRefOid,mergeable,isDraft",
    );
  }, 90_000);

  it("re-drives once when the head moved by a base merge and a PR edit", async () => {
    const { w, verified, head } = afterBaseMerge(true);
    checkEvidence(w, head, "success");
    const started = await apply(w);
    const [launch] = started.repos[0]?.launches ?? [];
    expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
    const record = launch?.record ?? "";
    await waitFor("the exit", () => exitWritten(w, record));
    expect((await apply(w)).repos[0]?.launches).toEqual([]);
    expect(terminalCreates(w)).toHaveLength(1);
    expect(commentBodies(w).map(parseLedger).find(Boolean)).toMatchObject({
      kind: "ledger",
      ledger: { verifiedSha: verified },
    });
  }, 90_000);
});
