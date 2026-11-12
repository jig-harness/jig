/**
 * Verification is a list of proposed command lines, not instructions to run
 * them. Keep shell-sensitive text intact: remove only a Markdown list marker
 * and a code span wrapping a whole text line. Code lines keep their markers
 * and quotes. The scanner already identified fences and headings in the
 * context of the whole body; neither is a command.
 */
import { createHash } from "node:crypto";
import type { SpecEntry } from "./adapter.ts";
import type { MarkdownLine } from "./markdown.ts";

/** Drop the scanner's list prefix, counting tabs as the scanner does. */
function afterColumn(raw: string, column: number): string {
  let index = 0;
  for (let at = 0; at < column && index < raw.length; index++)
    at += raw[index] === "\t" ? 4 : 1;
  return raw.slice(index);
}

/** One command's text, or empty for Markdown structure and quoted text. */
function commandText(marked: MarkdownLine): string {
  if (
    marked.kind === "heading" ||
    marked.kind === "fence" ||
    marked.boundary ||
    marked.quoted
  )
    return "";
  const raw = marked.raw ?? marked.line;
  let text = afterColumn(raw, marked.contentColumn ?? 0).trim();
  if (marked.kind === "code") return text;
  if (marked.depth !== undefined) text = text.replace(/^\[[ xX]\]\s+/, "");
  return /^(`+)(.*)\1$/.exec(text)?.[2] ?? text;
}

/** A stable command id; repeated commands keep separate entries. */
function commandId(text: string, taken: Set<string>): string {
  const base = `verify-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
  taken.add(id);
  return id;
}

export function verificationCommands(
  lines: readonly MarkdownLine[],
): SpecEntry[] {
  const commands: SpecEntry[] = [];
  const taken = new Set<string>();
  for (const marked of lines) {
    const text = commandText(marked);
    if (text === "") continue;
    commands.push({ id: commandId(text, taken), text });
  }
  return commands;
}
