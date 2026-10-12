#!/usr/bin/env bun
/**
 * Write the Refocus intent-chain snapshot.
 *
 * Type: Writer
 * Input: JSON on stdin (or `--input <path>`) — the Linear data `/do-item`
 *   already fetched; see `IntentChainInput`.
 * Output: `<worktree>/.context/intent-chain/<identifier>.md` (or
 *   `--out <path>` to override the content file directly — which writes NO
 *   alias or pointer files at all), plus, on the default path, the worktree
 *   `.current` pointer always and the session snapshot only when a session id
 *   is visible (`CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`; see below), and
 *   an immutable pickup archive for PR capture, and a one-line JSON summary
 *   `{ path, sessionPath, pickupId, chars, arm, truncated, pointerErrors }` on stdout.
 *
 * Usage:
 *     bun intent-chain.ts < chain.json
 *     bun intent-chain.ts --input chain.json --out /tmp/intent-chain.md
 *
 * Exit codes: 0 written, 2 usage, 1 unreadable input, unwritable output, or
 * a PARTIAL write — the content landed but a companion write below
 * failed (stderr names each, and `pointerErrors` in the summary lists them),
 * because a consumer that cannot resolve the content sees a stale or missing
 * chain, which is not a snapshot "written".
 *
 * KEYING: PR capture selects the immutable `pickupId` archive,
 * never mutable item files or aliases; `.current` records the last pickup.
 * Interactive Refocus reads ONLY the full session copy at
 * `.context/refocus-state/<session>.intent-chain.md`, atomically refreshed by
 * this session's explicit pickup. An identifier pointer cannot preserve a
 * batch or sub-issue alias overwritten by a later solo pickup, and neither a
 * branch nor `.current` can recover which content a new session meant to read.
 * The writer uses CLAUDE_CODE_SESSION_ID, then CODEX_THREAD_ID; the hook uses
 * the same precedence, then its payload session_id. No session identity means
 * no session copy; the hook goes quiet until this session makes a pickup.
 *
 * Budget and truncation are specified and implemented once, here, in
 * `renderIntentChain`:
 *   - the whole file stays within BUDGET characters;
 *   - sections are cut lowest-priority first;
 *   - the issue's scope, the out-of-scope group and the sub-issue's scope each
 *     keep their own PROTECTED_FLOOR (never pooled) until every unprotected
 *     section is already gone;
 *   - out-of-scope lines are kept or dropped whole, the first line is always
 *     kept, and every line is capped at LINE_CAP with a trailing marker.
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping): only `node:` APIs,
 * erasable-syntax-only TypeScript — same contract as the sibling scripts.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isEntryPoint, parseArgs } from "./lib/cli.ts";
import {
  prunePickups,
  withFileLock,
  writePickup,
} from "./lib/intent-chain-pickup.ts";

/** Hard ceiling on the rendered snapshot, in characters (code points). */
export const BUDGET = 4000;
/** Per-section minimum for each of the three protected sections. */
export const PROTECTED_FLOOR = 150;
/** Absolute cap on a single out-of-scope line, marker included. */
export const LINE_CAP = 1000;
/**
 * Cap on a single header field (`identifier`, `updatedAt`) in a source line,
 * marker included. `isChainIssue` bounds neither field's length — a real
 * Linear identifier or ISO timestamp is a few dozen characters, but nothing
 * stops a caller from passing something absurd — and the header (up to three
 * source lines) is rendered before the truncation loop below ever runs, so an
 * unbounded field there is invisible to every floor the loop enforces. Capped
 * here instead of validated away, so a malformed field degrades gracefully
 * rather than making the writer refuse to run.
 */
export const SOURCE_FIELD_CAP = 40;
export const TRUNCATION_MARKER = " …[truncated]";
/** First line of every snapshot: the calibration arm, read by the hook and the drive. */
export const ARM_LINE_PREFIX = "<!-- refocus-arm: ";

export interface ChainIssue {
  identifier: string;
  title?: string;
  updatedAt?: string;
  description?: string;
}

export interface IntentChainInput {
  /** `issue` (default) for a single work item, `batch` for `/work-batch`. */
  mode?: "issue" | "batch";
  epic?: ChainIssue | null;
  /** The issue being worked; in batch mode, the batch's anchor. */
  issue: ChainIssue;
  /** The Step 4b sub-issue actually being worked, when there is one. */
  subIssue?: ChainIssue | null;
  /** Batch mode only: every item in the batch (the anchor may be among them). */
  items?: ChainIssue[];
}

export type RefocusArm = "on" | "off";

export interface RenderedChain {
  text: string;
  arm: RefocusArm;
  /** Section keys that lost content to the budget, lowest priority first. */
  truncated: string[];
}

