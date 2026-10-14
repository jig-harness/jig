import { expect, test } from "bun:test";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { remarkRepoLinks } from "./remark-repo-links.ts";

const repoRoot = join(import.meta.dir, "../../..");

test("a reference-style link to the glossary is a term, resolved by its own text", () => {
  const tree = fromMarkdown(
    "[Drift][g] and [Refocus][g].\n\n[g]: GLOSSARY.md\n",
  );
  remarkRepoLinks({ repoRoot })()(tree as never, {
    path: join(repoRoot, "README.md"),
  });
  const links: { url?: string; data?: unknown }[] = [];
  const visit = (n: { type: string; children?: unknown[] }) => {
    if (n.type === "link") links.push(n as never);
    for (const c of n.children ?? []) visit(c as never);
  };
  visit(tree as never);
  expect(links.map((l) => l.url)).toEqual([
    "/glossary/#drift",
    "/glossary/#refocus",
  ]);
  expect(links[0]?.data).toEqual({
    hProperties: { className: ["term"], "data-term": "drift" },
  });
});
