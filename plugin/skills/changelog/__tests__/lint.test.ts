/**
 * The whole-changelog check: each format's rules over a clean changelog and
 * one fixture per rule broken, the format deciding which rules run, and the
 * command as an agent or CI runs it.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
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

describe("Unreleased headings and nested changes read as they render", () => {
  test("an Unreleased heading with escaped brackets is the Unreleased section", () => {
    // It is the Unreleased section, not a release heading, and its escaped
    // brackets link nowhere, whatever `[Unreleased]:` defines.
    expect(keepWith("## [Unreleased]", String.raw`## \[Unreleased\]`)).toEqual([
      KEEP_RULES.unreleasedLink.id,
    ]);
    expect(
      commonWith(
        "# Changelog\n",
        String.raw`# Changelog

## \[Unreleased\]

_Next._
`,
      ),
    ).toEqual([COMMON_RULES.unreleased.id]);
  });

  test("a list nested in a change belongs to it", () => {
    const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";
    expect(commonWith(item, `${item}\n  - with a detail`)).toEqual([]);
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

  test("a year below 100 is a real year, and a number past 2^53 compares exactly", () => {
    expect(["0099-01-01", "0001-02-28"].map(isDate)).toEqual([true, true]);
    expect(isDate("0099-02-29")).toBe(false);
    expect(
      precedence("9007199254740993.0.0", "9007199254740992.0.0"),
    ).toBeGreaterThan(0);
    expect(
      precedence("1.0.0-9007199254740993", "1.0.0-9007199254740992"),
    ).toBeGreaterThan(0);
    expect(precedence("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });
});

/** The rule ids Common Changelog's rules find in its clean fixture with `from` replaced by `to`. */
function commonWith(from: string, to: string): string[] {
  const common = fixture("common-changelog", "clean");
  expect(common).toContain(from);
  return ruleIds("common-changelog", common.replace(from, to));
}

/** The rule ids Keep a Changelog's rules find in its clean fixture with `from` replaced by `to`. */
function keepWith(from: string, to: string): string[] {
  const keep = fixture("keep-a-changelog", "clean");
  expect(keep).toContain(from);
  return ruleIds("keep-a-changelog", keep.replace(from, to));
}

describe("headings and definitions read as Markdown writes them", () => {
  test("a version heading may be an inline link or any reference link", () => {
    expect(
      commonWith(
        "## [2.0.0] - 2024-03-01",
        "## [2.0.0](https://example.com/o/r/releases/tag/v2.0.0) - 2024-03-01",
      ),
    ).toEqual([]);
    expect(
      commonWith("## [1.10.0] - 2024-04-01", "## [1.10.0][r1100] - 2024-04-01"),
    ).toEqual([COMMON_RULES.versionLink.id]);
    expect(
      commonWith(
        "## [1.10.0] - 2024-04-01",
        "## [1.10.0][r1100] - 2024-04-01\n\n[r1100]: https://example.com/o/r/releases/tag/v1.10.0",
      ),
    ).toEqual([]);
    expect(
      keepWith(
        "## [1.0.0] - 2024-01-01",
        "## [1.0.0](https://example.com/r/releases/tag/v1.0.0) - 2024-01-01",
      ),
    ).toEqual([]);
  });

  test("a plain Keep a Changelog version is a release heading that does not link", () => {
    expect(
      keepWith("## [1.0.0] - 2024-01-01", "## 1.0.0 - 2024-01-01"),
    ).toEqual([KEEP_RULES.versionLink.id]);
  });

  test("a definition may be indented, spaced out and titled", () => {
    expect(
      commonWith(
        "[2.0.0]: https://example.com/o/r/releases/tag/v2.0.0\n[1.10.0]: https://example.com/o/r/releases/tag/v1.10.0",
        '  [2.0.0]:   https://example.com/o/r/releases/tag/v2.0.0 "2.0.0"\n[1.10.0]:\t<https://example.com/o/r/releases/tag/v1.10.0>',
      ),
    ).toEqual([]);
  });

  test("a definition may put its destination and title on lines of their own", () => {
    expect(
      commonWith(
        "[1.9.0]: https://example.com/o/r/releases/tag/v1.9.0",
        "[1.9.0]:\n  https://example.com/o/r/releases/tag/v1.9.0\n  (1.9.0)",
      ),
    ).toEqual([]);
  });

  test("a destination must be one Markdown reads as one", () => {
    const found = commonWith(
      "[1.9.0]: https://example.com/o/r/releases/tag/v1.9.0",
      "[1.9.0]: <https://example.com/o/r/releases/tag/v1.9.0>garbage",
    );
    expect(found).toContain(COMMON_RULES.versionLink.id);
  });

  test("an inline version link may hold balanced parentheses and a parenthesized title", () => {
    for (const heading of [
      "## [2.0.0](https://example.com/o/r/release_(stable)) - 2024-03-01",
      "## [2.0.0](https://example.com/o/r/releases/tag/v2.0.0 (Release)) - 2024-03-01",
    ])
      expect(commonWith("## [2.0.0] - 2024-03-01", heading)).toEqual([]);
  });

  test("a title, a list and its items may be indented up to three spaces", () => {
    expect(commonWith("# Changelog", "   # Changelog")).toEqual([]);
    expect(keepWith("# Changelog", " # Changelog")).toEqual([]);
    expect(
      commonWith(
        "- Fix the parser ([#7](https://example.com/o/r/pull/7))",
        "  - Fix the parser ([#7](https://example.com/o/r/pull/7))",
      ),
    ).toEqual([]);
    expect(
      commonWith(
        "- Fix the parser ([#7](https://example.com/o/r/pull/7))",
        "  - Fix the parser",
      ),
    ).toEqual([COMMON_RULES.reference.id]);
  });
});

