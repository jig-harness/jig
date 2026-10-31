/**
 * Markdown to and from ADF (Atlassian Document Format, the JSON tree Jira
 * Cloud keeps rich text in), for issue descriptions and comments: every
 * skill reads and writes Markdown, and Jira's REST API version 3 takes and
 * returns ADF only. This file writes ADF; `adf-markdown.ts` reads it.
 *
 * Written both ways: paragraphs, headings, bullet and ordered lists (nested),
 * fenced code with its language, blockquotes, rules, tables with plain
 * cells, hard breaks; strong, emphasis, strikethrough, inline code and
 * links. A line that is one HTML comment stays a paragraph of literal text,
 * so a marker Jig writes reads back as written. A Markdown body the
 * converter writes reads back unchanged.
 */

import { COMMENT_LINE, isWord, RULE } from "./adf-markdown.ts";

export { adfToMarkdown } from "./adf-markdown.ts";

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

// ── Blocks ─────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-+*]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (line: string | undefined) =>
  line === undefined || line.trim() === "";
const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

/** What one block reader took: its nodes and the line after it. */
type Parsed = { nodes: AdfNode[]; end: number };
type BlockReader = (lines: string[], at: number) => Parsed | null;

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && TABLE_RULE.test(next);
}

/** Does `line` start a block other than a paragraph? */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    [FENCE, HEADING, RULE, QUOTE, ITEM, COMMENT_LINE].some((re) =>
      re.test(line),
    ) || isTableStart(line, next)
  );
}

