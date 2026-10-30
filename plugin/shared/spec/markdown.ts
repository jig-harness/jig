/**
 * The Markdown an issue body is written in, read line by line as far as the
 * spec resolver needs it: which lines are code, which are headings, and the
 * headings of the sections it reads.
 *
 * Code is never read as content: an example of a spec section or a path
 * inside a fence or an indented code block is an example, not the spec. A
 * fence closes only on a run of its own character at least as long as the
 * one that opened it, so a three-backtick line inside a four-backtick
 * example stays inside it. A line indented four columns or more after a
 * blank line opens indented code. Inside an open list item both are read
 * relative to the item's content column (where its text starts after the
 * marker): a fence indented under `- ` is the item's fence, and only a line
 * four columns past that column, after a blank line, is its indented code.
 * The text after a list marker is read the same way, at the item's content
 * column, so `- ```md` opens a fence, `- - x` opens a nested item and
 * `-     x` is the item's indented code. A line at or past that column
 * belongs to the item and does not close the list. A heading, a fence, a
 * list marker, a block quote, a thematic break (`---`), or any line after a
 * blank line closes the items whose column it does not reach, leaving the
 * enclosing items it does reach open: a heading at the margin closes every
 * item, one indented to an item's column is that item's, and marked so
 * (`inItem`). Only a paragraph's text continues an item from before its
 * column. A thematic break, and a block quote outside the innermost open
 * item, is marked `boundary`: it ends the entry above it and is no part of
 * one, and so is a line that lazily continues that quote's paragraph: a line
 * with no `>` right after quoted paragraph text (not a quoted heading,
 * thematic break or code), which starts no block that could end a paragraph
 * (an ordered item starting past 1 cannot, nor indented code). Which list a line belongs to is decided
 * here, once: a line that opens a list item is marked with the number of
 * open items around it (`depth`), so a reader nests items by that and not by
 * indentation, and an item after a block that ended the list above it starts
 * a list of its own. A fence opened inside an item ends with it: a line before the
 * item's column closes the fence and those items, and is read as ordinary
 * Markdown in the item that remains. Past a nesting depth of 64 markers on
 * one line the rest is the item's text, so a line of markers cannot run the
 * scan deep.
 */
import type { BodySectionKind } from "./adapter.ts";

/** The headings the resolver reads beside the configured spec heading. */
export const INLINE_HEADINGS: Record<
  Exclude<BodySectionKind, "spec">,
  string
> = {
  requirements: "Requirements",
  acceptance: "Acceptance criteria",
};

