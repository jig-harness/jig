// The Markdown block reader the deferral-references gate judges within: a
// document's blocks of prose (paragraphs, list items, table rows, headings),
// without frontmatter, fenced code or HTML comments, each with the
// `deferral-ok` waivers that start inside it.
import { readFrontmatter, splitLines } from "../lib/docs.ts";

/** A block of prose a deferral is judged within. Lines are 1-based, inclusive. */
export interface Unit {
  start: number;
  end: number;
  /** The block's lines with HTML comments blanked out. */
  text: string;
  /** The text of each `deferral-ok` comment that starts inside the block. */
  waivers: string[];
}

// Any indent: a fence inside a nested list item is indented four or more.
const FENCE = /^\s*(`{3,}|~{3,})/;
// A closing fence is the fence run alone: `​```still-code` is content.
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|/;
// A table's delimiter row: dash cells split by pipes, outer pipes optional.
const TABLE_DELIMITER = /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;
const QUOTE = /^(\s{0,3}>\s?)+/;
const WAIVER = /^<!--\s*deferral-ok(?=\s*(?::|-->))\s*:?([\s\S]*?)-->$/i;

// Where a comment started stands one visible character, so a line holding
// only a comment still continues the block around it.
const COMMENT_START = "\u0000";

type LineKind = "blank" | "heading" | "table" | "rule" | "item" | "text";

function kindOf(line: string): LineKind {
  if (line.trim() === "") return "blank";
  if (HEADING.test(line)) return "heading";
  if (TABLE_ROW.test(line)) return "table";
  if (RULE.test(line)) return "rule";
  return LIST_ITEM.test(line) ? "item" : "text";
}

/** A block still taking lines: its bullet's indent and where its content starts. */
interface Open {
  unit: Unit;
  indent: number;
  content: number;
}

interface Builder {
  out: Unit[];
  /** The paragraph or list item the next line continues. */
  open?: Open | undefined;
  /** The list items enclosing the current line, outermost first. */
  items: Open[];
  /** The previous line was blank. */
  gap: boolean;
}

const startUnit = (b: Builder, at: number, text: string): Unit => {
  const unit = { start: at, end: at, text, waivers: [] };
  b.out.push(unit);
  return unit;
};

const extendUnit = (unit: Unit, at: number, text: string) => {
  unit.end = at;
  unit.text += `\n${text}`;
};

const closeBlocks = (b: Builder) => {
  b.open = undefined;
  b.items = [];
};

/** The list item an indented paragraph after a blank line belongs to, if any. */
function enclosingItem(b: Builder, indent: number): number {
  for (let i = b.items.length - 1; i >= 0; i--)
    if (indent >= (b.items[i] as Open).content) return i;
  // Indented less than the content but more than the bullet still joins it.
  for (let i = b.items.length - 1; i >= 0; i--)
    if (indent > (b.items[i] as Open).indent) return i;
  return -1;
}

/** Add one line of prose to the block it belongs to. */
function place(b: Builder, kind: LineKind, line: string, at: number): void {
  const wasGap = b.gap;
  b.gap = kind === "blank";
  if (kind === "blank") {
    b.open = undefined;
    return;
  }
  if (kind !== "text" && kind !== "item") {
    closeBlocks(b);
    if (kind !== "rule") startUnit(b, at, line);
    return;
  }
  const indent = line.length - line.trimStart().length;
  if (kind === "item") {
    const marker = LIST_ITEM.exec(line) as RegExpExecArray;
    while ((b.items.at(-1)?.indent ?? -1) >= indent) b.items.pop();
    b.open = {
      unit: startUnit(b, at, line),
      indent,
      content: marker[0].length,
    };
    b.items.push(b.open);
    return;
  }
  const owner = wasGap ? enclosingItem(b, indent) : -1;
  if (owner >= 0) {
    b.items.length = owner + 1;
    b.open = b.items[owner] as Open;
    extendUnit(b.open.unit, at, line);
  } else if (b.open !== undefined && !wasGap) {
    extendUnit(b.open.unit, at, line);
  } else {
    b.items = [];
    b.open = { unit: startUnit(b, at, line), indent, content: indent };
  }
}

/** An HTML comment being read, which may span lines. */
interface Comment {
  line: number;
  /** The line the comment ends on. */
  end: number;
  text: string;
}

/**
 * Blank out the HTML comments on one line, keeping its length so indents hold.
 * A comment left open continues into the next line; finished comments are
 * passed to `done` with the line they started on.
 */
function maskComments(
  line: string,
  at: number,
  state: { open?: Comment | undefined },
  done: (comment: Comment) => void,
): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.open !== undefined) {
      const close = line.indexOf("-->", i);
      const end = close < 0 ? line.length : close + 3;
      state.open.text += line.slice(i, end);
      out += " ".repeat(end - i);
      i = end;
      if (close < 0) {
        state.open.text += "\n";
        break;
      }
      state.open.end = at;
      done(state.open);
      state.open = undefined;
      continue;
    }
    const start = line.indexOf("<!--", i);
    if (start < 0) {
      out += line.slice(i);
      break;
    }
    out += `${line.slice(i, start)}${COMMENT_START}   `;
    state.open = { line: at, end: at, text: "<!--" };
    i = start + 4;
  }
  return out;
}

