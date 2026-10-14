import { expect, test } from "bun:test";
import { blocks, paragraphs, sections } from "./source.ts";

const fence = (open: string, close: string) =>
  `intro\n\n${open}\n## Not a heading\n\n${"```"}\ninner\n${"```"}\n${close}\n\n## Real\n\nbody\n`;

test("a heading inside any fenced block is code", () => {
  for (const [open, close] of [
    ["```", "```"],
    ["~~~markdown", "~~~"],
    ["````", "````"],
  ] as const) {
    const titles = sections(fence(open, close)).map((s) => s.title);
    expect(titles, open).toEqual(["", "Real"]);
  }
});

test("a shorter or different fence does not close the block", () => {
  const md = "````\n```\n\n## Inside\n````\n\n## After\n";
  expect(sections(md).map((s) => s.title)).toEqual(["", "After"]);
  expect(blocks("~~~\na\n\nb\n~~~")).toEqual(["~~~\na\n\nb\n~~~"]);
});

test("paragraphs leave out tilde code blocks too", () => {
  expect(paragraphs("text\n\n~~~\ncode\n~~~")).toEqual(["text"]);
});

test("a fence indented four spaces outside a list is indented code", () => {
  const md = "Text\n\n    ```\n\n## Real\n\nBody\n";
  expect(sections(md).map((s) => s.title)).toEqual(["", "Real"]);
  const listed = "- item\n\n    ```\n    ## code\n    ```\n\n## Real\n";
  expect(sections(listed).map((s) => s.title)).toEqual(["", "Real"]);
});

test("a closing fence indented four spaces does not close the block", () => {
  const md = "~~~\n    ~~~\n## Inside\n~~~\n## After\n";
  expect(sections(md).map((s) => s.title)).toEqual(["", "After"]);
});

test("a heading inside an HTML comment or block is part of it", () => {
  const md =
    "intro\n\n<!--\n## Internal note\nPrivate drafting text\n-->\n\n" +
    "<details>\n## Folded\n</details>\n\n## Real\n\nbody\n";
  const all = sections(md);
  expect(all.map((s) => s.title)).toEqual(["", "Real"]);
  expect(all[0]?.body).toContain("## Internal note");
  expect(
    sections("<!--\n### Note\n-->\n\n### Real\n", 3).map((s) => s.title),
  ).toEqual(["", "Real"]);
});

test("front matter and underlined headings do not start a section", () => {
  const md =
    "---\ntype: prd\ndescription: |\n  ## In YAML\n---\n\n# Title\n\n## Real\n\nbody\n";
  const all = sections(md);
  expect(all.map((s) => s.title)).toEqual(["", "Real"]);
  expect(all[1]?.body).toBe("body");
  expect(sections("Text\n---\n\n## Real\n").map((s) => s.title)).toEqual([
    "",
    "Real",
  ]);
});

test("a section title keeps its Markdown and drops a closing sequence", () => {
  expect(
    sections("## The `jig` plugin ##\n\nbody").map((s) => s.title),
  ).toEqual(["", "The `jig` plugin"]);
});

test("an unclosed fence ends with the list item that holds it", () => {
  const md = "- example\n\n    ~~~\n    code\n\n## Invariant\n\nActual rule\n";
  const all = sections(md);
  expect(all.map((s) => s.title)).toEqual(["", "Invariant"]);
  expect(all[1]?.body).toBe("Actual rule");
});

test("an indented code block keeps the indentation that makes it code", () => {
  expect(blocks("    alpha\n\n    beta")).toEqual(["    alpha\n\n    beta"]);
  expect(paragraphs("Text\n\n    alpha\n\n    beta")).toEqual(["Text"]);
});

test("a paragraph inside a list item is part of the list, not a paragraph", () => {
  const md = "Lead\n\n1. item\n\n   continued inside the item\n\n2. next";
  expect(paragraphs(md)).toEqual(["Lead"]);
  expect(blocks(md)).toHaveLength(2);
});

test("a table and HTML are blocks but not paragraphs", () => {
  const md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- note -->\n\nProse";
  expect(blocks(md)).toHaveLength(3);
  expect(paragraphs(md)).toEqual(["Prose"]);
});
