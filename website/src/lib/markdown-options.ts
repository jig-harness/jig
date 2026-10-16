/**
 * The Markdown options every page and fragment renders with, so a document
 * reads the same whether a page renders it whole or in parts.
 */
import { rehypeBlocks } from "./rehype-blocks.ts";
import { remarkRepoLinks } from "./remark-repo-links.ts";

export function markdownOptions(repoRoot: string) {
  return {
    // Shiki colors tokens with the --astro-code-* variables that
    // src/styles/global.css defines from the site's own palette, so the code
    // follows the light and dark theme without a second set of colors.
    syntaxHighlight: { type: "shiki" as const },
    shikiConfig: { theme: "css-variables" as const },
    remarkPlugins: [remarkRepoLinks({ repoRoot })],
    rehypePlugins: [rehypeBlocks],
  };
}
