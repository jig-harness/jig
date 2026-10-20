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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import {
  closeTypeScriptService,
  driveStatusTsSourcePath,
  findBareLiteralExits,
  runCheck,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

describe("runCheck — the outOfBand coverage cross-check catches a real call site losing its anchor", () => {
  test("an else-branch mutation on the real drive-status.ts source fails runCheck() via the coverage cross-check, not the mismatch check", async () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = [
      "        if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "          const code = outOfBand(",
      "            report,",
      '            "DRIVE_HELD_BY_OTHER_WORKTREE",',
      '            "another live working tree is driving this PR — refusing to reconcile threads on its behalf",',
      "          );",
      "          if (admit.stderr) process.stderr.write(admit.stderr);",
      "          await emit(code);",
      "          return code;",
      "        }",
    ].join("\n");
    expect(realSource).toContain(target);
    const mutatedBlock = [
      "        if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "          return 0;",
      "        } else {",
      "          const code = outOfBand(",
      "            report,",
      '            "DRIVE_HELD_BY_OTHER_WORKTREE",',
      '            "another live working tree is driving this PR — refusing to reconcile threads on its behalf",',
      "          );",
      "          if (admit.stderr) process.stderr.write(admit.stderr);",
      "          await emit(code);",
      "          return code;",
      "        }",
    ].join("\n");
    const mutated = realSource.replace(target, mutatedBlock);
    const dir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-coverage-e2e-"),
    );
    const file = join(dir, "mutated-drive-status.ts");
    writeFileSync(file, mutated);
    const prev =
      process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE = file;
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      expect(await runCheck()).toBe(1);
    } finally {
      console.error = error;
      console.log = log;
      if (prev === undefined) {
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE;
      } else {
        process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE = prev;
      }
    }
  });

  test("a same-named, non-imported outOfBand decoy added alongside the real corpus does NOT fail runCheck — the coverage cross-check false positive this issue exists to close", async () => {
    // The mirror image of the test above: before the fix, ANY same-named
    // decoy call anywhere in drive-status.ts inflated candidateCount
    // without inflating anchoredCount, so the coverage cross-check failed
    // runCheck() on a call that never touched the real outOfBand() helper
    // at all. The decoy is declared in its OWN nested scope, shadowing the
    // file's real top-level `outOfBand` import within that scope only — a
    // second top-level `import { outOfBand } from …` alongside the real one
    // would be a duplicate-identifier compile error, not a shape any real
    // file could contain.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const decoy = [
      "",
      "function callDecoyOutOfBand(): number {",
      "  function outOfBand(",
      "    _report: unknown,",
      "    _name: string,",
      "    _reason: string,",
      "  ): number {",
      "    return 0;",
      "  }",
      "  return outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "}",
      "",
    ].join("\n");
    const mutated = realSource + decoy;
    const dir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-decoy-e2e-"),
    );
    const file = join(dir, "mutated-drive-status.ts");
    writeFileSync(file, mutated);
    const prev =
      process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE = file;
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      expect(await runCheck()).toBe(0);
    } finally {
      console.error = error;
      console.log = log;
      if (prev === undefined) {
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE;
      } else {
        process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE = prev;
      }
    }
  });
});

describe("findBareLiteralExits — alias-resolution gaps closed across all three sibling resolvers", () => {
  test("a two-hop identifier alias chain is followed to its literal — resolveIdentifierLiteral no longer stops at the first hop", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const raw = 11;",
      "  const code = raw;",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "return" }]);
  });

  test("an alias chain through a .code comparison is followed the same way", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const raw = bump.code;",
      "  const code = raw;",
      "  if (code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "comparison" }]);
  });

  test("an alias chain through an emit() call is followed the same way", async () => {
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  const first = emit;",
      "  const second = first;",
      "  await second(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 5, value: 11, kind: "call" }]);
  });

  test("an alias chain reaching the real exported named constant is still exempt at every hop — the clean shape", async () => {
    const source = [
      "export const MAX_ROUNDS_EXIT = 6;",
      "async function main(): Promise<number> {",
      "  const alias = MAX_ROUNDS_EXIT;",
      "  const code = alias;",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([6])),
    ).toEqual([]);
  });

  test("a same-named but UNRELATED nested `emit` function is NOT mistaken for the real dispatch emitter — a shadow, not an alias", async () => {
    // The finding: matching on `expr.text === 'emit'` unconditionally could
    // not tell a genuine call to the file's own dispatch emitter apart from
    // an unrelated, same-named function declared in some other scope. The
    // fix resolves the callee's own declaration and compares it against the
    // file's real top-level `emit`, so a nested shadow — which is never that
    // declaration — is correctly rejected.
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  async function helper(): Promise<void> {",
      "    async function emit(x: number): Promise<void> {}",
      "    await emit(11);",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a nested shadow named differently from the real emit is unaffected either way — sanity check on the fixture shape", async () => {
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("a destructured `.code` binding (`const { code } = bump`) is caught — a destructuring is a code-property access too", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const { code } = bump;",
      "  if (code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("a renamed destructured `.code` binding (`const { code: alias } = bump`) is caught the same way", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const { code: alias } = bump;",
      "  if (alias === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("a destructured binding for a property OTHER than `code` is not flagged", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const { value } = bump;",
      "  if (value === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an array-destructured binding named `code` is NOT mistaken for a `.code` property access — positional, not a property at all", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const [code] = bump;",
      "  if (code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a chained alias of a destructured `.code` binding is followed through both mechanisms together", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const { code } = bump;",
      "  const alias = code;",
      "  if (alias === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "comparison" }]);
  });
});

