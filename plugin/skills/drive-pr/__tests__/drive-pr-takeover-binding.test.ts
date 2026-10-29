/**
 * drive-pr suite: what `--take-over` binds to what it observed — the stop of
 * a wedged holder to the acquisition its doctor row named
 * (`drives.ts --stop --expect-started`), and each reopened hold to what the
 * held batch reads back afterwards: a thread re-held unconfirmed on its own
 * reply, the state the replied-thread sweep gives it, with no reply posted,
 * and a hold that changed under the takeover recorded apart, not as reopened.
 * Shared fixtures live in drive-pr-harness.ts, drive-loop-harness.ts and
 * drive-pr-pickup-fixtures.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { isTakeoverRecord } from "../scripts/lib/state/takeover.ts";
import {
  gitCleanEnv,
  hold,
  SCRIPTS,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { pollUntil, runDriveIn, state } from "./drive-loop-harness.ts";
import {
  alive,
  fakeDriver,
  plantPrLock,
  progressAt,
  replyRecordingGh,
  stale,
} from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

/** Run `drives.ts` against `stateDir`, from the shared scratch tree. */
async function drives(stateDir: string, args: string[]) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drives.ts"), ...args), {
    cwd: scratchClean.dir,
    env: {
      ...gitCleanEnv(),
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_STOP_GRACE_SEC: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** The acquisition time PR 999's planted claim records. */
function claimStarted(stateDir: string): string {
  const lock = join(stateDir, "pr-drive-999.lock");
  const claim = readdirSync(lock).find((f) => f.startsWith("claim."));
  if (claim === undefined) throw new Error("no claim planted");
  const diag = readFileSync(join(lock, claim), "utf8").split("\n")[1] ?? "";
  return (JSON.parse(diag) as { started: string }).started;
}

describe("drives.ts --stop --expect-started", () => {
  it("refuses a holder of another acquisition with exit 3, and stops the one it names", async () => {
    const owner = fakeDriver();
    try {
      const { stateDir } = writeFixture({}, scratchClean.dir);
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      const other = await drives(stateDir, [
        "--stop",
        "999",
        "--expect-started",
        "2026-01-01T00:00:00.000Z",
      ]);
      expectSpawnExit(other, 3);
      expect(other.stdout).toContain("held by another acquisition");
      expect(alive(owner.pid)).toBe(true);
      const named = await drives(stateDir, [
        "--stop",
        "999",
        "--expect-started",
        claimStarted(stateDir),
      ]);
      expectSpawnExit(named, 0);
      expect(await pollUntil(() => !alive(owner.pid), 200)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  }, 60_000);

  it("is refused without --stop", async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    const r = await drives(stateDir, ["--expect-started", "x"]);
    expectSpawnExit(r, 2);
  });
});

describe("the takeover record's reopenFailed", () => {
  const record = {
    at: "2026-10-01T00:00:00.000Z",
    fromActor: null,
    fromAccount: null,
    toActor: "wt-0123456789abcdef",
    toAccount: null,
    verdict: "WEDGED",
    round: 1,
    reopened: [],
  };

  it("is optional, and a key list when present", () => {
    expect(isTakeoverRecord(record)).toBe(true);
    expect(isTakeoverRecord({ ...record, reopenFailed: ["PRRT_c"] })).toBe(
      true,
    );
    expect(isTakeoverRecord({ ...record, reopenFailed: [""] })).toBe(false);
    expect(isTakeoverRecord({ ...record, reopenFailed: "PRRT_c" })).toBe(false);
  });
});

describe("drive.ts --take-over reopening unverified holds", () => {
  it("re-holds an unverified thread unconfirmed with no reply, and records a hold that changed apart", async () => {
    const owner = fakeDriver();
    const gh = replyRecordingGh("takeover-binding");
    const noticeFile = join(tmpRoot, "takeover-binding-notice");
    const accepted = {
      body: "**accepted** — fixed in the next push",
      author: "maintainer",
      authorAssociation: "OWNER",
      bot: false,
    };
    try {
      const { dir, stateDir } = writeFixture(
        {
          threads: [
            {
              id: "PRRT_h",
              path: "a.ts",
              bot: true,
              comments: [{ body: "a finding", bot: true }, accepted],
            },
            {
              id: "PRRT_c",
              path: "b.ts",
              bot: true,
              comments: [{ body: "a finding", bot: true }, accepted],
            },
            { id: "PRRT_n", path: "c.ts", bot: true },
          ],
        },
        scratchClean.dir,
      );
      // PRRT_h is held on its visible reply; PRRT_c on an earlier one, so the
      // takeover's own reconciliation replaces it before the reopen reaches it.
      const replyH = "https://example.invalid/PRRT_h/comment-1";
      const replyC = "https://example.invalid/PRRT_c/comment-1";
      await hold(stateDir, "PRRT_h", "thread", replyH);
      await hold(stateDir, "PRRT_c", "thread", "https://example.invalid/old");
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, stale());
      const pass = [
        "sh",
        "-c",
        `: pass for 999\nprintf '%s' "$DRIVE_PR_PASS_NOTICE" > '${noticeFile}'`,
      ];
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--take-over", "--no-head-sync", "--max-rounds", "1", "--", ...pass],
        undefined,
        { env: { DRIVE_PR_STOP_GRACE_SEC: "1" }, extraBinDir: gh.bin },
      );
      expect(r.stderr).toContain("1 hold(s) reopened, 1 not");
      const after = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
      const record = after.takeovers[0];
      expect(record.reopened).toEqual(["PRRT_h"]);
      expect(record.reopenFailed).toEqual(["PRRT_c"]);
      const byKey = new Map(
        after.held.map((h: { key: string }) => [h.key, h] as const),
      );
      expect(byKey.get("PRRT_h")).toMatchObject({
        round: -1,
        commentUrl: replyH,
        outcome: "accepted",
      });
      expect(byKey.get("PRRT_c")).toMatchObject({
        round: -1,
        commentUrl: replyC,
      });
      // The reply above stays the thread's last qualifying one: nothing new
      // is posted for a reopen.
      expect(existsSync(gh.log)).toBe(false);
      const notice = readFileSync(noticeFile, "utf8");
      expect(notice).toContain(
        `PRRT_h (was accepted, round 0): re-held unconfirmed on ${replyH}`,
      );
      expect(notice).toContain("could NOT be reopened");
      expect(notice).toContain(
        "PRRT_c (was accepted, round 0): NOT reopened — it is now held for another reply",
      );
    } finally {
      owner.kill();
      await owner.exited;
    }
  }, 120_000);
});
