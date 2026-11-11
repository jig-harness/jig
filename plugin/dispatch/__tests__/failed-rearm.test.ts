/**
 * dispatch --apply: a re-arm that failed without moving its ledger is not
 * started again at the same pull request head, branch head and ledger
 * generation; it is notified once, naming the recovery when the pull request
 * is behind its branch, and re-armed once either head or the ledger moves.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { statePath } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  BASE_SHA,
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
  dispatchState,
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const HEAD = "feature/7-attach";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A drive of PR #7 stopped `NOT_SETTLED`, whose every re-arm exits `INDETERMINATE` without moving its ledger; its branch's head is `branch`. */
function fixture(branch: string): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  renotify_after: 1h\n`,
  );
  withOrigin(w);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [
    ledgerComment(701, stoppedLedger(7, DRIVE_EXIT.NOT_SETTLED)),
  ]);
  w.setBaseHead(branch);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.INDETERMINATE));
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** A tick that re-arms PR #7, waited on until the re-arm's exit is recorded. */
async function rearmed(w: World): Promise<void> {
  const receipt = await tick(w);
  const launch = receipt.repos[0]?.launches?.[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the re-arm's exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
}

/** Every notice's suppression record, as if it was sent two hours ago: past `renotify_after`. */
function sentLongAgo(w: World): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db.query("UPDATE notices SET at = ?, sent_at = ?").run(at, at);
  } finally {
    db.close();
  }
}

/** Mark the notices workspace read, so a cause due again would be sent rather than appended. */
function readNotices(w: World, path: string | null | undefined): void {
  const file = join(w.dir, "orca-ps.json");
  const ps = JSON.parse(readFileSync(file, "utf8")) as {
    worktrees: Array<{ path: string; unread: boolean }>;
  };
  for (const row of ps.worktrees) if (row.path === path) row.unread = false;
  writeFileSync(file, JSON.stringify(ps));
}

describe("a failed re-arm", () => {
  it("of a pull request behind its branch is held, notified once with both heads and the recovery", async () => {
    const w = fixture(BASE_SHA);
    await rearmed(w);

    const second = await tick(w);
    const repo = second.repos[0];
    expect(repo?.launches).toEqual([]);
    expect(driveRuns(w)).toHaveLength(1);
    const [action] = repo?.actions ?? [];
    expect(action).toMatchObject({
      stage: "notify",
      target: "PR #7",
      cause: "needs-person",
    });
    expect(action?.reason).toContain(
      `PR #7 is behind its branch '${HEAD}' (the pull request's head is ${HEAD_SHA.slice(0, 12)}, the branch's ${BASE_SHA.slice(0, 12)})`,
    );
    expect(action?.evidence).toMatchObject({
      rearmExit: DRIVE_EXIT.INDETERMINATE,
      prHead: HEAD_SHA,
      branchHead: BASE_SHA,
    });
    const text = action?.notice?.text ?? "";
    expect(text).toContain(HEAD_SHA);
    expect(text).toContain(BASE_SHA);
    expect(text).toContain("Close and reopen the pull request");
    expect(repo?.notifications).toMatchObject([
      { cause: "needs-person", outcome: "sent" },
    ]);

    readNotices(w, repo?.notifications?.[0]?.workspace);
    sentLongAgo(w);
    const third = await tick(w);
    expect(third.repos[0]?.launches).toEqual([]);
    expect(third.repos[0]?.notifications).toMatchObject([
      { cause: "needs-person", outcome: "suppressed" },
    ]);
    expect(driveRuns(w)).toHaveLength(1);
  }, 120_000);

  it("at heads that agree is held and names its exit, without the reopen", async () => {
    const w = fixture(HEAD_SHA);
    await rearmed(w);

    const second = await tick(w);
    expect(second.repos[0]?.launches).toEqual([]);
    const [action] = second.repos[0]?.actions ?? [];
    expect(action).toMatchObject({ stage: "notify", cause: "needs-person" });
    expect(action?.reason).toContain(
      `ended ${DRIVE_EXIT.INDETERMINATE} without moving its ledger`,
    );
    expect(action?.notice?.text).toContain(
      "until the pull request's head, its branch's head or the ledger's generation changes",
    );
    expect(action?.notice?.text).not.toContain("Close and reopen");
  }, 120_000);

  const changes: Array<[string, (w: World) => void]> = [
    [
      "the pull request's head changes",
      (w) => w.setPrs("open", [openPr(7, HEAD, { headRefOid: BASE_SHA })]),
    ],
    ["the branch's head changes", (w) => w.setBaseHead("d".repeat(40))],
    [
      "the ledger's generation changes",
      (w) =>
        w.setComments(7, [
          ledgerComment(
            701,
            stoppedLedger(7, DRIVE_EXIT.NOT_SETTLED, { generation: 4 }),
          ),
        ]),
    ],
    ["its branch's head does not read", (w) => w.setBaseHead(null)],
  ];
  it.each(changes)(
    "is re-armed again when %s",
    async (_what, change) => {
      const w = fixture(BASE_SHA);
      await rearmed(w);
      const held = await tick(w);
      expect(held.repos[0]?.launches).toEqual([]);
      change(w);
      await rearmed(w);
      expect(driveRuns(w)).toHaveLength(2);
    },
    120_000,
  );
});