describe("changes and notices read as they render", () => {
  test("a reference is a link that renders, after the change's text", () => {
    const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";
    for (const broken of [
      "- Fix the parser `([#7](https://example.com/o/r/pull/7))`",
      "- Fix the parser ([#7][missing])",
      "- Fix the parser ([#7](https://example.com/o/r/pull/7)",
      "- ([#7](https://example.com/o/r/pull/7))",
      "- Fix the parser <!-- ([#7](https://example.com/o/r/pull/7)) -->",
      "- Fix the parser\n\n      ([#7](https://example.com/o/r/pull/7))",
      "- Fix the parser ([#7](https://example.com/o/r/pull/7)) ([#8][missing])",
      "- Fix the parser (![#7](https://example.com/o/r/pull/7))",
    ])
      expect(commonWith(item, broken)).toEqual([COMMON_RULES.reference.id]);
    for (const linked of [
      "- Fix the parser ([#7][pr-7])\n\n[pr-7]: https://example.com/o/r/pull/7",
      "- Fix the parser ([`abc1234`])\n\n[`abc1234`]: https://example.com/o/r/commit/abc1234",
      '- Fix the parser ([#7](<https://example.com/o/r/pull/7> "#7"))',
      "- Fix the parser (<https://example.com/o/r/pull/7>)",
    ])
      expect(commonWith(item, linked)).toEqual([]);
  });

  test("text after a fence that closes inside a change is outside the list", () => {
    const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";
    expect(
      commonWith(
        item,
        `${item}\n\n  \`\`\`\n  code\n  \`\`\`\nOutside the list.`,
      ),
    ).toEqual([COMMON_RULES.list.id]);
    expect(commonWith(item, `${item}\nwrapped onto a lazy line.`)).toEqual([]);
  });

  test("a fence outside the list is not part of a change", () => {
    const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";
    expect(commonWith(item, `${item}\n\n \`\`\`\n code\n \`\`\``)).toEqual([
      COMMON_RULES.list.id,
    ]);
    expect(commonWith(item, `${item}\n\n  \`\`\`\n  code\n  \`\`\``)).toEqual(
      [],
    );
    expect(commonWith(item, `${item}\n\n not indented to the item`)).toEqual([
      COMMON_RULES.list.id,
    ]);
  });

  test("a notice is one paragraph to its end, not only at its first line", () => {
    for (const after of ["> a quote", "***"])
      expect(
        commonWith("_First release._", `_First release._\n${after}`),
      ).toEqual([COMMON_RULES.release.id]);
    // A setext underline makes the notice a heading, which leaves the release
    // empty and is read as what it renders: a release heading, or a title.
    expect(commonWith("_First release._", "_First release._\n---")).toEqual([
      COMMON_RULES.release.id,
      COMMON_RULES.heading.id,
    ]);
    expect(commonWith("_First release._", "_First release._\n===")).toEqual([
      COMMON_RULES.release.id,
      COMMON_RULES.content.id,
    ]);
    expect(
      commonWith("_First release._", "_First release,\nwrapped._"),
    ).toEqual([]);
  });
});

