import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  MODULE_IDS,
  parseModule,
  probedFiles,
  type Score,
} from "../scripts/lib/criteria.ts";
import {
  type AuditRecord,
  checkRecord,
  decidedByProbe,
  parseRecord,
} from "../scripts/lib/record.ts";
import { loadProfiles } from "../scripts/lib/profiles.ts";
import { matchGlob } from "../scripts/lib/repo.ts";
import { commitFiles, git, runScript, scratchRepo } from "./helpers.ts";

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
  test("every module carries well-formed criteria", () => {
    const run = runScript("score.ts", ["--check"], scratch);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`All ${MODULE_IDS.length} modules`);
    const modules = loadModules();
    expect(modules.map((m) => m.module)).toEqual([...MODULE_IDS]);
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
      "module: M0\nname: empty\npurpose: P.\ncriteria: []\n",
    );
    const run = runScript("score.ts", ["--check", "--criteria", dir], scratch);
    expect(run.code).toBe(1);
    expect(run.out).toContain("EMPTY: M0");
    expect(run.out).toContain("MISSING: M1");
  });

  test("a module has one file, named after what it declares", () => {
    const one = (module: string, name: string) =>
      `module: ${module}\nname: ${name}\npurpose: P.\ncriteria:\n  - { id: a, level: lite, requires: convention, statement: A., observe: [a] }\n`;
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
purpose: P.
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
  test("parses a rung's probe at the top and under a top-level all", () => {
    const probe = (p: string) =>
      parseModule(
        base.replace("observe:", `probe: ${p}\n    observe:`),
        "x.yaml",
      ).criteria[0]?.probe;
    expect(probe("{ mechanical: { files: [a] } }")).toEqual({
      rung: "mechanical",
      needs: { files: ["a"] },
    });
    expect(
      probe("{ all: [{ files: [a] }, { advisory: { files: [b] } }] }"),
    ).toEqual({
      all: [{ files: ["a"] }, { rung: "advisory", needs: { files: ["b"] } }],
    });
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
      "a rung's probe inside any",
      base.replace(
        "observe:",
        "probe: { any: [{ mechanical: { files: [a] } }, { files: [b] }] }\n    observe:",
      ),
    ],
    [
      "a rung no score lies beneath",
      base.replace(
        "observe:",
        "probe: { convention: { files: [a] } }\n    observe:",
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
  test("a rung's probe caps the score instead of ruling every rung out", () => {
    const files = ["docs/README.md"];
    const ci = { files: [".github/workflows/*.yml"] };
    const docs = { files: ["docs/**"] };
    expect(
      evaluateProbe({ rung: "mechanical", needs: ci }, files, root),
    ).toEqual({
      met: true,
      evidence: "",
      atMost: {
        rung: "advisory",
        evidence: "no tracked file matches .github/workflows/*.yml",
      },
    });
    const both = evaluateProbe(
      { all: [docs, { rung: "mechanical", needs: ci }] },
      files,
      root,
    );
    expect(both).toMatchObject({ met: true, evidence: "docs/README.md" });
    expect(both.atMost?.rung).toBe("advisory");
    // A missing condition no rung qualifies still rules every rung out.
    const none = evaluateProbe(
      { all: [{ files: ["nope"] }, { rung: "mechanical", needs: ci }] },
      files,
      root,
    );
    expect(none.met).toBe(false);
    expect(none.atMost).toBeUndefined();
    // Held, it caps nothing.
    expect(
      evaluateProbe({ rung: "mechanical", needs: docs }, files, root).atMost,
    ).toBeUndefined();
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
purpose: P.
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
    // The score a probe decided carries the probe's mark, as in the draft.
    expect(hooks?.split(/(?<!\\)\|/)[6]?.trim()).toStartWith(
      "probe: no tracked file matches",
    );
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
    const decided = record.criteria.get("M1/precommit-autofix-hooks");
    expect(decided?.score).toBe("absent");
    // Marked as the probe's, so the sheet can tell it from the agent's scores.
    expect(decided?.evidence).toStartWith("probe: no tracked file matches");
    expect(decidedByProbe(decided)).toBe(true);
    expect(decidedByProbe(record.criteria.get("M1/ci-runs-gates-on-pr"))).toBe(
      false,
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

  test("without CI, a check CI would enforce stays open, capped below mechanical", () => {
    const dir = repo({ "docs/README.md": "# Docs\n" });
    const run = runScript("score.ts", ["--json"], dir);
    const rows = JSON.parse(run.out) as {
      key: string;
      probe: string | null;
      evidence: string | null;
      atMost?: string;
    }[];
    expect(
      rows.find((r) => r.key === "M4/frontmatter-machine-validated"),
    ).toMatchObject({ probe: "capped", atMost: "advisory" });
    // A criterion about CI itself is still ruled out.
    expect(rows.find((r) => r.key === "M1/ci-runs-gates-on-pr")?.probe).toBe(
      "absent",
    );
    const path = join(scratch, "capped.yaml");
    expect(
      runScript("score.ts", ["--draft", path, "--examine-all"], dir).code,
    ).toBe(0);
    const text = readFileSync(path, "utf8");
    expect(
      parseRecord(text, path).criteria.get("M4/frontmatter-machine-validated")
        ?.score,
    ).toBeNull();
    expect(text).toMatch(
      /# probe capped: no tracked file matches \.github\/workflows.*; at most advisory/,
    );
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

describe("a draft scoped to a profile", () => {
  const modules = loadModules();
  const keys = (pick: (key: string, level: string) => boolean) =>
    modules
      .flatMap((m) => m.criteria)
      .filter((c) => pick(c.key, c.level))
      .map((c) => c.key);
  const draftIn = (dir: string, name: string, args: string[]) => {
    const path = join(scratch, name);
    const run = runScript(
      "score.ts",
      ["--draft", path, "--date", "2026-10-12", ...args],
      dir,
    );
    return { run, path };
  };
  const read = (path: string): AuditRecord =>
    parseRecord(readFileSync(path, "utf8"), path);
  const scoreOf = (r: AuditRecord, key: string) => r.criteria.get(key)?.score;
  const unexamined = (r: AuditRecord) =>
    [...r.criteria].filter(([, e]) => e.score === "not-examined").length;

  test("leaves every criterion beyond the target not examined, and says how many", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const { run, path } = draftIn(dir, "solo.yaml", ["--profile", "solo-lite"]);
    expect(run.code).toBe(0);
    const record = read(path);
    const beyond = record.criteria.get("M0/per-directory-instructions");
    expect(beyond).toEqual({
      score: "not-examined",
      evidence: "not examined: beyond the Solo/Lite target",
    });
    // Within the target, it is left for the agent.
    expect(scoreOf(record, "M0/universal-instruction-file")).toBeNull();
    // A module the profile does not target is beyond it at every level.
    for (const key of keys((k) => k.startsWith("M12/")))
      expect(
        decidedByProbe(record.criteria.get(key)) ||
          scoreOf(record, key) === "not-examined",
      ).toBe(true);
    // A probe's absent stands, beyond the target too.
    const probed = record.criteria.get("M5/adrs-exist-numbered-from-template");
    expect(decidedByProbe(probed)).toBe(true);
    expect(run.out).toContain(
      `${unexamined(record)} left not examined beyond the Solo/Lite target`,
    );
    // The scope is the audit's, not a profile the team declared.
    expect(record.profile).toBeUndefined();
    expect(readFileSync(path, "utf8")).toMatch(
      /^profile: null {3}# .*: set it when the team chose one \(score\.ts --declare does\); otherwise leave null and put a suggested profile in the report source$/m,
    );
    // Filled within the target, the draft checks with no profile declared.
    const filled = readFileSync(path, "utf8")
      .replace(/score: null/g, "score: convention")
      .replace(/evidence: null/g, 'evidence: "AGENTS.md"');
    expect(checkRecord(parseRecord(filled, path), modules)).toEqual([]);
  });

  test("counts a listed condition and the heading-to profile's targets as targets", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const { run, path } = draftIn(dir, "team.yaml", [
      "--profile",
      "team-standard",
      "--conditions",
      "M12",
      "--heading-to",
      "regulated-strict",
    ]);
    expect(run.code).toBe(0);
    const record = read(path);
    expect(scoreOf(record, "M12/branch-reuse-and-footgun-bans-written")).toBe(
      null,
    );
    expect(scoreOf(record, "M12/port-allocation-scripted")).toBe(
      "not-examined",
    );
    // Regulated/Strict aims M0 at strict, beyond Team/Standard's standard.
    expect(scoreOf(record, "M0/instruction-set-owned")).toBeNull();
    // M3's condition was not listed.
    for (const key of keys((k) => k.startsWith("M3/")))
      expect(
        decidedByProbe(record.criteria.get(key)) ||
          scoreOf(record, key) === "not-examined",
      ).toBe(true);
  });

  test("takes the prior record's profile unless told to examine everything", () => {
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".config/jig-audit.yaml":
        'version: 1\nplugin_version: 0.12.0\ndate: "2026-01-02"\ncommit: abc\nprofile: solo-lite\ncriteria: {}\n',
    });
    const inherited = draftIn(dir, "inherited.yaml", []);
    expect(inherited.run.code).toBe(0);
    const record = read(inherited.path);
    expect(record.profile).toBe("solo-lite");
    expect(scoreOf(record, "M0/per-directory-instructions")).toBe(
      "not-examined",
    );
    const all = draftIn(dir, "all.yaml", ["--examine-all"]);
    expect(all.run.code).toBe(0);
    expect(unexamined(read(all.path))).toBe(0);
  });

  test.each([
    ["an unknown profile", ["--profile", "enterprise"], "is not one of"],
    [
      "a condition the profile does not have",
      ["--profile", "solo-lite", "--conditions", "M12"],
      "Solo/Lite has no conditional target for M12",
    ],
    ["conditions without a profile", ["--conditions", "M12"], "need --profile"],
  ])("refuses %s", (_, args, message) => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const { run, path } = draftIn(dir, "refused.yaml", args);
    expect(run.code).toBe(2);
    expect(run.err).toContain(message);
    expect(existsSync(path)).toBe(false);
  });

  test("another --profile adds its targets to the declared profile's, which the draft keeps", () => {
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".config/jig-audit.yaml":
        'version: 1\nplugin_version: 0.12.0\ndate: "2026-01-02"\ncommit: abc\nprofile: team-standard\ncriteria: {}\n',
    });
    const { run, path } = draftIn(dir, "lower.yaml", [
      "--profile",
      "solo-lite",
    ]);
    expect(run.code).toBe(0);
    const record = read(path);
    expect(record.profile).toBe("team-standard");
    // Team/Standard's targets stay examined though Solo/Lite does not reach them.
    expect(scoreOf(record, "M0/per-directory-instructions")).toBeNull();
    expect(run.out).toContain("beyond the Solo/Lite and Team/Standard target");
    // Filled where it was left open, the draft checks against the profile it declares.
    const filled = readFileSync(path, "utf8")
      .replace(/score: null/g, "score: convention")
      .replace(/evidence: null/g, 'evidence: "AGENTS.md"');
    expect(checkRecord(parseRecord(filled, path), modules)).toEqual([]);
  });

  test("other conditions on the declared profile add to the declared ones, which the draft keeps", () => {
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".config/jig-audit.yaml":
        'version: 1\nplugin_version: 0.12.0\ndate: "2026-01-02"\ncommit: abc\nprofile: team-standard\nprofile_conditions: [M12]\ncriteria: {}\n',
    });
    const { run, path } = draftIn(dir, "narrowed.yaml", [
      "--profile",
      "team-standard",
      "--conditions",
      "M3",
    ]);
    expect(run.code).toBe(0);
    const record = read(path);
    expect(record.profile_conditions).toEqual(["M12"]);
    // M12's declared condition stays examined though --conditions names M3.
    expect(scoreOf(record, "M12/branch-reuse-and-footgun-bans-written")).toBe(
      null,
    );
    const filled = readFileSync(path, "utf8")
      .replace(/score: null/g, "score: convention")
      .replace(/evidence: null/g, 'evidence: "AGENTS.md"');
    expect(
      checkRecord(parseRecord(filled, path), modules, loadProfiles(modules)),
    ).toEqual([]);
  });

  test("--declare records the profile, conditions and heading-to profile the flags name", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const { run, path } = draftIn(dir, "declared.yaml", [
      "--profile",
      "team-standard",
      "--conditions",
      "M12",
      "--heading-to",
      "regulated-strict",
      "--declare",
    ]);
    expect(run.code).toBe(0);
    const record = read(path);
    expect(record.profile).toBe("team-standard");
    expect(record.profile_conditions).toEqual(["M12"]);
    expect(record.heading_to).toBe("regulated-strict");
    // Filled where it was left open, the draft checks against what it declares.
    const filled = readFileSync(path, "utf8")
      .replace(/score: null/g, "score: convention")
      .replace(/evidence: null/g, 'evidence: "AGENTS.md"');
    expect(
      checkRecord(parseRecord(filled, path), modules, loadProfiles(modules)),
    ).toEqual([]);
  });

  test("--declare replaces the prior record's profile, whose targets it no longer examines", () => {
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".config/jig-audit.yaml":
        'version: 1\nplugin_version: 0.12.0\ndate: "2026-01-02"\ncommit: abc\nprofile: team-standard\nprofile_conditions: [M12]\ncriteria: {}\n',
    });
    const { run, path } = draftIn(dir, "redeclared.yaml", [
      "--profile",
      "solo-lite",
      "--declare",
    ]);
    expect(run.code).toBe(0);
    const record = read(path);
    expect(record.profile).toBe("solo-lite");
    expect(record.profile_conditions).toBeUndefined();
    expect(scoreOf(record, "M0/per-directory-instructions")).toBe(
      "not-examined",
    );
    expect(run.out).toContain("beyond the Solo/Lite target");
  });

  test("keeps a prior score beyond the target as the comment of the criterion it leaves unexamined", () => {
    const dir = repo({
      "AGENTS.md": "# Agents\n",
      ".config/jig-audit.yaml":
        'version: 1\nplugin_version: 0.12.0\ndate: "2026-01-02"\ncommit: abc\nprofile: null\ncriteria:\n  M0/per-directory-instructions: { score: convention, evidence: "src/AGENTS.md extends the root file" }\n',
    });
    const { run, path } = draftIn(dir, "narrowing.yaml", [
      "--profile",
      "solo-lite",
    ]);
    expect(run.code).toBe(0);
    const text = readFileSync(path, "utf8");
    const entry = text.slice(text.indexOf("  M0/per-directory-instructions:"));
    expect(entry).toMatch(
      /^ {2}M0\/per-directory-instructions:.*\n {4}# .*\n {4}# prior: convention: src\/AGENTS\.md extends the root file\n {4}score: not-examined\n/,
    );
  });

  test("--declare without --profile is a usage error", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const { run, path } = draftIn(dir, "undeclared.yaml", ["--declare"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--declare needs --profile");
    expect(existsSync(path)).toBe(false);
  });

  test("a profile without a draft is a usage error", () => {
    const run = runScript("score.ts", ["--profile", "solo-lite"], scratch);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--profile needs --draft");
  });
});

