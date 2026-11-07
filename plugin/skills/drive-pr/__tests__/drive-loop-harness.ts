import { fixtureStateTree } from "./scoped-state-dir.ts";
/**
 * drive-pr suite: helpers shared by the drive.ts loop-control files
 * (drive-pr-drive-*.test.ts). Fixtures and probes they build on live in
 * drive-pr-harness.ts.
 */

import { expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, delimiter } from "node:path";
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
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { shellQuote } from "../../../shared/cli.ts";
import { driveDb } from "../scripts/lib/state/db.ts";
import { lockRow, putLock } from "./state-rows.ts";

import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";

/** Full driver fixtures whose native startup cost exceeds the existing budget. */
export const skipLongDriveFixture = skipsOnWindows(
  "fixture-throughput",
  "the multi-round or long-CI driver fixture exceeds 30 seconds on native Windows",
);

/** Wait for actual pass readiness; the budget includes native fixture startup. */
export async function awaitFixtureMarker(marker: string): Promise<boolean> {
  const budgetMs = Number(
    byPlatform(
      "native Windows must launch the CLI and Git Bash fixture chain before a pass can announce itself",
      { windows: "60000", posix: "10000" },
    ),
  );
  const deadline = Date.now() + budgetMs;
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(25);
  return existsSync(marker);
}

/**
 * Shell commands for a pass that announces itself at `started` and then stays
 * running until the test creates `release`, so a test's operations against
 * the active pass cannot race the pass's exit however the test is scheduled.
 * The wait is bounded (about 60 s) so a test that fails before releasing
 * never leaves the pass behind; the test's own timeout is longer. Both paths
 * are single-quoted, so a temporary directory whose name holds `$` or a
 * backtick is read as the same literal path the test checks.
 */
