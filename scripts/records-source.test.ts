import { expect, test } from "bun:test";
import { sourceLiterals } from "./records-source.ts";

test("literal text and source lines after a regex and division", () => {
  const source = [
    "const regex = /['`]/;",
    'const sql = "CREATE\\nTABLE one (id TEXT)";',
    "const ratio = value / count;",
    "const other = `CREATE\nTABLE two (id TEXT)`;",
  ].join("\n");
  expect(sourceLiterals(source)).toEqual([
    { text: "CREATE\nTABLE one (id TEXT)", lines: Array(26).fill(2) },
    {
      text: "CREATE\nTABLE two (id TEXT)",
      lines: [...Array(7).fill(4), ...Array(19).fill(5)],
    },
  ]);
});

test("nested template expressions retain their own literals and source lines", () => {
  const source = [
    "const text = `before${",
    '  "CREATE TABLE inner (id TEXT)"',
    "}after`;",
  ].join("\n");
  expect(sourceLiterals(source)).toEqual([
    {
      text: "before\0after",
      lines: [...Array(6).fill(1), ...Array(6).fill(3)],
    },
    { text: "CREATE TABLE inner (id TEXT)", lines: Array(28).fill(2) },
  ]);
});

test("non-ASCII text before literals does not shift source offsets", () => {
  expect(
    sourceLiterals(
      '/* 🐦 café */\nconst sql = "CREATE TABLE birds (id TEXT)";',
    ),
  ).toEqual([
    { text: "CREATE TABLE birds (id TEXT)", lines: Array(28).fill(2) },
  ]);
});

test("parentheses preserve built-in raw tag recognition", () => {
  for (const tag of ["(String.raw)", "(String).raw", '(String["raw"])']) {
    expect(sourceLiterals(`${tag}\`CREATE TABLE birds (id TEXT)\`;`)).toEqual([
      ...(tag.includes('"raw"') ? [{ text: "raw", lines: [1, 1, 1] }] : []),
      { text: "CREATE TABLE birds (id TEXT)", lines: Array(28).fill(1) },
    ]);
  }
});
