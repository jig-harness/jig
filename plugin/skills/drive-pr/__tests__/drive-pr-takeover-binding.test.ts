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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { inspectLock } from "../scripts/lib/driver/locks.ts";
import { isTakeoverRecord } from "../scripts/lib/state/takeover.ts";
import {
  gitCleanEnv,
  hold,
  SCRIPTS,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
  type Fixture,
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
      // This process-lifecycle fixture has no mirrored ledger; publication is covered by ledger-stop.test.ts.
      DRIVE_PR_LEDGER: "off",
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

/** The acquisition time PR 999's planted lock records. */
function claimStarted(stateDir: string): string {
  const started = inspectLock(stateDir, "pr-drive-999")?.diag?.started;
  if (started === undefined) throw new Error("no lock planted");
  return started;
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
  const accepted = {
    body: "**accepted** — fixed in the next push",
    author: "maintainer",
    authorAssociation: "OWNER",
    bot: false,
  };
  const finding = { body: "a finding", bot: true };
  const replyUrl = (id: string) => `https://example.invalid/${id}/comment-1`;

  // Takes over a drive holding the given threads and replies, runs one round
  // whose pass records its notice, and returns what the takeover left behind.
  async function takeOver(
    threads: NonNullable<Fixture["threads"]>,
    holds: Record<string, string>,
  ) {
    const owner = fakeDriver();
    const gh = replyRecordingGh("takeover-binding");
    const noticeFile = join(tmpRoot, "takeover-binding-notice");
    try {
      const { dir, stateDir } = writeFixture({ threads }, scratchClean.dir);
      for (const [key, url] of Object.entries(holds)) {
        await hold(stateDir, key, "thread", url);
      }
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
      expectSpawnExit({ ...r, stdout: "" }, 6);
      const after = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
      return {
        r,
        after,
        gh,
        notice: existsSync(noticeFile) ? readFileSync(noticeFile, "utf8") : "",
      };
    } finally {
      owner.kill();
      await owner.exited;
    }
  }

  it("re-holds an unverified thread unconfirmed with no reply, and reopens a hold the takeover's own reconciliation replaced, on its current reply", async () => {
    // PRRT_h is held on its visible reply; PRRT_c on an earlier one, so the
    // takeover's own reconciliation replaces it before the reopen reads the
    // batch again and reopens the current entry.
    const { r, after, gh, notice } = await takeOver(
      [
        {
          id: "PRRT_h",
          path: "a.ts",
          bot: true,
          comments: [finding, accepted],
        },
        {
          id: "PRRT_c",
          path: "b.ts",
          bot: true,
          comments: [finding, accepted],
        },
        { id: "PRRT_n", path: "c.ts", bot: true },
      ],
      {
        PRRT_h: replyUrl("PRRT_h"),
        PRRT_c: "https://example.invalid/old",
      },
    );
    expect(r.stderr).toContain("2 hold(s) reopened, 0 not");
    const record = after.takeovers[0];
    expect([...record.reopened].sort()).toEqual(["PRRT_c", "PRRT_h"]);
    expect(record.reopenFailed).toBeUndefined();
    const byKey = new Map(
      after.held.map((h: { key: string }) => [h.key, h] as const),
    );
    expect(byKey.get("PRRT_h")).toMatchObject({
      round: -1,
      commentUrl: replyUrl("PRRT_h"),
      outcome: "accepted",
    });
    expect(byKey.get("PRRT_c")).toMatchObject({
      round: -1,
      commentUrl: replyUrl("PRRT_c"),
    });
    // The reply above stays the thread's last qualifying one: nothing new
    // is posted for a reopen.
    expect(existsSync(gh.log)).toBe(false);
    expect(notice).toContain(
      `PRRT_h (was accepted, round 0): re-held unconfirmed on ${replyUrl("PRRT_h")}`,
    );
    expect(notice).not.toContain("could NOT be reopened");
  }, 120_000);

  it("does not bring back a hold the takeover's own reconciliation removed for a superseding merit reply", async () => {
    // PRRT_c is held on its accepted reply, which a later rejection supersedes:
    // the takeover's own reconciliation resolves it and removes the hold.
    const { r, after } = await takeOver(
      [
        {
          id: "PRRT_h",
          path: "a.ts",
          bot: true,
          comments: [finding, accepted],
        },
        {
          id: "PRRT_c",
          path: "b.ts",
          bot: true,
          comments: [
            finding,
            accepted,
            { ...accepted, body: "**rejected** — the premise was wrong" },
          ],
        },
        { id: "PRRT_n", path: "c.ts", bot: true },
      ],
      { PRRT_h: replyUrl("PRRT_h"), PRRT_c: replyUrl("PRRT_c") },
    );
    expect(r.stderr).toContain("1 hold(s) reopened, 0 not");
    expect(after.takeovers[0].reopened).toEqual(["PRRT_h"]);
    const keys = after.held.map((h: { key: string }) => h.key);
    expect(keys).toContain("PRRT_h");
    expect(keys).not.toContain("PRRT_c");
  }, 120_000);
});
