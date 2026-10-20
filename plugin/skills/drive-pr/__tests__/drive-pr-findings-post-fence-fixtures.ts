/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { expect } from "bun:test";

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join } from "node:path";

import {
  leasePathFor,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease";

import { SCRIPTS, ACTOR, gitCleanEnv } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export function createFindingsPostFenceFixtures() {
  // The CLI surface `/resolve-review-comments` reaches across the skill
  // boundary for. Its refusal semantics are exercised end-to-end through
  // `reply-to-thread.ts` in that skill's own suite; what is unique here is how
  // it SCOPES the question — which PR's lease it looks at, and what it does
  // with an argument it cannot use.
  function stateDirFor(name: string): string {
    return mkdtempSync(join(tmpdir(), `fence-${name}-`));
  }

  // Writes ONLY the per-PR lease file, under this test's own (real) actor —
  // unlike `seedLease` below, which goes through `drive-state.ts phase` and
  // so, as a `LEASED_COMMANDS` side effect, ALSO claims a TREE lease
  // for the same actor. That side effect is exactly right for a
  // real session, but it defeats a test whose whole point is isolating the
  // PER-PR fence's OWN narrowing logic: the tree fence does not narrow by
  // `--pr` at all, so a `seedLease`-based fixture makes every `--pr`-scoped
  // assertion here fail for a reason unrelated to what it tests (the tree
  // fence is wired into `answer-summary-finding.ts`'s posting path too, which
  // this suite's `fence()` helper spawns).
  function seedRawPrLease(stateDir: string, pr: string, pid: number): void {
    writeFileSync(
      leasePathFor(stateDir, pr, ACTOR),
      JSON.stringify({
        holder: "session",
        pid,
        host: hostname(),
        platform: process.platform,
        actor: ACTOR,
        worktree: "",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "phase",
        generation: "e".repeat(32),
        sessionStarted: "",
      }),
    );
  }

  function seedLease(stateDir: string, pr: string, pid: number): void {
    const seed = Bun.spawnSync(
      scriptArgv(
        join(SCRIPTS, "drive-state.ts"),
        "phase",
        pr,
        "--set",
        "triage",
      ),
      {
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_SESSION: String(pid),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(seed.exitCode).toBe(0);
    expect(
      readdirSync(stateDir).filter((f) =>
        new RegExp(`^pr-drive-lease-${pr}-wt-[0-9a-f]{16}\\.json$`).test(f),
      ),
    ).toHaveLength(1);
  }

  async function fence(
    stateDir: string,
    args: string[],
    env: Record<string, string> = {},
  ) {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "assert-post-allowed.ts"), ...args),
      {
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_SESSION: String(process.pid),
          // PINNED to this test's own directory, never inherited. `gitCleanEnv()`
          // strips only `GIT_*`, so every other ambient variable passes through
          // — and if this suite runs under a live `drive.ts` orchestration, that
          // driver exported `$DRIVE_PR_STATE_DIR_IDENTITY` for ITS OWN state
          // directory. Inherited here it names a different directory than the
          // per-test one, so every test would refuse for a reason that has
          // nothing to do with what it asserts.
          //
          // A correct baseline rather than an empty one, because the override
          // path REQUIRES one: `$DRIVE_PR_STATE_DIR` without
          // `$DRIVE_PR_STATE_DIR_IDENTITY` is a superseded driver and refuses.
          // So the default here is what a current `drive.ts` would have
          // exported for this fixture. `...env` still overrides, so a test that
          // wants a stale, malformed or absent baseline sets one explicitly.
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
          DRIVE_PR_SESSION_STARTED: "",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr };
  }

  /**
   * The fence with NO `$DRIVE_PR_STATE_DIR` at all — the standalone
   * `/resolve-review-comments` shape, which resolves its own state directory
   * from git and has no inherited baseline by construction. Kept separate
   * from `fence()` rather than expressed as an override, because "the
   * variable is absent" and "the variable is empty" are different inputs and
   * this helper exists to exercise the first.
   */
  async function fenceNoOverride(args: string[]) {
    const env: Record<string, string> = {
      ...gitCleanEnv(),
      DRIVE_PR_SESSION: String(process.pid),
      DRIVE_PR_SESSION_STARTED: "",
    };
    delete env.DRIVE_PR_STATE_DIR;
    delete env.DRIVE_PR_STATE_DIR_IDENTITY;
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "assert-post-allowed.ts"), ...args),
      {
        env,
        // The repo root, so the non-override path resolves a REAL git common
        // dir — the whole point of this helper is to exercise that resolution
        // rather than an injected one.
        cwd: join(import.meta.dir, "..", "..", "..", ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr };
  }
  return { stateDirFor, seedRawPrLease, seedLease, fence, fenceNoOverride };
}
