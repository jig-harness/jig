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

import {
  closeTypeScriptService,
  scanOutOfBandNamePairings,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

describe("scanOutOfBandNamePairings — candidateCount/anchoredCount coverage cross-check", () => {
  test("a direct PLAIN-ASSIGNMENT callee naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "let alias: typeof decoy;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (alias = decoy)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a direct callee using each LOGICAL COMPOUND-ASSIGNMENT operator (`??=`, `||=`, `&&=`) naming the real helper as its right operand is an AMBIGUOUS candidate — closing the full closed family alongside the plain-`=` form", async () => {
    for (const op of ["??=", "||=", "&&="] as const) {
      const source = [
        "import { outOfBand } from './lib/status/terminal-states.ts';",
        "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
        "let alias: typeof outOfBand | undefined;",
        "async function main(): Promise<number> {",
        "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
        `    const code = (alias ${op} outOfBand)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');`,
        "    return code;",
        "  }",
        "  return 0;",
        "}",
      ].join("\n");
      expect(
        await scanOutOfBandNamePairings(source, "drive-status.ts"),
      ).toEqual({
        candidateCount: 1,
        anchoredCount: 0,
        mismatches: [],
      });
    }
  });

  test("a direct callee using a LOGICAL COMPOUND-ASSIGNMENT operator naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "let alias: typeof decoy | undefined;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (alias ??= decoy)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a direct AWAIT-EXPRESSION callee naming the real helper (`(await outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate (an AwaitExpression is not an opaque leaf)', async () => {
    // The family extends past binary operators entirely: an AwaitExpression
    // is a unary, no-operator-token wrapper that forwards its inner
    // expression's value, so neither binary branch above can ever match it —
    // without its own case it falls through to the opaque `[unwrapped]`
    // default.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (await outOfBand)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a direct AWAIT-EXPRESSION callee naming an UNRELATED decoy produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (await decoy)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a direct callee producing its value by RETURNING ONE OF ITS OWN ARGUMENTS (`(await Promise.resolve(outOfBand))(report, "X", reason)`) is an AMBIGUOUS candidate (the call arguments are checked, not only its callee)', async () => {
    // Unwrapping `await` alone is not enough when the
    // awaited value comes from a CALL that forwards one of its own arguments
    // to its return value (`Promise.resolve(x)` returns `x` unchanged) — the
    // callee-only CallExpression-leaf check never looks at arguments at
    // all. Conservatively treating every argument of a call-producing-a-value
    // leaf as a candidate too closes this without needing to model
    // `Promise.resolve` specifically.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (await Promise.resolve(outOfBand))(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a direct callee whose produced value comes from a call passed only an UNRELATED decoy argument produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (await Promise.resolve(decoy))(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias populated by an OBJECT-LITERAL right-hand side whose OWN property is the real helper (`({ x: alias } = { x: outOfBand }); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (the ambiguity walkers descend into object-literal values)", async () => {
    // In an earlier version, findAssignedValues pushed the whole right-hand
    // side `{ x: outOfBand }` as a candidate, but neither consumer descended
    // INTO an ObjectLiteralExpression candidate — composingExpressionLeaves
    // only named `?:`/`||`/`&&`/`??`. containsRealHelperReference now walks
    // every child regardless of container kind, so the nested `outOfBand` is
    // found.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "({ x: alias } = { x: outOfBand });",
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

  test("a `let` alias populated by an OBJECT-LITERAL right-hand side whose own property is an UNRELATED decoy produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "let alias: typeof decoy;",
      "({ x: alias } = { x: decoy });",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias reached through a NON-LITERAL array container one more `const` away (`const helpers = [outOfBand]; [alias] = helpers; alias(...)`) is an AMBIGUOUS candidate", async () => {
    // In an earlier version, findAssignedValues's array-literal special-case
    // only fired when the RIGHT-HAND SIDE of the destructure was ITSELF a
    // literal array — `helpers` is a plain identifier, so the push was just
    // `helpers` whole, and neither consumer chased its OWN declaration
    // initializer `[outOfBand]` into its elements.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "const helpers = [outOfBand];",
      "let alias: typeof outOfBand;",
      "[alias] = helpers;",
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

  test("a `let` alias reached through a non-literal array container of only UNRELATED decoys produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "const helpers = [decoy];",
      "let alias: typeof decoy;",
      "[alias] = helpers;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias populated by a destructuring DEFAULT naming the real helper (`({ x: alias = outOfBand } = decoy); alias(...)`) is an AMBIGUOUS candidate regardless of what the source object is (the value never depends on the destructured right-hand side)", async () => {
    // In an earlier version, findAssignedValues pushed only `node.right`
    // (`decoy`) for a destructuring-assignment match — the DEFAULT value
    // embedded in the LHS pattern itself was never collected as a candidate at
    // all, even though it is exactly what `alias` receives when `decoy` has no
    // `x`.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: { x?: undefined };",
      "let alias: typeof outOfBand;",
      "({ x: alias = outOfBand } = decoy);",
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

  test("a `let` alias populated by a destructuring default naming only an UNRELATED decoy produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoyDefault: (report: unknown, name: string, reason: string) => number;",
      "declare const decoy: { x?: undefined };",
      "let alias: typeof decoyDefault;",
      "({ x: alias = decoyDefault } = decoy);",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("an ARRAY-PATTERN destructuring default naming the real helper (`[alias = outOfBand] = decoyArray; alias(...)`) is an AMBIGUOUS candidate too", async () => {
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoyArray: readonly (typeof outOfBand | undefined)[];",
      "let alias: typeof outOfBand;",
      "[alias = outOfBand] = decoyArray;",
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

  test("a `let` alias populated by a CALL to a LOCALLY DECLARED function whose body returns the real helper (`function getHelper() { return outOfBand; } let alias; alias = getHelper(); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (otherwise the later call contributes neither a candidate nor an anchor)", async () => {
    // In an earlier version, findAssignedValues pushed the CallExpression
    // `getHelper()` as a candidate, but containsRealHelperReference's
    // forEachChild walk only reaches the call's own callee identifier and
    // argument list — the FunctionDeclaration body lives elsewhere in the
    // source tree and was never visited, so the real helper reference
    // inside it went unseen and the call contributed to NEITHER
    // candidateCount NOR anchoredCount at all.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getHelper(): typeof outOfBand {",
      "  return outOfBand;",
      "}",
      "let alias: typeof outOfBand;",
      "alias = getHelper();",
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

  test("a `let` alias populated by a call to a locally declared function returning only an UNRELATED decoy produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "function getDecoy(): typeof decoy {",
      "  return decoy;",
      "}",
      "let alias: typeof decoy;",
      "alias = getDecoy();",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a further hop of indirection between the call and the function — `const indirect = getHelper; let alias; alias = indirect(); alias(...)` — is still an AMBIGUOUS candidate (a legal alias must not defeat it)", async () => {
    // In an earlier version, the call-through-local-function check only
    // traced a function's body when
    // an identifier sat DIRECTLY in a CallExpression's own callee position
    // and its OWN declaration was the function. `indirect`'s declaration is
    // a plain identifier initializer (`getHelper`, not a function literal),
    // so `indirect()`'s callee-body special case never fired, and nothing
    // ever inspected `getHelper`'s body at all — this call contributed to
    // NEITHER candidateCount NOR anchoredCount, the exact invisible-bypass
    // shape the mandatory gate exists to prevent.
    //
    // candidateCount is 2, not 1: the fix generalizes function-body lookup
    // into ORDINARY identifier resolution (not a call-site-shaped special
    // case), so `indirect()` — itself a call whose callee (`indirect`)
    // ambiguously reaches the real helper's body — is now its OWN flagged
    // candidate too, alongside the outer `alias(...)` dispatch call. Both
    // are genuine members of "a call site this scan cannot positively clear
    // as SAFE", which is exactly what a fail-closed, uniform walk is
    // supposed to surface — this is not double-counting one ambiguity, it
    // is two distinct call sites each resolving to the same underlying one.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getHelper(): typeof outOfBand {",
      "  return outOfBand;",
      "}",
      "const indirect = getHelper;",
      "let alias: typeof outOfBand;",
      "alias = indirect();",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 2,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("the same further-hop chain reaching only an UNRELATED decoy produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "function getDecoy(): typeof decoy {",
      "  return decoy;",
      "}",
      "const indirect = getDecoy;",
      "let alias: typeof decoy;",
      "alias = indirect();",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a STATIC CLASS METHOD returning the real helper (`class Factory { static getHelper() { return outOfBand; } } let alias; alias = Factory.getHelper(); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (a MethodDeclaration body is inspected too)", async () => {
    // In an earlier version, functionBodyOfDeclaration recognized only
    // FunctionDeclaration and a VariableDeclaration-held arrow/function
    // expression — never a MethodDeclaration (or any other class member).
    // `Factory.getHelper`'s property-name resolves to a MethodDeclaration
    // symbol, whose body was never inspected, so this call contributed to
    // NEITHER candidateCount NOR anchoredCount at all. Fixed by switching to
    // `ts.isFunctionLikeDeclaration`, TypeScript's own predicate for every
    // body-bearing function-shaped declaration (FunctionDeclaration,
    // MethodDeclaration, GetAccessor, SetAccessor, Constructor,
    // FunctionExpression, ArrowFunction) — one predicate instead of
    // enumerating declaration kinds one at a time.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "class Factory {",
      "  static getHelper(): typeof outOfBand {",
      "    return outOfBand;",
      "  }",
      "}",
      "let alias: typeof outOfBand;",
      "alias = Factory.getHelper();",
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

  test("a static class method returning only an UNRELATED decoy produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "class Factory {",
      "  static getDecoy(): typeof decoy {",
      "    return decoy;",
      "  }",
      "}",
      "let alias: typeof decoy;",
      "alias = Factory.getDecoy();",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("mutual recursion between two locally declared helper functions does not hang the scan (seen-guard)", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "function helperA(): typeof decoy {",
      "  return helperB();",
      "}",
      "function helperB(): typeof decoy {",
      "  return helperA();",
      "}",
      "let alias: typeof decoy;",
      "alias = helperA();",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a DIRECT CALL through a locally returned helper — no intervening alias at all (`function getHelper() { return outOfBand; } getHelper()(report, "X", reason)`) — is an AMBIGUOUS candidate, not invisible to the census (the outer callee is itself a CallExpression, which strict provenance rejects)', async () => {
    // In an earlier version, the census's `visit()` failed strict resolution
    // (the outer call's callee `getHelper()` is not an import-bound
    // identifier), then fell to isAmbiguousOutOfBandCallee(callee=getHelper())
    // — which checked member access, then element access, then required
    // `ts.isIdentifier(resolved)`: `getHelper()` is a CallExpression, not an
    // identifier, so this returned false immediately. The call contributed to
    // NEITHER candidateCount NOR anchoredCount at all.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getHelper(): typeof outOfBand {",
      "  return outOfBand;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = getHelper()(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("one further hop of indirection before the direct double-call (`const indirect = getHelper; indirect()(...)`) is still an AMBIGUOUS candidate — the CallExpression-callee branch composes with the pre-existing arbitrary-alias-depth walk", async () => {
    // candidateCount is 2, not 1: the INNER call `indirect()` is itself a
    // census candidate too, independent of the CallExpression-leaf branch —
    // `indirect`'s own identifier-tail chase treats a bare
    // alias whose reaching value is a function reference the same as any
    // other reaching value, so `indirect()` alone already reads as
    // ambiguous under the pre-existing identifier chase (verified in
    // isolation: `indirect(report, name, reason)` with no outer call at all
    // still reports candidateCount 1). The CallExpression-leaf branch then adds
    // a SECOND, independent candidate for the outer call, whose own callee is
    // `indirect()` — a CallExpression.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getHelper(): typeof outOfBand {",
      "  return outOfBand;",
      "}",
      "const indirect = getHelper;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = indirect()(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(await scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 2,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct call through a locally returned UNRELATED decoy (`function getHelper() { return decoy; } getHelper()(...)`) produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "function getHelper(): typeof decoy {",
      "  return decoy;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = getHelper()(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a SINGLE, non-doubled call to a locally declared function that merely RETURNS the real helper (`function getHelper() { return outOfBand; } getHelper(report, "X", reason)`) produces no candidate — calling getHelper once executes its own body and returns outOfBand, it does not invoke outOfBand; guards against an over-broad variant (routing every non-member/non-element leaf, not just a CallExpression one, through containsRealHelperReference)', async () => {
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getHelper(): typeof outOfBand {",
      "  return outOfBand;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = getHelper(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a `.outOfBand` MEMBER access through a locally returned real NAMESPACE object (`function getNamespace() { return terminalStates; } getNamespace().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census (the object side is a CallExpression, not an identifier; requiring an identifier lets runCheck() pass vacuously)', async () => {
    // In an earlier version, isAmbiguousOutOfBandCallee's member-object branch
    // required `ts.isIdentifier(unwrappedObject)` before chasing it at all —
    // the CallExpression-leaf widening covers the OUTER callee
    // position, but composes with nothing on the OBJECT side of a member
    // access, so this call contributed to NEITHER candidateCount NOR
    // anchoredCount at all.
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "function getNamespace(): typeof terminalStates {",
      "  return terminalStates;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = getNamespace().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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
