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
  type OutOfBandStateName,
  outOfBand,
  outOfBandExitCode,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";

import {
  buildReservedExitCodes,
  closeTypeScriptService,
  findBareLiteralExits,
  findConstantProvenanceMismatches,
  outOfBandExitBindings,
  runCheck,
} from "./terminal-states-consistency.ts";

import { fileURLToPath } from "node:url";

afterAll(closeTypeScriptService);

const OUT_OF_BAND_STATE_NAMES: readonly OutOfBandStateName[] = [
  "SESSION_LEASE_HELD",
  "DRIVE_HELD_BY_OTHER_WORKTREE",
];

describe("runCheck — the drive.ts emitter checks reach the real entry point", () => {
  // A FRESH directory per fixture, not one shared `dir` for the whole
  // describe block: Bun's `require()` snapshots a directory's contents on
  // its FIRST resolution there, so a second, different file written into an
  // already-`require()`d directory fails to resolve ("Cannot find module …
  // from ''") even though it exists on disk by the time `require()` runs —
  // verified directly against a minimal repro before landing this shape.
  // `readFileSync` (the source-scan half) has no such issue; this is purely
  // about the module-require half.
  const fixture = (name: string, body: string): string => {
    const dir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-drivets-e2e-"),
    );
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const healthyModule = [
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

  // Includes every real declaration, not just the return site: since
  // `findConstantProvenanceMismatches` also scans
  // this SOURCE text for the constants' own `driverOnlyExitCode(...)`
  // bindings, a source fixture with only a return statement would report all
  // of them as "no declaration found" and never reach the checks below it.
  // The import line is likewise load-bearing:
  // `findConstantProvenanceMismatches` verifies `driverOnlyExitCode`
  // resolves to THIS import, not merely to a same-named identifier.
  const healthySource = [
    "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';",
    "export const PASS_DEADLINE_EXIT = driverOnlyExitCode('PASS_DEADLINE');",
    "export const QUOTA_PARKED_EXIT = driverOnlyExitCode('QUOTA_PARKED');",
    "export const MAILBOX_STOPPED_EXIT = driverOnlyExitCode('MAILBOX_STOPPED');",
    "export const MAILBOX_PAUSE_TIMEOUT_EXIT = driverOnlyExitCode('MAILBOX_PAUSE_TIMEOUT');",
    "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
    "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode(",
    "  'SINGLE_INSTANCE_LOCK',",
    ");",
    "export const WORKTREE_UNCLEAN_EXIT = driverOnlyExitCode('WORKTREE_UNCLEAN');",
    "export const STALLED_EXIT = driverOnlyExitCode('STALLED');",
    "async function main(): Promise<number> {",
    "  return MAX_ROUNDS_EXIT;",
    "}",
    "",
  ].join("\n");

  const withDriveTsSeams = async (
    modulePath: string,
    sourcePath: string,
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const prevModule =
      process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE;
    const prevSource =
      process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE = modulePath;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE = sourcePath;
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.log = log;
      if (prevModule === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE;
      else
        process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE = prevModule;
      if (prevSource === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE;
      else
        process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE = prevSource;
    }
  };

  test("a healthy module + source pair passes through the real runCheck() entry point", async () => {
    const modulePath = fixture("healthy-module.ts", healthyModule);
    const sourcePath = fixture("healthy-source.ts", healthySource);
    await withDriveTsSeams(modulePath, sourcePath, async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("a mismatched constant fails runCheck(), not just the pure function in isolation", async () => {
    const modulePath = fixture(
      "mismatched-module.ts",
      healthyModule.replace(
        "export const MAX_ROUNDS_EXIT = 6;",
        "export const MAX_ROUNDS_EXIT = 7;",
      ),
    );
    const sourcePath = fixture("mismatched-source.ts", healthySource);
    await withDriveTsSeams(modulePath, sourcePath, async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("a bare-literal exit site fails runCheck(), not just the pure function in isolation", async () => {
    const modulePath = fixture("bare-literal-module.ts", healthyModule);
    const sourcePath = fixture(
      "bare-literal-source.ts",
      healthySource.replace("return MAX_ROUNDS_EXIT;", "return 6;"),
    );
    await withDriveTsSeams(modulePath, sourcePath, async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("a constant DECLARATION reverted to a bare literal that still holds the right VALUE fails runCheck — the case findExitConstantMismatches alone cannot catch", async () => {
    const modulePath = fixture("provenance-module.ts", healthyModule);
    const sourcePath = fixture(
      "provenance-source.ts",
      healthySource.replace(
        "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
        "export const MAX_ROUNDS_EXIT = 6;", // reverted, but 6 is still the right value
      ),
    );
    await withDriveTsSeams(modulePath, sourcePath, async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("a missing drive.ts source file fails closed", async () => {
    const modulePath = fixture("healthy-module-2.ts", healthyModule);
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-drivets-e2e-missing-"),
    );
    await withDriveTsSeams(
      modulePath,
      join(missingDir, "does-not-exist.ts"),
      async () => expect(await runCheck()).toBe(1),
    );
  });
});

describe("outOfBandExitBindings — requires a real module for live export values", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "drive-pr-terminal-states-outofband-module-"),
  );

  test("reads all real out-of-band values from the actual lease.ts", () => {
    const path = fileURLToPath(
      new URL("../scripts/lib/state/lease.ts", import.meta.url),
    );
    const bindings = outOfBandExitBindings(path);
    expect(bindings).toHaveLength(2);
    const byName = Object.fromEntries(
      bindings.map((b) => [b.constantName, b.constantValue]),
    );
    expect(byName.SESSION_LEASE_HELD_EXIT).toBe(11);
    expect(byName.DRIVE_HELD_ELSEWHERE_EXIT).toBe(13);
  });

  test("a module missing an export reports NaN for it, rather than throwing past the caller", () => {
    const file = join(dir, "partial.ts");
    writeFileSync(
      file,
      [
        "export const SESSION_LEASE_HELD_EXIT = 11;",
        "// DRIVE_HELD_ELSEWHERE_EXIT is simply absent.",
        "",
      ].join("\n"),
    );
    const bindings = outOfBandExitBindings(file);
    const byName = Object.fromEntries(
      bindings.map((b) => [b.constantName, b.constantValue]),
    );
    expect(byName.SESSION_LEASE_HELD_EXIT).toBe(11);
    expect(Number.isNaN(byName.DRIVE_HELD_ELSEWHERE_EXIT)).toBe(true);
  });
});

describe("findConstantProvenanceMismatches — generalized helper/specifier params serve lease.ts too", () => {
  test("a healthy outOfBandExitCode(...) declaration, imported from the real relative path, passes", async () => {
    const source = [
      "import { outOfBandExitCode } from '../status/terminal-states.ts';",
      "export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD');",
    ].join("\n");
    const bindings = [
      {
        constantName: "SESSION_LEASE_HELD_EXIT",
        stateName: "SESSION_LEASE_HELD",
      },
    ];
    expect(
      await findConstantProvenanceMismatches(
        source,
        bindings,
        "lease.ts",
        "outOfBandExitCode",
        "../status/terminal-states.ts",
      ),
    ).toEqual([]);
  });

  test("a declaration reverted to a bare literal that still holds the right VALUE is still caught with the generalized params", async () => {
    const source = [
      "import { outOfBandExitCode } from '../status/terminal-states.ts';",
      "export const SESSION_LEASE_HELD_EXIT = 11;", // reverted, but 11 is still the right value
    ].join("\n");
    const bindings = [
      {
        constantName: "SESSION_LEASE_HELD_EXIT",
        stateName: "SESSION_LEASE_HELD",
      },
    ];
    const mismatches = await findConstantProvenanceMismatches(
      source,
      bindings,
      "lease.ts",
      "outOfBandExitCode",
      "../status/terminal-states.ts",
    );
    expect(mismatches).toEqual([
      {
        constantName: "SESSION_LEASE_HELD_EXIT",
        reason:
          "SESSION_LEASE_HELD_EXIT is not declared as outOfBandExitCode('SESSION_LEASE_HELD')",
      },
    ]);
  });

  test("a decoy driverOnlyExitCode call — the WRONG helper name for this file — does not satisfy the outOfBandExitCode requirement", async () => {
    const source = [
      "import { driverOnlyExitCode } from '../status/terminal-states.ts';",
      "export const SESSION_LEASE_HELD_EXIT = driverOnlyExitCode('SESSION_LEASE_HELD');",
    ].join("\n");
    const bindings = [
      {
        constantName: "SESSION_LEASE_HELD_EXIT",
        stateName: "SESSION_LEASE_HELD",
      },
    ];
    const mismatches = await findConstantProvenanceMismatches(
      source,
      bindings,
      "lease.ts",
      "outOfBandExitCode",
      "../status/terminal-states.ts",
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("SESSION_LEASE_HELD_EXIT");
  });

  test("the default params are unchanged — existing drive.ts-shaped call sites still pass with no params supplied", async () => {
    const source = [
      "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
    ].join("\n");
    const bindings = [
      { constantName: "MAX_ROUNDS_EXIT", stateName: "MAX_ROUNDS" },
    ];
    expect(await findConstantProvenanceMismatches(source, bindings)).toEqual(
      [],
    );
  });
});

describe("outOfBand — report.state and the returned exit code come from ONE lookup", () => {
  // The bug this closes: a `drive-status.ts` branch used to set
  // `report.state` by hand and separately `emit`/`return` its own imported
  // `*_EXIT` constant, so a branch that set `report.state =
  // 'SESSION_LEASE_HELD'` could independently emit/return
  // `DRIVE_HELD_ELSEWHERE_EXIT` (or vice versa) with nothing to catch it —
  // `findBareLiteralExits` only rejects a BARE numeric literal, and either
  // sibling constant is an equally well-formed named identifier
  //. `outOfBand` closes the
  // gap structurally: both values are read off ONE `TERMINAL_STATES[name]`
  // lookup inside the function, so they cannot be written to disagree at a
  // call site the way two independent statements could.
  for (const name of OUT_OF_BAND_STATE_NAMES) {
    test(`sets report.state and returns the matching exit code for '${name}'`, () => {
      const report = { state: "", reason: "" };
      const code = outOfBand(report, name, "a reason");
      expect(report.state).toBe(name);
      expect(report.reason).toBe("a reason");
      expect(code).toBe(outOfBandExitCode(name));
    });
  }

  test("the returned code is looked up THROUGH the written report.state, not asserted independently of it", () => {
    // Asserts the pairing via `report.state` rather than via the `name`
    // argument directly: `TERMINAL_STATES[report.state]?.exitCode` re-derives
    // the expected code from what `outOfBand()` actually WROTE, so a
    // (hypothetical) future version that wrote one state but returned a
    // different one's code would fail here even though `code ===
    // outOfBandExitCode(name)` — asserted per-name in the loop above — would
    // still pass. Complements that loop; it does not independently prove the
    // two are read from the same function-internal lookup (that guarantee
    // comes from `outOfBand()`'s own single-`TERMINAL_STATES[name]`-read
    // implementation, not from any test).
    const report = { state: "", reason: "" };
    const code = outOfBand(report, "DRIVE_HELD_BY_OTHER_WORKTREE", "x");
    expect(TERMINAL_STATES[report.state]?.exitCode).toBe(code);
  });
});

describe("findBareLiteralExits — a custom exitCodes param scopes the scan", () => {
  test("a bare literal outside the supplied exitCodes set is NOT flagged, even though it would be under the default driver-only set", async () => {
    // 11 is a real driver-only exit code (SINGLE_INSTANCE_LOCK) under the
    // DEFAULT set, but this scan is scoped to {13} only (as drive-status.ts's
    // own out-of-band scan for DRIVE_HELD_ELSEWHERE_EXIT alone would be) —
    // proving the codes actually SCOPE the scan rather than only adding to it.
    const source = [
      "async function main(): Promise<number> {",
      "  return 11;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([13])),
    ).toEqual([]);
  });

  test("a bare literal INSIDE the supplied exitCodes set is flagged", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 13;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11, 13])),
    ).toEqual([{ line: 2, value: 13, kind: "return" }]);
  });

  test("the named out-of-band constant form is NOT flagged, matching the named-constant exemption the default set already has", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  return SESSION_LEASE_HELD_EXIT;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11, 13])),
    ).toEqual([]);
  });

  test("omitting exitCodes keeps the original default (driver-only) behavior — every existing call site is unaffected", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("the out-of-band scanned code set is DERIVED from TERMINAL_STATES, not an independent literal list — same discipline as BARE_LITERAL_EXIT_CODES", async () => {
    for (const name of OUT_OF_BAND_STATE_NAMES) {
      const code = outOfBandExitCode(name);
      const source = [
        "async function main(): Promise<number> {",
        `  return ${code};`,
        "}",
      ].join("\n");
      expect(
        await findBareLiteralExits(
          source,
          "drive-status.ts",
          new Set(OUT_OF_BAND_STATE_NAMES.map(outOfBandExitCode)),
        ),
      ).toEqual([{ line: 2, value: code, kind: "return" }]);
    }
  });

  test("a value no longer among the CURRENT out-of-band exit codes is still caught when it is retained in the reserved set — pins the renumber case", async () => {
    // Simulates SESSION_LEASE_HELD having moved away from 11 to some other
    // code: the "current" half of the reserved set no longer contains 11 at
    // all, yet a stale `return 11;` left behind by the renumber must still
    // be caught. Deriving the scanned set purely from CURRENT
    // TERMINAL_STATES values (as `OUT_OF_BAND_BARE_LITERAL_EXIT_CODES` did
    // before this fix) would silently miss it — this is exactly the "no test
    // pins the stale-old-value case" gap the finding named. Unioning in a
    // retired-values set (as `BARE_LITERAL_EXIT_CODES` /
    // `OUT_OF_BAND_BARE_LITERAL_EXIT_CODES` now do via
    // `buildReservedExitCodes`/`RETIRED_RESERVED_EXIT_CODES`) closes it: this
    // test exercises that union mechanism directly through
    // `findBareLiteralExits`'s own `exitCodes` param, independent of whether
    // anything has been retired in production yet — see the
    // `buildReservedExitCodes` describe block below for the pin on the
    // production wiring itself.
    const currentValues = new Set([
      outOfBandExitCode("DRIVE_HELD_BY_OTHER_WORKTREE"), // 13 — NOT 11
    ]);
    const retiredValues = new Set([11]); // the value SESSION_LEASE_HELD moved away from
    const reserved = new Set([...currentValues, ...retiredValues]);
    const source = [
      "async function main(): Promise<number> {",
      "  return 11;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", reserved),
    ).toEqual([{ line: 2, value: 11, kind: "return" }]);
  });
});

describe("buildReservedExitCodes — unions CURRENT values with the retired set", () => {
  test("returns the current values unchanged while nothing has been retired", () => {
    // RETIRED_RESERVED_EXIT_CODES is empty today (no driver-only/out-of-band
    // entry has ever been renumbered) — this pins that current, honest state
    // rather than a claim about renumber history that does not exist yet.
    // The describe block above pins the OTHER half: once a value IS added to
    // RETIRED_RESERVED_EXIT_CODES, `findBareLiteralExits` still catches it.
    //
    // This alone does NOT verify the union mechanism itself: with the real
    // retired set empty, `new Set([...currentValues, ...RETIRED_RESERVED_EXIT_CODES])`
    // and a broken `new Set(currentValues)` (the union silently deleted)
    // produce an identical result, so this assertion cannot distinguish
    // them — deleting the union from `buildReservedExitCodes` would leave
    // this test green. The test
    // below exercises the union directly through the injectable
    // `retiredValues` parameter instead.
    expect(buildReservedExitCodes([6, 12])).toEqual(new Set([6, 12]));
  });

  test("unions in an injected retired set, independent of production state — pins the union mechanism itself", () => {
    // Injects a non-empty retired set through the parameter added for
    // exactly this purpose, rather than waiting for
    // RETIRED_RESERVED_EXIT_CODES to become non-empty in production. A
    // `buildReservedExitCodes` body that dropped the union (returning only
    // `new Set(currentValues)`) fails this assertion regardless of what is
    // retired in production today.
    expect(buildReservedExitCodes([6, 12], [99])).toEqual(new Set([6, 12, 99]));
  });
});
