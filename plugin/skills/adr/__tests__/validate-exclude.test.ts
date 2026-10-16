import { describe, expect, it } from "bun:test";
import { load } from "../../../shared/yaml.ts";
import {
  compileGlob,
  interpreterProblems,
  validateRules,
} from "../scripts/validate-rules.ts";

function check(text: string): string[] {
  const catalog = load(text);
  return [
    ...validateRules(catalog).problems,
    ...interpreterProblems(text, catalog),
  ];
}

function catalog(exclude: string): string {
  return `pattern_rules:\n  - id: r1\n    pattern: a\n    exclude: ${exclude}\n`;
}

describe("exclude globs", () => {
  it("rejects a glob the interpreter would turn into an invalid regex", () => {
    const problems = check(catalog(`['**/[']`));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('r1: exclude glob "**/[" does not compile');
  });

  it("names only the failing glob in a list", () => {
    const problems = check(catalog(`['docs/**', 'src/[', '**/*.test.ts']`));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"src/["');
  });

  it("accepts ordinary globs", () => {
    expect(check(catalog(`['**/*.test.ts', 'docs/**', '*.md']`))).toEqual([]);
  });

  it("rejects an exclude that is not a list of globs", () => {
    expect(
      validateRules({
        pattern_rules: [{ id: "r1", pattern: "a", exclude: [1] }],
      }).problems,
    ).toEqual(["r1: exclude must be a list of globs"]);
  });

  it("builds the interpreter's regex", () => {
    const regex = compileGlob("**/*.test.ts");
    expect(regex.test("src/a/b.test.ts")).toBe(true);
    expect(regex.test("src/a/b.test.tsx")).toBe(false);
    expect(compileGlob("docs/*").test("docs/a/b.md")).toBe(false);
  });
});
