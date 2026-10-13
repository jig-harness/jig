/**
 * drive-pr suite: helpers shared by the drive.ts loop-control files
 * (drive-pr-drive-*.test.ts). Fixtures and probes they build on live in
 * drive-pr-harness.ts.
 */

import { expect } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  SCRIPTS,
  WORKTREE_LOCK,
  type Fixture,
  type CheckRunFixture,
  binDir,
  scratchClean,
  gitCleanEnv,
  writeFixture,
} from "./drive-pr-harness.ts";

/**
 * drive.ts's fixed waits, compressed for every drive `runDriveIn` spawns
 * (a test that spawns drive.ts itself spreads this into its env): the
 * final-CI poll (10s in production), the settle after removing the CI hold
 * label (5s) and the mailbox poll of a paused or quota-parked drive (2s).
 * At the production values the loop-control tests spend most of their time
 * asleep in them. The fixtures answer from files, so a shorter wait changes
 * how long a drive sleeps, never what it reads or decides; a poll-bounded
 * wait still runs its full number of polls. A test that asserts the
 * production pacing sets its own value (per-call env wins over this one).
 */
export const DRIVE_PACING_ENV: Record<string, string> = {
  DRIVE_PR_FINAL_CI_POLL_MS: "50",
  DRIVE_PR_UNLABEL_SETTLE_MS: "50",
  DRIVE_PR_MAILBOX_POLL_MS: "50",
};

/**
 * Drive an ALREADY-WRITTEN fixture, so a probe can inspect the fixture
 * directory afterwards — `ready-calls`, which the stub appends to on every
 * `gh pr ready`, is only reachable this way. `runDrive` builds a fixture and
 * throws the paths away.
 *
 * Spawned in a scratch repo, never the real checkout: the converged exit
 * certifies a clean working tree, and the real checkout is dirty whenever
 * anyone is editing it. `cwd` is overridable so the dirty-tree probe can
 * point at a deliberately dirty repo.
 */
