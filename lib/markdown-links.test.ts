import { expect, test } from "bun:test";
import { decode, markdownLinks } from "./markdown-links.ts";

test("inline, angle-bracketed and reference destinations are read without titles", () => {
  const content = [
    '[a](a.md "Title") ![i](img/i.png) [b](<b c.md>) [p](x(1).md)',
    "[e](e\\_f.md) [r][ref] [g][ang]",
    "",
    "[ref]: ref.md 'Ref'",
    "   [ang]: <ang le.md>",
    "[unused]: unused.md",
    "[^note]: a footnote, not a link",
  ].join("\n");
  expect(markdownLinks(content)).toEqual([
    { target: "a.md", line: 1 },
    { target: "img/i.png", line: 1 },
    { target: "b c.md", line: 1 },
    { target: "x(1).md", line: 1 },
    { target: "e_f.md", line: 2 },
    { target: "ref.md", line: 4 },
    { target: "ang le.md", line: 5 },
  ]);
});

test("code spans and fenced code declare no link", () => {
  const content = [
    "`[a](a.md)` ``[b](`b`.md)``",
    "````md",
    "```",
    "[c](c.md)",
    "````",
    "~~~",
    "[d]: d.md",
    "~~~",
    "[e](e.md)",
    "",
    "~~~\r\n[f](f.md)\r\n~~~\r\n",
  ].join("\n");
  expect(markdownLinks(content)).toEqual([{ target: "e.md", line: 9 }]);
});

test("backticks that open no code span leave the link in them a link", () => {
  for (const content of [
    "`` [bad](../missing.md) `",
    "\\` [bad](../missing.md) `",
    "`first\n# Heading\n[bad](../missing.md)\n`last",
  ])
    expect(markdownLinks(content).map((link) => link.target)).toEqual([
      "../missing.md",
    ]);
});

test("a destination on its own line, and definitions in containers or over lines, are read", () => {
  expect(markdownLinks("[bad](\n../missing.md\n)")).toEqual([
    { target: "../missing.md", line: 2 },
  ]);
  expect(markdownLinks("[ref]:\n  ../missing.md\n\n[bad][ref]")).toEqual([
    { target: "../missing.md", line: 2 },
  ]);
  expect(markdownLinks("> [ref]: ../missing.md\n>\n> [bad][ref]")).toEqual([
    { target: "../missing.md", line: 1 },
  ]);
  expect(markdownLinks("- item\n\n  [ref]: in-list.md\n\n  [x][ref]")).toEqual([
    { target: "in-list.md", line: 3 },
  ]);
});

test("escapes, character references and Unicode spaces are read as the renderer reads them", () => {
  const targets = (content: string) =>
    markdownLinks(content).map((link) => link.target);
  expect(targets("[x](<a\\>b.md>)")).toEqual(["a>b.md"]);
  expect(targets("[x](README.md missing.md)")).toEqual([
    "README.md missing.md",
  ]);
  expect(targets("[x](README&#46;md) [y](a&amp;b.md) [z](&ouml;.md)")).toEqual([
    "README.md",
    "a&b.md",
    "ö.md",
  ]);
  expect(targets("[x](\\&amp;.md) [y](&bogus;.md)")).toEqual([
    "&amp;.md",
    "&bogus;.md",
  ]);
});

test("text that only looks like a link declares none", () => {
  expect(markdownLinks("\\[x](missing.md)")).toEqual([]);
  expect(markdownLinks("](missing.md)")).toEqual([]);
  expect(markdownLinks("[x](a.md b.md)")).toEqual([]);
  expect(markdownLinks("    [indented](code.md)")).toEqual([]);
});

test("autolinks are read with their scheme", () => {
  expect(
    markdownLinks("<https://example.com/a> <someone@example.com>").map(
      (link) => link.target,
    ),
  ).toEqual(["https://example.com/a", "mailto:someone@example.com"]);
});

test("a destination written like an email is mailto only where it is an autolink", () => {
  expect(
    markdownLinks(
      "[broken](missing@example.com)\n\n`<missing@example.com>`",
    ).map((link) => link.target),
  ).toEqual(["missing@example.com"]);
  expect(
    markdownLinks("![i](a@example.com) <a@example.com>").map(
      (link) => link.target,
    ),
  ).toEqual(["a@example.com", "mailto:a@example.com"]);
  expect(
    markdownLinks("[x](<a@example.com>)\n\n[r]\n\n[r]: <b@example.com>").map(
      (link) => link.target,
    ),
  ).toEqual(["a@example.com", "b@example.com"]);
});

test("a link's line is where the renderer read it, not where its text first stands", () => {
  expect(
    markdownLinks("`[example](missing.md)`\n[broken](missing.md)"),
  ).toEqual([{ target: "missing.md", line: 2 }]);
  expect(
    markdownLinks(
      "```\n[x](missing.md)\n```\n[unused]: missing.md\n[broken](missing.md)",
    ),
  ).toEqual([{ target: "missing.md", line: 5 }]);
  expect(
    markdownLinks("See (missing.md).\n\n[b][r]\n\n[r]: missing.md"),
  ).toEqual([{ target: "missing.md", line: 5 }]);
  expect(markdownLinks("[a](x.md)\n[b](x.md)\n`(x.md)`\n[c](x.md)")).toEqual([
    { target: "x.md", line: 1 },
    { target: "x.md", line: 2 },
    { target: "x.md", line: 4 },
  ]);
});

test("percent-encoding is decoded, and a malformed one is kept as written", () => {
  expect(decode("a%20b.md")).toBe("a b.md");
  expect(decode("100%.md")).toBe("100%.md");
});
