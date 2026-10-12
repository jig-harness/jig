import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attained,
  evaluateProbe,
  loadModules,
  parseModule,
  probedFiles,
  type Score,
} from "../scripts/lib/criteria.ts";
import { checkRecord, parseRecord } from "../scripts/lib/record.ts";
import { matchGlob } from "../scripts/lib/repo.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "jig-score-"));
const repos: string[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const r = scratchRepo(files);
  repos.push(r);
  return r;
};

describe("the shipped criteria", () => {
  test("all thirteen modules carry well-formed criteria", () => {
    const run = runScript("score.ts", ["--check"], scratch);
    expect(run.code).toBe(0);
    expect(run.out).toContain("All 13 modules");
    const modules = loadModules();
    expect(modules.map((m) => m.module)).toEqual(
      Array.from({ length: 13 }, (_, n) => `M${n}`),
    );
    // Every file is named after its module.
    for (const m of modules)
      expect(m.file).toEndWith(`${m.module}-${m.name}.yaml`);
  });

  test("a missing or empty module fails the check", () => {
    const dir = join(scratch, "criteria");
    mkdirSync(dir);
    expect(
      runScript("score.ts", ["--check", "--criteria", dir], scratch).code,
    ).toBe(1);
    writeFileSync(
      join(dir, "M0-empty.yaml"),
      "module: M0\nname: empty\ncriteria: []\n",
    );
    const run = runScript("score.ts", ["--check", "--criteria", dir], scratch);
    expect(run.code).toBe(1);
    expect(run.out).toContain("EMPTY: M0");
    expect(run.out).toContain("MISSING: M1");
  });

  test("a module has one file, named after what it declares", () => {
    const one = (module: string, name: string) =>
      `module: ${module}\nname: ${name}\ncriteria:\n  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }\n`;
    const twice = join(scratch, "twice");
    mkdirSync(twice);
    writeFileSync(join(twice, "M1-a.yaml"), one("M1", "a"));
    writeFileSync(join(twice, "M1-b.yaml"), one("M1", "b"));
    expect(() => loadModules(twice)).toThrow("M1 has two criteria files");
    const misnamed = join(scratch, "misnamed");
    mkdirSync(misnamed);
    writeFileSync(join(misnamed, "M2-a.yaml"), one("M1", "a"));
    expect(() => loadModules(misnamed)).toThrow("name the file M1-a.yaml");
  });

  test("a missing criteria folder and an unknown flag are usage errors", () => {
    expect(
      runScript(
        "score.ts",
        ["--check", "--criteria", join(scratch, "nope")],
        scratch,
      ).code,
    ).toBe(2);
    expect(runScript("score.ts", ["--nope"], scratch).code).toBe(2);
  });
});

describe("criteria format", () => {
  const base = `module: M1
name: example
criteria:
  - id: one
    level: lite
    requires: convention
    statement: A fact.
    observe: ["a file"]
`;
  test("parses ids into module-qualified keys", () => {
    const m = parseModule(base, "x.yaml");
    expect(m.criteria[0]?.key).toBe("M1/one");
  });
  test.each([
    ["an unknown key", base.replace("observe:", "colour: red\n    observe:")],
    ["a bad level", base.replace("level: lite", "level: gold")],
    [
      "a bad pass bar",
      base.replace("requires: convention", "requires: advisory"),
    ],
    ["a bad since", base.replace("observe:", "since: soon\n    observe:")],
    [
      "a malformed probe",
      base.replace("observe:", "probe: { files: [] }\n    observe:"),
    ],
    [
      "a two-key probe",
      base.replace(
        "observe:",
        "probe: { files: [a], grep: { files: [a], pattern: x } }\n    observe:",
      ),
    ],
    [
      "a duplicate id",
      `${base}  - id: one\n    level: lite\n    requires: convention\n    statement: B.\n    observe: [b]\n`,
    ],
  ])("refuses %s", (_, text) => {
    expect(() => parseModule(text, "x.yaml")).toThrow();
  });
});

