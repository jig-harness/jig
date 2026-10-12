/**
 * The recorded, human-adjudicated defect-escape baseline — the
 * quality counterweight to the loop-economy speed numbers `lib/metrics.ts`
 * renders.
 *
 * The escape rate is a JUDGMENT, not a mechanical count: `defect-escape.ts`'s
 * own header explains why a human has to read each proximate re-find and
 * decide whether it is the SAME finding coming back. That verdict is recorded
 * exactly once, in prose, in the consumer's baseline document
 * (`drive.escape_baseline_doc`, default `docs/review-loop-baseline.md`), and a
 * re-measurement
 * is APPENDED there rather than overwriting the prior one (that doc's own
 * closing line: "append the result below rather than overwriting this one").
 *
 * Parsed from that doc rather than hand-copied into a second constant here —
 * a copied number is what drifts the moment a new window is appended and this
 * file is not (this figure already lives, recorded, in the doc; a second copy
 * in code has no source of truth of its own to stay in sync with). `parseRecordedEscapeBaseline` reads
 * the LAST occurrence of both the window heading and the rate line, since the
 * doc's own convention is to append, never overwrite.
 *
 * Best-effort throughout, matching every other economy-block signal
 * `lib/metrics.ts` already renders: a doc that moved, a heading that no
 * longer matches, or a repository root this process cannot resolve all
 * degrade to `null` rather than throwing — the loop-economy report is a
 * REPORT, and a missing anchor must never be the reason it fails to print.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { optionalOverlayString } from "./overlay.ts";

/** The default baseline document, repository-relative. */
export const BASELINE_DOC_PATH = "docs/review-loop-baseline.md";

/**
 * The repository's baseline document: `drive.escape_baseline_doc`, else
 * `BASELINE_DOC_PATH`. Repository-relative — also the path rendered next to
 * the anchor line, so a reader can go straight to the full table and
 * per-finding verdicts. An unreadable configuration file reads as the
 * default: this module is best-effort throughout (see the header).
 */
export function baselineDocPath(): string {
  try {
    return (
      optionalOverlayString("drive", "escape_baseline_doc") ?? BASELINE_DOC_PATH
    );
  } catch {
    return BASELINE_DOC_PATH;
  }
}

export interface EscapeBaseline {
  escaped: number;
  total: number;
  /** `YYYY-MM-DD`, inclusive. */
  since: string;
  /** `YYYY-MM-DD`, inclusive. */
  until: string;
}

// ` {0,3}` before the marker: CommonMark treats up to three leading spaces on
// an ATX heading as insignificant indentation, not content — anchoring at
// column zero would let a legally-indented heading (this one, or the
// `nextHeading` boundary below) slip past unrecognized (a legal-but-unexpected
// indentation). Anchored at the END too (`\s*$`, multiline): without it, a
// heading with trailing content after a valid date pair — `## Baseline window:
// 2026-09-01 → 2026-09-08 (draft)` — still matched the PREFIX and was accepted
// as a genuine window rather than failing closed, even though the doc's own
// contract is the exact shape and nothing else. Composes with
// `WINDOW_CENSUS_RE` below: a heading this excludes for trailing content still
// matches the broader census, so it is caught as a later malformed heading
// rather than silently ignored.
const WINDOW_RE =
  /^ {0,3}## Baseline window: (\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})\s*$/gm;
