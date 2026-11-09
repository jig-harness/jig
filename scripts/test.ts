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
// suite, so a run starts only while the machine has room for one more, and
// otherwise waits, saying what it waits on and who holds the lock.
//
// The reference script's environment applies (LOCK_NAME, LOCK_ROOT,
// LOCK_POLL, LOCK_SLOTS and the admission settings), with two defaults of
// this suite's own: LOCK_TIMEOUT is an hour rather than the reference's
// minute, because what a run waits for is another run of this suite, which
// takes minutes; and LOCK_RUN_COST, the load one run adds, is the suite's
// effective worker count. The lock is bypassed in CI (CI=1 or CI=true), where a runner
// is already an isolated machine, and with RESOURCE_LOCK_BYPASS=1. Arguments
// are passed on to `bun test` after the fixed ones, so `bun run test
// ./website/` and the gate stage's `--path-ignore-patterns=…` work as they
// did.
import { availableParallelism } from "node:os";
import { cli } from "../lib/cli.ts";
import { main as withResourceLock } from "../plugin/shared/resource-lock.ts";

/** The fixed `bun test` arguments; the caller's extra ones follow them. */
export const TEST_ARGS = ["test", "--timeout", "30000"];

/** How long one run waits for another worktree's run, in seconds. */
export const DEFAULT_LOCK_TIMEOUT = "3600";

/** How many test files one run executes at once. */
export function workers(platform = process.platform): number {
  return platform === "win32" ? 1 : 4;
}

/** The worker count `bun test` ends up with: the caller's own `--parallel`, else the default. */
export function effectiveWorkers(
  extra: readonly string[],
  platform = process.platform,
): number {
  let count = workers(platform);
  extra.forEach((arg, i) => {
    // A bare `--parallel` asks for one worker per CPU core.
    const given =
      /^--parallel=(\d+)$/.exec(arg)?.[1] ??
      (arg === "--parallel"
        ? (/^\d+$/.exec(extra[i + 1] ?? "")?.[0] ??
          String(availableParallelism()))
        : undefined);
    if (given !== undefined && Number(given) > 0) count = Number(given);
  });
  return count;
}

/** The command `bun run test [extra…]` runs under the lock. */
export function testCommand(
  extra: readonly string[],
  bun = process.execPath,
  platform = process.platform,
): string[] {
  return [bun, ...TEST_ARGS, `--parallel=${workers(platform)}`, ...extra];
}

/** The lock's environment: the caller's, with this suite's default wait and run cost. */
export function lockEnv(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  extra: readonly string[] = [],
): NodeJS.ProcessEnv {
  return {
    ...env,
    LOCK_TIMEOUT: env.LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT,
    LOCK_RUN_COST:
      env.LOCK_RUN_COST || String(effectiveWorkers(extra, platform)),
  };
}

if (import.meta.main)
  cli(async () => {
    const extra = process.argv.slice(2);
    return withResourceLock(
      testCommand(extra),
      lockEnv(process.env, process.platform, extra),
    );
  });
