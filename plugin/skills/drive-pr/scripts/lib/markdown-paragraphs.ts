/**
 * The top-level paragraphs of a Markdown document, found by the CommonMark
 * block-structure rules and nothing else: no inline parsing, no dependencies.
 *
 * The scanner follows the parsing strategy of the CommonMark 0.31
 * specification: each line first continues the open containers (block
 * quotes, list items), then may open new blocks, and what remains is
 * paragraph text, either continuing an open paragraph (lazily, through
 * unmatched containers) or starting a new one. Containers are tracked only to
 * know where they end; the only output is the raw source of each paragraph
 * that is a direct child of the document.
 *
 * Where micromark (the parser behind remark) departs from the
 * specification's reference parser, the scanner sides with micromark, and
 * its tests pin each such case: a list item cannot interrupt indented code
 * either; an ordered item interrupts only when numbered exactly `1`; a
 * complete HTML tag on a lazy line starts an HTML block that stays inside the
 * containers; indented code begun on a lazy line ends with that line; a
 * parenthesized link title may contain `(`.
 */

type Kind =
  | "document"
  | "quote"
  | "item"
  | "paragraph"
  | "fence"
  | "indented"
  | "html"
  | "heading"
  | "break";

interface Span {
  start: number;
  end: number;
}

interface Block {
  kind: Kind;
  parent: Block | undefined;
  children: Block[];
  open: boolean;
  /** List item: the column its content starts at, relative to its container. */
  contentIndent: number;
  fenceChar: string;
  fenceLength: number;
  htmlType: number;
  /** Paragraph: each line's text, leading whitespace excluded. */
  lines: Span[];
}

const CODE_INDENT = 4;

const TAG_NAME = "[A-Za-z][A-Za-z0-9-]*";
const ATTRIBUTE =
  "(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG = `<${TAG_NAME}${ATTRIBUTE}*[ \\t]*/?>`;
const CLOSE_TAG = `</${TAG_NAME}[ \\t]*>`;
const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/** HTML block start conditions 1–7, indexed by type. */
const HTML_OPEN: readonly RegExp[] = [
  /(?!)/,
  /^<(?:script|pre|textarea|style)(?:[ \t>]|$)/i,
  /^<!--/,
  /^<\?/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]|/?>|$)`, "i"),
  new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})[ \\t]*$`, "i"),
];
/** End conditions of HTML block types 1–5; types 6 and 7 end at a blank line. */
const HTML_CLOSE: readonly RegExp[] = [
  /(?!)/,
  /<\/(?:script|pre|textarea|style)>/i,
  /-->/,
  /\?>/,
  />/,
  /\]\]>/,
];

