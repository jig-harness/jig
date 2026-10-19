import { expect, test } from "bun:test";
import { decode, markdownLinks } from "./markdown-links.ts";

test("inline, angle-bracketed and reference destinations are read without titles", () => {
  const content = [
    '[a](a.md "Title") ![i](img/i.png) [b](<b c.md>) [p](x(1).md)',
    "[e](e\\_f.md) [r][ref]",
    "",
    "[ref]: ref.md 'Ref'",
    "   [ang]: <ang le.md>",
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
  ].join("\n");
  expect(markdownLinks(content)).toEqual([{ target: "e.md", line: 9 }]);
});

test("percent-encoding is decoded, and a malformed one is kept as written", () => {
  expect(decode("a%20b.md")).toBe("a b.md");
  expect(decode("100%.md")).toBe("100%.md");
});
