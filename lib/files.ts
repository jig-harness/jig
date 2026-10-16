import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * List files relative to a root; exclusions apply to relative components.
 * Regular files and links to them by default; with `everyEntry`, every entry
 * that is not a directory, so a caller that checks an entry's kind before
 * reading it also sees links to nothing, FIFOs and devices.
 */
export function walk(
  root: string,
  exclude: string[] = [".git", "node_modules"],
  everyEntry = false,
): string[] {
  const files: string[] = [];
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      if (exclude.includes(entry.name)) continue;
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (
        everyEntry ||
        entry.isFile() ||
        (entry.isSymbolicLink() && statSync(join(root, name)).isFile())
      )
        files.push(name);
    }
  }
  visit("");
  return files.sort();
}

/**
 * A file's text, read only once its path is shown to reach a regular file.
 * A FIFO blocks the read and a device such as /dev/zero never ends it, so
 * every other kind of entry, a link to nothing included, throws instead.
 */
export function readRegularFile(path: string): string {
  const target = statSync(path, { throwIfNoEntry: false });
  if (!target) throw new Error("a link to nothing");
  if (!target.isFile()) throw new Error("not a regular file");
  return readFileSync(path, "utf8");
}

/**
 * Git supplies repository scope; NUL records preserve spaces and Unicode.
 * Git still lists a tracked file deleted from the working tree until the
 * deletion is staged, so only entries present on disk (a link to nothing
 * included) are returned. Outside a git work tree the walk stands in,
 * `everyEntry` as for `walk`. Names use forward slashes on every platform.
 */
