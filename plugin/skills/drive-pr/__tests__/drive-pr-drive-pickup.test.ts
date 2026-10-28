/**
 * drive-pr suite: drive.ts picking a stopped drive up — the pass-deadline
 * restart and its budget, the re-arm after a quota park by another account,
 * the re-arm once every parked item is answered, and `--take-over`.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { formatClaim } from "../scripts/lib/claim.ts";
import { accountHash } from "../scripts/lib/identity.ts";
import {
  gitCleanEnv,
  hold,
  makeScratchRepo,
  park,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import {
  pollUntil,
  runDrive,
  runDriveIn,
  state,
} from "./drive-loop-harness.ts";

useDrivePrSuite();

/** The hashed account a `CLAUDE_CODE_OAUTH_TOKEN` pass bills. */
function tokenAccount(token: string): string {
  const fp = createHash("sha256").update(token).digest("hex").slice(0, 12);
  const hash = accountHash({
    account: `token:${fp}`,
    vendor: "claude",
    provenance: "CLAUDE_CODE_OAUTH_TOKEN",
    reason: null,
  });
  if (hash === null) throw new Error("a resolved identity always hashes");
  return hash;
}

/** Whether a process is still running, by the signal-0 probe. */
function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** A scratch repository of the test's own, so leftovers stay out of the shared one. */
function ownTree(name: string): string {
  return makeScratchRepo(`pickup-${name}`).dir;
}

describe("drive.ts restarts a pass killed at its deadline", () => {
  it("restarts the round, tells the next pass what the killed one left, and drives on", async () => {
    const tree = ownTree("deadline-retry");
    const marker = join(tmpRoot, "pickup-deadline-retry-killed");
    // The first pass leaves an uncommitted file and hangs past its deadline;
    // the restarted one reads its notice and completes.
    const pass = [
      "sh",
      "-c",
      [
        ": pass for 999",
        `if [ ! -e '${marker}' ]; then : > '${marker}'; echo wip > wip.txt; sleep 60; fi`,
        'case "$DRIVE_PR_PASS_NOTICE" in "RESTARTED AFTER A PASS DEADLINE"*) echo "pass for 999: RETRY_PASS_OK" >&2 ;; esac',
        "exit 0",
      ].join("\n"),
    ];
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--pass-timeout",
        "1",
        "--max-rounds",
        "2",
        "--",
        ...pass,
      ],
      tree,
    );
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).toContain("deadline retry 1 of 2");
    expect(r.stderr).toContain("wip.txt");
    expect(r.stderr).toContain("RETRY_PASS_OK");
    expect(r.stderr).not.toContain("retry budget is spent");
  }, 120_000);

  it("stops as PASS_DEADLINE once drive.pass_deadline_retries is spent", async () => {
    const r = await runDrive(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      [
        "--no-head-sync",
        "--pass-timeout",
        "1",
        "--",
        "sh",
        "-c",
        ": pass for 999; sleep 60",
      ],
      ownTree("deadline-spent"),
      { env: { JIG__DRIVE__PASS_DEADLINE_RETRIES: "1" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 15);
    expect(r.stderr).toContain("deadline retry 1 of 1");
    expect(r.stderr).toContain("retry budget is spent (1");
    expect(r.stderr.match(/was killed/g)?.length).toBe(2);
    expect(r.stderr).toContain("git status --short");
  }, 120_000);
});

describe("drive.ts re-arms a quota-parked drive only from another account", () => {
  const future = () => new Date(Date.now() + 24 * 3600_000).toISOString();
  const CLAUDE_PASS = ["claude", "-p", "/jig:drive-pr 999"];

  async function quotaParked(account: string | null) {
    const { dir, stateDir } = writeFixture(
      { prState: "MERGED" },
      scratchClean.dir,
    );
    const parked = await state(
      stateDir,
      [
        "quota-park",
        "999",
        "--vendor",
        "claude",
        "--window",
        "weekly",
        "--reset-at",
        future(),
        ...(account === null ? [] : ["--account", account]),
      ],
      scratchClean.dir,
    );
    expectSpawnExit({ ...parked, stderr: null }, 0);
    return { dir, stateDir };
  }

  it("admits a pass that bills a different account", async () => {
    const { dir, stateDir } = await quotaParked(tokenAccount("tok-wall"));
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...CLAUDE_PASS],
      undefined,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-other" } },
    );
    // Past the admission the gate finds the PR merged.
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("a different account — driving on");
  });

  it("refuses a pass that bills the account the wall belongs to", async () => {
    const wall = tokenAccount("tok-wall");
    const { dir, stateDir } = await quotaParked(wall);
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...CLAUDE_PASS],
      undefined,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-wall" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 16);
    expect(r.stderr).toContain(
      `the same account the wall belongs to (${wall})`,
    );
  });

  it("refuses when the pass's account is unknown", async () => {
    const { dir, stateDir } = await quotaParked(tokenAccount("tok-wall"));
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      "sh",
      "-c",
      ": pass for 999",
    ]);
    expectSpawnExit({ ...r, stdout: null }, 16);
    expect(r.stderr).toContain("the account this pass bills is unknown");
  });

  it("refuses when the wall's account was not recorded", async () => {
    const { dir, stateDir } = await quotaParked(null);
    const r = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", ...CLAUDE_PASS],
      undefined,
      { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok-other" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 16);
    expect(r.stderr).toContain("did not record the account");
  });
});

