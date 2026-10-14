/**
 * Slicing the repository's Markdown into the parts a page lays out: its
 * level-two sections, its paragraphs, a table's rows, a list's top-level
 * items. The parts stay Markdown; a page renders each with `md()`.
 */
import { fromMarkdown } from "mdast-util-from-markdown";

export interface Section {
  title: string;
  body: string;
}

/**
 * A document's sections at one heading level, level two unless `level` says
 * otherwise; the text before the first one comes first, with an empty title.
 * A section starts at a top-level `#` heading as a CommonMark parser reads
 * it, so heading-shaped text in code, an HTML block or comment, a list or a
 * quote stays part of the section around it, and so does leading front
 * matter. An underlined (setext) heading does not start one: a closing `---`
 * would make it one. The title is the heading's Markdown.
 */
export function sections(markdown: string, level = 2): Section[] {
  const out: Section[] = [];
  let title = "";
  let from = 0;
  for (const node of fromMarkdown(withoutFrontMatter(markdown)).children) {
    if (node.type !== "heading" || node.depth !== level) continue;
    const { start, end } = node.position ?? {};
    if (start?.offset === undefined || end?.offset === undefined) continue;
    if (!markdown.startsWith("#", start.offset)) continue;
    out.push({ title, body: markdown.slice(from, start.offset) });
    const first = node.children[0]?.position?.start.offset;
    const last = node.children.at(-1)?.position?.end.offset;
    title =
      first === undefined || last === undefined
        ? ""
        : markdown.slice(first, last);
    from = end.offset;
  }
  out.push({ title, body: markdown.slice(from) });
  return out.map((s) => ({ title: s.title.trim(), body: s.body.trim() }));
}

/**
 * The document with a leading front-matter block blanked out: each of its
 * characters but line breaks becomes a space, so the parser reads blank
 * lines and every offset still points into the original text.
 */
function withoutFrontMatter(markdown: string): string {
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown)?.[0];
  return fm
    ? fm.replace(/[^\r\n]/g, " ") + markdown.slice(fm.length)
    : markdown;
}

/** The section whose title starts with `prefix`, or an empty body. */
export function section(all: Section[], prefix: string): string {
  return all.find((s) => s.title.startsWith(prefix))?.body ?? "";
}

/** The document without its level-one title line. */
export function withoutTitle(markdown: string): string {
  return markdown.replace(/^\s*# .+\n/, "");
}

/** The level-one title, without Markdown marks. */
export function titleLine(markdown: string): string {
  return (/^# (.+)$/m.exec(markdown)?.[1] ?? "").replace(/[`*_]/g, "").trim();
}

interface Block {
  /** The parser's node type: `paragraph`, `code`, `list`, `table`… */
  kind: string;
  text: string;
}

/**
 * The document's top-level blocks as a CommonMark parser reads them, each
 * with its node type. Every block is its source text from the start of its
 * first line; code keeps its indentation, which in an indented code block is
 * what makes it code, and every other block is trimmed.
 */
function parsedBlocks(markdown: string): Block[] {
  const root = fromMarkdown(markdown);
  return root.children.flatMap((node) => {
    const { start, end } = node.position ?? {};
    if (start?.offset === undefined || end?.offset === undefined) return [];
    const from = markdown.lastIndexOf("\n", start.offset - 1) + 1;
    const raw = markdown.slice(from, end.offset);
    const text = node.type === "code" ? raw.trimEnd() : raw.trim();
    return text ? [{ kind: node.type, text }] : [];
  });
}

/** The document's top-level blocks: paragraphs, lists, tables, code, quotes. */
export function blocks(markdown: string): string[] {
  return parsedBlocks(markdown).map((b) => b.text);
}

const isTableLine = (line: string) => line.trimStart().startsWith("|");

/**
 * Paragraph blocks only: no lists, tables, headings, quotes, code or HTML.
 * The parser reads Markdown without table syntax, so a table is a paragraph
 * to it and is told apart by its leading `|`.
 */
export function paragraphs(markdown: string): string[] {
  return parsedBlocks(markdown)
    .filter((b) => b.kind === "paragraph" && !isTableLine(b.text))
    .map((b) => b.text);
}

/** The first paragraph, on one line. */
export function firstParagraph(markdown: string): string {
  return (paragraphs(markdown)[0] ?? "").replace(/\s*\n\s*/g, " ");
}

/** A table's body rows as cells (Markdown), header and divider dropped. */
export function tableRows(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .filter(isTableLine)
    .filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  return rows.slice(1);
}

export interface ListItem {
  /** The marker's number for an ordered item, else 0. */
  n: number;
  /** The item's first paragraph, on one line. */
  text: string;
  /** The item's whole content, its continuation lines dedented. */
  body: string;
}

/** The top-level items of the first list in `markdown`. */
export function listItems(markdown: string): ListItem[] {
  const items: { n: number; lines: string[] }[] = [];
  let started = false;
  for (const line of markdown.split("\n")) {
    const m = /^(?:[-*]|(\d+)\.)\s+(.*)$/.exec(line);
    if (m) {
      started = true;
      items.push({ n: Number(m[1] ?? 0), lines: [m[2] ?? ""] });
    } else if (started && (/^\s+\S/.test(line) || !line.trim())) {
      items[items.length - 1]?.lines.push(line);
    } else if (started) break;
  }
  return items.map(({ n, lines }) => {
    const indent = Math.min(
      ...lines
        .slice(1)
        .filter((l) => l.trim())
        .map((l) => /^ */.exec(l)?.[0].length ?? 0),
    );
    const cut = Number.isFinite(indent) ? indent : 0;
    const body = [lines[0], ...lines.slice(1).map((l) => l.slice(cut))]
      .join("\n")
      .trim();
    return { n, text: firstParagraph(body) || body, body };
  });
}

/** The bold lead an item opens with (`**Audit** — run …` -> `Audit`). */
export function leadOf(text: string): string {
  const lead = /^\*\*(.+?)\*\*/.exec(text)?.[1] ?? "";
  return lead.replace(/[`*]/g, "").replace(/[.:]$/, "");
}

/** Module ids a text names (`M0`, `M12`), each once, in order. */
export function moduleIds(text: string): string[] {
  return [...new Set(text.match(/\bM\d+\b/g) ?? [])];
}
