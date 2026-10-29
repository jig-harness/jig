/**
 * drive-pr suite: what picking a stopped drive up must refuse, and the edges
 * of what it admits — which comments answer a park, the quota re-arm after a
 * reset or a person's `--window-reopened`, and the holders `--take-over`
 * admits, refuses or leaves running.
 * Shared fixtures live in drive-pr-harness.ts, drive-loop-harness.ts and
 * drive-pr-pickup-fixtures.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  HEAD,
  hold,
  park,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";
import {
  alive,
  deadPid,
  fakeDriver,
  plantPrLock,
  progressAt,
  replyRecordingGh,
  stale,
  tokenAccount,
  trackedTree,
} from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

const NOOP = ["sh", "-c", ": pass for 999"];

/** A minute from now: later than any park a test just made. */
const later = () => new Date(Date.now() + 60_000).toISOString();

interface Comment {
  author: string;
  authorAssociation: string;
  body: string;
  dated: "before" | "after";
}

/**
 * PR 999 with one parked thread `PRRT_p`, the given comments on it, and the
 * given pull-request comments (`created_at` after the park).
 */
async function parked(onThread: Comment[], onPr: Comment[] = []) {
  const { dir, stateDir } = writeFixture(
    {
      threads: [
        {
          id: "PRRT_p",
          path: "a.ts",
          bot: true,
          comments: [
            { body: "a finding", bot: true },
            ...onThread.map((c) => ({ ...c, bot: false })),
          ],
        },
      ],
    },
    scratchClean.dir,
  );
  await park(stateDir, "PRRT_p", "thread");
  const file = join(dir, "threads.json");
  const threads = JSON.parse(readFileSync(file, "utf8"));
  const nodes = threads.data.repository.pullRequest.reviewThreads.nodes[0]
    .comments.nodes as Array<{ createdAt: string }>;
  onThread.forEach((c, i) => {
    const node = nodes[i + 1];
    if (node !== undefined && c.dated === "after") node.createdAt = later();
  });
  writeFileSync(file, JSON.stringify(threads));
  const prFile = join(dir, "issue-comments.json");
  const comments = JSON.parse(readFileSync(prFile, "utf8"));
  for (const [i, c] of onPr.entries())
    comments.push({
      id: 7000 + i,
      body: c.body,
      user: { login: c.author },
      author_association: c.authorAssociation,
      created_at: c.dated === "after" ? later() : "2026-09-10T10:00:00Z",
      updated_at: later(),
      html_url: `https://example.invalid/pr-comment-${i}`,
    });
  writeFileSync(prFile, JSON.stringify(comments));
  return { dir, stateDir };
}

async function rearm(fixture: { dir: string; stateDir: string }) {
  return runDriveIn(fixture.dir, fixture.stateDir, [
    "--no-head-sync",
    "--max-rounds",
    "1",
    "--",
    ...NOOP,
  ]);
}

describe("what answers a parked item", () => {
  const owner = (body: string, dated: Comment["dated"] = "after"): Comment => ({
    author: "maintainer",
    authorAssociation: "OWNER",
    body,
    dated,
  });

  it("refuses an answer from an author without write access", async () => {
    const r = await rearm(
      await parked([
        { ...owner("Go with option B."), authorAssociation: "CONTRIBUTOR" },
        { ...owner("Go with option B."), authorAssociation: "NONE" },
      ]),
    );
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(r.stderr).toContain("still waiting on thread PRRT_p");
  });

  it("refuses an answer written before the park", async () => {
    const r = await rearm(await parked([owner("Go with option B.", "before")]));
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(r.stderr).toContain("still waiting on thread PRRT_p");
  });

  it("ignores what the drive writes: an outcome reply or a marked comment", async () => {
    const r = await rearm(
      await parked(
        [owner("**rejected** — out of scope.")],
        [owner("answer PRRT_p: option B\n<!-- drive-pr-addressed: x -->")],
      ),
    );
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(r.stderr).toContain("still waiting on thread PRRT_p");
  });

  it("reads a pull-request comment only in the stated answer form", async () => {
    const mention = await rearm(
      await parked([], [owner("Looked at PRRT_p, will decide tomorrow.")]),
    );
    expectSpawnExit({ ...mention, stdout: null }, 8);
    const answered = await rearm(
      await parked([], [owner("Decisions:\nanswer PRRT_p: go with option B")]),
    );
    expectSpawnExit({ ...answered, stdout: null }, 6);
    expect(answered.stderr).toContain(
      "every parked item on PR #999 is answered",
    );
  });
});

describe("re-arming a quota-parked drive on the wall's own account", () => {
  const CLAUDE_PASS = ["claude", "-p", "/jig:drive-pr 999"];

  async function parkedOn(resetAt: string) {
    const fixture = writeFixture({ prState: "MERGED" }, scratchClean.dir);
    const parkedRes = await state(
      fixture.stateDir,
      [
        "quota-park",
        "999",
        "--vendor",
        "claude",
        "--window",
        "weekly",
        "--reset-at",
        resetAt,
        "--account",
        tokenAccount("tok-wall"),
      ],
      scratchClean.dir,
    );
    expectSpawnExit({ ...parkedRes, stderr: null }, 0);
    return fixture;
  }

  it("admits it once the recorded reset has passed", async () => {
    const { dir, stateDir } = await parkedOn(
      new Date(Date.now() - 60_000).toISOString(),
    );
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...CLAUDE_PASS],
      undefined,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-wall" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("its window reset at");
  });

  it("admits it with a person's --window-reopened", async () => {
    const { dir, stateDir } = await parkedOn(later());
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--window-reopened", "--", ...CLAUDE_PASS],
      undefined,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-wall" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("--window-reopened says the window is open");
  });
});

