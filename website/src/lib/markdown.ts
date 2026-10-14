/**
 * Renders a fragment of one of the repository's documents (a module's
 * invariant, a level's text, a table cell) to HTML, with the same plugins as
 * a whole page. `from` is the repository path of the document the fragment
 * comes from, so its relative links resolve as they do in the document.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMarkdownProcessor,
  type MarkdownRenderer,
} from "@astrojs/markdown-remark";
import { markdownOptions } from "./markdown-options.ts";
import { repoRoot } from "./site.ts";

let renderer: Promise<MarkdownRenderer> | undefined;

function processor(): Promise<MarkdownRenderer> {
  renderer ??= createMarkdownProcessor(markdownOptions(repoRoot));
  return renderer;
}

/** Block HTML: paragraphs, lists, tables, code. */
export async function md(source: string, from: string): Promise<string> {
  const fileURL = pathToFileURL(join(repoRoot, from));
  const { code } = await (await processor()).render(source, { fileURL });
  return code;
}

/** Inline HTML: one paragraph's content, without its `<p>`. */
export async function mdInline(source: string, from: string): Promise<string> {
  const html = await md(source.replace(/\s*\n\s*/g, " ").trim(), from);
  return html.replace(/^<p>([\s\S]*)<\/p>\s*$/, "$1");
}