describe("drive.ts re-arms a HITL-parked drive once every item is answered", () => {
  const PASS = [
    "sh",
    "-c",
    [
      ": pass for 999",
      'case "$DRIVE_PR_PASS_NOTICE" in "RE-ARMED WITH HUMAN ANSWERS"*) echo "pass for 999: HUMAN_VERDICTS" >&2 ;; esac',
      'printf "%s" "$DRIVE_PR_PASS_NOTICE" | grep -q "option B" && echo "pass for 999: ANSWER_SEEN" >&2',
      "exit 0",
    ].join("\n"),
  ];

  async function parkedThread(answered: boolean) {
    const { dir, stateDir } = writeFixture(
      {
        threads: [
          {
            id: "PRRT_p",
            path: "a.ts",
            bot: true,
            comments: [
              { body: "a finding", bot: true },
              ...(answered
                ? [
                    {
                      author: "maintainer",
                      authorAssociation: "OWNER",
                      body: "Go with option B.",
                      bot: false,
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      scratchClean.dir,
    );
    await park(stateDir, "PRRT_p", "thread");
    // The fixture dates every comment before the park; the answer comes after.
    const file = join(dir, "threads.json");
    const threads = JSON.parse(readFileSync(file, "utf8"));
    for (const c of threads.data.repository.pullRequest.reviewThreads.nodes[0]
      .comments.nodes)
      if (c.author.login === "maintainer")
        c.createdAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(file, JSON.stringify(threads));
    return { dir, stateDir };
  }

  it("unparks the answered items and hands the answers to the first round", async () => {
    const { dir, stateDir } = await parkedThread(true);
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--max-rounds",
      "1",
      "--",
      ...PASS,
    ]);
    expectSpawnExit({ ...r, stdout: null }, 6);
    expect(r.stderr).toContain("every parked item on PR #999 is answered");
    expect(r.stderr).toContain("HUMAN_VERDICTS");
    expect(r.stderr).toContain("ANSWER_SEEN");
    const after = await state(stateDir, ["get", "999"]);
    expect(JSON.parse(after.stdout).parked).toEqual([]);
  });

  it("leaves every item parked and stops HITL_PARKED while one is unanswered", async () => {
    const { dir, stateDir } = await parkedThread(false);
    const r = await runDriveIn(dir, stateDir, [
      "--no-head-sync",
      "--",
      ...PASS,
    ]);
    expectSpawnExit({ ...r, stdout: null }, 8);
    expect(r.stderr).toContain("still waiting on thread PRRT_p");
    expect(r.stderr).not.toContain("HUMAN_VERDICTS");
    expect(r.stderr).toContain("Once every one is answered, re-arm");
  });
});

describe("drive.ts --take-over", () => {
  /** A process whose command line reads as a driver's, as `--stop` checks. */
  function fakeDriver() {
    return Bun.spawn(
      [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000)",
        "drive.ts",
        "999",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  }

  function plantPrLock(stateDir: string, pid: number, worktree: string): void {
    const lock = join(stateDir, "pr-drive-999.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "claim.feedc0de"),
      formatClaim(pid, hostname(), {
        pr: "999",
        worktree,
        log: join(stateDir, "drive-pr-999.log"),
        started: new Date().toISOString(),
        account: {
          account: "dev@example.invalid",
          vendor: "claude",
          provenance: "oauthAccount",
          reason: null,
        },
      }),
    );
  }

  /** Back-date (or freshen) the drive's progress, as the doctor reads it. */
  async function progressAt(stateDir: string, iso: string): Promise<void> {
    await state(stateDir, ["phase", "999", "--set", "probe"]);
    const file = join(stateDir, "drive-pr-999.json");
    const s = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...s, lastProgressAt: iso }));
  }

  it("refuses against a HEALTHY holder, naming its verdict, and leaves it running", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = writeFixture(
        { prState: "MERGED" },
        scratchClean.dir,
      );
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(stateDir, new Date().toISOString());
      const r = await runDriveIn(dir, stateDir, [
        "--take-over",
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        ": pass for 999",
      ]);
      expectSpawnExit({ ...r, stdout: null }, 11);
      expect(r.stderr).toContain("refusing to take over PR #999");
      expect(r.stderr).toContain("Doctor verdict: HEALTHY");
      expect(r.stderr).toContain(
        "Do not stop a driver that is making progress",
      );
      expect(alive(owner.pid)).toBe(true);
    } finally {
      owner.kill();
      await owner.exited;
    }
  });

  it("stops a WEDGED holder, records the takeover, reconciles, and reopens an unlanded hold", async () => {
    const owner = fakeDriver();
    try {
      const { dir, stateDir } = writeFixture(
        { prState: "MERGED" },
        scratchClean.dir,
      );
      await hold(stateDir, "PRRT_h", "thread");
      plantPrLock(stateDir, owner.pid, scratchClean.dir);
      await progressAt(
        stateDir,
        new Date(Date.now() - 5 * 3600_000).toISOString(),
      );
      const r = await runDriveIn(
        dir,
        stateDir,
        ["--take-over", "--no-head-sync", "--", "sh", "-c", ": pass for 999"],
        undefined,
        { env: { DRIVE_PR_STOP_GRACE_SEC: "1" } },
      );
      // Past the takeover the gate finds the PR merged.
      expectSpawnExit({ ...r, stdout: null }, 5);
      expect(r.stderr).toContain("driver is WEDGED; stopping it");
      expect(r.stderr).toContain(
        "ran reconcile-replied-threads.ts before the first triage",
      );
      expect(r.stderr).toContain("takeover: recorded in the drive state");
      // The stop witnessed the holder gone before the takeover went on.
      expect(await pollUntil(() => !alive(owner.pid), 200)).toBe(true);
      const after = JSON.parse((await state(stateDir, ["get", "999"])).stdout);
      expect(after.takeovers).toHaveLength(1);
      const record = after.takeovers[0];
      expect(record.verdict).toBe("WEDGED");
      expect(record.reopened).toEqual(["PRRT_h"]);
      expect(record.fromActor).toBe(record.toActor);
      expect(after.held.map((h: { key: string }) => h.key)).not.toContain(
        "PRRT_h",
      );
    } finally {
      owner.kill();
      await owner.exited;
    }
  }, 120_000);

  it("refuses a dead holder on this machine while its tree holds leftovers", async () => {
    const dead = Bun.spawn(["sh", "-c", ":"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await dead.exited;
    // The dead driver's tree tracks a remote, so its leftovers can be counted.
    const tree = ownTree("takeover-leftovers");
    const origin = join(tmpRoot, "pickup-takeover-leftovers-origin");
    const git = (cwd: string, ...args: string[]) =>
      expectSpawnExit(
        Bun.spawnSync(["git", ...args], {
          cwd,
          env: gitCleanEnv(),
          stdout: "pipe",
          stderr: "pipe",
        }),
        0,
      );
    git(tmpRoot, "init", "-q", "--bare", origin);
    git(tree, "remote", "add", "origin", origin);
    git(tree, "push", "-q", "-u", "origin", "main");
    writeFileSync(join(tree, "stranded.txt"), "unfinished fix\n");
    const { dir, stateDir } = writeFixture(
      { prState: "MERGED" },
      scratchClean.dir,
    );
    plantPrLock(stateDir, dead.pid, tree);
    await progressAt(stateDir, new Date().toISOString());
    const r = await runDriveIn(dir, stateDir, [
      "--take-over",
      "--no-head-sync",
      "--",
      "sh",
      "-c",
      ": pass for 999",
    ]);
    expectSpawnExit({ ...r, stdout: null }, 11);
    expect(r.stderr).toContain("DEAD_WITH_LEFTOVERS");
    expect(r.stderr).toContain("uncommitted changes");
    expect(r.stderr).toContain("Push or discard them first");
  });
});
