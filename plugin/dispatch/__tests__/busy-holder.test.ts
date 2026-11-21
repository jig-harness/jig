/**
 * dispatch --apply: a re-arm whose head branch another checkout holds, one
 * Orca does not list (an agent's leftover worktree, say). While that checkout
 * is in use, the launch is refused, and a person is notified once, with the
 * checkout's path and what keeps it busy; a later tick that is refused the
 * same way sends nothing new. Once the checkout is idle, the next tick
 * detaches it at its commit and opens the workspace on the branch. A
 * follow-up whose merged branch such a checkout holds, its commits
 * squash-merged into the base branch, detaches it and lists it, with no
 * person asked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  mergedPr,
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
const BRANCH = "feature/7-parked";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function git(w: World, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    env: w.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
  return r.stdout.toString().trim();
}

/** PR #7 re-armable, its head branch pushed and checked out by a plain-git worktree Orca does not list. */
function heldRearm(): { w: World; holder: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  w.setPrs("open", [openPr(7, BRANCH)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  w.setWorkspaces([]);
  const holder = join(w.root, "agent-tree");
  git(w, "-C", w.repo, "worktree", "add", "-q", "-b", BRANCH, holder, "main");
  git(w, "-C", holder, "push", "-q", "origin", BRANCH);
  return { w, holder };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** The workspaces Orca was asked to create for PR #7's re-arm, not the notices workspace. */
const rearmCreates = (w: World) =>
  orcaCalls(w, "worktree", "create").filter((args) =>
    args.includes("⚙ dispatched · rearm #7"),
  );

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notifications = (r: TickReceipt) => r.repos[0]?.notifications ?? [];

describe("jig dispatch with a checkout Orca does not list holding the head branch", () => {
  it("refuses while it is in use, notifies a person once, and opens past it once it is idle", async () => {
    const { w, holder } = heldRearm();
    writeFileSync(join(holder, "notes.txt"), "work in progress\n");
    const key = `${SLUG} PR #7 branch held by busy checkout ${BRANCH} at ${holder}`;

    const first = await tick(w);
    expect(launches(first)).toMatchObject([
      {
        target: "PR #7",
        outcome: "refused",
        holder: {
          path: holder,
          branch: BRANCH,
          reasons: ["it has uncommitted or untracked changes"],
        },
      },
    ]);
    expect(launches(first)[0]?.detail).toContain(
      "it has uncommitted or untracked changes",
    );
    expect(launches(first)[0]?.detail).toContain(
      "a notice to a person follows",
    );
    expect(notifications(first)).toMatchObject([
      { target: "PR #7", cause: "needs-person", key, outcome: "sent" },
    ]);
    const [written] = notifyWrites(w);
    const comment = written?.[written.indexOf("--comment") + 1] ?? "";
    expect(comment).toContain(`[jig dispatch: ${key}]`);
    expect(comment).toContain("it has uncommitted or untracked changes");

    const second = await tick(w);
    expect(launches(second)).toMatchObject([
      { target: "PR #7", outcome: "refused" },
    ]);
    expect(notifications(second)).toMatchObject([
      { key, outcome: "suppressed" },
    ]);
    expect(notifyWrites(w)).toHaveLength(1);
    expect(rearmCreates(w)).toEqual([]);

    rmSync(join(holder, "notes.txt"));
    const head = git(w, "-C", holder, "rev-parse", "HEAD");
    const third = await tick(w);
    const [launched] = launches(third);
    expect(launched).toMatchObject({ target: "PR #7", outcome: "launched" });
    expect(launched?.holder).toBeUndefined();
    const path = readRecord(String(launched?.record), dispatchState(w))
      ?.workspace?.path;
    expect(path).toBeDefined();
    expect(git(w, "-C", path ?? "", "symbolic-ref", "--short", "HEAD")).toBe(
      BRANCH,
    );
    expect(git(w, "-C", holder, "rev-parse", "HEAD")).toBe(head);
    const detached = Bun.spawnSync(
      ["git", "-C", holder, "symbolic-ref", "-q", "HEAD"],
      { env: w.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(detached, 1, "the holder's HEAD is detached");
    expect(rearmCreates(w)).toHaveLength(1);
  }, 90_000);
});

const MERGED = "feature/10-merged";
const AUTHOR = [
  "-c",
  "user.name=Probe",
  "-c",
  "user.email=probe@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

/**
 * PR #10 merged, its follow-up due: its branch squash-merged into origin's
 * main and deleted on origin, and still checked out, with its one commit,
 * by a plain-git worktree Orca does not list.
 */
function heldMergedFollowup(): { w: World; holder: string } {
  const w = world();
  current = w;
  w.setConfig(`${CONFIG}dispatch:\n  followup_command: /followup\n`);
  withOrigin(w);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  w.setPrs("merged", [mergedPr(10, MERGED, "2026-10-31T12:00:00Z")]);
  w.setComments(10, []);
  w.setWorkspaces([]);
  const holder = join(w.root, "agent-tree");
  git(w, "-C", w.repo, "worktree", "add", "-q", "-b", MERGED, holder, "main");
  writeFileSync(join(holder, "merged.txt"), "the merged change\n");
  git(w, "-C", holder, "add", "merged.txt");
  git(w, "-C", holder, ...AUTHOR, "commit", "-q", "-m", "the change");
  git(w, "-C", holder, "push", "-q", "origin", MERGED);
  const merger = join(w.root, "merger");
  git(w, "-C", w.repo, "worktree", "add", "-q", "--detach", merger, "main");
  git(w, "-C", merger, "merge", "-q", "--squash", `origin/${MERGED}`);
  git(w, "-C", merger, ...AUTHOR, "commit", "-q", "-m", "the change (#10)");
  git(w, "-C", merger, "push", "-q", "origin", "HEAD:main");
  git(w, "-C", w.repo, "worktree", "remove", merger);
  git(w, "-C", w.repo, "push", "-q", "origin", "--delete", MERGED);
  return { w, holder };
}

describe("jig dispatch with a squash-merged checkout Orca does not list holding a follow-up's branch", () => {
  it("detaches it, launches the follow-up and lists the checkout and its kept branch, asking no person", async () => {
    const { w, holder } = heldMergedFollowup();
    const head = git(w, "-C", holder, "rev-parse", "HEAD");

    const receipt = await tick(w);
    const [launched] = launches(receipt);
    expect(launched).toMatchObject({
      target: "PR #10",
      action: "followup",
      outcome: "launched",
      detached: { path: holder, branch: MERGED, head },
    });
    expect(launched?.holder).toBeUndefined();
    expect(launched?.detail).toContain(
      `left the idle checkout at ${holder} detached at ${head.slice(0, 12)}, its branch ${MERGED} kept`,
    );
    expect(
      notifications(receipt).filter((n) => n.cause === "needs-person"),
    ).toEqual([]);
    expect(git(w, "-C", holder, "rev-parse", "HEAD")).toBe(head);
    const detached = Bun.spawnSync(
      ["git", "-C", holder, "symbolic-ref", "-q", "HEAD"],
      { env: w.env, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(detached, 1, "the holder's HEAD is detached");
    expect(git(w, "-C", w.repo, "rev-parse", `refs/heads/${MERGED}`)).toBe(
      head,
    );
  }, 90_000);
});
