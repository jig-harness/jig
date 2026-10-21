// What a reader sees of a Markdown document, for the lifecycle map gate.
//
// The document is parsed by Bun's built-in CommonMark parser, with GitHub's
// tables, through its structured callbacks (`Bun.markdown.render`): the parser
// itself says which text is a table cell, a code span or a link. So a fenced or
// indented block, an HTML comment, a code span, a backslash escape, a reference
// definition and a table row are each what CommonMark makes of them, and an
// example of one written inside another is not mistaken for it.
//
// The document's own HTML is text to this reader, never structure: an `<a>`,
// a `<table>` or a `<code>` written as HTML is not a link, a table or a code
// span here, and neither is anything inside a `<script>` or a comment. The
// parser hands each inline HTML tag over as one text piece of its own, which
// is how a cell's prose keeps an unfilled `<placeholder>` while its text does
// not; an HTML comment is dropped.
//
// The parser reports no source positions. A finding's line is found instead by
// rendering parts of the document (`linesOf`): the line locates a finding and
// never decides one.

/** A table cell as a reader sees it. */
export interface Cell {
  /** The text, code spans included, without markup. */
  text: string;
  /** The text outside code spans, with the document's own HTML tags kept as written. */
  prose: string;
  /** The cell's code spans, without their backticks. */
  spans: string[];
  /** The targets of the cell's links. */
  links: string[];
}

/** A table body row; `index` counts the body rows of every table in the document. */
export interface Row {
  index: number;
  cells: Cell[];
}

export interface Table {
  /** The header cells' text. */
  header: string[];
  rows: Row[];
}

export interface Rendered {
  tables: Table[];
  /** The inline code spans, in document order. */
  spans: string[];
  /** The targets of every Markdown link, in document order. */
  links: string[];
}

/** A node of the parse: a callback's kind, what it was told, and its children. */
interface Node {
  kind: string;
  meta: Record<string, unknown> | undefined;
  children: Node[];
  /** A `text` node's text, as the parser decoded it. */
  text: string;
}

/** The structure the reader needs; every other kind passes its children on. */
const KINDS = [
  "codespan",
  "code",
  "html",
  "link",
  "table",
  "thead",
  "tr",
  "th",
  "td",
] as const;

// Each callback returns a reference to the node it built, and a parent reads
// its children back from the references it is handed. CommonMark turns a NUL
// in the document into U+FFFD, so a NUL in the parser's output is always one of
// these references.
const REF = /\0(\d+)\0/g;

/** The document as a tree of the nodes the reader needs. */
function parse(markdown: string): Node[] {
  const nodes: Node[] = [];
  const ref = (node: Node): string => `\0${nodes.push(node) - 1}\0`;
  const childrenOf = (s: string): Node[] =>
    [...s.matchAll(REF)].map((m) => nodes[Number(m[1])] as Node);
  const callbacks: Record<
    string,
    (children: string, meta?: Record<string, unknown>) => string
  > = {
    text: (text) => ref({ kind: "text", meta: undefined, children: [], text }),
  };
  for (const kind of KINDS)
    callbacks[kind] = (children, meta) =>
      ref({ kind, meta, children: childrenOf(children), text: "" });
  return childrenOf(Bun.markdown.render(markdown, callbacks));
}

/** A piece of text that is one HTML tag or comment the document wrote. */
const RAW_TAG = /^<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?|!--[\s\S]*--)>$/;

