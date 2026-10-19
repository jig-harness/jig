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

test("a destination with no letter or digit, or none in ASCII, is placed where it is read", () => {
  expect(markdownLinks("`!!!`\n[broken](!!!)\n[again](!!!)")).toEqual([
    { target: "!!!", line: 2 },
    { target: "!!!", line: 3 },
  ]);
  expect(markdownLinks("`é`\n[broken](é)")).toEqual([{ target: "é", line: 2 }]);
});

test("a line ends at CR, LF or CRLF", () => {
  expect(markdownLinks("intro\r[broken](missing.md)\r\n\n[b](x.md)")).toEqual([
    { target: "missing.md", line: 2 },
    { target: "x.md", line: 4 },
  ]);
});

test("a label that repeats its destination keeps the link at its definition", () => {
  expect(markdownLinks("[x.md]\n\n[x.md]: x.md")).toEqual([
    { target: "x.md", line: 3 },
  ]);
  expect(markdownLinks("<a@b.c>\n[x](<a@b.c>)\n<a@b.c>")).toEqual([
    { target: "mailto:a@b.c", line: 1 },
    { target: "a@b.c", line: 2 },
    { target: "mailto:a@b.c", line: 3 },
  ]);
});

test("an email autolink stands where it is read, whatever text repeats its address", () => {
  expect(markdownLinks("Contact a@b.c\n\n<a@b.c>")).toEqual([
    { target: "mailto:a@b.c", line: 3 },
  ]);
  expect(markdownLinks("`a@b.c`\n[r]: a@b.c\n<a@b.c>")).toEqual([
    { target: "mailto:a@b.c", line: 3 },
  ]);
});

test("a file that already holds Private Use Area characters is still marked", () => {
  expect(markdownLinks("\n[broken](<missing@example.com>)")).toEqual([
    { target: "missing@example.com", line: 2 },
  ]);
  expect(markdownLinks(" `x.md`\n[a](x.md)\n<a@b.c>")).toEqual([
    { target: "x.md", line: 2 },
    { target: "mailto:a@b.c", line: 3 },
  ]);
});

/** Every Private Use Area character from `first` through `last`. */
function privateUse(first: number, last: number): string {
  let text = "";
  for (let code = first; code <= last; code++)
    text += String.fromCodePoint(code);
  return text;
}

test("a file holding the whole Basic Multilingual Plane's Private Use Area is marked from planes 15 and 16", () => {
  const inventory = `\`\`\`\n${privateUse(0xe000, 0xf8ff)}\n\`\`\`\n`;
  expect(markdownLinks(`${inventory}<a@b.c>\n[x](a@b.c)`)).toEqual([
    { target: "mailto:a@b.c", line: 4 },
    { target: "a@b.c", line: 5 },
  ]);
  const most = `${privateUse(0xe000, 0xf8ff)}${privateUse(0xf0000, 0xffffd)}${privateUse(0x100000, 0x10fffb)}`;
  expect(
    markdownLinks(`\`${most}\`\n${"[a](x.md)\n".repeat(5)}<a@b.c>`),
  ).toEqual([
    ...[2, 3, 4, 5, 6].map((line) => ({ target: "x.md", line })),
    { target: "mailto:a@b.c", line: 7 },
  ]);
});

test("a file holding every Private Use Area character is refused, not read by guess", () => {
  const every = `${privateUse(0xe000, 0xf8ff)}${privateUse(0xf0000, 0xffffd)}${privateUse(0x100000, 0x10fffd)}`;
  expect(() => markdownLinks(`\`${every}\`\n<a@b.c>`)).toThrow(
    "every Private Use Area character",
  );
});

test("a link and an image whose destinations differ only by a leading ! are told apart", () => {
  expect(markdownLinks("[l](!a.md)\n![i](a.md)")).toEqual([
    { target: "!a.md", line: 1 },
    { target: "a.md", line: 2 },
  ]);
  expect(markdownLinks("![i](a@b.c)\n[l](<!a@b.c>)")).toEqual([
    { target: "a@b.c", line: 1 },
    { target: "!a@b.c", line: 2 },
  ]);
});

test("a file is rendered twice however many links repeat a destination", () => {
  const render = Bun.markdown.render;
  let renders = 0;
  Bun.markdown.render = ((...args: Parameters<typeof render>) => {
    renders++;
    return render(...args);
  }) as typeof render;
  try {
    const links = markdownLinks(`${"[a](x.md)\n".repeat(1000)}\`x.md\``);
    expect(links).toHaveLength(1000);
    expect(links.at(-1)).toEqual({ target: "x.md", line: 1000 });
  } finally {
    Bun.markdown.render = render;
  }
  expect(renders).toBe(2);
});

test("percent-encoding is decoded, and a malformed one is kept as written", () => {
  expect(decode("a%20b.md")).toBe("a b.md");
  expect(decode("100%.md")).toBe("100%.md");
});
