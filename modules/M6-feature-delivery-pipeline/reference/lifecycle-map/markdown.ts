// What a reader sees of a Markdown document, for the lifecycle map gate.
//
// The document is rendered by Bun's built-in CommonMark parser, with GitHub's
// tables, and the gate reads the HTML it produces rather than the source. So a
// fenced or indented block, an HTML comment, a code span, a backslash escape,
// a reference definition and a table row are each what CommonMark makes of
// them, and an example of one written inside another is not mistaken for it.
// The renderer escapes every `<`, `>`, `&` and `"` of the document's text, so
// in its output a `<` opens a tag (one the renderer wrote, or the document's
// own HTML) and an HTML comment is one the document really holds.
//
// The renderer reports no source positions. A finding's line is found instead
// by rendering ever longer beginnings of the document until the item it is
// about appears: the line locates a finding and never decides one.

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
  /** The inline code spans, outside code blocks, in document order. */
  spans: string[];
  /** The targets of every link, in document order. */
  links: string[];
}

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

/** Text the renderer escaped, as written. */
const unescapeHtml = (html: string): string =>
  html.replaceAll(
    /&(amp|lt|gt|quot);/g,
    (_m, name: string) => ENTITIES[name] ?? "",
  );

/** An attribute of a tag's attribute text. */
function attribute(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeHtml(m[1] ?? "") : undefined;
}

/** A link's target as the document wrote it: the renderer percent-encodes it. */
function target(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** Tags the reader keeps out of a cell's prose: it reads them itself. */
const STRUCTURE = new Set(["code", "td", "th"]);

/** Reads the renderer's HTML one token at a time into what a reader sees. */
class Reader {
  readonly out: Rendered = { tables: [], spans: [], links: [] };
  private table: Table | undefined;
  private row: Cell[] | undefined;
  private cell: Cell | undefined;
  private inHead = false;
  private pre = 0;
  private code: string | undefined;
  private rows = 0;

  text(token: string): void {
    const text = unescapeHtml(token);
    if (this.code !== undefined) this.code += text;
    else if (this.cell) {
      this.cell.text += text;
      this.cell.prose += text;
    }
  }

  tag(name: string, close: boolean, attrs: string, token: string): void {
    const handle = this.handlers[name];
    if (handle) handle(close, attrs);
    // A tag inside a cell stays in its prose, so an unfilled `<placeholder>`
    // the renderer took for HTML is still seen.
    if (this.cell && this.code === undefined && !close && !STRUCTURE.has(name))
      this.cell.prose += token;
  }

  private readonly handlers: Record<
    string,
    (close: boolean, attrs: string) => void
  > = {
    pre: (close) => {
      this.pre += close ? -1 : 1;
    },
    code: (close) => (close ? this.endCode() : this.startCode()),
    a: (close, attrs) => {
      const href = close ? undefined : attribute(attrs, "href");
      if (href === undefined) return;
      this.out.links.push(target(href));
      this.cell?.links.push(target(href));
    },
    table: (close) => {
      this.table = close ? undefined : { header: [], rows: [] };
      if (this.table) this.out.tables.push(this.table);
    },
    thead: (close) => {
      this.inHead = !close;
    },
    tr: (close) => (close ? this.endRow() : this.startRow()),
    td: (close) => this.cellTag(close),
    th: (close) => this.cellTag(close),
  };

  private startCode(): void {
    this.code = "";
  }

  private endCode(): void {
    if (this.code === undefined) return;
    const span = this.code.trim();
    if (this.pre === 0) this.out.spans.push(span);
    if (this.cell) {
      this.cell.spans.push(span);
      this.cell.text += this.code;
    }
    this.code = undefined;
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

  private cellTag(close: boolean): void {
    if (!this.row) return;
    if (!close) {
      this.cell = { text: "", prose: "", spans: [], links: [] };
      return;
    }
    if (!this.cell) return;
    const { text, prose } = this.cell;
    this.row.push({ ...this.cell, text: text.trim(), prose: prose.trim() });
    this.cell = undefined;
  }
}

/** The tables, code spans and links a reader sees in `markdown`. */
export function render(markdown: string): Rendered {
  const reader = new Reader();
  for (const [token, close, name, attrs = ""] of Bun.markdown
    .html(markdown)
    .matchAll(TOKEN)) {
    if (token.startsWith("<!--")) continue;
    if (name === undefined) reader.text(token);
    else reader.tag(name.toLowerCase(), close === "/", attrs, token);
  }
  return reader.out;
}

/**
 * The 1-based line of `markdown` on which the `n`th (0-based) item that
 * `count` counts appears: the shortest beginning of the document whose
 * rendering holds more than `n` of them.
 */
export function lineOf(
  markdown: string,
  count: (rendered: Rendered) => number,
  n: number,
): number {
  const lines = markdown.split("\n");
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (count(render(lines.slice(0, mid).join("\n"))) > n) high = mid;
    else low = mid + 1;
  }
  return low;
}
