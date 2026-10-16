import { expect, test } from "bun:test";
import { twinPath, wantsMarkdown } from "./markdown.ts";

test("a header that names Markdown and prefers it asks for it", () => {
  for (const accept of [
    "text/markdown",
    "text/markdown, text/html",
    "text/markdown, text/html;q=0.9, */*;q=0.1",
    "text/html;q=0.5, text/markdown;q=0.8",
    "TEXT/Markdown",
  ])
    expect(wantsMarkdown(accept), accept).toBe(true);
});

test("a browser, a wildcard or an empty header gets HTML", () => {
  for (const accept of [
    null,
    "",
    "*/*",
    "text/*",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "text/html, text/markdown",
    "text/markdown;q=0.5, text/html",
    "text/markdown;q=0",
  ])
    expect(wantsMarkdown(accept), String(accept)).toBe(false);
});

test("a page has its twin beside it, a file has none", () => {
  expect(twinPath("/")).toBe("/index.md");
  expect(twinPath("/modules/M2/")).toBe("/modules/M2/index.md");
  expect(twinPath("/modules/M2")).toBe("/modules/M2/index.md");
  expect(twinPath("/llms.txt")).toBeNull();
  expect(twinPath("/modules/M2/index.md")).toBeNull();
  expect(twinPath("/examples/audit/sheet.html")).toBeNull();
});
