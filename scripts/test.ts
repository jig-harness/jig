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
// Every invocation writes a fresh JUnit report and runs M14's executed-test
// check, so every suite job and shard refuses a successful all-skipped run.
import { availableParallelism } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { main as withResourceLock } from "../plugin/shared/resource-lock.ts";
import { withoutLeakyGitEnv } from "../plugin/shared/guarded-git-spawn.ts";
import { checkTestsExecuted } from "../modules/M14-testing-strategy/reference/tests-executed/check-tests-executed.ts";

/** The fixed `bun test` arguments; the caller's extra ones follow them. */
export const TEST_ARGS = ["test", "--timeout", "30000"];

/** How long one run waits for another worktree's run, in seconds. */
export const DEFAULT_LOCK_TIMEOUT = "3600";

/** How many test files one run executes at once. */
export function workers(platform = process.platform): number {
  return platform === "win32" ? 1 : 4;
}

/**
 * `bun test` options whose next argument is their value. Options with an
 * optional value (`--bail[=n]`, `--parallel[=n]`) are absent: their value is
 * only ever attached with `=`, so the next argument is a separate option.
 */
const VALUE_OPTIONS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--path-ignore-patterns",
  "--preload",
  "--tsconfig-override",
  "--define",
  "--loader",
  "--conditions",
  "--max-concurrency",
  "--shard",
  "--seed",
]);

/** The worker count `bun test` ends up with: the caller's own `--parallel`, else the default. */
export function effectiveWorkers(
  extra: readonly string[],
  platform = process.platform,
): number {
  let count = workers(platform);
  // Options after `--` are passthrough arguments, and the token after a
  // value-taking option is its value, so neither is read as `--parallel`.
  const end = extra.indexOf("--");
  const options = end < 0 ? extra : extra.slice(0, end);
  options.forEach((arg, i) => {
    if (VALUE_OPTIONS.has(options[i - 1] ?? "")) return;
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
    // Scrub before Bun starts: its implicit child environment retains
    // startup values even after a test preload deletes process.env keys.
    ...withoutLeakyGitEnv(env),
    LOCK_TIMEOUT: env.LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT,
    LOCK_RUN_COST:
      env.LOCK_RUN_COST || String(effectiveWorkers(extra, platform)),
  };
}

if (import.meta.main)
  cli(async () => {
    const extra = process.argv.slice(2);
    // A fresh report per invocation cannot borrow another shard's results.
    // Keep it outside discovery and remove it even when the suite fails.
    const work = mkdtempSync(join(tmpdir(), "jig-test-report-"));
    const report = join(work, "junit.xml");
    try {
      const split = extra.indexOf("--");
      const options = split < 0 ? extra : extra.slice(0, split);
      const passthrough = split < 0 ? [] : extra.slice(split);
      const status = await withResourceLock(
        testCommand([
          ...options,
          "--reporter=junit",
          `--reporter-outfile=${report}`,
          ...passthrough,
        ]),
        lockEnv(process.env, process.platform, extra),
      );
      // A failed suite or lock admission must keep its own status. A suite
      // that exits successfully still has to show that it executed a test.
      return status || checkTestsExecuted([report]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
