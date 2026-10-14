/**
 * The Markdown options every page and fragment renders with, so a document
 * reads the same whether a page renders it whole or in parts.
 */
import { rehypeBlocks } from "./rehype-blocks.ts";
import { remarkRepoLinks } from "./remark-repo-links.ts";

export function markdownOptions(repoRoot: string) {
  return {
    syntaxHighlight: false as const,
    remarkPlugins: [remarkRepoLinks({ repoRoot })],
    rehypePlugins: [rehypeBlocks],
  };
}
