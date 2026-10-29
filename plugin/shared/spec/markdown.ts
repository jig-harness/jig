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
 * column, so `- ```md` opens a fence and `- - x` opens a nested item. A line
 * at or past that column belongs to the item and does not close the list; a
 * heading, or a line before that column after a blank line, does.
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
 * closes a fence. Tabs are four spaces.
 */
export interface MarkdownLine {
  line: string;
  kind: "text" | "heading" | "code" | "fence";
}

/** A heading: its run of `#` and its title. */
export const HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( *)(?=\S|$)/;

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
  listOpen: boolean;
  /** The content column of the innermost list item open. */
  listIndent: number;
  afterBlank: boolean;
}

/**
 * The kind of a line less than four columns past its container's content
 * column (`strip`, 0 outside a list), outside code.
 */
function shallowLine(
  line: string,
  strip: number,
  state: ScanState,
): MarkdownLine["kind"] {
  state.indentedCode = false;
  const own = line.slice(strip);
  const run = fenceRun(own);
  if (run !== null) {
    state.fence = { ...run, strip };
    return "fence";
  }
  const item = listContent(own);
  if (item !== null) {
    state.listOpen = true;
    state.listIndent = strip + item;
    if (line.length <= state.listIndent) return "text";
    const content = shallowLine(line, state.listIndent, state);
    return content === "heading" ? "text" : content;
  }
  if (/^ {0,3}#/.test(line) || (state.afterBlank && strip === 0))
    state.listOpen = false;
  return HEADING.test(own) ? "heading" : "text";
}

/** The kind of one line, the state moved on past it. */
function classify(line: string, state: ScanState): MarkdownLine["kind"] {
  if (state.fence !== null) {
    if (!closes(line, state.fence)) return "code";
    state.fence = null;
    return "fence";
  }
  if (line.trim() === "") {
    state.afterBlank = true;
    return "text";
  }
  const indent = indentOf(line);
  const strip =
    state.listOpen && indent >= state.listIndent ? state.listIndent : 0;
  let kind: MarkdownLine["kind"];
  if (indent - strip >= 4) {
    state.indentedCode ||= state.afterBlank;
    kind = state.indentedCode ? "code" : "text";
  } else kind = shallowLine(line, strip, state);
  state.afterBlank = false;
  return kind;
}

/** Each line of `text`, classified; see the header. */
export function* markdownLines(text: string): Generator<MarkdownLine> {
  const state: ScanState = {
    fence: null,
    indentedCode: false,
    listOpen: false,
    listIndent: 0,
    afterBlank: true,
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    yield { line, kind: classify(line, state) };
  }
}
