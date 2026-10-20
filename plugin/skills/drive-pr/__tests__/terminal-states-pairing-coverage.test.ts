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

import { readFileSync } from "node:fs";

import {
  closeTypeScriptService,
  driveStatusTsSourcePath,
  scanOutOfBandNamePairings,
} from "./terminal-states-consistency.ts";
import { createPairingFixtures } from "./terminal-states-pairing-fixtures.ts";

afterAll(closeTypeScriptService);

describe("scanOutOfBandNamePairings — candidateCount/anchoredCount coverage cross-check", () => {
  const pairingFixtures = createPairingFixtures();
  const { IMPORTS } = pairingFixtures;

  test("a correctly paired call site anchors — candidateCount equals anchoredCount", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("no outOfBand() calls at all is vacuously clean — 0 candidates, 0 anchored", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call nested inside a NON-dispatch inner `if`, itself nested inside the real dispatch, still anchors to the outer dispatch — the exact false negative found in review", async () => {
    // Before the fix, `findEnclosingIfTrueBranch` stopped at the innermost
    // enclosing `if` regardless of whether ITS test was a recognized
    // dispatch, so a call one level deeper than the real dispatch silently
    // found no anchor at all and reported zero mismatches even when the
    // name was wrong.
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    if (report.deep) {",
      "      const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "      return code;",
      "    }",
      "    return 0;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 6,
        comparisonLine: 4,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("a call moved into the dispatch's own `else` branch does not anchor — candidateCount outruns anchoredCount", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code !== SESSION_LEASE_HELD_EXIT) {",
      "    return 0;",
      "  } else {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call behind a `switch (x.code)` dispatch does not anchor — this scan only recognizes `if`", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  switch (bump.code) {",
      "    case SESSION_LEASE_HELD_EXIT: {",
      "      const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "      return code;",
      "    }",
      "    default:",
      "      return 0;",
      "  }",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call behind an early-return guard does not anchor — the call sits outside any `if`'s thenStatement at all", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code !== SESSION_LEASE_HELD_EXIT) {",
      "    return 0;",
      "  }",
      "  const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "  return code;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a nested REAL dispatch anchors to its own innermost comparison, not the outer one it also sits inside of", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "    if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "      const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "      return code;",
      "    }",
      "    return 0;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a `outOfBand()` mention inside a COMMENT is not counted as a candidate — this is an AST scan, not a textual one", async () => {
    const source = [
      IMPORTS,
      "// see outOfBand()'s own doc comment for details",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    // The real corpus carries exactly this shape at terminal-states.ts's own
    // header ("`outOfBand()`'s own doc comment for the pairing-drift bug
    // this closes") — a naive textual `outOfBand(` occurrence count would
    // over-count by exactly one there, which is why candidateCount is
    // derived from real call-expression AST nodes, never source text.
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("the real repo corpus: candidateCount equals anchoredCount equals 5, with zero mismatches", async () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    expect(
      await scanOutOfBandNamePairings(realSource, driveStatusTsSourcePath()),
    ).toEqual({ candidateCount: 5, anchoredCount: 5, mismatches: [] });
  });

  test("the real repo corpus: moving a real call site into its dispatch's own `else` branch drops anchoredCount below candidateCount", async () => {
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
    const result = await scanOutOfBandNamePairings(
      mutated,
      driveStatusTsSourcePath(),
    );
    expect(result.candidateCount).toBe(5);
    expect(result.anchoredCount).toBe(4);
    expect(result.anchoredCount).toBeLessThan(result.candidateCount);
  });

  test("a renaming import alias of the REAL helper is still counted as a candidate and its wrong state name is caught — the local identifier text is irrelevant", async () => {
    // Before the fix, candidateCount required the call's LOCAL identifier
    // text to literally be `outOfBand`. An aliased import of the real
    // helper — `import { outOfBand as reportOutOfBand } from …` — is called
    // through the local name `reportOutOfBand`, so this real call was never
    // counted as a candidate at all: candidateCount stayed 0, anchoredCount
    // stayed 0, and mismatches stayed empty even though the state name
    // below is wrong — a silent bypass of the whole check.
    const source = [
      "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand as reportOutOfBand } from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = reportOutOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 5,
        comparisonLine: 4,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("a local CONST REBIND of the real helper is still counted as a candidate and its wrong state name is caught", async () => {
    // Distinct from the renaming-import-alias test above: `const alias =
    // outOfBand;` is a LOCAL VARIABLE declaration, not an ImportSpecifier —
    // `alias`'s own symbol resolves to that VariableDeclaration, so the
    // direct import-specifier check alone cannot see through it. Before this
    // fix, this real, mis-anchored call was invisible to the census entirely.
    const source = [
      "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "const reportOutOfBand = outOfBand;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = reportOutOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 6,
        comparisonLine: 5,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("a two-hop CONST REBIND chain is followed the same way resolveIdentifierLiteral follows one for numeric literals", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "const hop1 = outOfBand;",
      "const hop2 = hop1;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = hop2(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a call wrapped in redundant parens — `(outOfBand)(…)` — still anchors (transparent expression wrappers are normalized)", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (outOfBand)(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a callee wrapped in an `as` type assertion — `(outOfBand as typeof outOfBand)(…)` — still anchors", async () => {
    // An unwrapTransparentExpression that only strips parens has the same
    // residual a parens-only `unwrapLiteral` would (no as/satisfies/non-null),
    // recurring on a second resolver in the same file; both are closed by the
    // same established loop.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (outOfBand as typeof outOfBand)(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a mutable (`let`) rebind is NOT trusted as provenance — a later reassignment must not still anchor through the stale initial import — but IS now an AMBIGUOUS candidate rather than silently excluded", async () => {
    // Before this fix, resolveIdentifierImportBinding recursed into ANY
    // VariableDeclaration's initializer regardless of `const`/`let`, so
    // `let alias = outOfBand; alias = decoy; alias(...)` still resolved from
    // the STALE initializer to the real import even though the call, at
    // runtime, invokes whatever `decoy` denotes — a false "verified" on a
    // call this scan never actually confirmed. Requiring the declaration
    // list to carry `NodeFlags.Const` excludes a `let` rebind from the
    // STRICT resolver — that part is unchanged and still holds here.
    //
    // This scenario must not fall all the way through to SILENT EXCLUSION
    // (candidateCount: 0) rather than the ambiguous candidate every other
    // unresolvable shape in this file gets: the recursion reaches the
    // imported outOfBand identifier, whose declaration is an
    // ImportSpecifier, not a VariableDeclaration.
    // This scan has no control-flow analysis, so it cannot actually tell "the
    // real import was overwritten by a decoy before the call" apart from "the
    // real import is still live at the call" — treating the former as a
    // confident all-clear was the bug, not a documented trade-off. Both now
    // read as AMBIGUOUS: a candidate that can never anchor, forcing a human
    // to look, which is the fail-closed direction this scan always takes.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "let alias = outOfBand;",
      "alias = decoy;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a NAMESPACE-QUALIFIED call to the real helper (`terminalStates.outOfBand(…)`) is still counted as a candidate and its wrong state name is caught", async () => {
    const source = [
      "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates.outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 5,
        comparisonLine: 4,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("an ELEMENT-ACCESS call to the real helper (`terminalStates['outOfBand'](…)`) still anchors and its wrong state name is caught", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates['outOfBand'](report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 5,
        comparisonLine: 4,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("an ELEMENT-ACCESS call keyed by a CONST identifier resolving to 'outOfBand' (`const key = 'outOfBand' as const; terminalStates[key](…)`) still anchors and its wrong state name is caught", async () => {
    // Before this fix, outOfBandMemberExpressionObject's element-access
    // branch required the key ITSELF to be a string literal —
    // `ts.isStringLiteralLike(expr.argumentExpression)` — so a key held in a
    // separate const binding (even one narrowed with `as const`, making its
    // value just as statically knowable as a direct literal) failed that
    // check before candidateCount ever incremented: candidateCount stayed
    // 0, so the wrong-state mismatch below went uncaught, and
    // runCheck()'s own candidateCount/anchoredCount cross-check couldn't
    // see the gap either since both sides stayed 0.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const key = 'outOfBand' as const;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[key](report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const result = await scanOutOfBandNamePairings(source, "drive-status.ts");
    expect(result.candidateCount).toBe(1);
    expect(result.anchoredCount).toBe(1);
    expect(result.mismatches).toEqual([
      {
        line: 6,
        comparisonLine: 5,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("an ELEMENT-ACCESS key bound WITHOUT `as const` (`const key = 'outOfBand'; terminalStates[key](…)`) still resolves — the census reads the initializer's syntax, not the checker's widened `string` type", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const key = 'outOfBand';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[key](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test('an ELEMENT-ACCESS key naming something OTHER than "outOfBand" through a const chain is not treated as a candidate', async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const key = 'outOfBandExitCode' as const;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[key]('SESSION_LEASE_HELD');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a mutable (`let`) ELEMENT-ACCESS key is NOT trusted as provenance, but is now an AMBIGUOUS candidate rather than silently excluded (a mutable let key can invoke the real helper while both candidate and anchor counts remain zero)", async () => {
    // In an earlier version, `resolveIdentifierStringLiteral`'s own const-only
    // requirement made this key unresolvable — correctly not TRUSTED as
    // naming 'outOfBand' — but `isAmbiguousOutOfBandElementAccess` then
    // special-cased "the key is an identifier" as automatically excluded too,
    // conflating "not trusted" with "not a candidate at all". A `let` key
    // reassigned right before the call is exactly the shape a fail-closed
    // scan must not wave through silently: it might still name 'outOfBand'
    // at the call site the scan cannot observe.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "let key = 'outOfBand';",
      "key = 'decoy';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[key](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("an UNRESOLVABLE identifier ELEMENT-ACCESS key — a function parameter, with no initializer to trace at all — is likewise an AMBIGUOUS candidate on the real helper namespace (`function f(key: keyof typeof terminalStates) { terminalStates[key](report, ...) }` can invoke the real helper while both candidate and anchor counts remain zero)", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function dispatch(key: keyof typeof terminalStates): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[key](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a GENUINELY dynamic ELEMENT-ACCESS key (a function call) on the REAL helper namespace is an AMBIGUOUS candidate that never anchors — fails closed instead of vanishing from the census (accepting this shape as a 0/0 residual lets a mutated state-name argument through it pass runCheck() vacuously)", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[computeKey()](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    // candidateCount: 1, anchoredCount: 0 — this is what `runCheck()`'s own
    // coverage cross-check (`anchoredCount < candidateCount`) reads as "a
    // real outOfBand() call site exists that this scan could not verify",
    // exactly the fail-closed outcome a gate owes content it cannot read.
    // Mismatches stay empty because this scan deliberately never attempts to
    // compare a state name it cannot trust belongs to this call in the first
    // place.
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a mutated state-name argument through that same dynamic-key shape is STILL not silently accepted — candidateCount stays ahead of anchoredCount regardless of what the call actually names (the exact mutation a 0/0 residual would let pass vacuously)", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[computeKey()](report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a GENUINELY dynamic ELEMENT-ACCESS key on a DECOY object (not the real helper namespace) is NOT counted as an ambiguous candidate — the fail-closed check stays scoped to the real import, mirroring the decoy exclusions elsewhere in this suite", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as decoyModule from './some-other-module.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = decoyModule[computeKey()](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a TEMPLATE LITERAL with interpolation as the ELEMENT-ACCESS key is likewise an ambiguous candidate on the real helper namespace — the fail-closed check is not scoped to call-expression keys alone", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates[`${prefix}outOfBand`](report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a local CONST REBIND of a genuinely dynamic ELEMENT-ACCESS callee (`const alias = terminalStates[computeKey()]; alias(…)`) is likewise an AMBIGUOUS candidate, not invisible to the census (missing it leaves 0/0 counts that let the wrong sibling state pass)", async () => {
    // In an earlier version, isAmbiguousOutOfBandElementAccess was only ever
    // called on the call expression's OWN callee — `alias`, a bare identifier —
    // so its `!ts.isElementAccessExpression` guard excluded this shape
    // immediately, one hop before it could see the dynamic element access
    // `alias` was rebound from. isAmbiguousOutOfBandCallee follows the same
    // same-scope rebind chain resolveOutOfBandImportProvenance already follows
    // on the RESOLVED side, so this now reaches the identical ambiguous verdict
    // the direct-callee shape above already gets.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const alias = terminalStates[computeKey()];",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });
});
