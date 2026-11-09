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
import { failureText } from "./text.ts";

/** The section's heading text, compared without case. */
const HEADING = "out-of-tree follow-ups";

/** The steps one description's section lists: those still owed and those done. */
export interface OwedSteps {
  open: number;
  done: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LINE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const BOX = /^\[([ xX])\]\s*(.*)$/;

const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** Whether an item's text says there is nothing to do: "None" or "N/A", however emphasised, alone or with a colon or parenthesis after it; a sentence that begins with the word is a step. */
function saysNone(text: string): boolean {
  return /^(?:none|n\/a)(?:\s*[:(–—].*)?$/i.test(
    text.replace(/^[\s_*~]+/, "").replace(/[\s_*~.!]+$/, ""),
  );
}

/** Whether `line` closes the open fence `fence`: its own marker, as long, and nothing after it. */
function closesFence(line: string, fence: string): boolean {
  const marker = FENCE.exec(line)?.[1];
  return (
    marker !== undefined &&
    marker[0] === fence[0] &&
    marker.length >= fence.length &&
    line.slice(line.indexOf(marker) + marker.length).trim() === ""
  );
}

/** What is left of `line` outside HTML comments, and whether a comment is open at its end; `open` says whether one was open at its start. */
function uncommented(
  line: string,
  open: boolean,
): { text: string; open: boolean } {
  let rest = line;
  let text = "";
  let inside = open;
  for (;;) {
    if (inside) {
      const close = rest.indexOf("-->");
      if (close === -1) return { text, open: true };
      rest = rest.slice(close + 3);
      inside = false;
    }
    const start = rest.indexOf("<!--");
    if (start === -1) return { text: text + rest, open: false };
    text += rest.slice(0, start);
    rest = rest.slice(start + 4);
    inside = true;
  }
}

/**
 * The description's lines outside fenced code and HTML comments, read in one
 * pass so that each hides the other's delimiters: a comment opener inside a
 * fence is code, and a fence inside a comment is comment. A comment that never
 * closes runs to the end; a fence closes only on a line of its own marker.
 */
function readLines(body: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const line of body.split(/\r?\n/)) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const marker = comment ? undefined : FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const read = uncommented(line, comment);
    comment = read.open;
    lines.push(read.text);
  }
  return lines;
}

/** A list line's indent, a tab counted as four spaces. */
const indentOf = (line: string): number =>
  (ITEM.exec(line)?.[1] ?? "").replace(/\t/g, "    ").length;

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

/** One list item of a section: its indent, and whether it is an open box, a checked one or a plain item; `null` for a line that is no step. */
function itemOf(
  line: string,
): { indent: number; kind: "open" | "done" | "plain" } | null {
  const item = ITEM.exec(line);
  if (item === null || BREAK.test(line)) return null;
  const box = BOX.exec(item[2] ?? "");
  const text = (box === null ? item[2] : box[2])?.trim() ?? "";
  if (text === "" || saysNone(text)) return null;
  const indent = indentOf(line);
  if (box === null) return { indent, kind: "plain" };
  return { indent, kind: box[1] === " " ? "open" : "done" };
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
 * it), or it is a label of the dispatcher's own (under the dispatch
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
