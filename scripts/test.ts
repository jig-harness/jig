// Jig's test run: `bun test` under the machine-wide resource lock.
//
// Jig is worked in many worktrees of one clone at once (CONTRIBUTING.md
// § Parallel workspaces), and every `bun run gates` runs this suite. The suite
// spawns process trees by the hundred, so two or more runs at once on one
// machine thrash it: measured on a 16-core laptop with four worktrees' suites
// running, a load average of 190 with 0% idle, every fixture deadline
// expiring, and each run slower than all four would have been in sequence.
// The M12 resource lock
// (modules/M12-parallel-agent-ergonomics/reference/resource-lock/) is the
// practice Jig prescribes for exactly this; here Jig applies it to its own
// suite, so a second worktree's run waits for the first to finish.
//
// The reference script's environment applies (LOCK_NAME, LOCK_ROOT,
// LOCK_POLL), with one default of this suite's own: LOCK_TIMEOUT is an hour
// rather than the reference's minute, because what a run waits for is another
// run of this suite, which takes minutes. The lock is bypassed in CI (CI=1 or
// CI=true), where a runner is already an isolated machine, and with
// RESOURCE_LOCK_BYPASS=1. Arguments are passed on to `bun test` after the
// fixed ones, so `bun run test ./website/` and the gate stage's
// `--path-ignore-patterns=…` work as they did.
import { readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { cli } from "../lib/cli.ts";
import { swallow } from "../plugin/shared/errors.ts";
import {
  main as withResourceLock,
  resourceLockPath,
} from "../plugin/shared/resource-lock.ts";

/** The fixed `bun test` arguments; the caller's extra ones follow them. */
export const TEST_ARGS = ["test", "--timeout", "30000", "--parallel=4"];

/** How long one run waits for another worktree's run, in seconds. */
export const DEFAULT_LOCK_TIMEOUT = "3600";

/** The command `bun run test [extra…]` runs under the lock. */
export function testCommand(
  extra: readonly string[],
  bun = process.execPath,
): string[] {
  return [bun, ...TEST_ARGS, ...extra];
}

/** The lock's environment: the caller's, with this suite's default wait. */
export function lockEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, LOCK_TIMEOUT: env.LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT };
}

/** The lock is not taken when CI or the bypass says so, as in the reference script. */
export function lockBypassed(env: NodeJS.ProcessEnv): boolean {
  return (
    env.CI === "1" || env.CI === "true" || env.RESOURCE_LOCK_BYPASS === "1"
  );
}

/**
 * The pid holding the lock this run is about to contend on, or null when
 * nothing holds it: read where and how the reference script publishes it (a
 * symlink's target on POSIX, a file's content on Windows). Informational,
 * so a run that waits says what it waits for; the reference script's own
 * acquisition is what decides.
 */
export function lockHolder(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
): string | null {
  const name = env.LOCK_NAME || "heavy";
  const root = env.LOCK_ROOT || env.TMPDIR || tmpdir();
  const lock = resourceLockPath(root, name);
  try {
    return platform === "win32"
      ? readFileSync(lock, "utf8")
      : readlinkSync(lock);
  } catch (err) {
    swallow(
      err,
      "no lock holder could be read; the lock's own acquisition decides",
    );
    return null;
  }
}

if (import.meta.main)
  cli(async () => {
    const env = lockEnv(process.env);
    const holder = lockBypassed(env) ? null : lockHolder(env);
    if (holder !== null)
      console.error(
        `test: another run holds the '${env.LOCK_NAME || "heavy"}' lock (pid ${holder}); waiting up to ${env.LOCK_TIMEOUT}s for it to finish`,
      );
    return withResourceLock(testCommand(process.argv.slice(2)), env);
  });
