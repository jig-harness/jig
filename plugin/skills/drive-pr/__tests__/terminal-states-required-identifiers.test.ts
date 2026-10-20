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
  type DriverOnlyStateName,
  driverOnlyExitCode,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";

import {
  closeTypeScriptService,
  driverOnlyExitBindings,
  findBareLiteralExits,
  findConstantProvenanceMismatches,
  findExitConstantMismatches,
  runCheck,
} from "./terminal-states-consistency.ts";

import { fileURLToPath } from "node:url";

afterAll(closeTypeScriptService);

/** Every `category: 'driver-only'` key in the real `TERMINAL_STATES` —
 * derived, not a second hand-typed copy of `DriverOnlyStateName`'s members,
 * so this list cannot itself go stale the way `BARE_LITERAL_EXIT_CODES`
 * used to (see the test below that pins the fix). */
const DRIVER_ONLY_STATE_NAMES = Object.entries(TERMINAL_STATES)
  .filter(([, entry]) => entry?.category === "driver-only")
  .map(([name]) => name as DriverOnlyStateName);

describe("runCheck — requiredIdentifiers wired end to end through the TEST_REQUIRED seam", () => {
  // The `findMissingRequired` suite above proves the LOGIC is correct in
  // isolation; it cannot prove `runCheck()` actually calls it with the right
  // arguments and acts on the result. `DRIVE_PR_TERMINAL_STATES_TEST_FILES`
  // alone can't test that either — it never threads `requiredIdentifiers`
  // through (see that field's own doc comment on `CorpusFile`) — which is
  // exactly why `DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED` exists: a synthetic
  // fixture, run through the REAL `runCheck()` entry point, on a completeness
  // failure the population floor alone would not catch.
  const dir = mkdtempSync(
    join(tmpdir(), "drive-pr-terminal-states-required-e2e-"),
  );

  const corpus = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const withRequired = async (
    filesEntry: string,
    required: readonly string[],
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const prevFiles = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    const prevRequired = process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = filesEntry;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED = required.join(";");
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.log = log;
      if (prevFiles === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
      else process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = prevFiles;
      if (prevRequired === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED;
      else process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED = prevRequired;
    }
  };

  test("a fixture carrying every required identifier passes", async () => {
    const file = corpus(
      "healthy.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Meaning |",
        "|---|---|---|",
        "| `0` | `ROUND_READY` | work |",
        "| `3` | `CONVERGED` | done |",
        "| `5` | `PR_NOT_OPEN` | closed |",
        "",
      ].join("\n"),
    );
    await withRequired(
      `${file}=pipe-table-exit-first=3=## Exit codes`,
      ["ROUND_READY", "CONVERGED", "PR_NOT_OPEN"],
      async () => expect(await runCheck()).toBe(0),
    );
  });

  test("ONE required row silently dropped — total count still clears the floor, requiredIdentifiers still catches it", async () => {
    const file = corpus(
      "partial-loss.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Meaning |",
        "|---|---|---|",
        "| `0` | `ROUND_READY` | work |",
        // PR_CONFLICTING silently dropped — 3 rows remain, clearing a floor
        // of 3, which is exactly the evasion the floor alone cannot see.
        "| `5` | `PR_NOT_OPEN` | closed |",
        "| `8` | `HITL_PARKED` | parked |",
        "",
      ].join("\n"),
    );
    await withRequired(
      `${file}=pipe-table-exit-first=3=## Exit codes`,
      ["ROUND_READY", "PR_NOT_OPEN", "HITL_PARKED", "PR_CONFLICTING"],
      async () => expect(await runCheck()).toBe(1),
    );
  });
});

