#!/usr/bin/env bun
// Scan promoted docs only (`approved` unless docs.promoted_statuses says
// otherwise), masking fenced and inline code before scar checks.
import {
  cli,
  frontmatterValue,
  markdownFiles,
  readDocument,
  splitLines,
} from "../lib/docs.ts";
import { loadPromotedStatuses } from "../lib/settings.ts";

/**
 * Resolution phrasing opening a list or quote item's content, after any
 * checkbox or emphasis marker: `- Addressed: …`, never `- Hosts are addressed`.
 */
const RESOLUTION = new RegExp(
  "^\\s*(?:(?:[-*>]|\\d+\\.)\\s+)+(?:\\[[ x]\\]\\s+)?(?:(?:\\*\\*|__|\\*|_)\\s*)?" +
    "(?:addressed|fixed as suggested|good catch|as per review|as requested|resolved per review|done as suggested)\\b",
);
const REVIEWER = "reviewer|coderabbit(?:ai)?|codex|copilot|shadow reviewer";
/** A reviewer named and followed by a colon, anywhere in a list or quote item. */
const ATTRIBUTION = new RegExp(`(${REVIEWER})\\s*:`);
/**
 * A reviewer named, plain, and followed by a colon in a table's first cell. A
 * bold or italic name is a label, not a trace: `**CodeRabbit**: …` heads a
 * tool comparison.
 */
const TABLE_ATTRIBUTION = new RegExp(`^\\s*\\|\\s*(${REVIEWER})\\s*:`);
/** The same, opening a plain paragraph: only a reviewer, never a tool's name. */
const PARAGRAPH_ATTRIBUTION = /^\s*(reviewer|shadow reviewer)\s*:/;
/** A review bot's account name, as GitHub prints it. */
const BOT_HANDLE =
  /(?<![\w-])(?:coderabbitai|copilot|codex|[a-z0-9-]*review[a-z0-9-]*)\[bot\]/;
/** An ATX heading, a dash underline, or a thematic break: a block of its own. */
const BLOCK_BOUNDARY =
  /^\s{0,3}(?:#{1,6}(?:\s|$)|-+\s*$|([-*_])(?:\s*\1){2,}\s*$)/;
/** An equals-only line underlines a heading only below paragraph content. */
const EQUALS_UNDERLINE = /^\s{0,3}=+\s*$/;
/** Stands in for inline code: not whitespace, so masking opens no prefix. */
const CODE_MASK = "\u0001";

/** Index just past the backtick run starting at `from`. */
function runEnd(line: string, from: number): number {
  let end = from;
  while (line[end] === "`") end++;
  return end;
}

/** Start of the next backtick run of exactly `size` at or after `from`, or -1. */
function findClose(line: string, from: number, size: number): number {
  let at = line.indexOf("`", from);
  while (at >= 0) {
    const end = runEnd(line, at);
    if (end - at === size) return at;
    at = line.indexOf("`", end);
  }
  return -1;
}

/** Whether the backtick at `at` is escaped by an odd run of backslashes. */
function escaped(text: string, at: number, floor: number): boolean {
  let slashes = 0;
  while (at - 1 - slashes >= floor && text[at - 1 - slashes] === "\\") {
    slashes++;
  }
  return slashes % 2 === 1;
}

/**
 * Replace each inline code span with one mask. A span opens at an unescaped
 * backtick run and closes at the next run of exactly the same length; a run
 * with no such partner is literal text, so shorter or longer runs never close
 * a span. Line endings inside a span are kept so the text splits back into the
 * lines it came from.
 */
function maskCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("`", i);
    if (open < 0) return out + text.slice(i);
    if (escaped(text, open, i)) {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const end = runEnd(text, open);
    const close = findClose(text, end, end - open);
    out += text.slice(i, open);
    if (close < 0) {
      out += text.slice(open, end);
      i = end;
    } else {
      const stop = close + (end - open);
      // Every physical line the span occupies keeps a mask, so text after the
      // span's close never reads as the opening of a table row or list item.
      out +=
        CODE_MASK +
        text
          .slice(open, stop)
          .replace(/[^\n]+/g, "")
          .replace(/\n/g, `\n${CODE_MASK}`);
      i = stop;
    }
  }
  return out;
}