/** A heading's text as the resolver compares it: no emphasis, no trailing colon, any case. */
export function headingKey(text: string): string {
  let key = text.replace(/[*_`]/g, "").trim();
  if (key.endsWith(":")) key = key.slice(0, -1).trimEnd();
  return key.toLowerCase();
}

/** `text` with every trailing character in `chars` removed. */
export function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/**
 * A line in a section: `text` is content, `heading` a heading outside code,
 * `code` is inside a fence or an indented code block, `fence` opens or
 * closes a fence. Tabs are four spaces. `inItem` marks a heading inside an
 * open list item: it belongs to the item, so it opens or closes no section.
 * `boundary` marks a `text` line that ends the entry above it and continues
 * none: a thematic break, or a block quote the open item does not contain,
 * and the lines that lazily continue it. `depth` marks a line that opens a
 * list item: the number of open items it is nested in, 0 for a new list.
 * `quoted` marks a line of a block quote, a lazy continuation included: its
 * text is the quote's, never an entry of its own.
 */
export interface MarkdownLine {
  line: string;
  kind: "text" | "heading" | "code" | "fence";
  inItem?: true;
  boundary?: true;
  depth?: number;
  quoted?: true;
}

/** A heading: its run of `#` and its title. */
export const HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( *)(?=\S|$)/;
/** A block quote or a thematic break: blocks that end a list item they are not inside. */
const INTERRUPTS = /^ {0,3}(?:>|([-*_])(?: *\1){2,} *$)/;
/** List markers past this many on one line are read as the item's text. */
const MAX_LIST_DEPTH = 64;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** `line` with up to `columns` leading spaces removed. */
function dedent(line: string, columns: number): string {
  return line.slice(Math.min(columns, indentOf(line)));
}

/** The content column of the list item `line` opens, or `null`. */
function listContent(line: string): number | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const marker = (match[1] ?? "").length + (match[2] ?? "").length;
  const spaces = (match[3] ?? "").length;
  if (spaces === 0 && match[0].length < line.length) return null;
  return marker + (spaces === 0 || spaces > 4 ? 1 : spaces);
}

/** The fence `line` closes or opens: its character and length. */
function fenceRun(line: string): { char: string; length: number } | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const run = match[1] ?? "";
  const char = run.charAt(0);
  if (char === "`" && (match[2] ?? "").includes("`")) return null;
  return { char, length: run.length };
}

/** An open fence; `strip` is the list content column it was opened at. */
type Fence = { char: string; length: number; strip: number };

/** Whether `line` closes `fence`: a bare run of its character, at least as long. */
function closes(raw: string, fence: Fence): boolean {
  const line = dedent(raw, fence.strip);
  const run = fenceRun(line);
  return (
    run !== null &&
    run.char === fence.char &&
    run.length >= fence.length &&
    line.trim() === fence.char.repeat(run.length)
  );
}

/** What the scanner knows between lines. */
interface ScanState {
  fence: Fence | null;
  indentedCode: boolean;
  /** The content columns of the open list items, outermost first, ascending. */
  lists: number[];
  afterBlank: boolean;
  /** Whether the last heading read sits inside an open list item. */
  headingInItem: boolean;
  /** Whether the line just read is a boundary (see `MarkdownLine`). */
  boundary: boolean;
  /** The line just read opens a list item nested in this many (see `MarkdownLine`). */
  depth: number | null;
  /** The block quote the line just read is in, or `null`. */
  quote: Quote | null;
}

/**
 * An open block quote: whether its lines are boundaries, the fence open
 * inside it, and whether its text ends in an open paragraph, the one block a
 * line without `>` can lazily continue.
 */
interface Quote {
  boundary: boolean;
  fence: Fence | null;
  paragraph: boolean;
}

/** The `>` markers that open a block quote line, nested ones included. */
const QUOTE_MARKERS = /^(?: {0,3}> ?)+/;
/** A setext heading's underline of `=`, which ends a paragraph. */
const SETEXT_EQUALS = /^ {0,3}=+ *$/;

/**
 * Whether `own` (a line at its container's content column) starts a block
 * that ends an open paragraph rather than continuing it. Indented code
 * cannot, and a list item can only with text, and an ordered one only when
 * it starts at 1.
 */
function interruptsParagraph(own: string): boolean {
  if (HEADING.test(own) || fenceRun(own) !== null || INTERRUPTS.test(own))
    return true;
  const match = LIST_ITEM.exec(own);
  if (match === null || listContent(own) === null) return false;
  if (own.slice(match[0].length).trim() === "") return false;
  const marker = match[2] ?? "";
  return !/\d/.test(marker) || Number.parseInt(marker, 10) === 1;
}

/** The fence and paragraph a quote's content line leaves open, after `prev`. */
function quoteContent(
  content: string,
  prev: Quote | null,
): Pick<Quote, "fence" | "paragraph"> {
  const fence = prev?.fence ?? null;
  if (fence !== null)
    return { fence: closes(content, fence) ? null : fence, paragraph: false };
  if (content.trim() === "") return { fence: null, paragraph: false };
  if (
    prev?.paragraph === true &&
    !interruptsParagraph(content) &&
    !SETEXT_EQUALS.test(content)
  )
    return { fence: null, paragraph: true };
  return quoteBlock(content);
}

/**
 * What a block a quote's content line starts leaves open: a paragraph,
 * unless it is code, a fence, a heading, a thematic break or an empty list
 * item. Markers are followed to their text as `itemLine` follows them.
 */
function quoteBlock(content: string): Pick<Quote, "fence" | "paragraph"> {
  const none = { fence: null, paragraph: false };
  for (let depth = 0; ; depth++) {
    if (content.trim() === "" || indentOf(content) >= 4) return none;
    const run = fenceRun(content);
    if (run !== null) return { fence: { ...run, strip: 0 }, paragraph: false };
    if (HEADING.test(content) || INTERRUPTS.test(content)) return none;
    const item = depth < MAX_LIST_DEPTH ? listContent(content) : null;
    if (item === null) return { fence: null, paragraph: true };
    content = content.slice(item);
  }
}

/** The content column of the innermost open item `indent` reaches, or 0. */
function container(state: ScanState, indent: number): number {
  const { lists } = state;
  let low = 0;
  let high = lists.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((lists[mid] ?? 0) <= indent) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? 0 : (lists[low - 1] ?? 0);
}

/** End every open item whose content column is past `indent`. */
function closeItemsPast(state: ScanState, indent: number): void {
  const { lists } = state;
  while (lists.length > 0 && (lists[lists.length - 1] ?? 0) > indent)
    lists.pop();
}

/**
 * The kind of a line less than four columns past its container's content
 * column (`strip`, 0 outside a list), outside code.
 */
function shallowLine(
  line: string,
  strip: number,
  state: ScanState,
  quote: Quote | null,
): MarkdownLine["kind"] {
  state.indentedCode = false;
  const own = line.slice(strip);
  const opened = opensFence(own, strip, state);
  if (opened !== null) {
    closeItemsPast(state, strip);
    return opened;
  }
  const interrupt = INTERRUPTS.exec(own);
  if (interrupt) {
    const inItem = strip > 0 && state.lists.at(-1) === strip;
    state.boundary = interrupt[1] !== undefined || !inItem;
    if (interrupt[1] === undefined)
      state.quote = {
        boundary: state.boundary,
        ...quoteContent(own.replace(QUOTE_MARKERS, ""), quote),
      };
    closeItemsPast(state, strip);
    return "text";
  }
  const item = listContent(own);
  if (item !== null) {
    closeItemsPast(state, strip);
    state.depth = state.lists.length;
    return itemLine(line, strip + item, state);
  }
  if (!HEADING.test(own)) return "text";
  closeItemsPast(state, strip);
  state.headingInItem = strip > 0;
  return "heading";
}

/** `"fence"` with the fence `own` opens at `column` recorded, or `null`. */
function opensFence(
  own: string,
  column: number,
  state: ScanState,
): "fence" | null {
  const run = fenceRun(own);
  if (run === null) return null;
  state.fence = { ...run, strip: column };
  return "fence";
}

/**
 * The kind of a line that opens a list item whose content starts at
 * `column`. Each further marker on the line moves the column past it, up to
 * `MAX_LIST_DEPTH`; the text after the last is read at that column, as a
 * line of the item.
 */
function itemLine(
  line: string,
  column: number,
  state: ScanState,
): MarkdownLine["kind"] {
  for (let depth = 1; ; depth++) {
    state.lists.push(column);
    if (line.length <= column) return "text";
    const own = line.slice(column);
    if (indentOf(own) >= 4) {
      state.indentedCode = true;
      return "code";
    }
    const opened = opensFence(own, column, state);
    if (opened !== null) return opened;
    const item = depth < MAX_LIST_DEPTH ? listContent(own) : null;
    if (item === null) return "text";
    column += item;
  }
}

/**
 * The kind of `line` inside the open `fence`, or `null` when the line ends
 * the list item the fence opened in, and the fence with it, and is to be
 * read as ordinary Markdown.
 */
function fencedLine(
  line: string,
  fence: Fence,
  state: ScanState,
): MarkdownLine["kind"] | null {
  if (fence.strip > 0 && line.trim() !== "" && indentOf(line) < fence.strip) {
    state.fence = null;
    closeItemsPast(state, indentOf(line));
    return null;
  }
  if (!closes(line, fence)) return "code";
  state.fence = null;
  return "fence";
}

/** The kind of one line, the state moved on past it. */
function classify(line: string, state: ScanState): MarkdownLine["kind"] {
  if (state.fence !== null) {
    const fenced = fencedLine(line, state.fence, state);
    if (fenced !== null) return fenced;
  }
  const quote = state.quote;
  state.quote = null;
  if (line.trim() === "") {
    state.afterBlank = true;
    return "text";
  }
  const indent = indentOf(line);
  if (state.afterBlank) closeItemsPast(state, indent);
  const strip = container(state, indent);
  if (quote?.paragraph === true && lazy(line.slice(strip))) {
    state.quote = quote;
    state.boundary = quote.boundary;
    state.afterBlank = false;
    return "text";
  }
  let kind: MarkdownLine["kind"];
  if (indent - strip >= 4) {
    state.indentedCode ||= state.afterBlank;
    kind = state.indentedCode ? "code" : "text";
  } else kind = shallowLine(line, strip, state, quote);
  state.afterBlank = false;
  return kind;
}

/**
 * Whether `own`, after a quote's open paragraph, continues it lazily: it
 * starts no block that could end the paragraph, and no `>` of its own.
 */
function lazy(own: string): boolean {
  return indentOf(own) >= 4 || !interruptsParagraph(own);
}

/** Each line of `text`, classified; see the header. */
export function* markdownLines(text: string): Generator<MarkdownLine> {
  const state: ScanState = {
    fence: null,
    indentedCode: false,
    lists: [],
    afterBlank: true,
    headingInItem: false,
    boundary: false,
    depth: null,
    quote: null,
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    state.boundary = false;
    state.depth = null;
    const kind = classify(line, state);
    const out: MarkdownLine = { line, kind };
    if (kind === "heading" && state.headingInItem) out.inItem = true;
    if (state.boundary) out.boundary = true;
    if (state.depth !== null) out.depth = state.depth;
    if (state.quote !== null) out.quoted = true;
    yield out;
  }
}