export async function runDriveIn(
  dir: string,
  stateDir: string,
  args: string[],
  cwd?: string,
  opts: {
    env?: Record<string, string>;
    /** Prepended ahead of `binDir` in PATH — for a probe's own `git` stub. */
    extraBinDir?: string;
  } = {},
) {
  const proc = Bun.spawn([join(SCRIPTS, "drive.ts"), "999", ...args], {
    cwd: cwd ?? scratchClean.dir,
    // gitCleanEnv, not process.env: a git hook exports GIT_DIR and
    // GIT_INDEX_FILE, and inheriting them makes every git call inside the
    // spawned script — including the converged clean-tree check — operate
    // on the REAL repository instead of the scratch cwd.
    env: {
      ...gitCleanEnv(),
      PATH: `${opts.extraBinDir ? `${opts.extraBinDir}:` : ""}${binDir}:${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
      ...DRIVE_PACING_ENV,
      ...(opts.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stderr, exitCode };
}

export async function runDrive(
  f: Fixture,
  args: string[],
  cwd?: string,
  opts: {
    env?: Record<string, string>;
    extraBinDir?: string;
  } = {},
) {
  const { dir, stateDir } = writeFixture(f);
  return runDriveIn(dir, stateDir, args, cwd, opts);
}

/** Read one field back out of the durable state a drive just wrote. */
export async function state(stateDir: string, args: string[], cwd?: string) {
  const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
    cwd,
    env: {
      // gitCleanEnv(), not process.env: this suite runs inside a live
      // drive-pr pass as often as not (`runDriveIn`'s doc comment
      // says so), and `drive-state.ts`'s `resolveWorktreeRoot()`
      // anchors to an inherited `DRIVE_PR_WORKTREE` when one is set. Raw
      // `process.env` let that REAL worktree identity leak into a
      // `set-ci-hold` call against this test's own ISOLATED state dir,
      // writing a lease keyed to the real worktree — which the `drive.ts`
      // spawned moments later (via `runDriveIn`, already on
      // `gitCleanEnv()`) then reads back and refuses as "already driven by
      // another working tree", even though nothing but this same test is
      // actually running. A no-op everywhere `DRIVE_PR_WORKTREE` was never
      // set to begin with — i.e. every non-contaminated run, CI included.
      ...gitCleanEnv(),
      DRIVE_PR_STATE_DIR: stateDir,
      // set-ci-hold is test-only fixture seeding —
      // harmless to set unconditionally here since no other command
      // reads this variable.
      DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { stdout, exitCode };
}

// Every pass command must name PR 999 or drive.ts's mis-targeting guard
// rejects it — which `refuses a pass command that names a different PR`
// asserts directly.
export const PASS_NOOP = ["sh", "-c", ": pass for 999; exit 0"];
export const PASS_LOUD = [
  "sh",
  "-c",
  'echo "pass for 999: RAN_THE_PASS" >&2; exit 0',
];
// Echoes the repair-task channel back. Both variables are always
// printed, including when unset, so a test can assert their ABSENCE on an
// ordinary review round as positively as their presence on a repair one.
export const PASS_TASK = [
  "sh",
  "-c",
  'echo "pass for 999: TASK=$DRIVE_PR_ROUND_TASK DETAIL=$DRIVE_PR_ROUND_TASK_DETAIL" >&2; exit 0',
];

/**
 * The worktree-lock name for the SCRATCH tree, resolved through the same
 * function drive.ts calls — from a subprocess standing in that tree,
 * because this process's own derivation is memoised on the suite's cwd
 * (see WORKTREE_LOCK's comment for why no hash is recomputed here).
 */
export async function scratchLockName(): Promise<string> {
  const probe = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))}).then(async (m) => console.log(await m.worktreeLockName()))`,
    ],
    {
      cwd: scratchClean.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, code] = await Promise.all([
    new Response(probe.stdout).text(),
    probe.exited,
  ]);
  expect(code).toBe(0);
  const name = out.trim();
  expect(name.startsWith("pr-drive-worktree-")).toBe(true);
  return name;
}

/** A completed, failed, non-reviewer required check on the current head. */
export const FAILING_RUN: CheckRunFixture = {
  name: "code-quality-and-build",
  status: "completed",
  conclusion: "failure",
  app: "github-actions",
  started: "2026-09-10T10:01:00Z",
};

// Both locks live in the state dir: one keyed by PR, one by the working
// tree. The worktree key is deliberately NOT derived from anything a
// second driver in the same tree can be configured to compute differently
// — $DRIVE_PR_HANDOFF_DIR used to move it, which `keys the WORKTREE lock by
// the tree, not by $DRIVE_PR_HANDOFF_DIR` pins.
export function lockDirs(_dir: string, stateDir: string) {
  return {
    worktree: join(stateDir, WORKTREE_LOCK),
    pr: join(stateDir, "pr-drive-999.lock"),
  };
}

/**
 * Plant a lock INSTANCE. Its generation is the claim's NAME —
 * `claim.<nonce>` — and `<pid> <host>` is all the record holds. The name is
 * what every removal in drive.ts addresses, which is what makes a stale
 * actor's removal a no-op rather than a fence that has to be left standing
 *, so a fixture that puts the generation back inside the record
 * plants debris and tests the debris path instead of the one it means to.
 *
 * `staleMs` backdates the claim's mtime, which IS the heartbeat: a claim
 * whose pid is alive but that has stopped being refreshed is a recycled
 * pid, not a driver.
 */
export function plantClaim(
  dirPath: string,
  opts: {
    pid: number | string;
    host: string;
    nonce: string;
    staleMs?: number;
  },
): string {
  mkdirSync(dirPath, { recursive: true });
  const file = join(dirPath, `claim.${opts.nonce}`);
  writeFileSync(file, `${opts.pid} ${opts.host}\n`);
  if (opts.staleMs !== undefined) {
    const at = (Date.now() - opts.staleMs) / 1000;
    utimesSync(file, at, at);
  }
  return file;
}

/** Every claim a lock directory currently holds. */
export function claimsIn(dirPath: string): string[] {
  return readdirSync(dirPath).filter((n) => n.startsWith("claim."));
}

/**
 * The worktree-lock name for a driver spawned with `cwd` overridden to
 * `treeDir` — resolved through the same function drive.ts calls, from a
 * FRESH subprocess standing in that tree, because this process's own
 * derivation (`WORKTREE_LOCK` in drive-pr-harness.ts) is memoised on the suite's own cwd
 * the moment the test file loads (`worktreeRoot()`'s own doc comment: "a
 * process cannot change which working tree it is in"). A driver spawned
 * with a different `cwd` (and no `$DRIVE_PR_WORKTREE` override of its
 * own) computes a DIFFERENT lock name than `WORKTREE_LOCK`/`lockDirs()`
 * name — not a race, a permanent path mismatch that makes every claim
 * read against `lockDirs()`'s `worktree` fail closed to "absent" for the
 * whole run. Mirrors `scratchLockName()` above, which resolves the same
 * name for the scratch tree.
 */
export async function worktreeLockNameFor(treeDir: string): Promise<string> {
  const probe = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import(${JSON.stringify(join(SCRIPTS, "lib", "state", "store.ts"))}).then(async (m) => console.log(await m.worktreeLockName()))`,
    ],
    { cwd: treeDir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(probe.stdout).text(),
    probe.exited,
  ]);
  if (code !== 0) {
    throw new Error(`worktreeLockNameFor(${treeDir}): probe exited ${code}`);
  }
  const name = out.trim();
  if (!name.startsWith("pr-drive-worktree-")) {
    throw new Error(`worktreeLockNameFor(${treeDir}): got "${name}"`);
  }
  return name;
}

/**
 * Bounded poll: call `probe` up to `tries` times, sleeping `intervalMs`
 * after each falsy result, and return the last result — truthy as soon as
 * the probe succeeds, falsy when it never did. A test asserts on the
 * result, so an exhausted poll fails at the assertion, not here.
 */
export async function pollUntil<T>(
  probe: () => T | Promise<T>,
  tries: number,
  intervalMs = 25,
): Promise<T | undefined> {
  let result: T | undefined;
  for (let i = 0; i < tries && !result; i++) {
    result = await probe();
    if (!result) await Bun.sleep(intervalMs);
  }
  return result;
}

/**
 * Model a successor recovering this lock. Retiring the generation that was
 * there is the load-bearing half: a driver notices a takeover because its
 * OWN claim is gone, never because somebody else's arrived.
 */
export function simulateTakeover(dirPath: string, nonce: string): void {
  for (const name of claimsIn(dirPath)) rmSync(join(dirPath, name));
  plantClaim(dirPath, { pid: process.pid, host: hostname(), nonce });
}
