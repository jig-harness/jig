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
  let text = afterColumn(raw, marked.contentColumn ?? 0).trimStart();
  if (marked.kind === "code") return text;
  if (marked.depth !== undefined) text = text.replace(/^\[[ xX]\]\s+/, "");
  text = text.trimEnd();
  const opening = /^`+/.exec(text)?.[0];
  const closing = /`+$/.exec(text)?.[0];
  if (
    opening !== undefined &&
    opening === closing &&
    text.length > opening.length + closing.length
  ) {
    const inside = text.slice(opening.length, -closing.length);
    // Only a maximal run of exactly the opening length closes a span.
    const runs = inside.match(/`+/g) ?? [];
    if (!runs.some((run) => run.length === opening.length)) return inside;
  }
  return text;
}

/** A stable command id; repeated commands keep separate entries. */
function commandId(
  text: string,
  taken: Set<string>,
  nextSuffix: Map<string, number>,
): string {
  const base = `verify-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
  let id = base;
  for (let n = nextSuffix.get(base) ?? 2; taken.has(id); n++) {
    id = `${base}~${n}`;
    nextSuffix.set(base, n + 1);
  }
  taken.add(id);
  nextSuffix.set(base, nextSuffix.get(base) ?? 2);
  return id;
}

export function verificationCommands(
  lines: readonly MarkdownLine[],
): SpecEntry[] {
  const commands: SpecEntry[] = [];
  const taken = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const marked of lines) {
    const text = commandText(marked);
    if (text === "") continue;
    commands.push({ id: commandId(text, taken, nextSuffix), text });
  }
  return commands;
}
