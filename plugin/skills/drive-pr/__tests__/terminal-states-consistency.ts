#!/usr/bin/env bun
/**
 * drive-pr terminal-state ↔ exit-code drift check, across the prose corpus,
 * `drive.ts` itself, `drive-status.ts`'s own out-of-band sites and
 * `lib/state/lease.ts`.
 *
 * `<skill-dir>/scripts/lib/status/terminal-states.ts`'s
 * `TERMINAL_STATES` const is now the single source of truth for which
 * `state` name pairs with which exit code (`evaluate.ts`'s own sites are
 * bound to it in code — see that module's header for why the site count is
 * not restated here). The prose restatements are not, and were never going
 * to be: `drive-status.ts`'s own "Exit codes"
 * doc comment, `SKILL.md` § Terminal states, `references/terminal-states.md`
 * § Exit codes and `README.md`'s exit table each restate a subset of
 * the same pairing by hand, with nothing to keep any of them in step with
 * the code or with each other.
 *
 * This is a RUNG-2 check (freshness ladder: drop / derive-at-render · CI check
 * that commits nothing · commit a generated artifact) — it re-derives the
 * canonical (exitCode, stateName) set from `TERMINAL_STATES` and scans each
 * prose file for a row that states a DIFFERENT pairing than the table
 * carries. Nothing is written to disk; a materialised `_generated/` table
 * would still manufacture merge conflicts on the repo's highest-churn
 * subsystem, which is exactly the
 * class of churn this check exists to police without adding to.
 *
 * WHAT THIS DOES NOT DO (a scanning gate states its own scope): it
 * derives a STRUCTURAL fact (does a documented pair exist in the code's own
 * table), never whether the surrounding PROSE is accurate. A row can state a
 * real, correct pair and still be a stale or misleading sentence; this check
 * has nothing to say about that.
 *
 * EXTRACTION STRATEGY (parse or pin: a hand-rolled recognizer over
 * independently-styled prose tables is defeated by each new decoy shape in
 * turn).
 * There is no shared machine-readable format to parse here — four Markdown
 * pipe tables, each styled differently by whoever wrote it, plus one doc
 * comment that isn't a table at all — so each is PINNED to its own known
 * row shape rather than driven through one generic table parser that would
 * have to guess column order and cell styling per file. What is shared, and
 * genuinely generic, is the "is this cell a bare state identifier" test,
 * applied two ways: (1) strip `**`/backtick wrapping, split multi-name
 * cells on ` / `, and keep only tokens that are the WHOLE (trimmed) cell
 * content, matching `^[A-Z][A-Z0-9_]*$`; (2) independently, pull out every
 * `` `IDENT` `` backtick span embedded ANYWHERE in the cell, matching the
 * same pattern — this is what lets a human-prose row (`README.md`'s
 * own style) still be checked once it names its canonical state inline, e.g.
 * "**PR not open** (`PR_NOT_OPEN`)". A cell with NEITHER a whole-cell
 * identifier nor an embedded backtick span — "PR not open" alone, or
 * "**Stalled**" alone — is prose describing the row with nothing to check,
 * and is silently skipped rather than guessed at — the same "prefer omission
 * over hand-maintained approximation" instinct the repository applies to
 * counts, applied here to extraction. Driver-only states
 * (`MAX_ROUNDS`, `STALLED`, `WORKTREE_UNCLEAN`, `SINGLE_INSTANCE_LOCK`) and
 * the `RETIRED` tombstone are deliberately left un-annotated in the
 * human-facing docs today, matching the convention `references/
 * terminal-states.md` already uses (a bare `—` for these rows): the
 * driver-only ones produce no `--json` report at all, and the tombstone is
 * never emitted, so naming either here would be more precision than the
 * underlying data actually has. `SESSION_LEASE_HELD` is un-annotated in
 * those same docs too, but for a DIFFERENT reason, not this one — checked
 * against `terminal-states.ts`: its category is `state`, not `driver-only`;
 * it IS a real value `report.state` carries, set outside `evaluate` at
 * `drive-status.ts`'s own round-gate lease bump, and it CAN appear in the
 * `--json` report. It stays un-annotated in the human-facing prose docs
 * today, even though the code-level checks below do bind it in code.
 *
 * Below the prose-corpus check are TWO code-level checks, over real files
 * rather than prose about them:
 *
 *   `drive.ts` exports a named constant for each of its
 *   driver-only exits, each one derived via `terminal-states.ts`'s own
 *   `driverOnlyExitCode('<NAME>')` rather than an independent literal —
 *   `findExitConstantMismatches`, `findConstantProvenanceMismatches`, and
 *   `findBareLiteralExits` below verify that binding against the REAL file,
 *   not prose about it. See their own doc comments for the distinct
 *   regressions each one closes.
 *
 *   The same binding covers `drive-status.ts`'s non-`evaluate` sites.
 *   `lib/state/lease.ts` exports `SESSION_LEASE_HELD_EXIT`
 *   and `DRIVE_HELD_ELSEWHERE_EXIT`, both derived via `terminal-states.ts`'s
 *   `outOfBandExitCode('<NAME>')` — the `driverOnlyExitCode` sibling for the
 *   two `state`-category entries `drive-status.ts` sets OUTSIDE `evaluate`
 *   — and `drive-status.ts` imports both rather than hand-writing `11`/`13`
 *   at its `case 0` sites and at its own PR-wide admission preflight. The
 *   same three functions used for
 *   `drive.ts` above are reused here, generalized to accept a helper-function
 *   name, its expected import specifier, and the exit-code set to scan for —
 *   see `OUT_OF_BAND_EXIT_NAMES` and its own call sites in `runCheck`
 *   below. Deliberately NOT extended to `lib/state/lease.ts`'s OWN internal
 *   per-tree `fail(11, ...)` refusal sites (`assertNoForeignDrive` and
 *   siblings): those are a `fail` call argument, not a `return` statement,
 *   at every one of those sites, a differently-shaped check these scans do
 *   not cover.
 *
 *   `drive-status.ts` routes `report.state` and the emitted/returned exit
 *   code for an out-of-band state through ONE
 *   `outOfBand(report, name, reason)` lookup, so
 *   the two cannot be written to disagree with EACH OTHER. That says
 *   nothing about whether `name` is the RIGHT one for the branch calling
 *   it — `outOfBand(report, 'SESSION_LEASE_HELD', ...)` compiles and keeps
 *   `report.state`/the exit code internally coherent even inside an
 *   `if (bump.code === DRIVE_HELD_ELSEWHERE_EXIT)` block, which is still a
 *   real misclassification the checks above cannot see (none of them ever
 *   inspects an `outOfBand` call's own arguments).
 *   `findOutOfBandNamePairingMismatches` below closes that gap: for every
 *   `outOfBand(report, 'NAME', ...)` call inside an `if (X.code === IDENT)`
 *   block in `drive-status.ts`, it verifies `outOfBandExitCode('NAME')` —
 *   the state the call actually reports — matches `IDENT`'s own resolved
 *   value — the state the enclosing comparison dispatched on. Reuses
 *   `resolvesToCodePropertyAccess` (the `.code` side) and the same
 *   import-resolution discipline `isExitCodeHelperCall` already applies to
 *   `driverOnlyExitCode`/`outOfBandExitCode` (symbol-resolved, never
 *   name-text matched).
 *
 * Exit codes:
 *   0 — every documented (exit, state) pair in the prose corpus matches a
 *       TERMINAL_STATES entry, drive.ts's own driver-only exit constants
 *       still read from it with no bare-literal regression, lease.ts's/
 *       drive-status.ts's own out-of-band exit constants and call sites do
 *       too, AND every drive-status.ts `outOfBand` call names the state its
 *       own enclosing comparison actually dispatched on
 *   1 — a prose file states a pair the table does not contain, a file in the
 *       corpus could not be read at all, a drive.ts or lease.ts exit constant
 *       no longer equals its TERMINAL_STATES entry (or is no longer bound via
 *       its helper function), drive.ts/drive-status.ts contains a bare
 *       exit-code literal that bypasses its named constant, or a
 *       drive-status.ts `outOfBand` call names a different state than the
 *       one its enclosing `.code === IDENT` comparison dispatched on
 *
 * Test seam (never set in prod):
 *   DRIVE_PR_TERMINAL_STATES_TEST_FILES  colon-separated `path=role` pairs
 *     (role is one of the CORPUS_FILES keys below) to scan instead of the
 *     real corpus. The `terminal-states*.test.ts` suites drive
 *     `runCheck` through it.
 *   DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED  companion to the above (see
 *     `testRequiredIdentifiers`): a `;`-separated identifier list applied
 *     as `requiredIdentifiers` to every entry the above produces, so the
 *     `requiredIdentifiers` completeness check is reachable end to end on a
 *     synthetic fixture too, not only against the real corpus.
 *   DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE  path `require`d instead
 *     of the real drive.ts for the exit-constant values (see
 *     `driverOnlyExitBindings`).
 *   DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE  path read as raw text
 *     instead of the real drive.ts for the AST-based checks (see
 *     `findConstantProvenanceMismatches`, `findBareLiteralExits`). Separate
 *     from the module seam above because loading drive.ts as a module (for
 *     its live export values) and reading it as raw text (for an AST scan)
 *     are different things a test may need to fake independently.
 *   DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE /
 *   DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE  the same module/source
 *     split as the two above, for `lib/state/lease.ts`'s own out-of-band exit
 *     constants.
 *   DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE  path read as raw
 *     text instead of the real drive-status.ts for its own bare-literal AST
 *     scan — drive-status.ts only CONSUMES the out-of-band
 *     constants, never declares them, so it needs no module-require seam,
 *     only a source seam.
 */

import { driverSourceFiles } from "./terminal-state-source-files.ts";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, relative, resolve } from "node:path";
import * as ts from "typescript/unstable/ast";
import {
  API,
  type Symbol as CheckerSymbol,
  type NodeHandle,
} from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import {
  type DriverOnlyStateName,
  driverOnlyExitCode,
  type OutOfBandStateName,
  outOfBandExitCode,
  TERMINAL_STATES,
} from "../scripts/lib/status/terminal-states.ts";

const SKILL_ROOT = resolve(import.meta.dir, "..");

export type CorpusRole =
  | "drive-status-header"
  | "skill-md-table"
  | "pipe-table-exit-first";

export interface CorpusFile {
  readonly path: string;
  readonly role: CorpusRole;
  /**
   * Population floor for THIS file (a scan that finds too few pairs fails
   * rather than passing vacuously).
   * Defaults to `DEFAULT_MIN_PAIRS` for a file whose table is built out of
   * bare state identifiers; `README.md`'s table is deliberately
   * human-prose ("what you do now" — see its own section heading)
   * and only NAMES its canonical state inline (see EXTRACTION STRATEGY
   * above) for the rows that document a real, `evaluate.ts`-bound state or
   * class label — the driver-only rows stay unannotated, matching
   * `references/terminal-states.md`'s own convention — so its floor is set
   * to match what a healthy scan of THAT file actually finds, not lowered
   * globally and weakening the check everywhere else.
   *
   * A LOWER BOUND ONLY — it catches a table reformatted into nothing this
   * extractor recognizes, but not a single real row silently disappearing
   * (renamed, deleted, turned into unrecognized prose) while the file's
   * total row count stays at or above this number: on the real corpus
   * today every file's true population is `requiredIdentifiers.length`,
   * which is `>=` this floor for every real entry below, so there is slack
   * to lose a row into and still clear it (measured: 2 rows' worth of slack
   * on the header, 1 on `references/terminal-states.md`).
   * `requiredIdentifiers` below is what actually closes that gap; this field
   * stays as the cheap belt-and-suspenders population floor, and as
   * the ONLY completeness check a `DRIVE_PR_TERMINAL_STATES_TEST_FILES`
   * fixture gets unless it also sets the companion
   * `DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED` env var (see
   * `testRequiredIdentifiers`).
   */
  readonly minPairs?: number;
  /**
   * The EXACT set of state/class-label identifiers this file is expected to
   * document — every one of them must survive extraction, not merely enough
   * pairs to clear `minPairs`. This is the fix for the gap `minPairs` alone
   * leaves open (see its own doc comment): a row that silently vanishes
   * while the file's total count stays above the floor is invisible to a
   * count-only check but not to a set-membership one. Pinned verbatim
   * against each file's own current,
   * known-good content — computed once by running the real extractor over
   * the real file and reading back its output, not re-derived from
   * `TERMINAL_STATES` by a formula, because which subset of the vocabulary
   * each file chooses to document is a per-file editorial decision (e.g.
   * `SKILL.md` names `PASS_DEADLINE`/`QUOTA_PARKED` despite them being
   * `driver-only`, while `README.md` does not) that no formula can
   * safely re-derive without guessing at intent. `undefined` on every real
   * `CORPUS_FILES` entry means "skip this check for this file" — never true
   * for a real entry today, since every one below sets it. A
   * `DRIVE_PR_TERMINAL_STATES_TEST_FILES` fixture leaves it unset too UNLESS
   * the companion `DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED` env var is also
   * set (see `testRequiredIdentifiers()`) — that is how
   * `terminal-states-required-identifiers.test.ts` exercises this check end to end
   * through `runCheck()`, on a synthetic fixture, without touching the real
   * corpus files at all.
   */
  readonly requiredIdentifiers?: readonly string[];
  /**
   * Bound a pipe-table extraction to the SECTION starting at this exact
   * (trimmed) heading line, up to the next level-2 (`## `) heading or EOF.
   * Without a bound, `extractPipeTable` scans every pipe-table row in the
   * whole file — an unrelated table elsewhere in the same file whose first
   * cells are bare small numbers could gain a row pairing a number with an
   * ALL-CAPS token, which would be silently absorbed as a false pair. Unused
   * by `drive-status-header`, whose own regex already only matches the doc
   * comment's tightly-aligned rows and needs no section bound.
   */
  readonly heading?: string;
  /**
   * This file/section documents `drive.ts`'s OWN operator-facing exit for a
   * state `drive.ts` remaps (today only `CONVERGED`, which `drive-status.ts`
   * itself exits `3` for but `drive.ts` remaps to `0` — see
   * `TERMINAL_STATES.CONVERGED.additionalExitCodes`'s own doc comment).
   * `README.md` is an operator-facing doc that shows ONLY the remapped
   * code for such a state, never `drive-status.ts`'s raw one — so for it
   * `runCheck` validates against `additionalExitCodes` (falling back to
   * `exitCode` for every state that has none). Every OTHER file
   * (`drive-status.ts`'s own header, `SKILL.md`, `references/
   * terminal-states.md`) documents `drive-status.ts`'s own contract — for
   * those, `runCheck` is STRICT: only the bare `exitCode` is valid, so a
   * remapped state's PRIMARY cell must still carry `drive-status.ts`'s own
   * exit (an annotation naming the remap, like SKILL.md's own
   * `` 3 (`drive.ts`: 0) ``, does not change what the PRIMARY code must be —
   * `EXIT_CELL` reads only the primary code, never the annotation). Leaving
   * this false (the default) is what catches a corrupted `CONVERGED` row
   * whose primary cell was accidentally replaced by the bare remapped value
   * with the annotation dropped — the exact defect this field exists to
   * catch.
   */
  readonly documentsDriveTsRemap?: boolean;
}

const DEFAULT_MIN_PAIRS = 3;

interface Section {
  readonly text: string;
  /** How many lines were dropped from the top — added back to every
   * extracted pair's `line` so reported line numbers stay absolute (the
   * file position an editor would actually jump to), not relative to the
   * slice. */
  readonly lineOffset: number;
}

/**
 * Slice `text` down to the section beginning at the line exactly equal to
 * `heading` (trimmed), up to but excluding the next `## ` heading, or EOF.
 * Returns `text` unchanged when `heading` is undefined (no bound requested).
 * A `heading` that does not match anything (renamed, reworded) fails
 * CLOSED to an EMPTY section rather than falling back to the whole file —
 * the per-file population floor then catches it as zero pairs, loud rather
 * than a silent partial scan that happens to look plausible.
 */
function sectionText(text: string, heading: string | undefined): Section {
  if (heading === undefined) return { text, lineOffset: 0 };
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return { text: "", lineOffset: 0 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n"), lineOffset: start };
}

/**
 * The prose restatements of the exit-code pairing. Three distinct row shapes
 * cover the corpus below: `drive-status.ts` uses its own doc-comment format;
 * `SKILL.md` uses a `| State | Exit | … |` table (state column first); the
 * others use `| Exit | State | … |` (exit column first). The file count is
 * `CORPUS_FILES.length` below, not restated here: a hand-copied tally of this
 * array drifts as soon as the array changes.
 *
 * `requiredIdentifiers` on each entry is the exact, pinned set `CorpusFile`'s
 * own doc comment explains — computed by running this file's extractor
 * against the real corpus and reading back its output, not hand-counted from
 * the prose.
 */
const CORPUS_FILES: readonly CorpusFile[] = [
  {
    path: "scripts/drive-status.ts",
    role: "drive-status-header",
    minPairs: 14,
    requiredIdentifiers: [
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
      "MAILBOX_STOPPED",
      "MAILBOX_PAUSE_TIMEOUT",
      "TAKEN_OVER",
    ],
  },
  {
    path: "SKILL.md",
    role: "skill-md-table",
    heading: "## Terminal states",
    minPairs: 6,
    requiredIdentifiers: [
      "CONVERGED",
      "PR_NOT_OPEN",
      "HITL_PARKED",
      "PR_CONFLICTING",
      "PASS_DEADLINE",
      "QUOTA_PARKED",
      "MAILBOX_STOPPED",
      "MAILBOX_PAUSE_TIMEOUT",
      "TAKEN_OVER",
    ],
  },
  {
    path: "references/terminal-states.md",
    role: "pipe-table-exit-first",
    heading: "## Exit codes",
    minPairs: 16,
    requiredIdentifiers: [
      "ROUND_READY",
      "CONVERGED",
      "HEAD_LAG",
      "AWAITING_REVIEWER",
      "STALE_REVIEW",
      "HEAD_MOVED",
      "MERGEABILITY_UNKNOWN",
      "PR_NOT_OPEN",
      "REVIEWER_FAILED",
      "HITL_PARKED",
      "PR_CONFLICTING",
      "DRIVE_HELD_BY_OTHER_WORKTREE",
      "INDETERMINATE",
      "PASS_DEADLINE",
      "QUOTA_PARKED",
      "MAILBOX_STOPPED",
      "MAILBOX_PAUSE_TIMEOUT",
      "TAKEN_OVER",
      "UNSUPPORTED_CLI",
    ],
  },
  {
    path: "README.md",
    role: "pipe-table-exit-first",
    heading: "## The exit states — what you do now",
    minPairs: 7,
    documentsDriveTsRemap: true,
    requiredIdentifiers: [
      "CONVERGED",
      "PR_NOT_OPEN",
      "HITL_PARKED",
      "PR_CONFLICTING",
      "NOT_SETTLED",
      "REVIEWER_FAILED",
      "DRIVE_HELD_BY_OTHER_WORKTREE",
      "MAILBOX_STOPPED",
      "MAILBOX_PAUSE_TIMEOUT",
      "TAKEN_OVER",
    ],
  },
];

export interface DocumentedPair {
  readonly file: string;
  readonly line: number;
  readonly exitCode: number;
  readonly state: string;
}

/** A cell counts as a bare state identifier only when the WHOLE trimmed,
 * unwrapped cell (or one ` / `-separated piece of it) matches this — never a
 * substring of longer prose picked up by this pattern alone. */
const BARE_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

/** A canonical state name named INLINE, anywhere in a cell, in backticks —
 * "**PR not open** (`PR_NOT_OPEN`)". Global so every embedded span in a cell
 * is found, not just the first. Deliberately independent of `BARE_IDENTIFIER`
 * being whole-cell-anchored: this is how a human-prose row (`using-drive-
 * pr.md`'s own style) still gets checked once it names its state — see
 * EXTRACTION STRATEGY above. */
const EMBEDDED_IDENTIFIER = /`([A-Z][A-Z0-9_]*)`/g;

function unwrapCell(cell: string): string {
  return cell
    .trim()
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^`(.*)`$/, "$1")
    .trim();
}

/**
 * Every state identifier a cell names, by either recognized form: a bare
 * token that IS the whole cell (or one ` / `-separated piece of it —
 * `references/terminal-states.md`'s exit-4 row), or a `` `TOKEN` `` backtick
 * span embedded anywhere in otherwise-prose text. A cell can use either form
 * exclusively or both; the result is deduplicated (a whole-cell identifier
 * that also happens to be backtick-wrapped, e.g. `` `CONVERGED` ``, would
 * otherwise be found twice).
 */
function identifierTokens(cell: string): string[] {
  const tokens = new Set<string>();
  for (const piece of cell.split("/")) {
    const tok = unwrapCell(piece);
    if (BARE_IDENTIFIER.test(tok)) tokens.add(tok);
  }
  for (const m of cell.matchAll(EMBEDDED_IDENTIFIER)) {
    if (m[1] !== undefined) tokens.add(m[1]);
  }
  return [...tokens];
}

/**
 * `drive-status.ts`'s own "Exit codes — the driver contract" doc comment:
 * ` *   9  PR_CONFLICTING   the PR conflicts with its base …`. The exit
 * number and the identifier sit on the same physical line even for the two
 * rows whose prose continues onto following lines (`SESSION_LEASE_HELD`,
 * `DRIVE_HELD_BY_OTHER_WORKTREE`), so a single-line regex is sufficient —
 * no multi-line stitching needed. Requires 2+ spaces between the number and
 * the identifier (the table's own alignment convention), which is what
 * keeps this from matching unrelated ` * 3 things` prose elsewhere in the
 * file: a real row always column-aligns its identifier this way.
 */
function extractDriveStatusHeader(
  text: string,
  file: string,
): DocumentedPair[] {
  const pairs: DocumentedPair[] = [];
  const lines = text.split("\n");
  const re = /^\s*\*\s{0,3}(\d{1,2})\s{2,}([A-Z][A-Z0-9_]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i] ?? "");
    if (m) {
      pairs.push({
        file,
        line: i + 1,
        exitCode: Number(m[1]),
        state: m[2] ?? "",
      });
    }
  }
  return pairs;
}

/** Splits a Markdown pipe-table row into trimmed cells, ignoring a leading/
 * trailing empty cell from the row's own bounding `|`s. Does not need to
 * handle an escaped `\|` — none of the corpus tables use one (verified by
 * inspection); a row that did would simply mis-split, which is caught by
 * the population floor below reading as too few valid pairs to trust. */
