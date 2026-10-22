/**
 * Marks a test that cannot pass on Windows yet, and names the work that lifts
 * the skip. It is the only way the drive-pr and do-item suites skip a whole
 * test on Windows, so every skipped test points at one of the pieces of the
 * plan item "Windows for `drive-pr` and `do-item`" (design/plan.md) and
 * disappears when that piece lands. Inside a running test, a check only a
 * POSIX system can make goes through exceptOnWindows, and a value that differs
 * by platform through byPlatform; both say why. A test that calls either must
 * make an assertion on the platform it runs on, so a test whose every check
 * is POSIX-only, or that returns on one platform before asserting anything,
 * fails rather than passing with nothing checked. windows-skip.test.ts refuses
 * every other `===`, `!==` or `case` comparison with "win32" in the suites; a
 * platform check written another way is for review to catch.
 *
 *   it.skipIf(skipsOnWindows("process-lifecycle", "reads process state through ps"))(
 *     "finds the pass tree", () => { … });
 *   describe.skipIf(skipsOnWindows("file-system", "claims are hard links"))(…)
 *   exceptOnWindows("Windows reports 0o666 for any writable file", () =>
 *     expect(mode).toBe(0o600));
 *   const probe = byPlatform("Windows has no ps", {
 *     windows: "Get-Process -Id 42", posix: "ps -p 42" });
 */

import { expect } from "bun:test";

/** The pieces of work whose completion makes a skipped test pass on Windows. */
export const WINDOWS_STEPS = {
  /** Finding, waiting on and stopping a pass's processes without `ps` and POSIX signals. */
  "process-lifecycle": "process lifecycle without ps and POSIX signals",
  /** State, locks and paths hardened for Windows file-system semantics. */
  "file-system": "state, locks and paths hardened for Windows file systems",
  /** The skills' instructions and invocations under Git Bash, and resolving the pass launcher. */
  "git-bash": "the skills under Git Bash and the pass launcher",
  /** The skills under PowerShell, for a machine without Git Bash. */
  powershell: "the skills under PowerShell",
  /** Native fixture throughput within the existing test deadlines. */
  "fixture-throughput": "native fixture throughput within test budgets",
} as const;

export type WindowsStep = keyof typeof WINDOWS_STEPS;

/** A Windows skip written without a piece of work or without a reason. */
class WindowsSkipError extends Error {}

/**
 * True on Windows. `step` names the work that lifts the skip and `reason` says
 * what fails until it lands; both are for the reader of the test.
 */
export function skipsOnWindows(step: WindowsStep, reason: string): boolean {
  if (!Object.hasOwn(WINDOWS_STEPS, step) || reason.trim() === "")
    throw new WindowsSkipError(
      "a Windows skip names its piece of work and says why",
    );
  return process.platform === "win32";
}

/** A branch on Windows inside a test, written without a reason or outside a running test. */
class WindowsBranchError extends Error {}

const RUNNING = Symbol.for("jig.test.running");

/**
 * Records whether a test is running, for exceptOnWindows and byPlatform.
 * Called once from the test preload (lib/test-env-preload.ts), whose hooks
 * run around every test.
 */
export function markRunningTests(
  beforeEach: (hook: () => void) => void,
  afterEach: (hook: () => void) => void,
): void {
  const global = globalThis as { [RUNNING]?: boolean };
  global[RUNNING] = false;
  beforeEach(() => {
    global[RUNNING] = true;
  });
  afterEach(() => {
    global[RUNNING] = false;
  });
}

/**
 * Throws unless `reason` says something and a test is running. Outside a
 * running test a branch would decide whether a test is registered or skipped,
 * which is skipsOnWindows's job.
 */
function requireRunningTest(reason: string): void {
  if (reason.trim() === "")
    throw new WindowsBranchError("a branch on Windows says why");
  if ((globalThis as { [RUNNING]?: boolean })[RUNNING] !== true)
    throw new WindowsBranchError(
      "a branch on Windows runs inside a running test; a whole test skips through skipsOnWindows",
    );
}

/**
 * Runs `check` everywhere but Windows: an assertion only a POSIX system can
 * enforce. `reason` says why for the reader. The test must make an assertion
 * on every platform: on Windows one of its own, so it fails rather than passes
 * when every check it has is POSIX-only, and elsewhere the check's or the
 * test's. `check` is synchronous, so none of its assertions outlive the test.
 */
export function exceptOnWindows(reason: string, check: () => void): void {
  requireRunningTest(reason);
  expect.hasAssertions();
  if (process.platform === "win32") return;
  const result: unknown = check();
  if (typeof (result as { then?: unknown } | null)?.then === "function")
    throw new WindowsBranchError(
      "exceptOnWindows runs a synchronous check; await outside it",
    );
}

/**
 * The value for this platform, inside a running test: a fixture or an
 * expected text that differs on Windows. `reason` says why for the reader.
 * The test must make an assertion on every platform, so one that branches on
 * the value and returns before asserting anything fails.
 */
export function byPlatform<T extends string | readonly string[]>(
  reason: string,
  values: { windows: T; posix: T },
): T {
  requireRunningTest(reason);
  expect.hasAssertions();
  return process.platform === "win32" ? values.windows : values.posix;
}