// A deliberately BROADER census over the same construct, per the rule that a
// self-test's recognizer must be strictly broader than the production one, so a
// construct the parser refuses still fails the test — applied to production
// code, not just a self-test: `WINDOW_RE` above is precise about digit-shaped
// dates and the exact arrow, so a heading that is CLOSE but slightly malformed
// — a single-digit month (`2026-9-01`), a typo'd separator, extra internal
// whitespace — is invisible to it and `windows.at(-1)` silently falls back to
// the PREVIOUS, valid window and its stale figure. This pattern exists only to
// detect that gap, never to extract data from it. `#{1,6}`, not `{1,3}`:
// WINDOW_RE only ever matches level-2, but the CENSUS must be broader across
// every ATX level too, or a `#### Baseline window` heading evades it the same
// way a malformed date would.
const WINDOW_CENSUS_RE = /^ {0,3}#{1,6}\s*baseline\s*window\b/gim;
// Anchored to a COMPLETE line (`^...$`, multiline), not merely a substring
// match anywhere in prose: without this, "Illustration: **Escape rate: 4 of
// 155 declined findings, ...**" inside the latest window's block is accepted
// as its authoritative measurement — or, alongside a real line, creates a
// false "two candidates" ambiguity — even though the doc's own contract is a
// standalone rate line. No comment
// suffix needs matching here: `stripNonRenderedMarkdown` already blanks any
// trailing `<!-- ... -->` before this regex ever runs, so `\s*$` alone
// covers what remains.
const RATE_RE =
  /^\*\*Escape rate: (\d+) of (\d+) declined findings,.*\*\*\s*$/gm;

/** A fence line's leading run: >=3 backticks/tildes, 0-3 space indent —
 * CommonMark's own ATX-heading indent tolerance, reused here for the same
 * reason `WINDOW_RE` carries it. Matches a CLOSING fence candidate (the
 * whole remainder must be whitespace-only, checked by the caller) as well
 * as a potential opener — `isValidFenceOpen` below validates the latter. */
const FENCE_RUN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every maximal run of one or more backticks in `line`, as `[start, end)`
 * ranges — the candidate opening/closing delimiters CommonMark inline code
 * spans use.
 */