/** A table row's cells, split on unescaped pipes. */
function cellsOf(line: string): string[] {
  const s = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

const cell = (type: string, text: string): AdfNode => ({
  type,
  content: [{ type: "paragraph", content: inline(text) }],
});

const fenced: BlockReader = (lines, at) => {
  const m = FENCE.exec(lines[at] as string);
  if (m === null) return null;
  const fence = m[1] as string;
  const closes = (line: string) => {
    const c = FENCE_CLOSE.exec(line)?.[1];
    return c !== undefined && c[0] === fence[0] && c.length >= fence.length;
  };
  let end = at + 1;
  while (end < lines.length && !closes(lines[end] as string)) end++;
  const text = lines.slice(at + 1, end).join("\n");
  const node: AdfNode = { type: "codeBlock" };
  if (m[2] !== "") node.attrs = { language: m[2] };
  if (text !== "") node.content = [{ type: "text", text }];
  return { nodes: [node], end: end + 1 };
};

const heading: BlockReader = (lines, at) => {
  const m = HEADING.exec(lines[at] as string);
  if (m === null) return null;
  const level = (m[1] as string).length;
  return {
    nodes: [{ type: "heading", attrs: { level }, content: inline(m[2] ?? "") }],
    end: at + 1,
  };
};

const rule: BlockReader = (lines, at) =>
  RULE.test(lines[at] as string)
    ? { nodes: [{ type: "rule" }], end: at + 1 }
    : null;

const table: BlockReader = (lines, at) => {
  if (!isTableStart(lines[at] as string, lines[at + 1])) return null;
  const header = cellsOf(lines[at] as string);
  const rows: AdfNode[] = [
    { type: "tableRow", content: header.map((c) => cell("tableHeader", c)) },
  ];
  let end = at + 2;
  for (; !isBlank(lines[end]) && (lines[end] as string).includes("|"); end++) {
    const cells = cellsOf(lines[end] as string);
    rows.push({
      type: "tableRow",
      content: header.map((_, j) => cell("tableCell", cells[j] ?? "")),
    });
  }
  return { nodes: [{ type: "table", content: rows }], end };
};

const quote: BlockReader = (lines, at) => {
  const body: string[] = [];
  let end = at;
  for (let m = QUOTE.exec(lines[end] ?? ""); m !== null; ) {
    body.push(m[1] as string);
    m = QUOTE.exec(lines[++end] ?? "");
  }
  return body.length === 0
    ? null
    : { nodes: [{ type: "blockquote", content: blocks(body) }], end };
};

const comment: BlockReader = (lines, at) => {
  const line = lines[at] as string;
  return COMMENT_LINE.test(line)
    ? {
        nodes: [
          { type: "paragraph", content: [{ type: "text", text: line.trim() }] },
        ],
        end: at + 1,
      }
    : null;
};

/** Whether a blank line inside an item continues it: indented content follows. */
function continuesItem(lines: string[], at: number, indent: number): boolean {
  const after = lines.slice(at + 1).find((l) => !isBlank(l));
  return after !== undefined && indentOf(after) >= indent;
}

/** One list item's content lines, dedented, and where the item ends. */
function itemLines(
  lines: string[],
  at: number,
  indent: number,
): { body: string[]; end: number } {
  const body = [(ITEM.exec(lines[at] as string) as RegExpExecArray)[4] ?? ""];
  let end = at + 1;
  for (; end < lines.length; end++) {
    const line = lines[end] as string;
    if (isBlank(line) && continuesItem(lines, end, indent)) body.push("");
    else if (!isBlank(line) && indentOf(line) >= indent)
      body.push(line.slice(indent));
    else break;
  }
  return { body, end };
}

/** A list item's marker as `ITEM` reads it: indent, ordered, content indent. */
function markerOf(line: string | undefined) {
  const m = line === undefined ? null : ITEM.exec(line);
  if (m === null) return null;
  const indent = (m[1] as string).length;
  const spaces = (m[3] as string).length;
  return {
    indent,
    ordered: /\d/.test(m[2] as string),
    number: Number.parseInt(m[2] as string, 10),
    content:
      indent +
      (m[2] as string).length +
      (spaces > 4 || spaces === 0 ? 1 : spaces),
  };
}

type Marker = NonNullable<ReturnType<typeof markerOf>>;

/** The marker at `line` when it continues the list `first` opened. */
function sibling(line: string | undefined, first: Marker): Marker | null {
  const m = markerOf(line);
  const same = m?.indent === first.indent && m.ordered === first.ordered;
  return same ? m : null;
}

function listNode(first: Marker, items: AdfNode[]): AdfNode {
  if (!first.ordered) return { type: "bulletList", content: items };
  const node: AdfNode = { type: "orderedList", content: items };
  if (first.number !== 1) node.attrs = { order: first.number };
  return node;
}

const EMPTY_ITEM: AdfNode[] = [{ type: "paragraph", content: [] }];

const list: BlockReader = (lines, at) => {
  const first = markerOf(lines[at]);
  if (first === null || first.indent >= 4) return null;
  const items: AdfNode[] = [];
  let end = at;
  for (
    let m = sibling(lines[end], first);
    m !== null;
    m = sibling(lines[end], first)
  ) {
    const item = itemLines(lines, end, m.content);
    const content = blocks(item.body);
    items.push({
      type: "listItem",
      content: content.length > 0 ? content : EMPTY_ITEM,
    });
    end = item.end;
  }
  return { nodes: [listNode(first, items)], end };
};

/** Lines up to the next blank line or block, joined by hard breaks. */
const paragraph = (lines: string[], at: number): Parsed => {
  let end = at + 1;
  while (
    !isBlank(lines[end]) &&
    !startsBlock(lines[end] as string, lines[end + 1])
  )
    end++;
  const content = lines
    .slice(at, end)
    .flatMap((l, j): AdfNode[] => [
      ...(j > 0 ? [{ type: "hardBreak" }] : []),
      ...inline(l.trim()),
    ]);
  return { nodes: [{ type: "paragraph", content }], end };
};

const BLOCKS: BlockReader[] = [
  fenced,
  heading,
  rule,
  table,
  quote,
  list,
  comment,
];

/** The first reader's answer, trying each in turn. */
function firstRead<I, T>(
  readers: ReadonlyArray<(input: I, at: number) => T | null>,
  input: I,
  at: number,
): T | null {
  for (const read of readers) {
    const r = read(input, at);
    if (r !== null) return r;
  }
  return null;
}

function blocks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = [];
  let at = 0;
  while (at < lines.length) {
    if (isBlank(lines[at])) {
      at++;
      continue;
    }
    const parsed = firstRead(BLOCKS, lines, at) ?? paragraph(lines, at);
    out.push(...parsed.nodes);
    at = parsed.end;
  }
  return out;
}

// ── Inline ─────────────────────────────────────────────────────────────────

const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function withMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((n) =>
    n.type === "text" ? { ...n, marks: [...(n.marks ?? []), mark] } : n,
  );
}

