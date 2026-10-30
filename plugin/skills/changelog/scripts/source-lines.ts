// The source line each block of a Markdown document starts on. Bun's parser
// (markdown-tree.ts) reports no positions, so a line is assigned to a block
// only on proof: a `#` heading line tagged with its number that renders as
// that heading, or a line where the document splits, the lines before it
// rendering as the blocks before the block and the lines from it as the
// block and those after, kind for kind. Used by the lint's reader
// (lint-structure.ts) to say where a finding points.
import { fenced, heading } from "./markdown-blocks.ts";
import {
  type Block,
  type Inline,
  parseBlocks,
  plain,
} from "./markdown-tree.ts";

/** What kind of block `b` is: what a split must keep. */
const shape = (b: Block | undefined): string =>
  b === undefined
    ? ""
    : b.k === "heading"
      ? `h${b.level}`
      : b.k === "list"
        ? `list ${b.ordered}`
        : b.k === "other"
          ? b.kind
          : b.k;

const same = (a: Block[], b: Block[]): boolean =>
  a.length === b.length && a.every((x, i) => shape(x) === shape(b[i]));

/**
 * The lines of the top-level `#` headings, by their index among the blocks.
 * Each `#` heading line outside fenced code is tagged with its number and the
 * tagged file parsed once; a heading names its line when it renders with the
 * tag at the same level. A line inside an HTML comment, or one that renders
 * as something else, names none, and a source that already holds the tag's
 * delimiter is not tagged at all: its headings are located instead.
 */
export function headingLines(
  lines: string[],
  blocks: Block[],
): Map<number, number> {
  const tag = "\u{E000}";
  const proven = new Map<number, number>();
  if (lines.some((l) => l.includes(tag))) return proven;
  const written = new Set(
    fenced(lines.join("\n")).flatMap((l, i) =>
      !l.inFence && heading(l.line) ? [i + 1] : [],
    ),
  );
  const tagged = lines.map((l, i) =>
    written.has(i + 1) ? `${l} ${tag}${i + 1}${tag}` : l,
  );
  const seen = parseBlocks(tagged.join("\n"));
  if (!same(seen, blocks)) return proven;
  const marker = new RegExp(`${tag}(\\d+)${tag}`);
  for (const [index, b] of seen.entries()) {
    const n = b.k === "heading" ? marker.exec(plain(b.inline))?.[1] : undefined;
    if (n !== undefined && written.has(Number(n))) proven.set(index, Number(n));
  }
  return proven;
}

/**
 * The stretch of the file a block sits in: between the proven headings
 * nearest it on either side, or the file's ends. A top-level heading ends
 * every block before it and starts the next, so the stretch renders on its
 * own as the blocks between, kind for kind.
 */
interface Stretch {
  /** The stretch's first line, 1-based. */
  from: number;
  lines: string[];
  /** The index of its first block among the document's. */
  first: number;
  blocks: Block[];
}

function stretchOf(
  lines: string[],
  blocks: Block[],
  proven: Map<number, number>,
  index: number,
): Stretch {
  let [first, from, last, to] = [0, 1, blocks.length, lines.length + 1];
  for (const [i, line] of proven) {
    if (i < index && i >= first) [first, from] = [i + 1, line + 1];
    if (i > index && i < last) [last, to] = [i, line];
  }
  return {
    from,
    lines: lines.slice(from - 1, to - 1),
    first,
    blocks: blocks.slice(first, last),
  };
}

/**
 * Whether the stretch splits before its line `n` (0-based) at block `rel`,
 * or with `item` at that list item: the lines before render as the blocks
 * before it (and the list's earlier items), the lines from it as it and the
 * blocks after.
 */
function splits(s: Stretch, n: number, rel: number, item?: number): boolean {
  const before = parseBlocks(s.lines.slice(0, n).join("\n"));
  const after = parseBlocks(s.lines.slice(n).join("\n"));
  const list = s.blocks[rel];
  if (item === undefined || item === 0 || list?.k !== "list")
    return (
      same(before, s.blocks.slice(0, rel)) && same(after, s.blocks.slice(rel))
    );
  const head = before.at(-1);
  const tail = after[0];
  return (
    same(before, s.blocks.slice(0, rel + 1)) &&
    same(after, s.blocks.slice(rel)) &&
    head?.k === "list" &&
    head.items.length === item &&
    tail?.k === "list" &&
    tail.items.length === list.items.length - item
  );
}

/** The text a block opens with: its own, or its first item's or block's; null for code, HTML, a break or a table. */
function opening(b: Block | undefined): Inline[] | null {
  if (b?.k === "heading" || b?.k === "paragraph") return b.inline;
  if (b?.k === "list") return opening(b.items[0]?.[0]);
  if (b?.k === "quote") return opening(b.blocks[0]);
  return null;
}