function backtickRuns(line: string): Array<readonly [number, number]> {
  return [...line.matchAll(/`+/g)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
}

/**
 * Inline code span ranges on ONE line, per CommonMark's actual rule: a span
 * opens on a maximal backtick run and closes on the NEXT run of the EXACT SAME
 * length — any shorter or longer run strictly between the two is itself just
 * content, not a delimiter. `` ``<!--`` `` is a valid two-backtick span
 * containing a literal `<!--`; a single-backtick-only recognizer left it
 * unshielded.
 *
 * DELIBERATE, STATED RESIDUAL: spans do not cross lines, though CommonMark
 * permits a code span's closing run to land on a later line. Closing this would
 * require recognizing an inline code span BEFORE fence/comment state is known
 * for the lines it spans — but fence and comment detection deliberately run
 * interleaved, in that order (comment-before-fence), specifically because
 * neither can be resolved independently of the other. Giving code spans a
 * document-wide, fence/comment-unaware first pass reopens the exact regression
 * (a fence-shaped line inside a comment misread as a real fence); giving them a
 * document-wide pass AFTER fence/comment resolution needs the interleaved
 * single-pass scanner restructured into multiple dependent passes, which is
 * exactly the general-parser project a hand-rolled recognizer should stop short
 * of, rather than partially build (parse with a real parser, or pin the shape).
 * A multi-line inline span is also a vanishingly rare shape for prose in this
 * specific, first-party, hand-authored doc, where the risk this residual
 * accepts is negligible next to the risk of reintroducing a confirmed
 * regression to close it.
 */
function inlineCodeSpans(line: string): Array<readonly [number, number]> {
  const runs = backtickRuns(line);
  const spans: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < runs.length) {
    const opening = runs[i] as readonly [number, number];
    const len = opening[1] - opening[0];
    let closeIdx = -1;
    for (let j = i + 1; j < runs.length; j++) {
      const candidate = runs[j] as readonly [number, number];
      if (candidate[1] - candidate[0] === len) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      i += 1; // no matching-length close on this line; not a span here
      continue;
    }
    spans.push([opening[0], (runs[closeIdx] as readonly [number, number])[1]]);
    i = closeIdx + 1;
  }
  return spans;
}

/**
 * The next `<!--` in `line` at or after `from` that is NOT inside an inline
 * code span — Markdown renders `` `<!--` `` (or `` ``<!--`` ``, or any
 * matching-backtick-length delimiter) as code, not as the start of a real
 * comment, so treating it as one blanks everything after it (with no closing
 * `-->` in sight) through EOF, suppressing every later real heading/rate line
 * (an earlier fix covered only the single-backtick case). Only applies to
 * finding a comment's START: once `inComment` is already true, nothing about
 * Markdown inline syntax has any meaning inside a real HTML comment, so the
 * search for its closing `-->` is never shielded this way.
 */
function findUnshieldedCommentStart(line: string, from: number): number {
  const spans = inlineCodeSpans(line);
  let i = from;
  for (;;) {
    const idx = line.indexOf("<!--", i);
    if (idx === -1) return -1;
    const shielded = spans.some(([s, e]) => idx >= s && idx < e);
    if (!shielded) return idx;
    i = idx + 4;
  }
}

/**
 * Whether a backtick run followed by `rest` (the text after it, before
 * validating anything else about it) is a CommonMark-legal fence opener.
 * Backtick-fenced info strings may not themselves contain a backtick — that
 * would be ambiguous with an inline code span — so `` ```foo`bar `` is not a
 * fence at all, just a line starting with backticks. Tilde fences carry no such
 * restriction, since `~` cannot appear in a backtick code span or vice versa.
 */
function isValidFenceOpen(char: string, rest: string): boolean {
  return char === "`" ? !rest.includes("`") : true;
}

/**
 * Blanks HTML comments and fenced code blocks (space-preserving, so anything
 * left keeps its original line/column position) before either `WINDOW_RE` or
 * `RATE_RE` ever sees the text.
 *
 * Both regexes are plain-text matchers with no notion of Markdown "rendered"
 * context, so without this a heading- or rate-shaped line sitting inside a
 * fenced example or an HTML comment reads as a real one — exactly the class of
 * defeat a hand-rolled text matcher stays vulnerable to indefinitely, one
 * counterexample per round (this is the class fix, after narrower patches to
 * this same file's own scanning logic, not another variant).
 *
 * Scoped to what this module's two constructs need excluded, not a general
 * CommonMark implementation: a closing fence must be the SAME character as
 * its opener, at least as long, with nothing but whitespace after it, and an
 * opener's info string may not itself contain a backtick — the rules that
 * distinguish a real fence from a longer nested run of the other fence
 * character, a trailing info string, or an invalid backtick opener
 * (`isValidFenceOpen`). Indented (4+ space) code blocks are not separately
 * handled: `WINDOW_RE` already requires 0-3 leading spaces and so cannot
 * match one, and this is a first-party, hand-authored doc with no rendered
 * indented-code-block sections in practice — a stated residual, not a
 * silently missed category among the ones the reviewer actually named.
 *
 * Comment state is checked BEFORE fence recognition, never the reverse: a
 * fence-shaped line inside a multiline HTML comment (`<!--\n\`\`\`\n-->`) is
 * not a real fence, and recognizing it as one left `fence` open past the
 * comment's own close, blanking every real heading/rate line through EOF.
 * Once inside a REAL fence, comment
 * syntax is correctly never scanned at all — `<!--`/`-->` inside a fenced
 * code block are literal text, not a Markdown comment, exactly like
 * CommonMark's own rendering.
 */
function stripNonRenderedMarkdown(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  for (const line of lines) {
    if (fence !== null) {
      const m = FENCE_RUN_RE.exec(line);
      const closes =
        m?.[1] !== undefined &&
        m[1][0] === fence.char &&
        m[1].length >= fence.len &&
        (m[2] ?? "").trim() === "";
      out.push(" ".repeat(line.length));
      if (closes) fence = null;
      continue;
    }
    if (!inComment) {
      const m = FENCE_RUN_RE.exec(line);
      const run = m?.[1];
      if (
        run !== undefined &&
        isValidFenceOpen(run[0] as string, m?.[2] ?? "")
      ) {
        fence = { char: run[0] as string, len: run.length };
        out.push(" ".repeat(line.length));
        continue;
      }
    }
    let result = "";
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf("-->", i);
        if (end === -1) {
          result += " ".repeat(line.length - i);
          break;
        }
        result += " ".repeat(end + 3 - i);
        i = end + 3;
        inComment = false;
      } else {
        const start = findUnshieldedCommentStart(line, i);
        if (start === -1) {
          result += line.slice(i);
          break;
        }
        result += `${line.slice(i, start)}    `;
        i = start + 4;
        inComment = true;
      }
    }
    out.push(result);
  }
  return out.join("\n");
}