/** The index after an escape or a code span at `i`; `i` when there is none. */
function skipAt(s: string, i: number): number {
  if (s[i] === "\\") return i + 2;
  if (s[i] !== "`") return i;
  const run = /^`+/.exec(s.slice(i))?.[0] as string;
  const end = s.indexOf(run, i + run.length);
  return end > 0 ? end + run.length : i + run.length;
}

/** Whether delimiter `d` at `i` closes a span opened just before `from`. */
function closesAt(
  s: string,
  i: number,
  from: number,
  d: string,
  single: boolean,
): boolean {
  if (i === from || !s.startsWith(d, i) || isSpace(s[i - 1])) return false;
  if (single && (s[i + 1] === d || s[i - 1] === d)) return false;
  return !(d === "_" && isWord(s[i + d.length]));
}

/** Where `d` closes after `from`, skipping escapes and code spans; -1 if nowhere. */
function closing(s: string, from: number, d: string, single = false): number {
  let i = from;
  while (i < s.length) {
    const next = skipAt(s, i);
    if (next !== i) i = next;
    else if (closesAt(s, i, from, d, single)) return i;
    else i++;
  }
  return -1;
}

/** What one inline reader took: its nodes and the index after it. */
type Span = { nodes: AdfNode[]; end: number };
type InlineReader = (s: string, i: number) => Span | null;

const escaped: InlineReader = (s, i) =>
  s[i] === "\\" && PUNCT.test(s[i + 1] ?? "")
    ? { nodes: [{ type: "text", text: s[i + 1] as string }], end: i + 2 }
    : null;

const code: InlineReader = (s, i) => {
  if (s[i] !== "`") return null;
  const run = /^`+/.exec(s.slice(i))?.[0] as string;
  const end = s.indexOf(run, i + run.length);
  if (end < 0 || s[end + run.length] === "`")
    return { nodes: [{ type: "text", text: run }], end: i + run.length };
  const raw = s.slice(i + run.length, end);
  const padded = run.length > 1 && /^ .* $/.test(raw) && raw.trim() !== "";
  const text = padded ? raw.slice(1, -1) : raw;
  return {
    nodes: [{ type: "text", text, marks: [{ type: "code" }] }],
    end: end + run.length,
  };
};

/** The index of the `]` matching the `[` at `at`, or -1. */
function bracketEnd(s: string, at: number): number {
  let depth = 0;
  for (let i = at; i < s.length; i = s[i] === "\\" ? i + 2 : i + 1) {
    if (s[i] === "[") depth++;
    if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

const link: InlineReader = (s, i) => {
  if (s[i] !== "[") return null;
  const end = bracketEnd(s, i);
  const href = end <= i + 1 ? null : /^\(([^()\s]+)\)/.exec(s.slice(end + 1));
  if (href === null) return null;
  return {
    nodes: withMark(inline(s.slice(i + 1, end)), {
      type: "link",
      attrs: { href: href[1] },
    }),
    end: end + 1 + href[0].length,
  };
};

const PAIRS: Record<string, string> = { "**": "strong", "~~": "strike" };

const pair: InlineReader = (s, i) => {
  const d = s.slice(i, i + 2);
  const type = PAIRS[d];
  if (type === undefined || isSpace(s[i + 2])) return null;
  const end = closing(s, i + 2, d);
  return end < 0
    ? null
    : { nodes: withMark(inline(s.slice(i + 2, end)), { type }), end: end + 2 };
};

const em: InlineReader = (s, i) => {
  const d = s[i] as string;
  const opens =
    (d === "*" || (d === "_" && !isWord(s[i - 1]))) &&
    s[i + 1] !== d &&
    !isSpace(s[i + 1]);
  const end = opens ? closing(s, i + 1, d, true) : -1;
  return end < 0
    ? null
    : {
        nodes: withMark(inline(s.slice(i + 1, end)), { type: "em" }),
        end: end + 1,
      };
};

const INLINES: InlineReader[] = [escaped, code, link, pair, em];

const sameMarks = (a: AdfNode, b: AdfNode) =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/** Adjacent text nodes with the same marks, joined. */
function merged(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const n of nodes) {
    const last = out.at(-1);
    if (last?.type === "text" && n.type === "text" && sameMarks(last, n))
      out[out.length - 1] = { ...last, text: `${last.text}${n.text}` };
    else out.push(n);
  }
  return out;
}

function inline(s: string): AdfNode[] {
  const out: AdfNode[] = [];
  let i = 0;
  while (i < s.length) {
    const span = firstRead(INLINES, s, i);
    if (span === null) {
      out.push({ type: "text", text: s[i] as string });
      i++;
    } else {
      out.push(...span.nodes);
      i = span.end;
    }
  }
  return merged(out);
}

/** A Markdown body as an ADF document; an empty body is one empty paragraph. */
export function markdownToAdf(markdown: string): AdfDoc {
  const content = blocks(markdown.replace(/\r\n?/g, "\n").split("\n"));
  return {
    type: "doc",
    version: 1,
    content:
      content.length > 0 ? content : [{ type: "paragraph", content: [] }],
  };
}
