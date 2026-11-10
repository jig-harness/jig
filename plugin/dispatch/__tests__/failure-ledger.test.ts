/**
 * dispatch --apply and the failure ledger, through real ticks: a label write
 * the forge keeps refusing backs off between tries and is notified to a
 * person once past `failures.notify_after`, then clears when it succeeds; a
 * repository whose turn fails three ticks in a row is notified, and one tick
 * that reads it whole clears its row and retires the notice; and a write
 * whose pull request leaves the plan drops its row.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import { statePath } from "../lib/state.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;
const LABELS = `${CONFIG}dispatch:
  labels: { enabled: true }
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world whose machine file enables `rearm` and `notify` for the repository on account a. */
function fixture(yaml: string): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World, exit = 0): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, exit);
  return JSON.parse(r.stdout) as TickReceipt;
}

interface Stored {
  repo: string;
  key: string;
  kind: string;
  count: number;
  reason: string;
}

/** The failure ledger's rows, as the tick left them. */
function rows(w: World): Stored[] {
  const path = statePath(dispatchState(w));
  if (!existsSync(path)) return [];
  const db = new Database(path);
  try {
    return db
      .query("SELECT repo, key, kind, count, reason FROM failures ORDER BY key")
      .all() as Stored[];
  } finally {
    db.close();
  }
}

/** Every action's next try moved into the past, as if its wait had passed. */
function waited(w: World): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.query("UPDATE failures SET next_at_ms = 0").run();
  } finally {
    db.close();
  }
}

/** The suppression records' keys, as the notifications left them. */
function noticeKeys(w: World): string[] {
  const db = new Database(statePath(dispatchState(w)));
  try {
    return (
      db.query("SELECT key FROM notices ORDER BY key").all() as Array<{
        key: string;
      }>
    ).map((r) => r.key);
  } finally {
    db.close();
  }
}

const repo = (r: TickReceipt) => r.repos[0];
const failing = (r: TickReceipt) =>
  (repo(r)?.notifications ?? []).filter((n) =>
    ["action-failing", "repository-failing"].includes(n.cause),
  );

/** Every `gh pr edit` the ticks made since the last call. */
function edits(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n")
    : [];
  writeFileSync(path, "");
  return lines.filter((l) => l.startsWith("pr edit "));
}

const converged = (pr: number) =>
  ledgerComment(pr * 100 + 1, stoppedLedger(pr, 0, { verifiedSha: HEAD_SHA }));