describe("orders, links and statements read as they render", () => {
  test("versions that differ only in build metadata may sit in either order", () => {
    const last = "## 1.0.0 - 2023-06-01\n\n_First release._";
    expect(
      commonWith(
        last,
        "## 1.0.0+windows - 2023-06-01\n\n_On Windows._\n\n## 1.0.0+linux - 2023-06-01\n\n_On Linux._",
      ),
    ).toEqual([]);
    expect(
      commonWith(
        last,
        "## 1.0.0+linux - 2023-06-01\n\n_On Linux._\n\n## 1.0.0+windows - 2023-06-01\n\n_On Windows._\n\n## 1.0.0+linux - 2023-06-01\n\n_Again._",
      ),
    ).toEqual([COMMON_RULES.order.id]);
  });

  test("the Unreleased link compares the newest release's own tag with HEAD", () => {
    const link = "[Unreleased]: https://example.com/r/compare/v1.1.0...HEAD";
    for (const broken of [
      "[Unreleased]: https://example.com/r/compare/v11.1.0...HEAD",
      "[Unreleased]: https://example.com/r/releases/tag/v1.1.0#HEAD",
      "[Unreleased]: https://example.com/r/compare/HEAD...v1.1.0",
    ])
      expect(keepWith(link, broken)).toEqual([KEEP_RULES.unreleasedLink.id]);
    expect(
      keepWith(link, "[Unreleased]: https://example.com/r/compare/1.1.0..HEAD"),
    ).toEqual([]);
  });

  test("the Semantic Versioning statement is text that renders", () => {
    const statement =
      "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).";
    for (const hidden of [
      "<!-- semver -->",
      "<!--\n\nsemver\n\n-->",
      "```text\nsemver\n```",
      "`semver`",
      "and this project adheres to [a policy](https://semver.org/).",
      "and this project adheres to a policy.\n\n[policy]: https://semver.org/",
    ])
      expect(keepWith(statement, hidden)).toEqual([KEEP_RULES.semver.id]);
  });
});

