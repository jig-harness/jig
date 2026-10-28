/**
 * The whole-changelog check: each format's rules over a clean changelog and
 * one fixture per rule broken, the format deciding which rules run, and the
 * command as an agent or CI runs it.
 */
import { describe, expect, test } from "bun:test";
import {
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { COMMON_RULES } from "../scripts/lint-common-changelog.ts";
import { KEEP_RULES } from "../scripts/lint-keep-a-changelog.ts";
import {
  type Coverage,
  isDate,
  precedence,
  readChangelog,
} from "../scripts/lint-structure.ts";
import { changelogPath, lintResolved, RULES } from "../scripts/lint.ts";
import { release } from "../scripts/release.ts";
import {
  cleanEnv,
  commit,
  git,
  jigYaml,
  MANIFEST,
  repository,
  resolvedFor,
  temporary,
} from "./scratch.ts";

const fixtures = join(import.meta.dir, "fixtures", "lint");
const fixture = (format: string, name: string): string =>
  readFileSync(join(fixtures, format, `${name}.md`), "utf8");

const NONE: Coverage = { current: null, tagged: [] };

/** The rule ids `format`'s rules find in `text`, each once, in order. */
function ruleIds(
  format: keyof typeof RULES,
  text: string,
  coverage: Coverage = NONE,
  file = "CHANGELOG.md",
): string[] {
  const found = RULES[format](readChangelog(file, text), coverage);
  return [...new Set(found.map((f) => f.rule))];
}

interface Case {
  rule: string;
  fixture: string;
  coverage?: Coverage;
  file?: string;
}

const KEEP_CASES: Case[] = [
  { rule: KEEP_RULES.title.id, fixture: "title" },
  { rule: KEEP_RULES.semver.id, fixture: "semver-statement" },
  { rule: KEEP_RULES.unreleased.id, fixture: "unreleased-first" },
  { rule: KEEP_RULES.heading.id, fixture: "release-heading" },
  { rule: KEEP_RULES.date.id, fixture: "date" },
  { rule: KEEP_RULES.order.id, fixture: "release-order" },
  { rule: KEEP_RULES.duplicate.id, fixture: "duplicate-release" },
  { rule: KEEP_RULES.type.id, fixture: "change-type" },
  { rule: KEEP_RULES.grouped.id, fixture: "grouped" },
  { rule: KEEP_RULES.versionLink.id, fixture: "version-link" },
  { rule: KEEP_RULES.unreleasedLink.id, fixture: "unreleased-link" },
  {
    rule: KEEP_RULES.coverage.id,
    fixture: "clean",
    coverage: { current: "1.2.0", tagged: ["1.0.0", "0.9.0"] },
  },
];

const COMMON_CASES: Case[] = [
  { rule: COMMON_RULES.fileName.id, fixture: "clean", file: "docs/HISTORY.md" },
  { rule: COMMON_RULES.title.id, fixture: "title" },
  { rule: COMMON_RULES.content.id, fixture: "content" },
  { rule: COMMON_RULES.unreleased.id, fixture: "no-unreleased" },
  { rule: COMMON_RULES.heading.id, fixture: "release-heading" },
  { rule: COMMON_RULES.date.id, fixture: "date" },
  { rule: COMMON_RULES.order.id, fixture: "release-order" },
  { rule: COMMON_RULES.versionLink.id, fixture: "version-link" },
  { rule: COMMON_RULES.release.id, fixture: "release-content" },
  { rule: COMMON_RULES.notice.id, fixture: "notice" },
  { rule: COMMON_RULES.category.id, fixture: "category" },
  { rule: COMMON_RULES.categoryOrder.id, fixture: "category-order" },
  { rule: COMMON_RULES.list.id, fixture: "change-list" },
  { rule: COMMON_RULES.reference.id, fixture: "reference" },
  {
    rule: COMMON_RULES.coverage.id,
    fixture: "clean",
    coverage: { current: "2.1.0", tagged: ["1.0.0", "1.5.0", "2.1.0-rc.1"] },
  },
];

for (const [format, rules, cases] of [
  ["keep-a-changelog", KEEP_RULES, KEEP_CASES],
  ["common-changelog", COMMON_RULES, COMMON_CASES],
] as const)
  describe(`${format}'s rules`, () => {
    test("the clean changelog breaks none", () => {
      expect(ruleIds(format, fixture(format, "clean"))).toEqual([]);
    });

    test("every rule has a fixture that breaks it", () => {
      expect(cases.map((c) => c.rule).sort()).toEqual(
        Object.values(rules)
          .map((r) => r.id)
          .sort(),
      );
    });

    for (const c of cases)
      test(`${c.rule} is the one rule ${c.fixture}.md${c.coverage ? " with its coverage" : ""}${c.file ? ` named ${c.file}` : ""} breaks`, () => {
        expect(
          ruleIds(format, fixture(format, c.fixture), c.coverage, c.file),
        ).toEqual([c.rule]);
      });

    test("each rule cites its specification's section", () => {
      for (const rule of Object.values(rules)) {
        expect(rule.id.startsWith(`${format}/`)).toBe(true);
        expect(rule.url).toMatch(
          format === "keep-a-changelog"
            ? /^https:\/\/keepachangelog\.com\/en\/1\.1\.0\//
            : /^https:\/\/common-changelog\.org\//,
        );
        expect(rule.section.length).toBeGreaterThan(0);
      }
    });
  });

describe("the documentation", () => {
  const read = (file: string) =>
    readFileSync(join(import.meta.dir, "..", file), "utf8");

  test("the README lists every rule with its citation, and SKILL.md names each", () => {
    const readme = read("README.md");
    const skill = read("SKILL.md");
    for (const rule of [
      ...Object.values(KEEP_RULES),
      ...Object.values(COMMON_RULES),
    ]) {
      const row = readme
        .split("\n")
        .find((line) => line.startsWith(`| \`${rule.id}\` |`));
      expect([rule.id, row?.includes(rule.url)]).toEqual([rule.id, true]);
      const [format, name] = rule.id.split("/");
      const listed = skill
        .split("\n")
        .find((line) => line.includes(`\`${format}/`));
      expect([
        rule.id,
        listed?.includes(`\`${name}\``) || listed?.includes(`\`${rule.id}\``),
      ]).toEqual([rule.id, true]);
    }
  });
});

describe("findings", () => {
  test("name the file, the line, the rule and what to change, with the citation", () => {
    const [found] = RULES["keep-a-changelog"](
      readChangelog("CHANGELOG.md", fixture("keep-a-changelog", "change-type")),
      NONE,
    );
    expect(found).toEqual({
      rule: "keep-a-changelog/change-type",
      file: "CHANGELOG.md",
      line: 20,
      problem: '"### Bug fixes" is not a type of change',
      remedy:
        "use one of Added, Changed, Deprecated, Removed, Fixed, Security (Keep a Changelog 1.1.0, Types of changes: https://keepachangelog.com/en/1.1.0/#types)",
    });
  });

  test("coverage names each missing version once, prereleases aside in Common Changelog", () => {
    const found = RULES["common-changelog"](
      readChangelog("CHANGELOG.md", fixture("common-changelog", "clean")),
      { current: "2.1.0", tagged: ["1.5.0", "1.5.0", "2.1.0-rc.1", "2.0.0"] },
    );
    expect(found.map((f) => f.problem)).toEqual([
      "2.1.0, which the version files hold, has no release section",
      "1.5.0, which a tag names, has no release section",
    ]);
  });
});

describe("what each format allows", () => {
  test("Keep a Changelog: no Unreleased section, a yanked release, the change types in any order", () => {
    const text = fixture("keep-a-changelog", "clean")
      .replace(/## \[Unreleased\][\s\S]*?(?=## \[1\.1\.0\])/, "")
      .replace(/^\[Unreleased\]: .*\n/m, "");
    expect(text).not.toContain("Unreleased");
    expect(ruleIds("keep-a-changelog", text)).toEqual([]);
  });

  test("Keep a Changelog: a pre-release version, and Semantic Versioning named as semver", () => {
    const text = `# Changelog\n\nThis project follows semver.\n\n## [0.1.0-beta.1] - 2024-01-01\n\n### Added\n\n- A start.\n\n[0.1.0-beta.1]: https://example.com/r/releases/tag/v0.1.0-beta.1\n`;
    expect(
      ruleIds("keep-a-changelog", text, {
        current: null,
        tagged: ["0.1.0-beta.1"],
      }),
    ).toEqual([]);
  });

  test("Common Changelog: a release with only a notice, a version without a link, a later-dated lower version", () => {
    expect(
      ruleIds("common-changelog", fixture("common-changelog", "clean")),
    ).toEqual([]);
  });
});

describe("the format decides which rules run", () => {
  test("a Common Changelog file is never judged by Keep a Changelog's rules", () => {
    const text = fixture("common-changelog", "clean");
    // The file breaks Keep a Changelog's rules, so the absence of their
    // findings below is the dispatch, not a coincidence.
    expect(ruleIds("keep-a-changelog", text).length).toBeGreaterThan(0);
    const result = lint(
      repository({
        "CHANGELOG.md": text,
        "package.json": MANIFEST("2.0.0"),
        ".config/jig.yaml": jigYaml(
          "  file: CHANGELOG.md\n  format: common-changelog",
        ),
      }),
      ["--json"],
    );
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: "common-changelog",
      findings: [],
    });
  });

  test("a file that names Common Changelog is detected as it and held to its rules alone", () => {
    const text = fixture("common-changelog", "clean").replace(
      "# Changelog\n",
      "# Changelog\n\nIn the [Common Changelog](https://common-changelog.org/) format.\n",
    );
    const result = lint(
      repository({
        "CHANGELOG.md": text,
        "package.json": MANIFEST("2.0.0"),
        ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
      }),
      ["--json"],
    );
    expectSpawnExit(result, 1);
    const report = JSON.parse(result.stdout);
    expect(report.format).toBe("common-changelog");
    expect(report.findings.map((f: { rule: string }) => f.rule)).toEqual([
      "common-changelog/content",
    ]);
  });

  test("the configured format wins over what the file looks like", () => {
    const root = repository({
      "CHANGELOG.md": fixture("keep-a-changelog", "clean"),
      "package.json": MANIFEST("1.1.0"),
      ".config/jig.yaml": jigYaml(
        "  file: CHANGELOG.md\n  format: common-changelog",
      ),
    });
    const result = lint(root, ["--json"]);
    expectSpawnExit(result, 1);
    const rules: string[] = JSON.parse(result.stdout).findings.map(
      (f: { rule: string }) => f.rule,
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.startsWith("common-changelog/"))).toBe(true);
  });
});

