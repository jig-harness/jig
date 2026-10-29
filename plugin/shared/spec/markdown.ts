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
 * blank line opens indented code unless a list item is open, where it is
 * the item's nested content.
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
 * A line in a section: `text` is content, `code` is inside a fence or an
 * indented code block, `fence` opens or closes a fence. Tabs are four
 * spaces.
 */
export interface MarkdownLine {
  line: string;
  kind: "text" | "code" | "fence";
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
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

type Fence = { char: string; length: number };

/** Whether `line` closes `fence`: a bare run of its character, at least as long. */
function closes(line: string, fence: Fence): boolean {
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
  afterBlank: boolean;
}

/** The kind of a line indented less than four columns, outside code. */
function shallowLine(line: string, state: ScanState): MarkdownLine["kind"] {
  state.indentedCode = false;
  const run = fenceRun(line);
  if (run !== null) {
    state.fence = run;
    return "fence";
  }
  if (LIST_ITEM.test(line)) state.listOpen = true;
  else if (state.afterBlank || /^ {0,3}#/.test(line)) state.listOpen = false;
  return "text";
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
  let kind: MarkdownLine["kind"];
  if (indentOf(line) >= 4) {
    state.indentedCode ||= state.afterBlank && !state.listOpen;
    kind = state.indentedCode ? "code" : "text";
  } else kind = shallowLine(line, state);
  state.afterBlank = false;
  return kind;
}

/** Each line of `text`, classified; see the header. */
export function* markdownLines(text: string): Generator<MarkdownLine> {
  const state: ScanState = {
    fence: null,
    indentedCode: false,
    listOpen: false,
    afterBlank: true,
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    yield { line, kind: classify(line, state) };
  }
}