function splitRow(line: string): string[] {
  const cells = line.split("|");
  if (cells.length > 0 && cells[0]?.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]?.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/**
 * Matches the PRIMARY exit code, and ONLY the primary code plus the one
 * annotation shape this corpus actually uses — the code `drive-status.ts`
 * itself returns. Deliberately not whole-cell-anchored on the FRONT: `SKILL.md`'s
 * own `CONVERGED` row reads `3 (\`drive.ts\`: 0)` — the primary code (`3`)
 * followed by an annotation of `drive.ts`'s remap, not a second pairing. A
 * whole-cell anchor made that row invisible to this extractor entirely
 * — the single row this
 * whole check exists to police went unchecked. It IS anchored on the END
 * (`$`), to exactly the digit(s) or the digit(s) plus that one annotation —
 * an unanchored tail let any non-digit suffix through unexamined (`5oops`,
 * `5.5`, `` `5`garbage ``  all still captured `5`, satisfying the
 * required-identifier and population checks over a cell that no longer
 * spells a clean exit code at all) and matched the extractor's own tightened
 * intent nowhere but in its doc comment.
 */
const EXIT_CELL = /^`?(\d{1,2})`?(?:\s+\(`drive\.ts`: \d{1,2}\))?$/;

/**
 * A generic pipe-table row extractor for the two known column orders. Only
 * lines starting with `|` are candidates; the header row and the `|---|---|`
 * separator both fail `EXIT_CELL` on their first relevant cell and are
 * skipped harmlessly rather than specially cased.
 */
function extractPipeTable(
  text: string,
  file: string,
  order: "exit-first" | "state-first",
  lineOffset: number,
): DocumentedPair[] {
  const pairs: DocumentedPair[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const first = cells[0] ?? "";
    const second = cells[1] ?? "";
    const [exitCell, stateCell] =
      order === "exit-first" ? [first, second] : [second, first];
    const exitMatch = EXIT_CELL.exec(exitCell);
    if (!exitMatch) continue;
    const exitCode = Number(exitMatch[1]);
    for (const state of identifierTokens(stateCell)) {
      pairs.push({ file, line: lineOffset + i + 1, exitCode, state });
    }
  }
  return pairs;
}

function extractSkillMdTable(
  text: string,
  file: string,
  lineOffset: number,
): DocumentedPair[] {
  return extractPipeTable(text, file, "state-first", lineOffset);
}

function extractPipeTableExitFirst(
  text: string,
  file: string,
  lineOffset: number,
): DocumentedPair[] {
  return extractPipeTable(text, file, "exit-first", lineOffset);
}

function extractFile(unit: CorpusFile, text: string): DocumentedPair[] {
  switch (unit.role) {
    case "drive-status-header":
      return extractDriveStatusHeader(text, unit.path);
    case "skill-md-table": {
      const section = sectionText(text, unit.heading);
      return extractSkillMdTable(section.text, unit.path, section.lineOffset);
    }
    case "pipe-table-exit-first": {
      const section = sectionText(text, unit.heading);
      return extractPipeTableExitFirst(
        section.text,
        unit.path,
        section.lineOffset,
      );
    }
  }
}

/** Suffix on the `role` field of a `DRIVE_PR_TERMINAL_STATES_TEST_FILES`
 * entry that sets `documentsDriveTsRemap: true` — kept off the positional
 * list below (rather than a 5th `=`-separated field) so it can never collide
 * with `heading`'s own "everything after the 3rd `=`, unsplit" contract. */
const REMAP_ROLE_SUFFIX = "+remap";

/**
 * Companion to `DRIVE_PR_TERMINAL_STATES_TEST_FILES` (never set alongside it
 * in production, only from a test): a `;`-separated list of identifiers
 * applied as `requiredIdentifiers` to EVERY entry the override produces this
 * call. Deliberately flat rather than per-path-keyed — every test that uses
 * it drives exactly one fixture file, and per-path keying would add a second
 * small parser for a need no current test has. A SEPARATE env var, not a
 * 5th positional field on `DRIVE_PR_TERMINAL_STATES_TEST_FILES` itself,
 * because `heading` already claims "everything after the 3rd `=`" — a new
 * positional field there would have to be inserted BEFORE `heading`, which
 * silently breaks any existing override string that already supplies one.
 * Exists so the `requiredIdentifiers` completeness check (see that field's
 * own doc comment on `CorpusFile`) is reachable end to end through
 * `runCheck()` from a synthetic fixture, not only unit-testable via
 * `findMissingRequired` in isolation — `terminal-states-required-identifiers.test.ts`
 * uses it for exactly that.
 */
function testRequiredIdentifiers(): readonly string[] | undefined {
  const raw = process.env.DRIVE_PR_TERMINAL_STATES_TEST_REQUIRED;
  return raw ? raw.split(";").filter(Boolean) : undefined;
}

/**
 * `path=role[=minPairs[=heading]]`, colon-separated — a real file on disk
 * (fixture) plus which of the pinned row shapes (`CorpusRole`) to read it as,
 * optionally its own population floor, and optionally a section-bounding
 * heading. `role` may carry the `+remap` suffix (see `REMAP_ROLE_SUFFIX`) to
 * set `documentsDriveTsRemap`. Mirrors `check-lifecycle-maps.ts`'s
 * `LIFECYCLE_MAP_TEST_FILES` seam: fixtures are real files, never inline
 * strings, so the extractor reads exactly the code path it reads in
 * production. `heading` is everything after the 3rd `=` verbatim (not itself
 * split further), so a real heading containing `=` — none do today — still
 * round-trips.
 */
function corpusFiles(): readonly { unit: CorpusFile; path: string }[] {
  const override = process.env.DRIVE_PR_TERMINAL_STATES_TEST_FILES;
  if (override) {
    const requiredIdentifiers = testRequiredIdentifiers();
    return override
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => {
        const parts = entry.split("=");
        const path = parts[0] ?? "";
        const rawRole = parts[1] ?? "";
        const documentsDriveTsRemap = rawRole.endsWith(REMAP_ROLE_SUFFIX);
        const role = (
          documentsDriveTsRemap
            ? rawRole.slice(0, -REMAP_ROLE_SUFFIX.length)
            : rawRole
        ) as CorpusRole;
        const minPairs = parts[2];
        const heading = parts.length > 3 ? parts.slice(3).join("=") : undefined;
        return {
          unit: {
            path,
            role,
            ...(minPairs === undefined ? {} : { minPairs: Number(minPairs) }),
            ...(heading === undefined ? {} : { heading }),
            documentsDriveTsRemap,
            ...(requiredIdentifiers === undefined
              ? {}
              : { requiredIdentifiers }),
          },
          path,
        };
      });
  }
  return CORPUS_FILES.map((unit) => ({
    unit,
    path: resolve(SKILL_ROOT, unit.path),
  }));
}

interface BrokenPair {
  readonly pair: DocumentedPair;
  /** The exit code(s) actually valid for this pair's state, SCOPED to the
   * FILE it was found in — never a blanket dump of every code the state
   * could ever carry anywhere, which would wrongly suggest `0` is fine for
   * a `CONVERGED` row in `drive-status.ts`'s own header, `SKILL.md`, or
   * `references/terminal-states.md` (see `documentsDriveTsRemap`'s own doc
   * comment on `CorpusFile`). Empty when the state itself is not recognized
   * at all. */
  readonly validExitCodes: readonly number[];
}

interface MissingRequired {
  readonly file: string;
  readonly missing: readonly string[];
}

/**
 * Which of `requiredIdentifiers` did NOT survive extraction into `pairs` —
 * the exact-set completeness check `requiredIdentifiers`'s own doc comment
 * on `CorpusFile` describes, pulled out as a pure function so it is
 * unit-testable directly against constructed `DocumentedPair[]` fixtures,
 * without going through file I/O, `corpusFiles()`, or the
 * `DRIVE_PR_TERMINAL_STATES_TEST_FILES` override (which never sets
 * `requiredIdentifiers` — see that field's own doc comment). Presence-only:
 * a duplicate or extra pair beyond what is required is not itself a defect
 * this function reports (the `broken`/`silent` checks in `runCheck` cover
 * pair-level and population-level problems respectively).
 */
export function findMissingRequired(
  pairs: readonly Pick<DocumentedPair, "state">[],
  requiredIdentifiers: readonly string[],
): string[] {
  const found = new Set(pairs.map((p) => p.state));
  return requiredIdentifiers.filter((id) => !found.has(id));
}

/**
 * The driver-only half of the drift check, over CODE rather than
 * prose. Everything above this point re-derives the canonical (exit, state)
 * set from `TERMINAL_STATES` and checks the PROSE restatements (`CORPUS_FILES`
 * below) against it; none of it ever opens `drive.ts` itself, which is
 * exactly the gap this half closes. `drive.ts` now exports a named constant for
 * each of its driver-only exits, each one READ OUT OF `TERMINAL_STATES`
 * via `terminal-states.ts`'s own `driverOnlyExitCode('<NAME>')` rather than
 * an independent literal (`export const MAX_ROUNDS_EXIT =
 * driverOnlyExitCode('MAX_ROUNDS')`, and so on) — so the checks below
 * check what that binding cannot check by construction:
 *
 *   1. `findExitConstantMismatches` — a future edit that reverts one of
 *      these constants back to an independent literal (bypassing the
 *      `driverOnlyExitCode(...)` read) would no longer be caught by
 *      TypeScript, since both sides still type-check as `number`. This
 *      compares the REAL, IMPORTED runtime value of each constant against
 *      `TERMINAL_STATES`'s own entry — real code, not a text scan. On its
 *      own this proves the VALUE is currently correct, never that it is
 *      bound to that value BY the `driverOnlyExitCode(...)` read rather than
 *      by a literal that merely happens to still agree — see (3).
 *   2. `findBareLiteralExits` — a future edit that adds a NEW `return 6;` /
 *      `return 11;` / `return 12;` / `return 14;` / `return 15;` /
 *      `return 16;` somewhere in `drive.ts`, bypassing the named constant
 *      entirely, is invisible to (1): the constant itself would still be
 *      correct, and the check would never even look at the new site. This is
 *      a REAL AST scan (the TypeScript compiler's own parse of the file —
 *      see `createSingleFileProgram`), not a regex over the source text — it
 *      looks for a `return`
 *      statement whose entire expression is one of the driver-only exit codes
 *      in `BARE_LITERAL_EXIT_CODES`, anywhere in the file. The invariant this
 *      check states — every driver-only exit reads its value from
 *      `TERMINAL_STATES` via the named constant, never a bare literal —
 *      covers `PASS_DEADLINE_EXIT` (15) and `QUOTA_PARKED_EXIT` (16) exactly
 *      as much as the others. Scope note: this is
 *      deliberately NOT bounded
 *      to `main`/`runRepairPass` by function name — a name-bounded scan would
 *      silently stop catching a future edit that renames or extracts either
 *      function, which is a real risk in the repo's highest-churn subsystem
 *      (`references/consistency.md`). "Bare" covers a direct
 *      literal, a transparent wrapper around it — parens, `as`, `satisfies`,
 *      non-null `!`, unary `+` (`unwrapLiteral`; without the type-level
 *      wrappers `return 6 as number;` would bypass it) — and a same-scope
 *      local identifier whose OWN declaration resolves to one of those forms
 *      (`resolveIdentifierLiteral`, below, resolved via the real TypeScript
 *      binder rather than a document-order name walk — see that function's
 *      own header). Verified
 *      against the real file (2026-09): zero OTHER bare occurrences
 *      of any tracked exit code exist anywhere in `drive.ts` today, so an
 *      unscoped scan has no known false positive to state a residual for —
 *      but a future helper function that legitimately returns one of these
 *      numbers for an unrelated reason (a count, an index) would trip this
 *      check; that would be a completeness boundary to state, not a reason
 *      to narrow the scan by hand.
 *   3. `findConstantProvenanceMismatches` — a
 *      future edit that reverts one of the driver-only DECLARATIONS
 *      themselves back to an independent literal (`export const
 *      MAX_ROUNDS_EXIT = 6;` instead of `= driverOnlyExitCode('MAX_ROUNDS')`)
 *      is invisible to (1) as long as `TERMINAL_STATES.MAX_ROUNDS.exitCode`
 *      is still `6` — (1) only ever compares VALUES, and a reverted-but-still-
 *      correct literal has the identical value. This is a REAL AST scan of
 *      the declaration's initializer, not the runtime value: it requires the
 *      initializer of the REAL TOP-LEVEL EXPORTED declaration of that name
 *      (never a same-named declaration anywhere else in the file — a decoy
 *      inside a nested function is a DIFFERENT binding and does not satisfy
 *      this) to be literally the call
 *      `driverOnlyExitCode('<the matching state name>')`, where the callee
 *      resolves — via the real TypeScript binder, never by name text — to the
 *      `driverOnlyExitCode` actually imported from `terminal-states.ts` (see
 *      that function's own header for the decoys this closes).
 */
export interface DriverOnlyExitBinding {
  /** The name `drive.ts` exports this constant under, e.g. `MAX_ROUNDS_EXIT`. */
  readonly constantName: string;
  /** The value that export currently holds. */
  readonly constantValue: number;
  /** The `TERMINAL_STATES` key this constant is supposed to equal. */
  readonly stateName: string;
}

/**
 * `drive.ts`'s driver-only exports, paired with the `TERMINAL_STATES` key
 * each is supposed to equal. `constantValue` is read from a REAL module at
 * call time (`driverOnlyExitBindings` below) — this array shape alone is
 * just the pairing, kept separate so `findExitConstantMismatches` stays
 * unit-testable against a synthetic binding list, independent of loading any
 * real or fixture module.
 */
const DRIVER_ONLY_EXIT_NAMES: ReadonlyArray<{
  readonly constantName: string;
  readonly stateName: DriverOnlyStateName;
}> = [
  { constantName: "MAX_ROUNDS_EXIT", stateName: "MAX_ROUNDS" },
  {
    constantName: "SINGLE_INSTANCE_LOCK_EXIT",
    stateName: "SINGLE_INSTANCE_LOCK",
  },
  { constantName: "WORKTREE_UNCLEAN_EXIT", stateName: "WORKTREE_UNCLEAN" },
  { constantName: "STALLED_EXIT", stateName: "STALLED" },
  { constantName: "PASS_DEADLINE_EXIT", stateName: "PASS_DEADLINE" },
  { constantName: "QUOTA_PARKED_EXIT", stateName: "QUOTA_PARKED" },
  { constantName: "MAILBOX_STOPPED_EXIT", stateName: "MAILBOX_STOPPED" },
  {
    constantName: "MAILBOX_PAUSE_TIMEOUT_EXIT",
    stateName: "MAILBOX_PAUSE_TIMEOUT",
  },
  { constantName: "TAKEN_OVER_EXIT", stateName: "TAKEN_OVER" },
];

/**
 * `lib/state/lease.ts`'s out-of-band exit exports, paired with the
 * `TERMINAL_STATES` key each is supposed to equal — the
 * `DRIVER_ONLY_EXIT_NAMES` sibling for the two `state`-category entries
 * `drive-status.ts` sets OUTSIDE `evaluate`, rather than for a
 * `driver-only`-category one.
 */
const OUT_OF_BAND_EXIT_NAMES: ReadonlyArray<{
  readonly constantName: string;
  readonly stateName: OutOfBandStateName;
}> = [
  { constantName: "SESSION_LEASE_HELD_EXIT", stateName: "SESSION_LEASE_HELD" },
  {
    constantName: "DRIVE_HELD_ELSEWHERE_EXIT",
    stateName: "DRIVE_HELD_BY_OTHER_WORKTREE",
  },
];

/**
 * `require`s `modulePath` for the exit constants named in `names`, bare (a
 * global under Bun). Real code, not text: an export that is missing
 * entirely, or is not a `number`, is reported as a mismatch rather than
 * thrown past the caller, so one broken export does not crash the whole
 * check. Shared by `driverOnlyExitBindings` (drive.ts) and
 * `outOfBandExitBindings` (lease.ts) below — the `require` and
 * mapping logic is identical for both; only which name list and which module
 * differ.
 */
function loadExitBindings(
  modulePath: string,
  names: ReadonlyArray<{
    readonly constantName: string;
    readonly stateName: string;
  }>,
): readonly DriverOnlyExitBinding[] {
  const mod = require(modulePath) as Record<string, unknown>;
  return names.map(({ constantName, stateName }) => ({
    constantName,
    stateName,
    constantValue:
      typeof mod[constantName] === "number"
        ? (mod[constantName] as number)
        : Number.NaN,
  }));
}

export function driverOnlyExitBindings(
  modulePath: string,
): readonly DriverOnlyExitBinding[] {
  return loadExitBindings(modulePath, DRIVER_ONLY_EXIT_NAMES);
}

/** `lease.ts`'s own out-of-band exit bindings — see
 * `loadExitBindings` above for the shared loading logic. */
export function outOfBandExitBindings(
  modulePath: string,
): readonly DriverOnlyExitBinding[] {
  return loadExitBindings(modulePath, OUT_OF_BAND_EXIT_NAMES);
}

/**
 * Pure comparison, independent of `require()` or any file — see this
 * section's own header. `NaN` never equals anything, including itself, so a
 * binding whose `constantValue` came from a missing/non-numeric export
 * (`driverOnlyExitBindings` above) is reported as a mismatch here too,
 * rather than needing a separate branch.
 */
export function findExitConstantMismatches(
  bindings: readonly DriverOnlyExitBinding[],
  terminalStates: Readonly<
    Record<string, { readonly exitCode: number } | undefined>
  >,
): string[] {
  const mismatches: string[] = [];
  for (const { constantName, constantValue, stateName } of bindings) {
    const entry = terminalStates[stateName];
    if (entry === undefined) {
      mismatches.push(
        `${constantName}: TERMINAL_STATES has no '${stateName}' entry at all`,
      );
      continue;
    }
    if (entry.exitCode !== constantValue) {
      mismatches.push(
        `${constantName} = ${constantValue}, but TERMINAL_STATES.${stateName}.exitCode = ${entry.exitCode}`,
      );
    }
  }
  return mismatches;
}

/**
 * A checker symbol, with its declarations already resolved to nodes of the
 * scanned file (the program holds no other file, so every declaration is
 * one). There is exactly one object per symbol, so two references to the
 * same binding compare equal with `===` and a `Set` of these deduplicates
 * by binding, never by spelling.
 */
interface ResolvedSymbol {
  readonly declarations: readonly ts.Node[];
  readonly valueDeclaration: ts.Node | undefined;
}

/**
 * The three questions the checks below ask the TypeScript checker, answered
 * for one source file: which binding an identifier reference denotes, which
 * binding a shorthand property inside a destructuring assignment writes
 * (`({ alias } = holder)`), and which declaration the `outOfBand` property of
 * an element access's object type has. `createSingleFileProgram` asks the
 * checker every one of them for every node they can be asked about before
 * any scan starts, so the scans stay plain synchronous tree walks. A
 * question about a node outside that set throws rather than answering "no
 * symbol": a scan that silently resolved nothing would pass vacuously.
 */
interface FileChecker {
  getSymbolAtLocation(node: ts.Node): ResolvedSymbol | undefined;
  getShorthandAssignmentValueSymbol(
    node: ts.ShorthandPropertyAssignment,
  ): ResolvedSymbol | undefined;
  getOutOfBandPropertyOfType(node: ts.Expression): ResolvedSymbol | undefined;
}

/**
 * The TypeScript compiler runs as a separate server process that the
 * checker talks to; starting it costs a few hundred milliseconds, so one
 * process serves every program this module builds, over a virtual file
 * system that holds each scanned source and its tsconfig only while that
 * program is being read. Started on first use; `closeTypeScriptService`
 * stops it.
 */
interface TypeScriptService {
  readonly api: API;
  readonly writeFile: (path: string, content: string) => void;
  readonly removeFile: (path: string) => void;
}

/** Root of the virtual file system — never a real directory on disk. */
const VIRTUAL_ROOT = "/terminal-states-consistency";

let service: TypeScriptService | undefined;
let programCount = 0;
/** Programs are built one at a time: each one opens and then closes its own
 * project on the shared server, and an overlapping build would read a
 * snapshot another build is still changing. */
let programQueue: Promise<unknown> = Promise.resolve();

function typeScriptService(): TypeScriptService {
  if (service === undefined) {
    const files = createVirtualFileSystem({});
    const { writeFile, removeFile } = files;
    if (writeFile === undefined || removeFile === undefined) {
      throw new Error("the virtual file system cannot add or remove files");
    }
    service = {
      api: new API({ cwd: VIRTUAL_ROOT, fs: files }),
      writeFile,
      removeFile,
    };
  }
  return service;
}

/** Stops the TypeScript server process, if one is running. A later program
 * build starts a new one. */
export async function closeTypeScriptService(): Promise<void> {
  await programQueue;
  const running = service;
  service = undefined;
  await running?.api.close();
}

/**
 * Builds a one-file TypeScript program so the checks below can ask the real
 * TypeScript binder "what declaration does this identifier reference denote"
 * and "what module was this name imported from", instead of re-implementing
 * name/scope resolution by hand. `noResolve` and `noLib` with a virtual file
 * system that holds only this one file mean no module is ever actually
 * loaded — module specifiers stay unresolved — but the binder still creates
 * a real symbol for every local declaration and import specifier, and the
 * checker still walks lexical scope correctly for all of them. That
 * scope-correctness is what `findConstantProvenanceMismatches` and
 * `resolveIdentifierLiteral` below need to stop matching on bare identifier
 * SPELLING — which is what let a same-named decoy declaration elsewhere in
 * the file "rescue" a reverted constant, or let block-scope shadowing
 * "steal" the wrong declaration for a scope-blind name walk.
 *
 * The checker answers over a request/response channel, one round trip per
 * question, so this asks every question the scans can ask in a few batched
 * requests up front (see `FileChecker`) and resolves each symbol's
 * declaration handles back to nodes of the returned `sourceFile` — the same
 * node objects a walk of that tree visits, so a declaration found through a
 * symbol and the same node reached by walking compare equal with `===`.
 */
function createSingleFileProgram(
  fileName: string,
  source: string,
): Promise<{ checker: FileChecker; sourceFile: ts.SourceFile }> {
  const build = programQueue.then(() =>
    buildSingleFileProgram(fileName, source),
  );
  programQueue = build.catch(() => undefined);
  return build;
}