describe("what the skill writes passes the check", () => {
  const templates = join(import.meta.dir, "..", "templates");
  const template = (name: string) =>
    readFileSync(join(templates, `${name}.md`), "utf8");

  test("each format's template, before its first release", () => {
    expect(ruleIds("keep-a-changelog", template("keep-a-changelog"))).toEqual(
      [],
    );
    expect(ruleIds("common-changelog", template("common-changelog"))).toEqual(
      [],
    );
  });

  for (const [format, changelog, version] of [
    ["common-changelog", template("common-changelog"), "1.0.0"],
    ["keep-a-changelog", fixture("keep-a-changelog", "clean"), "1.1.0"],
  ] as const)
    test(`a release the release step writes in ${format}`, async () => {
      const root = repository({
        "CHANGELOG.md": changelog,
        "package.json": MANIFEST(version),
      });
      git(root, "remote", "add", "origin", "https://github.com/o/r.git");
      commit(
        root,
        {
          "changes/a.md":
            "---\nrelease: minor\n---\n_Upgrade with care._\n\n### Fixed\n\n- Fix the parser\n\n### Added\n\n- Add the retry option\n",
          "changes/b.md":
            "---\nrelease: patch\n---\n### Changed\n\n- Speed up the cache\n",
        },
        "Add the retry option (#12)",
      );
      await release({
        ...resolvedFor(root, { format }),
        date: "2026-02-03",
      });
      expect(lintResolved(resolvedFor(root, { format })).findings).toEqual([]);
    });
});

