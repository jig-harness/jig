/**
 * The steps a pull request still owes outside its code, read from the
 * `## Out-of-tree follow-ups` section of its description, which `do-item`
 * and `work-batch` write on every pull request they open: a list of the
 * steps a person takes after (or before) the merge, or an explicit "None".
 *
 * Within the section, each list item is a step. A checked box (`- [x]`) is
 * a step done; an unchecked box or a plain item is a step still owed. An
 * item that says "None" is no step, nor is a box with no text (a template's
 * placeholder). A plain item nested under another is the step's detail, not
 * a step; a box at any depth is one. The section ends at the next heading
 * of its level or above. Fenced code and HTML comments are never read, so a
 * description that quotes the heading in a code block owes nothing by it.
 *
 * The repository's manual-operations label (`issue_tracker.labels.manual_ops`)
 * names a pull request that owes such a step; its name is read here too.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { parseTrackerLabels } from "../../shared/tracker-labels.ts";
import { MAX_LABEL } from "./labels.ts";
import { failureText } from "./text.ts";

/** The section's heading text, compared without case. */
const HEADING = "out-of-tree follow-ups";

/** The steps one description's section lists: those still owed and those done. */
export interface OwedSteps {
  open: number;
  done: number;
}

const FENCE = /^( *)(`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const BOX = /^\[([ xX])\]\s*(.*)$/;

const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Whether an item's text says there is nothing to do: "None" or "N/A", however emphasised, alone or with a colon or parenthesis after it; a sentence that begins with the word is a step. */
function saysNone(text: string): boolean {
  return /^(?:none|n\/a)(?:[_*~]*(?:\s*[:(–—]|\s+-\s).*)?$/i.test(
    text.replace(/^[\s_*~]+/, "").replace(/[\s_*~.!]+$/, ""),
  );
}

/** A line's indent, a tab counted as four spaces. */
const indentOf = (line: string): number =>
  /^\s*/.exec(line.replace(/\t/g, "    "))?.[0].length ?? 0;

/** The fence marker a line opens or closes, at most three spaces in from `base`, the column of the list item that holds it (0 outside a list); `undefined` for another line. */
function fenceOf(line: string, base: number): string | undefined {
  const found = FENCE.exec(line.replace(/\t/g, "    "));
  return found !== null && (found[1]?.length ?? 0) <= base + 3
    ? found[2]
    : undefined;
}

/** Whether `line` closes the open fence `fence`: its own marker, as long, and nothing after it. */
function closesFence(line: string, fence: string, base: number): boolean {
  const marker = fenceOf(line, base);
  return (
    marker !== undefined &&
    marker[0] === fence[0] &&
    marker.length >= fence.length &&
    line.slice(line.indexOf(marker) + marker.length).trim() === ""
  );
}

/** The column where the text of the list item on `line` begins; 0 for a line that is no item. */
function contentColumn(line: string): number {
  const item = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line.replace(/\t/g, "    "));
  return item?.[0].length ?? 0;
}

/** The column of the list item holding the line after `line`, given `base` before it: an item sets its own, an unindented paragraph ends the list, any other line keeps it. */
function listColumn(line: string, base: number): number {
  if (line.trim() === "") return base;
  const column = contentColumn(line);
  if (column > 0) return column;
  return /^\s/.test(line) ? base : 0;
}

/** The end of the first run of exactly `n` backticks in `s` at or after `from`; -1 when there is none. */
function findRun(s: string, from: number, n: number): number {
  for (const m of s.matchAll(/`+/g))
    if (m.index >= from && m[0].length === n) return m.index + n;
  return -1;
}

/** What the reading of one line carries to the next: an HTML comment open, or a code span open (its backtick count) that a later line of the paragraph closes. */
interface Context {
  comment: boolean;
  span: number | null;
}

/** Whether a run of exactly `n` backticks closes a code span on a later line of the paragraph. */
type Lookahead = (n: number) => boolean;

/** Where the backtick run of `n` at `at` leaves the reading: past its closing run on `line`, to the line's end with the span open (`open` is its backtick count) when a later line of the paragraph closes it, or past the run alone when nothing does. */
function codeSpanAt(
  line: string,
  at: number,
  n: number,
  ahead: Lookahead,
): { end: number; open: number | null } {
  const end = findRun(line, at + n, n);
  if (end !== -1) return { end, open: null };
  if (ahead(n)) return { end: line.length, open: n };
  return { end: at + n, open: null };
}

/** Where the reading of `line` goes on from `at` inside an open comment or code span, closing it when `line` does; `line.length` and the context unchanged when it runs on, and the kept text of the span. */
function inside(
  line: string,
  at: number,
  ctx: Context,
): { to: number; kept: string } {
  if (ctx.comment) {
    const close = line.indexOf("-->", at);
    if (close === -1) return { to: line.length, kept: "" };
    ctx.comment = false;
    return { to: close + 3, kept: "" };
  }
  const end = findRun(line, at, ctx.span ?? 0);
  if (end === -1) return { to: line.length, kept: line.slice(at) };
  ctx.span = null;
  return { to: end, kept: line.slice(at, end) };
}