export function repoFiles(root: string, { everyEntry = false } = {}): string[] {
  if (!statSync(root).isDirectory())
    throw new Error(`root is not a directory: ${root}`);
  const probe = Bun.spawnSync([
    "git",
    "-C",
    resolve(root),
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (probe.exitCode !== 0)
    return walk(root, [".git", "node_modules"], everyEntry).map((name) =>
      name.replaceAll("\\", "/"),
    );
  const listed = Bun.spawnSync([
    "git",
    "-C",
    resolve(root),
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed under ${root}`);
  return [
    ...new Set(listed.stdout.toString().split("\0").filter(Boolean)),
  ].filter((name) => lstatSync(join(root, name), { throwIfNoEntry: false }));
}

export function markdownFiles(root: string, excluded: string[]): string[] {
  return repoFiles(root)
    .filter(
      (name) =>
        name.endsWith(".md") &&
        !name.split(/[\\/]/).some((part) => excluded.includes(part)) &&
        existsSync(join(root, name)),
    )
    .map((name) => join(root, name));
}

/** Mask fenced blocks using the same toggle convention as the legacy gates. */
export function prose(content: string): string {
  let fenced = false;
  return content
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return false;
      }
      return !fenced;
    })
    .join("\n")
    .replace(/`[^`]*`/g, "");
}

// A fence line, by CommonMark's grammar: up to three spaces, then three or more
// backticks or tildes. A backtick fence's info string holds no backtick, so
// ```example``` is an inline code span, not a fence.
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(.*)$/;

/** The fence open after `line`, given the one open before it: a fence closes
 * only on a line of its own character, at least as long, with nothing after.
 * A line's own carriage return is its ending, not its text. */
export function fenceAfter(
  open: string | undefined,
  line: string,
): string | undefined {
  const [, marks = "", rest = ""] = FENCE.exec(line.replace(/\r$/, "")) ?? [];
  if (open === undefined) return marks || undefined;
  const closes =
    marks[0] === open[0] && marks.length >= open.length && rest.trim() === "";
  return closes ? undefined : open;
}

// A line ending, by CommonMark: LF, CRLF or a lone CR. A CR is lone only when
// no LF follows it, so backtracking can never split one CRLF into two endings.
const EOL = String.raw`(?:\r\n|\r(?!\n)|\n)`;
const LINE_END = new RegExp(`(${EOL})`);

// A line that is a block of its own whatever is open before it: blank, an ATX
// heading, a thematic break or setext underline.
const OWN_BLOCK =
  /^[ \t]*$|^ {0,3}(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$|=+[ \t]*$)/;
// A setext underline of dashes too short for a thematic break; it underlines
// only a paragraph, and elsewhere is a list item.
const SETEXT_DASHES = /^ {0,3}-+[ \t]*$/;
// A list item's marker and the text after it.
const LIST_ITEM = /^[ \t]*(?:[-+*]|(\d{1,9})[.)])(?:[ \t]+(.*)|$)/;
// A table's delimiter row, which makes the line above it a header row.
const DELIMITER_ROW =
  /^[ \t]*(?=[^|]*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// One block-quote marker.
const QUOTE_MARKER = /^ {0,3}>[ \t]?/;

/** A line's block-quote depth and its content inside the quotes. */
function quoted(line: string): { depth: number; content: string } {
  let depth = 0;
  let content = line;
  for (let m = QUOTE_MARKER.exec(content); m; m = QUOTE_MARKER.exec(content)) {
    depth++;
    content = content.slice(m[0].length);
  }
  return { depth, content };
}

/** What is open before a line: a paragraph whose last matched container is
 * the paragraph itself, one inside a list item, or a table, at a quote depth. */
interface Open {
  kind: "none" | "paragraph" | "list" | "table";
  depth: number;
}

/** Whether a list item on this line may end the paragraph open before it.
 * By CommonMark, a paragraph is interrupted only by a non-empty item that is a
 * bullet or an ordered item starting at 1; outside a paragraph any item opens. */
function listInterrupts(open: Open, depth: number, item: RegExpExecArray) {
  if (open.kind !== "paragraph" || depth !== open.depth) return true;
  const [, start, rest = ""] = item;
  return rest.trim() !== "" && (start === undefined || Number(start) === 1);
}

/** How one line meets the block open before it: whether it ends that block,
 * whether it is a block of its own, and what is open after it. Tables follow
 * GitHub's extension: a header row is the line above a delimiter row, and
 * every line after it is a row until a blank line or another block. */
function blockStep(
  open: Open,
  line: string,
  next: string | undefined,
): { ends: boolean; own: boolean; open: Open } {
  const { depth, content } = quoted(line);
  const none: Open = { kind: "none", depth };
  if (
    OWN_BLOCK.test(content) ||
    (open.kind === "paragraph" &&
      depth === open.depth &&
      SETEXT_DASHES.test(content))
  )
    return { ends: true, own: true, open: none };
  const table: Open = { kind: "table", depth };
  if (open.kind === "table" && depth === open.depth)
    return { ends: true, own: true, open: table };
  const below = next === undefined ? undefined : quoted(next);
  if (
    content.includes("|") &&
    below?.depth === depth &&
    DELIMITER_ROW.test(below.content)
  )
    return { ends: true, own: true, open: table };
  const item = LIST_ITEM.exec(content);
  const list: Open = { kind: "list", depth };
  if (item && listInterrupts(open, depth, item))
    return { ends: true, own: false, open: list };
  if (depth > open.depth || open.kind === "none")
    return {
      ends: true,
      own: false,
      open: item ? list : { kind: "paragraph", depth },
    };
  return { ends: false, own: false, open };
}

/** The length of the backtick run starting at `at`. */
function runAt(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") end++;
  return end - at;
}

/** Where the backtick run closing an `length`-long opener starts, scanning
 * from `from`, or -1 when the end comes first. Inside a span a backslash is
 * literal, so it escapes nothing. */
function closingRun(text: string, from: number, length: number): number {
  for (let at = from; at < text.length; ) {
    if (text[at] !== "`") {
      at++;
      continue;
    }
    const run = runAt(text, at);
    if (run === length) return at;
    at += run;
  }
  return -1;
}

/** The code spans of one block by CommonMark's grammar, as spaces with their
 * line endings kept: a backtick run opens one unless a backslash escapes its
 * first backtick, and a run of the same length in the block closes it. */
function blankSpans(text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const char = text[at] as string;
    if (char === "\\") {
      out += text.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (char !== "`") {
      out += char;
      at++;
      continue;
    }
    const run = runAt(text, at);
    const close = closingRun(text, at + run, run);
    const end = close === -1 ? at + run : close + run;
    const taken = text.slice(at, end);
    out += close === -1 ? taken : taken.replace(/[^\r\n]/g, " ");
    at = end;
  }
  return out;
}

/**
 * Prose with its code blanked and its line count kept: the lines of a fenced
 * block (by `fenceAfter`'s grammar) become empty and a code span, one that
 * crosses lines included, becomes spaces with its line endings kept, so a
 * finding's line number is the file's. A code span is found within one block,
 * as CommonMark parses inline content, and a line ends the block before it
 * only where CommonMark lets it interrupt what is open (`blockStep`): an
 * ordered item not starting at 1 continues a paragraph, a line starting with a
 * pipe is a table row only under a header and delimiter row. Indented code and
 * fences inside a block quote are not recognised. `prose` drops the lines
 * instead.
 */
export function blankCode(content: string): string {
  let fence: string | undefined;
  // Odd indexes hold the line endings, kept as they are.
  const parts = content.split(LINE_END);
  for (let i = 0; i < parts.length; i += 2) {
    const before = fence;
    fence = fenceAfter(before, parts[i] as string);
    if (before !== undefined || fence !== undefined) parts[i] = "";
  }
  let out = "";
  let block = "";
  let open: Open = { kind: "none", depth: 0 };
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] as string;
    const step = blockStep(open, line, parts[i + 2]);
    if (step.ends) {
      out += blankSpans(block);
      block = "";
    }
    block += line + (parts[i + 1] ?? "");
    if (step.own) {
      out += blankSpans(block);
      block = "";
    }
    open = step.open;
  }
  return out + blankSpans(block);
}