describe("dates and versions", () => {
  test("a date is year-month-day and a real day", () => {
    expect(["2024-02-29", "2023-12-31"].map(isDate)).toEqual([true, true]);
    expect(
      ["2023-02-29", "2024-13-01", "2024-1-1", "01/01/2024", "2024-04-31"].map(
        isDate,
      ),
    ).toEqual([false, false, false, false, false]);
  });

  test("versions compare by Semantic Versioning precedence", () => {
    const sorted = [
      "1.0.0",
      "1.0.0-rc.1",
      "1.0.0-beta.11",
      "1.0.0-beta.2",
      "1.0.0-beta",
      "1.0.0-alpha.beta",
      "1.0.0-alpha.1",
      "1.0.0-alpha",
      "0.10.0",
      "0.9.1",
    ];
    expect([...sorted].reverse().sort((a, b) => precedence(b, a))).toEqual(
      sorted,
    );
    expect(precedence("1.0.0+build.1", "1.0.0")).toBe(0);
  });
});

const script = join(import.meta.dir, "..", "scripts", "lint.ts");

function lint(
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: cleanEnv({ JIG_HOME: temporary("jig-home-"), ...env }),
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

describe("the command", () => {
  const configured = (changelog: string, version = "1.1.0") =>
    repository({
      "CHANGELOG.md": changelog,
      "package.json": MANIFEST(version),
      ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
    });

  test("passes a clean changelog", () => {
    const result = lint(configured(fixture("keep-a-changelog", "clean")));
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("jig changelog lint (plugin ");
    expect(result.stdout).toContain(
      "changelog lint: OK — CHANGELOG.md follows Keep a Changelog 1.1.0's rules",
    );
  });

  test("reports each finding with its place, rule and fix, and exits 1", () => {
    const result = lint(configured(fixture("keep-a-changelog", "date")));
    expectSpawnExit(result, 1);
    expect(result.stderr).toContain(
      'CHANGELOG.md:28: [keep-a-changelog/date] the date "2023-02-29" of 1.0.1 is not a real day written year-month-day\n  fix: write the release date as YYYY-MM-DD (Keep a Changelog 1.1.0, Confusing Dates: https://keepachangelog.com/en/1.1.0/#confusing-dates)',
    );
    expect(result.stdout).toContain("changelog lint: 2 finding(s)");
  });

  test("annotates each finding in a GitHub Actions job", () => {
    const result = lint(
      configured(fixture("keep-a-changelog", "grouped")),
      [],
      {
        GITHUB_ACTIONS: "true",
      },
    );
    expectSpawnExit(result, 1);
    expect(result.stdout).toContain(
      "::error file=CHANGELOG.md,line=28,title=keep-a-changelog/grouped::",
    );
  });

  test("checks coverage against the version files and the tags in its history", () => {
    const root = configured(fixture("keep-a-changelog", "clean"), "1.2.0");
    git(root, "tag", "v0.9.0");
    git(root, "tag", "not-a-version");
    // A release made on a commit this checkout does not hold is not owed a
    // section here yet.
    git(root, "checkout", "-qb", "later");
    commit(root, { "later.txt": "later\n" }, "a later release");
    git(root, "tag", "v1.3.0");
    git(root, "checkout", "-q", "main");
    const result = lint(root, ["--json"]);
    expectSpawnExit(result, 1);
    expect(
      JSON.parse(result.stdout).findings.map(
        (f: { problem: string }) => f.problem,
      ),
    ).toEqual([
      "1.2.0, which the version files hold, has no release section",
      "0.9.0, which a tag names, has no release section",
    ]);
  });

  test("exits 2 when the version files disagree and nothing else is found", () => {
    const root = repository({
      "CHANGELOG.md": fixture("keep-a-changelog", "clean"),
      "package.json": MANIFEST("1.1.0"),
      VERSION: "1.0.0\n",
      ".config/jig.yaml": jigYaml(
        "  file: CHANGELOG.md\n  version:\n    files:\n      - { path: package.json, key: version }\n      - { path: VERSION }",
      ),
    });
    const result = lint(root);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain(
      "release coverage not checked against the version files: the version files disagree or hold no readable version: run status.ts to see them",
    );
  });

  test("says not configured, and passes, where the skill is off", () => {
    const root = repository({ "CHANGELOG.md": "not a changelog\n" });
    const result = lint(root);
    expectSpawnExit(result, 0);
    expect(result.stdout).toContain("not configured");
  });

  test("exits 2 on a usage error", () => {
    const result = lint(temporary(), ["--nope"]);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("--nope");
  });

  test.skipIf(
    skipsOnWindows("file-system", "creating a link needs a privilege"),
  )(
    "refuses a changelog that a link leads outside the repository, and exits 2",
    () => {
      const outside = join(temporary(), "CHANGELOG.md");
      writeFileSync(outside, fixture("keep-a-changelog", "clean"));
      const root = repository({
        "package.json": MANIFEST("1.1.0"),
        ".config/jig.yaml": jigYaml(
          "  file: CHANGELOG.md\n  format: keep-a-changelog",
        ),
      });
      symlinkSync(outside, join(root, "CHANGELOG.md"));
      expect(() => changelogPath(root, "CHANGELOG.md")).toThrow(
        "resolves outside the repository root",
      );
      const result = lint(root);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("resolves outside the repository root");
      expect(changelogPath(root, "package.json")).toBe(
        join(realpathSync(root), "package.json"),
      );
    },
  );
});
