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
/** An ATX heading, a setext underline, or a thematic break. */
const BLOCK_BOUNDARY =
  /^\s{0,3}(?:#{1,6}(?:\s|$)|=+\s*$|-+\s*$|([-*_])(?:\s*\1){2,}\s*$)/;
/** Stands in for inline code: not whitespace, so masking opens no prefix. */
const CODE_MASK = "\u0001";

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
  for (const [index, raw] of splitLines(text).entries()) {
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
    if (isScar(raw.replace(/(`+)(?:(?!\1).)+?\1/g, CODE_MASK), previousBlank))
      hits.push(`${index + 1}: ${raw}`);
    // A heading, setext underline or thematic break is a block of its own: the
    // line after it opens a paragraph.
    previousBlank = raw.trim() === "" || BLOCK_BOUNDARY.test(raw);
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