describe("findBareLiteralExits — the emitter nested inside its own top-level function, the real drive-status.ts shape", () => {
  // Every alias-resolution fixture in the describe block above declares `emit`
  // as a TOP-LEVEL sibling of `main` — but the real drive-status.ts declares
  // its dispatch emitter one level DEEPER, directly inside `main()`'s own body
  // (`async function main() { async function emit(code) { ... } ... }`).
  // `findTopLevelFunctionDeclaration` only searched `sourceFile.statements`, so
  // on the real file `emitDeclaration` was always `undefined`; every real
  // `emit(<literal>)` call then resolved to a declaration that fails BOTH the
  // `declaration === emitDeclaration` check (undefined never equals a real
  // node) and the `ts.isVariableDeclaration` fallback (a FunctionDeclaration is
  // neither), so `resolvesToLocalEmit` silently returned `false` for every real
  // call site — the scan never looked at drive-status.ts's own `emit(...)`
  // calls at all. This fixture reproduces that exact shape and would have
  // reported `[]` before the fix.
  test("a bare-literal emit() call is caught when emit is declared inside main(), not beside it", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emit(code: number): Promise<void> {}",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("a nested shadow two levels deep from main is still rejected, even though the real emitter now has no top-level sibling", async () => {
    // Guards against widening the search too far: the fix must resolve the
    // canonical `emit` one level into a top-level function's body, not
    // arbitrarily deep. `helper()` here is itself nested inside `main()`, so
    // its own `emit` is two levels down from the SourceFile and must stay a
    // rejected shadow, exactly like the shadow fixture at the true top level.
    const source = [
      "async function main(): Promise<number> {",
      "  async function emit(code: number): Promise<void> {}",
      "  async function helper(): Promise<void> {",
      "    async function emit(x: number): Promise<void> {}",
      "    await emit(11);",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("the real repo corpus: injecting a bare-literal comparison into the actual drive-status.ts source is caught", async () => {
    // The end-to-end guarantee this bug evaded: `runCheck()`'s "the shipped
    // corpus is drift-free" test (below) passing does not by itself prove
    // this scan ever looks at a real out-of-band site — it could pass
    // because the scan is broken and finds nothing to flag, exactly as it
    // did before this round's fix. This mutates the REAL, checked-in
    // drive-status.ts source textually and asserts the scan reports it, so a
    // future regression on the real file, not just a synthetic fixture, is
    // provably caught.
    //
    // This used to target `await emit(SESSION_LEASE_HELD_EXIT);` —
    // a named-constant emit() ARGUMENT. That shape no longer exists at any
    // of drive-status.ts's out-of-band sites: `report.state` and the
    // emitted/returned exit code are now derived from ONE
    // `outOfBand(report, 'SESSION_LEASE_HELD', ...)` call (see that
    // function's own doc comment in terminal-states.ts for the pairing-drift
    // bug this closes), so there is no longer a named-constant emit()/return
    // argument at these sites to revert to a bare literal. The remaining
    // bare-literal-bypass surface for SESSION_LEASE_HELD_EXIT /
    // DRIVE_HELD_ELSEWHERE_EXIT in drive-status.ts is the COMPARISON that
    // selects which branch (and therefore which `outOfBand()` call) runs at
    // all — this mutates that instead.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = "if (bump.code === SESSION_LEASE_HELD_EXIT) {";
    expect(realSource).toContain(target);
    const mutated = realSource.replace(target, "if (bump.code === 11) {");
    const found = await findBareLiteralExits(
      mutated,
      driveStatusTsSourcePath(),
      new Set([11]),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((exit) => exit.kind === "comparison" && exit.value === 11),
    ).toBe(true);
  });

  test("the real repo corpus: injecting a bare-literal comparison for the OTHER out-of-band identifier is caught too", async () => {
    // Sibling of the test above, for `DRIVE_HELD_ELSEWHERE_EXIT` at the
    // PR-wide admission preflight site rather than the round-gate
    // lease bump — a distinct real call site, so this is not redundant with
    // the `SESSION_LEASE_HELD_EXIT` mutation above.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = "if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {";
    expect(realSource).toContain(target);
    const mutated = realSource.replace(target, "if (admit.code === 13) {");
    const found = await findBareLiteralExits(
      mutated,
      driveStatusTsSourcePath(),
      new Set([13]),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((exit) => exit.kind === "comparison" && exit.value === 13),
    ).toBe(true);
  });
});

describe("findBareLiteralExits — the reporter is identified by structural position, never by name", () => {
  // A `findTopLevelFunctionDeclaration(sourceFile, 'emit')` lookup locates
  // the reporter by matching the literal spelling `emit`. A
  // behavior-preserving rename of the real nested function AND its call
  // sites to `emitReport` makes that lookup return `undefined`, so the
  // perfectly resolvable `emitReport` declaration is rejected and `await
  // emitReport(11)` passes the gate uncaught.
  // `isEmitterZoneFunctionDeclaration` replaces the name check with a pure
  // position test, so every fixture below renames BOTH the declaration and
  // every call site and still expects the bare literal to be caught.

  test("a bare-literal call is still caught after renaming BOTH the declaration and its call site away from `emit`", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  await emitReport(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("the named-constant form of the renamed reporter is still NOT flagged — the clean shape survives the rename too", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  await emitReport(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an alias of the renamed reporter is still caught, chained alias-following unaffected by the rename", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  const report = emitReport;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("a shadow two levels deep from main is still rejected even under the renamed spelling — the position bound survives the rename too", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  async function helper(): Promise<void> {",
      "    async function emitReport(x: number): Promise<void> {}",
      "    await emitReport(11);",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("the real repo corpus: renaming the actual drive-status.ts reporter — declaration AND every call site — is still caught", async () => {
    // Mirrors the real-corpus injection test above, but exercises a rename,
    // not just a bare-literal argument swap.
    // Every occurrence of the identifier followed by `(` — the declaration
    // included, since `async function emit(code: number)` contains the exact
    // same `emit(` substring as every call site — is renamed uniformly, so
    // this reproduces a genuine behavior-preserving rename of the real
    // nested function and every one of its callers at once.
    //
    // The mutation target is now one `outOfBand`-derived
    // `await emit(code);` call rather than a named-constant argument — see
    // the sibling comparison-kind tests above for why the named-constant
    // emit()/return shape no longer exists in the real file. Reverting that
    // call's `code` argument to a bare `11` still reproduces what this test
    // exists to catch: a real out-of-band exit bypassing its binding, after
    // a behavior-preserving rename of the reporter. The surrounding
    // "another live session…"/`bump.stderr` text pins this to the ONE
    // `SESSION_LEASE_HELD` block that reads `bump` rather than `bumpA`.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    expect(realSource).toContain(
      "async function emit(code: number): Promise<void> {",
    );
    const block = [
      '              "another live session in this working tree holds the drive lease for this PR",',
      "            );",
      "            if (bump.stderr) process.stderr.write(bump.stderr);",
      "            await emit(code);",
      "            return code;",
    ].join("\n");
    expect(realSource).toContain(block);
    const mutatedBlock = block.replace("await emit(code);", "await emit(11);");
    const renamed = realSource
      .replace(block, mutatedBlock)
      .replace(/\bemit\(/g, "emitReport(");
    const found = await findBareLiteralExits(
      renamed,
      driveStatusTsSourcePath(),
      new Set([11]),
    );
    expect(
      found.some((exit) => exit.kind === "call" && exit.value === 11),
    ).toBe(true);
  });
});

describe("findBareLiteralExits — the reporter is identified by call contract, not position alone", () => {
  // A position-only test neither recognizes a function-VALUED variable
  // declaration nor excludes an unrelated sibling declared at the identical
  // structural depth. Both are closed by `matchesReporterSignature` plus
  // `isEmitterZoneVariableDeclaration` — see their own doc comments above
  // `resolvesToLocalReporter`.

  test("a bare-literal call to an arrow-function-valued reporter is caught — a behavior-preserving rewrite away from a function declaration", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const emit = async (code: number): Promise<void> => {};",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("the named-constant form survives the arrow-function rewrite too — the clean shape", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  const emit = async (code: number): Promise<void> => {};",
      "  await emit(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a bare-literal call to a function-expression-valued reporter is caught the same way", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const emit = async function (code: number): Promise<void> {};",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("an unrelated sibling function at the exact same structural depth is not mistaken for the reporter, while a real call to the reporter still is", async () => {
    // `countOrNull`'s own real signature in drive-status.ts: a single
    // `number | null` parameter, never a bare `number` — so it fails the
    // call-contract test even though it sits at the identical position as
    // the real `emit`, directly inside `main()`.
    const source = [
      "async function main(): Promise<number> {",
      "  function countOrNull(n: number | null): number | null {",
      "    return n;",
      "  }",
      "  async function emit(code: number): Promise<void> {}",
      "  await countOrNull(11);",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 7, value: 11, kind: "call" }]);
  });

  test("a zero-argument sibling at the same structural depth is not mistaken for the reporter either", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function reflectDue(): Promise<boolean> {",
      "    return false;",
      "  }",
      "  await reflectDue();",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });
});