async function buildSingleFileProgram(
  fileName: string,
  source: string,
): Promise<{ checker: FileChecker; sourceFile: ts.SourceFile }> {
  const { api, writeFile, removeFile } = typeScriptService();
  programCount += 1;
  const directory = `${VIRTUAL_ROOT}/${programCount}`;
  const configPath = `${directory}/tsconfig.json`;
  const sourcePath = `${directory}/${basename(fileName)}`;
  writeFile(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        noResolve: true,
        noLib: true,
        types: [],
      },
      files: [basename(fileName)],
    }),
  );
  writeFile(sourcePath, source);
  const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
  try {
    const project = snapshot.getProject(configPath);
    const sourceFile = await project?.program.getSourceFile(sourcePath);
    if (project === undefined || sourceFile === undefined) {
      throw new Error(`TypeScript did not load ${fileName} into a program`);
    }
    const { checker } = project;

    const names: ts.Node[] = [];
    const shorthands: ts.ShorthandPropertyAssignment[] = [];
    const elementAccessObjects: ts.Expression[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        names.push(node);
      } else if (ts.isShorthandPropertyAssignment(node)) {
        shorthands.push(node);
      } else if (ts.isElementAccessExpression(node)) {
        elementAccessObjects.push(node.expression);
      }
      node.forEachChild(collect);
    };
    collect(sourceFile);

    const nameSymbols = await checker.getSymbolAtLocation(names);
    const shorthandSymbols = await Promise.all(
      shorthands.map((node) => checker.getShorthandAssignmentValueSymbol(node)),
    );
    const objectTypes = await checker.getTypeAtLocation(elementAccessObjects);
    const outOfBandProperties = await Promise.all(
      objectTypes.map((type) =>
        type === undefined
          ? undefined
          : checker.getPropertyOfType(type, "outOfBand"),
      ),
    );

    const resolveHandle = async (
      handle: NodeHandle,
    ): Promise<ts.Node | undefined> => handle.resolve(project);
    const resolved = new Map<CheckerSymbol, ResolvedSymbol>();
    for (const symbol of [
      ...nameSymbols,
      ...shorthandSymbols,
      ...outOfBandProperties,
    ]) {
      if (symbol === undefined || resolved.has(symbol)) continue;
      const declarations = await Promise.all(
        symbol.declarations.map(resolveHandle),
      );
      resolved.set(symbol, {
        declarations: declarations.filter(
          (node): node is ts.Node => node !== undefined,
        ),
        valueDeclaration:
          symbol.valueDeclaration === undefined
            ? undefined
            : await resolveHandle(symbol.valueDeclaration),
      });
    }
    const table = <K extends ts.Node>(
      keys: readonly K[],
      symbols: readonly (CheckerSymbol | undefined)[],
    ): Map<ts.Node, ResolvedSymbol | undefined> =>
      new Map(
        keys.map((key, i) => {
          const symbol = symbols[i];
          return [key, symbol === undefined ? undefined : resolved.get(symbol)];
        }),
      );
    const lookup =
      (answers: Map<ts.Node, ResolvedSymbol | undefined>, question: string) =>
      (node: ts.Node): ResolvedSymbol | undefined => {
        if (!answers.has(node)) {
          throw new Error(
            `${question} was not resolved for a ${ts.SyntaxKind[node.kind]} node`,
          );
        }
        return answers.get(node);
      };
    return {
      sourceFile,
      checker: {
        getSymbolAtLocation: lookup(
          table(names, nameSymbols),
          "getSymbolAtLocation",
        ),
        getShorthandAssignmentValueSymbol: lookup(
          table(shorthands, shorthandSymbols),
          "getShorthandAssignmentValueSymbol",
        ),
        getOutOfBandPropertyOfType: lookup(
          table(elementAccessObjects, outOfBandProperties),
          "getOutOfBandPropertyOfType",
        ),
      },
    };
  } finally {
    await api.updateSnapshot({ closeProjects: [configPath] });
    await snapshot.dispose();
    removeFile(sourcePath);
    removeFile(configPath);
  }
}

/**
 * Is `statement` an exported top-level `const` declaration list — the ONE
 * shape this file treats as a canonical, exempt binding everywhere the
 * distinction matters? Requires: the statement's own parent is the
 * SourceFile itself (never nested — see `findTopLevelExportedDeclaration`'s
 * own header for why a plain statement-list scan, not a recursive walk, is
 * what enforces this), it carries the `export` modifier (never merely
 * top-level — a non-exported top-level `const exit = 6;` is not the
 * driver-only-exit pattern this file promotes, and must not be silently
 * exempted from `findBareLiteralExits` below), and its declaration list is
 * declared `const` (never `let`/`var` — a `let` would pass today's
 * provenance and value checks once, then could be reassigned elsewhere
 * without failing this gate). The single definition both
 * `findTopLevelExportedDeclaration` and `isTopLevelDeclaration` below build
 * on, so they cannot drift apart on what "canonical" means the way
 * two separate checks would (the const check missing from one and the
 * export check from the other — two independent gaps in what is meant to
 * be the same invariant).
 */
function isExportedTopLevelConstStatement(
  node: ts.Node,
): node is ts.VariableStatement {
  if (!ts.isVariableStatement(node)) return false;
  if (!ts.isSourceFile(node.parent)) return false;
  if ((node.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
  return (
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

/**
 * The real top-level `export const <name> = ...` statement — never a
 * same-named declaration anywhere else in the file. Deliberately a plain
 * statement-list scan rather than a recursive tree walk ("parse, don't
 * pattern-match" applied to SCOPE, not just syntax): `sourceFile.statements`
 * is exactly the module's top level, so a decoy `function decoy { const
 * MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS'); }` elsewhere in the file
 * is a completely different statement list this scan never descends into, and
 * cannot "rescue" a reverted top-level export (a recursive `forEachChild`
 * walk matches a decoy at ANY depth, including inside a nested function,
 * because it never checks which declaration list a match came from).
 */
function findTopLevelExportedDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!isExportedTopLevelConstStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

/**
 * Does `init` call the REAL helper function (`driverOnlyExitCode` for
 * `drive.ts`, `outOfBandExitCode` for `lease.ts` — the caller names which
 * helper/specifier count as "the real one") — the one imported from the exact
 * canonical module specifier — with `stateName` as its sole string-literal
 * argument?
 * Symbol-resolved via `checker`, not name text: an identifier spelled like
 * the helper that resolves to an import from some OTHER module (a decoy
 * shadowing the real helper) does not match (matching on
 * `init.expression.text === 'driverOnlyExitCode'` alone never looks at
 * where that name actually came from). The module-specifier check itself is
 * an exact match, not a substring test: `.includes('terminal-states')`
 * accepted any decoy specifier merely containing that text, such as
 * `./fake-terminal-states.ts`, as the real helper.
 */
function isExitCodeHelperCall(
  init: ts.Expression,
  stateName: string,
  checker: FileChecker,
  helperName: string,
  helperModuleSpecifier: string,
): boolean {
  if (
    !ts.isCallExpression(init) ||
    !ts.isIdentifier(init.expression) ||
    init.arguments.length !== 1 ||
    init.arguments[0] === undefined ||
    !ts.isStringLiteral(init.arguments[0]) ||
    init.arguments[0].text !== stateName
  ) {
    return false;
  }
  const calleeSymbol = checker.getSymbolAtLocation(init.expression);
  const importSpecifier = calleeSymbol?.declarations?.find(
    ts.isImportSpecifier,
  );
  if (importSpecifier === undefined) return false;
  const importedName = (importSpecifier.propertyName ?? importSpecifier.name)
    .text;
  if (importedName !== helperName) return false;
  const importDeclaration = importSpecifier.parent.parent.parent;
  return (
    ts.isImportDeclaration(importDeclaration) &&
    ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
    importDeclaration.moduleSpecifier.text === helperModuleSpecifier
  );
}

/**
 * `findExitConstantMismatches`
 * above proves each driver-only exit constant presently holds the VALUE
 * `TERMINAL_STATES` says it should. It cannot, by construction, prove the
 * constant is bound to that value BY the `driverOnlyExitCode(...)` read
 * rather than by an independent literal that happens to still agree —
 * `export const MAX_ROUNDS_EXIT = 6;` and `export const MAX_ROUNDS_EXIT =
 * driverOnlyExitCode('MAX_ROUNDS')` are indistinguishable at the runtime
 * VALUE layer as long as both currently equal 6, so a revert to the bare
 * literal (the exact regression this check exists to prevent) silently passes
 * `findExitConstantMismatches` as long as `TERMINAL_STATES` hasn't also
 * drifted. This is a REAL AST scan of the DECLARATION itself, not the
 * runtime value: for each
 * binding, the matching declaration must be the REAL top-level exported
 * `export const <constantName> = ...` (`findTopLevelExportedDeclaration`,
 * above — never a same-named declaration anywhere else in the file), and its
 * initializer must be a call to the REAL, imported helper function
 * (`isExitCodeHelperCall`, above — never a same-named decoy) with
 * `'<stateName>'` as its sole string-literal argument. Any other shape — a
 * bare numeric literal, a call to a different or decoy function, a
 * mismatched or non-literal argument, or no top-level exported declaration at
 * all — is reported.
 */
export interface ConstantProvenanceMismatch {
  readonly constantName: string;
  readonly reason: string;
}

export async function findConstantProvenanceMismatches(
  sourceText: string,
  bindings: ReadonlyArray<{
    readonly constantName: string;
    readonly stateName: string;
  }>,
  fileName = "drive.ts",
  // The two params below default to drive.ts's own helper, preserving every
  // existing call site's (and test's) behavior unchanged; lease.ts's own
  // provenance check passes 'outOfBandExitCode' and
  // '../status/terminal-states.ts' explicitly instead.
  helperName = "driverOnlyExitCode",
  helperModuleSpecifier = "./lib/status/terminal-states.ts",
): Promise<ConstantProvenanceMismatch[]> {
  const { checker, sourceFile } = await createSingleFileProgram(
    fileName,
    sourceText,
  );

  const mismatches: ConstantProvenanceMismatch[] = [];
  for (const { constantName, stateName } of bindings) {
    const declaration = findTopLevelExportedDeclaration(
      sourceFile,
      constantName,
    );
    if (declaration === undefined) {
      mismatches.push({
        constantName,
        reason: `no top-level exported declaration of '${constantName}' found in ${fileName}`,
      });
      continue;
    }
    const init = declaration.initializer;
    if (
      init === undefined ||
      !isExitCodeHelperCall(
        init,
        stateName,
        checker,
        helperName,
        helperModuleSpecifier,
      )
    ) {
      mismatches.push({
        constantName,
        reason:
          init === undefined
            ? `${constantName} has no initializer`
            : `${constantName} is not declared as ${helperName}('${stateName}')`,
      });
    }
  }
  return mismatches;
}

/**
 * Exit-code values a driver-only or out-of-band `TERMINAL_STATES` entry has
 * ever held, retained here forever once superseded by a renumber — the
 * append-only complement to deriving {@link BARE_LITERAL_EXIT_CODES} and
 * {@link OUT_OF_BAND_BARE_LITERAL_EXIT_CODES} from CURRENT values alone
 *. Deriving those two sets purely
 * from `TERMINAL_STATES`'s current values fixes only ONE direction of the
 * problem the file header above describes: it stops a value that is no
 * longer reserved from being mis-flagged, but it also means a renumber makes
 * the OLD value invisible to the scan — a stale `return 11;` left behind
 * after `SESSION_LEASE_HELD` moves from `11` to some other code matches
 * nothing in a set that now only contains the new value, so `runCheck`
 * passes over exactly the drift this scan exists to catch. The two
 * directions cannot both be served by a single "current values" set, because
 * they want opposite answers for the same retired value.
 *
 * Empty today: no driver-only or out-of-band entry has ever been renumbered
 * (every historical `= 15`-shaped literal noted throughout this file changed
 * its DECLARATION FORM only — from an independent literal to a
 * `driverOnlyExitCode(...)`/`outOfBandExitCode(...)` read — never its VALUE).
 * When a `TERMINAL_STATES` entry's `exitCode` is intentionally changed, add
 * its OLD value here in the SAME commit, so a leftover bare reference to it
 * stays part of the reserved vocabulary forever after — this is the
 * "preserve the known reserved exit-code vocabulary" remedy, deliberately
 * NOT a historical union computed some other way: an automatically-derived
 * history would need to diff against a prior commit, which is exactly the
 * kind of state this file otherwise avoids keeping.
 */
const RETIRED_RESERVED_EXIT_CODES: ReadonlySet<number> = new Set<number>([]);

/**
 * `currentValues` (a driver-only or out-of-band exit set, read fresh from
 * `TERMINAL_STATES` at call time) UNIONED with `retiredValues` — the single
 * place `BARE_LITERAL_EXIT_CODES` and `OUT_OF_BAND_BARE_LITERAL_EXIT_CODES`
 * build their scanned set, so both halves of the residual documented above
 * are exercised by name, not reimplemented ad hoc at each call site.
 *
 * `retiredValues` defaults to {@link RETIRED_RESERVED_EXIT_CODES} — every
 * production call site omits the second argument and gets the real,
 * currently-empty retired set. The parameter exists so a test can inject a
 * non-empty one directly: while `RETIRED_RESERVED_EXIT_CODES` stays empty in
 * production, a call with no override always returns exactly
 * `new Set(currentValues)` regardless of whether the union with the retired
 * set is even present in this function body, so a test pinned to the
 * zero-argument call cannot tell a correct union from a deleted one
 *. Injecting the retired set
 * directly makes the union itself the thing under test, independent of
 * whether production has retired anything yet.
 */
export function buildReservedExitCodes(
  currentValues: Iterable<number>,
  retiredValues: Iterable<number> = RETIRED_RESERVED_EXIT_CODES,
): ReadonlySet<number> {
  return new Set([...currentValues, ...retiredValues]);
}

/** Every driver-only exit code. The invariant this scan enforces ("a
 * driver-only exit is always returned via its named constant") applies to
 * every one of them identically, and a future bare `return` of any of these
 * values bypasses its named constant exactly as silently as a bare `6`
 * bypasses `MAX_ROUNDS_EXIT`.
 * Verified (2026-09): zero existing bare occurrences of any of these values
 * in `drive.ts` today (see this section's header for the residual this
 * still leaves open on any of them).
 *
 * DERIVED from `TERMINAL_STATES` via `DRIVER_ONLY_EXIT_NAMES` above and the
 * same `driverOnlyExitCode` read `drive.ts`'s own constants use — never an
 * independent literal set for the CURRENT values. A hard-coded set still
 * needs a matching edit for an add/remove of a driver-only exit (as with any
 * array), but a *renumber* in `TERMINAL_STATES` — the exported constant
 * following automatically via `driverOnlyExitCode` — leaves it holding the
 * stale value, so a new bare `return` of the NEW code bypasses its constant
 * undetected while a bare return of the OLD, now-unused code can be
 * misreported. Deriving the CURRENT half from `TERMINAL_STATES` closes that
 * false-positive direction; it does not, by itself, close the opposite one —
 * a renumber's own OLD value needs {@link RETIRED_RESERVED_EXIT_CODES} above
 * to stay caught. */
const BARE_LITERAL_EXIT_CODES = buildReservedExitCodes(
  DRIVER_ONLY_EXIT_NAMES.map(({ stateName }) => driverOnlyExitCode(stateName)),
);

/**
 * `drive-status.ts`'s own scan target — the two out-of-band exit
 * codes it sets outside `evaluate`, DERIVED from `TERMINAL_STATES` via
 * `OUT_OF_BAND_EXIT_NAMES` and `outOfBandExitCode`, same reasoning as
 * `BARE_LITERAL_EXIT_CODES` above — including the same residual: this only
 * covers the CURRENT half. {@link RETIRED_RESERVED_EXIT_CODES} covers any
 * value a renumber has since moved away from.
 */
const OUT_OF_BAND_BARE_LITERAL_EXIT_CODES = buildReservedExitCodes(
  OUT_OF_BAND_EXIT_NAMES.map(({ stateName }) => outOfBandExitCode(stateName)),
);

export interface BareLiteralExit {
  readonly line: number;
  readonly value: number;
  /** Which of the three code-bound shapes this occurrence is: `return` for a
   * bare-literal return, `comparison` for a bare literal compared against
   * a `.code` property (`bump.code === 11`), `call` for a bare literal passed
   * to `emit(...)`. All three bypass the named constant identically — a
   * scan that only caught `return` would miss a comparison or `emit` call
   * reverted to a bare literal while the function's own final `return` still
   * read the real constant. */
  readonly kind: "return" | "comparison" | "call";
}

/** Renders a `BareLiteralExit` back to the shape it was found in, for error
 * output — a `comparison`/`call` occurrence is not itself a `return`, and
 * reporting it as one would misdirect a reader at the wrong line's syntax. */
function describeBareLiteralExit({ value, kind }: BareLiteralExit): string {
  switch (kind) {
    case "return":
      return `return ${value};`;
    case "comparison":
      return `.code === ${value}`;
    case "call":
      return `emit(${value})`;
  }
}

/**
 * Unwraps every transparent wrapper around a numeric literal so `(6)` / `6 as
 * number` / `6 satisfies number` / `6!` / `+6` — and any nesting of these —
 * are all recognized as the literal `6` they evaluate to. A `return (6);`
 * bypasses the named constant exactly like a bare `return 6;` does, and
 * stopping at `ts.isNumericLiteral(expr)` alone misses every one of these
 * forms (`return 6 as number;` bypasses a scan that unwraps only
 * parens/unary-plus). It loops rather than following a fixed nesting order
 * so a combination like `+(6 as number)` unwraps too. Deliberately narrow in
 * one direction only: unary MINUS is never unwrapped — a driver-only exit code
 * is never legitimately negative, so `-6` is not this class of bypass and
 * unwrapping it would misreport an unrelated negative-value return as a literal
 * `6`.
 */
function unwrapLiteral(expr: ts.Expression): ts.NumericLiteral | undefined {
  let current: ts.Expression = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isPrefixUnaryExpression(current) &&
      current.operator === ts.SyntaxKind.PlusToken
    ) {
      current = current.operand;
      continue;
    }
    break;
  }
  return ts.isNumericLiteral(current) ? current : undefined;
}

/**
 * Resolution of a bare identifier return (`const exit = 6; return exit;`) to
 * its declaration's literal initializer — that bypasses the named constant
 * exactly like `return 6;` does, and neither `ts.isNumericLiteral` nor
 * `unwrapLiteral` above can see it, since the return expression is an
 * identifier, not a literal.
 * Resolved via `checker.getSymbolAtLocation` — the real TypeScript binder —
 * rather than a hand-rolled document-order name walk: walking the
 * identifier's enclosing FUNCTION in document order and matching the FIRST
 * same-named declaration found is both
 * too narrow (a decoy in an unrelated function never rescued it, but only
 * because it happened to be out of the function boundary the walk enforced
 * by hand) and, more seriously, WRONG about scope: it does not distinguish a
 * BLOCK-scoped shadow from the binding the return statement actually reads,
 * so `const exit = MAX_ROUNDS_EXIT; if (cond) { const exit = 6; } return
 * exit;` is misreported as a bare-literal bypass even though the `return`
 * correctly reads the outer, canonical binding. The real binder resolves
 * lexical scope, shadowing and function boundaries correctly by construction,
 * closing that class outright rather than adding a narrower hand-rolled scope
 * rule. It does not follow REASSIGNMENT — it reads the resolved declaration's
 * own initializer, not a later write (`let exit = 6; exit = MAX_ROUNDS_EXIT;
 * return exit;` still resolves to the `let exit = 6` declaration) — a full
 * data-flow resolver is a materially larger undertaking than this drift check
 * warrants, so this residual is a stated completeness boundary.
 *
 * Deliberately excludes a TOP-LEVEL EXPORTED CONST declaration once resolved
 * (`isTopLevelDeclaration` below, built on the same
 * `isExportedTopLevelConstStatement` predicate `findTopLevelExportedDeclaration`
 * uses above): `return MAX_ROUNDS_EXIT;` referencing the real named constant
 * is the CLEAN, encouraged shape this whole check exists to promote, even on
 * a HEAD where that constant's own declaration happens to be a bare literal
 * — that declaration-level defect is
 * `findExitConstantMismatches`'/`findConstantProvenanceMismatches`'s job to
 * report, not this one's. Real lexical-scope resolution otherwise reaches
 * that same top-level declaration for any unshadowed reference (that is
 * exactly what fixes the block-shadowing bug above), so without this
 * exclusion every ordinary use of the named constant would itself start
 * getting flagged as a bare-literal bypass. The exclusion is scoped to
 * exactly that shape — export AND const — never to "any top-level variable
 * declaration": a non-exported top-level `const exit = 6;` is not a
 * reference to a driver-only-exit constant at all, and must still be caught
 * the same as any other local alias (a structural-only check would exempt
 * it regardless).
 */
function isTopLevelDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    isExportedTopLevelConstStatement(declaration.parent.parent)
  );
}

/**
 * Follows an identifier's declaration to its literal value, through a whole
 * CHAIN of same-scope local aliases (`const raw = 11; const code = raw;
 * return code;`), not just the immediate initializer. A single-hop version
 * unwrapped only the first declaration's own initializer, so a second alias
 * hop reduced to an identifier the caller never re-resolved — the identical
 * gap `resolvesToLocalReporter` and `resolvesToCodePropertyAccess` below close by
 * recursing on their OWN initializer already; this was the one of the three
 * sibling resolvers that did not. `seen`
 * accumulates the symbols already visited in this call chain so a cyclic
 * alias — not reachable through ordinary `const` (a self-reference is a TDZ
 * error), but not ruled out for a pathological `let`-based chain either —
 * terminates instead of recursing forever. Every other constraint is
 * unchanged: `isTopLevelDeclaration` still exempts a reference to the real
 * named constant at any hop, and reassignment is still a stated residual
 * (see the header above `isTopLevelDeclaration`).
 */
function resolveIdentifierLiteral(
  identifier: ts.Identifier,
  checker: FileChecker,
  seen: Set<ResolvedSymbol> = new Set(),
): ts.NumericLiteral | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || seen.has(symbol)) {
    return undefined;
  }
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    isTopLevelDeclaration(declaration) ||
    declaration.initializer === undefined
  ) {
    return undefined;
  }
  return (
    unwrapLiteral(declaration.initializer) ??
    (ts.isIdentifier(declaration.initializer)
      ? resolveIdentifierLiteral(declaration.initializer, checker, seen)
      : undefined)
  );
}

/**
 * Is `statement` positioned where this scan is willing to recognize a file's
 * own out-of-band reporting function — the SourceFile's own statement list,
 * OR one level inside the body of a top-level function declaration — never
 * any deeper? This is a STRUCTURAL test only: it says nothing about the
 * declaration's NAME, so a behavior-preserving rename of the real reporter
 * (`emit` → `emitReport`, declaration and call sites together) does not move
 * it out of this zone. That closes the exact gap the previous, name-based
 * `findTopLevelFunctionDeclaration(sourceFile, 'emit')` lookup left open:
 * once the real nested function and its calls were renamed away from `emit`,
 * that lookup returned `undefined`, so the caller rejected the perfectly
 * resolvable renamed declaration and let `await emitReport(11)` through the
 * gate uncaught: the reporting function is identified structurally rather
 * than by requiring its name.
 *
 * The depth bound:
 * `drive-status.ts`'s real emitter is nested directly inside its own
 * top-level `async function main()`, so that shape must resolve — but a
 * function nested two levels deep (a shadow declared inside some OTHER
 * helper that is itself nested inside a top-level function) must not, so a
 * same-named-or-not decoy two levels down still cannot stand in for the real
 * reporter (the shadow fixture and its two-levels-deep sibling are both
 * pinned below, and both pass under this position-only test, since neither
 * depends on matching a name).
 *
 * Takes a STATEMENT rather than a `FunctionDeclaration` specifically —
 * shared by both declaration shapes this scan recognizes: a
 * `FunctionDeclaration` is itself a statement, and a function-valued
 * `VariableDeclaration`'s own enclosing `VariableStatement` is positioned the
 * same way (`isEmitterZoneVariableDeclaration` below).
 */
function isEmitterZoneStatement(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): boolean {
  if (statement.getSourceFile() !== sourceFile) {
    return false;
  }
  if (ts.isSourceFile(statement.parent)) {
    return true;
  }
  const enclosingBody = statement.parent;
  return (
    ts.isBlock(enclosingBody) &&
    ts.isFunctionDeclaration(enclosingBody.parent) &&
    ts.isSourceFile(enclosingBody.parent.parent)
  );
}

function isEmitterZoneFunctionDeclaration(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  return isEmitterZoneStatement(declaration, sourceFile);
}

/**
 * Is `declaration` a function-VALUED variable declaration
 * (`const emit = async (code: number) => {...}`, or the `function` expression
 * spelling of the same thing) whose own `VariableStatement` sits in the
 * recognized reporter zone? `resolvesToLocalReporter` below previously only
 * matched a `FunctionDeclaration` at that position — a behavior-preserving
 * rewrite of the real reporter to an arrow-function-valued `const` resolved
 * to a `VariableDeclaration` whose initializer is neither an identifier
 * (the alias case already handled) nor a `FunctionDeclaration`, so it fell
 * through to `return false` and let `await emit(11)` through the gate
 * uncaught.
 */
