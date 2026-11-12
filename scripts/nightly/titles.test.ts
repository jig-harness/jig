import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { literals, TitleIndex } from "./titles.ts";

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jig-nightly-titles-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("finding a recorded test in the source", () => {
  test("reads quoted and template literals, unescaped, and skips comments", () => {
    const found = literals(
      [
        "// it's a comment with a 'quote",
        '/* "not a title" */',
        "test('it\\'s escaped', () => {});",
        'test("say \\"hi\\"", () => {});',
        "test(`a $" + "{kind} case of note`, () => {});",
      ].join("\n"),
    );
    expect([...found.plain]).toEqual(["it's escaped", 'say "hi"']);
    expect(found.patterns.map(String)).toEqual(["/^a [^]* case of note$/"]);
  });

  test("a title made mostly of placeholders matches nothing", () => {
    expect(
      literals("test(`$" + "{a}: $" + "{b}`, () => {});").patterns,
    ).toEqual([]);
  });

  test("finds titles in the test file and what it imports, placeholders included", () => {
    const root = repo({
      "lib/shared/suite.ts":
        'export const suite = () => it("a browser is available where one is required", () => {});\n',
      "lib/a.test.ts": [
        'import { suite } from "./shared/suite.ts";',
        'describe("outer > block", () => {',
        '  test.each([[1]])("each row %p is checked", () => {});',
        '  test.each([{ n: 1 }])("names $n in its title", () => {});',
        "});",
        "suite();",
      ].join("\n"),
    });
    const titles = new TitleIndex(root);
    expect(
      titles.has(
        "lib/a.test.ts",
        "a browser is available where one is required",
      ),
    ).toBe(true);
    expect(
      titles.has(
        "lib/a.test.ts",
        'outer > block > each row {"pr":1} is checked',
      ),
    ).toBe(true);
    expect(
      titles.has("lib/a.test.ts", "outer > block > names 1 in its title"),
    ).toBe(true);
    expect(titles.has("lib/a.test.ts", "outer > block > (unnamed)")).toBe(true);
    expect(titles.has("lib/a.test.ts", "(unnamed)")).toBe(true);
    expect(titles.has("lib/a.test.ts", "outer > block > a renamed test")).toBe(
      false,
    );
    expect(
      titles.has("lib/a.test.ts", "another block > each row 1 is checked"),
    ).toBe(false);
  });
});