/** Whether `line` closes a fence opened with `fence`. */
function closesFence(line: string, fence: string): boolean {
  const closing = CLOSING_FENCE.exec(line)?.[1];
  return (
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length
  );
}

const quoteDepth = (line: string) =>
  (QUOTE.exec(line)?.[0].match(/>/g) ?? []).length;

/** Where the reader stands between lines. */
interface Reader {
  builder: Builder;
  comments: Comment[];
  comment: { open?: Comment | undefined };
  /** The open fence's run, while inside fenced code. */
  fence?: string | undefined;
  /** How many block quotes the current line sits in. */
  depth: number;
  /** Inside a table, whose rows continue to the next blank line. */
  table: boolean;
}

/** Whether `line` heads a table: it holds a pipe and the next line is a delimiter row. */
const startsTable = (kind: LineKind, line: string, next: string | undefined) =>
  (kind === "text" || kind === "table") &&
  line.includes("|") &&
  TABLE_DELIMITER.test((next ?? "").replace(QUOTE, ""));

/** The kind a line is read as, a table's rows included. */
function lineKind(r: Reader, line: string, next: string | undefined): LineKind {
  const kind = kindOf(line);
  if (kind === "blank") {
    r.table = false;
    return kind;
  }
  r.table ||= startsTable(kind, line, next);
  return r.table ? "table" : kind;
}

function readLine(r: Reader, lines: string[], i: number): void {
  const raw = lines[i] ?? "";
  const unquoted = raw.replace(QUOTE, "");
  if (r.fence !== undefined) {
    if (closesFence(unquoted, r.fence)) r.fence = undefined;
    return;
  }
  const line = maskComments(unquoted, i + 1, r.comment, (c) =>
    r.comments.push(c),
  );
  const depth = quoteDepth(raw);
  r.fence = FENCE.exec(line)?.[1];
  if (depth !== r.depth || r.fence !== undefined) {
    closeBlocks(r.builder);
    r.table = false;
    r.depth = depth;
  }
  if (r.fence === undefined)
    place(r.builder, lineKind(r, line, lines[i + 1]), line, i + 1);
}

/**
 * Give each waiver comment to the block it starts in. The block then reaches
 * the waiver's last line, so a change to any line of its reason judges it.
 */
function attachWaivers(blocks: Unit[], comments: Comment[]): void {
  for (const comment of comments) {
    const waiver = WAIVER.exec(comment.text.trim());
    const unit = blocks.find(
      (u) => u.start <= comment.line && comment.line <= u.end,
    );
    if (waiver === null || unit === undefined) continue;
    unit.waivers.push(waiver[1] ?? "");
    unit.end = Math.max(unit.end, comment.end);
  }
}

/**
 * The document's blocks: each paragraph, list item (with its continuation
 * lines and, in a loose list, its indented following paragraphs, nested items
 * apart), table row and heading. Frontmatter, fenced code and HTML comments
 * are not prose and are left out; a comment may span lines and blocks. Entering
 * or leaving a block quote ends a block.
 */
export function units(content: string): Unit[] {
  const lines = splitLines(content);
  const frontmatter = readFrontmatter(content);
  const r: Reader = {
    builder: { out: [], items: [], gap: false },
    comments: [],
    comment: {},
    depth: 0,
    table: false,
  };
  const first = frontmatter.present ? frontmatter.end + 1 : 0;
  for (let i = first; i < lines.length; i++) readLine(r, lines, i);
  if (r.comment.open !== undefined)
    r.comments.push({ ...r.comment.open, end: lines.length });
  const blocks = r.builder.out;
  for (const unit of blocks)
    unit.text = unit.text.replaceAll(COMMENT_START, " ");
  attachWaivers(blocks, r.comments);
  return blocks;
}