// ── String helpers (code-point aware, so the budget matches the hook's jq) ──

const clen = (s: string): number => Array.from(s).length;
const cslice = (s: string, n: number): string =>
  Array.from(s).slice(0, n).join("");

/** Cut `s` to at most `max` code points, marker included. */
export function capWithMarker(s: string, max: number): string {
  if (clen(s) <= max) return s;
  const keep = Math.max(0, max - clen(TRUNCATION_MARKER));
  return `${cslice(s, keep)}${TRUNCATION_MARKER}`;
}

/**
 * Count of literal `<!--` occurrences (non-overlapping, left-to-right) —
 * exactly what both consumers' escaping (`.claude/hooks/refocus.sh`'s
 * `gsub("<!--"; "&lt;!--")`, `handoff.ts`'s `defangIntentChain`) expands, one
 * per occurrence.
 */
export function countCommentOpeners(s: string): number {
  return (s.match(/<!--/g) ?? []).length;
}

/** `&lt;!--` (7 chars) replacing `<!--` (4 chars): +3 per occurrence. */
const ESCAPE_GROWTH_PER_OPENER = clen("&lt;!--") - clen("<!--");

/**
 * The length both consumers actually cap against: each strips the
 * arm line (line 1) before escaping — `refocus.sh`'s `emit` with
 * `sub("^<!-- refocus-arm: [a-z]+ -->\n"; "")`, `handoff.ts`'s
 * `intentChainSection` with `lines.slice(1)` — then expands every `<!--` to
 * `&lt;!--`. Counting occurrences on the PRE-escape body is equivalent to
 * counting on the escaped one: the bracket-defang step neither of them skips
 * only ever rewrites a `<` immediately followed by an `intent_chain` tag
 * shape (the same lookahead `renderHandoff`'s own envelope rule uses), which
 * `<!--` never is, so it can neither create nor destroy a `<!--` sequence.
 */
export function postEscapeBodyLen(fullText: string): number {
  const nl = fullText.indexOf("\n");
  const body = nl === -1 ? "" : fullText.slice(nl + 1);
  return clen(body) + ESCAPE_GROWTH_PER_OPENER * countCommentOpeners(body);
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Reduce Linear's markdown to what an agent needs to read: inline issue/PR
 * mention tags become their text, and link targets are dropped (a URL spends
 * budget without telling the agent anything about the boundary).
 */
export function normalizeMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/<(issue|pull-request)\b[^>]*>([\s\S]*?)<\/\1>/g, "$2")
    .replace(/\[([^\]\n]+)\]\(<[^>\n]*>\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1");
}

// ` {0,3}` — CommonMark allows an ATX heading up to 3 leading spaces of
// indentation before it stops being a heading at all (4+ becomes an indented
// code block); anchoring at column zero missed a legally-indented `##
// Acceptance Criteria` and swallowed it as body text of whatever section
// preceded it (a construct at a legal-but-unexpected indentation must still
// be recognised: Markdown allows 1–3 leading spaces).
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** A bold label on its own line: `**Acceptance Criteria:**`, `**Excluded**`. */
const BOLD_LABEL_RE = /^\*\*([^*]+?)\*\*:?\s*$/;
const labelName = (raw: string) =>
  raw.replace(/:\s*$/, "").trim().toLowerCase();

/**
 * Body of the first section whose heading (any level ≥ 2) or standalone bold
 * label matches one of `names`, case-insensitively. A heading section ends at
 * the next heading of the same or a higher level; a bold-label block ends at
 * the next heading, horizontal rule, or bold label.
 */
export function extractSection(md: string, names: readonly string[]): string {
  return extractAllSections(md, names)[0] ?? "";
}

/**
 * Every section `extractSection` would match, in document order. A NESTED
 * block that independently matches `wanted` too — `### Non-goals` inside
 * `## Out of scope`, or a `**Excluded**` bold label inside either — is its
 * own separate entry, not folded into the enclosing match's body: the body
 * loop below stops at it (leaving it for this same scan to pick up on its
 * next iteration) rather than consuming it as plain text. Consuming it used
 * to both merge it into the last list item of the enclosing body (`listItems`
 * has no heading syntax, so `### Non-goals` became trailing text on whatever
 * bullet preceded it) and skip past it entirely, so it was never reported at
 * all. A nested block that does NOT
 * itself match `wanted` is unaffected and stays folded into the enclosing
 * body, same as before.
 */
