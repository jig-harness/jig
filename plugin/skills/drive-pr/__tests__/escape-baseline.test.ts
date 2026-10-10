/**
 * escape-baseline.test.ts — the defect-escape anchor an earlier change pairs with
 * every loop-economy speed report.
 *
 * Two things are worth pinning here. First, the PARSE rule: the doc appends a
 * new measurement window below the prior one rather than overwriting it, so
 * the parser must take the LAST occurrence of each pattern, not the first —
 * a test that only exercised a single-window doc would pass just as happily
 * on a first-occurrence bug. Second, that the file reader finds the document
 * at its path under a repository root and parses it the same way
 * (`fixtures/review-loop-baseline.md` is the format contract).
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BASELINE_DOC_PATH,
  parseRecordedEscapeBaseline,
  readRecordedEscapeBaseline,
  renderEscapeAnchor,
} from "../scripts/lib/escape-baseline.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "review-loop-baseline.md");

describe("parseRecordedEscapeBaseline", () => {
  it("reads a single recorded window", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("takes the LAST window when a re-measurement was appended", () => {
    // The doc's own convention: append, never overwrite. A parser reading
    // the FIRST occurrence would report a stale window forever.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 2 of 90 declined findings, ≈2.2%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 2,
      total: 90,
      since: "2026-09-01",
      until: "2026-09-08",
    });
  });

  it("returns null when there is no window heading", () => {
    const doc = "**Escape rate: 4 of 155 declined findings, ≈2.6%.**";
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null when there is no rate line", () => {
    const doc = "## Baseline window: 2026-08-06 → 2026-08-13";
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null on an empty document", () => {
    expect(parseRecordedEscapeBaseline("")).toBeNull();
  });

  it("does NOT pair a freshly appended window with a PRIOR window's rate line", () => {
    // The realistic failure this guards against: a human appends the new
    // "## Baseline window" heading and its surrounding tables first, and has
    // not yet written (or wrote a malformed) "**Escape rate: ...**" line for
    // it. Matching both patterns independently and taking each one's own
    // last occurrence would find the PRIOR window's still-present rate line
    // and print it stamped with the NEW window's dates — stale numbers
    // reported as a measured fact for a window they were never adjudicated
    // against.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet)",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("does not resume scanning from a PRIOR call's position (RATE_RE has the `g` flag)", () => {
    // Regression guard for reusing a module-level global-flagged RegExp
    // across calls via a stateful lastIndex-mutating method. `matchAll` is
    // safe; `.exec()`/`.match()` on the shared regex object are not.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
    // Second call against a FRESH, unrelated single-window doc must still
    // find its own rate line from the start, not from wherever the first
    // call's internal scan left off.
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("returns null rather than dividing by a zero total", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 0 of 0 declined findings, ≈0.0%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("finds the rate line nested several subsections below the window heading", () => {
    // The real doc's own shape (### Outcome mix, ### Rounds and growth,
    // ### Defect escape all sit between the window heading and its own rate
    // line) — the rate line is never literally the line right after the
    // heading.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "",
      "### Outcome mix",
      "some prose",
      "",
      "### Defect escape",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does NOT stamp a later, UNRELATED section's rate-shaped line onto this window", () => {
    // The finding this guards against: `afterWindow` used to search to the
    // END of the document rather than stopping at the next level-2 heading,
    // so an example or a differently-scoped section below the window's own
    // block — but still before any newer window heading — could supply a
    // matching line for a window whose own rate line was never written.
    const doc = [
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet for this window)",
      "",
      "## What this licenses, and what it does not",
      "Illustrative example of the old shape:",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null when two candidate rate lines exist in the same window (an obsolete line left behind by a correction)", () => {
    // The finding this guards against (docomply-review, chatgpt-codex-connector,
    // a reference-implementation pull request round 2): `.at(0)` on the raw match list silently prefers
    // whichever rate line sorts first — which can be the STALE one a
    // correction left in place rather than the live figure. Ambiguous must
    // degrade to null, never guess between the two.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "(correction pending — recount landed a different figure below)",
      "**Escape rate: 9 of 200 declined findings, ≈4.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("ignores a superseded rate line inside an HTML comment, returning the one live match rather than reading it as ambiguous", () => {
    // Blanking runs BEFORE duplicate-counting, so a rate-shaped line entirely
    // inside a comment never becomes a second candidate in the first place —
    // this is the live figure, cleanly, not an ambiguous pair.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "<!-- superseded: **Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.** -->",
      "**Escape rate: 9 of 200 declined findings, ≈4.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 9,
      total: 200,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not read a rate line that lives ENTIRELY inside an HTML comment as a real measurement (docomply-review, a reference-implementation pull request round 3)", () => {
    // The exact scenario the finding gave: no live rate line at all for this
    // window, only a commented-out one. Pre-fix, `rateMatches.length` was 1
    // and the parser returned 4/155 as authoritative.
    const doc = [
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "<!-- **Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.** -->",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("does not read a rate-shaped line inside a fenced code example as a real measurement", () => {
    // The decoy sits WITHIN this window's own block (no intervening `## `
    // heading before it) — without an unrelated heading to exclude it via
    // afterWindow's own bounding, this genuinely exercises fence stripping
    // rather than passing for the wrong reason (coderabbitai, PR #4674).
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "Illustrative rendering, e.g.:",
      "```",
      "**Escape rate: 999 of 1000 declined findings, ≈99.9%, over one week.**",
      "```",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not read a fenced-example window heading as a newer window (docomply-review, a reference-implementation pull request round 3)", () => {
    // The window census runs over the same raw text as the rate scan, so a
    // baseline-shaped `##` line inside a fenced example after the real
    // heading must not become `windows.at(-1)` — it would either suppress
    // the genuine anchor as "unmeasured" (its own block has no rate line) or
    // supply the example's own counts as the current measurement.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Example of the format for a future window",
      "Copy this shape when appending a new measurement:",
      "```",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 0 of 1 declined findings, ≈0.0%, over one week.**",
      "```",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not let a fence-shaped line inside a multiline HTML comment suppress everything after it (docomply-review, a reference-implementation pull request round 5)", () => {
    // Fence recognition used to run before checking comment state, so this
    // `<!--\n```\n-->` sequence mis-entered fence mode on the middle line and
    // never left it, blanking the real heading and rate line through EOF.
    const doc = [
      "<!--",
      "```",
      "-->",
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not treat a backtick run with a backtick in its info string as a fence opener", () => {
    // CommonMark: a backtick-fenced info string may not itself contain a
    // backtick (ambiguous with an inline code span), so this line is not a
    // fence at all — treating it as one would incorrectly enter fence mode
    // and swallow the real content that follows.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "```invalid`info",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not read a rate-shaped substring embedded in ordinary prose as the real measurement (docomply-review, a reference-implementation pull request round 5)", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "Illustration: **Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("does not read a rate-shaped substring embedded in prose as a second candidate alongside the real line", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "Illustration: **Escape rate: 9 of 200 declined findings, ≈4.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("recognizes a newer window heading indented by a legal 1-3 Markdown spaces, and does not fall through to the prior window", () => {
    // CommonMark treats up to three leading spaces on an ATX heading as
    // insignificant indentation, not content. A parser anchored at column
    // zero would fail to recognize the newer heading, silently fall back to
    // `windows.at(-1)` picking the PRIOR window, and stamp its stale rate
    // under what looks like the newer window's own dates.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "  ## Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 7,
      total: 200,
      since: "2026-09-01",
      until: "2026-09-08",
    });
  });

  it("degrades to unmeasured rather than falling back to a stale window when a newer heading is malformed (docomply-review, a reference-implementation pull request round 5)", () => {
    // A single-digit month makes the newer heading invisible to the precise
    // WINDOW_RE, so `.at(-1)` used to silently select the OLDER, valid
    // window and publish its stale figure as current.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-9-01 → 2026-09-08",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("does not flag an unrelated heading as a malformed newer window", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## What this licenses, and what it does not",
      "ordinary prose with no baseline-window-shaped heading after it.",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
  });

  it("does not treat a `<!--` rendered as inline code as the start of a real comment (chatgpt-codex-connector, a reference-implementation pull request round 8)", () => {
    // Markdown renders `` `<!--` `` as literal code, not a comment opener.
    // Reading it as a real comment start blanks everything after it through
    // EOF (no closing `-->` in sight), suppressing the real window below.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "Mentions the `<!--` syntax in passing.",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 7,
      total: 200,
      since: "2026-09-01",
      until: "2026-09-08",
    });
  });

  it("shields a `<!--` inside a TWO-backtick inline code span, not just single-backtick (docomply-review, a reference-implementation pull request round 7)", () => {
    // CommonMark: a code span opens on a maximal backtick run and closes on
    // the next run of the exact same length. `` ``<!--`` `` is a valid
    // two-backtick span; a single-backtick-only recognizer left it
    // unshielded, blanking everything after it through EOF.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "Mentions ``<!--`` syntax in passing.",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toEqual({
      escaped: 7,
      total: 200,
      since: "2026-09-01",
      until: "2026-09-08",
    });
  });

  it("still recognizes a genuine HTML comment after a two-backtick span containing an unrelated backtick", () => {
    // The decoy rate line sits on its OWN line, inside the comment: `RATE_RE`
    // matches complete lines, so a decoy sharing a line with other text
    // could never match regardless of whether comment-stripping works at
    // all — this shape ensures the test actually exercises it (coderabbitai,
    // PR #4674): if comment recognition ever breaks, this returns 9/9
    // instead of null.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "``code with a ` backtick`` <!--",
      "**Escape rate: 9 of 9 declined findings, 100%, over one week.**",
      "-->",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("still recognizes a genuine HTML comment on a line that also happens to contain a backtick span", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet) `example code` <!-- real comment -->",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("does not accept a window heading with trailing content after a valid date pair (docomply-review, a reference-implementation pull request round 6)", () => {
    // `WINDOW_RE` used to match only the prefix, so a heading like
    // "... 2026-09-08 (draft)" still parsed as a genuine window instead of
    // failing closed on the doc's own exact-shape contract. Composes with
    // WINDOW_CENSUS_RE: the malformed heading is still broad-census-visible,
    // so this degrades to null (a later malformed heading) rather than
    // falling back to the older window's data.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Baseline window: 2026-09-01 → 2026-09-08 (draft)",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("bounds the rate-line search at a bare, EMPTY `##` heading (coderabbitai, PR #4674)", () => {
    // CommonMark: an ATX heading marker needs no trailing whitespace when
    // the heading itself is empty, so a bare `##` on its own line is a
    // valid (empty) level-2 heading. A boundary requiring `[ \t]` after the
    // marker missed it, letting the scan run past it into an unrelated
    // section's own decoy rate line.
    const doc = [
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet for this window)",
      "##",
      "Illustrative example of the old shape:",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("bounds the rate-line search at a TAB-delimited next heading, not just a space-delimited one (chatgpt-codex-connector, a reference-implementation pull request)", () => {
    // `##\tHeading` is legal CommonMark ATX-heading whitespace. A boundary
    // that only recognized a literal space would let the search run past
    // this heading into the unrelated section's own decoy rate line.
    const doc = [
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet for this window)",
      "##\tWhat this licenses, and what it does not",
      "Illustrative example of the old shape:",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("census catches a malformed newer window heading at heading levels 4-6, not just 1-3", () => {
    // Isolated from the older window's own real `## ` boundary (so its
    // rate line is found cleanly, on its own, and would otherwise be
    // returned as a false "current" measurement) — the ONLY thing that
    // must catch the deeper, malformed heading below is the census's own
    // level range, not the duplicate-rate-line check.
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
      "",
      "## Some unrelated real heading",
      "ordinary prose",
      "",
      "#### Baseline window: 2026-09-01 → 2026-09-08",
      "**Escape rate: 7 of 200 declined findings, ≈3.5%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("bounds to an indented next heading rather than searching past it", () => {
    // Same hazard as the previous test, but for the `nextHeading` boundary
    // regex rather than `WINDOW_RE`: an indented next heading that fails to
    // terminate the block would let this window's search reach into the
    // following, unrelated section's own rate-shaped line.
    const doc = [
      "## Baseline window: 2026-09-01 → 2026-09-08",
      "(rate line not written yet for this window)",
      "",
      "  ## What this licenses, and what it does not",
      "Illustrative example of the old shape:",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null when the escaped count exceeds the total", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: 200 of 155 declined findings, ≈129.0%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null for a negative escaped count", () => {
    const doc = [
      "## Baseline window: 2026-08-06 → 2026-08-13",
      "**Escape rate: -1 of 155 declined findings, ≈-0.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null for a calendar-impossible date (digit-shaped but not real)", () => {
    const doc = [
      "## Baseline window: 2026-99-99 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null for a date that overflows its month (2026-02-30)", () => {
    const doc = [
      "## Baseline window: 2026-02-30 → 2026-08-13",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });

  it("returns null when `since` is after `until`", () => {
    const doc = [
      "## Baseline window: 2026-08-13 → 2026-08-06",
      "**Escape rate: 4 of 155 declined findings, ≈2.6%, over one week.**",
    ].join("\n");
    expect(parseRecordedEscapeBaseline(doc)).toBeNull();
  });
});

describe("readRecordedEscapeBaseline — fs wrapper", () => {
  it("returns null for a repo root with no such file", () => {
    expect(
      readRecordedEscapeBaseline("/nonexistent-root-for-tests"),
    ).toBeNull();
  });

  it("returns null for an empty repoRoot rather than resolving to cwd", () => {
    expect(readRecordedEscapeBaseline("")).toBeNull();
  });

  it("reads the recorded document at its path under a repository root", () => {
    const text = readFileSync(FIXTURE, "utf8");
    const baseline = parseRecordedEscapeBaseline(text);
    expect(baseline).toEqual({
      escaped: 2,
      total: 90,
      since: "2026-09-01",
      until: "2026-09-08",
    });
    const root = mkdtempSync(join(tmpdir(), "escape-baseline-"));
    try {
      expect(readRecordedEscapeBaseline(root)).toBeNull();
      const at = join(root, BASELINE_DOC_PATH);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
      expect(readRecordedEscapeBaseline(root)).toEqual(baseline);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderEscapeAnchor", () => {
  it("never renders silently absent — always a line, even for null", () => {
    const out = renderEscapeAnchor(null);
    expect(out).toContain("defect-escape anchor");
    expect(out).toContain("unmeasured for a current window");
    expect(out).toContain(BASELINE_DOC_PATH);
  });

  it("renders the recorded figure with its window", () => {
    const out = renderEscapeAnchor({
      escaped: 4,
      total: 155,
      since: "2026-08-06",
      until: "2026-08-13",
    });
    expect(out).toContain("defect-escape anchor");
    expect(out).toContain("4/155");
    expect(out).toContain("2.6%");
    expect(out).toContain("2026-08-06 → 2026-08-13");
    expect(out).toContain(BASELINE_DOC_PATH);
  });
});
