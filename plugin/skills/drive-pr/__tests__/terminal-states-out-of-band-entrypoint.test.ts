/**
 * Regression suite for the drive-pr terminal-state ↔ exit-code
 * drift check.
 *
 * It runs as part of the repository's `bun test`, never from the plugin
 * cache: the checker needs the TypeScript compiler's API (the `typescript`
 * package, a repository devDependency). The checker talks to the compiler as
 * a separate server process, shared by every test here and stopped once the
 * suite is done.
 *
 * Every fixture below is mutated from a form the checker is known to accept — a
 * passing test alone proves nothing about whether the assertion is reachable at
 * all.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import {
  closeTypeScriptService,
  runCheck,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

describe("runCheck — the lease.ts + drive-status.ts out-of-band checks reach the real entry point", () => {
  // Same reasoning as the drive.ts describe block above: a FRESH directory
  // per fixture, because Bun's `require()` snapshots a directory's contents
  // on its first resolution there.
  const fixture = (name: string, body: string): string => {
    const dir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-e2e-"),
    );
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  // Healthy drive.ts fixtures, duplicated from the describe block
  // above rather than shared across describe blocks (no existing
  // shared-fixture convention in this file) — needed so the earlier,
  // drive.ts-specific checks in runCheck() pass and execution actually
  // reaches the lease.ts/drive-status.ts checks this block exercises.
  const healthyDriveTsModule = [
    "export const MAX_ROUNDS_EXIT = 6;",
    "export const SINGLE_INSTANCE_LOCK_EXIT = 11;",
    "export const WORKTREE_UNCLEAN_EXIT = 12;",
    "export const STALLED_EXIT = 14;",
    "export const PASS_DEADLINE_EXIT = 15;",
    "export const QUOTA_PARKED_EXIT = 16;",
    "export const MAILBOX_STOPPED_EXIT = 18;",
    "export const MAILBOX_PAUSE_TIMEOUT_EXIT = 19;",
    "",
  ].join("\n");
  const healthyDriveTsSource = [
    "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';",
    "export const PASS_DEADLINE_EXIT = driverOnlyExitCode('PASS_DEADLINE');",
    "export const QUOTA_PARKED_EXIT = driverOnlyExitCode('QUOTA_PARKED');",
    "export const MAILBOX_STOPPED_EXIT = driverOnlyExitCode('MAILBOX_STOPPED');",
    "export const MAILBOX_PAUSE_TIMEOUT_EXIT = driverOnlyExitCode('MAILBOX_PAUSE_TIMEOUT');",
    "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
    "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
    "export const WORKTREE_UNCLEAN_EXIT = driverOnlyExitCode('WORKTREE_UNCLEAN');",
    "export const STALLED_EXIT = driverOnlyExitCode('STALLED');",
    "async function main(): Promise<number> {",
    "  return MAX_ROUNDS_EXIT;",
    "}",
    "",
  ].join("\n");

  const healthyLeaseModule = [
    "export const SESSION_LEASE_HELD_EXIT = 11;",
    "export const DRIVE_HELD_ELSEWHERE_EXIT = 13;",
    "",
  ].join("\n");
  const healthyLeaseSource = [
    "import { outOfBandExitCode } from '../status/terminal-states.ts';",
    "export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD');",
    "export const DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode('DRIVE_HELD_BY_OTHER_WORKTREE');",
    "",
  ].join("\n");

  // Mirrors the real drive-status.ts shape: a `.code ===` comparison and an
  // `emit(...)` call both precede the matching `return`, and each one binds the
  // constant independently — exactly the three code-bound parts the mutation
  // tests below exercise one at a time.
  const healthyDriveStatusSource = [
    "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
    "async function main(): Promise<number> {",
    "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
    "    await emit(SESSION_LEASE_HELD_EXIT);",
    "    return SESSION_LEASE_HELD_EXIT;",
    "  }",
    "  return DRIVE_HELD_ELSEWHERE_EXIT;",
    "}",
    "",
  ].join("\n");

  const SEAM_ENV_KEYS = [
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE",
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE",
    "DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE",
    "DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE",
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE",
  ] as const;

  interface SeamPaths {
    driveTsModule: string;
    driveTsSource: string;
    leaseTsModule: string;
    leaseTsSource: string;
    driveStatusTsSource: string;
  }

  const withSeams = async (
    paths: SeamPaths,
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const prev = Object.fromEntries(
      SEAM_ENV_KEYS.map((k) => [k, process.env[k]]),
    );
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE =
      paths.driveTsModule;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE =
      paths.driveTsSource;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE =
      paths.leaseTsModule;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE =
      paths.leaseTsSource;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE =
      paths.driveStatusTsSource;
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.log = log;
      for (const k of SEAM_ENV_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  const healthyPaths = (): SeamPaths => ({
    driveTsModule: fixture("healthy-drive-module.ts", healthyDriveTsModule),
    driveTsSource: fixture("healthy-drive-source.ts", healthyDriveTsSource),
    leaseTsModule: fixture("healthy-lease-module.ts", healthyLeaseModule),
    leaseTsSource: fixture("healthy-lease-source.ts", healthyLeaseSource),
    driveStatusTsSource: fixture(
      "healthy-drive-status-source.ts",
      healthyDriveStatusSource,
    ),
  });

  test("a fully healthy fixture set passes through the real runCheck() entry point", async () => {
    await withSeams(healthyPaths(), async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("a mismatched lease.ts exit constant VALUE fails runCheck(), not just the pure function in isolation", async () => {
    const paths = healthyPaths();
    paths.leaseTsModule = fixture(
      "mismatched-lease-module.ts",
      healthyLeaseModule.replace(
        "export const SESSION_LEASE_HELD_EXIT = 11;",
        "export const SESSION_LEASE_HELD_EXIT = 99;",
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  test("a lease.ts DECLARATION reverted to a bare literal that still holds the right VALUE fails runCheck() — the case findExitConstantMismatches alone cannot catch", async () => {
    const paths = healthyPaths();
    paths.leaseTsSource = fixture(
      "provenance-lease-source.ts",
      healthyLeaseSource.replace(
        "export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD');",
        "export const SESSION_LEASE_HELD_EXIT = 11;", // reverted, but still the right value
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  test("a drive-status.ts bare-literal exit site fails runCheck(), not just the pure function in isolation", async () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "return SESSION_LEASE_HELD_EXIT;",
        "return 11;",
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  // The two mutations below are the exact residual of a `return`-only scan:
  // it misses a `.code ===` comparison or an `emit(...)` call reverted to a
  // bare literal while the function's own trailing `return` still reads the
  // real constant — `healthyDriveStatusSource` above deliberately carries all
  // three shapes so each mutation below trips ONLY the clause under test.
  test("a drive-status.ts .code COMPARISON reverted to a bare literal fails runCheck(), even though the return in the same block still uses the named constant", async () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-comparison-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "bump.code === SESSION_LEASE_HELD_EXIT",
        "bump.code === 11",
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  test("a drive-status.ts emit() CALL reverted to a bare literal fails runCheck(), even though the return in the same block still uses the named constant", async () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-call-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "emit(SESSION_LEASE_HELD_EXIT)",
        "emit(11)",
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  test("a missing lease.ts source file fails closed", async () => {
    const paths = healthyPaths();
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-e2e-missing-"),
    );
    paths.leaseTsSource = join(missingDir, "does-not-exist.ts");
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });

  test("a missing drive-status.ts source file fails closed", async () => {
    const paths = healthyPaths();
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-e2e-missing-2-"),
    );
    paths.driveStatusTsSource = join(missingDir, "does-not-exist.ts");
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });
});

describe("runCheck — the outOfBand name-pairing check reaches the real entry point", () => {
  // Same reasoning as the two describe blocks above: a FRESH directory per
  // fixture, and the healthy drive.ts/lease.ts fixtures duplicated rather
  // than shared (no existing shared-fixture convention in this file) — both
  // needed so execution actually reaches the check this block exercises.
  const fixture = (name: string, body: string): string => {
    const dir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-name-e2e-"),
    );
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const healthyDriveTsModule = [
    "export const MAX_ROUNDS_EXIT = 6;",
    "export const SINGLE_INSTANCE_LOCK_EXIT = 11;",
    "export const WORKTREE_UNCLEAN_EXIT = 12;",
    "export const STALLED_EXIT = 14;",
    "export const PASS_DEADLINE_EXIT = 15;",
    "export const QUOTA_PARKED_EXIT = 16;",
    "export const MAILBOX_STOPPED_EXIT = 18;",
    "export const MAILBOX_PAUSE_TIMEOUT_EXIT = 19;",
    "",
  ].join("\n");
  const healthyDriveTsSource = [
    "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';",
    "export const PASS_DEADLINE_EXIT = driverOnlyExitCode('PASS_DEADLINE');",
    "export const QUOTA_PARKED_EXIT = driverOnlyExitCode('QUOTA_PARKED');",
    "export const MAILBOX_STOPPED_EXIT = driverOnlyExitCode('MAILBOX_STOPPED');",
    "export const MAILBOX_PAUSE_TIMEOUT_EXIT = driverOnlyExitCode('MAILBOX_PAUSE_TIMEOUT');",
    "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
    "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
    "export const WORKTREE_UNCLEAN_EXIT = driverOnlyExitCode('WORKTREE_UNCLEAN');",
    "export const STALLED_EXIT = driverOnlyExitCode('STALLED');",
    "async function main(): Promise<number> {",
    "  return MAX_ROUNDS_EXIT;",
    "}",
    "",
  ].join("\n");

  const healthyLeaseModule = [
    "export const SESSION_LEASE_HELD_EXIT = 11;",
    "export const DRIVE_HELD_ELSEWHERE_EXIT = 13;",
    "",
  ].join("\n");
  const healthyLeaseSource = [
    "import { outOfBandExitCode } from '../status/terminal-states.ts';",
    "export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD');",
    "export const DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode('DRIVE_HELD_BY_OTHER_WORKTREE');",
    "",
  ].join("\n");

  // Unlike the block's own `healthyDriveStatusSource` (which uses a bare
  // `emit(...)` and needs no `outOfBand()` call at all — it exercises only the
  // bare-literal scan), this fixture uses the REAL `outOfBand()` dispatch shape
  // both real call sites use, since that is exactly what this check's mutation
  // targets.
  const healthyDriveStatusSource = [
    "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
    "import { outOfBand } from './lib/status/terminal-states.ts';",
    "async function main(): Promise<number> {",
    "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
    "    const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
    "    await emit(code);",
    "    return code;",
    "  }",
    "  if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
    "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
    "    await emit(code);",
    "    return code;",
    "  }",
    "  return 0;",
    "}",
    "",
  ].join("\n");

  const SEAM_ENV_KEYS = [
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE",
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE",
    "DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE",
    "DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE",
    "DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE",
  ] as const;

  interface SeamPaths {
    driveTsModule: string;
    driveTsSource: string;
    leaseTsModule: string;
    leaseTsSource: string;
    driveStatusTsSource: string;
  }

  const withSeams = async (
    paths: SeamPaths,
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const prev = Object.fromEntries(
      SEAM_ENV_KEYS.map((k) => [k, process.env[k]]),
    );
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE =
      paths.driveTsModule;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE =
      paths.driveTsSource;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE =
      paths.leaseTsModule;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE =
      paths.leaseTsSource;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE =
      paths.driveStatusTsSource;
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.log = log;
      for (const k of SEAM_ENV_KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  const healthyPaths = (): SeamPaths => ({
    driveTsModule: fixture("healthy-drive-module.ts", healthyDriveTsModule),
    driveTsSource: fixture("healthy-drive-source.ts", healthyDriveTsSource),
    leaseTsModule: fixture("healthy-lease-module.ts", healthyLeaseModule),
    leaseTsSource: fixture("healthy-lease-source.ts", healthyLeaseSource),
    driveStatusTsSource: fixture(
      "healthy-drive-status-source.ts",
      healthyDriveStatusSource,
    ),
  });

  test("a fully healthy fixture set — using the real outOfBand() dispatch shape — passes through the real runCheck() entry point", async () => {
    await withSeams(healthyPaths(), async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("an outOfBand() call NAME swapped to the wrong sibling state fails runCheck(), even though its enclosing comparison branch is unchanged", async () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "wrong-name-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "outOfBand(report, 'SESSION_LEASE_HELD', 'reason')",
        "outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason')",
      ),
    );
    await withSeams(paths, async () => expect(await runCheck()).toBe(1));
  });
});