export function extractAllSections(
  md: string,
  names: readonly string[],
): string[] {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const lines = md.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Both HEADING_RE groups are mandatory, so a match always carries them.
    const h = HEADING_RE.exec(line);
    const hashes = h?.[1] ?? "";
    if (h && hashes.length >= 2 && wanted.has(labelName(h[2] ?? ""))) {
      const level = hashes.length;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const lineJ = lines[j];
        if (lineJ === undefined) break;
        const next = HEADING_RE.exec(lineJ);
        if (next) {
          if ((next[1] ?? "").length <= level) break;
          if (wanted.has(labelName(next[2] ?? ""))) break;
        } else {
          const nextBold = BOLD_LABEL_RE.exec(lineJ.trim());
          if (nextBold && wanted.has(labelName(nextBold[1] ?? ""))) break;
        }
        body.push(lineJ);
      }
      found.push(trimBlock(body.join("\n")));
      i = j - 1;
      continue;
    }
    // BOLD_LABEL_RE's one group is mandatory, so a match always carries it.
    const b = BOLD_LABEL_RE.exec(line.trim());
    if (b && wanted.has(labelName(b[1] ?? ""))) {
      const body = boldBlock(lines, i + 1);
      found.push(trimBlock(body.join("\n")));
      i += body.length;
    }
  }
  return found;
}

function boldBlock(lines: string[], start: number): string[] {
  const body: string[] = [];
  for (let j = start; j < lines.length; j++) {
    const line = lines[j];
    if (line === undefined) break;
    const t = line.trim();
    if (HEADING_RE.test(line) || /^(-{3,}|\*{3,})$/.test(t)) break;
    if (BOLD_LABEL_RE.test(t)) break;
    body.push(line);
  }
  return body;
}

function trimBlock(s: string): string {
  return s
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "")
    .replace(/\n{3,}/g, "\n\n");
}

const INTENT_RE = /^\*\*Intent:\*\*\s*(.+?)\s*$/m;

/** The epic's `**Intent:**` line, rendered by `/plan-epic` from `executionIntent`. */
export function extractIntent(md: string): string {
  return INTENT_RE.exec(md)?.[1] ?? "";
}

const INCLUDED_LABELS = ["included", "in scope", "in-scope"];
const EXCLUDED_LABELS = [
  "excluded",
  "out of scope",
  "out-of-scope",
  "non-goals",
  "not in scope",
];

/**
 * Split a `## Scope` section into its included text and excluded lines.
 * Without `**Included**` / `**Excluded**` labels the whole section is the
 * included scope, which keeps older issues (filed before the template carried
 * the structured section) usable.
 */
export function extractScope(md: string): {
  included: string;
  excluded: string[];
} {
  const scope = extractSection(md, ["scope"]);
  const inc = extractSection(scope, INCLUDED_LABELS);
  const exc = extractSection(scope, EXCLUDED_LABELS);
  // Every excluded-labelled block in the whole description, not just the
  // first: an issue filed from the template carries `**Excluded**` inside
  // `## Scope`, and a later hand-added `## Out of scope` section must not be
  // shadowed by it. Duplicate lines collapse to one.
  const excluded = [
    ...new Set(extractAllSections(md, EXCLUDED_LABELS).flatMap(listItems)),
  ];
  const included = inc || (exc ? "" : scope);
  return { included, excluded };
}

/** A bullet marker at any indentation, split into its leading whitespace, the
 * marker itself, the whitespace after it, and the item's first line of
 * content — `listItems` needs all four to compute the item's content column. */
const BULLET_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;

/** CommonMark tab stops are every 4 columns; a marker's column is what decides
 * whether it is nested, so a leading tab must count as its stop, not as 1. */
function advanceColumn(col: number, ws: string): number {
  let c = col;
  for (const ch of ws) c = ch === "\t" ? c + (4 - (c % 4)) : c + 1;
  return c;
}

/**
 * One entry per top-level list item; continuation lines and nested bullets
 * fold into their parent item. Non-list prose counts as one item per
 * paragraph, so a boundary written as a sentence is not lost.
 *
 * Nesting follows CommonMark's own rule: a bullet belongs to the
 * current item — a nested continuation folded into it — when its marker sits
 * at or past that item's CONTENT column (the marker's column plus the
 * marker's width plus the gap after it); a bullet marker before that column
 * is a sibling and starts a new item. Comparing against the content column,
 * not the first marker's column, is what reads ` - a\n  - b` as two siblings
 * (the second marker sits before the first item's content column at 3), a
 * uniformly 1-3-space-indented list as flat siblings, and the 2-space nested
 * bullet under a column-zero `- ` as folded, from the same one rule.
 *
 * A marker only counts as a marker at 0-3 columns of indentation when it
 * would START an item: four or more columns is an indented code block, so a
 * line like `    - example command` outside any item is prose (kept whole,
 * marker text included — never dropped), and the same line inside an item
 * whose content column it does not reach is a continuation of that item's
 * paragraph. A blank line does not by itself end the current item: CommonMark
 * keeps a loose list's nested content together, so what follows a blank line
 * stays in the item when it is indented to the item's content column or past
 * it (`- a\n\n  - b` is one item with a child) and starts fresh otherwise.
 */
