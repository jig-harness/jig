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
  test("a local CONST REBIND of a namespace-qualified callee (`const alias = terminalStates.outOfBand; alias(…)`) still anchors and its wrong state name is caught", async () => {
    // Distinct from the bare-identifier CONST rebind test above: `alias`'s
    // own initializer here is a PropertyAccessExpression, not another
    // identifier, so the identifier-to-identifier alias chain alone cannot
    // see through it — this exercises resolveIdentifierMemberRebind.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const alias = terminalStates.outOfBand;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a DESTRUCTURED rebind of a namespace-qualified callee (`const { outOfBand: alias } = terminalStates; alias(…)`) still anchors and its wrong state name is caught", async () => {
    // A destructured identifier's own declaration is a BindingElement, not
    // the VariableDeclaration the property-access rebind test above already
    // knew how to follow — the exact same shape `resolvesToCodePropertyAccess`
    // already handles for `.code`, applied here to `outOfBand` instead. Unlike
    // that sibling, the source object must ALSO be verified as the real
    // helper namespace (resolvesToRealHelperNamespace), not merely "destructured
    // from something" — see the doc comment on resolveIdentifierMemberRebind.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "const { outOfBand: alias } = terminalStates;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a DESTRUCTURED rebind from an UNRELATED module with its own `outOfBand` property is not treated as the real helper", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as decoyModule from './some-other-module.ts';",
      "const { outOfBand: alias } = decoyModule;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'SESSION_LEASE_HELD', 'reason');",
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

  test("a namespace import of an UNRELATED module with its own `.outOfBand` property is not treated as the real helper", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as decoyModule from './some-other-module.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = decoyModule.outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
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

  test("a property access naming something OTHER than `outOfBand` is not treated as a candidate, even on the real namespace import", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = terminalStates.outOfBandExitCode('SESSION_LEASE_HELD');",
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

  test("a same-named outOfBand decoy imported from elsewhere is excluded from the coverage census entirely — candidateCount stays 0, not just mismatches staying empty", async () => {
    // Before the fix, candidateCount counted ANY call whose local
    // identifier text was `outOfBand`, so this decoy (real import, but from
    // an unrelated module) was still counted as a candidate that
    // resolveOutOfBandCallStateName correctly refused to anchor —
    // producing candidateCount: 1, anchoredCount: 0. That is exactly the
    // shape runCheck()'s own coverage cross-check reads as "a real call
    // site lost its anchor", so a harmless decoy alone failed the
    // mandatory gate. findOutOfBandNamePairingMismatches alone (the
    // decoy test above) cannot see this: it discards the counts and only
    // ever reports `[]`, same before and after this fix.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './some-other-module.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias populated by ASSIGNMENT rather than its own initializer, then called on a genuinely dynamic key (`let alias: typeof terminalStates.outOfBand; alias = terminalStates[computeKey()]; alias(...)`), is an AMBIGUOUS candidate, not invisible to the census (it has no declaration initializer, so an initializer-only census misses it)", async () => {
    // In an earlier version, isAmbiguousOutOfBandCallee's identifier-chase
    // bailed out the moment `declaration.initializer === undefined` — a `let`
    // declared with no initializer at all, populated only by a later plain
    // assignment, had nothing for that chain to follow and the call vanished
    // from the census with candidateCount/anchoredCount both at 0.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "let alias: typeof terminalStates.outOfBand;",
      "alias = terminalStates[computeKey()];",
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

  test("a `let`-REASSIGNED namespace alias, then called on a genuinely dynamic key (`let ns = decoyModule; ns = terminalStates; ns[computeKey()](...)`), is an AMBIGUOUS candidate", async () => {
    // In an earlier version, isAmbiguousOutOfBandElementAccess's object-side
    // check ran through resolveIdentifierImportBinding, which requires a CONST
    // chain — a `let`-declared namespace alias reassigned away from its own
    // initializer resolved to nothing there and the call vanished from the
    // census identically to the case above, one hop further out.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as decoyModule from './some-other-module.ts';",
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "let ns = decoyModule;",
      "ns = terminalStates;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = ns[computeKey()](report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias assigned DIRECTLY to the real `outOfBand` import — no member access at all (`let alias; alias = outOfBand; alias(...)`) — is an AMBIGUOUS candidate, not invisible to the census (its declaration is an ImportSpecifier, not a VariableDeclaration)", async () => {
    // In an earlier version, isAmbiguousOutOfBandCallee's identifier-chase
    // recursed into the assigned candidate `outOfBand`, but its own base case
    // only continued the chase past a `ts.VariableDeclaration` — an
    // ImportSpecifier (what `outOfBand` itself resolves to) failed that guard
    // and the whole chase returned false, so this call vanished from the census
    // exactly like the gaps above, one hop earlier: no member access, no
    // dynamic key, just a direct reassignment of the real helper onto a
    // reassignable binding.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "alias = outOfBand;",
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

  test("a `let` alias assigned to a DEFINITE `.outOfBand` PROPERTY ACCESS on the real namespace (`let alias; alias = terminalStates.outOfBand; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (a property access that is neither an ambiguous dynamic element access nor an identifier)", async () => {
    // In an earlier version, the recursion into the assigned candidate
    // `terminalStates.outOfBand` first tried isAmbiguousOutOfBandElementAccess
    // (which requires an ElementAccessExpression and so refused a plain
    // PropertyAccessExpression outright), then tried ts.isIdentifier (also
    // false, since a property access is not a bare identifier) — the chase
    // had no third branch for a DEFINITE `.outOfBand` member access reached
    // through a non-const alias, so it vanished from the census exactly like
    // the direct-import case above.
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof terminalStates.outOfBand;",
      "alias = terminalStates.outOfBand;",
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

  test("a `let` alias assigned DIRECTLY to a same-named `outOfBand` DECOY import (not the real helper) produces no candidate at all — the direct-import reach stays scoped to the real import, mirroring the decoy exclusions elsewhere in this suite", async () => {
    // Guards the direct-import reach above against over-triggering: reaching
    // SOME import specifier through a reassignable alias must not by itself
    // widen the census — the reached specifier still has to actually be the
    // real `outOfBand` export of the real helper module.
    const source = [
      "import { outOfBand } from './some-other-module.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "alias = outOfBand;",
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

  test("a `let` alias populated by a COMPOUND LOGICAL ASSIGNMENT to the real `outOfBand` import (`let alias; alias ??= outOfBand; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (an assignment census recording only `identifier = rhs` ignores `alias ??= outOfBand`)", async () => {
    // In an earlier version, findAssignedValues only matched EqualsToken, so a
    // `??=`/`||=`/`&&=` reassignment of the real helper left `alias` with no
    // recorded reaching value at all — vanishing from the census exactly
    // like the direct-`=` gap this mirrors, one operator token wider.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "alias ??= outOfBand;",
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

  test("a `let` alias populated by a COMPOUND LOGICAL ASSIGNMENT to a same-named `outOfBand` DECOY import produces no candidate at all — mirrors the direct-import decoy guard for the compound-operator shape", async () => {
    const source = [
      "import { outOfBand } from './some-other-module.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "alias ??= outOfBand;",
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

  test("a `let` alias populated by an OBJECT-DESTRUCTURING ASSIGNMENT off the real helper namespace (`let alias; ({ outOfBand: alias } = terminalStates); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census", async () => {
    // In an earlier version, findAssignedValues required
    // `ts.isIdentifier(node.left)`, so a destructuring-ASSIGNMENT pattern (as
    // opposed to a destructuring DECLARATION, `const { outOfBand: alias } =
    // terminalStates`) left `alias` with no recorded reaching value at all.
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof terminalStates.outOfBand;",
      "({ outOfBand: alias } = terminalStates);",
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

  test("a `let` alias populated by an OBJECT-DESTRUCTURING ASSIGNMENT off an UNRELATED decoy module with its own `outOfBand` property produces no candidate at all — mirrors the destructuring-declaration decoy guard for the assignment-pattern shape", async () => {
    const source = [
      "import * as decoyModule from './some-other-module.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof decoyModule.outOfBand;",
      "({ outOfBand: alias } = decoyModule);",
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

  test("a SHORTHAND object-destructuring assignment off the real helper namespace (`let outOfBand; ({ outOfBand } = terminalStates); outOfBand(...)`) is an AMBIGUOUS candidate too", async () => {
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let outOfBand: typeof terminalStates.outOfBand;",
      "({ outOfBand } = terminalStates);",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `let` alias assigned only to an UNRELATED decoy, never to the real helper namespace, produces no candidate at all", async () => {
    // Guards the fix above against over-triggering: merely being a `let`
    // that is reassigned somewhere must not by itself widen the census — the
    // reassigned value still has to actually reach the real helper's
    // namespace import.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import * as decoyModule from './some-other-module.ts';",
      "let alias = decoyModule.outOfBand;",
      "alias = decoyModule[computeKey()];",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = alias(report, 'SESSION_LEASE_HELD', 'reason');",
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

  test("a `let` alias populated by a COMPUTED-KEY object-destructuring assignment off the real helper namespace (`let alias; ({ ['outOfBand']: alias } = terminalStates); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (left unsupported, `candidateCount` and `anchoredCount` would both remain zero)", async () => {
    // In an earlier version, findAssignedValues resolved the destructuring
    // TARGET fine (`alias` was found as the property-assignment's own
    // initializer) but then demanded a STATICALLY named key to synthesize a
    // candidate value — a ComputedPropertyName, even one wrapping a plain
    // string literal, made objectAssignmentPatternPropertyName() return
    // undefined, so the whole match was silently dropped.
    // assignmentPatternBindsSymbol no longer needs to name the property at all
    // — it only has to prove `alias` is A target somewhere in the pattern.
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof terminalStates.outOfBand;",
      "({ ['outOfBand']: alias } = terminalStates);",
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

  test("a `let` alias populated by a COMPUTED-KEY object-destructuring assignment off an UNRELATED decoy module produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import * as decoyModule from './some-other-module.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof decoyModule.outOfBand;",
      "({ ['outOfBand']: alias } = decoyModule);",
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

  test("a `let` alias populated by an ARRAY-PATTERN destructuring assignment off the real helper (`let alias; [alias] = [terminalStates.outOfBand]; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census", async () => {
    // In an earlier version, findAssignedValues only recognized an identifier
    // or an OBJECT-literal pattern as the assignment LHS — an ArrayLiteralExpr
    // ession pattern matched neither branch, so the walker fell straight
    // through to forEachChild without ever recording a candidate.
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof terminalStates.outOfBand;",
      "[alias] = [terminalStates.outOfBand];",
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

  test("a `let` alias populated by an ARRAY-PATTERN destructuring assignment off an UNRELATED decoy value produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import * as decoyModule from './some-other-module.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof decoyModule.outOfBand;",
      "[alias] = [decoyModule.outOfBand];",
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

  test("a `let` alias populated by a CONDITIONAL (ternary) expression naming the real helper in one branch (`alias = flag ? outOfBand : decoy; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (the ambiguity walker traces the conditional expression it collected as a value)", async () => {
    // In an earlier version, findAssignedValues correctly pushed the whole
    // ConditionalExpression as a reassignment candidate, but both consumers
    // only recursed when `ts.isIdentifier(unwrapTransparentExpression(cand
    // idate))` — a ternary node is neither, so it was dropped without ever
    // looking at either branch. composingExpressionLeaves now expands it
    // into both branches before either consumer inspects it.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: (report: unknown, name: string, reason: string) => number;",
      "declare const flag: boolean;",
      "let alias: typeof outOfBand;",
      "alias = flag ? outOfBand : decoy;",
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

  test("a `let` alias populated by a CONDITIONAL expression naming only UNRELATED decoys in both branches produces no candidate at all — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoyA: (report: unknown, name: string, reason: string) => number;",
      "declare const decoyB: (report: unknown, name: string, reason: string) => number;",
      "declare const flag: boolean;",
      "let alias: typeof decoyA;",
      "alias = flag ? decoyA : decoyB;",
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

  test("a `let` alias populated by a LOGICAL (`??`) expression naming the real helper in the fallback operand is an AMBIGUOUS candidate too — composingExpressionLeaves covers `||`/`&&`/`??`, not just `?:`", async () => {
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const maybeDecoy: typeof outOfBand | undefined;",
      "let alias: typeof outOfBand;",
      "alias = maybeDecoy ?? outOfBand;",
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

  test('a direct COMMA-EXPRESSION callee naming the real helper as its right operand (`(sideEffect(), outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census (`composingExpressionLeaves()` expands `CommaToken`)', async () => {
    // In an earlier version, composingExpressionLeaves only expanded `?:`/`||`/
    // `&&`/`??` — a comma-expression callee fell through to the default
    // `return [unwrapped]`, treating the whole BinaryExpression as one
    // opaque leaf that is neither a member access, an element access, a
    // call, nor a bare identifier, so isAmbiguousOutOfBandCallee returned
    // false and the call contributed to neither candidateCount nor
    // anchoredCount.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function sideEffect(): void;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (sideEffect(), outOfBand)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a direct COMMA-EXPRESSION callee naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function sideEffect(): void;",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (sideEffect(), decoy)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a direct PLAIN-ASSIGNMENT callee naming the real helper as its right operand (`(alias = outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate (the assignment-expression form one operator over from the comma)', async () => {
    // In an earlier version, an EqualsToken binary expression fell through to
    // the opaque-leaf default exactly like an unhandled CommaToken did.
    const source = [
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "let alias: typeof outOfBand;",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = (alias = outOfBand)(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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
