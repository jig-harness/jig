import { expect, test } from "bun:test";
import { sourceLiterals } from "./records-source.ts";

test("scope-dependent invalid source is rejected in module and CommonJS modes", () => {
  for (const prefix of ["", "return; "]) {
    expect(() =>
      sourceLiterals(
        `${prefix}let foo; let foo; const sql = 'CREATE TABLE birds (id TEXT)';`,
      ),
    ).toThrow();
  }
});

test("Unicode line separators inside literals retain declaration source lines", () => {
  for (const separator of ["\u2028", "\u2029"]) {
    for (const quote of ["`", '"', "'"]) {
      const text = `/*${separator}*/ CREATE TABLE birds (id TEXT)`;
      const [sql] = sourceLiterals(`const sql = ${quote}${text}${quote};`);
      expect(sql?.text).toBe(text);
      expect(sql?.lines[text.indexOf("CREATE")]).toBe(2);
    }
  }
});

test("escaped Unicode line continuations do not emit SQL characters", () => {
  for (const separator of ["\u2028", "\u2029"]) {
    const [sql] = sourceLiterals(
      `const sql = "/*\\${separator}*/ CREATE TABLE birds (id TEXT)";`,
    );
    expect(sql?.text).toBe("/**/ CREATE TABLE birds (id TEXT)");
    expect(sql?.lines[5]).toBe(2);
    expect(sql?.lines.length).toBe(sql?.text.length);
  }
});

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