export function listItems(block: string): string[] {
  const items: string[] = [];
  let cur: string | null = null;
  // The current item's content column; null when there is no item, or the
  // item is a prose paragraph (which has no content column for a bullet to
  // nest under).
  let contentCol: number | null = null;
  const flush = () => {
    if (cur?.trim()) items.push(cur.trim().replace(/\s+/g, " "));
    cur = null;
    contentCol = null;
  };
  let afterBlank = false;
  for (const line of block.split("\n")) {
    if (!line.trim()) {
      afterBlank = true;
      continue;
    }
    if (afterBlank) {
      afterBlank = false;
      // Still inside the item only when indented to its content column.
      const lineIndent = advanceColumn(0, /^[ \t]*/.exec(line)?.[0] ?? "");
      if (contentCol === null || lineIndent < contentCol) flush();
    }
    const m = BULLET_RE.exec(line);
    if (m) {
      // All four BULLET_RE groups are mandatory, so a match always carries
      // them (the content group may be empty, never absent).
      const [, lead = "", marker = "", gap = "", content = ""] = m;
      const indent = advanceColumn(0, lead);
      if (contentCol !== null && indent >= contentCol) {
        cur = `${cur ?? ""} ${content}`;
        continue;
      }
      if (indent < 4) {
        flush();
        const markerEnd = indent + marker.length;
        const afterGap = advanceColumn(markerEnd, gap);
        // 5+ columns of gap means the content is itself indented code and
        // the item's content column is one column past the marker.
        contentCol = afterGap - markerEnd > 4 ? markerEnd + 1 : afterGap;
        cur = content;
        continue;
      }
    }
    cur = `${cur ?? ""} ${line.trim()}`;
  }
  flush();
  return items;
}

// ── Calibration arm (plan W1 step 5) ────────────────────────────────────────

/**
 * Whether Refocus is on for this work item. `JIG_REFOCUS` forces it
 * (`1`/`on`, `0`/`off`); otherwise the calibration splits by the parity of
 * the snapshot's `issue` number — odd is on. That is the unit a PR delivers:
 * the picked-up issue, a batch's anchor, or — when an epic is picked up — the
 * sub-issue being worked. Bucketing by work item rather than by session keeps
 * a pickup, its later resumes and its drive in the same arm, which is what
 * the per-PR comparison needs, and makes the arm reproducible from the
 * identifier alone when the results are analysed.
 */
export function refocusArm(
  identifier: string,
  override: string | undefined,
): RefocusArm {
  const o = override?.trim().toLowerCase();
  if (o === "1" || o === "on") return "on";
  if (o === "0" || o === "off") return "off";
  const n = /-(\d+)$/.exec(identifier)?.[1];
  if (n === undefined) return "off";
  return Number(n.at(-1)) % 2 === 1 ? "on" : "off";
}

// ── Rendering and budget ────────────────────────────────────────────────────

interface TextSection {
  kind: "text";
  key: string;
  heading: string;
  text: string;
  protected: boolean;
}
interface LinesSection {
  kind: "lines";
  key: string;
  heading: string;
  lines: string[];
  protected: boolean;
}
type Section = TextSection | LinesSection;

function renderSection(s: Section): string {
  if (s.kind === "text") {
    return s.text ? `## ${s.heading}\n\n${s.text}\n` : "";
  }
  return s.lines.length
    ? `## ${s.heading}\n\n${s.lines.map((l) => `- ${l}`).join("\n")}\n`
    : "";
}

function renderAll(header: string, sections: Section[]): string {
  return [header, ...sections.map(renderSection).filter(Boolean)].join("\n");
}

/** Whole out-of-scope lines that fit the floor, in order; the first always stays. */
function linesWithinFloor(lines: string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    const n = clen(l);
    if (kept.length > 0 && used + n > PROTECTED_FLOOR) break;
    kept.push(l);
    used += n;
  }
  return kept;
}

/**
 * Cap an identifier at `SOURCE_FIELD_CAP` wherever it is embedded into
 * rendered text — a section heading or a batch-item line, not just the
 * header's own source lines. `isChainIssue` bounds an identifier's format,
 * never its length, so every embed site needs this, not only `sourceLine`:
 * an uncapped identifier in a section `heading` is invisible to the
 * truncation loop below (which only shrinks a section's `text`/`lines`, never
 * its `heading`), so it can make the header-plus-headings alone exceed
 * BUDGET before that loop ever runs — at which point the final backstop cap
 * fires for real and prefix-slices away whatever protected content comes
 * after it, exactly the failure `SOURCE_FIELD_CAP` was introduced to prevent
 * for the header.
 */