// The parser hands a link's destination over as written; CommonMark reads its
// backslash escapes and character references.
const DESTINATION_ESCAPE =
  /\\([!-/:-@[-`{-~])|&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** A character reference as CommonMark reads it: the parser decodes it. */
const reference = (entity: string): string =>
  Bun.markdown.render(entity, {
    text: (t: string) => t,
    paragraph: (c: string) => c,
  });

/**
 * A link's target as CommonMark reads it. Percent-escapes are left as written:
 * they belong to the address, and which of them are delimiters is known only
 * once its path, query and fragment are told apart.
 */
const target = (destination: string): string =>
  destination.replaceAll(
    DESTINATION_ESCAPE,
    (m: string, escaped: string | undefined) => escaped ?? reference(m),
  );

/** Reads the parse into what a reader sees. */
class Reader {
  readonly out: Rendered = { tables: [], spans: [], links: [] };
  private table: Table | undefined;
  private row: Cell[] | undefined;
  private cell: Cell | undefined;
  private inHead = false;
  private rows = 0;

  visit(node: Node): void {
    const children = (): void => {
      for (const child of node.children) this.visit(child);
    };
    switch (node.kind) {
      case "text":
        this.text(node.text);
        break;
      case "codespan":
        this.codespan(node);
        break;
      case "code":
      case "html":
        break;
      case "link":
        this.link(node);
        children();
        break;
      case "table":
        this.table = { header: [], rows: [] };
        this.out.tables.push(this.table);
        children();
        this.table = undefined;
        break;
      case "thead":
        this.inHead = true;
        children();
        this.inHead = false;
        break;
      case "tr":
        this.startRow();
        children();
        this.endRow();
        break;
      case "th":
      case "td":
        this.startCell();
        children();
        this.endCell();
        break;
      default:
        children();
    }
  }

  private text(text: string): void {
    if (!this.cell || text.startsWith("<!--")) return;
    this.cell.prose += text;
    if (!RAW_TAG.test(text)) this.cell.text += text;
  }

  private codespan(node: Node): void {
    // CommonMark reads a line ending inside a code span as a space.
    const code = flat(node).replaceAll("\n", " ");
    const span = code.trim();
    this.out.spans.push(span);
    if (this.cell) {
      this.cell.spans.push(span);
      this.cell.text += code;
    }
  }

  private link(node: Node): void {
    const href = node.meta?.href;
    if (typeof href !== "string") return;
    this.out.links.push(target(href));
    this.cell?.links.push(target(href));
  }

  private startRow(): void {
    if (this.table) this.row = [];
  }

  private endRow(): void {
    if (!this.table || !this.row) return;
    if (this.inHead) this.table.header = this.row.map((c) => c.text);
    else this.table.rows.push({ index: this.rows++, cells: this.row });
    this.row = undefined;
  }

  private startCell(): void {
    if (this.row) this.cell = { text: "", prose: "", spans: [], links: [] };
  }

  private endCell(): void {
    if (!this.row || !this.cell) return;
    const { text, prose } = this.cell;
    this.row.push({ ...this.cell, text: text.trim(), prose: prose.trim() });
    this.cell = undefined;
  }
}

/** The text of a node and everything under it. */
const flat = (node: Node): string =>
  node.kind === "text" ? node.text : node.children.map(flat).join("");

/** The tables, code spans and links a reader sees in `markdown`. */
export function render(markdown: string): Rendered {
  const reader = new Reader();
  for (const node of parse(markdown)) reader.visit(node);
  return reader.out;
}

/** A part of the document no larger than this is searched line by line. */
const LEAF_LINES = 64;

/** How many blank lines a part tries before it is searched line by line. */
const SPLIT_TRIES = 4;

/**
 * The 1-based line of `markdown` on which each item that `items` lists
 * appears.
 *
 * Within a part of the document, the item at index `i` is on the line where
 * the part's beginnings start holding the same first `i + 1` items as the
 * whole part, and every longer beginning does too. A beginning can hold an
 * item the whole does not (a line that closes a code span merges what were
 * spans before it), so the beginnings are read from the longest down, not
 * searched; that costs a rendering per line, so it is done only on small
 * parts.
 *
 * A larger part is cut at a blank line near its middle when its two halves,
 * rendered apart, list exactly the items the part lists, in order; each half
 * is then a part of its own. Where no tried cut agrees (a fenced block or a
 * list running across them), the part is read line by line. An item names
 * what it is, never where: a row's index restarts in a half, so a row is
 * listed as the same value every time.
 */
export function linesOf<T>(
  markdown: string,
  items: (rendered: Rendered) => T[],
): number[] {
  const lines = markdown.split("\n");
  const keys = (from: number, to: number): string[] =>
    items(render(lines.slice(from, to).join("\n"))).map((item) =>
      JSON.stringify(item),
    );
  const found: number[] = [];
  const locate = (from: number, to: number, whole: string[]): void => {
    if (whole.length === 0) return;
    if (to - from > LEAF_LINES)
      for (const blank of blanks(lines, from, to)) {
        const before = keys(from, blank);
        const after = keys(blank + 1, to);
        const halves = [...before, ...after];
        if (
          halves.length === whole.length &&
          halves.every((key, i) => key === whole[i])
        ) {
          locate(from, blank, before);
          locate(blank + 1, to, after);
          return;
        }
      }
    found.push(...scan(keys, from, to, whole));
  };
  locate(0, lines.length, keys(0, lines.length));
  return found;
}

/** The blank lines strictly inside `[from, to)`, nearest its middle first, at most `SPLIT_TRIES`. */
function blanks(lines: string[], from: number, to: number): number[] {
  const middle = (from + to) / 2;
  const found: number[] = [];
  for (let at = from + 1; at < to - 1; at++)
    if (lines[at]?.trim() === "") found.push(at);
  return found
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))
    .slice(0, SPLIT_TRIES);
}

/** The line of each of a part's items, reading its beginnings from the longest down. */
function scan(
  keys: (from: number, to: number) => string[],
  from: number,
  to: number,
  whole: string[],
): number[] {
  const found = whole.map(() => to);
  let open = whole.length;
  for (let end = to - 1; end > from && open > 0; end--) {
    const part = keys(from, end);
    let same = 0;
    while (same < open && part[same] === whole[same]) same++;
    for (let i = 0; i < same; i++) found[i] = end;
    open = same;
  }
  return found;
}
