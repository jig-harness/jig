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

import { delimiter, join } from "node:path";

import {
  closeTypeScriptService,
  findMissingRequired,
  runCheck,
} from "./terminal-states-consistency.ts";

afterAll(closeTypeScriptService);

describe("runCheck — forms that MUST be read correctly", () => {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-terminal-states-run-"));

  const corpus = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const withCorpus = async (
    entries: string[],
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const previous = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = entries.join(delimiter);
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
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

  test("drive-status-header: exit + identifier on the same line, including the two-line continuation form", async () => {
    const file = corpus("drive-status.ts", driveStatusHeaderGood);
    await withCorpus([`${file}=drive-status-header`], async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("skill-md-table: state-first column order", async () => {
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
    await withCorpus([`${file}=skill-md-table`], async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test('pipe-table-exit-first: exit-first column order, and a multi-name cell split on " / "', async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first`], async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("a bold, mixed-case, or prose cell with NO embedded backtick token is correctly SKIPPED, not misread as an identifier", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first+remap=2`], async () =>
      expect(await runCheck()).toBe(0),
    );
  });

  test("a prose cell with a canonical state named INLINE in backticks is read via the embedded form, not skipped", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first+remap=3`], async () =>
      expect(await runCheck()).toBe(0),
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
    await withCorpus([`${wrong}=pipe-table-exit-first+remap=3`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test('an annotated exit cell ("3 (`drive.ts`: 0)") is read for its PRIMARY code, not silently dropped', async () => {
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
    await withCorpus(
      [`${file}=skill-md-table=3=## Terminal states`],
      async () => expect(await runCheck()).toBe(0), // 3 pairs, including CONVERGED at its primary code 3
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
    await withCorpus(
      [`${wrong}=skill-md-table=3=## Terminal states`],
      async () => expect(await runCheck()).toBe(1),
    );
  });

  test("EXIT_CELL rejects a malformed suffix on the exit code instead of silently accepting its digit prefix", async () => {
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
      await withCorpus(
        [`${file}=pipe-table-exit-first=2=## Exit codes`],
        async () => expect(await runCheck()).toBe(1), // population floor: only HITL_PARKED's row still yields a pair
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
    await withCorpus(
      [`${clean}=pipe-table-exit-first=2=## Exit codes`],
      async () => expect(await runCheck()).toBe(0),
    );
  });

  test("CONVERGED's drive.ts remap (exit 0) is accepted ONLY in a file flagged `documentsDriveTsRemap` — every other file requires drive-status.ts's own exit 3, header included", async () => {
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
    await withCorpus([`${prose}=pipe-table-exit-first+remap`], async () =>
      expect(await runCheck()).toBe(0),
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
    await withCorpus([`${unflaggedProse}=pipe-table-exit-first`], async () =>
      expect(await runCheck()).toBe(1),
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
    await withCorpus([`${header}=drive-status-header`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("extraction is bounded to the named heading’s section — an unrelated table elsewhere in the same file is ignored", async () => {
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
    await withCorpus(
      [`${file}=pipe-table-exit-first=3=## The drive's terminal states`],
      async () => expect(await runCheck()).toBe(0),
    );
  });

  test("a heading that matches nothing fails CLOSED via the population floor, not silently to a full-file scan", async () => {
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
    await withCorpus(
      [`${file}=pipe-table-exit-first=1=## A heading that does not exist`],
      async () => expect(await runCheck()).toBe(1),
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

  const withCorpus = async (
    entries: string[],
    fn: () => Promise<void> | void,
  ): Promise<void> => {
    const previous = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = entries.join(delimiter);
    const error = console.error;
    const log = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.log = log;
      if (previous === undefined)
        delete process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
      else process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES = previous;
    }
  };

  test("fails when a doc states the WRONG exit code for a real state (the develop/PR_CONFLICTING shape)", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("fails when a doc names a state that does not exist at all", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("CONVERGED's drive.ts remap (0) is accepted in a `+remap`-flagged file — its raw drive-status.ts exit (3) is NOT, there", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first+remap`], async () =>
      expect(await runCheck()).toBe(0),
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
    await withCorpus(
      [`${rawInFlagged}=pipe-table-exit-first+remap`],
      async () => expect(await runCheck()).toBe(1),
    );
  });

  test("but CONVERGED at any OTHER wrong exit is still caught — additionalExitCodes is not a wildcard", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first+remap`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("fails on the population floor — a table reformatted past what the extractor recognizes must not read as clean", async () => {
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
    await withCorpus([`${file}=pipe-table-exit-first`], async () =>
      expect(await runCheck()).toBe(1),
    );
  });

  test("fails when a corpus file does not exist", async () => {
    await withCorpus(
      [`${join(dir, "was-renamed-away.md")}=pipe-table-exit-first`],
      async () => expect(await runCheck()).toBe(1),
    );
  });

  test("a healthy file does not mask a silent or broken sibling", async () => {
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
    await withCorpus(
      [`${healthy}=pipe-table-exit-first`, `${broken}=pipe-table-exit-first`],
      async () => expect(await runCheck()).toBe(1),
    );
  });
});

describe("runCheck — the real repo corpus", () => {
  // The end-to-end guarantee: the actual, checked-in corpus (drive-status.ts,
  // SKILL.md, terminal-states.md and README.md — see CORPUS_FILES) is
  // self-consistent today. A future edit to any of them that
  // documents a pair TERMINAL_STATES does not contain fails THIS test, not
  // just the fixture-driven ones above.
  test("the shipped corpus is drift-free", async () => {
    expect(await runCheck()).toBe(0);
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