function isEmitterZoneVariableDeclaration(
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    isEmitterZoneStatement(declaration.parent.parent, sourceFile)
  );
}

/**
 * Does `fn`'s parameter list match the real reporter's own call contract —
 * exactly one parameter, typed `number` wherever a type annotation is
 * present? Position alone (`isEmitterZoneStatement` above) accepts every
 * direct statement child of a top-level function without regard to what it
 * actually takes — `drive-status.ts`'s `main()` declares OTHER direct
 * function children alongside the real `emit` (`countOrNull(n: number |
 * null)`, `reflectDue()`, `structuralEscalationStatus()`,
 * `recordRoundPaths()`, `baseDrift()`, `degrade(reason: string)`), none
 * sharing its signature, so on position alone an unrelated call such as
 * `countOrNull(11)` would be classified as an emit call purely on structural
 * depth. The reporting function is therefore identified through a feature
 * unique to its call contract rather than declaration depth alone. The
 * reporter always takes the exit code as its sole argument, so
 * its declared arity and (where annotated) parameter type are real evidence
 * position alone is not. An UNANNOTATED parameter is not rejected — this scan
 * has no full program to infer its type from, so the absence of an
 * annotation is "not disproven", not a positive match.
 *
 * STATED BOUNDARY (an execution-classification residual): this is a
 * fail-CLOSED heuristic, not a proof of reporter identity. "Is this function
 * THE canonical reporter" is a semantic property no structural or type-level
 * predicate can decide without full call-graph/whole-program analysis, so a
 * future same-zone sibling that happens to share this exact contract (one
 * parameter, `number`-typed or unannotated) WILL be misclassified as the
 * reporter — on purpose. That is the same deliberate posture already stated
 * above for the sibling `return`-statement scan's own false-positive
 * residual ("a future helper function that legitimately returns one of these
 * numbers... would trip this check"). Today it is instance-free: none of
 * `main()`'s other direct children listed above match. If a real
 * collision is ever introduced, it fails LOUDLY (the gate rejects a
 * legitimate bare-literal call) rather than silently passing a real
 * violation through — the gate's preferred failure direction — and
 * that concrete instance is the trigger to revisit this boundary, not
 * another round of narrowing the heuristic in the abstract.
 */
function matchesReporterSignature(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  if (fn.parameters.length !== 1) {
    return false;
  }
  const paramType = fn.parameters[0]?.type;
  return (
    paramType === undefined || paramType.kind === ts.SyntaxKind.NumberKeyword
  );
}

/**
 * Does `expr` — a call expression's callee — resolve, through the REAL
 * binder and through a same-scope variable alias (`const report = emit;
 * await report(11);`, the way `resolveIdentifierLiteral` above already
 * follows one for a literal value), to a function declaration OR a
 * function-valued variable declaration positioned in this scan's recognized
 * reporter zone and matching the reporter's own call contract
 * (`isEmitterZoneStatement` / `isEmitterZoneVariableDeclaration` /
 * `matchesReporterSignature` above)? Resolved via
 * `checker.getSymbolAtLocation` and tested by POSITION and SIGNATURE — never
 * by matching the identifier's text — so this is immune to every direction of
 * the arms race at once: a behavior-preserving RENAME of
 * the real reporter (`emit` → `emitReport`, declaration and call sites
 * together) still resolves, because nothing here reads a name; an
 * UNRELATED same-named shadow declared outside the recognized zone
 * is still rejected, because it fails the position test regardless of
 * sharing the spelling `emit`; a REWRITE to a function-valued variable
 * declaration still resolves, because the zone test covers
 * that shape too; and an UNRELATED sibling declared at the exact same
 * structural depth is still rejected, because it fails the
 * call-contract test even though it shares the reporter's position. This
 * does not follow an alias defined in a different file (an import) — the
 * reporter is declared locally in every dispatch shape this check targets
 * today — and it does not follow REASSIGNMENT, the same stated residual
 * `resolveIdentifierLiteral` carries (`let report = emit; report =
 * somethingElse; report(11);` still resolves to the `emit` initializer).
 *
 * Falls back to the pre-binder textual match `expr.text === 'emit'` ONLY
 * when the identifier's own declaration cannot be resolved AT ALL — the
 * synthetic test-snippet shape that calls `emit(...)` with no surrounding
 * declaration in scope, where there is no declaration to test the position
 * of and the literal spelling is the only signal available. This can never
 * fire on real, type-checking source: a call site whose callee has no
 * resolvable declaration anywhere in the program does not compile, so
 * neither file this scan actually runs against (`drive.ts`,
 * `drive-status.ts`) can ever reach this branch — it exists purely so the
 * many minimal fixtures below that omit an explicit `emit` declaration for
 * brevity keep working. It carries none of the real security property; that
 * property is carried entirely by the position and signature tests above,
 * which is why a resolvable declaration that fails either no longer falls
 * back to this — it fails closed instead.
 *
 * STATED BOUNDARY: the MODELED callee set is a bare identifier plus a
 * same-scope `const` alias chain (the `if (!ts.isIdentifier(expr))` guard
 * above), and nothing else. A non-identifier callee — property access
 * (`reporter.emit(11)`), element access, a call expression returning a
 * function, `this.emit(11)`, optional chaining — is a stated SYNTACTIC
 * residual, not chased: each shape closed opens the next one (an
 * open-ended enumeration of JS/TS callee expressions), which is exactly the
 * per-variant patch the structural-escalation rule (`drive-pr/SKILL.md` § 3)
 * forbids after two rounds on one root cause. This is safe to leave stated
 * rather than closed because the actual gate-level consequence does not
 * silently reproduce: the real corpus's own reporter declaration and its
 * call sites are pinned VERBATIM by the test suite (the "pin it verbatim"
 * alternative to parsing, paired with this parser) —
 * see "the real repo corpus: injecting a bare-literal emit call into the
 * actual drive-status.ts source is caught" and "the real repo corpus:
 * renaming the actual drive-status.ts reporter — declaration AND every call
 * site — is still caught" below — so restructuring the real reporter into a
 * delegated (`reporter.emit`) shape breaks those pins loudly, in CI, rather
 * than silently disabling this scan. What survives the pin is an ADDED
 * second, delegated reporter carrying a hand-written literal beside the
 * intact real one — an execution-classification residual ("is this call a
 * reporter dispatch" is not a syntactic property), the same class as the
 * `fail(11, ...)` sites this file's own header already carves out (see top
 * of file) — closable only by a scope decision, which this is.
 */
function resolvesToLocalReporter(
  expr: ts.Expression,
  checker: FileChecker,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isIdentifier(expr)) {
    return false;
  }
  const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
  if (declaration === undefined) {
    return expr.text === "emit";
  }
  if (
    ts.isFunctionDeclaration(declaration) &&
    isEmitterZoneFunctionDeclaration(declaration, sourceFile) &&
    matchesReporterSignature(declaration)
  ) {
    return true;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer)) &&
    isEmitterZoneVariableDeclaration(declaration, sourceFile) &&
    matchesReporterSignature(declaration.initializer)
  ) {
    return true;
  }
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    resolvesToLocalReporter(declaration.initializer, checker, sourceFile)
  );
}

/**
 * The literal an arbitrary expression reduces to for this scan's purposes —
 * the direct/wrapped literal (`unwrapLiteral`), or, for a bare identifier, its
 * same-scope declaration's own literal initializer (`resolveIdentifierLiteral`,
 * with its own stated residual). Shared by all the call-site shapes below
 * (`return <expr>`, `<expr> === code`, `emit(<expr>)`) — each one asks the
 * identical question of a different expression position.
 */
function resolveLiteral(
  expr: ts.Expression,
  checker: FileChecker,
): ts.NumericLiteral | undefined {
  return (
    unwrapLiteral(expr) ??
    (ts.isIdentifier(expr)
      ? resolveIdentifierLiteral(expr, checker)
      : undefined)
  );
}

/**
 * Is `expr` an access of a `code` member — the shape every out-of-band
 * dispatch comparison in `drive-status.ts` uses (`bump.code === ...`,
 * `admit.code === ...`)? Name-based, not symbol-resolved: there is no single
 * declared `code` property to resolve against (it comes from whichever
 * `bump`/`admit` result shape is in scope at each call site), so this
 * mirrors the comparison's own literal textual shape rather than its type.
 * Covers both dot access (`bump.code`) and a string-literal element access
 * (`bump['code']`, `` bump[`code`] ``) — a behavior-preserving rewrite between
 * the two spellings must not silently exit this check's population
 *. Stated residual: a computed
 * element access through an intermediate variable (`const k = 'code';
 * bump[k]`) is not resolved — matching this function's own name-based scope,
 * not a symbol-resolved one.
 */
function isCodePropertyAccess(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "code") {
    return true;
  }
  return (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLikeNode(expr.argumentExpression) &&
    expr.argumentExpression.text === "code"
  );
}

/**
 * The property name a destructuring `BindingElement` reads — `code` from
 * `const { code } = bump`, or from its own `propertyName` when renamed
 * (`const { code: alias } = bump` binds `alias` to property `code`, which is
 * exactly the case `resolvesToCodePropertyAccess` below needs to recognize
 * for `alias`). A COMPUTED property name (`const { ['code']: alias } =
 * bump`) is a documented residual, matching the identical
 * bracket-computed-through-a-variable residual `isCodePropertyAccess`
 * already carries for its own element-access shape — `undefined` here reads
 * the same way there: not resolved, not a regression.
 */
function bindingElementPropertyName(
  element: ts.BindingElement,
): string | undefined {
  if (element.propertyName !== undefined) {
    return ts.isIdentifier(element.propertyName) ||
      ts.isStringLiteralLikeNode(element.propertyName)
      ? element.propertyName.text
      : undefined;
  }
  return element.name !== undefined && ts.isIdentifier(element.name)
    ? element.name.text
    : undefined;
}

/**
 * Does `expr` resolve to a `code`-property access — directly
 * (`isCodePropertyAccess` above), through a same-scope local alias
 * (`const code = bump.code; ... code === 11`), OR through DESTRUCTURING
 * (`const { code } = bump; ... code === 11`, including its renamed spelling
 * `const { code: alias } = bump`) — the way `resolvesToLocalReporter` above
 * already follows an alias of the reporter callee? A behavior-preserving local
 * extraction of the `.code` access into its own variable would evade the
 * comparison check entirely, since `isCodePropertyAccess` only recognizes the
 * property access written directly at the comparison site — and
 * destructuring would evade an alias-only fix, since a destructured
 * identifier's own declaration is a `BindingElement`, not the
 * `VariableDeclaration` the alias branch below follows. Resolved
 * via `checker.getSymbolAtLocation` — the real binder — for the identical
 * reason `resolveIdentifierLiteral` and `resolvesToLocalReporter` are:
 * reassignment is a stated residual here too (`let code = bump.code; code =
 * other.code; if (code === 11)` still resolves to the FIRST declaration's
 * own initializer, not the later write), and this does not reach through a
 * computed/string-held key (`const k = 'code'; const code = bump[k];` stays
 * out of scope, since `isCodePropertyAccess` itself never recognizes
 * `bump[k]` for a non-literal `k` — the residual is inherited, not
 * reintroduced) nor through a computed destructuring property name (see
 * `bindingElementPropertyName` above). Restricted to an OBJECT binding
 * pattern: an ARRAY destructure (`const [code] = arr`) binds `code`
 * positionally, with no property named `code` involved at all, so treating
 * its bare `name` text as a property name the way the object-pattern branch
 * does would misclassify it.
 */
function resolvesToCodePropertyAccess(
  expr: ts.Expression,
  checker: FileChecker,
): boolean {
  if (isCodePropertyAccess(expr)) {
    return true;
  }
  if (!ts.isIdentifier(expr)) {
    return false;
  }
  const declaration = checker.getSymbolAtLocation(expr)?.valueDeclaration;
  if (declaration === undefined) {
    return false;
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent)
  ) {
    return bindingElementPropertyName(declaration) === "code";
  }
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    resolvesToCodePropertyAccess(declaration.initializer, checker)
  );
}

/**
 * A REAL AST scan (parsed, not pattern-matched) for the shapes
 * that bypass a named exit constant with a bare numeric literal in
 * `exitCodes` (`BARE_LITERAL_EXIT_CODES` by default, for `drive.ts`; `runCheck`
 * passes `OUT_OF_BAND_BARE_LITERAL_EXIT_CODES` for `drive-status.ts`
 * instead) — see this section's own header for why this is deliberately NOT
 * scoped to a named function, and the residual that leaves:
 *
 *   - `return <expr>;` (`kind: 'return'`).
 *   - `<expr> === <expr>` / `!==` / `==` / `!=` where one side is a `.code`
 *     property access (`kind: 'comparison'`) — `drive-status.ts`'s own
 *     out-of-band dispatch reads `bump.code === SESSION_LEASE_HELD_EXIT`
 *     before ever reaching a `return`, and a comparison reverted to a bare
 *     literal silently changes which branch fires while the function's own
 *     trailing `return` may still read the real constant, undetected by the
 *     `return`-only scan alone.
 *   - `emit(<expr>)` (`kind: 'call'`) — the out-of-band exit is reported via
 *     `emit(...)` before the matching `return`; the same bypass applies.
 *
 * "Bare" covers the direct literal, a transparent wrapper around it
 * (`unwrapLiteral`), and a same-scope local identifier whose own declaration
 * resolves to one of those forms (`resolveIdentifierLiteral`, with its own
 * stated residual) — `return foo(6);` or `return x - 6;` still do not match,
 * since neither reduces to the literal itself; the same holds for a
 * comparison or call argument built the same way.
 */