export function blockedPassScript(started: string, release: string): string {
  return [
    `: > ${shellQuote(started)}`,
    "i=0",
    `while [ ! -e ${shellQuote(release)} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`,
    "exit 0",
  ].join("\n");
}

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
 * It also turns the drive ledger off (see the entry's comment).
 */
export const DRIVE_PACING_ENV: Record<string, string> = {
  DRIVE_PR_FINAL_CI_POLL_MS: "50",
  DRIVE_PR_UNLABEL_SETTLE_MS: "50",
  DRIVE_PR_MAILBOX_POLL_MS: "50",
  // The stub forge never returns a comment it was posted, so a drive writing
  // its ledger would add a post per round to what these suites count; the
  // ledger's own suite turns it on.
  DRIVE_PR_LEDGER: "off",
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
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "drive.ts"), "999", ...args),
    {
      cwd: cwd ?? scratchClean.dir,
      // gitCleanEnv, not process.env: a git hook exports GIT_DIR and
      // GIT_INDEX_FILE, and inheriting them makes every git call inside the
      // spawned script — including the converged clean-tree check — operate
      // on the REAL repository instead of the scratch cwd.
      env: {
        ...gitCleanEnv(),
        PATH: `${opts.extraBinDir ? `${opts.extraBinDir}${delimiter}` : ""}${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
        ...DRIVE_PACING_ENV,
        ...(opts.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
  const { dir, stateDir } = writeFixture(f, cwd ?? scratchClean.dir);
  return runDriveIn(dir, stateDir, args, cwd, opts);
}

/** Read one field back out of the durable state a drive just wrote. */
export async function state(stateDir: string, args: string[], cwd?: string) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args), {
    cwd: cwd ?? fixtureStateTree(stateDir),
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
      DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
      // set-ci-hold is test-only fixture seeding —
      // harmless to set unconditionally here since no other command
      // reads this variable.
      DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
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

// Every pass command must name PR 999 or drive.ts's mis-targeting guard
// rejects it — which `refuses a pass command that names a different PR`
// asserts directly. A marker a test looks for is split in the shell source
// (`RAN_TH""E_PASS`): a stop prints the re-arm command with this argv, and
// only the shell running the pass may put the whole marker on stderr.
export const PASS_NOOP = ["sh", "-c", ": pass for 999; exit 0"];
export const PASS_LOUD = [
  "sh",
  "-c",
  'echo "pass for 999: RAN_TH""E_PASS" >&2; exit 0',
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

/** A driver lock: the clone's state directory and the lock's name in its database. */
export interface LockSlot {
  stateDir: string;
  name: string;
}

// Both locks are rows of the clone's database: one keyed by PR, one by the
// working tree. The worktree key is deliberately NOT derived from anything a
// second driver in the same tree can be configured to compute differently
// — `keys the WORKTREE lock by the tree, not by $DRIVE_PR_HANDOFF_DIR` pins
// it.
export function lockDirs(
  _dir: string,
  stateDir: string,
): { worktree: LockSlot; pr: LockSlot } {
  return {
    worktree: { stateDir, name: WORKTREE_LOCK },
    pr: { stateDir, name: "pr-drive-999" },
  };
}

/** Whether a driver lock is held: its row exists. */
export function lockHeld(slot: LockSlot): boolean {
  return lockRow(slot.stateDir, slot.name) !== null;
}

/**
 * Plant a lock held by `pid` on `host` under acquisition token `nonce`.
 * `staleMs` backdates its heartbeat: a lock whose pid is alive but that has
 * stopped being renewed is a recycled pid, not a driver.
 */
export function plantClaim(
  slot: LockSlot,
  opts: {
    pid: number | string;
    host: string;
    nonce: string;
    platform?: string | null;
    staleMs?: number;
    diag?: unknown;
  },
): void {
  putLock(slot.stateDir, slot.name, {
    pid: Number(opts.pid),
    host: opts.host,
    ...(opts.host === hostname() ? {} : { hostId: "" }),
    token: opts.nonce,
    platform: opts.platform === null ? "" : (opts.platform ?? process.platform),
    ...(opts.diag === undefined ? {} : { diag: opts.diag }),
    ...(opts.staleMs === undefined
      ? {}
      : { renewedAt: new Date(Date.now() - opts.staleMs).toISOString() }),
  });
}

/** The acquisition token a driver lock holds, as `claim.<token>`; none when nobody holds it. */
export function claimsIn(slot: LockSlot): string[] {
  const row = lockRow(slot.stateDir, slot.name);
  return row === null ? [] : [`claim.${row.token}`];
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
 * Model a successor recovering this lock: the row is replaced under another
 * token, which is how a driver notices a takeover — its own token is gone.
 */
export function simulateTakeover(slot: LockSlot, nonce: string): void {
  plantClaim(slot, { pid: process.pid, host: hostname(), nonce });
}

/** An SQL string literal. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Make the drive database refuse writes to some of a clone's rows until the
 * returned function lifts it: triggers that abort an insert or update of a
 * row of `table` whose `key` columns hold the given values, for a probe that
 * needs a store which still reads but cannot be written. With `columns`,
 * only an update that sets one of them is refused, and inserts are not.
 * Every process that opens the database sees the triggers, so a spawned
 * script fails the same way, at the statement, as on a store that cannot be
 * written.
 */
export function refuseWrites(
  stateDir: string,
  table: string,
  key: Record<string, string>,
  columns: string[] = [],
): () => void {
  const drive = driveDb(stateDir);
  const when = Object.entries({ clone: drive.clone, ...key })
    .map(([column, value]) => `NEW.${column} = ${sqlText(value)}`)
    .join(" AND ");
  const name = `test_refuse_${table}_${randomBytes(4).toString("hex")}`;
  const abort = "BEGIN SELECT RAISE(ABORT, 'writes refused by the test'); END";
  const of = columns.length === 0 ? "" : ` OF ${columns.join(", ")}`;
  const triggers = [`${name}_update`];
  drive.db.run(
    `CREATE TRIGGER ${name}_update BEFORE UPDATE${of} ON ${table} WHEN ${when} ${abort}`,
  );
  if (columns.length === 0) {
    triggers.push(`${name}_insert`);
    drive.db.run(
      `CREATE TRIGGER ${name}_insert BEFORE INSERT ON ${table} WHEN ${when} ${abort}`,
    );
  }
  return () => {
    for (const t of triggers) drive.db.run(`DROP TRIGGER IF EXISTS ${t}`);
  };
}

/**
 * Make a driver lock refuse its diagnostics rewrite (the account-identity
 * update) while its heartbeat renewal, which sets no diagnostics, still
 * lands: a stand-in for a write that fails on this one lock only.
 */
export function refuseDiagWrites(slot: LockSlot): () => void {
  return refuseWrites(slot.stateDir, "locks", { name: slot.name }, ["detail"]);
}