/** What is left of `line` outside HTML comments; `ahead` looks through the later lines of its paragraph, where an open code span may close. */
function uncommented(line: string, ctx: Context, ahead: Lookahead): string {
  let text = "";
  let i = 0;
  while (i < line.length) {
    if (ctx.comment || ctx.span !== null) {
      const read = inside(line, i, ctx);
      text += read.kept;
      i = read.to;
      continue;
    }
    const re = /`+|<!--/g;
    re.lastIndex = i;
    const m = re.exec(line);
    if (m === null) return text + line.slice(i);
    text += line.slice(i, m.index);
    if (m[0] === "<!--") {
      ctx.comment = true;
      i = m.index + 4;
      continue;
    }
    const run = codeSpanAt(line, m.index, m[0].length, ahead);
    text += line.slice(m.index, run.end);
    i = run.end;
    ctx.span = run.open;
  }
  return text;
}

/** The fence a line opens and the column of the list item holding it: the item's own when the fence follows its marker, else `base`; `undefined` for another line. */
function fenceOpener(
  line: string,
  base: number,
): { marker: string; base: number } | undefined {
  const column = contentColumn(line);
  // A fence indented less than the item's text is outside the item, however recent the item.
  const held = indentOf(line) >= base ? base : 0;
  const marker =
    column > 0
      ? fenceOf(line.replace(/\t/g, "    ").slice(column), 0)
      : fenceOf(line, held);
  return marker === undefined
    ? undefined
    : { marker, base: column > 0 ? column : held };
}

/** Whether an open fence ends at `line`: its closing marker, or, in a list item, a line less indented than the item's text. */
function fenceEnds(
  line: string,
  fence: string,
  base: number,
  fenceBase: number,
): "closed" | "dedented" | "open" {
  if (closesFence(line, fence, base)) return "closed";
  return line.trim() !== "" && indentOf(line) < fenceBase ? "dedented" : "open";
}

/** Whether an item can interrupt a paragraph. An ordered list can do so only when it starts at 1. */
function interruptsParagraph(line: string): boolean {
  const item = ITEM.exec(line);
  if (item === null) return false;
  const marker = line.slice((item[1] ?? "").length).match(/^(?:[-*+]|\d+[.)])/);
  return (
    marker !== null && (!/^\d/.test(marker[0]) || /^1[.)]$/.test(marker[0]))
  );
}

/** Whether a line cannot continue the paragraph above it: it is blank, an interrupting list item, a heading or a fence of its own. */
function interrupts(line: string): boolean {
  return (
    line.trim() === "" ||
    interruptsParagraph(line) ||
    HEADING_LINE.test(line) ||
    BREAK.test(line) ||
    fenceOf(line, 0) !== undefined
  );
}

/** Whether `line` starts a top-level checkbox item, including an ordered sibling that cannot itself interrupt a paragraph. */
const startsBoxItem = (line: string): boolean => {
  const item = ITEM.exec(line);
  return item !== null && (item[1] ?? "") === "" && BOX.test(item[2] ?? "");
};

/** A look through the paragraph after line `at`, stopping where a blank line, an item, a heading or a fence begins another block; nothing is copied, and no line is read unless asked. */
function paragraphAfter(input: readonly string[], at: number): Lookahead {
  return (n) => {
    for (let j = at + 1; j < input.length; j++) {
      const line = input[j] ?? "";
      // A checkbox begins a new step even where its ordered marker cannot
      // interrupt an ordinary paragraph on its own.
      if (interrupts(line) || startsBoxItem(line)) return false;
      if (findRun(line, 0, n) !== -1) return true;
    }
    return false;
  };
}

/**
 * The description's lines outside fenced code and HTML comments, read in one
 * pass so that each hides the other's delimiters: a comment opener inside a
 * fence or a code span is code, and a fence inside a comment is comment. A
 * fence may be indented into the list item that holds it, or open on the
 * item's own line; a fence in an item ends with the item, at the first line
 * indented less than the item's text. A code span may run over the lines of
 * its paragraph. A comment that never closes runs to the end; a fence closes
 * only on a line of its own marker.
 */
function readLines(body: string): string[] {
  const lines: string[] = [];
  const input = body.split(/\r?\n/);
  const ctx: Context = { comment: false, span: null };
  const fence: Fence = { marker: null, base: 0, itemBase: 0 };
  for (const [i, line] of input.entries()) {
    if (skippedByFence(line, fence, ctx)) continue;
    if (interrupts(line) || startsBoxItem(line)) ctx.span = null;
    if (!ctx.comment) fence.base = listColumn(line, fence.base);
    lines.push(uncommented(line, ctx, paragraphAfter(input, i)));
  }
  return lines;
}

/** The fence being read: its marker (`null` outside one), the column of the list item holding the line, and the column of the item holding the fence, which a less indented line ends the fence with. */
interface Fence {
  marker: string | null;
  base: number;
  itemBase: number;
}

/** Whether `line` is fenced code or a fence's own line, updating `fence` as the line opens or closes one; a line that ends the fence by dedent is read as any other. */
function skippedByFence(line: string, fence: Fence, ctx: Context): boolean {
  if (fence.marker !== null) {
    const ends = fenceEnds(line, fence.marker, fence.base, fence.itemBase);
    if (ends !== "open") fence.marker = null;
    if (ends !== "dedented") return true;
  }
  const opener = ctx.comment ? undefined : fenceOpener(line, fence.base);
  if (opener === undefined) return false;
  fence.marker = opener.marker;
  fence.base = fence.itemBase = opener.base;
  return true;
}

/** A heading's level and text, without case; `null` for a line that is no heading. */
function headingOf(line: string): { level: number; text: string } | null {
  const heading = HEADING_LINE.exec(line);
  if (heading === null) return null;
  return {
    level: heading[1]?.length ?? 0,
    text: (heading[2] ?? "").trim().toLowerCase(),
  };
}

/** A setext heading's level and text, the line before its underline; `null` when `line` underlines nothing. */
function setextOf(
  line: string,
  before: string | undefined,
): { level: number; text: string } | null {
  const underline = SETEXT.exec(line);
  if (underline === null || before === undefined) return null;
  if (before.trim() === "" || ITEM.test(before) || HEADING_LINE.test(before))
    return null;
  return {
    level: underline[1]?.startsWith("=") ? 1 : 2,
    text: before.trim().toLowerCase(),
  };
}

/** The lines of each out-of-tree section of a description, read outside code and comments. */
function sections(body: string): string[][] {
  const found: string[][] = [];
  let current: string[] | null = null;
  const lines = readLines(body);
  for (const [i, line] of lines.entries()) {
    const setext = setextOf(line, lines[i - 1]);
    // The underlined line was read as the section's text: it is the heading.
    if (setext !== null) current?.pop();
    const heading = setext ?? headingOf(line);
    if (heading === null) current?.push(line);
    else if (heading.level === 2 && heading.text === HEADING) {
      current = [];
      found.push(current);
    } else if (heading.level <= 2) current = null;
  }
  return found;
}

/** The text of a list item without its checkbox, and whether the box is open, checked or absent; `null` for a line that is no item or a thematic break. */
function itemText(
  line: string,
): { text: string; kind: "open" | "done" | "plain" } | null {
  const item = ITEM.exec(line);
  if (item === null || BREAK.test(line)) return null;
  const box = BOX.exec(item[2] ?? "");
  if (box === null) return { text: (item[2] ?? "").trim(), kind: "plain" };
  return {
    text: (box[2] ?? "").trim(),
    kind: box[1] === " " ? "open" : "done",
  };
}

/** One list item of a section: its indent, and whether it is an open box, a checked one or a plain item; `null` for a line that is no step. */
function itemOf(
  line: string,
): { indent: number; kind: "open" | "done" | "plain" } | null {
  const item = itemText(line);
  if (item === null || item.text === "" || saysNone(item.text)) return null;
  return { indent: indentOf(line), kind: item.kind };
}

/** The steps a description's out-of-tree section lists; none when it has no such section. */
export function owedSteps(body: string): OwedSteps {
  const steps: OwedSteps = { open: 0, done: 0 };
  for (const lines of sections(body)) {
    // The first step's indent is the steps' own; a plain item deeper than it is a step's detail.
    const items = lines.flatMap((l) => itemOf(l) ?? []);
    const top = items[0]?.indent ?? 0;
    for (const item of items) {
      if (item.kind === "done") steps.done += 1;
      else if (item.kind === "open" || item.indent <= top) steps.open += 1;
    }
  }
  return steps;
}

/** Whether a description owes a step; `null` when the description was not read. */
export function owesSteps(body: string | undefined): boolean | null {
  return body === undefined ? null : owedSteps(body).open > 0;
}

/**
 * The repository's manual-operations label, from its configuration values;
 * `invalid` when its tracker labels do not read, or the name cannot be
 * written as one label: it holds a comma (the forge's label flags split on
 * it), is longer than the forge takes, or it is a label of the dispatcher's own (under the dispatch
 * prefix, `automation` or of the `automation:` family).
 */
export function manualOpsLabel(
  values: Record<string, unknown>,
  prefix: string,
): Outcome<string, "invalid"> {
  try {
    const name = parseTrackerLabels(values).manualOps;
    if (name.includes(","))
      return failed(
        "invalid",
        `issue_tracker.labels.manual_ops '${name}' holds a comma, which splits it into two labels`,
      );
    if (name.length > MAX_LABEL)
      return failed(
        "invalid",
        `issue_tracker.labels.manual_ops '${name}' is longer than the forge's ${MAX_LABEL} characters for a label`,
      );
    if (
      (prefix !== "" && name.startsWith(prefix)) ||
      name === "automation" ||
      name.startsWith("automation:")
    )
      return failed(
        "invalid",
        `issue_tracker.labels.manual_ops '${name}' is a label the dispatcher keeps itself (under '${prefix}', or automation)`,
      );
    return ok(name);
  } catch (error) {
    return failed("invalid", failureText(error), error);
  }
}