/**
 * Pure over the doc TEXT, so it is pinnable without a filesystem — the
 * `readFileSync` wrapper below is the only impure part of this module.
 *
 * `null` on anything this cannot read: no window heading, no rate line AFTER
 * it, MORE THAN ONE candidate rate line within this window's own block (an
 * obsolete line left behind by a correction, or a decoy in a fenced example
 * or comment — ambiguous either way, so neither is preferred over the
 * other), a malformed count, or a doc restructured past what either pattern
 * recognizes. Never a guess — the caller renders the explicit "unmeasured"
 * marker instead.
 *
 * The rate line is matched only in the text AFTER the last window heading,
 * never independently against the whole document. Matching both patterns
 * independently and taking each one's own last occurrence would pair a newly
 * appended window with whatever rate line happens to sort last in the WHOLE
 * document — including a PRIOR window's figure, if the new window's own rate
 * line has not been written yet (or no longer matches `RATE_RE`, e.g. a typo
 * dropping the trailing comma). That silently stamps stale numbers under a
 * fresh window and reads as a measured fact, exactly what "never a guess"
 * above promises not to do.
 */
export function parseRecordedEscapeBaseline(
  docText: string,
): EscapeBaseline | null {
  // Every subsequent scan runs over this BLANKED copy, never the raw
  // `docText` — see `stripNonRenderedMarkdown`'s own doc for why. Blanking
  // preserves line/column positions, so `w.index`/`nextHeading.index` below
  // remain valid offsets into it.
  const scanText = stripNonRenderedMarkdown(docText);
  const windows = [...scanText.matchAll(WINDOW_RE)];
  const w = windows.at(-1);
  if (w === undefined || w.index === undefined) return null;
  // Cross-check against the broader census: anything AFTER this precise
  // match's own text that still looks like it's trying to be a baseline
  // window heading is a malformed newer window the precise regex refused —
  // never silently fall back to this (older, valid) one for it.
  const laterMalformedHeading = [...scanText.matchAll(WINDOW_CENSUS_RE)].some(
    (bm) => bm.index !== undefined && bm.index >= w.index + w[0].length,
  );
  if (laterMalformedHeading) return null;
  // `matchAll`, not `.exec()`/`.match()` with the module-level `RATE_RE`:
  // both of the latter mutate a global-flagged regex's own `lastIndex`
  // across calls, so a second `parseRecordedEscapeBaseline` invocation would
  // silently resume from wherever the previous call left off instead of
  // scanning `afterWindow` from its start. `matchAll` iterates over an
  // internal clone and never touches `RATE_RE.lastIndex`.
  const afterWindowFull = scanText.slice(w.index + w[0].length);
  // Bounded to THIS window's own block — up to the next level-2 heading,
  // whatever it is (another appended window, or an unrelated section such
  // as "## What this licenses"), not the rest of the document. Searching to
  // EOF would let a later, unrelated section's own matching
  // `**Escape rate: ...**` line (an example, a different window whose own
  // rate line has not landed yet) get stamped with THIS window's dates —
  // the doc's own promise is "somewhere in its own block", not "somewhere
  // later in the file".
  // Same legal-indentation hazard as `WINDOW_RE` above: an indented next
  // heading that this pattern failed to recognize would extend the search
  // past this window's own block, re-opening exactly the "unrelated section"
  // hazard the comment above describes. `[ \t]`, not a literal space: a tab
  // is equally legal CommonMark ATX-heading whitespace (`##\tHeading`), and
  // a boundary that only recognized a space would let the scan run past a
  // tab-delimited unrelated section into whatever decoy sits inside it.
  // `(?:[ \t]|$)`, not just `[ \t]`: a
  // bare `##` at end-of-line is ALSO a valid (empty) ATX heading — CommonMark
  // waives the whitespace-after-marker requirement specifically when the
  // heading is empty — so a boundary requiring trailing whitespace missed it
  // and let the scan run past it too.
  const nextHeading = /^ {0,3}##(?:[ \t]|$)/m.exec(afterWindowFull);
  const afterWindow =
    nextHeading === null
      ? afterWindowFull
      : afterWindowFull.slice(0, nextHeading.index);
  // Exactly one, not "at least one": the doc's own convention is one rate line
  // per window. Two matches — an obsolete line left behind when a correction is
  // appended above or below it, or a decoy inside a fenced example or HTML
  // comment within this window's own block — makes `.at(0)` silently prefer
  // whichever sorts first, which can be the STALE one rather than the live
  // figure. Ambiguous is exactly the "duplicate entry where the model assumes
  // uniqueness" shape a scan must fail closed on, so any count other than one
  // degrades to `null` the same as zero already did.
  const rateMatches = [...afterWindow.matchAll(RATE_RE)];
  const r = rateMatches.length === 1 ? rateMatches[0] : undefined;
  if (r === undefined) return null;
  const [, since, until] = w;
  const [, escapedRaw, totalRaw] = r;
  if (
    since === undefined ||
    until === undefined ||
    escapedRaw === undefined ||
    totalRaw === undefined
  ) {
    return null;
  }
  const escaped = Number.parseInt(escapedRaw, 10);
  const total = Number.parseInt(totalRaw, 10);
  if (
    !Number.isFinite(escaped) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    escaped < 0 ||
    // A count of declined findings that escaped can never exceed the count
    // of declined findings measured — an impossible rate above 100% is not
    // a real observation, so treat it the same as any other malformed pair.
    escaped > total ||
    !isValidIsoDate(since) ||
    !isValidIsoDate(until) ||
    // Fixed-width `YYYY-MM-DD` strings compare chronologically as strings,
    // so no `Date` parse is needed for the ordering check.
    since > until
  ) {
    return null;
  }
  return { escaped, total, since, until };
}