const ATX_HEADING = /^#{1,6}(?:[ \t]+|$)/;
// A backtick fence's info string cannot contain a backtick.
const CODE_FENCE = /^`{3,}(?=[^`]*$)|^~{3,}/;
const CLOSING_FENCE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const BULLET_MARKER = /^[*+-]/;
const ORDERED_MARKER = /^(\d{1,9})([.)])/;
const MAYBE_SPECIAL = /^[#`~*+_=<>0-9-]/;

const isSpaceOrTab = (c: string | undefined): boolean =>
  c === " " || c === "\t";

function newBlock(kind: Kind, parent: Block | undefined): Block {
  return {
    kind,
    parent,
    children: [],
    open: true,
    contentIndent: 0,
    fenceChar: "",
    fenceLength: 0,
    htmlType: 0,
    lines: [],
  };
}

const isContainer = (kind: Kind): boolean =>
  kind === "document" || kind === "quote" || kind === "item";

const acceptsLines = (kind: Kind): boolean =>
  kind === "paragraph" ||
  kind === "fence" ||
  kind === "indented" ||
  kind === "html";

/** Split on CommonMark line endings: LF, CRLF and a lone CR. A leading byte
 * order mark is not content. */
function splitLines(body: string): Span[] {
  const lines: Span[] = [];
  const ending = /\r\n|\n|\r/g;
  let start = body.startsWith("\uFEFF") ? 1 : 0;
  for (let m = ending.exec(body); m !== null; m = ending.exec(body)) {
    lines.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < body.length) lines.push({ start, end: body.length });
  return lines;
}

class BlockScanner {
  readonly doc = newBlock("document", undefined);
  private tip: Block = this.doc;
  private oldTip: Block = this.doc;
  private lastMatched: Block = this.doc;
  private allClosed = true;

  private line = "";
  private lineStart = 0;
  private offset = 0;
  private column = 0;
  private nextNonspace = 0;
  private nextNonspaceColumn = 0;
  private indent = 0;
  private indented = false;
  private blank = false;
  /** This line continues not all open containers (and starts none yet). */
  private lazy = false;
  /** A paragraph or indented code is open here: a list item interrupting it
   * must be non-empty, and an ordered one must start at 1. */
  private interrupting = false;
  /** Indented code begun on a lazy line ends with that line. */
  private closeAtNextLine: Block | undefined;

  // A plain field, not a constructor parameter property: Node's type
  // stripping cannot run parameter properties, and the scripts must load
  // under Node as well as Bun.
  private readonly body: string;

  constructor(body: string) {
    this.body = body;
  }

  scan(): Block {
    for (const { start, end } of splitLines(this.body)) {
      this.incorporate(this.body.slice(start, end), start);
    }
    while (this.tip !== this.doc) this.finalize(this.tip);
    return this.doc;
  }

  private findNextNonspace(): void {
    let i = this.offset;
    let cols = this.column;
    let c = this.line[i];
    while (c === " " || c === "\t") {
      cols += c === " " ? 1 : 4 - (cols % 4);
      i++;
      c = this.line[i];
    }
    this.blank = c === undefined;
    this.nextNonspace = i;
    this.nextNonspaceColumn = cols;
    this.indent = cols - this.column;
    this.indented = this.indent >= CODE_INDENT;
  }

  private advanceNextNonspace(): void {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
  }

  /** Advance by characters, or (with `columns`) by columns, splitting a tab. */
  private advanceOffset(count: number, columns: boolean): void {
    let left = count;
    while (left > 0) {
      const c = this.line[this.offset];
      if (c === undefined) return;
      if (c === "\t") {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          const step = Math.min(toTab, left);
          this.column += step;
          if (toTab <= left) this.offset++;
          left -= step;
        } else {
          this.column += toTab;
          this.offset++;
          left--;
        }
      } else {
        this.offset++;
        this.column++;
        left--;
      }
    }
  }

  private finalize(block: Block): void {
    block.open = false;
    if (block.parent) this.tip = block.parent;
  }

  private addChild(kind: Kind): Block {
    while (!isContainer(this.tip.kind)) this.finalize(this.tip);
    const child = newBlock(kind, this.tip);
    this.tip.children.push(child);
    this.tip = child;
    return child;
  }

  private closeUnmatchedBlocks(): void {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatched) {
      const parent = this.oldTip.parent;
      this.finalize(this.oldTip);
      if (!parent) break;
      this.oldTip = parent;
    }
    this.allClosed = true;
  }

  private addLine(): void {
    if (this.tip.kind !== "paragraph") return;
    this.tip.lines.push({
      start: this.lineStart + this.offset,
      end: this.lineStart + this.line.length,
    });
  }

  /** 0: matched; 1: not matched; 2: the line is consumed (closing fence). */
  private continues(block: Block): 0 | 1 | 2 {
    switch (block.kind) {
      case "document":
        return 0;
      case "quote":
        if (!this.indented && this.line[this.nextNonspace] === ">") {
          this.advanceNextNonspace();
          this.advanceOffset(1, false);
          if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
          return 0;
        }
        return 1;
      case "item":
        if (this.blank) {
          if (block.children.length === 0) return 1;
          this.advanceNextNonspace();
          return 0;
        }
        if (this.indent >= block.contentIndent) {
          this.advanceOffset(block.contentIndent, true);
          return 0;
        }
        return 1;
      case "paragraph":
        return this.blank ? 1 : 0;
      case "fence": {
        const rest = this.line.slice(this.nextNonspace);
        const close = this.indent <= 3 ? CLOSING_FENCE.exec(rest) : null;
        if (
          close &&
          rest[0] === block.fenceChar &&
          close[0].length >= block.fenceLength
        ) {
          this.finalize(block);
          return 2;
        }
        return 0;
      }
      case "indented":
        if (this.indent >= CODE_INDENT) {
          this.advanceOffset(CODE_INDENT, true);
          return 0;
        }
        if (this.blank) {
          this.advanceNextNonspace();
          return 0;
        }
        return 1;
      case "html":
        return this.blank && block.htmlType >= 6 ? 1 : 0;
      default:
        return 1;
    }
  }

  private incorporate(line: string, lineStart: number): void {
    this.line = line;
    this.lineStart = lineStart;
    this.offset = 0;
    this.column = 0;
    if (this.closeAtNextLine?.open) this.finalize(this.closeAtNextLine);
    this.closeAtNextLine = undefined;
    this.oldTip = this.tip;

    let container = this.doc;
    for (;;) {
      const last = container.children.at(-1);
      if (!last?.open) break;
      container = last;
      this.findNextNonspace();
      const result = this.continues(container);
      if (result === 2) return;
      if (result === 1) {
        container = container.parent ?? this.doc;
        break;
      }
    }

    this.allClosed = container === this.oldTip;
    this.lastMatched = container;
    const innermost = isContainer(this.tip.kind)
      ? this.tip
      : (this.tip.parent ?? this.doc);
    this.lazy = container !== innermost && container !== this.tip;
    this.interrupting =
      !this.lazy &&
      (this.tip.kind === "paragraph" || this.tip.kind === "indented");

    let matchedLeaf =
      container.kind !== "paragraph" && acceptsLines(container.kind);
    while (!matchedLeaf) {
      this.findNextNonspace();
      if (
        !this.indented &&
        !MAYBE_SPECIAL.test(this.line.slice(this.nextNonspace))
      ) {
        this.advanceNextNonspace();
        break;
      }
      const started = this.startBlock(container);
      if (started === 0) {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      if (started === 2) matchedLeaf = true;
    }

    if (!this.allClosed && !this.blank && this.tip.kind === "paragraph") {
      this.addLine(); // lazy paragraph continuation
      return;
    }
    this.closeUnmatchedBlocks();
    if (acceptsLines(container.kind)) {
      this.addLine();
      const type = container.htmlType;
      if (
        container.kind === "html" &&
        type >= 1 &&
        type <= 5 &&
        HTML_CLOSE[type]?.test(this.line.slice(this.offset))
      ) {
        this.finalize(container);
      }
    } else if (this.offset < this.line.length && !this.blank) {
      this.addChild("paragraph");
      this.advanceNextNonspace();
      this.addLine();
    }
  }

  /** 0: nothing starts; 1: a container started; 2: a leaf started. */
  private startBlock(container: Block): 0 | 1 | 2 {
    const rest = this.line.slice(this.nextNonspace);
    if (!this.indented) {
      if (rest[0] === ">") {
        this.advanceNextNonspace();
        this.advanceOffset(1, false);
        if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
        this.closeUnmatchedBlocks();
        this.addChild("quote");
        return 1;
      }
      if (ATX_HEADING.test(rest)) {
        this.closeUnmatchedBlocks();
        this.addChild("heading");
        this.offset = this.line.length;
        return 2;
      }
      const fence = CODE_FENCE.exec(rest);
      if (fence) {
        this.closeUnmatchedBlocks();
        const block = this.addChild("fence");
        block.fenceChar = fence[0][0] ?? "`";
        block.fenceLength = fence[0].length;
        this.advanceNextNonspace();
        this.advanceOffset(fence[0].length, false);
        return 2;
      }
      const htmlType = this.htmlBlockType(rest, container);
      if (htmlType === 7 && !this.allClosed && this.tip.kind === "paragraph") {
        // As in micromark, a complete tag on a lazy line ends the paragraph
        // but stays inside its containers: the next line that does not
        // continue them ends it.
        this.finalize(this.tip);
        this.allClosed = true;
        this.addChild("html").htmlType = htmlType;
        return 2;
      }
      if (htmlType > 0) {
        this.closeUnmatchedBlocks();
        this.addChild("html").htmlType = htmlType;
        return 2;
      }
      if (
        container.kind === "paragraph" &&
        SETEXT_UNDERLINE.test(rest) &&
        definitionLines(this.body, container.lines) < container.lines.length
      ) {
        this.closeUnmatchedBlocks();
        container.kind = "heading";
        this.tip = container;
        this.offset = this.line.length;
        return 2;
      }
      if (THEMATIC_BREAK.test(rest)) {
        this.closeUnmatchedBlocks();
        this.addChild("break");
        this.offset = this.line.length;
        return 2;
      }
      const contentIndent = this.listItemStart(rest);
      if (contentIndent !== null) {
        this.closeUnmatchedBlocks();
        this.addChild("item").contentIndent = contentIndent;
        return 1;
      }
      return 0;
    }
    if (this.tip.kind !== "paragraph" && !this.blank) {
      const lazy = this.lazy && !this.allClosed;
      this.advanceOffset(CODE_INDENT, true);
      this.closeUnmatchedBlocks();
      const code = this.addChild("indented");
      if (lazy) this.closeAtNextLine = code;
      return 2;
    }
    return 0;
  }

  private htmlBlockType(rest: string, container: Block): number {
    if (rest[0] !== "<") return 0;
    for (let type = 1; type <= 7; type++) {
      if (!HTML_OPEN[type]?.test(rest)) continue;
      // A complete tag cannot interrupt a paragraph it would continue.
      if (type === 7 && container.kind === "paragraph") return 0;
      return type;
    }
    return 0;
  }

  /** The content indent of a list item starting here, or null. */
  private listItemStart(rest: string): number | null {
    if (this.indent >= CODE_INDENT) return null;
    let marker: string;
    const bullet = BULLET_MARKER.exec(rest);
    if (bullet) {
      marker = bullet[0];
    } else {
      const ordered = ORDERED_MARKER.exec(rest);
      if (!ordered || (this.interrupting && ordered[1] !== "1")) return null;
      marker = ordered[0];
    }
    const after = rest[marker.length];
    if (after !== undefined && !isSpaceOrTab(after)) return null;
    if (this.interrupting && /^[ \t]*$/.test(rest.slice(marker.length))) {
      return null;
    }

    const markerOffset = this.indent;
    this.advanceNextNonspace();
    this.advanceOffset(marker.length, true);
    const spacesStartColumn = this.column;
    const spacesStartOffset = this.offset;
    do {
      this.advanceOffset(1, true);
    } while (
      this.column - spacesStartColumn < 5 &&
      isSpaceOrTab(this.line[this.offset])
    );
    const blankItem = this.line[this.offset] === undefined;
    const spaces = this.column - spacesStartColumn;
    if (spaces >= 5 || spaces < 1 || blankItem) {
      this.column = spacesStartColumn;
      this.offset = spacesStartOffset;
      if (isSpaceOrTab(this.line[this.offset])) this.advanceOffset(1, true);
      return markerOffset + marker.length + 1;
    }
    return markerOffset + marker.length + spaces;
  }
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Index just past a backslash escape or ordinary character at `i`. */
function stepChar(s: string, i: number): number {
  const next = s[i + 1];
  return s[i] === "\\" && next !== undefined && ASCII_PUNCTUATION.test(next)
    ? i + 2
    : i + 1;
}

/** Skip spaces and tabs, then at most one line ending and spaces and tabs. */
function skipWhitespace(
  s: string,
  from: number,
): { at: number; newline: boolean } {
  let i = from;
  while (isSpaceOrTab(s[i])) i++;
  let newline = false;
  if (s[i] === "\n") {
    newline = true;
    i++;
    while (isSpaceOrTab(s[i])) i++;
  }
  return { at: i, newline };
}

/** The end of a link destination starting at `i`, or null. */
function destinationEnd(s: string, i: number): number | null {
  if (s[i] === "<") {
    let j = i + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === ">") return j + 1;
      if (c === "<" || c === "\n") return null;
      j = stepChar(s, j);
    }
    return null;
  }
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j] ?? "";
    if (c <= " " || c === "\x7f") break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    j = stepChar(s, j);
  }
  return j > i && depth === 0 ? j : null;
}

