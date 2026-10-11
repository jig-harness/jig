import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitIdentityEnv } from "../../drive-pr/scripts/lib/proc.ts";
import { load } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import {
  adrConfig,
  isRulesFile,
  LocateError,
  locate,
  trackedFiles,
} from "../scripts/locate.ts";
import {
  compile,
  interpreterProblems,
  validateRules,
} from "../scripts/validate-rules.ts";

const scratch = mkdtempSync(join(tmpdir(), "adr-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A git hook exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE pointing at the
// real checkout; a fixture's `git init`, `config` or `add` inheriting them
// would write there instead of the scratch repository. Every git subprocess in
// this file, including the ones the code under test runs, gets this env: the
// shared scrubber, plus GIT_CONFIG, which redirects `git config` writes.
const gitEnv = gitIdentityEnv();
for (const key of Object.keys(gitEnv))
  if (key.toUpperCase() === "GIT_CONFIG") delete gitEnv[key];

function repo(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

describe("locate", () => {
  it("finds a conventional directory and the next ADR-prefixed number", () => {
    const root = repo("prefixed", {
      "docs/adr/ADR-0001-a.md": "",
      "docs/adr/ADR-0012-b.md": "",
      "docs/adr/ADR-template.md": "",
    });
    expect(locate(root, {}, [])).toMatchObject({
      directory: "docs/adr",
      naming: "ADR-NNNN-<slug>.md",
      highest: 12,
      next: "0013",
      nextFile: "docs/adr/ADR-0013-<slug>.md",
      rulesFile: null,
    });
  });

  it("reads the bare-number naming and its padding", () => {
    const root = repo("bare", {
      "docs/decisions/0003-x.md": "",
      "docs/decisions/README.md": "",
    });
    expect(locate(root, {}, [])).toMatchObject({
      directory: "docs/decisions",
      naming: "NNNN-<slug>.md",
      next: "0004",
      nextFile: "docs/decisions/0004-<slug>.md",
    });
  });

  it("numbers past records of either naming, keeping the preferred one", () => {
    const root = repo("mixed", {
      "docs/adr/ADR-0001-a.md": "",
      "docs/adr/0002-b.md": "",
    });
    expect(locate(root, {}, [])).toMatchObject({
      naming: "ADR-NNNN-<slug>.md",
      highest: 2,
      nextFile: "docs/adr/ADR-0003-<slug>.md",
    });
  });

  it("keeps a three-digit padding the records already use", () => {
    const root = repo("three-digit", { "docs/adr/003-choice.md": "" });
    expect(locate(root, {}, [])).toMatchObject({
      naming: "NNNN-<slug>.md",
      width: 3,
      next: "004",
      nextFile: "docs/adr/004-<slug>.md",
    });
  });

  it("starts at 0001 when there are no records yet", () => {
    const root = repo("empty", { "README.md": "" });
    expect(locate(root, {}, [])).toMatchObject({
      directory: null,
      highest: null,
      nextFile: "docs/adr/ADR-0001-<slug>.md",
    });
  });

  it("prefers the configured directory and refuses a missing one", () => {
    const root = repo("configured", {
      "docs/adr/ADR-0001-a.md": "",
      "records/ADR-0007-x.md": "",
    });
    expect(locate(root, { directory: "records" }, []).next).toBe("0008");
    expect(() => locate(root, { directory: "nope" }, [])).toThrow(LocateError);
  });

  it("finds one tracked rules file, and refuses to guess between several", () => {
    const root = repo("rules", { "docs/adr/ADR-0001-a.md": "" });
    expect(
      locate(root, {}, ["src/a.ts", ".claude/adr-rules/rules.yaml"]).rulesFile,
    ).toBe(".claude/adr-rules/rules.yaml");
    expect(() =>
      locate(root, {}, [".adr-rules.yaml", "x/adr-rules.yaml"]),
    ).toThrow(/several/);
    expect(isRulesFile("config/rules.yaml")).toBe(false);
    expect(isRulesFile("templates/adr-rules.yaml")).toBe(false);
    expect(isRulesFile("a/fixtures/adr-rules.yaml")).toBe(false);
  });

  it("refuses to report no rules file when git cannot list the tracked files", () => {
    const root = repo("not-a-repo", { "README.md": "" });
    const env = { ...gitEnv, GIT_DIR: join(root, "no-such-git-dir") };
    expect(() => trackedFiles(root, env)).toThrow(LocateError);
    expect(() => trackedFiles(root, env)).toThrow(/git ls-files failed/);
  });

  it("reads a successful empty listing as no tracked files", () => {
    const root = repo("empty-git", { "README.md": "" });
    expect(
      spawnSync("git", ["init", "-q"], { cwd: root, env: gitEnv }).status,
    ).toBe(0);
    expect(trackedFiles(root, gitEnv)).toEqual([]);
  });

  it("discovers a tracked rules file under a non-ASCII directory", () => {
    const root = repo("non-ascii", {
      "docs/adr/ADR-0001-a.md": "",
      "politique/décisions/adr-rules.yaml": "rules: []\n",
    });
    const git = (...args: string[]) =>
      expect(spawnSync("git", args, { cwd: root, env: gitEnv }).status).toBe(0);
    git("init", "-q");
    // The default, set here so a global `core.quotePath=false` cannot mask it.
    git("config", "core.quotePath", "true");
    git("add", ".");
    expect(trackedFiles(root, gitEnv)).toContain(
      "politique/décisions/adr-rules.yaml",
    );
    expect(locate(root, {}, trackedFiles(root, gitEnv)).rulesFile).toBe(
      "politique/décisions/adr-rules.yaml",
    );
  });

  it("reads the adr section of the overlay, defaulting when absent", () => {
    const root = repo("overlay", {
      "a.yaml": "adr:\n  directory: records\n",
      "b.yaml": "gates:\n  command: x\n",
      "c.yaml": "adr:\n  directory: 3\n",
    });
    expect(adrConfig(join(root, "a.yaml"))).toEqual({ directory: "records" });
    expect(adrConfig(join(root, "b.yaml"))).toEqual({});
    expect(adrConfig(join(root, "missing.yaml"))).toEqual({});
    expect(() => adrConfig(join(root, "c.yaml"))).toThrow(/nonempty string/);
  });
});

describe("validate-rules", () => {
  it("accepts a valid catalog and counts each rule list", () => {
    const catalog = load(`
pattern_rules:
  - id: PM-101
    pattern: 'console\\.log\\('
  - id: PM-102
    pattern: 'fetch\\('
    follow_check: 'AbortSignal|timeout'
semantic_rules:
  - id: SEM-001
    prompt: x
`);
    expect(validateRules(catalog)).toEqual({
      problems: [],
      counts: { pattern_rules: 2, semantic_rules: 1 },
    });
  });

  it("reports duplicate ids, missing ids and patterns that do not compile", () => {
    const catalog = load(`
pattern_rules:
  - id: PM-1
    pattern: '('
  - id: PM-1
    pattern: 'a'
  - pattern: 'b'
    follow_check: '[[:nope:]]'
`);
    const { problems } = validateRules(catalog);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/PM-1: pattern does not compile/);
    expect(problems.join("\n")).toMatch(/duplicate id PM-1/);
    expect(problems.join("\n")).toMatch(/has no id/);
    expect(problems.join("\n")).toMatch(
      /unsupported POSIX character class: nope/,
    );
  });

  it("reports a pattern rule without a pattern and an unknown severity", () => {
    const catalog = load(`
pattern_rules:
  - id: PM-1
    severity: critical
  - id: PM-2
    pattern: ''
  - id: PM-3
    pattern: 'a'
    severity: criticial
  - id: PM-4
    pattern: 'b'
    severity: 1
semantic_rules:
  - id: SEM-1
    severity: blocker
    prompt: x
`);
    const { problems } = validateRules(catalog);
    expect(problems).toEqual([
      "PM-1: pattern_rules entry has no pattern",
      "PM-2: pattern_rules entry has no pattern",
      "PM-3: severity must be one of critical, warning, info (got criticial)",
      "PM-4: severity must be one of critical, warning, info (got 1)",
      "SEM-1: severity must be one of critical, warning, info (got blocker)",
    ]);
  });

  it("accepts every known severity and an omitted one", () => {
    const catalog = load(`
pattern_rules:
  - id: PM-1
    pattern: 'a'
  - id: PM-2
    pattern: 'b'
    severity: critical
  - id: PM-3
    pattern: 'c'
    severity: warning
  - id: PM-4
    pattern: 'd'
    severity: info
`);
    expect(validateRules(catalog).problems).toEqual([]);
  });

  it("translates POSIX classes", () => {
    expect(compile("a[[:space:]]+b").test("a \tb")).toBe(true);
  });

  it("rejects a duplicated key at parse time", () => {
    expect(() => load("pattern_rules: []\npattern_rules: []\n")).toThrow();
  });

  it("rejects a pattern_rules shape the interpreter reads differently", () => {
    const check = (text: string) => interpreterProblems(text, load(text));
    // The interpreter's own template reads the same either way.
    const template = readFileSync(
      join(
        dirname(import.meta.dir),
        "../../../modules/M5-adr-practice/templates/adr-rules.yaml",
      ),
      "utf8",
    );
    expect(check(template)).toEqual([]);

    expect(
      check(`pattern_rules:
  - id: PM-1
    severity: critical # critical | warning | info
    pattern: 'a'
`).join("\n"),
    ).toMatch(
      /PM-1 \(line 3\): the interpreter reads severity as "critical # critical \| warning \| info".*inline # comment/,
    );

    expect(
      check(`pattern_rules:
  - id: PM-1
    pattern: 'a'   # note
`).join("\n"),
    ).toMatch(/reads pattern as "a' {3}# note"/);

    expect(
      check(`pattern_rules:
  - id: PM-1
    pattern: 'a'
  - pattern: 'b'
    id: PM-2
`),
    ).toEqual([
      'line 4: a pattern_rules entry must open with an indented "- id:" line; the interpreter starts a rule nowhere else',
    ]);

    expect(
      check(`pattern_rules:
- id: PM-1
  pattern: 'a'
`),
    ).toHaveLength(1);

    expect(
      check(`pattern_rules:
  - id: PM-1
    pattern: |
      a
`).join("\n"),
    ).toMatch(/reads pattern as "\|".*block scalar/);

    expect(
      check(`pattern_rules:
  - id: PM-1
    pattern: >-
      a
`).join("\n"),
    ).toMatch(/block scalar/);

    expect(
      check(`pattern_rules:
  - id: PM-1
    pattern: 'a'
    exclude:
      - '**/*.test.ts'
`).join("\n"),
    ).toMatch(/reads exclude as "exclude:"/);

    expect(
      check(String.raw`pattern_rules:
  - id: PM-1
    pattern: "a\\.b"
`),
    ).toEqual([
      String.raw`PM-1 (line 3): the interpreter reads pattern as "a\\\\.b", the YAML as "a\\.b"`,
    ]);
  });

  it("leaves lists the interpreter does not read alone", () => {
    const text = `pattern_rules:
  - id: PM-1
    pattern: 'a'
semantic_rules:
  - id: SEM-1
    severity: critical # critical | warning
    prompt: |
      x
`;
    expect(interpreterProblems(text, load(text))).toEqual([]);
  });
});
