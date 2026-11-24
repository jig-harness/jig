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

test("literal Markdown does not repeat overlapping autolinks", () => {
  expect(lit("https://example.org/a@b.co;c@d.co/path")).toBe(
    "`https://example.org/a@b.co;c@d.co/path`",
  );
});

test("literal Markdown scans non-email prose in linear time", () => {
  const input = "a-".repeat(30_000);
  expect(lit(input)).toBe(input);
});