describe("probes", () => {
  const root = scratch;
  test("a glob without a slash matches the root only, in any letter case", () => {
    expect(matchGlob("AGENTS.md", "agents.md")).toBe(true);
    expect(matchGlob("AGENTS.md", "docs/AGENTS.md")).toBe(false);
    expect(matchGlob("**/GLOSSARY.md", "docs/glossary.md")).toBe(true);
  });
  test("files, any and all", () => {
    const files = ["AGENTS.md", ".github/workflows/ci.yml"];
    expect(evaluateProbe({ files: ["AGENTS.md"] }, files, root)).toEqual({
      met: true,
      evidence: "AGENTS.md",
    });
    const none = evaluateProbe({ files: ["lefthook.yml"] }, files, root);
    expect(none.met).toBe(false);
    expect(none.evidence).toContain("no tracked file matches lefthook.yml");
    expect(
      evaluateProbe(
        { any: [{ files: ["nope"] }, { files: [".github/workflows/*.yml"] }] },
        files,
        root,
      ).met,
    ).toBe(true);
    expect(
      evaluateProbe(
        { all: [{ files: ["nope"] }, { files: ["AGENTS.md"] }] },
        files,
        root,
      ).met,
    ).toBe(false);
  });
  test("grep reads the matching files", () => {
    const dir = repo({ "package.json": '{"devDependencies":{"husky":"9"}}' });
    expect(
      evaluateProbe(
        { grep: { files: ["package.json"], pattern: '"husky"' } },
        ["package.json"],
        dir,
      ).met,
    ).toBe(true);
    expect(
      evaluateProbe(
        { grep: { files: ["package.json"], pattern: '"lefthook"' } },
        ["package.json"],
        dir,
      ).met,
    ).toBe(false);
  });
  test("a file too large to search leaves the probe unchecked, never absent", () => {
    const dir = repo({ "package.json": `{"x":"${"a".repeat(1100 * 1024)}"}` });
    const big = { grep: { files: ["package.json"], pattern: '"husky"' } };
    const none = { files: ["lefthook.yml"] };
    const some = { files: ["package.json"] };
    const met = (probe: Parameters<typeof evaluateProbe>[0]) =>
      evaluateProbe(probe, ["package.json"], dir).met;
    expect(met(big)).toBeNull();
    expect(met({ any: [none, big] })).toBeNull();
    expect(met({ any: [some, big] })).toBe(true);
    expect(met({ all: [some, big] })).toBeNull();
    expect(met({ all: [none, big] })).toBe(false);
  });
  test("fixtures, templates and vendored code are not probed", () => {
    expect(
      probedFiles([
        "docs/adr/0001-x.md",
        "tests/fixtures/adr/0001-x.md",
        "modules/M5/templates/ADR-template.md",
        "vendor/x/AGENTS.md",
        "node_modules/y/AGENTS.md",
      ]),
    ).toEqual(["docs/adr/0001-x.md"]);
  });
});

describe("levels", () => {
  const m = parseModule(
    `module: M9
name: x
criteria:
  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }
  - { id: b, level: standard, requires: mechanical, statement: B., observe: [b] }
  - { id: c, level: strict, requires: convention, statement: C., observe: [c] }
`,
    "x.yaml",
  );
  const level = (a: Score, b: Score, c: Score) =>
    attained(
      m,
      new Map([
        ["M9/a", a],
        ["M9/b", b],
        ["M9/c", c],
      ] as [string, Score][]),
    );
  test("a level needs every criterion at it and below", () => {
    expect(level("absent", "mechanical", "convention")).toBe("none");
    expect(level("convention", "advisory", "convention")).toBe("lite");
    expect(level("convention", "mechanical", "absent")).toBe("standard");
    expect(level("mechanical", "expected-absent", "convention")).toBe("strict");
  });
  test("a module whose practice does not apply attains n/a, not strict", () => {
    expect(level("expected-absent", "expected-absent", "expected-absent")).toBe(
      "n/a",
    );
  });
  test("an unscored criterion leaves the level incomplete", () => {
    expect(attained(m, new Map([["M9/a", "convention" as Score]]))).toBeNull();
  });
});

