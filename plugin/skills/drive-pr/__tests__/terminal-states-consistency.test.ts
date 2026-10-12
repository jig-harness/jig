/**
 * Regression suite for the drive-pr terminal-state ↔ exit-code
 * drift check.
 *
 * It runs as part of the repository's `bun test`, never from the plugin
 * cache: the checker needs the TypeScript compiler API (`typescript6`, a
 * repository devDependency).
 *
 * Every fixture below is mutated from a form the checker is known to accept — a
 * passing test alone proves nothing about whether the assertion is reachable at
 * all.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DriverOnlyStateName,
  driverOnlyExitCode,
  type OutOfBandStateName,
  outOfBand,
  outOfBandExitCode,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";
import {
  buildReservedExitCodes,
  driverOnlyExitBindings,
  driveStatusTsSourcePath,
  findBareLiteralExits,
  findConstantProvenanceMismatches,
  findExitConstantMismatches,
  findMissingRequired,
  findOutOfBandNamePairingMismatches,
  outOfBandExitBindings,
  runCheck,
  scanOutOfBandNamePairings,
} from "./terminal-states-consistency.ts";

/** Every `category: 'driver-only'` key in the real `TERMINAL_STATES` —
 * derived, not a second hand-typed copy of `DriverOnlyStateName`'s members,
 * so this list cannot itself go stale the way `BARE_LITERAL_EXIT_CODES`
 * used to (see the test below that pins the fix). */
const DRIVER_ONLY_STATE_NAMES = Object.entries(TERMINAL_STATES)
  .filter(([, entry]) => entry?.category === "driver-only")
  .map(([name]) => name as DriverOnlyStateName);

/** Same derivation as `DRIVER_ONLY_STATE_NAMES` above, for the two
 * out-of-band states `lib/state/lease.ts` derives its own exit constants
 * from — `SESSION_LEASE_HELD` and `DRIVE_HELD_BY_OTHER_WORKTREE`
 * are both `category: 'state'`, so filtering on category alone would also
 * catch every `evaluate.ts`-bound state; `OutOfBandStateName`'s own member
 * list is the precise set. */
const OUT_OF_BAND_STATE_NAMES: readonly OutOfBandStateName[] = [
  "SESSION_LEASE_HELD",
  "DRIVE_HELD_BY_OTHER_WORKTREE",
];

