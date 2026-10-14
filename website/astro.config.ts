import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { markdownOptions } from "./src/lib/markdown-options.ts";
import { SITE_ORIGIN } from "./src/lib/origin.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A static site: every page is rendered at build time from the repository's
// own documents, so a document change shows up on the next build.
export default defineConfig({
  site: SITE_ORIGIN,
  trailingSlash: "always",
  markdown: markdownOptions(repoRoot),
  // Pages read the repository's files at build time; bundling moves their
  // modules, so they get the repository root from here.
  vite: {
    define: { "import.meta.env.JIG_REPO_ROOT": JSON.stringify(repoRoot) },
  },
});
