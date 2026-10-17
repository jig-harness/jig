import { describe, expect, test } from "bun:test";
import { lineStyle } from "../scripts/lib/classify.ts";
import { countLines } from "../scripts/lib/count.ts";
import { commentStyle } from "../scripts/lib/languages.ts";
import { facts } from "./helpers.ts";

const count = (src: string, ext: string) => countLines(src, commentStyle(ext));

describe("countLines", () => {
  test("separates blank, comment and code lines", () => {
    const src =
      "// header\n\nconst a = 1;\n/* block\n still */\nconst b = 2;\n";
    expect(count(src, "ts")).toEqual({ raw: 6, blank: 1, comment: 3, code: 2 });
  });

  test("code beside a block comment is code", () => {
    expect(count("/* explanation */ const x = 1;\n", "ts").code).toBe(1);
    expect(count("/* a\n b */ const x = 1;\n", "ts")).toEqual({
      raw: 2,
      blank: 0,
      comment: 1,
      code: 1,
    });
    expect(count("/* a */ // b\n/**/\n", "ts").comment).toBe(2);
    expect(count("<!-- a --> <p>x</p>\n", "html").code).toBe(1);
    expect(count("/* a */ SELECT 1;\n", "sql").code).toBe(1);
  });

  test("a block comment opened after code continues onto the next lines", () => {
    expect(
      count("const x = 1; /* explanation\ncontinued */\nconst y = 2;\n", "ts"),
    ).toEqual({ raw: 3, blank: 0, comment: 1, code: 2 });
    expect(count("SELECT 1; /* a\n b */\n", "sql").comment).toBe(1);
  });

  test("comment markers inside a string are code", () => {
    const template = "const t = `\n/* not a comment\n`;\nconst y = 2;\n";
    expect(count(template, "ts")).toEqual({
      raw: 4,
      blank: 0,
      comment: 0,
      code: 4,
    });
    expect(
      count('const u = "http://x"; // c\nconst v = "/*";\nf();\n', "ts"),
    ).toEqual({ raw: 3, blank: 0, comment: 0, code: 3 });
    expect(count('val s = """\n// inside\n"""\n', "kt").comment).toBe(0);
    expect(count("SELECT '-- no';\n", "sql").code).toBe(1);
    expect(count('const e = "a\\"/*";\nx();\n', "ts").code).toBe(2);
  });

  test("comment markers inside a regular-expression literal are code", () => {
    expect(count("const re = /[/*]/;\nconst x = 1;\n", "ts").code).toBe(2);
    expect(count("if (/\\/\\*/.test(s)) f();\ng();\n", "js").code).toBe(2);
    expect(count("const r = a / b; /* open\n still */\nf();\n", "ts")).toEqual({
      raw: 3,
      blank: 0,
      comment: 1,
      code: 2,
    });
  });

  test("block comments nest where the language nests them", () => {
    const src = "/* outer\n /* inner */\n still outer\n*/\nlet x = 1;\n";
    expect(count(src, "rs")).toEqual({ raw: 5, blank: 0, comment: 4, code: 1 });
    expect(count(src, "kt").comment).toBe(4);
    expect(count("/* a /* b */\nint x;\n", "c")).toEqual({
      raw: 2,
      blank: 0,
      comment: 1,
      code: 1,
    });
  });

  test("a hash inside a Python triple-quoted string is code", () => {
    expect(count('x = """\n# inside\n"""\n# c\n', "py")).toEqual({
      raw: 4,
      blank: 0,
      comment: 1,
      code: 3,
    });
    expect(count("x = '''\n# inside\n'''\n", "py").comment).toBe(0);
    expect(count('echo "# not"\n# c\n', "sh").comment).toBe(1);
  });

  test("a SQL string runs across lines", () => {
    expect(count("SELECT 'hello\n-- literal text\nworld';\n", "sql")).toEqual({
      raw: 3,
      blank: 0,
      comment: 0,
      code: 3,
    });
    expect(count("SELECT 'it''s'; -- c\n-- d\n", "sql").comment).toBe(1);
  });

  test("a SQL string escapes its quote by doubling it, not with a backslash", () => {
    expect(count("SELECT 'C:\\';\n-- one\n-- two\n", "sql")).toEqual({
      raw: 3,
      blank: 0,
      comment: 2,
      code: 1,
    });
    expect(count("SELECT 'a''\n-- inside\n';\n-- c\n", "sql")).toEqual({
      raw: 4,
      blank: 0,
      comment: 1,
      code: 3,
    });
    expect(count('SELECT "a\\";\n-- c\n', "sql").comment).toBe(1);
    expect(count('s = "a\\"; // no\n// c\n', "js").comment).toBe(1);
  });

  test("a SQL escape string (E'…') takes backslash escapes", () => {
    expect(count("SELECT E'it\\'s';\n-- one\n-- two\n", "sql")).toEqual({
      raw: 3,
      blank: 0,
      comment: 2,
      code: 1,
    });
    expect(count("SELECT e'a\\'\n-- inside\n';\n-- c\n", "sql")).toEqual({
      raw: 4,
      blank: 0,
      comment: 1,
      code: 3,
    });
    // A doubled quote and a fragment continued on the next line stay escape strings.
    expect(count("SELECT E'it''s\\'fine';\n-- one\n-- two\n", "sql")).toEqual({
      raw: 3,
      blank: 0,
      comment: 2,
      code: 1,
    });
    expect(count("SELECT E'a'\n'it\\'s';\n-- one\n-- two\n", "sql")).toEqual({
      raw: 4,
      blank: 0,
      comment: 2,
      code: 2,
    });
    // A line comment between the fragments is whitespace to the continuation.
    expect(
      count("SELECT E'a' -- note\n'it\\'s';\n-- one\n-- two\n", "sql"),
    ).toEqual({ raw: 4, blank: 0, comment: 2, code: 2 });
    // Code between two strings ends the continuation.
    expect(count("SELECT E'a', 'C:\\';\n-- c\n", "sql").comment).toBe(1);
    // A name ending in E is not a prefix: DATE'…' is a standard string.
    expect(count("SELECT DATE'C:\\';\n-- one\n-- two\n", "sql")).toEqual({
      raw: 3,
      blank: 0,
      comment: 2,
      code: 1,
    });
  });

  test("markup apostrophes do not open a string", () => {
    expect(count("It's here.\n<!-- c -->\n", "md")).toEqual({
      raw: 2,
      blank: 0,
      comment: 1,
      code: 1,
    });
  });

  test("SQL line comments", () => {
    expect(count("-- c\nSELECT 1;\n", "sql")).toEqual({
      raw: 2,
      blank: 0,
      comment: 1,
      code: 1,
    });
  });

  test("hash comments, and a file without a final newline", () => {
    expect(count("# c\nx = 1", "py")).toEqual({
      raw: 2,
      blank: 0,
      comment: 1,
      code: 1,
    });
  });

  test("the languages added beside the original set have their comment style", () => {
    for (const ext of ["java", "cs", "c", "cpp", "php"])
      expect([ext, commentStyle(ext)]).toEqual([ext, "c"]);
    for (const ext of ["kt", "swift", "rs"])
      expect([ext, commentStyle(ext)]).toEqual([ext, "nested"]);
    for (const ext of ["rb", "ex", "exs", "r", "pl", "ps1"])
      expect([ext, commentStyle(ext)]).toEqual([ext, "hash"]);
  });

  test("an extension without comments counts every non-blank line as code", () => {
    expect(count("# not a comment\n{}\n", "json")).toEqual({
      raw: 2,
      blank: 0,
      comment: 0,
      code: 2,
    });
  });
});

describe("lineStyle", () => {
  test("an extensionless script takes its shebang language's style", () => {
    const script = facts("bin/release", "#!/usr/bin/env bash\n# c\necho\n");
    expect(lineStyle(script, "Shell")).toBe("hash");
  });

  test("an extension's own style wins over a named language", () => {
    expect(lineStyle(facts("a/b.ts"), "Shell")).toBe("js");
  });

  test("a file whose language is only its own name strips nothing", () => {
    expect(lineStyle(facts("bin/notes"), "notes")).toBe("none");
  });
});