describe("runCheck — forms that MUST be read correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-terminal-states-run-"));

  const corpus = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const withCorpus = (entries: string[], fn: () => void): void => {
    const previous = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = entries.join(":");
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      fn();
    } finally {
      console.error = error;
      console.log = log;
      if (previous === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
      else process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = previous;
    }
  };

  // A realistic drive-status-header fixture — enough rows to clear the
  // population floor and cover the two-line ( SESSION_LEASE_HELD-shaped)
  // continuation form.
  const driveStatusHeaderGood = [
    " * Exit codes — the driver contract.",
    " *",
    " *   0  ROUND_READY      work exists",
    " *   3  CONVERGED        SHA-verified",
    " *   5  PR_NOT_OPEN      merged or closed",
    " *  11  SESSION_LEASE_HELD",
    " *                       another live session",
    " */",
    "",
  ].join("\n");

  test("drive-status-header: exit + identifier on the same line, including the two-line continuation form", () => {
    const file = corpus("drive-status.ts", driveStatusHeaderGood);
    withCorpus([`${file}=drive-status-header`], () =>
      expect(runCheck()).toBe(0),
    );
  });

  test("skill-md-table: state-first column order", () => {
    // The annotated CONVERGED form ("3 (`drive.ts`: 0)") has its own
    // dedicated, mutation-tested coverage below ("an annotated exit cell …
    // is read for its PRIMARY code") — this fixture stays plain so it tests
    // only what its name claims: column order.
    const file = corpus(
      "SKILL.md",
      [
        "## Terminal states",
        "",
        "| State | Exit | Meaning |",
        "|---|---|---|",
        "| `CONVERGED` | 3 | done |",
        "| `PR_NOT_OPEN` | 5 | merged or closed |",
        "| `HITL_PARKED` | 8 | parked |",
        "| `PR_CONFLICTING` | 9 | conflict |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=skill-md-table`], () => expect(runCheck()).toBe(0));
  });

  test('pipe-table-exit-first: exit-first column order, and a multi-name cell split on " / "', () => {
    const file = corpus(
      "terminal-states.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `0` | `ROUND_READY` | no | work exists |",
        "| `3` | `CONVERGED` | **yes** | done |",
        "| `4` | `HEAD_LAG` / `AWAITING_REVIEWER` / `STALE_REVIEW` / `HEAD_MOVED` / `MERGEABILITY_UNKNOWN` | no | not settled |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first`], () =>
      expect(runCheck()).toBe(0),
    );
  });

  test("a bold, mixed-case, or prose cell with NO embedded backtick token is correctly SKIPPED, not misread as an identifier", () => {
    // "PR not open" (no backticks at all) is human prose (README.md's
    // actual style for a genuinely un-annotated row) — the checker must not
    // guess an identifier out of it, and must not choke on it either.
    const file = corpus(
      "using-drive-pr.md",
      [
        "## The exit states — what you do now",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `0` | **CONVERGED** | merge |",
        "| `5` | PR not open | nothing |",
        "| `13` | `DRIVE_HELD_BY_OTHER_WORKTREE` | wait |",
        "",
      ].join("\n"),
    );
    // Only 2 of the 3 rows yield a bare identifier (CONVERGED,
    // DRIVE_HELD_BY_OTHER_WORKTREE) — set minPairs=2 to match. `+remap`
    // matches README.md's own real corpus entry: it shows only the
    // drive.ts-remapped code for CONVERGED, never drive-status.ts's raw one.
    withCorpus([`${file}=pipe-table-exit-first+remap=2`], () =>
      expect(runCheck()).toBe(0),
    );
  });

  test("a prose cell with a canonical state named INLINE in backticks is read via the embedded form, not skipped", () => {
    // "**PR not open** (`PR_NOT_OPEN`)" is README.md's own real style:
    // prose stays human-readable, but the canonical state rides along in
    // backticks so this checker can still verify the row — closing the gap
    // the whole-cell-only form leaves open (a human-prose table whose cells
    // only rarely hold a bare identifier is barely checkable at all).
    const file = corpus(
      "using-drive-pr-embedded.md",
      [
        "## The exit states — what you do now",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `0` | **CONVERGED** | merge |",
        "| `5` | **PR not open** (`PR_NOT_OPEN`) | nothing |",
        "| `8` | **HITL-parked** (`HITL_PARKED`) | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first+remap=3`], () =>
      expect(runCheck()).toBe(0),
    );

    // And the mutation: a wrong exit code behind the same embedded form must
    // still be caught — the embedded path is not a free pass either.
    const wrong = corpus(
      "using-drive-pr-embedded-wrong.md",
      [
        "## The exit states — what you do now",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `0` | **CONVERGED** | merge |",
        "| `55` | **PR not open** (`PR_NOT_OPEN`) | nothing |",
        "| `8` | **HITL-parked** (`HITL_PARKED`) | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${wrong}=pipe-table-exit-first+remap=3`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test('an annotated exit cell ("3 (`drive.ts`: 0)") is read for its PRIMARY code, not silently dropped', () => {
    // The real regression: SKILL.md's own CONVERGED row uses exactly this
    // shape, and a whole-cell-anchored EXIT_CELL made it invisible to the
    // checker entirely — the one row the whole feature exists to police went
    // unchecked.
    const file = corpus(
      "annotated-exit.md",
      [
        "## Terminal states",
        "",
        "| State | Exit | Meaning |",
        "|---|---|---|",
        "| `CONVERGED` | 3 (`drive.ts`: 0) | done |",
        "| `PR_NOT_OPEN` | 5 | closed |",
        "| `HITL_PARKED` | 8 | parked |",
        "",
      ].join("\n"),
    );
    withCorpus(
      [`${file}=skill-md-table=3=## Terminal states`],
      () => expect(runCheck()).toBe(0), // 3 pairs, including CONVERGED at its primary code 3
    );
    // And the mutation: the annotated cell's PRIMARY code must still be
    // checked, not waved through because it carries an annotation.
    const wrong = corpus(
      "annotated-exit-wrong.md",
      [
        "## Terminal states",
        "",
        "| State | Exit | Meaning |",
        "|---|---|---|",
        "| `CONVERGED` | 7 (`drive.ts`: 0) | done |",
        "| `PR_NOT_OPEN` | 5 | closed |",
        "| `HITL_PARKED` | 8 | parked |",
        "",
      ].join("\n"),
    );
    withCorpus([`${wrong}=skill-md-table=3=## Terminal states`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("EXIT_CELL rejects a malformed suffix on the exit code instead of silently accepting its digit prefix", () => {
    // Each of these carries a real identifier (PR_NOT_OPEN) behind a
    // corrupted exit cell — `5oops`/`5.5`/a garbage suffix after a
    // backtick-wrapped digit. An unanchored EXIT_CELL still captured the
    // leading `5` from every one of these and let the row through clean;
    // the fix anchors the cell to exactly a bare digit or the one
    // `` (`drive.ts`: N) `` annotation shape, so a corrupted cell now yields
    // NO pair for that row at all — floor=2 needs both rows to clear, so
    // the dropped row surfaces as the population-floor failure rather than
    // silently validating garbage as a clean `5`.
    for (const malformed of ["5oops", "5.5", "`5`garbage"]) {
      const file = corpus(
        `malformed-exit-${malformed.replace(/[^a-z0-9]/gi, "_")}.md`,
        [
          "## Exit codes",
          "",
          "| Exit | State | Terminal? | Meaning |",
          "|---|---|---|---|",
          `| ${malformed} | \`PR_NOT_OPEN\` | **yes** | closed |`,
          "| `8` | `HITL_PARKED` | **yes** | parked |",
          "",
        ].join("\n"),
      );
      withCorpus(
        [`${file}=pipe-table-exit-first=2=## Exit codes`],
        () => expect(runCheck()).toBe(1), // population floor: only HITL_PARKED's row still yields a pair
      );
    }

    // Control: the same shape with a CLEAN exit cell must still pass, so the
    // fixture proves the malformed suffix specifically, not the row shape.
    const clean = corpus(
      "clean-exit.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `5` | `PR_NOT_OPEN` | **yes** | closed |",
        "| `8` | `HITL_PARKED` | **yes** | parked |",
        "",
      ].join("\n"),
    );
    withCorpus([`${clean}=pipe-table-exit-first=2=## Exit codes`], () =>
      expect(runCheck()).toBe(0),
    );
  });

  test("CONVERGED's drive.ts remap (exit 0) is accepted ONLY in a file flagged `documentsDriveTsRemap` — every other file requires drive-status.ts's own exit 3, header included", () => {
    // Applying the remap allowance to every non-header file lets a genuinely
    // wrong `CONVERGED` → `0` row pass in ANY prose file, not just the one
    // (README.md) that actually documents drive.ts's operator-facing exit
    // (mutation-proven). Scoping it to "not the header" is too broad: it
    // still lets the same wrong row pass in SKILL.md's own primary cell and
    // in references/terminal-states.md's table, both of which document
    // drive-status.ts's contract exactly like the header does. The `+remap`
    // suffix below is the explicit, per-file opt-in instead of a role-based
    // guess.
    const prose = corpus(
      "remap-ok.md",
      [
        "## The exit states",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `0` | **CONVERGED** | merge |",
        "| `5` | **PR_NOT_OPEN** | nothing |",
        "| `8` | **HITL_PARKED** | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${prose}=pipe-table-exit-first+remap`], () =>
      expect(runCheck()).toBe(0),
    );

    // A prose file NOT flagged as documenting the remap — e.g. references/
    // terminal-states.md's or SKILL.md's own real shape — must reject the
    // same bare `0` that the flagged file above accepts.
    const unflaggedProse = corpus(
      "remap-wrong-unflagged.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `0` | `CONVERGED` | **yes** | wrongly claims drive-status.ts itself emits this |",
        "| `5` | `PR_NOT_OPEN` | **yes** | merged or closed |",
        "| `8` | `HITL_PARKED` | **yes** | parked |",
        "",
      ].join("\n"),
    );
    withCorpus([`${unflaggedProse}=pipe-table-exit-first`], () =>
      expect(runCheck()).toBe(1),
    );

    const header = corpus(
      "remap-wrong-header.ts",
      [
        " * Exit codes.",
        " *   0  CONVERGED        wrongly claims drive-status.ts itself emits this",
        " *   5  PR_NOT_OPEN      merged or closed",
        " *   8  HITL_PARKED      parked",
        " */",
        "",
      ].join("\n"),
    );
    withCorpus([`${header}=drive-status-header`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("extraction is bounded to the named heading’s section — an unrelated table elsewhere in the same file is ignored", () => {
    // A stage-flow table with bare `0`–`9` first cells can sit BEFORE the
    // real terminal-states section. Without a heading bound, a row there that
    // happens to pair a small number with an ALL-CAPS token reads as a
    // state/exit pair and can be wrongly flagged. Bounding to the heading
    // must ignore it entirely.
    const file = corpus(
      "bounded.md",
      [
        "## An unrelated stage table",
        "",
        "| # | Stage | Owner |",
        "|---|---|---|",
        "| 0 | `PR_CONFLICTING` | git |", // poison row: real name, wrong exit — must be ignored
        "",
        "## The drive's terminal states",
        "",
        "| Exit | State | Meaning |",
        "|---|---|---|",
        "| `0` | `ROUND_READY` | work |",
        "| `9` | `PR_CONFLICTING` | conflict |",
        "| `8` | `HITL_PARKED` | parked |",
        "",
        "## A later, unrelated section",
        "",
        "| 1 | `REVIEWER_FAILED` | also poison, also ignored |",
        "",
      ].join("\n"),
    );
    withCorpus(
      [`${file}=pipe-table-exit-first=3=## The drive's terminal states`],
      () => expect(runCheck()).toBe(0),
    );
  });

  test("a heading that matches nothing fails CLOSED via the population floor, not silently to a full-file scan", () => {
    const file = corpus(
      "missing-heading.md",
      [
        "## Some other heading entirely",
        "",
        "| Exit | State | Meaning |",
        "|---|---|---|",
        "| `0` | `ROUND_READY` | work |",
        "| `9` | `PR_CONFLICTING` | conflict |",
        "",
      ].join("\n"),
    );
    withCorpus(
      [`${file}=pipe-table-exit-first=1=## A heading that does not exist`],
      () => expect(runCheck()).toBe(1),
    );
  });
});

describe("runCheck — drift MUST be caught", () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-terminal-states-drift-"));

  const corpus = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const withCorpus = (entries: string[], fn: () => void): void => {
    const previous = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = entries.join(":");
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      fn();
    } finally {
      console.error = error;
      console.log = log;
      if (previous === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
      else process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = previous;
    }
  };

  test("fails when a doc states the WRONG exit code for a real state (the develop/PR_CONFLICTING shape)", () => {
    const file = corpus(
      "wrong-exit.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        // PR_CONFLICTING is really exit 9 — this states 7.
        "| `7` | `PR_CONFLICTING` | **yes** | conflict |",
        "| `5` | `PR_NOT_OPEN` | **yes** | closed |",
        "| `8` | `HITL_PARKED` | **yes** | parked |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("fails when a doc names a state that does not exist at all", () => {
    const file = corpus(
      "unknown-state.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `9` | `PR_IS_DRAFT` | **yes** | a retired name resurrected wrongly |",
        "| `5` | `PR_NOT_OPEN` | **yes** | closed |",
        "| `8` | `HITL_PARKED` | **yes** | parked |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("CONVERGED's drive.ts remap (0) is accepted in a `+remap`-flagged file — its raw drive-status.ts exit (3) is NOT, there", () => {
    const file = corpus(
      "converged-remap.md",
      [
        "## The exit states",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `0` | **CONVERGED** | merge |",
        "| `5` | **PR_NOT_OPEN** | nothing |",
        "| `8` | **HITL_PARKED** | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first+remap`], () =>
      expect(runCheck()).toBe(0),
    );

    // The replace-not-extend half: a remap-flagged file is operator-facing
    // and never shows drive-status.ts's raw code for a remapped state, so
    // documenting CONVERGED there as `3` is just as wrong as `0` is in an
    // unflagged file.
    const rawInFlagged = corpus(
      "converged-remap-raw.md",
      [
        "## The exit states",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `3` | **CONVERGED** | merge |",
        "| `5` | **PR_NOT_OPEN** | nothing |",
        "| `8` | **HITL_PARKED** | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${rawInFlagged}=pipe-table-exit-first+remap`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("but CONVERGED at any OTHER wrong exit is still caught — additionalExitCodes is not a wildcard", () => {
    const file = corpus(
      "converged-wrong.md",
      [
        "## The exit states",
        "",
        "| Exit | State | What you do |",
        "|---|---|---|",
        "| `4` | **CONVERGED** | merge |",
        "| `5` | **PR_NOT_OPEN** | nothing |",
        "| `8` | **HITL_PARKED** | decide |",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first+remap`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("fails on the population floor — a table reformatted past what the extractor recognizes must not read as clean", () => {
    // Mutating this away (e.g. accepting < the floor) must be caught here —
    // a gate's guard is proven only by a test that fails without it.
    const file = corpus(
      "reformatted.md",
      [
        "## Exit codes",
        "",
        "This table used to have rows; now it is prose describing exit codes",
        "in running text instead of a table, e.g. exit 9 is PR_CONFLICTING.",
        "",
      ].join("\n"),
    );
    withCorpus([`${file}=pipe-table-exit-first`], () =>
      expect(runCheck()).toBe(1),
    );
  });

  test("fails when a corpus file does not exist", () => {
    withCorpus(
      [`${join(dir, "was-renamed-away.md")}=pipe-table-exit-first`],
      () => expect(runCheck()).toBe(1),
    );
  });

  test("a healthy file does not mask a silent or broken sibling", () => {
    const healthy = corpus(
      "healthy.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `0` | `ROUND_READY` | no | work |",
        "| `3` | `CONVERGED` | **yes** | done |",
        "| `5` | `PR_NOT_OPEN` | **yes** | closed |",
        "",
      ].join("\n"),
    );
    const broken = corpus(
      "broken.md",
      [
        "## Exit codes",
        "",
        "| Exit | State | Terminal? | Meaning |",
        "|---|---|---|---|",
        "| `1` | `PR_CONFLICTING` | **yes** | wrong exit for this state |",
        "| `5` | `PR_NOT_OPEN` | **yes** | closed |",
        "| `8` | `HITL_PARKED` | **yes** | parked |",
        "",
      ].join("\n"),
    );
    withCorpus(
      [`${healthy}=pipe-table-exit-first`, `${broken}=pipe-table-exit-first`],
      () => expect(runCheck()).toBe(1),
    );
  });
});

describe("runCheck — the real repo corpus", () => {
  // The end-to-end guarantee: the actual, checked-in corpus (drive-status.ts,
  // SKILL.md, terminal-states.md and README.md — see CORPUS_FILES) is
  // self-consistent today. A future edit to any of them that
  // documents a pair TERMINAL_STATES does not contain fails THIS test, not
  // just the fixture-driven ones above.
  test("the shipped corpus is drift-free", () => {
    expect(runCheck()).toBe(0);
  });
});

describe("findMissingRequired — catches ONE row silently vanishing, not just total loss", () => {
  // The named gap: "The per-file population floors are only lower bounds
  // ... The tests only mutate a table to zero recognized rows, so they do
  // not catch this partial-loss evasion". These
  // fixtures construct `pairs` directly — bypassing extraction and the
  // `DRIVE_PR_TERMINAL_STATES_TEST_FILES` override entirely, since that
  // override never sets `requiredIdentifiers` (see its own doc comment on
  // `CorpusFile`) — so they test the completeness LOGIC itself, independent
  // of any one row shape.
  const pair = (state: string) => ({ state });

  test("every required identifier present, plus extras the file also documents: nothing missing", () => {
    const pairs = [pair("ROUND_READY"), pair("CONVERGED"), pair("PR_NOT_OPEN")];
    expect(findMissingRequired(pairs, ["ROUND_READY", "CONVERGED"])).toEqual(
      [],
    );
  });

  test("total loss (zero recognized rows) — the pre-existing floor case, still caught here too", () => {
    expect(findMissingRequired([], ["ROUND_READY", "CONVERGED"])).toEqual([
      "ROUND_READY",
      "CONVERGED",
    ]);
  });

  test("PARTIAL loss: one required row silently vanished while enough OTHER rows remain to clear any population floor", () => {
    // Mirrors the real header's shape: 14 required identifiers, and this
    // fixture drops exactly one (PR_CONFLICTING) while keeping 13 — well
    // above even a loosely-set floor, which is exactly the measured slack
    // (the recognizer sees 14 rows, while a floor can be as low as 12).
    const required = [
      "ROUND_READY",
      "CONVERGED",
      "NOT_SETTLED",
      "PR_NOT_OPEN",
      "RETIRED",
      "REVIEWER_FAILED",
      "HITL_PARKED",
      "PR_CONFLICTING",
      "SESSION_LEASE_HELD",
      "DRIVE_HELD_BY_OTHER_WORKTREE",
      "INDETERMINATE",
      "UNSUPPORTED_CLI",
      "PASS_DEADLINE",
      "QUOTA_PARKED",
    ];
    const droppedOneRow = required
      .filter((id) => id !== "PR_CONFLICTING")
      .map(pair);
    expect(droppedOneRow.length).toBeGreaterThanOrEqual(12); // still clears the OLD floor
    expect(findMissingRequired(droppedOneRow, required)).toEqual([
      "PR_CONFLICTING",
    ]);
  });

  test("a duplicated pair does not mask a genuinely absent one", () => {
    const pairs = [pair("CONVERGED"), pair("CONVERGED"), pair("CONVERGED")];
    expect(findMissingRequired(pairs, ["CONVERGED", "PR_NOT_OPEN"])).toEqual([
      "PR_NOT_OPEN",
    ]);
  });
});

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

  const withRequired = (
    filesEntry: string,
    required: readonly string[],
    fn: () => void,
  ): void => {
    const prevFiles = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    const prevRequired = process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = filesEntry;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED = required.join(";");
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      fn();
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

  test("a fixture carrying every required identifier passes", () => {
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
    withRequired(
      `${file}=pipe-table-exit-first=3=## Exit codes`,
      ["ROUND_READY", "CONVERGED", "PR_NOT_OPEN"],
      () => expect(runCheck()).toBe(0),
    );
  });

  test("ONE required row silently dropped — total count still clears the floor, requiredIdentifiers still catches it", () => {
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
    withRequired(
      `${file}=pipe-table-exit-first=3=## Exit codes`,
      ["ROUND_READY", "PR_NOT_OPEN", "HITL_PARKED", "PR_CONFLICTING"],
      () => expect(runCheck()).toBe(1),
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

  test("both constants correctly bound via driverOnlyExitCode(...): no mismatches", () => {
    const source = [
      realImport,
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode(",
      "  'SINGLE_INSTANCE_LOCK',",
      ");",
      "",
    ].join("\n");
    expect(findConstantProvenanceMismatches(source, bindings)).toEqual([]);
  });

  test("a constant reverted to a bare literal that still holds the RIGHT value is caught — this is exactly what findExitConstantMismatches cannot see", () => {
    const source = [
      realImport,
      "export const MAX_ROUNDS_EXIT = 6;", // reverted, but 6 is still correct
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain("MAX_ROUNDS_EXIT");
  });

  test("a driverOnlyExitCode(...) call with the WRONG state-name argument is caught", () => {
    const source = [
      realImport,
      // copy-paste mistake: names the wrong TERMINAL_STATES key
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
  });

  test("a missing declaration entirely is caught, not silently skipped", () => {
    const source = [
      realImport,
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain(
      "no top-level exported declaration",
    );
  });

  test("a top-level exported `let` (not `const`) is NOT treated as the canonical binding — a reassignment elsewhere could break it without this gate ever noticing", () => {
    const source = [
      realImport,
      // Same provenance and value as the clean shape, but declared `let`:
      // nothing stops a later `MAX_ROUNDS_EXIT = 6;` elsewhere in the file
      // from silently breaking the table binding this gate exists to pin.
      "export let MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
    expect(mismatches[0]?.reason).toContain(
      "no top-level exported declaration",
    );
  });

  test("a decoy declaration inside a NESTED function does not rescue a reverted top-level export", () => {
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
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("MAX_ROUNDS_EXIT");
  });

  test("driverOnlyExitCode imported from a DIFFERENT module is not accepted as the real one", () => {
    const source = [
      "import { driverOnlyExitCode } from './some-other-module.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
    expect(mismatches).toHaveLength(2);
    expect(mismatches.map((m) => m.constantName).sort()).toEqual([
      "MAX_ROUNDS_EXIT",
      "SINGLE_INSTANCE_LOCK_EXIT",
    ]);
  });

  test('a decoy module specifier merely CONTAINING "terminal-states" is not accepted as the real one (a substring test via .includes would let ./fake-terminal-states.ts satisfy it)', () => {
    const source = [
      "import { driverOnlyExitCode } from './fake-terminal-states.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
      "export const SINGLE_INSTANCE_LOCK_EXIT = driverOnlyExitCode('SINGLE_INSTANCE_LOCK');",
      "",
    ].join("\n");
    const mismatches = findConstantProvenanceMismatches(source, bindings);
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
    const path = new URL("../scripts/drive.ts", import.meta.url).pathname;
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
  test("a bare-literal return of a tracked exit code is found, with its line number", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (true) {",
      "    return 6;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const found = findBareLiteralExits(source);
    expect(found).toEqual([{ line: 3, value: 6, kind: "return" }]);
  });

  test("the named constant form is NOT flagged — this is the clean, post-fix shape", () => {
    const source = [
      "export const MAX_ROUNDS_EXIT = 6;",
      "async function main(): Promise<number> {",
      "  return MAX_ROUNDS_EXIT;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test('a NON-EXPORTED top-level const is not the canonical binding and IS flagged — the exemption is for the exported constant, not for "any top-level declaration"', () => {
    const source = [
      "const exit = 6;", // top-level, but never exported — not a driver-only-exit constant
      "async function main(): Promise<number> {",
      "  return exit;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 3, value: 6, kind: "return" },
    ]);
  });

  test("a numeric literal that is part of a LARGER expression is not mistaken for a bare exit-code return", () => {
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
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test("15/16 (PASS_DEADLINE_EXIT/QUOTA_PARKED_EXIT — already had named constants before) ARE flagged, same as the other four", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (a) {",
      "    return 15;",
      "  }",
      "  return 16;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 3, value: 15, kind: "return" },
      { line: 5, value: 16, kind: "return" },
    ]);
  });

  test("a genuinely unrelated numeric return (not one of the tracked driver-only codes) is not flagged", () => {
    const source = [
      "async function countThings(): Promise<number> {",
      "  return 42;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test("a parenthesized bare literal — return (6); — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return (6);",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a unary-plus bare literal — return +6; — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return +6;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a unary-MINUS literal is NOT caught — a driver-only exit code is never legitimately negative, so -6 is not this bypass class", () => {
    const source = ["function unrelated(): number {", "  return -6;", "}"].join(
      "\n",
    );
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test("a local const alias — const exit = 6; return exit; — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const exit = 6;",
      "  return exit;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 3, value: 6, kind: "return" },
    ]);
  });

  test("identifier resolution is scoped to the ENCLOSING FUNCTION only — a same-named alias in a different, unrelated function is not resolved across the boundary", () => {
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
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test("multiple sites across the file are all found, each with its own correct line number", () => {
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
    expect(findBareLiteralExits(source)).toEqual([
      { line: 3, value: 11, kind: "return" },
      { line: 6, value: 12, kind: "return" },
      { line: 11, value: 14, kind: "return" },
    ]);
  });

  test("deliberately NOT scoped to main/runRepairPass by name — a bare literal in ANY function is caught, per this scan’s own documented scope note", () => {
    const source = [
      "async function someRenamedOrExtractedHelper(): Promise<number> {",
      "  return 6;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a TypeScript `as` wrapper — return 6 as number; — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6 as number;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a `satisfies` wrapper — return 6 satisfies number; — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6 satisfies number;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("nested wrappers combine — return +(6 as number); — is caught", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return +(6 as number);",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("a shadowed BLOCK-scoped local does not steal a return that correctly reads the outer, canonical binding", () => {
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
    expect(findBareLiteralExits(source)).toEqual([]);
  });

  test("reassignment is still NOT tracked — a documented residual, not a regression (let exit = 6; exit = MAX_ROUNDS_EXIT; return exit;)", () => {
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
    expect(findBareLiteralExits(source)).toEqual([
      { line: 4, value: 6, kind: "return" },
    ]);
  });

  test("the scanned code set is DERIVED from TERMINAL_STATES, not an independent literal list", () => {
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
      expect(findBareLiteralExits(source)).toEqual([
        { line: 2, value: code, kind: "return" },
      ]);
    }
  });

  test("a value one past a real driver-only exit code is NOT flagged — the scan is exact, not a range", () => {
    const code = driverOnlyExitCode("MAX_ROUNDS") + 1000;
    const source = [
      "async function main(): Promise<number> {",
      `  return ${code};`,
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([]);
  });
});

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
  // The import line is likewise load-bearing since an earlier change:
  // `findConstantProvenanceMismatches` now verifies `driverOnlyExitCode`
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

  const withDriveTsSeams = (
    modulePath: string,
    sourcePath: string,
    fn: () => void,
  ): void => {
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
      fn();
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

  test("a healthy module + source pair passes through the real runCheck() entry point", () => {
    const modulePath = fixture("healthy-module.ts", healthyModule);
    const sourcePath = fixture("healthy-source.ts", healthySource);
    withDriveTsSeams(modulePath, sourcePath, () => expect(runCheck()).toBe(0));
  });

  test("a mismatched constant fails runCheck(), not just the pure function in isolation", () => {
    const modulePath = fixture(
      "mismatched-module.ts",
      healthyModule.replace(
        "export const MAX_ROUNDS_EXIT = 6;",
        "export const MAX_ROUNDS_EXIT = 7;",
      ),
    );
    const sourcePath = fixture("mismatched-source.ts", healthySource);
    withDriveTsSeams(modulePath, sourcePath, () => expect(runCheck()).toBe(1));
  });

  test("a bare-literal exit site fails runCheck(), not just the pure function in isolation", () => {
    const modulePath = fixture("bare-literal-module.ts", healthyModule);
    const sourcePath = fixture(
      "bare-literal-source.ts",
      healthySource.replace("return MAX_ROUNDS_EXIT;", "return 6;"),
    );
    withDriveTsSeams(modulePath, sourcePath, () => expect(runCheck()).toBe(1));
  });

  test("a constant DECLARATION reverted to a bare literal that still holds the right VALUE fails runCheck — the case findExitConstantMismatches alone cannot catch", () => {
    const modulePath = fixture("provenance-module.ts", healthyModule);
    const sourcePath = fixture(
      "provenance-source.ts",
      healthySource.replace(
        "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
        "export const MAX_ROUNDS_EXIT = 6;", // reverted, but 6 is still the right value
      ),
    );
    withDriveTsSeams(modulePath, sourcePath, () => expect(runCheck()).toBe(1));
  });

  test("a missing drive.ts source file fails closed", () => {
    const modulePath = fixture("healthy-module-2.ts", healthyModule);
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-drivets-e2e-missing-"),
    );
    withDriveTsSeams(modulePath, join(missingDir, "does-not-exist.ts"), () =>
      expect(runCheck()).toBe(1),
    );
  });
});

describe("outOfBandExitBindings — requires a real module for live export values", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "drive-pr-terminal-states-outofband-module-"),
  );

  test("reads all real out-of-band values from the actual lease.ts", () => {
    const path = new URL("../scripts/lib/state/lease.ts", import.meta.url)
      .pathname;
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
  test("a healthy outOfBandExitCode(...) declaration, imported from the real relative path, passes", () => {
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
      findConstantProvenanceMismatches(
        source,
        bindings,
        "lease.ts",
        "outOfBandExitCode",
        "../status/terminal-states.ts",
      ),
    ).toEqual([]);
  });

  test("a declaration reverted to a bare literal that still holds the right VALUE is still caught with the generalized params", () => {
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
    const mismatches = findConstantProvenanceMismatches(
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

  test("a decoy driverOnlyExitCode call — the WRONG helper name for this file — does not satisfy the outOfBandExitCode requirement", () => {
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
    const mismatches = findConstantProvenanceMismatches(
      source,
      bindings,
      "lease.ts",
      "outOfBandExitCode",
      "../status/terminal-states.ts",
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.constantName).toBe("SESSION_LEASE_HELD_EXIT");
  });

  test("the default params are unchanged — existing drive.ts-shaped call sites still pass with no params supplied", () => {
    const source = [
      "import { driverOnlyExitCode } from './lib/status/terminal-states.ts';",
      "export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS');",
    ].join("\n");
    const bindings = [
      { constantName: "MAX_ROUNDS_EXIT", stateName: "MAX_ROUNDS" },
    ];
    expect(findConstantProvenanceMismatches(source, bindings)).toEqual([]);
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
  test("a bare literal outside the supplied exitCodes set is NOT flagged, even though it would be under the default driver-only set", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([13])),
    ).toEqual([]);
  });

  test("a bare literal INSIDE the supplied exitCodes set is flagged", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 13;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11, 13])),
    ).toEqual([{ line: 2, value: 13, kind: "return" }]);
  });

  test("the named out-of-band constant form is NOT flagged, matching the named-constant exemption the default set already has", () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  return SESSION_LEASE_HELD_EXIT;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11, 13])),
    ).toEqual([]);
  });

  test("omitting exitCodes keeps the original default (driver-only) behavior — every existing call site is unaffected", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 6;",
      "}",
    ].join("\n");
    expect(findBareLiteralExits(source)).toEqual([
      { line: 2, value: 6, kind: "return" },
    ]);
  });

  test("the out-of-band scanned code set is DERIVED from TERMINAL_STATES, not an independent literal list — same discipline as BARE_LITERAL_EXIT_CODES", () => {
    for (const name of OUT_OF_BAND_STATE_NAMES) {
      const code = outOfBandExitCode(name);
      const source = [
        "async function main(): Promise<number> {",
        `  return ${code};`,
        "}",
      ].join("\n");
      expect(
        findBareLiteralExits(
          source,
          "drive-status.ts",
          new Set(OUT_OF_BAND_STATE_NAMES.map(outOfBandExitCode)),
        ),
      ).toEqual([{ line: 2, value: code, kind: "return" }]);
    }
  });

  test("a value no longer among the CURRENT out-of-band exit codes is still caught when it is retained in the reserved set — pins the renumber case", () => {
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
    expect(findBareLiteralExits(source, "drive-status.ts", reserved)).toEqual([
      { line: 2, value: 11, kind: "return" },
    ]);
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

describe("findBareLiteralExits — comparison and call sites, not just return", () => {
  // The finding: a future `if (bump.code === 11)` or `emit(11)` bypasses the
  // named constant exactly like a bare `return 11;` does, but the scan only
  // looked at `return` statements. These sites are code-bound in
  // `drive-status.ts`'s real out-of-band dispatch (`bump.code === X`, then
  // `emit(X)`, then `return X`), so all three must be caught independently.

  test('a `.code === <literal>` comparison is caught, with kind "comparison"', () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump.code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("the literal may appear on either side of the comparison", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (11 === bump.code) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("the named constant form in a comparison is NOT flagged — the clean shape", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a comparison against a property OTHER than `.code` is not flagged — scoped to the real dispatch shape", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump.value === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a bare-identifier comparison with no `.code` property access at all is not flagged", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (code === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a `bump['code'] === <literal>` element-access comparison is caught too — a behavior-preserving rewrite of the dot-access shape", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump['code'] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test("a template-literal element access (`bump[`code`]`) is caught the same way", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump[`code`] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "comparison" }]);
  });

  test('an element access for a key OTHER than "code" is not flagged', () => {
    const source = [
      "async function main(): Promise<number> {",
      "  if (bump['value'] === 11) {",
      "    return 0;",
      "  }",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a computed element access through an intermediate variable is NOT resolved — a documented residual, not a regression", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a local extraction of the `.code` access into its own variable is still caught — a behavior-preserving rewrite of the property-access shape", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("the local-extraction alias is caught for the element-access spelling too", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("an alias of a property OTHER than `.code` is NOT mistaken for one", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a reassigned `.code` alias is still resolved off its own declaration initializer, not the later write — a documented residual, not a regression", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "comparison" }]);
  });

  test("the computed-element-access-through-a-variable residual survives the alias-following fix — still out of scope", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test('an `emit(<literal>)` call is caught, with kind "call"', () => {
    const source = [
      "async function main(): Promise<number> {",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 2, value: 11, kind: "call" }]);
  });

  test("the named constant form in an emit() call is NOT flagged — the clean shape", () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  await emit(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a call to a differently-named, UNDECLARED function is not mistaken for emit() — the textual-fallback rescue only, never reachable on real corpus", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an alias of `emit` is still caught — a behavior-preserving rename evading identifier-text matching", () => {
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  const report = emit;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("an alias of a differently-named but DECLARED local function is now caught the same as an alias of emit — position, not name, identifies the reporter", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("a reassigned emit alias is still resolved off its own declaration's initializer, not the later write — a documented residual, not a regression", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 6, value: 11, kind: "call" }]);
  });

  test("all three shapes in one function are each reported independently", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
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

  test("a correctly paired call site is not flagged — the clean shape", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a call site naming the WRONG sibling state for its enclosing comparison is caught", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
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

  test("the mismatch is caught in either direction — the other sibling swapped the other way", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
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

  test("multiple correctly paired sites side by side are all clean", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("an outOfBand() call with no enclosing .code comparison is silently out of scope — nothing to anchor the check against", () => {
    const source = [
      IMPORTS,
      "async function main(): Promise<number> {",
      "  const code = outOfBand(report, 'SESSION_LEASE_HELD', 'reason');",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a comparison against a property OTHER than `.code` is not treated as a dispatch — no anchor, no mismatch reported", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a `!==` comparison is out of scope by design — it dispatches on absence, not presence, of the state", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a same-named outOfBand() decoy imported from elsewhere is not treated as the real helper", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("a same-named comparison identifier imported from elsewhere is not treated as the real exit constant", () => {
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
      findOutOfBandNamePairingMismatches(source, "drive-status.ts"),
    ).toEqual([]);
  });

  test("the real repo corpus: the shipped drive-status.ts has zero outOfBand() name-pairing mismatches", () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    expect(
      findOutOfBandNamePairingMismatches(realSource, driveStatusTsSourcePath()),
    ).toEqual([]);
  });

  test("the real repo corpus: swapping a real outOfBand() call site to the sibling state, inside an unchanged comparison branch, is caught (the exact mutation this issue exists to catch)", () => {
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
    const found = findOutOfBandNamePairingMismatches(
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

  test("the real repo corpus: the sibling PR-wide admission preflight site is caught the same way", () => {
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
    const found = findOutOfBandNamePairingMismatches(
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

describe("scanOutOfBandNamePairings — candidateCount/anchoredCount coverage cross-check", () => {
  const IMPORTS = [
    "import { DRIVE_HELD_ELSEWHERE_EXIT, SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
    "import { outOfBand } from './lib/status/terminal-states.ts';",
  ].join("\n");

  test("a correctly paired call site anchors — candidateCount equals anchoredCount", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("no outOfBand() calls at all is vacuously clean — 0 candidates, 0 anchored", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  return 0;",
      "}",
    ].join("\n");
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call nested inside a NON-dispatch inner `if`, itself nested inside the real dispatch, still anchors to the outer dispatch — the exact false negative found in review", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("a call moved into the dispatch's own `else` branch does not anchor — candidateCount outruns anchoredCount", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call behind a `switch (x.code)` dispatch does not anchor — this scan only recognizes `if`", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a call behind an early-return guard does not anchor — the call sits outside any `if`'s thenStatement at all", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a nested REAL dispatch anchors to its own innermost comparison, not the outer one it also sits inside of", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a `outOfBand()` mention inside a COMMENT is not counted as a candidate — this is an AST scan, not a textual one", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("the real repo corpus: candidateCount equals anchoredCount equals 5, with zero mismatches", () => {
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    expect(
      scanOutOfBandNamePairings(realSource, driveStatusTsSourcePath()),
    ).toEqual({ candidateCount: 5, anchoredCount: 5, mismatches: [] });
  });

  test("the real repo corpus: moving a real call site into its dispatch's own `else` branch drops anchoredCount below candidateCount", () => {
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
    const result = scanOutOfBandNamePairings(
      mutated,
      driveStatusTsSourcePath(),
    );
    expect(result.candidateCount).toBe(5);
    expect(result.anchoredCount).toBe(4);
    expect(result.anchoredCount).toBeLessThan(result.candidateCount);
  });

  test("a renaming import alias of the REAL helper is still counted as a candidate and its wrong state name is caught — the local identifier text is irrelevant", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("a local CONST REBIND of the real helper is still counted as a candidate and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("a two-hop CONST REBIND chain is followed the same way resolveIdentifierLiteral follows one for numeric literals", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a call wrapped in redundant parens — `(outOfBand)(…)` — still anchors (transparent expression wrappers are normalized)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a callee wrapped in an `as` type assertion — `(outOfBand as typeof outOfBand)(…)` — still anchors", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test("a mutable (`let`) rebind is NOT trusted as provenance — a later reassignment must not still anchor through the stale initial import — but IS now an AMBIGUOUS candidate rather than silently excluded", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a NAMESPACE-QUALIFIED call to the real helper (`terminalStates.outOfBand(…)`) is still counted as a candidate and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("an ELEMENT-ACCESS call to the real helper (`terminalStates['outOfBand'](…)`) still anchors and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("an ELEMENT-ACCESS call keyed by a CONST identifier resolving to 'outOfBand' (`const key = 'outOfBand' as const; terminalStates[key](…)`) still anchors and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("an ELEMENT-ACCESS key bound WITHOUT `as const` (`const key = 'outOfBand'; terminalStates[key](…)`) still resolves — the census reads the initializer's syntax, not the checker's widened `string` type", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 1,
      mismatches: [],
    });
  });

  test('an ELEMENT-ACCESS key naming something OTHER than "outOfBand" through a const chain is not treated as a candidate', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a mutable (`let`) ELEMENT-ACCESS key is NOT trusted as provenance, but is now an AMBIGUOUS candidate rather than silently excluded (a mutable let key can invoke the real helper while both candidate and anchor counts remain zero)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("an UNRESOLVABLE identifier ELEMENT-ACCESS key — a function parameter, with no initializer to trace at all — is likewise an AMBIGUOUS candidate on the real helper namespace (`function f(key: keyof typeof terminalStates) { terminalStates[key](report, ...) }` can invoke the real helper while both candidate and anchor counts remain zero)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a GENUINELY dynamic ELEMENT-ACCESS key (a function call) on the REAL helper namespace is an AMBIGUOUS candidate that never anchors — fails closed instead of vanishing from the census (accepting this shape as a 0/0 residual lets a mutated state-name argument through it pass runCheck() vacuously)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a mutated state-name argument through that same dynamic-key shape is STILL not silently accepted — candidateCount stays ahead of anchoredCount regardless of what the call actually names (the exact mutation a 0/0 residual would let pass vacuously)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a GENUINELY dynamic ELEMENT-ACCESS key on a DECOY object (not the real helper namespace) is NOT counted as an ambiguous candidate — the fail-closed check stays scoped to the real import, mirroring the decoy exclusions elsewhere in this suite", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a TEMPLATE LITERAL with interpolation as the ELEMENT-ACCESS key is likewise an ambiguous candidate on the real helper namespace — the fail-closed check is not scoped to call-expression keys alone", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a local CONST REBIND of a genuinely dynamic ELEMENT-ACCESS callee (`const alias = terminalStates[computeKey()]; alias(…)`) is likewise an AMBIGUOUS candidate, not invisible to the census (missing it leaves 0/0 counts that let the wrong sibling state pass)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a local CONST REBIND of a namespace-qualified callee (`const alias = terminalStates.outOfBand; alias(…)`) still anchors and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("a DESTRUCTURED rebind of a namespace-qualified callee (`const { outOfBand: alias } = terminalStates; alias(…)`) still anchors and its wrong state name is caught", () => {
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
    const result = scanOutOfBandNamePairings(source, "drive-status.ts");
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

  test("a DESTRUCTURED rebind from an UNRELATED module with its own `outOfBand` property is not treated as the real helper", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a namespace import of an UNRELATED module with its own `.outOfBand` property is not treated as the real helper", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a property access naming something OTHER than `outOfBand` is not treated as a candidate, even on the real namespace import", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a same-named outOfBand decoy imported from elsewhere is excluded from the coverage census entirely — candidateCount stays 0, not just mismatches staying empty", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by ASSIGNMENT rather than its own initializer, then called on a genuinely dynamic key (`let alias: typeof terminalStates.outOfBand; alias = terminalStates[computeKey()]; alias(...)`), is an AMBIGUOUS candidate, not invisible to the census (it has no declaration initializer, so an initializer-only census misses it)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let`-REASSIGNED namespace alias, then called on a genuinely dynamic key (`let ns = decoyModule; ns = terminalStates; ns[computeKey()](...)`), is an AMBIGUOUS candidate", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias assigned DIRECTLY to the real `outOfBand` import — no member access at all (`let alias; alias = outOfBand; alias(...)`) — is an AMBIGUOUS candidate, not invisible to the census (its declaration is an ImportSpecifier, not a VariableDeclaration)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias assigned to a DEFINITE `.outOfBand` PROPERTY ACCESS on the real namespace (`let alias; alias = terminalStates.outOfBand; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (a property access that is neither an ambiguous dynamic element access nor an identifier)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias assigned DIRECTLY to a same-named `outOfBand` DECOY import (not the real helper) produces no candidate at all — the direct-import reach stays scoped to the real import, mirroring the decoy exclusions elsewhere in this suite", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a COMPOUND LOGICAL ASSIGNMENT to the real `outOfBand` import (`let alias; alias ??= outOfBand; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (an assignment census recording only `identifier = rhs` ignores `alias ??= outOfBand`)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a COMPOUND LOGICAL ASSIGNMENT to a same-named `outOfBand` DECOY import produces no candidate at all — mirrors the direct-import decoy guard for the compound-operator shape", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an OBJECT-DESTRUCTURING ASSIGNMENT off the real helper namespace (`let alias; ({ outOfBand: alias } = terminalStates); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an OBJECT-DESTRUCTURING ASSIGNMENT off an UNRELATED decoy module with its own `outOfBand` property produces no candidate at all — mirrors the destructuring-declaration decoy guard for the assignment-pattern shape", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a SHORTHAND object-destructuring assignment off the real helper namespace (`let outOfBand; ({ outOfBand } = terminalStates); outOfBand(...)`) is an AMBIGUOUS candidate too", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias assigned only to an UNRELATED decoy, never to the real helper namespace, produces no candidate at all", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a COMPUTED-KEY object-destructuring assignment off the real helper namespace (`let alias; ({ ['outOfBand']: alias } = terminalStates); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (left unsupported, `candidateCount` and `anchoredCount` would both remain zero)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a COMPUTED-KEY object-destructuring assignment off an UNRELATED decoy module produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an ARRAY-PATTERN destructuring assignment off the real helper (`let alias; [alias] = [terminalStates.outOfBand]; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an ARRAY-PATTERN destructuring assignment off an UNRELATED decoy value produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a CONDITIONAL (ternary) expression naming the real helper in one branch (`alias = flag ? outOfBand : decoy; alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (the ambiguity walker traces the conditional expression it collected as a value)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a CONDITIONAL expression naming only UNRELATED decoys in both branches produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a LOGICAL (`??`) expression naming the real helper in the fallback operand is an AMBIGUOUS candidate too — composingExpressionLeaves covers `||`/`&&`/`??`, not just `?:`", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a direct COMMA-EXPRESSION callee naming the real helper as its right operand (`(sideEffect(), outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census (`composingExpressionLeaves()` expands `CommaToken`)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct COMMA-EXPRESSION callee naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a direct PLAIN-ASSIGNMENT callee naming the real helper as its right operand (`(alias = outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate (the assignment-expression form one operator over from the comma)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct PLAIN-ASSIGNMENT callee naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct callee using each LOGICAL COMPOUND-ASSIGNMENT operator (`??=`, `||=`, `&&=`) naming the real helper as its right operand is an AMBIGUOUS candidate — closing the full closed family alongside the plain-`=` form", () => {
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
      expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
        candidateCount: 1,
        anchoredCount: 0,
        mismatches: [],
      });
    }
  });

  test("a direct callee using a LOGICAL COMPOUND-ASSIGNMENT operator naming an UNRELATED decoy as its right operand produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a direct AWAIT-EXPRESSION callee naming the real helper (`(await outOfBand)(report, "X", reason)`) is an AMBIGUOUS candidate (an AwaitExpression is not an opaque leaf)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct AWAIT-EXPRESSION callee naming an UNRELATED decoy produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a direct callee producing its value by RETURNING ONE OF ITS OWN ARGUMENTS (`(await Promise.resolve(outOfBand))(report, "X", reason)`) is an AMBIGUOUS candidate (the call arguments are checked, not only its callee)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct callee whose produced value comes from a call passed only an UNRELATED decoy argument produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an OBJECT-LITERAL right-hand side whose OWN property is the real helper (`({ x: alias } = { x: outOfBand }); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (the ambiguity walkers descend into object-literal values)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by an OBJECT-LITERAL right-hand side whose own property is an UNRELATED decoy produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias reached through a NON-LITERAL array container one more `const` away (`const helpers = [outOfBand]; [alias] = helpers; alias(...)`) is an AMBIGUOUS candidate", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias reached through a non-literal array container of only UNRELATED decoys produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a destructuring DEFAULT naming the real helper (`({ x: alias = outOfBand } = decoy); alias(...)`) is an AMBIGUOUS candidate regardless of what the source object is (the value never depends on the destructured right-hand side)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a destructuring default naming only an UNRELATED decoy produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("an ARRAY-PATTERN destructuring default naming the real helper (`[alias = outOfBand] = decoyArray; alias(...)`) is an AMBIGUOUS candidate too", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a CALL to a LOCALLY DECLARED function whose body returns the real helper (`function getHelper() { return outOfBand; } let alias; alias = getHelper(); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (otherwise the later call contributes neither a candidate nor an anchor)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `let` alias populated by a call to a locally declared function returning only an UNRELATED decoy produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a further hop of indirection between the call and the function — `const indirect = getHelper; let alias; alias = indirect(); alias(...)` — is still an AMBIGUOUS candidate (a legal alias must not defeat it)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 2,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("the same further-hop chain reaching only an UNRELATED decoy produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a STATIC CLASS METHOD returning the real helper (`class Factory { static getHelper() { return outOfBand; } } let alias; alias = Factory.getHelper(); alias(...)`) is an AMBIGUOUS candidate, not invisible to the census (a MethodDeclaration body is inspected too)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a static class method returning only an UNRELATED decoy produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("mutual recursion between two locally declared helper functions does not hang the scan (seen-guard)", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a DIRECT CALL through a locally returned helper — no intervening alias at all (`function getHelper() { return outOfBand; } getHelper()(report, "X", reason)`) — is an AMBIGUOUS candidate, not invisible to the census (the outer callee is itself a CallExpression, which strict provenance rejects)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("one further hop of indirection before the direct double-call (`const indirect = getHelper; indirect()(...)`) is still an AMBIGUOUS candidate — the CallExpression-callee branch composes with the pre-existing arbitrary-alias-depth walk", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 2,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a direct call through a locally returned UNRELATED decoy (`function getHelper() { return decoy; } getHelper()(...)`) produces no candidate at all — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a SINGLE, non-doubled call to a locally declared function that merely RETURNS the real helper (`function getHelper() { return outOfBand; } getHelper(report, "X", reason)`) produces no candidate — calling getHelper once executes its own body and returns outOfBand, it does not invoke outOfBand; guards against an over-broad variant (routing every non-member/non-element leaf, not just a CallExpression one, through containsRealHelperReference)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a `.outOfBand` MEMBER access through a locally returned real NAMESPACE object (`function getNamespace() { return terminalStates; } getNamespace().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census (the object side is a CallExpression, not an identifier; requiring an identifier lets runCheck() pass vacuously)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `.outOfBand` member access through a locally returned UNRELATED decoy object (`function getNamespace() { return decoy; } getNamespace().outOfBand(...)`) produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a computed ELEMENT access on a locally returned real NAMESPACE object (`function getNamespace() { return terminalStates; } getNamespace()[computeKey()](...)`) is an AMBIGUOUS candidate — the sibling isAmbiguousOutOfBandElementAccess object check needs the same non-identifier handling as isAmbiguousOutOfBandCallee", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a `.outOfBand` member access on a CLASS INSTANCE whose own property aliases the real helper (`class Holder { outOfBand = outOfBand } new Holder().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census — the object never reaches the real NAMESPACE at all, only the PROPERTY itself does (the walk inspects the PropertyDeclaration initializer rather than stopping at the ClassDeclaration)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `.outOfBand` member access on a class instance whose own property is an UNRELATED decoy (`class Holder { outOfBand = decoy }`) produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a `.outOfBand` member access on a class instance whose own property is a METHOD that merely RETURNS the real helper (`class Holder { outOfBand(...args) { return outOfBand; } } new Holder().outOfBand(report, "X", reason)`) produces no candidate — calling the method once executes its own body and returns outOfBand, it does not invoke outOfBand; the member equivalent of the single-call guard (at runtime this call invokes only `Holder.outOfBand`, not the returned function)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test('a `.outOfBand` member access on a class instance whose own property is a GETTER that returns the real helper (`class Holder { get outOfBand(): typeof outOfBand { return outOfBand; } } new Holder().outOfBand(report, "X", reason)`) is an AMBIGUOUS candidate, not invisible to the census — accessing the getter runs its body and produces the real helper before the call syntax is even reached, unlike a plain method (the property symbol resolves to a `GetAccessorDeclaration`)', () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 1,
      anchoredCount: 0,
      mismatches: [],
    });
  });

  test("a `.outOfBand` member access on a class instance whose own property is a GETTER returning an UNRELATED decoy (`class Holder { get outOfBand() { return decoy; } }`) produces no candidate — guards against over-triggering", () => {
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
    expect(scanOutOfBandNamePairings(source, "drive-status.ts")).toEqual({
      candidateCount: 0,
      anchoredCount: 0,
      mismatches: [],
    });
  });
});

describe("runCheck — the outOfBand coverage cross-check catches a real call site losing its anchor", () => {
  test("an else-branch mutation on the real drive-status.ts source fails runCheck() via the coverage cross-check, not the mismatch check", () => {
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
      expect(runCheck()).toBe(1);
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

  test("a same-named, non-imported outOfBand decoy added alongside the real corpus does NOT fail runCheck — the coverage cross-check false positive this issue exists to close", () => {
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
      expect(runCheck()).toBe(0);
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
  test("a two-hop identifier alias chain is followed to its literal — resolveIdentifierLiteral no longer stops at the first hop", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const raw = 11;",
      "  const code = raw;",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "return" }]);
  });

  test("an alias chain through a .code comparison is followed the same way", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "comparison" }]);
  });

  test("an alias chain through an emit() call is followed the same way", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 5, value: 11, kind: "call" }]);
  });

  test("an alias chain reaching the real exported named constant is still exempt at every hop — the clean shape", () => {
    const source = [
      "export const MAX_ROUNDS_EXIT = 6;",
      "async function main(): Promise<number> {",
      "  const alias = MAX_ROUNDS_EXIT;",
      "  const code = alias;",
      "  return code;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([6])),
    ).toEqual([]);
  });

  test("a same-named but UNRELATED nested `emit` function is NOT mistaken for the real dispatch emitter — a shadow, not an alias", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a nested shadow named differently from the real emit is unaffected either way — sanity check on the fixture shape", () => {
    const source = [
      "async function emit(code: number): Promise<void> {}",
      "async function main(): Promise<number> {",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("a destructured `.code` binding (`const { code } = bump`) is caught — a destructuring is a code-property access too", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("a renamed destructured `.code` binding (`const { code: alias } = bump`) is caught the same way", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "comparison" }]);
  });

  test("a destructured binding for a property OTHER than `code` is not flagged", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an array-destructured binding named `code` is NOT mistaken for a `.code` property access — positional, not a property at all", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a chained alias of a destructured `.code` binding is followed through both mechanisms together", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
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
  test("a bare-literal emit() call is caught when emit is declared inside main(), not beside it", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emit(code: number): Promise<void> {}",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("a nested shadow two levels deep from main is still rejected, even though the real emitter now has no top-level sibling", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("the real repo corpus: injecting a bare-literal comparison into the actual drive-status.ts source is caught", () => {
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
    const found = findBareLiteralExits(
      mutated,
      driveStatusTsSourcePath(),
      new Set([11]),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(
      found.some((exit) => exit.kind === "comparison" && exit.value === 11),
    ).toBe(true);
  });

  test("the real repo corpus: injecting a bare-literal comparison for the OTHER out-of-band identifier is caught too", () => {
    // Sibling of the test above, for `DRIVE_HELD_ELSEWHERE_EXIT` at the
    // PR-wide admission preflight site rather than the round-gate
    // lease bump — a distinct real call site, so this is not redundant with
    // the `SESSION_LEASE_HELD_EXIT` mutation above.
    const realSource = readFileSync(driveStatusTsSourcePath(), "utf8");
    const target = "if (admit.code === DRIVE_HELD_ELSEWHERE_EXIT) {";
    expect(realSource).toContain(target);
    const mutated = realSource.replace(target, "if (admit.code === 13) {");
    const found = findBareLiteralExits(
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

  test("a bare-literal call is still caught after renaming BOTH the declaration and its call site away from `emit`", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  await emitReport(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("the named-constant form of the renamed reporter is still NOT flagged — the clean shape survives the rename too", () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  await emitReport(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("an alias of the renamed reporter is still caught, chained alias-following unaffected by the rename", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  async function emitReport(code: number): Promise<void> {}",
      "  const report = emitReport;",
      "  await report(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 4, value: 11, kind: "call" }]);
  });

  test("a shadow two levels deep from main is still rejected even under the renamed spelling — the position bound survives the rename too", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("the real repo corpus: renaming the actual drive-status.ts reporter — declaration AND every call site — is still caught", () => {
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
    const found = findBareLiteralExits(
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

  test("a bare-literal call to an arrow-function-valued reporter is caught — a behavior-preserving rewrite away from a function declaration", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const emit = async (code: number): Promise<void> => {};",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("the named-constant form survives the arrow-function rewrite too — the clean shape", () => {
    const source = [
      "import { SESSION_LEASE_HELD_EXIT } from './lib/state/lease.ts';",
      "async function main(): Promise<number> {",
      "  const emit = async (code: number): Promise<void> => {};",
      "  await emit(SESSION_LEASE_HELD_EXIT);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });

  test("a bare-literal call to a function-expression-valued reporter is caught the same way", () => {
    const source = [
      "async function main(): Promise<number> {",
      "  const emit = async function (code: number): Promise<void> {};",
      "  await emit(11);",
      "  return 1;",
      "}",
    ].join("\n");
    expect(
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 3, value: 11, kind: "call" }]);
  });

  test("an unrelated sibling function at the exact same structural depth is not mistaken for the reporter, while a real call to the reporter still is", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([{ line: 7, value: 11, kind: "call" }]);
  });

  test("a zero-argument sibling at the same structural depth is not mistaken for the reporter either", () => {
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
      findBareLiteralExits(source, "drive-status.ts", new Set([11])),
    ).toEqual([]);
  });
});

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

  const withSeams = (paths: SeamPaths, fn: () => void): void => {
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
      fn();
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

  test("a fully healthy fixture set passes through the real runCheck() entry point", () => {
    withSeams(healthyPaths(), () => expect(runCheck()).toBe(0));
  });

  test("a mismatched lease.ts exit constant VALUE fails runCheck(), not just the pure function in isolation", () => {
    const paths = healthyPaths();
    paths.leaseTsModule = fixture(
      "mismatched-lease-module.ts",
      healthyLeaseModule.replace(
        "export const SESSION_LEASE_HELD_EXIT = 11;",
        "export const SESSION_LEASE_HELD_EXIT = 99;",
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  test("a lease.ts DECLARATION reverted to a bare literal that still holds the right VALUE fails runCheck() — the case findExitConstantMismatches alone cannot catch", () => {
    const paths = healthyPaths();
    paths.leaseTsSource = fixture(
      "provenance-lease-source.ts",
      healthyLeaseSource.replace(
        "export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD');",
        "export const SESSION_LEASE_HELD_EXIT = 11;", // reverted, but still the right value
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  test("a drive-status.ts bare-literal exit site fails runCheck(), not just the pure function in isolation", () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "return SESSION_LEASE_HELD_EXIT;",
        "return 11;",
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  // The two mutations below are the exact residual of a `return`-only scan:
  // it misses a `.code ===` comparison or an `emit(...)` call reverted to a
  // bare literal while the function's own trailing `return` still reads the
  // real constant — `healthyDriveStatusSource` above deliberately carries all
  // three shapes so each mutation below trips ONLY the clause under test.
  test("a drive-status.ts .code COMPARISON reverted to a bare literal fails runCheck(), even though the return in the same block still uses the named constant", () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-comparison-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "bump.code === SESSION_LEASE_HELD_EXIT",
        "bump.code === 11",
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  test("a drive-status.ts emit() CALL reverted to a bare literal fails runCheck(), even though the return in the same block still uses the named constant", () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "bare-literal-call-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "emit(SESSION_LEASE_HELD_EXIT)",
        "emit(11)",
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  test("a missing lease.ts source file fails closed", () => {
    const paths = healthyPaths();
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-e2e-missing-"),
    );
    paths.leaseTsSource = join(missingDir, "does-not-exist.ts");
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });

  test("a missing drive-status.ts source file fails closed", () => {
    const paths = healthyPaths();
    const missingDir = mkdtempSync(
      join(tmpdir(), "drive-pr-terminal-states-outofband-e2e-missing-2-"),
    );
    paths.driveStatusTsSource = join(missingDir, "does-not-exist.ts");
    withSeams(paths, () => expect(runCheck()).toBe(1));
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

  // Unlike the block's own `healthyDriveStatusSource` (which uses a
  // bare `emit(...)` and needs no `outOfBand()` call at all — it exercises
  // only the bare-literal scan), this fixture uses the REAL an earlier change dispatch
  // shape both real call sites use, since that is exactly what this check's
  // mutation targets.
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

  const withSeams = (paths: SeamPaths, fn: () => void): void => {
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
      fn();
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

  test("a fully healthy fixture set — using the real outOfBand() dispatch shape — passes through the real runCheck() entry point", () => {
    withSeams(healthyPaths(), () => expect(runCheck()).toBe(0));
  });

  test("an outOfBand() call NAME swapped to the wrong sibling state fails runCheck(), even though its enclosing comparison branch is unchanged", () => {
    const paths = healthyPaths();
    paths.driveStatusTsSource = fixture(
      "wrong-name-drive-status-source.ts",
      healthyDriveStatusSource.replace(
        "outOfBand(report, 'SESSION_LEASE_HELD', 'reason')",
        "outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', 'reason')",
      ),
    );
    withSeams(paths, () => expect(runCheck()).toBe(1));
  });
});
