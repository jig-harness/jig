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
  findBareLiteralExits,
  findOutOfBandNamePairingMismatches,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

describe("findBareLiteralExits — comparison and call sites, not just return", () => {
  // The finding: a future `if (bump.code === 11)` or `emit(11)` bypasses the
  // named constant exactly like a bare `return 11;` does, but the scan only
  // looked at `return` statements. These sites are code-bound in
  // `drive-status.ts`'s real out-of-band dispatch (`bump.code === X`, then
  // `emit(X)`, then `return X`), so all three must be caught independently.

  test('a `.code === <literal>` comparison is caught, with kind "comparison"', async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump.code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("the literal may appear on either side of the comparison", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (11 === bump.code) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("the named constant form in a comparison is NOT flagged — the clean shape", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a comparison against a property OTHER than `.code` is not flagged — scoped to the real dispatch shape", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump.value === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a bare-identifier comparison with no `.code` property access at all is not flagged", async () => {
    const source = [
      "async function main(): Promise<number> {",
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

  test("a `bump['code'] === <literal>` element-access comparison is caught too — a behavior-preserving rewrite of the dot-access shape", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump['code'] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("a template-literal element access (`bump[`code`]`) is caught the same way", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump[`code`] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test('an element access for a key OTHER than "code" is not flagged', async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump['value'] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a computed element access through an intermediate variable is NOT resolved — a documented residual, not a regression", async () => {
    // Pinned as a mutation guard: `isCodePropertyAccess`
    // stays name-based, matching a string-literal key directly. A key held
    // in a variable (`const k = 'code'; bump[k]`) is out of scope, same as
    // the function's own header states.
    const source = [
      "async function main(): Promise<number> {",
      "  const k = 'code';",
      "  if (bump[k] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a local extraction of the `.code` access into its own variable is still caught — a behavior-preserving rewrite of the property-access shape", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const code = bump.code;",
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

  test("the local-extraction alias is caught for the element-access spelling too", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const code = bump['code'];",
      "  if (11 === code) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("an alias of a property OTHER than `.code` is NOT mistaken for one", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const value = bump.value;",
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

  test("a reassigned `.code` alias is still resolved off its own declaration initializer, not the later write — a documented residual, not a regression", async () => {
    // Mirrors the identical stance already pinned for `resolvesToLocalEmit`
    // (the reassigned-emit-alias test below): reads `code`'s own declaration
    // initializer (`bump.code`), not the later write.
    const source = [
      "async function main(): Promise<number> {",
      "  let code = bump.code;",
      "  code = other.value;",
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

  test("the computed-element-access-through-a-variable residual survives the alias-following fix — still out of scope", async () => {
    // `const k = 'code'; const code = bump[k];` — the alias now resolves
    // through the local extraction, but `isCodePropertyAccess` itself still
    // never recognizes `bump[k]` for a non-literal key, so this stays
    // unresolved exactly like the direct (non-aliased) case above.
    const source = [
      "async function main(): Promise<number> {",
      "  const k = 'code';",
      "  const code = bump[k];",
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

  test('an `emit(<literal>)` call is caught, with kind "call"', async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "call" }]);
  });

  test("the named constant form in an emit() call is NOT flagged — the clean shape", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  await emit(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a call to a differently-named, UNDECLARED function is not mistaken for emit() — the textual-fallback rescue only, never reachable on real corpus", async () => {
    // `emitSomethingElse` is never declared anywhere in this fixture, so the
    // binder cannot resolve it at all and `resolvesToLocalReporter` falls
    // back to the pre-binder textual match (`expr.text === 'emit'`) — the
    // ONE place this scan still reads a name, scoped to a shape that cannot
    // occur in real, type-checking source (see that fallback's own doc
    // comment). Contrast with the sibling test below, where the callee IS
    // declared: there, position — not name — decides, and a differently-named
    // local function at the SAME structural position as `emit` is now (round
    // 6) correctly indistinguishable from it.
    const source = [
      "async function main(): Promise<number> {",
      "  await emitSomethingElse(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an alias of `emit` is still caught — a behavior-preserving rename evading identifier-text matching", async () => {
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  const report = emit;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("an alias of a differently-named but DECLARED local function is now caught the same as an alias of emit — position, not name, identifies the reporter", async () => {
    // Identifying the reporter by matching the literal spelling `emit` would
    // pin the OPPOSITE claim ("NOT mistaken"), and that name-coupling is
    // broken: a behavior-preserving rename of the REAL reporter defeats it
    // just as completely as this fixture's differently-named function does.
    // The check drops name-matching entirely in favor of structural
    // position, so a function declared in the same recognized
    // zone as `emit` is now — correctly, on purpose — indistinguishable from
    // it, whatever it happens to be called.
    const source = [
      "async function emitSomethingElse(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  const report = emitSomethingElse;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("a reassigned emit alias is still resolved off its own declaration's initializer, not the later write — a documented residual, not a regression", async () => {
    // Pinned as a mutation guard, mirroring the identical
    // stance `resolveIdentifierLiteral` already takes on reassignment: this
    // reads `report`'s own declaration initializer (`emit`), not the later
    // write, so this case stays flagged rather than silently falling out of
    // the population once assigned away.
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function emitSomethingElse(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  let report = emit;",
      "  report = emitSomethingElse;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 6, value: 11, kind: "call" }]);
  });

  test("all three shapes in one function are each reported independently", async () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump.code === 11) {",
      "    await emit(11);",
      "    return 11;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      await findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([
      { line: 2, value: 11, kind: "comparison" },
      { line: 3, value: 11, kind: "call" },
      { line: 4, value: 11, kind: "return" },
    ]);
  });
});

describe("findOutOfBandNamePairingMismatches — outOfBand call sites picking the wrong sibling state", () => {
  const IMPORTS = [
    "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
    "import { outOfBand } from './lib/status/terminal-states.ts';",
  ].join("\n");

  test("a correctly paired call site is not flagged — the clean shape", async () => {
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
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a call site naming the WRONG sibling state for its enclosing comparison is caught", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([
      {
        line: 5,
        comparisonLine: 4,
        comparisonIdentifier: "SESSION_LEASE_HELD_EXIT",
        expectedStateName: "SESSION_LEASE_HELD",
        actualStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
      },
    ]);
  });

  test("the mismatch is caught in either direction — the other sibling swapped the other way", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "    const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([
      {
        line: 5,
        comparisonLine: 4,
        comparisonIdentifier: "DRIVE_HELD_ELSEWHERE_EXIT",
        expectedStateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
        actualStateName: "SESSION_LEASE_HELD",
      },
    ]);
  });

  test("multiple correctly paired sites side by side are all clean", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "    return code;",
      "  }",
      "  if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("an outOfBand() call with no enclosing .code comparison is silently out of scope — nothing to anchor the check against", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a comparison against a property OTHER than `.code` is not treated as a dispatch — no anchor, no mismatch reported", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.value === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a `!==` comparison is out of scope by design — it dispatches on absence, not presence, of the state", async () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  if (bump.code !== SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a same-named outOfBand() decoy imported from elsewhere is not treated as the real helper", async () => {
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
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a same-named comparison identifier imported from elsewhere is not treated as the real exit constant", async () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './some-other-module.ts';",
      "import { outOfBand } from './lib/status/terminal-states.ts';",
      "async function main(): Promise<number> {",
      "  if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "    const code = outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason');",
      "    return code;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    expect(
      await findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("the real repo corpus: the shipped drive-status.ts has zero outOfBand() name-pairing mismatches", async () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    expect(
      await findOutOfBandNamePairingMismatches(
        realSource,
        driveStatusTsSourcePath(),
      ),
    ).toEqual([]);
  });

  test("the real repo corpus: swapping a real outOfBand() call site to the sibling state, inside an unchanged comparison branch, is caught (the exact mutation this issue exists to catch)", async () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = [
      "          if (bump.code === SESSION_LEASE_HELD_EXIT) {",
      "            const code = outOfBand(",
      "              report,",
      '              "SESSION_LEASE_HELD",',
      '              "another live session in this working tree holds the drive lease for this PR",',
      "            );",
    ].join("\n");
    expect(realSource).toContain(target);
    const mutatedBlock = target.replace(
      '"SESSION_LEASE_HELD",',
      '"DRIVE_HELD_BY_OTHER_WORKTREE",',
    );
    const mutated = realSource.replace(target, mutatedBlock);
    const found = await findOutOfBandNamePairingMismatches(
      mutated,
      driveStatusTsSourcePath(),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some(
        (m) =>
          m.expectedStateName === "SESSION_LEASE_HELD" &&
          m.actualStateName === "DRIVE_HELD_BY_OTHER_WORKTREE",
      ),
    ).toBe(true);
  });

  test("the real repo corpus: the sibling PR-wide admission preflight site is caught the same way", async () => {
    // A distinct real call site from the round-gate lease bump
    // above — not redundant with it.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = [
      "        if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {",
      "          const code = outOfBand(",
      "            report,",
      '            "DRIVE_HELD_BY_OTHER_WORKTREE",',
    ].join("\n");
    expect(realSource).toContain(target);
    const mutatedBlock = target.replace(
      '"DRIVE_HELD_BY_OTHER_WORKTREE",',
      '"SESSION_LEASE_HELD",',
    );
    const mutated = realSource.replace(target, mutatedBlock);
    const found = await findOutOfBandNamePairingMismatches(
      mutated,
      driveStatusTsSourcePath(),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some(
        (m) =>
          m.expectedStateName === "DRIVE_HELD_BY_OTHER_WORKTREE" &&
          m.actualStateName === "SESSION_LEASE_HELD",
      ),
    ).toBe(true);
  });
});
