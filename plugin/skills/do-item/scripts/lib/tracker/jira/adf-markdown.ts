/**
 * ADF to Markdown (see `adf.ts`). What `adf.ts` writes reads back as it was
 * written; text is escaped where the Markdown reader would take it for
 * syntax.
 *
 * Read only, to plain Markdown: mentions, emoji, inline cards, status
 * lozenges, dates, media, panels, expands, task lists and decision lists.
 * An unknown node yields its text; an unknown mark is dropped.
 */

import type { AdfMark, AdfNode } from "./adf.ts";

export const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
export const COMMENT_LINE = /^\s*<!--[\s\S]*-->\s*$/;
export const isWord = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The marks written, outermost first; any other mark is dropped. */
const MARK_ORDER = ["link", "strong", "em", "strike", "code"];

const OPEN: Record<string, string> = {
  link: "[",
  strong: "**",
  em: "*",
  strike: "~~",
};

const close = (m: AdfMark) =>
  m.type === "link"
    ? `](${String(m.attrs?.href ?? "")})`
    : (OPEN[m.type] ?? "");

const sameMark = (a: AdfMark, b: AdfMark) =>
  a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Text escaped so the inline reader takes it as text. */
function escapeText(text: string, inTable: boolean): string {
  return [...text]
    .map((c, i, all) => {
      if ("\\`*[]~".includes(c) || (inTable && c === "|")) return `\\${c}`;
      const inWord = isWord(all[i - 1]) && isWord(all[i + 1]);
      return c === "_" && !inWord ? "\\_" : c;
    })
    .join("");
}

/** `text` as a code span: a fence longer than any backtick run inside it. */
function codeSpan(text: string): string {
  let fence = "`";
  while (text.includes(fence)) fence = `${fence}\``;
  return fence.length === 1 ? `\`${text}\`` : `${fence} ${text} ${fence}`;
}

const ATOMS: Record<string, (a: Record<string, unknown>) => string> = {
  mention: (a) => str(a.text) || `@${str(a.id)}`,
  emoji: (a) => str(a.text) || str(a.shortName),
  inlineCard: (a) => str(a.url),
  blockCard: (a) => str(a.url),
  embedCard: (a) => str(a.url),
  status: (a) => str(a.text),
  date: (a) => {
    const ms = Number(a.timestamp);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
  },
};

/** The text of a node with no content of its own; `null` for others. */
function atomText(node: AdfNode): string | null {
  const atom = Object.hasOwn(ATOMS, node.type) ? ATOMS[node.type] : undefined;
  return atom === undefined ? null : atom(node.attrs ?? {});
}

/** The plain text of a node, for a node with no Markdown form. */
function plainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return atomText(node) ?? (node.content ?? []).map(plainText).join("");
}

/** The marks of a node the writer knows. */
const marksOf = (node: AdfNode) =>
  node.type === "text"
    ? (node.marks ?? []).filter((m) => MARK_ORDER.includes(m.type))
    : [];

/** Inline nodes as Markdown, marks opened and closed around runs. */
function inlineMarkdown(nodes: AdfNode[], inTable = false): string {
  let out = "";
  const open: AdfMark[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) out += close(open.pop() as AdfMark);
  };
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      closeTo(0);
      out += inTable ? " " : "\n";
      continue;
    }
    const marks = marksOf(node);
    // Keep the open marks this node also carries, then open the rest.
    const keep = open.findIndex((o) => !marks.some((m) => sameMark(m, o)));
    closeTo(keep < 0 ? open.length : keep);
    const opening = marks
      .filter((m) => m.type !== "code" && !open.some((o) => sameMark(o, m)))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    for (const m of opening) {
      out += OPEN[m.type];
      open.push(m);
    }
    const text = plainText(node);
    out += marks.some((m) => m.type === "code")
      ? codeSpan(text)
      : escapeText(text, inTable);
  }
  closeTo(0);
  return out;
}