describe("the parser decides what renders, not the source", () => {
  const item = "- Fix the parser ([#7](https://example.com/o/r/pull/7))";
  const unreleased =
    "[Unreleased]: https://example.com/r/compare/v1.1.0...HEAD";
  const compare = "https://example.com/r/compare/v1.1.0...HEAD";

  test("the Unreleased link is the destination its heading links to", () => {
    const without = (heading: string, definitions: string) =>
      ruleIds(
        "keep-a-changelog",
        fixture("keep-a-changelog", "clean")
          .replace("## [Unreleased]", heading)
          .replace(unreleased, definitions),
      );
    expect(without(`## [Unreleased](${compare})`, "")).toEqual([]);
    expect(without("## [Unreleased][next]", `[next]: ${compare}`)).toEqual([]);
    expect(
      without(
        "## [Unreleased][next]",
        `${unreleased}\n[next]: https://example.com/r/compare/v1.0.0...HEAD`,
      ),
    ).toEqual([KEEP_RULES.unreleasedLink.id]);
  });

  test("a definition is one wherever Markdown reads one, and nowhere else", () => {
    const release = "[1.0.0]: https://example.com/r/releases/tag/v1.0.0";
    expect(
      keepWith(
        release,
        '[1.0.0]: https://example.com/r/releases/tag/v1.0.0 "\nfirst\nsecond\nthird\n"',
      ),
    ).toEqual([]);
    expect(
      keepWith(release, "<!--\n\n[1.0.0]: https://example.com/release\n\n-->"),
    ).toEqual([KEEP_RULES.versionLink.id]);
    // A heading line interrupts the paragraph a definition is read from, so
    // it renders as a release, and the definition after it is paragraph text.
    expect(
      ruleIds(
        "keep-a-changelog",
        fixture("keep-a-changelog", "clean").replace(
          release,
          `${release}\n[meta]: /url "\n## [9.9.9] - 2024-01-01\n"\n[9.9.9]: /release`,
        ),
        { current: null, tagged: ["9.9.9"] },
      ),
    ).toEqual([KEEP_RULES.versionLink.id]);
  });

  test("a change's text is what renders: entities, nested links, tabs, comments", () => {
    for (const broken of [
      "- Fix the parser ([outer [#7](https://example.com/o/r/pull/7)](https://example.com/outer))",
      "- Fix the parser ()",
      "- Fix the parser ()",
    ])
      expect(commonWith(item, broken)).toEqual([COMMON_RULES.reference.id]);
    for (const linked of [
      "- Fix the parser &#40;[#7](https://example.com/o/r/pull/7)&#41;",
      "-\tFix the parser\n\n    ([#7](https://example.com/o/r/pull/7))",
      // An inline comment does not open across a blank line, so the link renders.
      "- Fix the parser <!--\n\n  ([#7](https://example.com/o/r/pull/7))\n\n  -->",
    ])
      expect(commonWith(item, linked)).toEqual([]);
    expect(
      keepWith("[Semantic Versioning]", "[Semantic&#32;Versioning]"),
    ).toEqual([]);
  });

  test("a reference with many entries is read in linear time", () => {
    const entries = "\t,[#1](u)".repeat(20_000) + "\t,\uE001".repeat(40);
    const started = performance.now();
    expect(commonWith(item, `- Fix the parser (\uE001${entries}`)).toEqual([
      COMMON_RULES.reference.id,
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

const script = join(import.meta.dir, "..", "scripts", "lint.ts");

function lint(
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  // A deadline, so a read that blocks (a named pipe) fails rather than hangs.
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: cleanEnv({ JIG_HOME: temporary("jig-home-"), ...env }),
    timeout: 30_000,
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** A repository whose skill is on, holding `changelog` and a manifest at `version`. */
const configured = (changelog: string, version = "1.1.0"): string =>
  repository({
    "CHANGELOG.md": changelog,
    "package.json": MANIFEST(version),
    ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
  });

describe("the command", () => {
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
});

describe("the command, where coverage or the file cannot be read", () => {
  test("exits 2 on a shallow clone, whose tags are not the whole history", () => {
    const origin = configured(fixture("keep-a-changelog", "clean"));
    commit(origin, { "later.txt": "later\n" }, "a later commit");
    const clone = temporary();
    git(clone, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    const result = lint(clone);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain(
      "release coverage not checked against the tags: the checkout is a shallow clone",
    );
  });

  test("exits 2 when git cannot list the tags, rather than reading none", () => {
    const root = temporary();
    git(root, "init", "-q", "-b", "main");
    writeFileSync(
      join(root, "CHANGELOG.md"),
      fixture("keep-a-changelog", "clean"),
    );
    writeFileSync(join(root, "package.json"), MANIFEST("1.1.0"));
    mkdirSync(join(root, ".config"));
    writeFileSync(
      join(root, ".config", "jig.yaml"),
      jigYaml("  file: CHANGELOG.md"),
    );
    // No commit: HEAD names nothing, so no tag can be listed as merged into it.
    const result = lint(root, ["--json"]);
    expectSpawnExit(result, 2);
    expect(JSON.parse(result.stdout).unchecked).toContain(
      "git could not list the tags",
    );
  });

  test.skipIf(skipsOnWindows("file-system", "a named pipe needs mkfifo"))(
    "refuses a changelog that is not a regular file before reading it",
    () => {
      // Reading a pipe nobody writes blocks, until the lint's deadline.
      const root = unconfiguredChangelog();
      fifo(join(root, "CHANGELOG.md"));
      const result = lint(root);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("CHANGELOG.md is not a regular file");
    },
  );

  test.skipIf(skipsOnWindows("file-system", "a named pipe needs mkfifo"))(
    "refuses a link out of the repository before detecting the format from it",
    () => {
      const outside = join(temporary(), "pipe");
      fifo(outside);
      const root = unconfiguredChangelog();
      symlinkSync(outside, join(root, "CHANGELOG.md"));
      const result = lint(root);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain("resolves outside the repository root");
    },
  );
});

/** A repository whose skill is on, with no changelog yet and no format set. */
const unconfiguredChangelog = (): string =>
  repository({
    "package.json": MANIFEST("1.1.0"),
    ".config/jig.yaml": jigYaml("  file: CHANGELOG.md"),
  });

/** A named pipe at `path`. */
function fifo(path: string): void {
  const made = spawnSync("mkfifo", [path], { env: cleanEnv({}) });
  expectSpawnExit({ ...made, exitCode: made.status }, 0);
}

describe("the command's refusals", () => {
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

  test("refuses a root that is not a git repository's top level", () => {
    const root = configured(fixture("keep-a-changelog", "clean"));
    expect(() => changelogPath(join(root, ".config"), "CHANGELOG.md")).toThrow(
      "is not the top level of a git repository",
    );
    const plain = temporary();
    writeFileSync(join(plain, "CHANGELOG.md"), "# Changelog\n");
    expect(() => changelogPath(plain, "CHANGELOG.md")).toThrow(
      "is not the top level of a git repository",
    );
    expect(changelogPath(root, "CHANGELOG.md")).toBe(
      join(realpathSync(root), "CHANGELOG.md"),
    );
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