describe("a draft of another commit", () => {
  test("scores the revision --at names while the checkout is dirty, and keeps its snapshot for the audit", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const before = git(dir, "rev-parse", "HEAD");
    commitFiles(dir, { ".gitlab-ci.yml": "test: {}\n" });
    writeFileSync(join(dir, "AGENTS.md"), "# Changed\n");

    const dirty = runScript(
      "score.ts",
      ["--draft", join(scratch, "dirty-at.yaml")],
      dir,
    );
    expect(dirty.code).toBe(2);
    expect(dirty.err).toContain("--at HEAD");

    const path = join(scratch, "at.yaml");
    const run = runScript("score.ts", ["--draft", path, "--at", "HEAD~1"], dir);
    expect(run.code).toBe(0);
    const record = parseRecord(readFileSync(path, "utf8"), path);
    expect(record.commit).toBe(before);
    // The probes read the earlier commit, which had no CI configuration.
    expect(decidedByProbe(record.criteria.get("M1/ci-runs-gates-on-pr"))).toBe(
      true,
    );
    // The snapshot outlives the script, so the surveys read the same commit,
    // and the draft and its line name it with the command that removes it.
    const snapshot = /^# snapshot: (.+)$/m.exec(
      readFileSync(path, "utf8"),
    )?.[1];
    expect(snapshot).toBeDefined();
    const kept = snapshot ?? "";
    // Under its real path, which some install scripts insist on.
    expect(kept).toBe(realpathSync(kept));
    expect(existsSync(join(kept, ".gitlab-ci.yml"))).toBe(false);
    expect(readFileSync(join(kept, "AGENTS.md"), "utf8")).toBe("# Agents\n");
    expect(run.out).toContain(`snapshot of ${before.slice(0, 12)}: ${kept}`);
    expect(run.out).toContain(`git worktree remove --force ${kept}`);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# Changed\n");
    git(dir, "worktree", "remove", "--force", kept);
    expect(existsSync(kept)).toBe(false);
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(
      "detached",
    );

    const head = runScript(
      "score.ts",
      ["--draft", join(scratch, "at-head.yaml"), "--at", "HEAD"],
      dir,
    );
    expect(head.code).toBe(0);
    expect(
      parseRecord(
        readFileSync(join(scratch, "at-head.yaml"), "utf8"),
        "at-head.yaml",
      ).commit,
    ).toBe(git(dir, "rev-parse", "HEAD"));
    git(
      dir,
      "worktree",
      "remove",
      "--force",
      /^# snapshot: (.+)$/m.exec(
        readFileSync(join(scratch, "at-head.yaml"), "utf8"),
      )?.[1] ?? "",
    );
  });

  test("refuses a revision the repository does not have", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const run = runScript(
      "score.ts",
      ["--draft", join(scratch, "nowhere.yaml"), "--at", "no-such-branch"],
      dir,
    );
    expect(run.code).toBe(2);
    expect(run.err).toContain("--at no-such-branch: no such commit");
  });

  test("removes the snapshot when the draft cannot be written", () => {
    const dir = repo({ "AGENTS.md": "# Agents\n" });
    const run = runScript(
      "score.ts",
      ["--draft", join(scratch, "no-such-dir", "at.yaml"), "--at", "HEAD"],
      dir,
    );
    expect(run.code).toBe(2);
    expect(run.err).toContain("cannot write the draft");
    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(
      "detached",
    );
  });
});