describe("findExitConstantMismatches — pure comparison", () => {
  const terminalStates = {
    MAX_ROUNDS: { exitCode: 6 },
    SINGLE_INSTANCE_LOCK: { exitCode: 11 },
  };

  test("every binding equals its TERMINAL_STATES entry: no mismatches", () => {
    expect(
      findExitConstantMismatches(
        [
          {
            constantName: "MAX_ROUNDS_EXIT",
            constantValue: 6,
            stateName: "MAX_ROUNDS",
          },
          {
            constantName: "SINGLE_INSTANCE_LOCK_EXIT",
            constantValue: 11,
            stateName: "SINGLE_INSTANCE_LOCK",
          },
        ],
        terminalStates,
      ),
    ).toEqual([]);
  });

  test("a constant reverted to an independent literal that no longer matches is caught", () => {
    const mismatches = findExitConstantMismatches(
      [
        {
          constantName: "MAX_ROUNDS_EXIT",
          constantValue: 7, // was 6 — the real TERMINAL_STATES.MAX_ROUNDS.exitCode
          stateName: "MAX_ROUNDS",
        },
      ],
      terminalStates,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("MAX_ROUNDS_EXIT");
    expect(mismatches[0]).toContain("7");
    expect(mismatches[0]).toContain("6");
  });

  test("a binding naming a TERMINAL_STATES key that does not exist at all is caught, not silently skipped", () => {
    const mismatches = findExitConstantMismatches(
      [
        {
          constantName: "GHOST_EXIT",
          constantValue: 99,
          stateName: "GHOST_STATE",
        },
      ],
      terminalStates,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain("GHOST_STATE");
  });

  test("NaN (a missing or non-numeric export, per driverOnlyExitBindings) never coincidentally equals — always reported", () => {
    const mismatches = findExitConstantMismatches(
      [
        {
          constantName: "MAX_ROUNDS_EXIT",
          constantValue: Number.NaN,
          stateName: "MAX_ROUNDS",
        },
      ],
      terminalStates,
    );
    expect(mismatches).toHaveLength(1);
  });
});

describe("findConstantProvenanceMismatches — the declaration itself, not the runtime value", () => {
  const bindings = [
    { constantName: "MAX_ROUNDS_EXIT", stateName: "MAX_ROUNDS" },
    {
      constantName: "SINGLE_INSTANCE_LOCK_EXIT",
      stateName: "SINGLE_INSTANCE_LOCK",
    },
  ];
  const realImport =
    "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';";

  test("both constants correctly bound via driverOnlyExitCode(...): no mismatches", async () => {
    const source = [
      realImport,
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode(",
      "  'SINGLE_INSTANCE_LOCK',",
      ");",
      "",
    ].join("\n");
    expect(await findConstantProvenanceMismatches(source, bindings)).toEqual(
      [],
    );
  });

  test("a constant reverted to a bare literal that still holds the RIGHT value is caught — this is exactly what findExitConstantMismatches cannot see", async () => {
    const source = [
      realImport,
      "export const MAX_ROUNDS_EXIT = 6;", // reverted, but 6 is still correct
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain("MAX_ROUNDS_EXIT");
  });

  test("a driverOnlyExitCode(...) call with the WRONG state-name argument is caught", async () => {
    const source = [
      realImport,
      // copy-paste mistake: names the wrong TERMINAL_STATES key
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
  });

  test("a missing declaration entirely is caught, not silently skipped", async () => {
    const source = [
      realImport,
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain(
      "no top-level exported declaration",
    );
  });

  test("a top-level exported `let` (not `const`) is NOT treated as the canonical binding — a reassignment elsewhere could break it without this gate ever noticing", async () => {
    const source = [
      realImport,
      // Same provenance and value as the clean shape, but declared `let`:
      // nothing stops a later `MAX_ROUNDS_EXIT = 6;` elsewhere in the file
      // from silently breaking the table binding this gate exists to pin.
      "export let MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain(
      "no top-level exported declaration",
    );
  });

  test("a decoy declaration inside a NESTED function does not rescue a reverted top-level export", async () => {
    const source = [
      realImport,
      // The real, top-level export was reverted to a bare literal...
      "export const MAX_ROUNDS_EXIT = 6;",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      // ...but a same-named LOCAL inside an unrelated function is correctly
      // bound. The old document-order tree walk matched this decoy anywhere
      // in the file and reported the whole binding as clean; it must not.
      "function decoy(): number {",
      "  const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "  return MAX_ROUNDS_EXIT;",
      "}",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
  });

  test("driverOnlyExitCode imported from a DIFFERENT module is not accepted as the real one", async () => {
    const source = [
      "import { driverOnlyExitCode } from './some-other-module.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(2);
    expect(mismatches.map((m) => m.constantName).sort()).toEqual([
      "MAX_ROUNDS_EXIT",
      "SINGLE_INSTANCE_LOCK_EXIT",
    ]);
  });

  test('a decoy module specifier merely CONTAINING "terminal-states" is not accepted as the real one (a substring test via .includes would let ./fake-terminal-states.ts satisfy it)', async () => {
    const source = [
      "import { driverOnlyExitCode } from './fake-terminal-states.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = await findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(2);
    expect(mismatches.map((m) => m.constantName).sort()).toEqual([
      "MAX_ROUNDS_EXIT",
      "SINGLE_INSTANCE_LOCK_EXIT",
    ]);
  });
});

describe("driverOnlyExitBindings — requires a real module for live export values", () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-terminal-states-module-"));

  test("reads all real driver-only values from the actual drive.ts", () => {
    const path = fileURLToPath(new URL("../scripts/drive.ts", import.meta.url));
    const bindings = driverOnlyExitBindings(path);
    expect(bindings).toHaveLength(8);
    const byName = Object.fromEntries(
      bindings.map((b) => [b.constantName, b.constantValue]),
    );
    expect(byName.MAX_ROUNDS_EXIT).toBe(6);
    expect(byName.SINGLE_INSTANCE_LOCK_EXIT).toBe(11);
    expect(byName.WORKTREE_UNCLEAN_EXIT).toBe(12);
    expect(byName.STALLED_EXIT).toBe(14);
    expect(byName.PASS_DEADLINE_EXIT).toBe(15);
    expect(byName.QUOTA_PARKED_EXIT).toBe(16);
    expect(byName.MAILBOX_STOPPED_EXIT).toBe(18);
    expect(byName.MAILBOX_PAUSE_TIMEOUT_EXIT).toBe(19);
  });

  test("a module missing an export reports NaN for it, rather than throwing past the caller", () => {
    const file = join(dir, "partial.ts");
    writeFileSync(
      file,
      [
        "export const MAX_ROUNDS_EXIT = 6;",
        "// SINGLE_INSTANCE_LOCK_EXIT and the rest are simply absent.",
        "",
      ].join("\n"),
    );
    const bindings = driverOnlyExitBindings(file);
    const byName = Object.fromEntries(
      bindings.map((b) => [b.constantName, b.constantValue]),
    );
    expect(byName.MAX_ROUNDS_EXIT).toBe(6);
    expect(Number.isNaN(byName.SINGLE_INSTANCE_LOCK_EXIT)).toBe(true);
  });
});

describe("findBareLiteralExits — a real AST scan, not a text/regex match", () => {
  test("a bare-literal return of a tracked exit code is found, with its line number", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (true) {",
      "    return 6;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const found = await findBareLiteralExits(source);
    expect(found).toEqual([{ line: 3, value: 6, kind: "return" }]);
  });

  test("the named constant form is NOT flagged — this is the clean, post-fix shape", async () => {
    const source = [
      "export const MAX_ROUNDS_EXIT = 6;",
      "async function main(): Promise<number> {",
      "  return MAX_ROUNDS_EXIT;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test('a NON-EXPORTED top-level const is not the canonical binding and IS flagged — the exemption is for the exported constant, not for "any top-level declaration"', async () => {
    const source = [
      "const exit = 6;", // top-level, but never exported — not a driver-only-exit constant
      "async function main(): Promise<number> {",
      "  return exit;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 3, value: 6, kind: "return" },
    ]);
  });

  test("a numeric literal that is part of a LARGER expression is not mistaken for a bare exit-code return", async () => {
    // Parse, don't pattern-match: this is exactly the false-positive
    // class a text/regex match over "return ... 6" would trip on, and a real
    // AST-level check (matching only when the WHOLE return expression is the
    // literal) must not.
    const source = [
      "function unrelated(): number {",
      "  return randomBytes(12).length;", // CallExpression, not the literal
      "}",
      "function other(): number {",
      "  return heartbeatStaleMs() / 6;", // BinaryExpression, not the literal
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test("15/16 (PASS_DEADLINE_EXIT/QUOTA_PARKED_EXIT — already had named constants before) ARE flagged, same as the other four", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (a) {",
      "    return 15;",
      "  }",
      "  return 16;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 3, value: 15, kind: "return" },
      { line: 5, value: 16, kind: "return" },
    ]);
  });

  test("a genuinely unrelated numeric return (not one of the tracked driver-only codes) is not flagged", async () => {
    const source = [
      "async function countThings(): Promise<number> {",
      "  return 42;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test("a parenthesized bare literal — return (6); — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return (6);",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a unary-plus bare literal — return +6; — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return +6;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a unary-MINUS literal is NOT caught — a driver-only exit code is never legitimately negative, so -6 is not this bypass class", async () => {
    const source = ["function unrelated(): number {", "  return -6;", "}"].join(
      "\n",
    );
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test("a local const alias — const exit = 6; return exit; — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const exit = 6;",
      "  return exit;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 3, value: 6, kind: "return" },
    ]);
  });

  test("identifier resolution is scoped to the ENCLOSING FUNCTION only — a same-named alias in a different, unrelated function is not resolved across the boundary", async () => {
    const source = [
      "function elsewhere(): number {",
      "  const exit = 6; // unrelated local in a DIFFERENT function",
      "  return doSomethingWith(exit);",
      "}",
      "async function main(): Promise<number> {",
      "  const exit = doWork(); // NOT a literal — this function’s own alias",
      "  return exit;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test("multiple sites across the file are all found, each with its own correct line number", async () => {
    const source = [
      "async function main(): Promise<number> {", // line 1
      "  if (a) {", // 2
      "    return 11;", // 3
      "  }", // 4
      "  if (b) {", // 5
      "    return 12;", // 6
      "  }", // 7
      "  return 0;", // 8
      "}", // 9
      "async function runRepairPass(): Promise<number> {", // 10
      "  return 14;", // 11
      "}", // 12
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 3, value: 11, kind: "return" },
      { line: 6, value: 12, kind: "return" },
      { line: 11, value: 14, kind: "return" },
    ]);
  });

  test("deliberately NOT scoped to main/runRepairPass by name — a bare literal in ANY function is caught, per this scan’s own documented scope note", async () => {
    const source = [
      "async function someRenamedOrExtractedHelper(): Promise<number> {",
      "  return 6;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a TypeScript `as` wrapper — return 6 as number; — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6 as number;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a `satisfies` wrapper — return 6 satisfies number; — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6 satisfies number;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("nested wrappers combine — return +(6 as number); — is caught", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return +(6 as number);",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a shadowed BLOCK-scoped local does not steal a return that correctly reads the outer, canonical binding", async () => {
    // The real fix: `const exit = MAX_ROUNDS_EXIT;` (an identifier
    // initializer, not a literal) is what `return exit;` actually reads —
    // the nested `if`-block's own `const exit = 6;` is a DIFFERENT,
    // block-scoped binding the `return` cannot see. A document-order name
    // walk previously matched the inner literal anyway and misreported this
    // as a bare-literal bypass.
    const source = [
      "async function main(): Promise<number> {",
      "  const exit = MAX_ROUNDS_EXIT;",
      "  if (cond) {",
      "    const exit = 6;",
      "    doSomethingWith(exit);",
      "  }",
      "  return exit;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });

  test("reassignment is still NOT tracked — a documented residual, not a regression (let exit = 6; exit = MAX_ROUNDS_EXIT; return exit;)", async () => {
    // Pinned as a mutation guard: `resolveIdentifierLiteral`
    // resolves the identifier's DECLARATION via the real binder (fixing the
    // block-scope case above), but still only reads that declaration's own
    // initializer, not a later write. This mutation must keep failing until a
    // full data-flow resolver is deliberately added — see that function's own
    // header for why one is out of scope today.
    const source = [
      "async function main(): Promise<number> {",
      "  let exit = 6;",
      "  exit = MAX_ROUNDS_EXIT;",
      "  return exit;",
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([
      { line: 4, value: 6, kind: "return" },
    ]);
  });

  test("the scanned code set is DERIVED from TERMINAL_STATES, not an independent literal list", async () => {
    // Every value here comes from the real `driverOnlyExitCode` read, never
    // a number typed into this test — if `TERMINAL_STATES` ever renumbers one
    // of these states, this test keeps exercising whatever the CURRENT real
    // value is and still passes without an edit, exactly like the production
    // scan does. A hard-coded, independent literal set (the bug this fix
    // removes) would instead go stale the moment a renumber landed: it would
    // miss a bare return of the NEW code and could misfire on the OLD one.
    for (const name of DRIVER_ONLY_STATE_NAMES) {
      const code = driverOnlyExitCode(name);
      const source = [
        "async function main(): Promise<number> {",
        `  return ${code};`,
        "}",
      ].join("\n");
      expect(await findBareLiteralExits(source)).toEqual([
        { line: 2, value: code, kind: "return" },
      ]);
    }
  });

  test("a value one past a real driver-only exit code is NOT flagged — the scan is exact, not a range", async () => {
    const code = driverOnlyExitCode("MAX_ROUNDS") + 1000;
    const source = [
      "async function main(): Promise<number> {",
      `  return ${code};`,
      "}",
    ].join("\n");
    expect(await findBareLiteralExits(source)).toEqual([]);
  });
});