describe("drive.ts --take-over admits and refuses by the holder", () => {
  async function merged() {
    return writeFixture({ prState: "MERGED" }, scratchClean.dir);
  }

  it("admits a dead holder whose tree is clean, recording it DEAD", async () => {
    const { dir, stateDir } = await merged();
    plantPrLock(stateDir, await deadPid(), trackedTree("takeover-dead"));
    await progressAt(stateDir, new Date().toISOString());
    const r = await runDriveIn(dir, stateDir, [
      "--take-over",
      "--no-head-sync",
      "--",
      ...NOOP,
    ]);
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("taking the drive over");
    const after = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
    expect(after.takeovers.map((t: { verdict: string }) => t.verdict)).toEqual([
      "DEAD",
    ]);
  });

  it("refuses a stale lock whose process is still alive", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = await merged();
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      // An old heartbeat makes the lock stale while its process still runs.
      const claim = join(stateDir, "pr-drive-999.lock", "claim.feedc0de");
      const old = (Date.now() - 10 * 60_000) / 1000;
      utimesSync(claim, old, old);
      await progressAt(stateDir, new Date().toISOString());
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--take-over", "--no-head-sync", "--", ...NOOP],
        undefined,
        { env: { DRIVE_PR_LOCK_HEARTBEAT_MIN: "5" } },
      );
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("its process is not confirmed gone");
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("refuses a holder whose verdict is UNKNOWN", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = await merged();
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, "");
      const r = await runDriveIn(dir, stateDir, [
        "--take-over",
        "--no-head-sync",
        "--",
        ...NOOP,
      ]);
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("Doctor verdict: UNKNOWN");
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("refuses a holder with stale progress while its pass is running", async () => {
    const owner = fakeDriver(true);
    try {
      const { dir, stateDir } = await merged();
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, stale());
      const r = await runDriveIn(dir, stateDir, [
        "--take-over",
        "--no-head-sync",
        "--",
        ...NOOP,
      ]);
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("a pass is currently running");
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("exits 2 when no driver holds the lock", async () => {
    const { dir, stateDir } = await merged();
    const r = await runDriveIn(dir, stateDir, [
      "--take-over",
      "--no-head-sync",
      "--",
      ...NOOP,
    ]);
    expectSpawnExit({ ...r, stdout: null }, 2);
    expect(r.stderr).toContain("nothing to take over");
  });

  it("refuses a pass command for another PR before stopping the holder", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = await merged();
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, stale());
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--take-over", "--no-head-sync", "--", "sh", "-c", ": pass for 998"],
        undefined,
        { env: { DRIVE_PR_STOP_GRACE_SEC: "1" } },
      );
      expectSpawnExit({ ...r, stdout: null }, 2);
      expect(r.stderr).not.toContain("stopping it");
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("names the verdict and prints the --take-over command when a plain arm meets a WEDGED holder", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = await merged();
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, stale());
      const r = await runDriveIn(dir, stateDir, [
        "--no-head-sync",
        "--bots-only",
        "--",
        "sh",
        "-c",
        ": pass for 999 --bots-only",
      ]);
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("Its doctor verdict: WEDGED");
      expect(r.stderr).toMatch(/999 --take-over --bots-only -- claude -p/);
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("carries a stamped hold over and reopens the unstamped one with a superseding reply", async () => {
    const owner = fakeDriver();
    const gh = replyRecordingGh("takeover-carry");
    try {
      const { dir, stateDir } = writeFixture(
        {
          threads: [
            { id: "PRRT_s", path: "a.ts", bot: true },
            { id: "PRRT_h", path: "b.ts", bot: true },
          ],
        },
        scratchClean.dir,
      );
      await hold(stateDir, "PRRT_s", "thread", "https://example.invalid/s");
      const stamped = await state(stateDir, [
        "stamp-held",
        "999",
        "--sha",
        HEAD,
      ]);
      expectSpawnExit({ ...stamped, stderr: null }, 0);
      await hold(stateDir, "PRRT_h", "thread", "https://example.invalid/h");
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, stale());
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--take-over", "--no-head-sync", "--max-rounds", "1", "--", ...NOOP],
        undefined,
        { env: { DRIVE_PR_STOP_GRACE_SEC: "1" }, extraBinDir: gh.bin },
      );
      expect(r.stderr).toContain("takeover: recorded in the drive state");
      const after = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
      expect(after.takeovers[0].reopened).toEqual(["PRRT_h"]);
      expect(after.held.map((h: { key: string }) => h.key)).toContain("PRRT_s");
      expect(existsSync(gh.log)).toBe(true);
      const replies = readFileSync(gh.log, "utf8");
      expect(replies).toContain("PRRT_h");
      expect(replies).toContain("Reopened:");
      expect(replies).not.toContain("PRRT_s");
    } finally {
      owner.kill();
      await owner.exited;
    }
  }, 120_000);
});