function capId(identifier: string): string {
  return capWithMarker(identifier, SOURCE_FIELD_CAP);
}

function sourceLine(role: string, i: ChainIssue): string {
  const title = i.title
    ? ` — ${capWithMarker(normalizeMarkdown(i.title), 120)}`
    : "";
  const updatedAt = capWithMarker(i.updatedAt ?? "unknown", SOURCE_FIELD_CAP);
  return `- ${capId(i.identifier)} (${role}, updated ${updatedAt})${title}`;
}

export function renderIntentChain(
  input: IntentChainInput,
  override: string | undefined,
): RenderedChain {
  const mode = input.mode ?? "issue";
  const epicMd = normalizeMarkdown(input.epic?.description ?? "");
  const issueMd = normalizeMarkdown(input.issue.description ?? "");
  const subMd = normalizeMarkdown(input.subIssue?.description ?? "");
  const arm = refocusArm(input.issue.identifier, override);

  const issueScope = extractScope(issueMd);
  const epicScope = extractScope(epicMd);
  const subScope = extractScope(subMd);
  // extractScope already dedupes within one description; a boundary restated
  // at another level (a sub-issue repeating its parent's out-of-scope line)
  // must not be counted twice against the protected floor, or its duplicate
  // copies can crowd out a distinct boundary that would otherwise fit.
  const outOfScope = [
    ...new Set([
      ...epicScope.excluded,
      ...issueScope.excluded,
      ...subScope.excluded,
    ]),
  ].map((l) => capWithMarker(l, LINE_CAP));

  const scopeText =
    mode === "batch"
      ? (input.items ?? [])
          .map(
            (it) =>
              `- ${capId(it.identifier)}${it.title ? ` — ${normalizeMarkdown(it.title)}` : ""}`,
          )
          .join("\n")
      : issueScope.included || input.issue.title || "";

  const subText = input.subIssue
    ? subScope.included ||
      extractSection(subMd, ["acceptance criteria"]) ||
      input.subIssue.title ||
      ""
    : "";

  // Priority order, highest first (plan W1 step 1).
  const sections: Section[] = [
    {
      kind: "text",
      key: "intent",
      heading: "Epic intent",
      text: extractIntent(epicMd),
      protected: false,
    },
    // `epicScope.included` was computed above but never rendered anywhere —
    // an epic's own `## Scope` boundary was silently dropped in every arm,
    // not just the epic-labeled sub-issue one: when the selected sub-issue
    // is passed as `issue` and the epic as `epic`, "Issue scope" shows only
    // the child's boundary and the epic's own included scope had nowhere to
    // render at all.
    {
      kind: "text",
      key: "epic-scope",
      heading: "Epic scope",
      text: epicScope.included,
      protected: false,
    },
    {
      kind: "text",
      key: "epic-acceptance",
      heading: "Epic acceptance criteria",
      text: extractSection(epicMd, ["acceptance criteria", "acceptance"]),
      protected: false,
    },
    {
      kind: "text",
      key: "issue-scope",
      heading:
        mode === "batch"
          ? "Batch items"
          : `Issue scope (${capId(input.issue.identifier)})`,
      text: scopeText,
      protected: true,
    },
    {
      kind: "text",
      key: "issue-acceptance",
      heading: `Issue acceptance criteria (${capId(input.issue.identifier)})`,
      text: extractSection(issueMd, ["acceptance criteria", "acceptance"]),
      protected: false,
    },
    {
      kind: "lines",
      key: "out-of-scope",
      heading: "Out of scope",
      lines: outOfScope,
      protected: true,
    },
    {
      kind: "text",
      key: "sub-issue-scope",
      heading: `Sub-issue scope (${input.subIssue ? capId(input.subIssue.identifier) : ""})`,
      text: subText,
      protected: true,
    },
  ];

  const sources = [
    input.epic ? sourceLine("epic", input.epic) : null,
    sourceLine(mode === "batch" ? "batch anchor" : "issue", input.issue),
    input.subIssue ? sourceLine("sub-issue", input.subIssue) : null,
  ].filter((l): l is string => l !== null);
  const header = [
    `${ARM_LINE_PREFIX}${arm} -->`,
    "# Intent chain",
    "",
    "Sources (a Linear edit after these timestamps is not reflected here):",
    ...sources,
    "",
  ].join("\n");

  const truncated: string[] = [];
  // Both consumers strip the arm line, then escape every literal
  // `<!--` to `&lt;!--` (+3 characters each) before applying their own
  // BUDGET cap. A render that only just fits pre-escape can grow past BUDGET
  // once escaped, and the consumer's cap is a naive prefix slice with no
  // notion of section priority — it can then cut into a PROTECTED section
  // this writer never intended to sacrifice. `over()` therefore takes the
  // worse of the raw length and the post-escape length, so the loop below
  // keeps shrinking until the snapshot fits BOTH — see `postEscapeBodyLen`.
  const over = () => {
    const full = renderAll(header, sections);
    return Math.max(clen(full) - BUDGET, postEscapeBodyLen(full) - BUDGET);
  };
  const lowFirst = [...sections].reverse();

  // Phase 1: lowest priority first; protected sections stop at their floor.
  // Phase 2: protected sections below their floor — reached only when every
  // unprotected section is already gone, since phase 1 emptied those.
  for (const phase of [1, 2] as const) {
    for (const s of lowFirst) {
      if (over() <= 0) break;
      if (phase === 2 && !s.protected) continue;
      const before = renderSection(s);
      shrink(s, phase === 1 && s.protected ? "floor" : "zero", over);
      if (renderSection(s) !== before && !truncated.includes(s.key))
        truncated.push(s.key);
    }
  }

  let text = renderAll(header, sections);
  // Every header field is capped (title at 120, identifier/updatedAt at
  // SOURCE_FIELD_CAP), so up to three source lines plus the fixed intro text
  // stays a few hundred characters at most — nowhere near BUDGET even before
  // the sections above are counted. This final cap is therefore a backstop
  // that should never fire, not a load-bearing guarantee.
  if (clen(text) > BUDGET) text = capWithMarker(text, BUDGET);
  return { text, arm, truncated };
}

