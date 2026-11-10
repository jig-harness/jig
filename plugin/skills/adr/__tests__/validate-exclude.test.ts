import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { load } from "../../../shared/yaml.ts";
import {
  compileGlob,
  interpreterProblems,
  validateRules,
} from "../scripts/validate-rules.ts";

const SCRIPT = join(import.meta.dir, "../scripts/validate-rules.ts");

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

describe("the interpreter a catalog is enforced by", () => {
  const escaped = `pattern_rules:\n  - id: r1\n    pattern: "\\\\s*any\\\\b"\n    exclude:\n      - "docs/**"\n`;
  const run = (text: string, args: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "validate-rules-"));
    try {
      const file = join(dir, "rules.yaml");
      writeFileSync(file, text);
      return Bun.spawnSync([process.execPath, SCRIPT, ...args, file], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads the lines by default and reports the escape and the block list", () => {
    const result = run(escaped);
    expectSpawnExit(result, 1);
    const out = result.stdout.toString();
    expect(out).toContain("the interpreter reads pattern as");
    expect(out).toContain("the interpreter reads exclude as");
  });

  it("accepts the same catalog under --interpreter=yaml", () => {
    expectSpawnExit(run(escaped, ["--interpreter=yaml"]), 0);
  });

  it("accepts it when the catalog declares the interpreter, the flag winning", () => {
    expectSpawnExit(run(`interpreter: yaml\n${escaped}`), 0);
    expectSpawnExit(
      run(`interpreter: yaml\n${escaped}`, ["--interpreter=lines"]),
      1,
    );
  });

  it("still fails a pattern that does not compile in the YAML mode", () => {
    const result = run(
      `interpreter: yaml\npattern_rules:\n  - id: r1\n    pattern: "a("\n`,
    );
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toContain("r1: pattern does not compile");
  });

  it("refuses an unknown interpreter", () => {
    expectSpawnExit(run(escaped, ["--interpreter=toml"]), 2);
    expectSpawnExit(run("interpreter: toml\npattern_rules: []\n"), 2);
  });

  it("keeps the YAML mode's other checks: a duplicate id, an unknown severity", () => {
    const text = `interpreter: yaml\npattern_rules:\n  - id: r1\n    pattern: a\n    severity: loud\n  - id: r1\n    pattern: b\n`;
    const out = run(text).stdout.toString();
    expect(out).toContain("duplicate id r1");
    expect(out).toContain("severity must be one of");
  });

  it("does not report a rule that names how it is enforced", () => {
    const ok = (rule: string) =>
      validateRules(load(`pattern_rules:\n  - id: r1\n${rule}\n`)).problems;
    expect(ok("    implementation: ast-scan")).toEqual([]);
    expect(ok("    detector: tsc")).toEqual([]);
    expect(ok("    pattern_frontend: a\n    pattern_backend: b")).toEqual([]);
    expect(ok("    severity: critical")).toEqual([
      "r1: pattern_rules entry has no pattern",
    ]);
    expect(ok("    pattern_frontend: 'a('")[0]).toContain(
      "pattern_frontend does not compile",
    );
  });
});