/**
 * `WINDOW_RE`/`RATE_RE` only check that a date is digit-shaped
 * (`\d{4}-\d{2}-\d{2}`), which `2026-99-99` satisfies — a stray typo in the
 * doc would otherwise render as an authoritative-looking impossible date
 * rather than degrading to the "unmeasured" marker. Round-trips through
 * `Date.UTC` and checks the components survived, which also rejects
 * calendar overflow (`2026-02-30` silently rolling forward to March).
 */
function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Reads and parses `baselineDocPath()` under `repoRoot`. Best-effort: a
 * missing file, an unreadable one, or a `repoRoot` this process could not
 * resolve all fall through to `null` exactly like a parse failure — see the
 * module header.
 */
export function readRecordedEscapeBaseline(
  repoRoot: string,
): EscapeBaseline | null {
  if (repoRoot === "") return null;
  try {
    const text = readFileSync(join(repoRoot, baselineDocPath()), "utf8");
    return parseRecordedEscapeBaseline(text);
  } catch {
    return null;
  }
}

/**
 * The anchor line an earlier change requires next to every convergence-speed report —
 * the recorded figure with its window, or an explicit "unmeasured" marker.
 * Never silently absent: every caller of this function prints its result
 * unconditionally rather than gating on whether `baseline` is `null`.
 */
export function renderEscapeAnchor(baseline: EscapeBaseline | null): string {
  if (baseline === null) {
    return (
      `  defect-escape anchor: unmeasured for a current window — see ${baselineDocPath()} ` +
      "before reading the numbers above in isolation (policy: drive-pr SKILL.md § What the loop cost)"
    );
  }
  const rate = ((baseline.escaped / baseline.total) * 100).toFixed(1);
  return (
    `  defect-escape anchor: ${baseline.escaped}/${baseline.total} declined findings escaped ` +
    `(≈${rate}%), measured ${baseline.since} → ${baseline.until} — ${baselineDocPath()} ` +
    "(policy: drive-pr SKILL.md § What the loop cost)"
  );
}