/** Shrink one section until the snapshot fits or the section reaches its limit. */
function shrink(s: Section, limit: "floor" | "zero", over: () => number): void {
  if (s.kind === "lines") {
    const floorLines = limit === "floor" ? linesWithinFloor(s.lines) : [];
    while (over() > 0 && s.lines.length > floorLines.length) s.lines.pop();
    return;
  }
  if (!s.text) return;
  const floor = limit === "floor" ? PROTECTED_FLOOR : 0;
  const excess = over();
  if (excess <= 0) return;
  const len = clen(s.text);
  // Truncating to N content characters adds the marker; keep ≥ floor content.
  const target = len - excess - clen(TRUNCATION_MARKER);
  if (target >= len) return;
  if (target <= 0 && floor === 0) {
    s.text = "";
    return;
  }
  const keep = Math.max(floor, target);
  // Cutting to the floor only helps when floor + marker is shorter than the
  // section already is; otherwise the "truncated" section would grow.
  if (keep + clen(TRUNCATION_MARKER) >= len) return;
  s.text = `${cslice(s.text, keep)}${TRUNCATION_MARKER}`;
  // A heading line the section no longer needs can still leave us over by a
  // few characters; an unprotected section just goes.
  if (over() > 0 && floor === 0) s.text = "";
}

// ── Input validation ────────────────────────────────────────────────────────

function isChainIssue(v: unknown): v is ChainIssue {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.identifier === "string" &&
    /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(o.identifier) &&
    (o.title === undefined || typeof o.title === "string") &&
    (o.updatedAt === undefined || typeof o.updatedAt === "string") &&
    (o.description === undefined || typeof o.description === "string")
  );
}

export function isIntentChainInput(v: unknown): v is IntentChainInput {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const optional = (x: unknown) =>
    x === undefined || x === null || isChainIssue(x);
  return (
    (o.mode === undefined || o.mode === "issue" || o.mode === "batch") &&
    isChainIssue(o.issue) &&
    optional(o.epic) &&
    optional(o.subIssue) &&
    (o.items === undefined ||
      (Array.isArray(o.items) && o.items.every(isChainIssue))) &&
    // A batch with zero items renders no `Batch items` section at all — the
    // whole reason batch mode exists — so an empty array is rejected here,
    // not merely "items present but empty".
    (o.mode !== "batch" || (Array.isArray(o.items) && o.items.length > 0))
  );
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: intent-chain.ts [--input <path>] [--out <path>]   (JSON on stdin when --input is absent)";

/** Item and session snapshots unused for this window are pruned on writes.
 * drive-pr refreshes its PR pins when it renders them; Refocus refreshes its
 * session copy on every event, even on quiet or off-arm events, because the
 * session identity remains live. Both consumers read independent copies. */
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** A PR-scoped pin (`pr.<N>.md`, written by drive-pr's `capture-intent-chain.ts`,
 *) outlives the per-item window: the drive refreshes it on every
 * re-arm and every round that renders the handoff section (armed or not), so
 * a pin on a PR being driven never ages; one on a PR parked awaiting a human
 * for weeks would still be deleted by the very next unrelated pickup's write
 * under the shorter window, after which the round reports a missing pin. Still bounded, so pins of PRs that
 * merged (no drive touching them) do not accumulate forever. */
const PIN_STALE_MS = 90 * 24 * 60 * 60 * 1000;
const PIN_NAME = /^pr\.\d+\.md$/;

function repoRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}

