import { expect, test } from "bun:test";
import { join } from "node:path";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { markdownOptions } from "./markdown-options.ts";

const repoRoot = join(import.meta.dir, "../../..");

async function render(source: string): Promise<string> {
  const processor = await createMarkdownProcessor(markdownOptions(repoRoot));
  return (await processor.render(source)).code;
}

test("a fenced block is highlighted with palette variables and labelled with its language", async () => {
  const html = await render("```typescript\nconst a = 1;\n```\n");
  expect(html).toContain("<figcaption><span>typescript</span>");
  expect(html).toContain("color:var(--astro-code-token-keyword)");
  expect(html).not.toMatch(/color:#[0-9a-f]{3,8}/i);
});

test("a fenced block without a language is labelled text", async () => {
  const html = await render("```\nplain words\n```\n");
  expect(html).toContain("<figcaption><span>text</span>");
});

test("every palette variable a diff block uses is defined in the stylesheet", async () => {
  const css = await Bun.file(
    join(import.meta.dir, "../styles/global.css"),
  ).text();
  const defined = new Set(css.match(/--astro-code-[a-z-]+(?=\s*:)/g));
  const html = await render("```diff\n- removed\n+ added\n! changed\n```\n");
  const used = new Set(html.match(/--astro-code-[a-z-]+/g));
  expect(used.has("--astro-code-token-inserted")).toBe(true);
  expect([...used].filter((name) => !defined.has(name))).toEqual([]);
});
