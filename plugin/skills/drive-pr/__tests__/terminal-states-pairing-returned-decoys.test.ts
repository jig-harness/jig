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
  test("a `.outOfBand` member access through a locally returned UNRELATED decoy object (`function getNamespace() { return decoy; } getNamespace().outOfBand(...)`) produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare const decoy: {",
      "  outOfBand(report: unknown, name: string, reason: string): number;",
      "};",
      "function getNamespace(): typeof decoy {",
      "  return decoy;",
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
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a computed ELEMENT access on a locally returned real NAMESPACE object (`function getNamespace() { return terminalStates; } getNamespace()[computeKey()](...)`) is an AMBIGUOUS candidate — the sibling isAmbiguousOutOfBandElementAccess object check needs the same non-identifier handling as isAmbiguousOutOfBandCallee", async () => {
    const source = [
      "import * as terminalStates from './lib/status/terminal-states.ts';",
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function computeKey(): string;",
      "function getNamespace(): typeof terminalStates {",
      "  return terminalStates;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = getNamespace()[computeKey()](report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a `.outOfBand` member access on a CLASS INSTANCE whose own property aliases the real helper (`class Holder { outOfBand = outOfBand } new Holder().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census — the object never reaches the real NAMESPACE at all, only the PROPERTY itself does (the walk inspects the PropertyDeclaration initializer rather than stopping at the ClassDeclaration)', async () => {
    // In an earlier version, isAmbiguousOutOfBandCallee's member-object branch
    // asked only "does the OBJECT reach the real terminal-states namespace"
    // (`couldReachRealHelperNamespace` for an identifier object,
    // `containsRealHelperReference` on the object alone otherwise) — the
    // right question for `ns.outOfBand`, but `new Holder()` never reaches
    // the namespace at all: the alias lives one hop deeper, on the
    // PropertyDeclaration itself, which neither arm of that ternary ever
    // asked the checker about. This call contributed to NEITHER
    // candidateCount NOR anchoredCount.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "class Holder {",
      "  outOfBand = outOfBand;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `.outOfBand` member access on a class instance whose own property is an UNRELATED decoy (`class Holder { outOfBand = decoy }`) produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "class Holder {",
      "  outOfBand = decoy;",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a `.outOfBand` member access on a class instance whose own property is a METHOD that merely RETURNS the real helper (`class Holder { outOfBand(...args) { return outOfBand; } } new Holder().outOfBand(report, "X", reason)`) produces no candidate — calling the method once executes its own body and returns outOfBand, it does not invoke outOfBand; the member equivalent of the single-call guard (at runtime this call invokes only `Holder.outOfBand`, not the returned function)', async () => {
    // In an earlier version, isAmbiguousOutOfBandCallee's member-object branch
    // routed the WHOLE resolved member expression through
    // containsRealHelperReference, whose generic forEachChild
    // fallback visits the `.outOfBand` name identifier and, for ANY
    // identifier, unconditionally walks the referenced symbol's own function
    // body — here, the MethodDeclaration body `{ return outOfBand; }` —
    // finding the real helper referenced there and flagging candidacy even
    // though invoking `new Holder().outOfBand(...)` only ever runs that
    // method's own code, never the helper itself.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "class Holder {",
      "  outOfBand(...args: Parameters<typeof outOfBand>): typeof outOfBand {",
      "    return outOfBand;",
      "  }",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test('a `.outOfBand` member access on a class instance whose own property is a GETTER that returns the real helper (`class Holder { get outOfBand(): typeof outOfBand { return outOfBand; } } new Holder().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census — accessing the getter runs its body and produces the real helper before the call syntax is even reached, unlike a plain method (the property symbol resolves to a `GetAccessorDeclaration`)', async () => {
    // In an earlier version, couldDirectInvocationReachHelper gated candidacy
    // on `ts.hasOnlyExpressionInitializer(declaration)` alone, which a
    // GetAccessorDeclaration never satisfies (a getter has a body, not an
    // initializer) — the identical shape of exclusion the method fix correctly
    // applied to a MethodDeclaration, but wrongly applied here too: unlike a
    // method, merely ACCESSING a getter already runs its body and produces
    // whatever it returns, so `new Holder().outOfBand` evaluates to the real
    // helper before the trailing `(...)` is even reached.
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "class Holder {",
      "  get outOfBand(): typeof outOfBand {",
      "    return outOfBand;",
      "  }",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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

  test("a `.outOfBand` member access on a class instance whose own property is a GETTER returning an UNRELATED decoy (`class Holder { get outOfBand() { return decoy; } }`) produces no candidate — guards against over-triggering", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "declare function decoy(report: unknown, name: string, reason: string): number;",
      "class Holder {",
      "  get outOfBand(): typeof decoy {",
      "    return decoy;",
      "  }",
      "}",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
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
});