/** A bullet item, or an ordered item numbered 1: opens a list inside a paragraph. */
const LIST_OPENER = /^\s*(?:[-*+]|1[.)])\s/;
/** Any ordered item: follows a sibling item of an ordered list. */
const ORDERED_ITEM = /^\s*\d+[.)]\s/;
/** Leading blockquote markers, with the content that follows them. */
const QUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/;

/** A line's content with its blockquote markers removed, and their count. */
function unquote(raw: string): { content: string; depth: number } {
  const prefix = QUOTE_PREFIX.exec(raw)?.[0] ?? "";
  return {
    content: raw.slice(prefix.length),
    depth: prefix.split(">").length - 1,
  };
}

/**
 * Whether `raw` ends the paragraph that `first` opened. A code span runs across
 * the lines of one paragraph, never past a block boundary: judged on each
 * line's content inside its quote, so a quoted blank line or heading counts, a
 * deeper quote starts a block of its own, and an ordered item ends a paragraph
 * that is itself an ordered item whatever its number.
 */
function endsParagraph(raw: string, first: string): boolean {
  const here = unquote(raw);
  const opened = unquote(first);
  const content = here.content;
  return (
    content.trim() === "" ||
    here.depth > opened.depth ||
    /^\s*(```|~~~)/.test(content) ||
    BLOCK_BOUNDARY.test(content) ||
    EQUALS_UNDERLINE.test(content) ||
    LIST_OPENER.test(content) ||
    (ORDERED_ITEM.test(opened.content) && ORDERED_ITEM.test(content))
  );
}

/** The lines of the paragraph starting at `start`, code masked across them. */
function maskParagraph(lines: string[], start: number): string[] {
  const first = lines[start] ?? "";
  // A heading or thematic break is one line: no span opened on it runs on.
  let stop = start + 1;
  if (!BLOCK_BOUNDARY.test(unquote(first).content)) {
    while (stop < lines.length && !endsParagraph(lines[stop] ?? "", first))
      stop++;
  }
  return maskCode(lines.slice(start, stop).join("\n")).split("\n");
}

/**
 * Whether a line, its code already masked, carries a review scar. `opensParagraph`
 * is whether the line starts a paragraph rather than continuing one.
 */
function isScar(line: string, opensParagraph: boolean): boolean {
  const low = line.toLowerCase();
  if (/~~[^~]+~~/.test(line)) return true;
  const item = /^\s*([-*>]|\d+\.)\s+/.test(line);
  return (
    RESOLUTION.test(low) ||
    (item && ATTRIBUTION.test(low)) ||
    BOT_HANDLE.test(low) ||
    TABLE_ATTRIBUTION.test(low) ||
    (opensParagraph && PARAGRAPH_ATTRIBUTION.test(low))
  );
}

/** Each line of a document with its inline code masked, a paragraph at a time. */
function paragraphMasker(lines: string[]): (index: number) => string {
  let masked: string[] = [];
  let from = 0;
  return (index) => {
    if (index >= from + masked.length) {
      masked = maskParagraph(lines, index);
      from = index;
    }
    return masked[index - from] ?? lines[index] ?? "";
  };
}

/** Whether line `index` of a document is inside its frontmatter block. */
function frontmatterState(was: boolean, index: number, raw: string): boolean {
  if (index === 0) return raw.trim() === "---";
  return was && !/^(---|\.\.\.)\s*$/.test(raw);
}

export function scanScars(text: string): string[] {
  let fence = false;
  // Frontmatter keys such as `reviewer: alice` name fields, not traces; the
  // block is skipped whole.
  let frontmatter = false;
  let previousBlank = true;
  const hits: string[] = [];
  const lines = splitLines(text);
  const maskedLine = paragraphMasker(lines);
  for (const [index, raw] of lines.entries()) {
    const wasFrontmatter = frontmatter;
    frontmatter = frontmatterState(frontmatter, index, raw);
    if (frontmatter || (index === 0 && raw.trim() === "---")) continue;
    if (wasFrontmatter) {
      // The closing delimiter ends the block; the body starts a paragraph.
      previousBlank = true;
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      previousBlank = true;
      continue;
    }
    if (fence) continue;
    if (isScar(maskedLine(index), previousBlank))
      hits.push(`${index + 1}: ${raw}`);
    // A heading, setext underline or thematic break is a block of its own: the
    // line after it opens a paragraph.
    previousBlank =
      raw.trim() === "" ||
      BLOCK_BOUNDARY.test(raw) ||
      (!previousBlank && EQUALS_UNDERLINE.test(raw));
  }
  return hits;
}
/** "approved", or "approved or active": the statuses as a sentence names them. */
const statusList = (statuses: string[]) => statuses.join(" or ");

const skippedNote = (statuses: string[]) =>
  `were not scanned for scars (their status is not ${statusList(statuses)}); this is not evidence they are clean`;

const listed = (files: string[]) =>
  files.map((file) => `    ${file}`).join("\n");

interface Scan {
  /** Promoted docs that carry scars. */
  scarred: number;
  /** Named files left unscanned because they are not promoted. */
  skipped: string[];
}

/**
 * An allowlist entry matches as a fragment of the path, not the whole path:
 * `docs/review/` covers every document of that folder, which is how a
 * repository exempts the pages whose subject is the review process.
 */
function exempt(file: string, text: string, allowlist: string[]): boolean {
  return (
    frontmatterValue(text, "descar_allow", file) === "true" ||
    allowlist.some((pattern) => file.includes(pattern))
  );
}

function scanFiles(
  files: string[],
  isNamed: boolean,
  allowlist: string[],
  promoted: string[],
): Scan {
  const scan: Scan = { scarred: 0, skipped: [] };
  for (const file of files) {
    const text = readDocument(file);
    const status = frontmatterValue(text, "status", file);
    if (typeof status !== "string" || !promoted.includes(status)) {
      if (isNamed) scan.skipped.push(file);
      continue;
    }
    const hits = exempt(file, text, allowlist) ? [] : scanScars(text);
    if (!hits.length) continue;
    console.log(`SCAR ${file}\n${hits.map((hit) => `  ${hit}`).join("\n")}`);
    scan.scarred++;
  }
  return scan;
}

/** Print the verdict for a scan; the exit code follows the scars alone. */
function verdict(scan: Scan, scanned: number, promoted: string[]): number {
  const { scarred, skipped } = scan;
  const label = statusList(promoted);
  const why = skippedNote(promoted);
  const note = `NOTE — ${skipped.length} of the named file(s) ${why}. Skipped:\n${listed(skipped)}`;
  if (scarred) {
    console.log(
      `\n${scarred} ${label} doc(s) carry review scars — move them to the\nreview thread / issue / a ## Version history section, or set\ndescar_allow: true if the doc's subject is the review process.`,
    );
    if (skipped.length) console.log(`\n${note}`);
    return 1;
  }
  if (skipped.length && skipped.length === scanned) {
    console.log(
      `NOT SCANNED — ${skipped.length} named file(s) ${why}. Named:\n${listed(skipped)}`,
    );
    return 0;
  }
  console.log(`OK — no scars in ${label} docs`);
  if (skipped.length) console.log(note);
  return 0;
}

/**
 * Named files are reported even when they are not scanned: a file named on the
 * command line that is not promoted is listed as NOT SCANNED, so a caller can
 * tell "scanned, clean" from "never in scope". A full-tree run names nothing,
 * so it reports plain OK.
 */
export function checkDescarring(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const named = args.length > 0;
  const files = (named ? args : markdownFiles(env.DOCS_DIR || "docs")).filter(
    Boolean,
  );
  const allowlist = (env.ALLOWLIST || "").split(/\s+/).filter(Boolean);
  const promoted = env.PROMOTED_STATUSES?.split(/\s+/).filter(Boolean);
  const statuses = promoted?.length ? promoted : loadPromotedStatuses();
  return verdict(
    scanFiles(files, named, allowlist, statuses),
    files.length,
    statuses,
  );
}
if (import.meta.main) cli(() => checkDescarring());