/** Escape a paragraph line the block reader would take for a block. */
function guardLine(raw: string): string {
  const line = raw.trimStart();
  if (COMMENT_LINE.test(line)) return line;
  if (/^(#{1,6}(\s|$)|>|[-+](\s|$)|\|)/.test(line) || RULE.test(line))
    return `\\${line}`;
  return line.replace(/^(\d{1,9})([.)])(\s|$)/, "$1\\$2$3");
}

function paragraphMarkdown(node: AdfNode): string {
  const content = node.content ?? [];
  const only = content[0];
  // A marker line Jig wrote reads back verbatim.
  const marker =
    content.length === 1 &&
    only?.type === "text" &&
    (only.marks ?? []).length === 0 &&
    COMMENT_LINE.test(only.text ?? "");
  if (marker) return only.text as string;
  return inlineMarkdown(content).split("\n").map(guardLine).join("\n");
}

const isList = (n: AdfNode) =>
  ["bulletList", "orderedList", "taskList", "decisionList"].includes(n.type);

function itemMarkdown(node: AdfNode, marker: string): string {
  const pad = " ".repeat(marker.length);
  const body = (node.content ?? [])
    .map((child, i) => {
      const gap = i === 0 ? "" : isList(child) ? "\n" : "\n\n";
      return `${gap}${blockMarkdown(child)}`;
    })
    .join("");
  const indented = body
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : `${pad}${l}`))
    .join("\n");
  return `${marker}${indented}`;
}

function cellMarkdown(c: AdfNode): string {
  return (c.content ?? [])
    .map((b) =>
      b.type === "paragraph"
        ? inlineMarkdown(b.content ?? [], true)
        : plainText(b),
    )
    .join(" ");
}

function tableMarkdown(node: AdfNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map(cellMarkdown),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [
    line(rows[0] as string[]),
    line(Array.from({ length: width }, () => "---")),
    ...rows.slice(1).map(line),
  ].join("\n");
}

function blocksMarkdown(nodes: AdfNode[]): string {
  return nodes
    .map(blockMarkdown)
    .filter((b) => b !== "")
    .join("\n\n");
}

const quoted = (node: AdfNode) =>
  blocksMarkdown(node.content ?? [])
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");

const media = (m: AdfNode) => `[${str(m.attrs?.alt) || "attachment"}]`;

const BLOCKS: Record<string, (node: AdfNode) => string> = {
  paragraph: paragraphMarkdown,
  heading: (node) => {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
    return `${"#".repeat(level)} ${inlineMarkdown(node.content ?? [])}`.trimEnd();
  },
  bulletList: (node) =>
    (node.content ?? []).map((item) => itemMarkdown(item, "- ")).join("\n"),
  orderedList: (node) => {
    const start = Number(node.attrs?.order ?? 1) || 1;
    return (node.content ?? [])
      .map((item, i) => itemMarkdown(item, `${start + i}. `))
      .join("\n");
  },
  codeBlock: (node) => {
    const text = (node.content ?? []).map((c) => c.text ?? "").join("");
    const longest = Math.max(
      0,
      ...(text.match(/`+/g) ?? []).map((r) => r.length),
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    const body = text === "" ? "" : `${text}\n`;
    return `${fence}${str(node.attrs?.language)}\n${body}${fence}`;
  },
  blockquote: quoted,
  panel: quoted,
  rule: () => "---",
  table: tableMarkdown,
  expand: (node) => {
    const title = str(node.attrs?.title);
    const body = blocksMarkdown(node.content ?? []);
    return title === "" ? body : `**${escapeText(title, false)}**\n\n${body}`;
  },
  taskList: (node) =>
    (node.content ?? [])
      .map((item) => {
        const done = item.attrs?.state === "DONE" ? "x" : " ";
        return `- [${done}] ${inlineMarkdown(item.content ?? [])}`;
      })
      .join("\n"),
  decisionList: (node) =>
    (node.content ?? [])
      .map((item) => `- ${inlineMarkdown(item.content ?? [])}`)
      .join("\n"),
  mediaSingle: (node) => (node.content ?? []).map(media).join(" "),
  mediaGroup: (node) => (node.content ?? []).map(media).join(" "),
  media,
};
BLOCKS.nestedExpand = BLOCKS.expand as (node: AdfNode) => string;

/** A node with no Markdown form: its blocks, else its inline text. */
function unknownMarkdown(node: AdfNode): string {
  const atom = atomText(node);
  if (atom !== null) return atom;
  const content = node.content ?? [];
  const inlineOnly = content.every(
    (c) => c.type === "text" || c.type === "hardBreak" || atomText(c) !== null,
  );
  return inlineOnly ? inlineMarkdown(content) : blocksMarkdown(content);
}

function blockMarkdown(node: AdfNode): string {
  const render = Object.hasOwn(BLOCKS, node.type)
    ? BLOCKS[node.type]
    : undefined;
  return render === undefined ? unknownMarkdown(node) : render(node);
}

/** An ADF document as Markdown; anything that is not a document reads as empty. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (doc === null || typeof doc !== "object") return "";
  const node = doc as AdfNode;
  return blocksMarkdown(node.type === "doc" ? (node.content ?? []) : [node]);
}