export async function findBareLiteralExits(
  sourceText: string,
  fileName = "drive.ts",
  exitCodes: ReadonlySet<number> = BARE_LITERAL_EXIT_CODES,
): Promise<BareLiteralExit[]> {
  const { checker, sourceFile } = await createSingleFileProgram(
    fileName,
    sourceText,
  );
  const found: BareLiteralExit[] = [];
  const record = (
    expr: ts.Expression,
    literal: ts.NumericLiteral,
    kind: BareLiteralExit["kind"],
  ): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      expr.getStart(sourceFile),
    );
    found.push({ line: line + 1, value: Number(literal.text), kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const expr = node.expression;
      const literal = resolveLiteral(expr, checker);
      if (literal !== undefined && exitCodes.has(Number(literal.text))) {
        record(expr, literal, "return");
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      const [codeSide, literalSide] = resolvesToCodePropertyAccess(
        node.left,
        checker,
      )
        ? [node.left, node.right]
        : resolvesToCodePropertyAccess(node.right, checker)
          ? [node.right, node.left]
          : [undefined, undefined];
      if (codeSide !== undefined && literalSide !== undefined) {
        const literal = resolveLiteral(literalSide, checker);
        if (literal !== undefined && exitCodes.has(Number(literal.text))) {
          record(literalSide, literal, "comparison");
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      resolvesToLocalReporter(node.expression, checker, sourceFile)
    ) {
      for (const arg of node.arguments) {
        const literal = resolveLiteral(arg, checker);
        if (literal !== undefined && exitCodes.has(Number(literal.text))) {
          record(arg, literal, "call");
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The gap `outOfBand` alone leaves (see this file's own header for the
 * full description): `outOfBand` guarantees
 * `report.state` and the returned exit code cannot disagree with EACH OTHER
 * for whatever name is passed, but nothing stops a call site from passing
 * the WRONG sibling name for the branch it is actually in. The functions
 * below find every `outOfBand(report, 'NAME', ...)` call reachable from an
 * `if (X.code === IDENT)` dispatch and verify `'NAME'` matches `IDENT`'s own
 * resolved state.
 */
export interface OutOfBandNamePairingMismatch {
  /** Line of the mismatched `outOfBand()` call's own `name` argument. */
  readonly line: number;
  /** Line of the enclosing `.code === IDENT` comparison. */
  readonly comparisonLine: number;
  /** The exit-code identifier the enclosing comparison tested for. */
  readonly comparisonIdentifier: string;
  /** The state name that identifier is actually bound to. */
  readonly expectedStateName: string;
  /** The state name the `outOfBand()` call passed instead. */
  readonly actualStateName: string;
}

/**
 * Does `expr` resolve — via the REAL import, never by name text, the same
 * discipline `isExitCodeHelperCall` applies to the helper functions
 * themselves — to one of `OUT_OF_BAND_EXIT_NAMES`'s constants, imported from
 * `leaseModuleSpecifier`? Returns the `TERMINAL_STATES` state name that
 * constant is bound to. That binding's own correctness (VALUE and
 * provenance) is verified separately, by `findExitConstantMismatches`/
 * `findConstantProvenanceMismatches` against `lease.ts` itself — this
 * function only has to know WHICH constant a comparison names. A same-named
 * decoy imported from elsewhere, or an identifier that is not one of the two
 * known constants at all, resolves to `undefined` — the same "not the real
 * thing" posture `isExitCodeHelperCall` takes for the helper functions.
 */
function resolveOutOfBandComparisonStateName(
  expr: ts.Expression,
  checker: FileChecker,
  leaseModuleSpecifier: string,
): string | undefined {
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(expr);
  const importSpecifier = symbol?.declarations?.find(ts.isImportSpecifier);
  if (importSpecifier === undefined) {
    return undefined;
  }
  const importedName = (importSpecifier.propertyName ?? importSpecifier.name)
    .text;
  const importDeclaration = importSpecifier.parent.parent.parent;
  if (
    !ts.isImportDeclaration(importDeclaration) ||
    !ts.isStringLiteralLikeNode(importDeclaration.moduleSpecifier) ||
    importDeclaration.moduleSpecifier.text !== leaseModuleSpecifier
  ) {
    return undefined;
  }
  return OUT_OF_BAND_EXIT_NAMES.find((n) => n.constantName === importedName)
    ?.stateName;
}

/**
 * The `X.code === IDENT` dispatch test itself: `resolvesToCodePropertyAccess`
 * (already used by the bare-literal comparison scan above) identifies which
 * side is the `.code` access, and the OTHER side must resolve, through the
 * real import, to a known out-of-band exit constant
 * (`resolveOutOfBandComparisonStateName` above). Deliberately `===` only —
 * never `!==`/`==`/`!=`: `drive-status.ts`'s own five real out-of-band call
 * sites all use `===` today (verified 2026-09), so that is the
 * shape this check anchors against; a future `!==`-guarded early-return
 * dispatch (`if (x.code !== EXIT) return; ...`) is a real presence dispatch
 * too and is NOT covered by this restriction — a stated scope boundary,
 * not a claim that every non-`===`
 * shape is semantically an absence check.
 */
function resolveOutOfBandComparisonTest(
  test: ts.Expression,
  checker: FileChecker,
  leaseModuleSpecifier: string,
): { readonly identifierText: string; readonly stateName: string } | undefined {
  if (
    !ts.isBinaryExpression(test) ||
    test.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return undefined;
  }
  const identSide = resolvesToCodePropertyAccess(test.left, checker)
    ? test.right
    : resolvesToCodePropertyAccess(test.right, checker)
      ? test.left
      : undefined;
  if (identSide === undefined || !ts.isIdentifier(identSide)) {
    return undefined;
  }
  const stateName = resolveOutOfBandComparisonStateName(
    identSide,
    checker,
    leaseModuleSpecifier,
  );
  return stateName === undefined
    ? undefined
    : { identifierText: identSide.text, stateName };
}

/**
 * Walking UP from `node`, the NEAREST enclosing `if` statement whose
 * `thenStatement` contains `node` AND whose own test resolves as a
 * recognized out-of-band dispatch (`resolveOutOfBandComparisonTest` above) —
 * never the test itself or an `else` branch. This is deliberately NOT "the
 * first enclosing `if`, full stop": an `outOfBand` call nested inside some
 * OTHER, unrelated `if` (`if (someCondition) { outOfBand(...) }`) that is
 * itself inside the real dispatch block must still anchor to the dispatch,
 * not silently find no anchor at the first, irrelevant `if` and stop there —
 * stopping there would go silent on a call nested one level deeper than the
 * dispatch itself. Ascends past every NON-resolving enclosing `if`, returning
 * the first one that DOES resolve — so a genuinely nested dispatch (an
 * `outOfBand` call inside an inner `if (y.code === IDENT2)` itself nested
 * inside an outer `if (x.code === IDENT1)`) still anchors to its own, innermost
 * dispatch, not the outer one it also happens to be lexically inside of. No
 * real call site nests at all today, let alone this deeply, but nothing here
 * assumes otherwise.
 */
function findEnclosingOutOfBandDispatch(
  node: ts.Node,
  checker: FileChecker,
  leaseModuleSpecifier: string,
):
  | {
      readonly ifStatement: ts.IfStatement;
      readonly identifierText: string;
      readonly stateName: string;
    }
  | undefined {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = current.parent;
  while (parent !== undefined) {
    if (ts.isIfStatement(parent) && parent.thenStatement === current) {
      const comparison = resolveOutOfBandComparisonTest(
        parent.expression,
        checker,
        leaseModuleSpecifier,
      );
      if (comparison !== undefined) {
        return { ifStatement: parent, ...comparison };
      }
      // This `if` isn't a recognized dispatch — keep ascending. The call may
      // still be anchored to an OUTER dispatch it is nested inside of.
    }
    current = parent;
    parent = parent.parent;
  }
  return undefined;
}

/**
 * Strips every transparent wrapper around a callee or rebind initializer —
 * parens, `as`, `satisfies`, and non-null (`!`) — so recognizing the real
 * helper does not depend on incidental wrapper syntax: `(outOfBand)(…)`,
 * `(outOfBand as typeof outOfBand)(…)`, `outOfBand!(…)`. Mirrors
 * `unwrapLiteral` above (sibling resolvers in this same file handle
 * AsExpression, SatisfiesExpression and NonNullExpression; this does too,
 * via the same established loop rather than a novel mechanism); deliberately
 * omits that
 * function's own unary-plus branch, which is specific to unwrapping a
 * *numeric literal* and has no callee-expression analogue.
 */
function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  let current: ts.Expression = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

/**
 * Follows `identifier` to the string literal it ultimately denotes through a
 * same-scope CONST alias chain (`const key = 'outOfBand' as const;
 * ns[key]`) — the identical discipline `resolveIdentifierImportBinding`
 * above applies to import bindings and `resolveIdentifierLiteral` applies to
 * numeric literals, applied here to a string literal instead (`const key =
 * 'outOfBand' as const; terminalStates[key](report, ...)` is a real helper
 * call, and rejecting the non-literal element access before `candidateCount`
 * increments would miss it). The
 * initializer is unwrapped of transparent parens/`as`/`satisfies`/non-null
 * (`unwrapTransparentExpression`) before the literal check, so `'outOfBand'
 * as const` resolves identically to a bare `'outOfBand'`. As with both
 * sibling resolvers, only a `const`-flagged declaration list counts — a
 * `let`-rebindable key is not a durable provenance claim — and `seen` guards
 * the same cyclic-alias case. A GENUINELY dynamic key (a function call, a
 * template literal with interpolation, a parameter) has no literal
 * initializer to resolve to and stays the stated residual this closes part
 * of, not all of.
 */
function resolveIdentifierStringLiteral(
  identifier: ts.Identifier,
  checker: FileChecker,
  seen: Set<ResolvedSymbol> = new Set(),
): ts.StringLiteralLikeNode | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || seen.has(symbol)) {
    return undefined;
  }
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (ts.isStringLiteralLikeNode(initializer)) {
    return initializer;
  }
  return ts.isIdentifier(initializer)
    ? resolveIdentifierStringLiteral(initializer, checker, seen)
    : undefined;
}

/**
 * If `expr` is a member access naming `outOfBand` — `ns.outOfBand`, an
 * element access keyed by the string literal `ns['outOfBand']`, or an
 * element access keyed by an identifier that itself resolves, through a
 * same-scope CONST chain, to that string literal (`ns[key]` where `const key
 * = 'outOfBand' as const`, via `resolveIdentifierStringLiteral` above) —
 * returns the OBJECT side (`ns`); else `undefined`. A GENUINELY dynamic element
 * access — a function call, a template literal with interpolation, a `let`
 * rebind — has no literal to resolve to and remains a stated residual, the same
 * posture `resolveOutOfBandCallStateName`'s own header already takes for a
 * computed `name` argument.
 */
function outOfBandMemberExpressionObject(
  expr: ts.Expression,
  checker: FileChecker,
): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "outOfBand") {
    return expr.expression;
  }
  if (ts.isElementAccessExpression(expr)) {
    const key = unwrapTransparentExpression(expr.argumentExpression);
    const resolvedKey = ts.isStringLiteralLikeNode(key)
      ? key
      : ts.isIdentifier(key)
        ? resolveIdentifierStringLiteral(key, checker)
        : undefined;
    if (resolvedKey?.text === "outOfBand") {
      return expr.expression;
    }
  }
  return undefined;
}

/**
 * The closed set of assignment-operator token kinds TypeScript's own grammar
 * defines (`ts.AssignmentOperator`) — plain `=` plus every compound
 * arithmetic/bitwise/logical-or-coalescing assignment (`+=`, `&=`, `??=`,
 * …) — read from the compiler's own `isAssignmentOperator` rather than
 * guessed from token-name suffixes (`===`/`!==`/`<=`/`>=` all end in
 * `EqualsToken` too and are comparisons, not assignments).
 * Used by `findAssignedValues` below in place of a bare `=== EqualsToken`
 * check, so a reassignment written with a compound operator (`alias ??=
 * outOfBand`) is not silently invisible to the census. A compound
 * ARITHMETIC operator (`+=`) could never legitimately carry a function
 * reference past type-checking, but admitting it here costs nothing: a
 * false-positive match only WIDENS the ambiguous census, the fail-closed
 * direction this file already always takes.
 */
function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return ts.isAssignmentOperator(kind);
}

/**
 * Does destructuring-assignment-pattern-shaped expression `pattern` bind
 * `symbol` ANYWHERE within it, at any nesting depth, under ANY destructuring
 * shape — object or array, a literal or COMPUTED property key, a default
 * value, a rest/spread element, an elided array hole, a nested pattern?
 *
 * A precise version of this check (matching only
 * `PropertyAssignment`/`ShorthandPropertyAssignment` with a statically named
 * key) is narrow in more than one shape at once: a computed key
 * (`({ ['outOfBand']: alias } = terminalStates)`) and an array pattern
 * (`[alias] = [terminalStates.outOfBand]`) each leave `alias` with no
 * recorded reaching value at all, so `candidateCount` and `anchoredCount`
 * both remain zero — a silent exclusion. Parse or pin: a hand-rolled
 * resolution model stays one counterexample behind, so this is not a
 * per-shape carve-out: destructuring-target
 * syntax is not an enumerable set the way a fixed corpus of documents is,
 * so this WALKS the pattern generically instead of matching a closed list of
 * node kinds, closing computed keys, array patterns, nesting and rest
 * elements all at once and any future sibling shape along with them.
 *
 * This deliberately answers only "could `symbol` be a target here", never
 * "which property of the source object would it receive" — `findAssignedVal
 * ues` below needs no more than that, because it always responds to a match
 * by pushing the WHOLE right-hand side as the candidate (never a synthesized
 * per-property access), so the identity of the specific property extracted
 * is irrelevant to it. That is what makes the generic walk sufficient: it
 * only has to prove reachability, and over-matching (treating a pattern as
 * binding `symbol` when a human reading the destructure would agree it does)
 * only WIDENS the ambiguous census — the fail-closed direction this file
 * already always takes, restated in `findAssignedValues`'s own comment below.
 */
function assignmentPatternBindsSymbol(
  pattern: ts.Expression,
  symbol: ResolvedSymbol,
  checker: FileChecker,
): boolean {
  if (ts.isIdentifier(pattern)) {
    return checker.getSymbolAtLocation(pattern) === symbol;
  }
  if (ts.isObjectLiteralExpression(pattern)) {
    return pattern.properties.some((element) => {
      if (ts.isShorthandPropertyAssignment(element)) {
        return checker.getShorthandAssignmentValueSymbol(element) === symbol;
      }
      if (ts.isPropertyAssignment(element)) {
        const target =
          ts.isBinaryExpression(element.initializer) &&
          element.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? element.initializer.left
            : element.initializer;
        return assignmentPatternBindsSymbol(target, symbol, checker);
      }
      if (ts.isSpreadAssignment(element)) {
        return assignmentPatternBindsSymbol(
          element.expression,
          symbol,
          checker,
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(pattern)) {
    return pattern.elements.some((element) => {
      if (ts.isOmittedExpression(element)) {
        return false;
      }
      if (ts.isSpreadElement(element)) {
        return assignmentPatternBindsSymbol(
          element.expression,
          symbol,
          checker,
        );
      }
      const target =
        ts.isBinaryExpression(element) &&
        element.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? element.left
          : element;
      return assignmentPatternBindsSymbol(target, symbol, checker);
    });
  }
  return false;
}

/**
 * Every DEFAULT-VALUE expression written directly inside destructuring
 * pattern `pattern` — `{ x: alias = outOfBand }`'s `outOfBand`, or
 * `[alias = outOfBand]`'s — at any nesting depth, regardless of which
 * target within the pattern it defaults. `findAssignedValues` below needs
 * these as candidates distinct from the pattern's own source object: a
 * default fires exactly when the source has NO property at that key, so its
 * value never depends on the destructured right-hand side at all —
 * `({ x: alias = outOfBand } = decoy)` reaches the real helper through
 * `outOfBand` alone, regardless of what `decoy` is. Collected pattern-wide
 * rather than scoped to the one target matching a given symbol, for the same
 * reason `assignmentPatternBindsSymbol` answers only yes/no: over-inclusion
 * here only widens the ambiguous census.
 */
function collectPatternDefaults(
  pattern: ts.Expression,
): readonly ts.Expression[] {
  const defaults: ts.Expression[] = [];
  const visit = (p: ts.Expression): void => {
    if (ts.isObjectLiteralExpression(p)) {
      for (const element of p.properties) {
        if (ts.isPropertyAssignment(element)) {
          if (
            ts.isBinaryExpression(element.initializer) &&
            element.initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ) {
            defaults.push(element.initializer.right);
            visit(element.initializer.left);
          } else {
            visit(element.initializer);
          }
        } else if (
          ts.isShorthandPropertyAssignment(element) &&
          element.objectAssignmentInitializer !== undefined
        ) {
          defaults.push(element.objectAssignmentInitializer);
        } else if (ts.isSpreadAssignment(element)) {
          visit(element.expression);
        }
      }
    } else if (ts.isArrayLiteralExpression(p)) {
      for (const element of p.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        if (ts.isSpreadElement(element)) {
          visit(element.expression);
          continue;
        }
        if (
          ts.isBinaryExpression(element) &&
          element.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          defaults.push(element.right);
          visit(element.left);
        } else {
          visit(element);
        }
      }
    }
  };
  visit(pattern);
  return defaults;
}

/**
 * Every value `symbol` could reach through a REASSIGNMENT anywhere in
 * `sourceFile` — the reaching-definition case a declaration-initializer-only
 * walk cannot see at all: a `let`-declared binding populated (or overwritten)
 * via a plain assignment rather than its own initializer (`let alias: typeof
 * terminalStates.outOfBand; alias = terminalStates[computeKey()];
 * alias(...)`, or `let ns = decoyModule; ns = terminalStates;
 * ns[computeKey()](...)`) leaves `declaration.initializer` either absent or
 * stale, so a chain that only ever follows that one field never reaches the
 * value the call site actually observes. A COMPOUND operator
 * (`isAssignmentOperatorToken` above, `alias ??= outOfBand`) reaching the
 * identifier directly is covered too.
 *
 * A destructuring-ASSIGNMENT pattern (object or array, any shape
 * `assignmentPatternBindsSymbol` above recognizes) cannot push the specific
 * property's real VALUE — there is no such node when the key is dynamic, and
 * even a statically named key would need one synthetic node per shape, which
 * is exactly the enumeration this function avoids (see
 * `assignmentPatternBindsSymbol`'s own comment). It pushes the WHOLE
 * right-hand side instead — an over-approximation ("`alias` might now hold
 * anything this expression could produce", rather than "the one property it
 * actually receives") — plus every default embedded directly in the pattern
 * (`collectPatternDefaults` above), which the right-hand side alone can
 * never account for.
 *
 * The whole-right-hand-side push needs no CONTAINER special-casing (such as
 * separately pushing an array-literal right-hand side's own elements):
 * `containsRealHelperReference`
 * below is the consumer both callers use to check a candidate, and it walks
 * every node a candidate's subtree contains regardless of container shape —
 * an object literal's property values, an array literal's elements, a
 * further identifier's own reassignments — so pushing the container ONCE is
 * enough; the container's insides are the consumer's problem, not this
 * function's (an object-literal right-hand side, `{ x: alias } = { x:
 * outOfBand }`, and a right-hand side reached through one more `const`
 * indirection, `const helpers = [outOfBand]; [alias] = helpers`, both vanish
 * under shape-by-shape handling).
 *
 * Deliberately walks the WHOLE source file rather than a scope-bounded
 * search — `checker.getSymbolAtLocation` resolves each assignment's own LHS
 * to its own symbol, compared here by reference, so a same-named binding
 * elsewhere can never collide, and a false-positive match only WIDENS the
 * ambiguous census, the fail-closed direction this side of the scan already
 * always takes.
 */
function findAssignedValues(
  symbol: ResolvedSymbol,
  sourceFile: ts.SourceFile,
  checker: FileChecker,
): readonly ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorToken(node.operatorToken.kind)
    ) {
      if (
        ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === symbol
      ) {
        values.push(node.right);
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isObjectLiteralExpression(node.left) ||
          ts.isArrayLiteralExpression(node.left)) &&
        assignmentPatternBindsSymbol(node.left, symbol, checker)
      ) {
        values.push(node.right, ...collectPatternDefaults(node.left));
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return values;
}

/**
 * Every "leaf" sub-expression `expr` could evaluate to through a
 * compile-time VALUE-COMPOSING operator or wrapper, followed recursively.
 * Three closed families — the actual invariant throughout is "does this
 * node's result definitionally equal one of its own sub-expressions' values,
 * or does it compute/await/yield-control-flow a genuinely different one":
 *
 * - EITHER-SIDE (drawn from TypeScript's own operator-token enumeration): the
 *   conditional `?:` (both branches), logical `||` / `&&` / `??`, and their
 *   assignment counterparts `||=` / `&&=` / `??=` (all six token kinds
 *   `isAssignmentOperatorToken` already enumerates that are ALSO logical) —
 *   every one of these can resolve, at runtime, to either its left or right
 *   operand's own value, so both are leaves.
 * - RIGHT-ONLY (binary): the comma operator `,` and plain assignment `=` —
 *   both are DEFINITIONALLY their right operand's value; the left is
 *   evaluated solely for its side effect (a comma's discarded expression) or
 *   its target reference (an assignment's own LHS), never contributing to
 *   what the whole expression evaluates to.
 * - RIGHT-ONLY (unary): `await x` — an `AwaitExpression`'s value is
 *   definitionally whatever `x` resolves to (its own inner expression,
 *   `.expression`), the same "forwards exactly one sub-expression's value"
 *   shape as the binary right-only family, just without a discarded left
 *   side at all.
 *
 * Every OTHER assignment operator (`+=`, `-=`, `*=`, `**=`, `/=`, `%=`,
 * `<<=`, `>>=`, `>>>=`, `&=`, `|=`, `^=`) computes a freshly combined value
 * from both operands — its result can never definitionally equal either raw
 * operand, so none belongs in either binary family; this scanner has no
 * interprocedural model that could prove such a combination happens to equal
 * the real helper anyway, the same stated residual as everywhere else in
 * this file that draws a syntactic-vs-semantic line. `yield x` /
 * `yield* x` is the unary family's own analogous exclusion, and for a
 * DIFFERENT reason than the arithmetic-assignment one: a `YieldExpression`'s
 * OWN runtime value is whatever a later external `.next(value)` call
 * supplies — `x` is what the generator SENDS OUT at that pause point, not
 * what the `yield` expression itself evaluates to, so `x` is not this node's
 * forwarded value at all. Modeling it correctly would need to know what the
 * generator's CALLER eventually passes back in, which is exactly the
 * external, non-syntactic information this single-file static scan has no
 * way to see — an honest exclusion, not an oversight, unlike `await`'s
 * genuinely pass-through semantics. So `a ? b : c ?? d` yields `[b, c, d]`,
 * `(a, b)`, `(x = b)`, and `await x` each yield `b`'s (or `x`'s) own leaves
 * alone, `(x += b)` and `yield x` both yield `[unwrapped]` — the opaque
 * default — same as any other node this scanner cannot see through. A
 * transparent wrapper (parens, `as`, `satisfies`, non-null `!`) is unwrapped
 * at every step via `unwrapTransparentExpression`. Anything else — a call, a
 * member access, a bare identifier, … — is itself a leaf with nothing
 * further to expand.
 *
 * Shared by every candidate-value walk below so a composing form only has
 * to be taught here once. Without it, `alias = flag ? outOfBand : decoy;
 * alias(...)` is collected as a reassignment candidate but neither walk can
 * trace past the `ConditionalExpression` node itself — `unwrapTranspa
 * rentExpression` does not unwrap a ternary's branches, and the callers
 * only ever recurse on a bare identifier. The comma operator belongs to the
 * same enumeration: without it, `(sideEffect(), outOfBand)(report, name,
 * reason)` falls through to the `return [unwrapped]` default, treating the
 * whole comma expression as one opaque leaf that resolves to neither a call,
 * a member access, nor an identifier — contributing to neither
 * `candidateCount` nor `anchoredCount`. `(alias = outOfBand)(report, name,
 * reason)` is the identical shape one operator over, and so are its logical
 * siblings (`||=`/`&&=`/`??=`), which is why the line is drawn at the closed
 * binary invariant above rather than at `EqualsToken` alone. The family also
 * extends past binary operators: `(await Promise.resolve(outOfBand))(report,
 * name, reason)` forwards a value through a UNARY wrapper node with no
 * operator token at all, so neither binary branch above could match it.
 * This expands the one value-forwarding unary node TypeScript's grammar has
 * (`await`), and states explicitly why its syntactic sibling (`yield`) is
 * excluded rather than silently absent: the doc comment carries the
 * completeness argument (why each family is closed) so no reader has to
 * re-derive it from a diff.
 */
function composingExpressionLeaves(
  expr: ts.Expression,
): readonly ts.Expression[] {
  const unwrapped = unwrapTransparentExpression(expr);
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...composingExpressionLeaves(unwrapped.whenTrue),
      ...composingExpressionLeaves(unwrapped.whenFalse),
    ];
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
      unwrapped.operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      unwrapped.operatorToken.kind ===
        ts.SyntaxKind.QuestionQuestionEqualsToken)
  ) {
    return [
      ...composingExpressionLeaves(unwrapped.left),
      ...composingExpressionLeaves(unwrapped.right),
    ];
  }
  if (
    ts.isBinaryExpression(unwrapped) &&
    (unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken ||
      unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  ) {
    return composingExpressionLeaves(unwrapped.right);
  }
  if (ts.isAwaitExpression(unwrapped)) {
    return composingExpressionLeaves(unwrapped.expression);
  }
  return [unwrapped];
}

/**
 * The declaration kinds that carry a plain expression initializer —
 * `VariableDeclaration | ParameterDeclaration | BindingElement |
 * PropertyDeclaration | PropertyAssignment | EnumMember`, the closed union
 * the TypeScript compiler itself names `HasExpressionInitializer` — never a
 * hand-grown list of whichever kinds a counterexample has named so far. The
 * compiler's AST module exports no predicate for it, so this states the same
 * six kinds directly.
 */
type ExpressionInitializerDeclaration =
  | ts.VariableDeclaration
  | ts.ParameterDeclaration
  | ts.BindingElement
  | ts.PropertyDeclaration
  | ts.PropertyAssignment
  | ts.EnumMember;

function hasOnlyExpressionInitializer(
  node: ts.Node,
): node is ExpressionInitializerDeclaration {
  switch (node.kind) {
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.EnumMember:
      return true;
    default:
      return false;
  }
}

/**
 * The body a `declaration` denotes AS A FUNCTION VALUE — a `FunctionDeclaration`'s
 * own body, or a `VariableDeclaration`'s initializer's body when that
 * initializer is an arrow function or function expression — or `undefined`
 * for any other declaration shape. Shared by `containsRealHelperReference`
 * below so a function reference's body is inspected uniformly at ordinary
 * identifier resolution, rather than only when that identifier happens to
 * sit in a `CallExpression`'s own callee position (see that function's own
 * header for the gap this closes).
 *
 * "Function-like" is the compiler's own `ts.isFunctionLikeDeclaration` — its
 * `FunctionLikeDeclaration` union (`FunctionDeclaration | MethodDeclaration |
 * GetAccessorDeclaration | SetAccessorDeclaration | ConstructorDeclaration |
 * FunctionExpression | ArrowFunction`), a CLOSED, TypeScript-language-defined
 * enumeration, not an open-ended list of whichever declaration kinds happen
 * to have been found so far.
 */
function functionBodyOfDeclaration(declaration: ts.Node): ts.Node | undefined {
  if (ts.isFunctionLikeDeclaration(declaration)) {
    return declaration.body;
  }
  return hasOnlyExpressionInitializer(declaration) &&
    declaration.initializer !== undefined &&
    ts.isFunctionLikeDeclaration(declaration.initializer)
    ? declaration.initializer.body
    : undefined;
}

/**
 * The node whose evaluation produces the value obtained by MERELY ACCESSING
 * `declaration` — reading it, no further call syntax required. Two closed
 * cases: every declaration kind `hasOnlyExpressionInitializer` covers (an
 * access reads a value the initializer already computed) and a
 * `GetAccessorDeclaration` (an access RUNS the getter's own body and takes
 * its return value — indistinguishable, to a caller, from reading a plain
 * data property). `undefined` for every other declaration shape, including
 * every OTHER function-like kind (`FunctionDeclaration`, `MethodDeclaration`,
 * `SetAccessorDeclaration`, a function/arrow expression): those require
 * their OWN separate call syntax to run at all, so merely accessing one
 * yields the function value itself, not whatever its body might reference or
 * return.
 *
 * That distinction is `couldDirectInvocationReachHelper`'s whole reason for
 * deliberately excluding `functionBodyOfDeclaration` (see its own header):
 * invoking `x.outOfBand(...)` where `outOfBand` is a METHOD runs that
 * method's own body, not whatever it returns. There is one function-like
 * kind that exclusion does not cover: `class Holder { get outOfBand() {
 * return outOfBand; } } new Holder().outOfBand(...)` runs the GETTER's body —
 * producing the real helper as a value — before the call syntax is ever
 * reached, so excluding it via the same guard as a method would silently drop
 * the one declaration kind where mere access already executes code (the
 * property symbol resolves to a `GetAccessorDeclaration`). This is not one
 * more declaration kind added to an open-ended list: TypeScript's
 * function-like union has
 * exactly one member that runs on ACCESS rather than on a further explicit
 * call — a set accessor runs on ASSIGNMENT, not access or call, so it stays
 * excluded — which makes the pairing here a closed, language-defined set
 * rather than a special case.
 */
function valueProducedByMereAccess(declaration: ts.Node): ts.Node | undefined {
  if (ts.isGetAccessorDeclaration(declaration)) {
    return declaration.body;
  }
  return hasOnlyExpressionInitializer(declaration) &&
    declaration.initializer !== undefined
    ? declaration.initializer
    : undefined;
}

/**
 * Does the real `outOfBand` helper — by import-symbol identity, never by
 * name text — appear ANYWHERE within `node`'s syntax tree: as a bare
 * reference to its import specifier, a `.outOfBand`/`['outOfBand']` access
 * on its namespace import, the namespace import referenced bare, or (for an
 * identifier) anywhere among what THAT identifier could reach through its
 * own declaration initializer or reassignments (`findAssignedValues`)?
 *
 * Enumerating composing operators (`composingExpressionLeaves`, immediately
 * above) is itself narrow: an object-literal property value (`{ x: alias } =
 * { x: outOfBand }`) and a non-literal array container reached through one
 * more `const` (`const helpers = [outOfBand]; [alias] = helpers`) both
 * vanish, because neither is one of the named operators. One narrower fix
 * after another is a loop that never ends — enumerating CONTAINER shapes
 * (object literal, array literal, ternary, logical, the next shape, …) is
 * unbounded. This function does not enumerate containers: it walks every child
 * `forEachChild` reaches, regardless of node kind, and only has to know what
 * a REFERENCE to the real helper itself looks like — three closed shapes,
 * checked at every node the walk visits. A future composing form (a spread, a
 * tagged template, a computed property with a constant-foldable key, an arrow
 * function's expression body) needs no new branch here, because the walk never
 * discriminates on the container at all — which also makes
 * `composingExpressionLeaves` above redundant for every caller that switches to
 * this function, though it stays in place for the one caller that has not
 * (`isAmbiguousOutOfBandCallee`'s own composed-CALLEE entry point). That caller
 * also reaches this function one hop further in: when its own leaf is itself a
 * `CallExpression` (`getHelper()(...)`), it calls this function on THAT call's
 * own callee, rather than re-deriving a narrower chase — see that function's
 * own header for why.
 *
 * Deliberately does not stop at a function boundary — an arrow function's
 * expression body, or a traditional function's block body, is reached by
 * `forEachChild` exactly like any other container, and this check has no
 * interprocedural model that could tell whether such a function is ever
 * actually invoked with the relevant arguments; finding a reference inside
 * one and flagging ambiguity anyway is the fail-closed direction this file
 * already always takes.
 *
 * A CALL EXPRESSION also resolves ONE HOP through its own callee's body when
 * the callee is a bare identifier naming a function declared in THIS same
 * file. Without that, `function getHelper() { return outOfBand; } let alias;
 * alias = getHelper(); alias(...)` vanishes entirely: `getHelper()` is a
 * candidate `findAssignedValues` collects, but the call expression's own
 * children (`forEachChild`) are only its callee identifier and argument
 * list — the `FunctionDeclaration` body lives elsewhere in the source tree
 * and is never syntactically reachable from the call site, so the walk finds
 * nothing and a real wrong-name call contributes to NEITHER `candidateCount`
 * NOR `anchoredCount` (`candidateCount === anchoredCount === 0` passes the
 * mandatory gate). The single-file program
 * (`createSingleFileProgram`) makes this bounded rather than a step toward
 * general interprocedural analysis: `noResolve` means an IMPORTED callee's
 * symbol never carries a `valueDeclaration` the binder can hand back, so a
 * cross-module call still resolves to nothing and stays a stated residual;
 * this closes exactly the LOCAL, single-hop case, symmetric with the
 * function-boundary paragraph above. `seen` (already threaded for the
 * cyclic-alias case) is checked and populated with the callee's OWN symbol
 * before the body walk, guarding direct and mutual recursion the identical
 * way an identifier reference already does.
 *
 * `seen` guards the same cyclic-alias case every sibling resolver in this
 * file guards, shared across the whole walk (including into
 * `couldReachRealHelperNamespace`, which this function's own member/element
 * -access branch calls, and which calls back into this function for ITS OWN
 * candidates below — the two are mutually recursive by design) so a cycle
 * reachable through either direction is caught once rather than looping.
 *
 * An identifier's own function BODY (when its declaration
 * is a `FunctionDeclaration`, or a `VariableDeclaration` whose initializer
 * is an arrow/function expression) is folded into what that identifier
 * "reaches" — checked at every identifier the walk visits, not only when
 * one happens to sit in the immediate callee position of a `CallExpression`.
 * A position-bound special case for that (`function getHelper() { return
 * outOfBand; } let alias; alias = getHelper(); alias(...)`) is defeated by
 * one more hop of indirection between the call and the function: `const
 * indirect = getHelper; let alias; alias = indirect(); alias(...)` resolves
 * `indirect` to `getHelper` through the ordinary alias-chain logic below,
 * but `indirect`'s OWN declaration is a plain identifier initializer, not
 * itself a function — so the position-bound special case never fires for
 * it, and `getHelper`'s body is never inspected at all. Folding
 * function-body lookup into ordinary identifier resolution — rather than a
 * second, call-site-shaped special case — means an ARBITRARY chain of
 * rebinds before reaching a function reference is covered by the same
 * recursion that already handles an arbitrary chain of rebinds before
 * reaching an import specifier, with no additional branch: the same "stop
 * enumerating shapes, walk uniformly" approach described above, applied to
 * position-bound special cases.
 *
 * The declaration-initializer half of identifier resolution
 * (`reaching` below) recognizes every TypeScript declaration shape that can
 * carry an expression initializer — `hasOnlyExpressionInitializer`, the
 * language's own closed `VariableDeclaration | ParameterDeclaration |
 * BindingElement | PropertyDeclaration | PropertyAssignment | EnumMember`
 * union — not `VariableDeclaration` alone. `class Holder { outOfBand =
 * outOfBand } new Holder().outOfBand(report, 'DRIVE_HELD_BY_OTHER_WORKTREE',
 * reason)` invokes the real helper through a class-instance property, but the
 * property name's own symbol resolves to a `PropertyDeclaration`, which a
 * `VariableDeclaration`-only guard silently excludes — the walk reaches the
 * `Holder` identifier and stops at its `ClassDeclaration` without inspecting
 * the `PropertyDeclaration` initializer, so neither `candidateCount` nor
 * `anchoredCount` moves. This is not one more per-shape carve-out for class
 * fields specifically: `hasOnlyExpressionInitializer` is
 * the TypeScript compiler's own enumeration of every declaration kind an
 * initializer can attach to, so the same swap closes a default parameter
 * value, a destructuring default, and an object-literal property value at
 * the identical hop, not only the class-field shape. Applied
 * identically to every sibling in this file that walks a declaration's own
 * initializer looking for a REACHABLE value rather than a durable, `const`-
 * only provenance claim — `functionBodyOfDeclaration` above,
 * `couldReachRealHelperNamespace` and `isAmbiguousOutOfBandCallee`'s own
 * identifier tail below — since all four ask the same fail-closed "could
 * this identifier's declaration reach the helper" question this function
 * does. The STRICT, `const`-gated resolvers (`resolveIdentifierImportBinding`,
 * `resolveIdentifierMemberRebind`) are deliberately NOT widened the same way:
 * they assert a durable provenance claim that only a `VariableDeclarationList`
 * carrying the `Const` flag can make, and a class field or parameter has no
 * equivalent durability guarantee to assert.
 */
function containsRealHelperReference(
  node: ts.Node,
  checker: FileChecker,
  helperModuleSpecifier: string,
  seen: Set<ResolvedSymbol> = new Set(),
): boolean {
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined || seen.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    const importSpecifier = symbol.declarations?.find(
      (d): d is ts.ImportSpecifier => ts.isImportSpecifier(d),
    );
    if (
      importSpecifier !== undefined &&
      isRealOutOfBandImportSpecifier(importSpecifier, helperModuleSpecifier)
    ) {
      return true;
    }
    const namespaceImport = symbol.declarations?.find(
      (d): d is ts.NamespaceImport => ts.isNamespaceImport(d),
    );
    if (
      namespaceImport !== undefined &&
      isRealHelperNamespaceImport(namespaceImport, helperModuleSpecifier)
    ) {
      return true;
    }
    const declaration = symbol.valueDeclaration;
    const functionBody =
      declaration !== undefined
        ? functionBodyOfDeclaration(declaration)
        : undefined;
    if (
      functionBody !== undefined &&
      containsRealHelperReference(
        functionBody,
        checker,
        helperModuleSpecifier,
        seen,
      )
    ) {
      return true;
    }
    const reaching: readonly ts.Expression[] = [
      ...(declaration !== undefined &&
      hasOnlyExpressionInitializer(declaration) &&
      declaration.initializer !== undefined
        ? [declaration.initializer]
        : []),
      ...findAssignedValues(symbol, node.getSourceFile(), checker),
    ];
    return reaching.some((r) =>
      containsRealHelperReference(r, checker, helperModuleSpecifier, seen),
    );
  }
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const memberObject = outOfBandMemberExpressionObject(node, checker);
    if (memberObject !== undefined) {
      const unwrappedObject = unwrapTransparentExpression(memberObject);
      if (
        ts.isIdentifier(unwrappedObject) &&
        couldReachRealHelperNamespace(
          unwrappedObject,
          checker,
          helperModuleSpecifier,
          seen,
        )
      ) {
        return true;
      }
    }
  }
  return (
    node.forEachChild((child) =>
      containsRealHelperReference(child, checker, helperModuleSpecifier, seen)
        ? true
        : undefined,
    ) ?? false
  );
}

/**
 * Ambiguous-side counterpart to `resolveIdentifierImportBinding`, used only
 * for the OBJECT side of a dynamic-key element access
 * (`isAmbiguousOutOfBandElementAccess` below): does `identifier` — through a
 * same-scope alias chain that follows every reaching value, a declaration's
 * own initializer AND every later assignment (`findAssignedValues` above),
 * not declaration initializers alone — ultimately reach a real
 * `NamespaceImport` of `helperModuleSpecifier`? Deliberately does NOT
 * require the chain to be `const`, for the identical reason
 * `isAmbiguousOutOfBandCallee` below does not: a RESOLVED verdict must trust
 * only a durable binding, but an AMBIGUOUS one only needs to say "cannot
 * rule out" — `let ns = decoyModule; ns = terminalStates;
 * ns[computeKey()](...)` reassigns the real namespace onto a `let` binding
 * with no CONST chain for `resolveIdentifierImportBinding` to ever follow.
 * The declaration checked below is `hasOnlyExpressionInitializer`, not
 * `VariableDeclaration` alone — see `containsRealHelperReference`'s own
 * declaration-initializer note for the class of gap this closes.
 */
function couldReachRealHelperNamespace(
  identifier: ts.Identifier,
  checker: FileChecker,
  helperModuleSpecifier: string,
  seen: Set<ResolvedSymbol> = new Set(),
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);
  const importBinding = symbol.declarations?.find(
    (d): d is ts.NamespaceImport => ts.isNamespaceImport(d),
  );
  if (
    importBinding !== undefined &&
    isRealHelperNamespaceImport(importBinding, helperModuleSpecifier)
  ) {
    return true;
  }
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined || !hasOnlyExpressionInitializer(declaration)) {
    return false;
  }
  const candidates: readonly ts.Expression[] = [
    ...(declaration.initializer !== undefined ? [declaration.initializer] : []),
    ...findAssignedValues(symbol, declaration.getSourceFile(), checker),
  ];
  return candidates.some((candidate) =>
    containsRealHelperReference(
      candidate,
      checker,
      helperModuleSpecifier,
      seen,
    ),
  );
}

