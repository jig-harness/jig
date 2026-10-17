/**
 * A generator banner (`@generated`, "DO NOT EDIT", Go's `Code generated …
 * DO NOT EDIT.`) in a file's leading comment header marks it generated. Prose
 * that merely mentions generation ("# Generated files", "auto-generated
 * IDs") does not, and neither does the phrase in code or in a later comment.
 * A banner states the marker: quoted in backticks or double quotes it is
 * being discussed, and `@generated` counts only as a tag opening a comment
 * line or as "is/was @generated".
 */
import { commentStyle, DOC_EXTENSIONS } from "./languages.ts";

const GENERATED_TAG = /(^|\n)[\s*!]*@generated\b|\b(is|was|been) @generated\b/i;
const DO_NOT_EDIT = /\bdo not edit\b/i;
const QUOTED = /`[^`]*`|"[^"\n]*"/g;
// Markdown `#` is a heading and `*` a bullet, so docs (and HTML-style
// sources) only take HTML/MDX comments.
const CODE_LINE_COMMENTS = ["//", "#", "--"];
const CODE_BLOCK_COMMENTS: [string, string][] = [["/*", "*/"]];
const MARKUP_BLOCK_COMMENTS: [string, string][] = [
  ["<!--", "-->"],
  ["{/*", "*/}"],
];
// Markup declarations that may precede the header comment.
const MARKUP_PROLOGUE = /^(<\?xml\b[\s\S]*?\?>|<!doctype\b[^>]*>)/i;
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/;

/** How many leading characters the banner check reads. */
export const HEAD_CHARS = 512;

interface Syntax {
  line: string[];
  block: [string, string][];
  markup: boolean;
}

/** `s` after its YAML frontmatter, or null when the frontmatter never closes. */
function afterFrontmatter(s: string): string | null {
  if (!/^---[ \t]*\r?\n/.test(s)) return s;
  const fm = FRONTMATTER.exec(s);
  return fm ? s.slice(fm[0].length) : null;
}

/**
 * Read the comment that starts at `i` into `parts`; the index after it (the
 * end of `s` when it never closes), or null when no comment starts there.
 */
function readComment(
  s: string,
  i: number,
  syntax: Syntax,
  parts: string[],
): number | null {
  const block = syntax.block.find(([open]) => s.startsWith(open, i));
  if (block) {
    const start = i + block[0].length;
    const end = s.indexOf(block[1], start);
    parts.push(s.slice(start, end === -1 ? s.length : end));
    return end === -1 ? s.length : end + block[1].length;
  }
  const line = syntax.line.find((open) => s.startsWith(open, i));
  if (!line) return null;
  const end = s.indexOf("\n", i);
  parts.push(s.slice(i + line.length, end === -1 ? s.length : end));
  return end === -1 ? s.length : end + 1;
}

/** The index after a markup declaration at `i`, or null. */
function afterPrologue(s: string, i: number, syntax: Syntax): number | null {
  const prologue = syntax.markup ? MARKUP_PROLOGUE.exec(s.slice(i)) : null;
  return prologue ? i + prologue[0].length : null;
}

/** The comments an extension's header may hold: docs and markup take only markup comments. */
function syntaxOf(ext: string): Syntax {
  const markup = DOC_EXTENSIONS.has(ext) || commentStyle(ext) === "html";
  return markup
    ? { line: [], block: MARKUP_BLOCK_COMMENTS, markup }
    : { line: CODE_LINE_COMMENTS, block: CODE_BLOCK_COMMENTS, markup };
}

/**
 * The text inside the comments that open `head`, read token by token: it
 * stops at the first character that is not whitespace, a comment, or (for
 * markup) an XML/doctype declaration, so code after a closing delimiter on
 * the same line ends the header. Docs skip YAML frontmatter first.
 */
export function leadingCommentText(head: string, ext: string): string {
  const syntax = syntaxOf(ext);
  const start = head.slice(0, HEAD_CHARS).replace(/^\uFEFF/, "");
  const s = DOC_EXTENSIONS.has(ext) ? afterFrontmatter(start) : start;
  if (s === null) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i] as string)) {
      i++;
      continue;
    }
    const next =
      readComment(s, i, syntax, parts) ?? afterPrologue(s, i, syntax);
    if (next === null) break;
    i = next;
  }
  return parts.join("\n");
}

/** Whether `head` opens with a generator banner. */
export function hasGeneratorBanner(head: string, ext: string): boolean {
  const stated = leadingCommentText(head, ext).replace(QUOTED, "");
  return GENERATED_TAG.test(stated) || DO_NOT_EDIT.test(stated);
}
