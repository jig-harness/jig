import { expect, test } from "bun:test";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { PAGE_NAMES, remarkRepoLinks } from "./remark-repo-links.ts";
import { FIXED } from "./routes.ts";

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

test("every fixed page has the name a link to it by file name reads as", () => {
  const unnamed = Object.values(FIXED).filter((route) => !PAGE_NAMES[route]);
  expect(unnamed).toEqual([]);
  const tree = fromMarkdown("[FEATURES.md](../FEATURES.md)\n");
  remarkRepoLinks({ repoRoot })()(tree as never, {
    path: join(repoRoot, "changes/x.md"),
  });
  const para = (tree as { children: { children: unknown[] }[] }).children[0];
  expect(para?.children[0]).toMatchObject({
    type: "link",
    url: "/features/",
    children: [{ type: "text", value: "What you get" }],
  });
});

test("a link to a module opens what it solves; a bare id reads as an id", () => {
  const tree = fromMarkdown(
    "[M7](modules/M7-pr-lifecycle-review/README.md), [the review loop](modules/M7-pr-lifecycle-review/README.md) and [M9](modules/M9-tasks-memory/README.md#work-item-rules).\n",
  );
  remarkRepoLinks({ repoRoot })()(tree as never, {
    path: join(repoRoot, "README.md"),
  });
  const para = (
    tree as {
      children: {
        children: {
          url?: string;
          data?: { hProperties: Record<string, unknown> };
        }[];
      }[];
    }
  ).children[0];
  const [bare, , named, , fragment] = para?.children ?? [];
  const m7 = {
    "data-tip-head": "M7 · PR lifecycle & review",
    "data-tip-kind": "Practice module",
    "data-tip-body": expect.stringMatching(
      /^Two things go wrong without a codified review process\./,
    ),
    "data-tip-more": "Open the module →",
  };
  expect(bare?.data?.hProperties).toEqual({
    className: ["module-ref"],
    ...m7,
  });
  expect(named?.data?.hProperties).toEqual({
    className: ["module-link"],
    ...m7,
  });
  expect(fragment?.url).toBe("/modules/M9/#work-item-rules");
  expect(fragment?.data?.hProperties).toMatchObject({
    className: ["module-ref"],
    "data-tip-head": expect.stringMatching(/^M9 · /),
  });
});