/**
 * Is `expr` an ELEMENT-ACCESS expression whose key this scan cannot
 * POSITIVELY resolve to the literal `'outOfBand'` — not a string literal
 * naming it, and not an identifier that resolves, through a same-scope CONST
 * chain, to that literal (`resolveIdentifierStringLiteral`) — on an OBJECT
 * side that could reach, through any assignment as well as its declaration
 * (`couldReachRealHelperNamespace` above), the real `outOfBand` helper's
 * namespace import?
 *
 * This is the fail-closed counterpart to `outOfBandMemberExpressionObject`,
 * not one more entry in its resolvable-forms enumeration (a hand-rolled
 * resolution model stays one counterexample behind, so it fails closed).
 * The residual covers a key with NO LITERAL anywhere in its syntax (a
 * function call, a template literal with interpolation), and equally an
 * IDENTIFIER key this scan cannot resolve to any literal at all (a function
 * parameter, a destructured value, a `let`-bound key): excluding every
 * identifier key unconditionally, rather than only when resolution actually
 * succeeds, would reproduce the same vacuous pass one case narrower. The
 * OBJECT side has the same shape one hop later: resolving it through
 * `resolveIdentifierImportBinding`, which requires a CONST chain, makes a
 * `let`-declared namespace alias populated by a later assignment rather than
 * its own initializer resolve to nothing and vanish from the census —
 * `couldReachRealHelperNamespace` closes that by following assignments too.
 * Both residuals collapse to the same rule: ANY key this scan cannot
 * positively resolve to `'outOfBand'` — whichever syntax it is written in —
 * on an object that COULD REACH the real helper's namespace, is treated by
 * the caller as a candidate that can never anchor — reusing the existing
 * `candidateCount`/`anchoredCount` coverage cross-check
 * (`scanOutOfBandNamePairings` below) to fail closed, rather than inventing a
 * parallel verdict.
 *
 * A key that DOES positively resolve — to `'outOfBand'` or to any other
 * literal — is excluded here on purpose: `outOfBandMemberExpressionObject`
 * already gives the `'outOfBand'` case its own, non-ambiguous verdict (a real
 * candidate, anchored and name-checked elsewhere), and a key resolving to a
 * *different* literal definitively is not this call at all. Only "no literal
 * to trace" or "the trace target is a mutable/unresolvable declaration" stays
 * ambiguous — `resolveIdentifierStringLiteral` itself withholds resolution
 * for a `let`-bound key rather than trusting a value that can change out from
 * under it, which is exactly why that shape reads as ambiguous here
 * instead of vanishing silently excluded.
 *
 * The OBJECT side does not require a plain identifier
 * (`ts.isIdentifier(unwrappedObject)`) before chasing it: with that gate, a
 * real helper invocation on a non-identifier object contributes neither a
 * candidate nor an anchor and `runCheck()` passes vacuously. A
 * non-identifier object — `getNamespace()[computeKey()]` — falls back to
 * `containsRealHelperReference`, the same generic reachability walk that
 * already covers this shape for the sibling function.
 */
function isAmbiguousOutOfBandElementAccess(
  expr: ts.Expression,
  checker: FileChecker,
  helperModuleSpecifier: string,
): boolean {
  if (!ts.isElementAccessExpression(expr)) {
    return false;
  }
  const key = unwrapTransparentExpression(expr.argumentExpression);
  if (ts.isStringLiteralLikeNode(key)) {
    return false;
  }
  if (
    ts.isIdentifier(key) &&
    resolveIdentifierStringLiteral(key, checker) !== undefined
  ) {
    return false;
  }
  const unwrappedObject = unwrapTransparentExpression(expr.expression);
  return ts.isIdentifier(unwrappedObject)
    ? couldReachRealHelperNamespace(
        unwrappedObject,
        checker,
        helperModuleSpecifier,
      )
    : containsRealHelperReference(
        unwrappedObject,
        checker,
        helperModuleSpecifier,
      );
}

/**
 * Does `expr` — after following a same-scope identifier through however many
 * hops of its own declaration initializer AND every later assignment
 * (`findAssignedValues` above), without requiring `const` — reach something
 * that COULD be the real `outOfBand` helper? Symmetric to the STRICT resolver
 * (`resolveOutOfBandImportProvenance` below): every terminal shape that
 * resolver recognizes is checked here too, minus its `const` requirement, so
 * an ambiguous (non-`const`, or order-dependent) chain to ANY of them is
 * caught — rather than one more narrow branch for whichever shape the latest
 * counterexample happened to name.
 *
 * The terminal shapes, checked in this order:
 *
 *   1. A DEFINITE `.outOfBand` member access — property (`ns.outOfBand`) or
 *      element keyed by a literal (or CONST-resolvable) `'outOfBand'`
 *      (`outOfBandMemberExpressionObject` above) — is ambiguous when its
 *      OBJECT side could reach the real helper namespace through any
 *      alias/reassignment chain (`couldReachRealHelperNamespace` above).
 *   2. An element access whose KEY this scan cannot positively resolve to any
 *      literal at all is ambiguous on the same object-side condition
 *      (`isAmbiguousOutOfBandElementAccess` above).
 *   3. A bare identifier reaching the real `outOfBand` IMPORT SPECIFIER
 *      directly — no member access at all (`let alias; alias = outOfBand;
 *      alias(…)`) — is ambiguous the instant any reaching value names it.
 *   4. A `CallExpression` LEAF — the callee position itself
 *      holds a call, not a reference (`getHelper()(...)`) — is ambiguous
 *      when INVOKING it might reach the helper: check the call's own
 *      callee, unwrapped, through `containsRealHelperReference` (above),
 *      the same "does this reachable value's function body return the
 *      helper" walk that value-position callers already get. Deliberately
 *      NOT the same as shape 3's chase: shape 3 asks whether `resolved`
 *      ITSELF denotes the helper (so a bare identifier naming a LOCAL
 *      function is excluded on purpose — invoking that identifier directly
 *      runs the function's OWN body, which does not itself invoke the
 *      helper merely because it references or returns one); shape 4 asks
 *      whether invoking `resolved`'s callee — which this leaf's own call
 *      already does, as part of producing the value that the OUTER call
 *      then invokes — reaches it. Conflating the two, by routing `resolved`
 *      itself (rather than its callee) through `containsRealHelperReference`
 *      for every non-member/non-element shape, flags a `getHelper()` call as
 *      ambiguous merely for locally declaring a function whose body
 *      references the helper, never actually reaching it through that one
 *      call alone (guarded by the over-triggering tests: "a static class
 *      method returning only an UNRELATED decoy produces no candidate", and
 *      the single-candidate count for the FIRST of the two calls in
 *      `alias = getHelper(); alias(...)`).
 *
 * Shape 2 covers `const alias = terminalStates[computeKey()]; alias(...)`,
 * an ordinary bare-identifier callee that a direct
 * `isAmbiguousOutOfBandElementAccess` call alone cannot see, and the reach
 * extends from declaration initializers to every later assignment too
 * (`let alias: typeof terminalStates.outOfBand; alias =
 * terminalStates[computeKey()]; alias(...)` has no declaration initializer
 * at all). Shapes 1 and 3 cover ordinary static assignments of the real
 * helper: `alias = outOfBand`, and `alias = terminalStates.outOfBand`, which
 * reaches a property access that is neither an ambiguous dynamic element
 * access nor an identifier. Rather than independent branches, this checks
 * every terminal shape the strict resolver checks, so a new counterexample
 * would have to be a shape `resolveOutOfBandImportProvenance` itself does
 * not recognize either — at which point both resolvers need the identical
 * new shape together, not just this one.
 *
 * Deliberately does NOT require any rebind to be `const`, unlike every
 * strict sibling resolver in this file: a RESOLVED verdict asserts "this call
 * reliably reaches the real helper" and must not trust a reassignable
 * binding, but an AMBIGUOUS verdict only asserts "this scan cannot rule out
 * that it does" — a `let` rebind or a later assignment cannot make that
 * assertion any less true. `seen` guards the same cyclic-alias case every
 * sibling resolver here guards.
 *
 * More terminal shapes: `composingExpressionLeaves` at
 * entry expands a `?:`/`||`/`&&`/`??` callee — directly, or reached through
 * a reassignment `findAssignedValues` collected — into every branch/operand
 * it could evaluate to, so `alias = flag ? outOfBand : decoy; alias(...)`
 * checks BOTH `outOfBand` and `decoy` rather than stopping at the
 * `ConditionalExpression` node itself. And a candidate that resolves to the
 * real helper's own NAMESPACE IMPORT (not a member access on it — the raw
 * namespace, as `findAssignedValues` pushes whenever a destructuring
 * pattern it cannot precisely map, such as a computed key, might have
 * extracted `.outOfBand` from it) is itself treated as ambiguous: `alias`
 * might now hold any property of that namespace, `outOfBand` included, and
 * this scan cannot rule that out any more than the direct member-access
 * branch above can.
 *
 * A leaf that is itself a `CallExpression` — the callee position holds a
 * CALL, not a reference (`function getHelper() { return outOfBand; }
 * getHelper()(report, 'DRIVE_HELD_BY_OTHER_WORKTREE', reason)` — the outer
 * call's own callee is `getHelper()`) — would otherwise fall straight to
 * `!ts.isIdentifier(resolved) → return false`, contributing to NEITHER
 * `candidateCount` NOR `anchoredCount`: strict provenance rejects that
 * shape, and expanding only conditional/logical expressions returns false
 * for any non-identifier/non-member expression. Rather than one more
 * position-bound special case, this routes through the same general machine:
 * a `CallExpression` leaf delegates to `containsRealHelperReference` on its
 * own callee (unwrapped) rather than a hand-rolled branch — the identical
 * "does this reachable value's function body return the helper" question
 * that function already answers for every value-position caller, applied
 * here to the one call this leaf itself makes on the way to producing
 * whatever the OUTER call then invokes.
 *
 * The same `CallExpression` leaf ALSO checks its own ARGUMENTS, not only its
 * callee: `(await Promise.resolve(outOfBand))(report, name, reason)` produces
 * its value by returning one of `Promise.resolve`'s own ARGUMENTS unchanged,
 * not by invoking `Promise.resolve` itself or anything `Promise.resolve`'s
 * own body references. This scanner has no way to know, in general, WHICH
 * functions forward one of their arguments into their return value and which
 * compute something unrelated — that is exactly the "no interprocedural model"
 * residual this file states elsewhere. But per this file's own stated
 * philosophy (`assignmentPatternBindsSymbol`'s header: "over-matching... only
 * WIDENS the ambiguous census — the fail-closed direction this file already
 * always takes"), NOT knowing which functions forward an argument is not a
 * reason to skip every argument — it is a reason to conservatively treat EVERY
 * argument of EVERY call-producing-a-value leaf as a candidate, exactly as the
 * callee already is. This over-approximates (a call passing the helper as an
 * argument to a function that never returns it becomes an unanchored candidate,
 * not a false negative) rather than under-approximates (silently missing a real
 * invocation) — the safe direction this whole file has always taken, so it
 * needs no new special case for `Promise.resolve` specifically, or for any
 * other single function.
 *
 * This is deliberately NARROWER than routing every non-member/non-element
 * shape (in particular, a bare identifier) through
 * `containsRealHelperReference`: a bare identifier naming a LOCAL function
 * directly (`getHelper(...)`, no intervening alias, no second call) is
 * invoking THAT function, executing its OWN body — which does not itself
 * invoke the helper merely because it references or returns one — so routing
 * it through the value-position "does this identifier's own function body
 * reach the helper" check would flag the identifier's OWN single,
 * otherwise-innocuous call as a second, spurious candidate. Two standing
 * guards cover exactly this failure mode: the candidateCount of 1 (not 2)
 * for `alias = getHelper(); alias(...)`, and the over-triggering guard
 * ("returning only an UNRELATED decoy produces no candidate at all"). The
 * `CallExpression` case above avoids that trap
 * because it checks the CALL's own callee (`getHelper`), not `resolved`
 * (`getHelper()`) itself — the callee's function body is genuinely what
 * executes when `resolved` is invoked, which is exactly the question this
 * leaf needs answered; a bare identifier `resolved` used directly as the
 * OUTER callee has no such second hop, and keeps the narrower
 * identifier chase (import specifier / namespace import / reaching values —
 * never the identifier's own function body) below.
 *
 * The member-object branch immediately below has an unrelated dimension the
 * paragraphs above do not reach: it does not ask what the OUTER callee
 * invokes, but what the `.outOfBand` access's own OBJECT evaluates to
 * (`ns` in `ns.outOfBand(...)`). Requiring that object to be a plain
 * identifier would make `getNamespace().outOfBand(report, 'WRONG_STATE',
 * reason)` — object side is the CallExpression `getNamespace()` — fall
 * straight to `false`, contributing to NEITHER `candidateCount` NOR
 * `anchoredCount`, so a real helper invocation passes `runCheck()`
 * vacuously. Unlike the OUTER-callee identifier case two paragraphs above,
 * there is no "invoking this directly runs its own body" trap to avoid here:
 * a non-identifier object is never itself invoked, only read and then
 * property-accessed, so routing it through `containsRealHelperReference`
 * unconditionally — the same general reachability walk, applied to the whole
 * object expression rather than one hop of it — asks exactly the right
 * question ("could evaluating this expression produce the real namespace")
 * with no shape-specific branch needed: that function's own fallback already
 * recurses into whatever it is given.
 *
 * `class Holder { outOfBand = outOfBand } new Holder().outOfBand(report,
 * 'DRIVE_HELD_BY_OTHER_WORKTREE', reason)` needs two more pieces, or neither
 * `candidateCount` nor `anchoredCount` moves (the walk reaches the `Holder`
 * identifier and stops at its `ClassDeclaration` without inspecting the
 * `PropertyDeclaration` initializer). First, the tail identifier chase below
 * recognizes every declaration shape `hasOnlyExpressionInitializer` covers
 * (`VariableDeclaration | ParameterDeclaration | BindingElement |
 * PropertyDeclaration | PropertyAssignment | EnumMember`), not
 * `VariableDeclaration` alone — see `containsRealHelperReference`'s own
 * declaration-initializer note for the full rationale, shared verbatim by
 * every sibling walk in this file. Second, the accessed PROPERTY must be
 * asked about, not only the object: asking only "does the OBJECT reach the
 * real terminal-states NAMESPACE" is the right question for `ns.outOfBand`
 * where `ns` is-or-reaches the namespace, but not for `new
 * Holder().outOfBand` at all: `new Holder()` never reaches the namespace,
 * because the alias lives one hop deeper, on the PROPERTY itself
 * (`outOfBand = outOfBand` in the class body).
 *
 * The property question is not the object's value question, though. Routing
 * the WHOLE resolved member expression through `containsRealHelperReference`
 * means its generic `forEachChild` fallback also visits the `.name` child,
 * and for an identifier — which a property name always is —
 * `containsRealHelperReference` unconditionally walks the referenced
 * symbol's own FUNCTION BODY (`functionBodyOfDeclaration`), not merely its
 * reaching values. That is exactly right for the OBJECT side (a value
 * question: "could evaluating this expression PRODUCE the real namespace",
 * where a call like `getNamespace()` legitimately needs its callee's body
 * inspected) but exactly wrong for the PROPERTY side when this whole
 * expression is itself about to be INVOKED: `class Holder { outOfBand(...args)
 * { return outOfBand; } } new Holder().outOfBand(report, name, reason)`
 * invokes only `Holder.prototype.outOfBand`, executing that METHOD's own
 * body — it does not invoke whatever the method merely references or
 * returns. This is the member-access shape of the identical invariant
 * stated for a bare identifier in direct callee position (two paragraphs
 * up: "invoking THAT function, executing its OWN body — which does not
 * itself invoke the helper merely because it references or returns one").
 *
 * So the member-object branch below asks the OBJECT and PROPERTY questions
 * separately instead of routing the whole expression through one call:
 * `containsRealHelperReference` on the object alone (the right,
 * value-question tool — covers `ns.outOfBand` and
 * `getNamespace().outOfBand`), and `couldDirectInvocationReachHelper` — the
 * DIRECT-INVOCATION counterpart, shared with this function's own identifier
 * tail below — on the accessed property's symbol
 * (`outOfBandMemberPropertySymbol`, covering both the `.outOfBand` and
 * computed-literal-key forms). That shared resolver gates on
 * `valueProducedByMereAccess` — a data declaration's initializer, or a get
 * accessor's own body — which is what makes the class-field case, the
 * method case and the getter case all
 * fall out of the SAME check rather than needing a method-vs-field-vs-getter
 * special case: a `PropertyDeclaration` (`outOfBand = outOfBand`) or a get
 * accessor (`get outOfBand() { return outOfBand; }`) both produce a value on
 * mere access, so their value is chased for a real reference; a
 * `MethodDeclaration` produces neither — accessing it yields the method
 * value itself, not whatever its body references or returns — so it is
 * excluded from candidacy without ever inspecting its body. The same "stop
 * enumerating shapes, route through the general machine" move, applied to
 * the one general machine (the direct-invocation resolver) that draws
 * this exact line for the bare-identifier case.
 */
