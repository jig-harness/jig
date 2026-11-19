/**
 * dispatch: a parked drive's review threads over ticks. A tick asks the
 * forge whether the pull request's review comments changed, which costs
 * nothing while they have not, and reads a thread again only when they did.
 * Each tick runs as the installed command in a child with its own home.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { dispatchState } from "./launch-fixtures.ts";
import { statePath } from "../lib/state.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

const THREAD = "PRRT_t1";

const PARK: ParkedItem = {
  key: THREAD,
  kind: "thread",
  reason: "Which retry budget should the client keep?",
  round: 2,
  at: "2026-10-30T21:00:00.000Z",
};

/** A review comment on the parked thread, as the listing gives it. */
const reviewComment = (
  id: number,
  login: string,
  body: string,
  at: string,
) => ({
  id,
  thread: THREAD,
  user: { login },
  author_association: "OWNER",
  created_at: at,
  updated_at: at,
  html_url: `https://github.com/${SLUG}/pull/7#discussion_r${id}`,
  body,
});

const QUESTION = reviewComment(
  1,
  "drive-bot",
  "Which retry budget should the client keep?",
  "2026-10-30T20:59:00Z",
);
const ANSWER = reviewComment(
  2,
  "a-maintainer",
  "Keep three retries.",
  "2026-10-30T22:00:00Z",
);

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world whose pull request #7 has a drive parked on one review thread. */
function parked(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, "feature/7-open")]);
  w.setPrs("merged", []);
  w.setComments(7, [
    ledgerComment(
      701,
      stoppedLedger(7, DRIVE_EXIT.HITL_PARKED, { parked: [PARK] }),
    ),
  ]);
  setReviewComments(w, [QUESTION]);
  return w;
}

function setReviewComments(w: World, comments: unknown[]): void {
  writeFileSync(
    join(w.dir, "review-comments-7.json"),
    JSON.stringify(comments),
  );
}

/** One tick with the forge's answers kept, exiting `exit`; its receipt. Calls logged before it are forgotten. */
async function tick(w: World, exit = 0): Promise<TickReceipt> {
  rmSync(join(w.dir, "gh-calls.log"), { force: true });
  rmSync(join(w.dir, "comment-page-responses.log"), { force: true });
  const r = await w.dispatch(
    ["--repo", w.repo, "--followup-since", "2026-10-30T00:00:00Z", "--json"],
    undefined,
    { JIG_GH_CACHE_DIR: join(w.root, "forge-cache") },
  );
  expectSpawnExit(r, exit);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** As when the review comments stopped changing long before the kept readings were taken. */
function settle(w: World): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.run(
      "UPDATE pickup_reads SET value = json_set(value, '$.changedAt', 0) WHERE key LIKE 'park-threads:%'",
    );
  } finally {
    db.close();
  }
}

function lines(w: World, name: string): string[] {
  const path = join(w.dir, name);
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

const threadReads = (w: World) =>
  lines(w, "gh-calls.log").filter((c) => c.includes(`id=${THREAD}`)).length;

const reviewListing = (w: World) =>
  lines(w, "comment-page-responses.log").filter((l) =>
    l.startsWith("review 7 "),
  );

/** Why the tick acts on pull request #7, each action's reason. */
const reasonsOn7 = (receipt: TickReceipt) =>
  (receipt.repos[0]?.actions ?? [])
    .filter((a) => a.target === "PR #7")
    .map((a) => a.reason);

const WAITING = expect.stringContaining(`waiting on thread ${THREAD}`);
const ANSWERED = expect.stringContaining("every parked item answered");

describe("a parked drive's review threads over ticks", () => {
  it("sends no thread read on a second tick over unchanged threads", async () => {
    const w = parked();
    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(1);
    settle(w);

    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(0);
    expect(reviewListing(w)).toContain("review 7 304");
    expect(reviewListing(w)).not.toContain("review 7 200");
  }, 60_000);

  it("reads a thread with a new reply and acts on the answer", async () => {
    const w = parked();
    await tick(w);
    settle(w);
    await tick(w);
    expect(threadReads(w)).toBe(0);
    setReviewComments(w, [QUESTION, ANSWER]);

    const answered = await tick(w);
    expect(threadReads(w)).toBe(1);
    expect(reasonsOn7(answered)).toContainEqual(ANSWERED);
  }, 60_000);

  it("reads a thread again when one of its comments is edited", async () => {
    const w = parked();
    await tick(w);
    settle(w);
    setReviewComments(w, [
      { ...QUESTION, body: "Reworded.", updated_at: "2026-10-30T23:00:00Z" },
    ]);

    await tick(w);
    expect(threadReads(w)).toBe(1);
  }, 60_000);

  it("sees a reply the listing showed before the thread's query returned it", async () => {
    const w = parked();
    await tick(w);
    settle(w);
    // The listing has the reply; the thread's query does not return it yet.
    setReviewComments(w, [QUESTION, { ...ANSWER, thread: "PRRT_elsewhere" }]);
    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(1);

    setReviewComments(w, [QUESTION, ANSWER]);
    expect(reasonsOn7(await tick(w))).toContainEqual(ANSWERED);
    expect(threadReads(w)).toBe(1);
  }, 60_000);

  it("keeps nothing of a thread whose read failed", async () => {
    const w = parked();
    w.failCall(`id=${THREAD}`, "gh: HTTP 422");
    await tick(w, 1);
    rmSync(join(w.dir, "forge-fails.json"));
    settle(w);

    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(1);
  }, 60_000);

  it("forgets a closed pull request's threads", async () => {
    const w = parked();
    await tick(w);
    settle(w);
    w.setPrs("open", []);
    await tick(w);
    w.setPrs("open", [openPr(7, "feature/7-open")]);

    await tick(w);
    expect(threadReads(w)).toBe(1);
  }, 60_000);

  it("reads the threads on every tick while the review comments do not list", async () => {
    const w = parked();
    w.failCall("pulls/7/comments", "gh: HTTP 422");
    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(1);
    expect(reasonsOn7(await tick(w))).toContainEqual(WAITING);
    expect(threadReads(w)).toBe(1);
  }, 60_000);
});