describe("the checklist and the draft record", () => {
  test("probes score a missing precondition absent and point at what they found", () => {
    const dir = repo({
      ".gitlab-ci.yml": "test: {}\n",
      "tests/fixtures/docs/adr/0001-example.md": "# example\n",
    });
    const run = runScript("score.ts", ["--json"], dir);
    expect(run.code).toBe(0);
    const rows = JSON.parse(run.out) as {
      key: string;
      probe: string | null;
      evidence: string | null;
    }[];
    const row = (key: string) => rows.find((r) => r.key === key);
    expect(row("M1/ci-runs-gates-on-pr")).toMatchObject({
      probe: "found",
      evidence: ".gitlab-ci.yml",
    });
    expect(row("M1/precommit-autofix-hooks")?.probe).toBe("absent");
    // The fixture's decision record is not the repository's own.
    expect(row("M5/adrs-exist-numbered-from-template")?.probe).toBe("absent");
    expect(row("M0/gates-and-guardrails-listed")?.probe).toBeNull();

    const md = runScript("score.ts", [], dir).out;
    expect(md).toContain(
      "| Criterion | Level | Requires | Probe | Score | Evidence |",
    );
    expect(md.indexOf("## M2 ")).toBeLessThan(md.indexOf("## M10 "));
    // A probe's regular expression keeps its alternation inside one cell.
    const hooks = md
      .split("\n")
      .find((l) => l.startsWith("| precommit-autofix-hooks "));
    expect(hooks).toContain("\\|husky\\|");
    expect(hooks?.split(/(?<!\\)\|/).length).toBe(8);
  });

  test("the draft carries decided scores, prior answers and declines, and checks once filled", () => {
    const prior = `version: 1
plugin_version: 0.12.0
date: "2026-01-02"
commit: abc
shape: library
criteria:
  M0/universal-instruction-file: { score: convention, evidence: "AGENTS.md" }
declined:
  - refs: [M1/precommit-autofix-hooks]
    reason: The editor formats on save.
    revisit_when: CI formatting failures reach one a month.
`;
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".gitlab-ci.yml": "test: {}\n",
      ".config/jig-audit.yaml": prior,
    });
    const draft = join(scratch, "draft.yaml");
    const run = runScript(
      "score.ts",
      ["--draft", draft, "--date", "2026-10-12"],
      dir,
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain("prior record of 2026-01-02");
    const text = readFileSync(draft, "utf8");
    expect(text).toContain("# prior: convention: AGENTS.md");
    expect(text).toContain("# probe found: .gitlab-ci.yml");
    const record = parseRecord(text, draft);
    expect(record.date).toBe("2026-10-12");
    expect(record.shape).toBe("library");
    expect(record.declined).toHaveLength(1);
    expect(record.criteria.get("M1/precommit-autofix-hooks")?.score).toBe(
      "absent",
    );
    expect(
      record.criteria.get("M0/universal-instruction-file")?.score,
    ).toBeNull();
    const modules = loadModules();
    expect(
      checkRecord(record, modules).some((p) => p.endsWith("not scored")),
    ).toBe(true);

    // Filled in, it is complete.
    const filled = text
      .replace(/score: null/g, "score: convention")
      .replace(/evidence: null/g, 'evidence: "AGENTS.md"');
    expect(checkRecord(parseRecord(filled, draft), modules)).toEqual([]);
  });

  test("the draft never overwrites the prior record, by any path", () => {
    const dir = repo({ ".config/jig-audit.yaml": "version: 1\n" });
    const run = runScript(
      "score.ts",
      ["--draft", ".config/jig-audit.yaml"],
      dir,
    );
    expect(run.code).toBe(2);
    const link = join(scratch, "linked.yaml");
    symlinkSync(join(dir, ".config/jig-audit.yaml"), link);
    expect(runScript("score.ts", ["--draft", link], dir).code).toBe(2);
    expect(existsSync(join(dir, ".config/jig-audit.yaml"))).toBe(true);
    expect(readFileSync(join(dir, ".config/jig-audit.yaml"), "utf8")).toBe(
      "version: 1\n",
    );
  });

  test("a draft refuses tracked changes it would read instead of the commit", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    writeFileSync(join(dir, "AGENTS.md"), "# Changed\n");
    const run = runScript(
      "score.ts",
      ["--draft", join(scratch, "dirty.yaml")],
      dir,
    );
    expect(run.code).toBe(2);
    expect(run.err).toContain("tracked files differ from HEAD (AGENTS.md)");
  });
});