/** Atomic write: tmp file in the same directory, then rename. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // A failed write (a full disk leaves a partial file) or rename must not
    // strand the tmp file — nothing else prunes it.
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone; the rename error below is the one worth reporting.
    }
    throw err;
  }
}

/** A failed explicit pickup must not leave the previous session's scope live.
 * Remove the stale copy on a failed replacement; inability to remove it is
 * reported alongside the write failure rather than claimed as fail-closed. */
function writeSessionSnapshot(path: string, text: string): void {
  try {
    writeAtomic(path, text);
  } catch (writeError) {
    try {
      unlinkSync(path);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `${(writeError as Error).message}; cannot remove stale session snapshot: ${(cleanupError as Error).message}`,
        );
      }
    }
    throw writeError;
  }
}

/** Sanitize a session id the same way `refocus.sh` does (`tr -c
 * 'A-Za-z0-9_-' '_'`), so the two implementations name the identical snapshot
 * file for the identical session. */
function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** This process's session id (Claude Code, or Codex's thread id); an empty
 * value counts as unset. */
function currentSessionId(): string | undefined {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
}

function sessionSnapshotPath(root: string, sessionId: string): string {
  return join(
    root,
    ".context",
    "refocus-state",
    `${sanitizeSessionId(sessionId)}.intent-chain.md`,
  );
}

/** Failed-pickup policy for the paths that fail BEFORE a session copy is
 * written (unreadable or invalid input, an unwritable primary snapshot): the
 * previous pickup's copy must not stay live for a pickup that failed. Skipped
 * under `--out`, which opts out of the worktree convention. A removal that
 * fails is reported, never claimed as fail-closed. */
function discardStaleSessionSnapshot(outOverride: string | undefined): void {
  const sessionId = currentSessionId();
  if (outOverride || !sessionId) return;
  const path = sessionSnapshotPath(repoRoot(), sessionId);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error(
      `intent-chain: cannot remove stale session snapshot ${path}: ${(err as Error).message}`,
    );
  }
}

/** Best-effort: delete `.md` files under `dir` untouched for `STALE_MS`.
 * Never throws — a prune failure must not block the write it rides along
 * with. */
function pruneStale(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const limit = PIN_NAME.test(name) ? PIN_STALE_MS : STALE_MS;
      // Skip clearly recent files before taking the lock: a contended lock
      // costs up to its wait, which must not be paid per fresh file.
      if (now - statSync(path).mtimeMs <= limit) continue;
      // The expiry decision is re-made and the unlink done under `<file>.lock`,
      // which serializes this prune against the TypeScript renewers (capture
      // re-arm, handoff render, pin repair). Two writers do NOT take it: the
      // Refocus hook's shell `touch` of a session copy and the atomic
      // replacement of a snapshot by a new pickup. The residual is a file
      // untouched for the whole retention window being renewed or replaced in
      // the instant between this re-stat and the unlink — accepted, since a
      // session dormant that long has no live scope to lose and a shell hook
      // cannot join this lock. Do not widen the lock further to chase it.
      withFileLock(`${path}.lock`, () => {
        if (now - statSync(path).mtimeMs > limit) unlinkSync(path);
      });
    } catch {
      // Best effort — a file that vanished or can't be stat'd is not this
      // writer's problem.
    }
  }
}

/**
 * Every OTHER identifier a branch for this work may legitimately be named
 * after: a batch's items (`/work-batch` names the branch after its
 * highest-priority item, not the anchor) and a selected sub-issue
 * (`/do-item` keeps the parent as `issue` and adds the child as
 * `subIssue`). Non-PR source lookup resolves the branch identifier, so each gets a
 * copy for non-PR source lookup; the immutable pickup owns the same IDs.
 */
export function aliasIdentifiers(
  input: IntentChainInput,
  identifier: string,
): string[] {
  // `items` is a batch-only field (`/do-item` Step 3.5 sends it only from
  // `/work-batch`): honoured for aliasing only in batch mode, so a malformed
  // single-issue input carrying `items` cannot overwrite another item's stored
  // chain.
  const ids = [
    input.subIssue?.identifier,
    ...(input.mode === "batch" ? (input.items ?? []) : []).map(
      (i) => i.identifier,
    ),
  ];
  return [
    ...new Set(ids.filter((id): id is string => !!id && id !== identifier)),
  ];
}