/**
 * Text as a line alone and the whole file both render it: brackets and link
 * text left out, since a definition elsewhere in the file can turn bracketed
 * text into a link; whitespace collapsed.
 */
function signature(inline: Inline[]): string {
  let s = inline
    .map((i) => (i.k === "text" ? i.v : i.k === "link" ? "\0" : " "))
    .join("");
  for (let t = ""; t !== s; ) [t, s] = [s, s.replace(/\[[^[\]]*\]/g, "")];
  return s.replaceAll("\0", "").replace(/\s+/g, " ").trim();
}

/**
 * The signature of the text the block (or list item) a split puts at `rel`
 * opens with, or null when it opens with none. Computed once per block, so
 * testing a line against it costs that line alone.
 */
function wanted(s: Stretch, rel: number, item?: number): string | null {
  const target = s.blocks[rel];
  const block =
    item !== undefined && target?.k === "list"
      ? ({
          k: "list",
          ordered: target.ordered,
          items: [target.items[item] ?? []],
        } as Block)
      : target;
  const want = opening(block);
  return want === null ? null : signature(want);
}

/**
 * Whether line `n` (0-based) of the stretch, rendered alone, opens the block
 * whose opening signature is `want` (from `wanted`): of a kind that starts
 * it, and with text the block's own opens with. A link definition renders no
 * block, so a split at one holds; its line alone shows other text, or none.
 */
function opens(s: Stretch, n: number, want: string | null): boolean {
  const alone = parseBlocks(s.lines[n] ?? "")[0];
  if (want === null) return alone !== undefined;
  const got = opening(alone);
  return got !== null && want.startsWith(signature(got));
}

/**
 * The first line, 0-based, of the stretch's first prefix that `holds`, by
 * binary search over `[lo, hi]`: a guess, which `splits` then proves.
 */
function firstHolding(lo: number, hi: number, holds: (n: number) => boolean) {
  let [a, b] = [lo, hi];
  while (a < b) {
    const mid = (a + b) >> 1;
    if (holds(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

/** How many lines past the searched guesses a split is tried at, each two parses of the stretch, before a block is placed at its stretch's start. */
const PROOF_LIMIT = 200;

/**
 * The line block `path` (an index, maybe a list item) starts on. Guesses come
 * from searching the prefixes for the first that shows the block, and, for a
 * heading or table whose lines render as a paragraph until its last, the
 * first that shows that paragraph; a guess counts only where the stretch
 * splits. Without a proven guess, every line of the stretch that opens the
 * block when rendered alone is tried in order, up to PROOF_LIMIT of them; a
 * block still unplaced is reported at its stretch's first line.
 */
export function locate(
  lines: string[],
  blocks: Block[],
  proven: Map<number, number>,
  path: number[],
): number {
  const [index, item] = path as [number, number?];
  const s = stretchOf(lines, blocks, proven, index);
  const rel = index - s.first;
  const blank = (n: number) => (s.lines[n] ?? "").trim() === "";
  const want = wanted(s, rel, item);
  const proof = (n: number): number | null => {
    let m = n;
    while (m < s.lines.length && blank(m)) m++;
    return m < s.lines.length && opens(s, m, want) && splits(s, m, rel, item)
      ? s.from + m
      : null;
  };
  const shows = (target: Block[]) => (n: number) => {
    const b = parseBlocks(s.lines.slice(0, n + 1).join("\n"));
    const at = b[rel];
    return (
      same(b.slice(0, rel), target.slice(0, rel)) &&
      shape(at) === shape(target[rel]) &&
      (item === undefined || (at?.k === "list" && at.items.length > item))
    );
  };
  const end = s.lines.length - 1;
  const shown = firstHolding(0, end, shows(s.blocks));
  const paragraph: Block = { k: "paragraph", inline: [] };
  const opening = s.blocks.map((b, i) => (i === rel ? paragraph : b));
  const guesses = [shown];
  if (item === undefined && shape(s.blocks[rel]) !== "paragraph")
    guesses.push(firstHolding(0, shown, shows(opening)));
  for (const n of guesses) {
    const found = proof(n);
    if (found !== null) return found;
  }
  let tried = 0;
  for (let n = 0; n <= end && tried < PROOF_LIMIT; n++) {
    if (blank(n) || guesses.includes(n) || !opens(s, n, want)) continue;
    tried++;
    if (splits(s, n, rel, item)) return s.from + n;
  }
  return s.from;
}