/** The end of a link title starting at `i`, or null. Like micromark, an
 * unescaped `(` is allowed inside a parenthesized title. */
function titleEnd(s: string, i: number): number | null {
  const open = s[i];
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return null;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === close) return j + 1;
    j = stepChar(s, j);
  }
  return null;
}

/** The end of the line holding `i` (past its line ending), if only spaces
 * and tabs remain on it; else null. */
function lineEndAfter(s: string, i: number): number | null {
  let j = i;
  while (isSpaceOrTab(s[j])) j++;
  if (j === s.length) return j;
  return s[j] === "\n" ? j + 1 : null;
}

/** The end of a link reference definition starting at `i`, or null. */
function definitionEnd(s: string, i: number): number | null {
  if (s[i] !== "[") return null;
  let j = i + 1;
  let size = 0; // characters, line endings excluded; at most 999
  let nonBlank = false;
  while (s[j] !== "]") {
    const c = s[j];
    if (c === undefined || c === "[") return null;
    if (c !== " " && c !== "\t" && c !== "\n") nonBlank = true;
    const next = stepChar(s, j);
    if (c !== "\n") size += next - j;
    j = next;
  }
  if (!nonBlank || size > 999 || s[j + 1] !== ":") return null;
  const dest = destinationEnd(s, skipWhitespace(s, j + 2).at);
  if (dest === null) return null;
  const withoutTitle = lineEndAfter(s, dest);
  const gap = skipWhitespace(s, dest);
  if (gap.at > dest) {
    const title = titleEnd(s, gap.at);
    const end = title === null ? null : lineEndAfter(s, title);
    if (end !== null) return end;
  }
  return withoutTitle;
}

/** How many leading lines of a paragraph are link reference definitions. */
function definitionLines(body: string, lines: readonly Span[]): number {
  const text = lines.map(({ start, end }) => body.slice(start, end)).join("\n");
  let at = 0;
  for (;;) {
    const end = definitionEnd(text, at);
    if (end === null) break;
    at = end;
  }
  if (at === 0) return 0;
  // Definitions end at line ends; count the lines they consumed.
  let consumed = 0;
  let length = 0;
  for (const { start, end } of lines) {
    if (length >= at) break;
    length += end - start + 1;
    consumed++;
  }
  return consumed;
}

/** The raw source of each top-level paragraph of `body`, in order. A leading
 * run of link reference definitions is not part of its paragraph. */
export function topLevelParagraphs(body: string): string[] {
  const paragraphs: string[] = [];
  for (const block of new BlockScanner(body).scan().children) {
    if (block.kind !== "paragraph") continue;
    const first = block.lines[definitionLines(body, block.lines)];
    const last = block.lines.at(-1);
    if (first && last) paragraphs.push(body.slice(first.start, last.end));
  }
  return paragraphs;
}
