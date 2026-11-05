/**
 * dispatch --apply: the repository's notices workspace is removed once its
 * job is done, read for `dispatch.notices_linger` or unread with every cause
 * it carried gone, and never while it holds something of a person's. A new
 * one has its first terminal closed. Removing it sends nothing again.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import { statePath } from "../lib/state.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { notifyWrites, orcaCalls, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #8 stopped on exit 7 with no workspace of its own, so its notice goes to the notices workspace. */
function fixture(config = CONFIG): World {
  const w = world();
  current = w;
  w.setConfig(config);
  withOrigin(w);
  w.setPrs("open", [openPr(8, "feature/8-failed")]);
  w.setComments(8, [ledgerComment(801, stoppedLedger(8, 7))]);
  w.setWorkspaces([]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const outcome = (r: TickReceipt) => r.repos[0]?.noticesWorkspace;

type PsRow = { path: string; unread: boolean; comment: string };

function psRows(w: World): PsRow[] {
  return (
    JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
      worktrees: PsRow[];
    }
  ).worktrees;
}

/** A person opens the workspace at `path`: Orca clears its unread mark. */
function read(w: World, path: string): void {
  const ps = JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
    worktrees: PsRow[];
  };
  for (const row of ps.worktrees) if (row.path === path) row.unread = false;
  writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
}

/** Move the time the tick first found the notices workspace read back by `ms`. */
function backdate(w: World, ms: number): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.run("UPDATE notices_read SET since = since - ?", [ms]);
  } finally {
    db.close();
  }
}

/** The notices workspace's path, from the first tick's notification. */
async function opened(w: World): Promise<string> {
  const first = await tick(w);
  const path = first.repos[0]?.notifications[0]?.workspace ?? "";
  expect(path).not.toBe("");
  return path;
}

describe("jig dispatch --apply retires the notices workspace", () => {
  it("closes a new notices workspace's terminals, and keeps it while its cause stands unread", async () => {
    const w = fixture();
    const path = await opened(w);
    expect(orcaCalls(w, "terminal", "close")).toEqual([
      ["terminal", "close", "--worktree", `path:${path}`, "--all", "--json"],
    ]);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "kept",
      detail: expect.stringContaining("still stands"),
    });
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  it("removes it once read for the linger, and opens no new one for the cause already sent", async () => {
    const w = fixture();
    const path = await opened(w);
    read(w, path);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({
        outcome: "kept",
        detail: expect.stringContaining("dispatch.notices_linger"),
      }),
    );
    backdate(w, 61 * 60_000);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ workspace: path, outcome: "retired" }),
    );
    expect(orcaCalls(w, "worktree", "rm")).toEqual([
      [
        "worktree",
        "rm",
        "--worktree",
        `path:${path}`,
        "--delete-branch",
        "--json",
      ],
    ]);
    expect(psRows(w).map((r) => r.path)).not.toContain(path);

    const after = await tick(w);
    expect(after.repos[0]?.notifications).toEqual([
      expect.objectContaining({ target: "PR #8", outcome: "suppressed" }),
    ]);
    expect(outcome(after)).toBeUndefined();
    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(notifyWrites(w)).toHaveLength(1);
  });

  it("removes it at the first read tick when dispatch.notices_linger is 0s", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    read(w, path);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ workspace: path, outcome: "retired" }),
    );
  });

  it("removes it unread once every cause it carried is gone", async () => {
    const w = fixture();
    const path = await opened(w);
    w.setPrs("open", []);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "retired",
      detail: expect.stringContaining("every cause it carried is gone"),
    });
  });

  it("leaves it for a person when git shows changes in it", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    writeFileSync(join(path, "notes.md"), "a person's notes\n");
    read(w, path);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "refused",
      detail: "git reports changes in it; left for a person",
    });
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  it("leaves it for a person when its comment is not the dispatcher's", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    const ps = JSON.parse(
      readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
    ) as {
      worktrees: PsRow[];
    };
    for (const row of ps.worktrees)
      if (row.path === path) {
        row.comment = "Look at the flaky retry test";
        row.unread = false;
      }
    writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ outcome: "refused" }),
    );
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });
});