export function main(argv: string[]): number {
  const parsed = parseArgs(argv, {
    flags: [],
    values: ["input", "out"],
    usage: USAGE,
    noPositional: true,
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    // A rejected invocation has no parsed `--out`, so read the exemption off
    // argv itself: any `--out` / `--out=…` token opts out, even a malformed one.
    const hasOut = argv.some((a) => a === "--out" || a.startsWith("--out="));
    discardStaleSessionSnapshot(hasOut ? "argv-out" : undefined);
    return 2;
  }
  let input: unknown;
  try {
    const src = parsed.args.values.get("input");
    input = JSON.parse(readFileSync(src ?? 0, "utf8"));
  } catch (err) {
    console.error(`intent-chain: unreadable input: ${(err as Error).message}`);
    discardStaleSessionSnapshot(parsed.args.values.get("out"));
    return 1;
  }
  if (!isIntentChainInput(input)) {
    console.error(
      "intent-chain: input must be { issue: { identifier, ... }, epic?, subIssue?, mode?, items? } with Linear identifiers",
    );
    discardStaleSessionSnapshot(parsed.args.values.get("out"));
    return 1;
  }
  const identifier = input.issue.identifier;
  const outOverride = parsed.args.values.get("out");
  // `repoRoot()` shells out to git — evaluated lazily, and only for the
  // default (no `--out`) path, exactly like the older code's `??
  // defaultOutPath()`. An explicit `--out` opts out of the whole worktree
  // convention: there is no worktree-relative `.current`/session snapshot a
  // caller pointing somewhere else would want written, and a test harness
  // passing `--out` must not have this process shell out to git or touch the
  // real repo's `.context/` as a side effect.
  let root: string | null = null;
  let chainDir: string | null = null;
  let out: string;
  if (outOverride) {
    out = outOverride;
  } else {
    root = repoRoot();
    chainDir = join(root, ".context", "intent-chain");
    out = join(chainDir, `${identifier}.md`);
  }
  const rendered = renderIntentChain(input, process.env.JIG_REFOCUS);
  try {
    writeAtomic(out, rendered.text);
  } catch (err) {
    console.error(
      `intent-chain: cannot write ${out}: ${(err as Error).message}`,
    );
    discardStaleSessionSnapshot(outOverride);
    return 1;
  }
  // The aliases and pointers below are what let the consumers FIND the
  // content, so a failed write of one is a partial snapshot, not a success:
  // every failure is collected, named on stderr, listed in the summary's
  // `pointerErrors`, and turns the exit code to 1. Pruning stays best-effort —
  // it only ever removes files already past their retention window.
  let sessionPath: string | null = null;
  let pickupId: string | null = null;
  const pointerErrors: string[] = [];
  const attempt = (what: string, write: () => void) => {
    try {
      write();
    } catch (err) {
      pointerErrors.push(`${what}: ${(err as Error).message}`);
    }
  };
  if (root && chainDir) {
    const dir = chainDir;
    attempt("immutable pickup", () => {
      pickupId = writePickup(
        dir,
        [identifier, ...aliasIdentifiers(input, identifier)],
        rendered.text,
      );
    });
    for (const alias of aliasIdentifiers(input, identifier)) {
      attempt(`alias snapshot ${alias}.md`, () =>
        writeAtomic(join(dir, `${alias}.md`), rendered.text),
      );
    }
    attempt(".current pointer", () =>
      writeAtomic(join(dir, ".current"), identifier),
    );
    // Claude Code sets `CLAUDE_CODE_SESSION_ID`; Codex sets neither that nor
    // any CLAUDE_* name, but exposes its session as `CODEX_THREAD_ID`. An
    // empty value counts as unset.
    const sessionId = currentSessionId();
    if (sessionId) {
      const sessionRoot = root;
      attempt("session snapshot", () => {
        const path = sessionSnapshotPath(sessionRoot, sessionId);
        writeSessionSnapshot(path, rendered.text);
        sessionPath = path;
      });
    }
    pruneStale(chainDir);
    prunePickups(chainDir);
    pruneStale(join(root, ".context", "refocus-state"));
  }
  console.log(
    JSON.stringify({
      path: out,
      sessionPath,
      pickupId,
      chars: clen(rendered.text),
      arm: rendered.arm,
      truncated: rendered.truncated,
      pointerErrors,
    }),
  );
  if (pointerErrors.length > 0) {
    console.error(
      `intent-chain: snapshot written to ${out}, but ${pointerErrors.length} companion write(s) failed — Refocus consumers may read a stale or missing chain:\n  ${pointerErrors.join("\n  ")}`,
    );
    return 1;
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) process.exit(main(process.argv.slice(2)));