/**
 * The symbol denoted by the PROPERTY a definite `.outOfBand` access reads —
 * `expr.name`'s own symbol for a `PropertyAccessExpression`
 * (`ns.outOfBand`), or the object type's `'outOfBand'` member for an
 * `ElementAccessExpression` with a resolved literal key (`ns['outOfBand']`,
 * `ns[ALIAS_RESOLVING_TO_THAT_LITERAL]`) — or `undefined` when `expr` is
 * neither shape, or the property cannot be resolved (an unresolved
 * cross-module type under this file's `noResolve` single-file program, most
 * commonly). Callers are expected to have already confirmed `expr` IS a
 * definite `.outOfBand` access (`outOfBandMemberExpressionObject(expr,
 * checker) !== undefined`); this function re-derives the node kind itself
 * rather than trusting a narrowed caller type, matching
 * `outOfBandMemberExpressionObject`'s own pattern.
 */
function outOfBandMemberPropertySymbol(
  expr: ts.Expression,
  checker: FileChecker,
): ResolvedSymbol | undefined {
  if (ts.isPropertyAccessExpression(expr)) {
    return checker.getSymbolAtLocation(expr.name);
  }
  if (ts.isElementAccessExpression(expr)) {
    return checker.getOutOfBandPropertyOfType(expr.expression);
  }
  return undefined;
}

/**
 * Does DIRECTLY INVOKING `symbol` — as the resolved callee itself, or as a
 * definite `.outOfBand` access's own accessed property, immediately before
 * that property is called — potentially reach the real helper? The
 * DIRECT-INVOCATION counterpart to `containsRealHelperReference`'s VALUE
 * question ("could evaluating this expression produce the real
 * helper/namespace"): chases `valueProducedByMereAccess` rather than
 * `functionBodyOfDeclaration`, because invoking a function-like declaration
 * directly runs THAT declaration's own body — it does not itself invoke
 * whatever the body merely references or returns (the same holds for the
 * sibling member-access shape; see `valueProducedByMereAccess`'s own header
 * for the one function-like kind that rationale does NOT cover, and why a
 * get accessor is a closed exception rather than a widening of the
 * exclusion). Checks import specifier and namespace import (meaningful only
 * for a genuine identifier's symbol — never matches a class/object property,
 * but harmless to check unconditionally), then every value
 * `valueProducedByMereAccess` names (a data declaration's initializer, or a get
 * accessor's own body) plus every later assignment, each chased through the
 * GENERAL `containsRealHelperReference` — a VALUE question about what that
 * access evaluates to, not a further direct-invocation question. A
 * `MethodDeclaration` (or any other function-like declaration besides a get
 * accessor) is excluded from candidacy here without a dedicated method-vs-field
 * branch: the same check that recognizes a `PropertyDeclaration` field alias
 * and a get-accessor field naturally excludes a `MethodDeclaration` that merely
 * returns the helper.
 */
function couldDirectInvocationReachHelper(
  symbol: ResolvedSymbol,
  checker: FileChecker,
  helperModuleSpecifier: string,
  seen: Set<ResolvedSymbol>,
): boolean {
  if (seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);
  const importSpecifier = symbol.declarations?.find(
    (d): d is ts.ImportSpecifier => ts.isImportSpecifier(d),
  );
  if (
    importSpecifier !== undefined &&
    isRealOutOfBandImportSpecifier(importSpecifier, helperModuleSpecifier)
  ) {
    return true;
  }
  const namespaceImport = symbol.declarations?.find(
    (d): d is ts.NamespaceImport => ts.isNamespaceImport(d),
  );
  if (
    namespaceImport !== undefined &&
    isRealHelperNamespaceImport(namespaceImport, helperModuleSpecifier)
  ) {
    return true;
  }
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    (!hasOnlyExpressionInitializer(declaration) &&
      !ts.isGetAccessorDeclaration(declaration))
  ) {
    return false;
  }
  // The gate above is deliberately a DECLARATION-KIND question ("is this a
  // kind that could ever produce a value on mere access"), separate from
  // `valueProducedByMereAccess` below ("what value does THIS declaration
  // produce right now"): `let alias;` with no initializer still satisfies
  // `hasOnlyExpressionInitializer` by kind, and must still fall through to
  // `findAssignedValues` for a LATER `alias = getHelper();` (the
  // call-through-local-callee fixtures). Returning early whenever
  // `valueProducedByMereAccess` itself is `undefined` would silently skip that
  // later-assignment case — do not fold the two questions back into one.
  const accessedValue = valueProducedByMereAccess(declaration);
  const candidates: readonly ts.Node[] = [
    ...(accessedValue !== undefined ? [accessedValue] : []),
    ...findAssignedValues(symbol, declaration.getSourceFile(), checker),
  ];
  return candidates.some((candidate) =>
    containsRealHelperReference(
      candidate,
      checker,
      helperModuleSpecifier,
      seen,
    ),
  );
}

function isAmbiguousOutOfBandCallee(
  expr: ts.Expression,
  checker: FileChecker,
  helperModuleSpecifier: string,
  seen: Set<ResolvedSymbol> = new Set(),
): boolean {
  const leaves = composingExpressionLeaves(expr);
  if (leaves.length !== 1) {
    return leaves.some((leaf) =>
      isAmbiguousOutOfBandCallee(leaf, checker, helperModuleSpecifier, seen),
    );
  }
  const [resolved] = leaves;
  if (resolved === undefined) return false;
  const memberObject = outOfBandMemberExpressionObject(resolved, checker);
  if (memberObject !== undefined) {
    const unwrappedObject = unwrapTransparentExpression(memberObject);
    if (
      containsRealHelperReference(
        unwrappedObject,
        checker,
        helperModuleSpecifier,
        seen,
      )
    ) {
      return true;
    }
    const propertySymbol = outOfBandMemberPropertySymbol(resolved, checker);
    return (
      propertySymbol !== undefined &&
      couldDirectInvocationReachHelper(
        propertySymbol,
        checker,
        helperModuleSpecifier,
        seen,
      )
    );
  }
  if (
    isAmbiguousOutOfBandElementAccess(resolved, checker, helperModuleSpecifier)
  ) {
    return true;
  }
  if (ts.isCallExpression(resolved)) {
    if (
      containsRealHelperReference(
        unwrapTransparentExpression(resolved.expression),
        checker,
        helperModuleSpecifier,
        seen,
      )
    ) {
      return true;
    }
    return resolved.arguments.some((arg) =>
      containsRealHelperReference(
        unwrapTransparentExpression(arg),
        checker,
        helperModuleSpecifier,
        seen,
      ),
    );
  }
  if (!ts.isIdentifier(resolved)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(resolved);
  if (symbol === undefined) {
    return false;
  }
  return couldDirectInvocationReachHelper(
    symbol,
    checker,
    helperModuleSpecifier,
    seen,
  );
}

/**
 * Follows `identifier` to the import binding it ultimately denotes — a
 * direct `ImportSpecifier` (`import { outOfBand } from …`, including its
 * renamed spelling `import { outOfBand as reportOutOfBand } from …`, since
 * an ImportSpecifier's OWN declaration already carries that rename via
 * `propertyName`), a `NamespaceImport` (`import * as terminalStates from
 * …`, for the property-access callee shape below to check), or `undefined`
 * if neither. Recurses through a same-scope CONST alias chain (`const
 * reportOutOfBand = outOfBand; … reportOutOfBand(…)`) — the identical
 * pattern `resolveIdentifierLiteral` above already uses for exit-code
 * literals, applied to import bindings instead of numeric ones — because a
 * LOCAL rebind is a different shape from a renaming import: `reportOutOfBand`
 * here is `reportOutOfBand`'s OWN `VariableDeclaration`, not an
 * `ImportSpecifier`, so the direct check alone cannot see through it.
 * `seen` guards the same cyclic-alias case `resolveIdentifierLiteral`
 * guards.
 *
 * The rebind's declaration list must actually carry the `Const` flag — a
 * `let`-declared alias is reassignable, so its declared initializer is not a
 * durable provenance claim: `let alias = outOfBand; alias = decoy;
 * alias(…)` would otherwise still resolve from the stale initializer to the
 * real import even though the call now reaches `decoy` (this is what makes
 * the "CONST alias chain" above true). The initializer is also unwrapped of
 * transparent parens before the identifier check, for the same reason as the
 * callee itself.
 */
function resolveIdentifierImportBinding(
  identifier: ts.Identifier,
  checker: FileChecker,
  seen: Set<ResolvedSymbol> = new Set(),
): ts.ImportSpecifier | ts.NamespaceImport | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || seen.has(symbol)) {
    return undefined;
  }
  seen.add(symbol);
  const importBinding = symbol.declarations?.find(
    (d): d is ts.ImportSpecifier | ts.NamespaceImport =>
      ts.isImportSpecifier(d) || ts.isNamespaceImport(d),
  );
  if (importBinding !== undefined) {
    return importBinding;
  }
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  return ts.isIdentifier(initializer)
    ? resolveIdentifierImportBinding(initializer, checker, seen)
    : undefined;
}

/**
 * Does the object side of a namespace-member rebind (`ns` in `const alias =
 * ns.outOfBand`, or in a destructure's own source) resolve, via a same-scope
 * CONST alias chain, to a real `NamespaceImport` of `helperModuleSpecifier`?
 * Shared by both terminal shapes `resolveIdentifierMemberRebind` below
 * recognizes, since a rebind and a destructure both reduce to "does the
 * SOURCE object name the real helper module" once the member/property name
 * itself is confirmed to be `outOfBand`.
 */
function resolvesToRealHelperNamespace(
  objectExpr: ts.Expression,
  checker: FileChecker,
  helperModuleSpecifier: string,
): boolean {
  const unwrapped = unwrapTransparentExpression(objectExpr);
  if (!ts.isIdentifier(unwrapped)) {
    return false;
  }
  const binding = resolveIdentifierImportBinding(unwrapped, checker);
  return (
    binding !== undefined &&
    ts.isNamespaceImport(binding) &&
    isRealHelperNamespaceImport(binding, helperModuleSpecifier)
  );
}

/**
 * Does bare identifier `identifier` — through a same-scope CONST alias chain,
 * exactly like `resolveIdentifierImportBinding` above — ultimately rebind a
 * `ns.outOfBand` / `ns['outOfBand']` member access naming the real helper,
 * OR ultimately destructure it (`const { outOfBand: alias } =
 * terminalStates; alias(…)`, mirroring `bindingElementPropertyName` /
 * `resolvesToCodePropertyAccess`'s own established destructuring-alias
 * pattern for `.code`, applied to `outOfBand` instead)? Both are a distinct
 * terminal shape from `resolveIdentifierImportBinding`'s own chain: neither
 * reduces to an `ImportSpecifier` or `NamespaceImport` through
 * identifier-to-identifier aliasing alone, since the member/destructured
 * access itself is the last hop before the binding it names — this walks the
 * identical CONST chain but stops to check those shapes at each step
 * instead. Unlike `resolvesToCodePropertyAccess`'s destructuring branch, the
 * SOURCE object is verified too (`resolvesToRealHelperNamespace` above) —
 * that function only needs "was this destructured from ANY object", but this
 * one must exclude a same-named decoy's own `outOfBand` property, exactly
 * like the member-access branch below already does.
 */
function resolveIdentifierMemberRebind(
  identifier: ts.Identifier,
  checker: FileChecker,
  helperModuleSpecifier: string,
  seen: Set<ResolvedSymbol> = new Set(),
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) {
    return false;
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent) &&
    bindingElementPropertyName(declaration) === "outOfBand" &&
    ts.isVariableDeclaration(declaration.parent.parent) &&
    declaration.parent.parent.initializer !== undefined &&
    ts.isVariableDeclarationList(declaration.parent.parent.parent) &&
    (declaration.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return resolvesToRealHelperNamespace(
      declaration.parent.parent.initializer,
      checker,
      helperModuleSpecifier,
    );
  }
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  const initializer = unwrapTransparentExpression(declaration.initializer);
  const objectExpr = outOfBandMemberExpressionObject(initializer, checker);
  if (objectExpr !== undefined) {
    return resolvesToRealHelperNamespace(
      objectExpr,
      checker,
      helperModuleSpecifier,
    );
  }
  return ts.isIdentifier(initializer)
    ? resolveIdentifierMemberRebind(
        initializer,
        checker,
        helperModuleSpecifier,
        seen,
      )
    : false;
}

/** Does `specifier` name the real `outOfBand` export of `helperModuleSpecifier`
 * — checked via `propertyName` first (a renamed import's own local `name` is
 * irrelevant to what it imports), never by local identifier text? */
function isRealOutOfBandImportSpecifier(
  specifier: ts.ImportSpecifier,
  helperModuleSpecifier: string,
): boolean {
  const importedName = (specifier.propertyName ?? specifier.name).text;
  if (importedName !== "outOfBand") {
    return false;
  }
  const importDeclaration = specifier.parent.parent.parent;
  return (
    ts.isImportDeclaration(importDeclaration) &&
    ts.isStringLiteralLikeNode(importDeclaration.moduleSpecifier) &&
    importDeclaration.moduleSpecifier.text === helperModuleSpecifier
  );
}

/** Does `namespaceImport` bind the module named `helperModuleSpecifier` —
 * the object-side check for a namespace-qualified call
 * (`terminalStates.outOfBand(…)`) below? */
function isRealHelperNamespaceImport(
  namespaceImport: ts.NamespaceImport,
  helperModuleSpecifier: string,
): boolean {
  const importDeclaration = namespaceImport.parent.parent;
  return (
    ts.isImportDeclaration(importDeclaration) &&
    ts.isStringLiteralLikeNode(importDeclaration.moduleSpecifier) &&
    importDeclaration.moduleSpecifier.text === helperModuleSpecifier
  );
}

/**
 * Does `call`'s callee resolve, through IMPORT PROVENANCE, to the REAL
 * `outOfBand` export of `helperModuleSpecifier` — symbol-resolved rather
 * than name-text matched, the same discipline `isExitCodeHelperCall`
 * applies to `driverOnlyExitCode`/`outOfBandExitCode`? Deliberately the ONLY
 * axis this checks: arity and the `name` argument's shape are
 * `resolveOutOfBandCallStateName`'s job, layered on top, because
 * `scanOutOfBandNamePairings`'s `candidateCount` census needs exactly this
 * axis and no more (see its own header) — conflating the two would
 * silently narrow the census the moment either check tightens.
 *
 * The callee is first unwrapped of transparent parens
 * (`unwrapTransparentExpression`, so `(outOfBand)(…)` anchors identically to
 * `outOfBand(…)`), then dispatched on shape, both resolved through
 * `resolveIdentifierImportBinding` above rather than duplicating its
 * alias-chain logic:
 *
 *   - A bare identifier (`outOfBand(…)`, an aliased import
 *     (`reportOutOfBand(…)` from `import { outOfBand as reportOutOfBand }`),
 *     or a local CONST rebind of either (`const alias = outOfBand;
 *     alias(…)`) — must resolve to a real `ImportSpecifier` naming
 *     `outOfBand` from `helperModuleSpecifier`. Failing that, it may still be
 *     a local CONST rebind of the member-access shape below
 *     (`resolveIdentifierMemberRebind`: `const alias =
 *     terminalStates.outOfBand; alias(…)`).
 *   - A member access naming `outOfBand` — a property access
 *     (`terminalStates.outOfBand(…)`), an element access keyed by the string
 *     literal `terminalStates['outOfBand'](…)`, or an element access keyed
 *     by a CONST identifier that itself resolves to that string literal
 *     (`terminalStates[key](…)` where `const key = 'outOfBand' as const`;
 *     `outOfBandMemberExpressionObject` above) — the OBJECT side must resolve
 *     to a `NamespaceImport` of `helperModuleSpecifier`. A non-identifier
 *     object expression (`getModule.outOfBand(…)`, `this.outOfBand(…)`) is a
 *     stated residual, the same posture `resolvesToLocalReporter` already takes
 *     for its own non-identifier-callee residual above.
 *
 * Getting this axis right cuts multiple ways.
 * Resolving by import IDENTITY rather than local text is what lets an
 * ALIASED or REBOUND real call still be recognized at all — pure text
 * matching misses every one of these, so a real, mis-anchored call written
 * through any of them produces a false "all clear" (nothing to see, because
 * nothing is ever counted). Requiring import identity in the first place is
 * what EXCLUDES a same-named decoy imported from an unrelated module — text
 * matching counts it as a real candidate that the strict check then
 * (rightly) refuses to anchor, so a harmless decoy alone fails the
 * mandatory gate's coverage cross-check. Both member-access shapes preserve
 * that: neither widens acceptance beyond "resolves, by import identity, to the
 * real helper" — they only widen which SYNTAX can reach that resolution.
 */
function resolveOutOfBandImportProvenance(
  call: ts.CallExpression,
  checker: FileChecker,
  helperModuleSpecifier: string,
): boolean {
  const callee = unwrapTransparentExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const binding = resolveIdentifierImportBinding(callee, checker);
    if (
      binding !== undefined &&
      ts.isImportSpecifier(binding) &&
      isRealOutOfBandImportSpecifier(binding, helperModuleSpecifier)
    ) {
      return true;
    }
    return resolveIdentifierMemberRebind(
      callee,
      checker,
      helperModuleSpecifier,
    );
  }
  const objectExpr = outOfBandMemberExpressionObject(callee, checker);
  if (objectExpr !== undefined) {
    const unwrappedObject = unwrapTransparentExpression(objectExpr);
    if (ts.isIdentifier(unwrappedObject)) {
      const binding = resolveIdentifierImportBinding(unwrappedObject, checker);
      return (
        binding !== undefined &&
        ts.isNamespaceImport(binding) &&
        isRealHelperNamespaceImport(binding, helperModuleSpecifier)
      );
    }
  }
  return false;
}

/**
 * Does `call` invoke the REAL `outOfBand` helper (import provenance, via
 * `resolveOutOfBandImportProvenance` above) — and if so, what
 * string-literal state name is its `name` argument (`outOfBand(report,
 * name, reason)`'s second parameter)? A same-named decoy imported from
 * elsewhere, a call with too few arguments to carry one, or a non-literal
 * `name` argument (a computed name is a documented residual, not a
 * regression — the same "not resolved through a computed value" posture
 * `isCodePropertyAccess` already carries) all resolve to `undefined`.
 * Checks `< 2` (enough arguments to carry a `name`), not `!== 3`: a future
 * optional 4th parameter on `outOfBand` itself must not silently blind
 * this scan at every real call site at once.
 */
function resolveOutOfBandCallStateName(
  call: ts.CallExpression,
  checker: FileChecker,
  helperModuleSpecifier: string,
):
  | { readonly nameArg: ts.StringLiteralLikeNode; readonly stateName: string }
  | undefined {
  if (call.arguments.length < 2) {
    return undefined;
  }
  const nameArg = call.arguments[1];
  if (nameArg === undefined || !ts.isStringLiteralLikeNode(nameArg)) {
    return undefined;
  }
  if (!resolveOutOfBandImportProvenance(call, checker, helperModuleSpecifier)) {
    return undefined;
  }
  return { nameArg, stateName: nameArg.text };
}

/**
 * The full scan result: every call resolving, by IMPORT PROVENANCE, to the
 * real `outOfBand` helper (`candidateCount` — a BROADER recognizer than the
 * strict scan below, so the census does not depend on the check it audits: it
 * shares only the import-provenance axis, never the arity/literal-name/dispatch
 * axes the strict scan additionally requires), how many of those actually
 * anchored to a recognized `if (X.code === IDENT)` dispatch (`anchoredCount`),
 * and which of those anchored calls named the WRONG sibling state
 * (`mismatches`).
 *
 * `candidateCount`/`anchoredCount` exist so `runCheck` can assert that
 * EVERY real `outOfBand` call was actually verified (a gate that verified
 * nothing must fail, not pass) — `mismatches` alone cannot tell
 * "every real call site is correctly paired" apart from "this scan silently
 * failed to anchor some of them", and several plausible refactors shrink
 * `anchoredCount` below `candidateCount` without touching a single state
 * name: moving a call into the dispatch's OWN `else` branch, behind a
 * `switch (x.code)` instead of an `if`, behind an early-return guard
 * (`if (x.code !== EXIT) return; ...; outOfBand(...)`) — each still contains
 * the call `candidateCount` counts, but `anchoredCount` can no longer verify
 * it. Every one of those
 * produces an EMPTY `mismatches` array that reads identically to "all
 * clear" without `candidateCount`/`anchoredCount` alongside it to say
 * whether anything was actually checked. Deliberately a COUNT COMPARISON,
 * not a fixed magic-number floor: it self-scales to whatever `sourceText`
 * actually contains, so it holds equally for the real corpus (today: 5) and
 * for a small synthetic test fixture (0, 1, 2, …) without either needing to
 * mirror the other's size.
 */
export interface OutOfBandNamePairingScan {
  readonly candidateCount: number;
  readonly anchoredCount: number;
  readonly mismatches: readonly OutOfBandNamePairingMismatch[];
}

