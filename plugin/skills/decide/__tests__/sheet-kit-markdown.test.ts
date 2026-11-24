import { expect, test } from "bun:test";
import { cell, code, lit } from "../scripts/sheet-kit/markdown.ts";

test("literal Markdown preserves text around autolinks and recognises underscored domains", () => {
  expect(
    lit(
      "see https://example.org next https://example.org/two and user@my_host.example",
    ),
  ).toBe(
    "see `https://example.org` next `https://example.org/two` and `user@my_host.example`",
  );
});

test("table cells protect pipes inside literal autolinks", () => {
  expect(cell("https://example.org/a|b")).toBe("`https://example.org/a\\|b`");
});

test("literal Markdown preserves pipes outside table cells", () => {
  expect(lit("| A |\n| --- |\n| B |")).toBe(
    "\\| A \\|\n\\| --- \\|\n\\| B \\|",
  );
});

test("code fences preserve backticks in source text", () => {
  expect(code("https://example.org/a`b")).toBe("``https://example.org/a`b``");
  expect(code("`edge")).toBe("`` `edge ``");
  expect(code("edge`")).toBe("`` edge` ``");
});

test("code fences handle long backtick runs without spreading their matches", () => {
  expect(code("`".repeat(150_000))).toHaveLength(450_004);
  expect(code("`a".repeat(150_000))).toBe(`\`\` ${"`a".repeat(150_000)} \`\``);
});

test("literal Markdown protects whole words, so overlapping candidates never leak", () => {
  expect(lit("https://example.org/a@b.co;c@d.co/path")).toBe(
    "`https://example.org/a@b.co;c@d.co/path`",
  );
  expect(lit("a@b.example/bob@c.example")).toBe("`a@b.example/bob@c.example`");
});

test("literal Markdown protects words GFM links after delimiter characters", () => {
  for (const word of [
    "_www.example.org",
    "_https://example.org",

    "*mailto:a@b.co",
  ])
    expect(lit(word)).toBe(`\`${word}\``);
});

test("literal Markdown keeps sentence punctuation and closing quotes outside the span", () => {
  expect(lit('See "https://example.org."')).toBe(
    'See "`https://example.org`."',
  );
  expect(lit("(see https://example.org)")).toBe("(see `https://example.org`)");
});

test("balanced parentheses stay inside the span and plain @ words stay text", () => {
  expect(lit("see https://example.org/path_(item).")).toBe(
    "see `https://example.org/path_(item)`.",
  );
  expect(lit("owner/repo@main")).toBe("owner/repo@main");
});

test("table cells escape each pipe once, in text and in code spans", () => {
  expect(cell("a | b")).toBe("a \\| b");
  expect(cell("x@y.co|z")).toBe("`x@y.co\\|z`");
});

test("literal Markdown leaves long non-email prose unchanged", () => {
  const input = "a-".repeat(30_000);
  expect(lit(input)).toBe(input);
  const nearMisses = "a.b-c@".repeat(5_000);
  expect(lit(nearMisses)).toBe(`\`${nearMisses}\``);
});
