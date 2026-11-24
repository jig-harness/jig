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

test("code fences preserve backticks in source text", () => {
  expect(code("https://example.org/a`b")).toBe("``https://example.org/a`b``");
});