/** The board query's answer: PR #7 clean at its verified head, so the board places it and the absence of a cause about it settles that cause's notice. */
function boardPlaces(w: World): void {
  const page = { pageInfo: { hasNextPage: false }, nodes: [] };
  const pr7 = {
    number: 7,
    headRefOid: HEAD_SHA,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    authorAssociation: "MEMBER",
    isMergeQueueEnabled: false,
    labels: page,
    reviewThreads: page,
    reviewRequests: page,
    latestReviews: page,
    commits: {
      nodes: [
        { commit: { oid: HEAD_SHA, statusCheckRollup: { contexts: page } } },
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

describe("jig dispatch backs off a label write that keeps failing", () => {
  it("waits between tries, notifies a person once past three failures in a row, and clears the row once the write succeeds", async () => {
    const w = fixture(LABELS);
    w.setPrs("open", [openPr(7, "feature/7")]);
    w.setComments(7, [converged(7)]);
    writeFileSync(join(w.dir, "label-edit-fail"), "");

    const first = await tick(w);
    expect(repo(first)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "failed" },
    ]);
    expect(rows(w)).toMatchObject([
      { repo: SLUG, key: "label PR #7", kind: "label", count: 1 },
    ]);
    expect(rows(w)[0]?.reason).toContain("HTTP 403");

    // A first failure is tried again at the next tick; a second waits.
    await tick(w);
    expect(rows(w)[0]?.count).toBe(2);
    edits(w);
    const backing = await tick(w);
    const [write] = repo(backing)?.labels?.writes ?? [];
    expect(write).toMatchObject({ target: "PR #7", outcome: "waits" });
    expect(write?.detail).toMatch(
      /^backing off after 2 failures in a row since .*; next try at /,
    );
    expect(edits(w)).toEqual([]);
    expect(backing.failures?.backingOff).toMatchObject([
      { kind: "label", key: "label PR #7", count: 2 },
    ]);

    waited(w);
    await tick(w);
    expect(rows(w)[0]?.count).toBe(3);
    expect(edits(w)).toHaveLength(1);

    // Past the threshold: the next tick tells a person, once.
    const told = await tick(w);
    expect(failing(told)).toMatchObject([
      { target: "PR #7", cause: "action-failing", outcome: "sent" },
    ]);
    expect(told.failures?.escalated).toMatchObject([
      { kind: "label", key: "label PR #7", count: 3 },
    ]);
    const quiet = await tick(w);
    expect(failing(quiet)).toMatchObject([
      { cause: "action-failing", outcome: "suppressed" },
    ]);

    rmSync(join(w.dir, "label-edit-fail"));
    waited(w);
    const written = await tick(w);
    expect(repo(written)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "written" },
    ]);
    expect(rows(w)).toEqual([]);
    expect(written.failures).toBeUndefined();

    // The cause left the plan with its row: its suppression record retires
    // once the board places the pull request it is about.
    boardPlaces(w);
    const after = await tick(w);
    expect(failing(after)).toEqual([]);
    expect(noticeKeys(w).filter((k) => k.includes("failing"))).toEqual([]);
  }, 180_000);

  it("drops the row of a write whose pull request left the plan", async () => {
    const w = fixture(LABELS);
    w.setPrs("open", [openPr(7, "feature/7")]);
    w.setComments(7, [converged(7)]);
    writeFileSync(join(w.dir, "label-edit-fail"), "");
    await tick(w);
    expect(rows(w).map((r) => r.key)).toEqual(["label PR #7"]);

    // The pull request closed: its labels are no longer the projection's.
    w.setPrs("open", []);
    await tick(w);
    expect(rows(w)).toEqual([]);
  }, 60_000);
});

describe("jig dispatch tells a person about a repository whose turn keeps failing", () => {
  it("notifies after three failing ticks in a row, and one tick that reads it whole clears the row and retires the notice", async () => {
    const w = fixture(CONFIG);
    w.setPrs("open", [openPr(7, "feature/7")]);
    writeFileSync(join(w.dir, "prs-open-fail"), "");

    for (const count of [1, 2, 3]) {
      const r = await tick(w, 1);
      expect(failing(r)).toEqual([]);
      expect(rows(w).find((x) => x.kind === "repository")).toMatchObject({
        key: "repository",
        count,
      });
    }
    const told = await tick(w, 1);
    const [notice] = failing(told);
    expect(notice).toMatchObject({
      target: SLUG,
      cause: "repository-failing",
      outcome: "sent",
    });
    const key = notice?.key ?? "";
    expect(key).toMatch(/^host repository .+ failing since \d{4}-/);
    const workspaces = JSON.parse(
      readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
    ) as { worktrees: Array<{ comment: string }> };
    const comment =
      workspaces.worktrees.find((x) => x.comment.includes(key))?.comment ?? "";
    expect(comment).toContain(
      `The dispatcher's turn for ${SLUG} has failed 3 ticks in a row since`,
    );
    expect(comment).toContain("HTTP 502");
    // The tick's own row counts the same failing ticks, and is notified beside it.
    expect(
      (repo(told)?.notifications ?? []).some(
        (n) => n.cause === "ticks-failing" && n.outcome === "sent",
      ),
    ).toBe(true);

    rmSync(join(w.dir, "prs-open-fail"));
    await tick(w);
    expect(rows(w)).toEqual([]);
    await tick(w);
    expect(noticeKeys(w).filter((k) => k.includes("failing"))).toEqual([]);
  }, 180_000);
});