/**
 * The real scan: for every call in `sourceText` whose callee resolves, by
 * IMPORT PROVENANCE, to the real `outOfBand` export of `helperModuleSpecifier`
 * (`candidateCount` — `resolveOutOfBandImportProvenance` above; this is
 * AST-based rather than textual, so it cannot be inflated by a
 * `` `outOfBand` `` mention inside a COMMENT the way a plain string/regex
 * search over the source text would be — verified against the real corpus,
 * which carries exactly this shape at `terminal-states.ts`'s own header —
 * and it is resolved by import IDENTITY rather than local identifier text,
 * so it neither misses a renaming import alias of the real helper nor
 * over-counts a same-named decoy imported from elsewhere), check whether it
 * anchors to an enclosing `if (X.code === IDENT)` dispatch
 * (`findEnclosingOutOfBandDispatch` above — which itself resolves `IDENT` to a
 * known out-of-band exit constant, and only counts a call in the dispatch's
 * `then` branch). For every anchored call, verify its `'NAME'` argument names
 * the SAME state `IDENT` does.
 */
export async function scanOutOfBandNamePairings(
  sourceText: string,
  fileName = "drive-status.ts",
  helperModuleSpecifier = "./lib/status/terminal-states.ts",
  leaseModuleSpecifier = "./lib/state/lease.ts",
): Promise<OutOfBandNamePairingScan> {
  const { checker, sourceFile } = await createSingleFileProgram(
    fileName,
    sourceText,
  );
  const mismatches: OutOfBandNamePairingMismatch[] = [];
  let candidateCount = 0;
  let anchoredCount = 0;
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        resolveOutOfBandImportProvenance(node, checker, helperModuleSpecifier)
      ) {
        candidateCount += 1;
        const call = resolveOutOfBandCallStateName(
          node,
          checker,
          helperModuleSpecifier,
        );
        if (call !== undefined) {
          const dispatch = findEnclosingOutOfBandDispatch(
            node,
            checker,
            leaseModuleSpecifier,
          );
          if (dispatch !== undefined) {
            anchoredCount += 1;
            if (dispatch.stateName !== call.stateName) {
              mismatches.push({
                line: lineOf(call.nameArg),
                comparisonLine: lineOf(dispatch.ifStatement.expression),
                comparisonIdentifier: dispatch.identifierText,
                expectedStateName: dispatch.stateName,
                actualStateName: call.stateName,
              });
            }
          }
        }
      } else if (
        isAmbiguousOutOfBandCallee(
          unwrapTransparentExpression(node.expression),
          checker,
          helperModuleSpecifier,
        )
      ) {
        // A genuinely dynamic key on the real helper's own namespace object
        // — reached either directly at the call site or through a rebind
        // chain: this MIGHT be a
        // real outOfBand() call this scan cannot verify. Count it as a
        // candidate that can never anchor, so the coverage cross-check below
        // fails closed instead of silently excluding it from the census.
        candidateCount += 1;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return { candidateCount, anchoredCount, mismatches };
}

/**
 * Thin wrapper over `scanOutOfBandNamePairings` for callers that only care
 * about the mismatches themselves — the shape every unit test in this file's
 * own suite already exercises. `runCheck()` calls `scanOutOfBandNamePairings`
 * directly instead, since it also needs `anchoredCount` for the population
 * floor.
 */
export async function findOutOfBandNamePairingMismatches(
  sourceText: string,
  fileName = "drive-status.ts",
  helperModuleSpecifier = "./lib/status/terminal-states.ts",
  leaseModuleSpecifier = "./lib/state/lease.ts",
): Promise<readonly OutOfBandNamePairingMismatch[]> {
  const scan = await scanOutOfBandNamePairings(
    sourceText,
    fileName,
    helperModuleSpecifier,
    leaseModuleSpecifier,
  );
  return scan.mismatches;
}

/** Test seams for `runCheck()`'s drive.ts-emitter check — never set in prod.
 * Two separate env vars because the two halves above load `drive.ts`
 * differently: one `require()`s it as a module for its live export values,
 * the other reads it as raw text for the AST scan. A test exercising only
 * one half leaves the other pointed at the real file. */
function driveTsModulePath(): string {
  return (
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_MODULE ??
    resolve(SKILL_ROOT, "scripts/drive.ts")
  );
}
function driveTsSourcePath(): string {
  return (
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE ??
    resolve(SKILL_ROOT, "scripts/lib/driver/settings.ts")
  );
}

/** Same module/source split as `driveTsModulePath`/`driveTsSourcePath`
 * above, for `lib/state/lease.ts`'s own out-of-band exit constants
 *. */
function leaseTsModulePath(): string {
  return (
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_MODULE ??
    resolve(SKILL_ROOT, "scripts/lib/state/lease.ts")
  );
}
function leaseTsSourcePath(): string {
  return (
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_LEASE_TS_SOURCE ??
    resolve(SKILL_ROOT, "scripts/lib/state/lease-model.ts")
  );
}

/** `drive-status.ts` only CONSUMES the out-of-band exit constants, never
 * declares them, so its own check needs only a source seam — no
 * module-require half like `drive.ts`'s/`lease.ts`'s own checks have.
 * Exported so the test suite can scan the REAL, checked-in source directly
 * rather than only synthetic fixtures. */
export function driveStatusTsSourcePath(): string {
  return (
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_STATUS_TS_SOURCE ??
    resolve(SKILL_ROOT, "scripts/drive-status.ts")
  );
}

interface CorpusScan {
  broken: BrokenPair[];
  silent: string[];
  missingRequired: MissingRequired[];
  scanned: number;
  checked: number;
}

function scanDocumentedCorpus(): CorpusScan | 1 {
  const broken: BrokenPair[] = [];
  const silent: string[] = [];
  const missingRequired: MissingRequired[] = [];
  let scanned = 0;
  let checked = 0;

  for (const { unit, path } of corpusFiles()) {
    if (!existsSync(path)) {
      console.error(
        `ERROR: terminal-state corpus file does not exist: ${path}`,
      );
      console.error(
        "  A file that was deleted or renamed leaves CORPUS_FILES stale.",
      );
      return 1;
    }
    scanned++;
    const text = readFileSync(path, "utf8");
    const pairs = extractFile(unit, text);

    // Runs BEFORE the population-floor `continue` below, and independently
    // of it: the floor alone cannot see a required identifier that vanished
    // while OTHER rows kept the total count at or above it — see
    // `requiredIdentifiers`'s own doc comment on `CorpusFile`.
    if (unit.requiredIdentifiers !== undefined) {
      const missing = findMissingRequired(pairs, unit.requiredIdentifiers);
      if (missing.length > 0) {
        missingRequired.push({ file: relative(SKILL_ROOT, path), missing });
      }
    }

    const floor = unit.minPairs ?? DEFAULT_MIN_PAIRS;
    if (pairs.length < floor) {
      silent.push(`${relative(SKILL_ROOT, path)} (${pairs.length} < ${floor})`);
      continue;
    }
    checked += checkDocumentedPairs(unit, pairs, broken);
  }

  return { broken, silent, missingRequired, scanned, checked };
}

function checkDocumentedPairs(
  unit: CorpusFile,
  pairs: DocumentedPair[],
  broken: BrokenPair[],
): number {
  let checked = 0;
  for (const pair of pairs) {
    checked++;
    const entry = TERMINAL_STATES[pair.state];
    // `additionalExitCodes` documents `drive.ts`'s own remap (CONVERGED's
    // `0`) — real ONLY in a file that documents `drive.ts`'s own
    // operator-facing exit, never `drive-status.ts`'s (see
    // `documentsDriveTsRemap`'s own doc comment on `CorpusFile`). Applying
    // it unconditionally to every non-header file would let a genuinely
    // wrong `CONVERGED` → `0` row pass in `SKILL.md`'s own combined
    // primary+annotation cell AND in `references/terminal-states.md`'s own
    // table — both document `drive-status.ts`'s contract, same as the
    // header, so "is this the header" is the wrong special case to check
    // for (mutation-proven). Conversely, a file that DOES
    // document the remap (`documentsDriveTsRemap: true`) shows ONLY the
    // remapped code for that state, never `drive-status.ts`'s raw one —
    // so there the raw `exitCode` is not itself valid either, and
    // `additionalExitCodes` REPLACES it rather than extending it.
    const validExitCodes =
      entry === undefined
        ? []
        : unit.documentsDriveTsRemap
          ? (entry.additionalExitCodes ?? [entry.exitCode])
          : [entry.exitCode];
    if (!validExitCodes.includes(pair.exitCode)) {
      broken.push({ pair, validExitCodes });
    }
  }
  return checked;
}

function reportCorpusProblems({
  broken,
  silent,
  missingRequired,
}: CorpusScan): 1 | undefined {
  if (missingRequired.length > 0) {
    console.error(
      "A required (exit, state) identifier silently disappeared from a corpus file:\n",
    );
    for (const { file, missing } of missingRequired) {
      console.error(`  ${file}: missing ${missing.join(", ")}`);
    }
    console.error(
      "\nEach identifier above is REQUIRED by this file's own `requiredIdentifiers`",
    );
    console.error(
      "(__tests__/terminal-states-consistency.ts CORPUS_FILES) — the file used to",
    );
    console.error(
      "document it and no longer does, even though the file's total row count may",
    );
    console.error(
      "still clear its population floor (a floor alone cannot see ONE row vanish",
    );
    console.error(
      "while others keep the total up — see `requiredIdentifiers`'s own doc comment",
    );
    console.error("on `CorpusFile`). Fix by one of:");
    console.error(
      "  - restoring the row this file dropped, in a shape the extractor recognizes;",
    );
    console.error(
      "  - updating that file's `requiredIdentifiers` in CORPUS_FILES if the state",
    );
    console.error(
      "    was deliberately removed from what this file documents.",
    );
    return 1;
  }

  if (silent.length > 0) {
    console.error(
      "Terminal-state corpus files yielded too few (exit, state) pairs:\n",
    );
    for (const file of silent) console.error(`  ${file}`);
    console.error(
      `\nEach file in the corpus documents the drive's terminal-state vocabulary,`,
    );
    console.error(
      "so fewer pairs than that file's own floor (shown above) means the table",
    );
    console.error(
      "was reformatted in a way this extractor no longer recognizes, or the file stopped",
    );
    console.error("documenting states at all. Either way the green verdict");
    console.error("below would be meaningless. Fix the extractor in");
    console.error(
      "__tests__/terminal-states-consistency.ts, or update CORPUS_FILES if",
    );
    console.error("the file genuinely no longer documents this vocabulary.");
    return 1;
  }

  if (broken.length > 0) {
    console.error(
      "Prose states an (exit code, state) pair the code does not emit:\n",
    );
    for (const { pair, validExitCodes } of broken) {
      const known =
        validExitCodes.length === 0
          ? "no such state exists in TERMINAL_STATES"
          : `TERMINAL_STATES allows exit ${validExitCodes.join(" or ")} here`;
      console.error(
        `  ${relative(SKILL_ROOT, pair.file)}:${pair.line}  exit ${pair.exitCode} → ${pair.state}  (${known})`,
      );
    }
    console.error(
      "\nA doc can describe a code/state pair only if it is real — see",
    );
    console.error("drive-pr/scripts/lib/status/terminal-states.ts, the single");
    console.error("source of truth for the pairing. Fix by one of:");
    console.error("  - correcting the exit code or state name in the doc;");
    console.error(
      "  - adding the state to TERMINAL_STATES if it is real and missing;",
    );
    console.error(
      "  - removing the row if the state was retired (mark it RETIRED,",
    );
    console.error("    never delete the tombstone silently).");
    return 1;
  }

  return undefined;
}

async function checkDriverBindings(): Promise<
  readonly DriverOnlyExitBinding[] | 1
> {
  // ── drive.ts itself, not just the prose corpus above ──────────
  const modulePath = driveTsModulePath();
  const bindings = driverOnlyExitBindings(modulePath);
  const exitMismatches = findExitConstantMismatches(bindings, TERMINAL_STATES);
  if (exitMismatches.length > 0) {
    console.error(
      `A driver-only exit constant in ${relative(SKILL_ROOT, modulePath)} no longer equals`,
    );
    console.error(
      "the TERMINAL_STATES entry it is supposed to be read from:\n",
    );
    for (const mismatch of exitMismatches) console.error(`  ${mismatch}`);
    console.error(
      "\nEach of these constants is declared as `= driverOnlyExitCode('<NAME>')`",
    );
    console.error(
      "— if this still fails, one of them was edited back to an independent",
    );
    console.error(
      "literal. Restore the `driverOnlyExitCode(...)` read, or fix the",
    );
    console.error(
      "TERMINAL_STATES entry itself if the exit code genuinely changed.",
    );
    return 1;
  }

  const sourcePath = driveTsSourcePath();
  if (!existsSync(sourcePath)) {
    console.error(`ERROR: drive.ts source file does not exist: ${sourcePath}`);
    return 1;
  }
  const driveTsSource = readFileSync(sourcePath, "utf8");

  const provenanceMismatches = await findConstantProvenanceMismatches(
    driveTsSource,
    DRIVER_ONLY_EXIT_NAMES,
    sourcePath,
    "driverOnlyExitCode",
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE === undefined
      ? "../status/terminal-states.ts"
      : "./lib/status/terminal-states.ts",
  );
  if (provenanceMismatches.length > 0) {
    console.error(
      `A driver-only exit constant in ${relative(SKILL_ROOT, sourcePath)} is no longer`,
    );
    console.error("declared as a `driverOnlyExitCode(...)` read:\n");
    for (const { reason } of provenanceMismatches) {
      console.error(`  ${reason}`);
    }
    console.error(
      "\nRestore the exact `export const <NAME>_EXIT = driverOnlyExitCode('<STATE>')`",
    );
    console.error(
      "form — a constant that currently holds the right VALUE can still fail this",
    );
    console.error(
      "if it is no longer bound to TERMINAL_STATES by that read (see",
    );
    console.error(
      "findExitConstantMismatches above, which cannot see this by construction).",
    );
    return 1;
  }

  const driverSources =
    process.env.DRIVE_PR_TERMINAL_STATES_TEST_DRIVE_TS_SOURCE === undefined
      ? driverSourceFiles(resolve(SKILL_ROOT, "scripts"))
      : [sourcePath];
  const bareLiterals: Array<BareLiteralExit & { path: string }> = [];
  for (const path of driverSources) {
    const exits = await findBareLiteralExits(readFileSync(path, "utf8"), path);
    bareLiterals.push(...exits.map((exit) => ({ ...exit, path })));
  }
  if (bareLiterals.length > 0) {
    console.error(
      `${relative(SKILL_ROOT, sourcePath)} uses a bare exit-code literal instead of`,
    );
    console.error("its named TERMINAL_STATES-derived constant:\n");
    for (const exit of bareLiterals) {
      console.error(
        `  ${relative(SKILL_ROOT, exit.path)}:${exit.line}  ${describeBareLiteralExit(exit)}`,
      );
    }
    console.error(
      "\nUse the matching exported constant instead (MAX_ROUNDS_EXIT / ",
    );
    console.error(
      "SINGLE_INSTANCE_LOCK_EXIT / WORKTREE_UNCLEAN_EXIT / STALLED_EXIT /",
    );
    console.error("PASS_DEADLINE_EXIT / QUOTA_PARKED_EXIT) — see");
    console.error(
      "drive-pr/scripts/lib/status/terminal-states.ts for why this",
    );
    console.error("binding exists.");
    return 1;
  }

  return bindings;
}

async function checkLeaseBindings(): Promise<
  readonly DriverOnlyExitBinding[] | 1
> {
  // ── lease.ts's out-of-band exit constants ──────────────────────
  const leaseModulePath = leaseTsModulePath();
  const leaseBindings = outOfBandExitBindings(leaseModulePath);
  const leaseExitMismatches = findExitConstantMismatches(
    leaseBindings,
    TERMINAL_STATES,
  );
  if (leaseExitMismatches.length > 0) {
    console.error(
      `An out-of-band exit constant in ${relative(SKILL_ROOT, leaseModulePath)} no longer`,
    );
    console.error(
      "equals the TERMINAL_STATES entry it is supposed to be read from:\n",
    );
    for (const mismatch of leaseExitMismatches) console.error(`  ${mismatch}`);
    console.error(
      "\nEach of these constants is declared as `= outOfBandExitCode('<NAME>')`",
    );
    console.error(
      "— if this still fails, one of them was edited back to an independent",
    );
    console.error(
      "literal. Restore the `outOfBandExitCode(...)` read, or fix the",
    );
    console.error(
      "TERMINAL_STATES entry itself if the exit code genuinely changed.",
    );
    return 1;
  }

  const leaseSourcePath = leaseTsSourcePath();
  if (!existsSync(leaseSourcePath)) {
    console.error(
      `ERROR: lease.ts source file does not exist: ${leaseSourcePath}`,
    );
    return 1;
  }
  const leaseSource = readFileSync(leaseSourcePath, "utf8");

  const leaseProvenanceMismatches = await findConstantProvenanceMismatches(
    leaseSource,
    OUT_OF_BAND_EXIT_NAMES,
    leaseSourcePath,
    "outOfBandExitCode",
    "../status/terminal-states.ts",
  );
  if (leaseProvenanceMismatches.length > 0) {
    console.error(
      `An out-of-band exit constant in ${relative(SKILL_ROOT, leaseSourcePath)} is no longer`,
    );
    console.error("declared as an `outOfBandExitCode(...)` read:\n");
    for (const { reason } of leaseProvenanceMismatches) {
      console.error(`  ${reason}`);
    }
    console.error(
      "\nRestore the exact `export const <NAME>_EXIT = outOfBandExitCode('<STATE>')`",
    );
    console.error(
      "form — a constant that currently holds the right VALUE can still fail this",
    );
    console.error(
      "if it is no longer bound to TERMINAL_STATES by that read (see",
    );
    console.error(
      "findExitConstantMismatches above, which cannot see this by construction).",
    );
    return 1;
  }

  return leaseBindings;
}

async function checkDriveStatusBindings(): Promise<number> {
  // ── drive-status.ts's own bare-literal scan for the same two out-of-band
  // exit codes — it only consumes SESSION_LEASE_HELD_EXIT /
  // DRIVE_HELD_ELSEWHERE_EXIT, so it needs no binding/provenance check of its
  // own, only the bare-literal-bypass one. ─────────────────────────────────
  const driveStatusSourcePath = driveStatusTsSourcePath();
  if (!existsSync(driveStatusSourcePath)) {
    console.error(
      `ERROR: drive-status.ts source file does not exist: ${driveStatusSourcePath}`,
    );
    return 1;
  }
  const driveStatusSource = readFileSync(driveStatusSourcePath, "utf8");
  const driveStatusBareLiterals = await findBareLiteralExits(
    driveStatusSource,
    driveStatusSourcePath,
    OUT_OF_BAND_BARE_LITERAL_EXIT_CODES,
  );
  if (driveStatusBareLiterals.length > 0) {
    console.error(
      `${relative(SKILL_ROOT, driveStatusSourcePath)} uses a bare exit-code literal`,
    );
    console.error("instead of its named TERMINAL_STATES-derived constant:\n");
    for (const exit of driveStatusBareLiterals) {
      console.error(
        `  ${relative(SKILL_ROOT, driveStatusSourcePath)}:${exit.line}  ${describeBareLiteralExit(exit)}`,
      );
    }
    console.error(
      "\nUse the matching exported constant instead (SESSION_LEASE_HELD_EXIT /",
    );
    console.error("DRIVE_HELD_ELSEWHERE_EXIT) — see drive-pr/scripts/lib/");
    console.error("state/lease.ts for why this binding exists.");
    return 1;
  }

  // ── drive-status.ts's own outOfBand NAME pairing check — the gap
  // `outOfBand` alone leaves: a call site can still name
  // the WRONG sibling state for the comparison branch it is actually inside.
  // See scanOutOfBandNamePairings's own header. ────────────────────────────
  const outOfBandScan = await scanOutOfBandNamePairings(
    driveStatusSource,
    driveStatusSourcePath,
  );
  // Coverage cross-check (fail closed, with an independent census) — checked
  // BEFORE the mismatches themselves: an empty `mismatches` array means
  // "verified clean" only when every real outOfBand() call was actually
  // anchored and checked. `candidateCount` is the broader, AST-based-but-
  // unresolved recognizer (see scanOutOfBandNamePairings's own header); a
  // shortfall here means some real call's enclosing dispatch shape no
  // longer resolves, so the mismatch check below never even looked at it.
  if (outOfBandScan.anchoredCount < outOfBandScan.candidateCount) {
    console.error(
      `${relative(SKILL_ROOT, driveStatusSourcePath)} has ${outOfBandScan.candidateCount} outOfBand() call site(s), but only`,
    );
    console.error(
      `${outOfBandScan.anchoredCount} anchored to a recognized \`.code === IDENT\` dispatch this scan can verify.`,
    );
    console.error(
      "\nA refactor (moving a call into the dispatch's own `else` branch, behind a",
    );
    console.error(
      "`switch` dispatch, or behind an early-return guard) may have moved a real call",
    );
    console.error(
      "site outside what this scan can anchor to — see findEnclosingOutOfBandDispatch's",
    );
    console.error("own header.");
    return 1;
  }
  if (outOfBandScan.mismatches.length > 0) {
    console.error(
      `${relative(SKILL_ROOT, driveStatusSourcePath)} calls outOfBand() with a state name that`,
    );
    console.error("does not match its enclosing comparison's own dispatch:\n");
    for (const mismatch of outOfBandScan.mismatches) {
      console.error(
        `  ${relative(SKILL_ROOT, driveStatusSourcePath)}:${mismatch.line}  outOfBand(report, '${mismatch.actualStateName}', ...)`,
      );
      console.error(
        `    inside the \`.code === ${mismatch.comparisonIdentifier}\` branch at line ${mismatch.comparisonLine}, which dispatches '${mismatch.expectedStateName}'`,
      );
    }
    console.error(
      "\nPass the state name matching the enclosing comparison's own exit-code",
    );
    console.error("identifier, not a sibling out-of-band state.");
    return 1;
  }

  return 0;
}

export async function runCheck(): Promise<number> {
  const corpus = scanDocumentedCorpus();
  if (typeof corpus === "number") return corpus;
  const corpusProblem = reportCorpusProblems(corpus);
  if (corpusProblem !== undefined) return corpusProblem;
  const bindings = await checkDriverBindings();
  if (typeof bindings === "number") return bindings;
  const leaseBindings = await checkLeaseBindings();
  if (typeof leaseBindings === "number") return leaseBindings;
  const statusProblem = await checkDriveStatusBindings();
  if (statusProblem !== 0) return statusProblem;
  const { checked, scanned } = corpus;
  console.log(
    `✅ drive-pr terminal states: ${checked} documented (exit, state) pair(s) across ${scanned} file(s) all match TERMINAL_STATES,`,
  );
  console.log(
    `   drive.ts's own ${bindings.length} driver-only exit constant(s) still read from it,`,
  );
  console.log(
    `   and lease.ts's own ${leaseBindings.length} out-of-band exit constant(s) — plus drive-status.ts's`,
  );
  console.log(
    "   own call sites and outOfBand() name pairings — still read from it too.",
  );
  console.log(
    "   This derives PAIRING CONSISTENCY, not prose accuracy: it proves every",
  );
  console.log(
    "   documented (exit, state) row is a real pair the code can emit, never that",
  );
  console.log("   the surrounding sentence describing it is still correct.");
  return 0;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await runCheck();
  } finally {
    await closeTypeScriptService();
  }
  process.exit(code);
}
