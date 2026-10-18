import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkBranch, checkNotes, under } from "../scripts/check.ts";
import {
  COMMON_CHANGELOG,
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  MANIFEST,
  repository,
  resolvedFor,
  temporary,
  write,
} from "./scratch.ts";

const VERSION_FILES = {
  version: {
    files: [
      { path: "a/plugin.json", key: "version" },
      { path: "b/plugin.json", key: "version" },
    ],
  },
};
const VERSION_YAML =
  "  version:\n    files:\n      - { path: a/plugin.json, key: version }\n      - { path: b/plugin.json, key: version }";
/** A `.config/jig.yaml` with the section and the version files these tests use. */
const yaml = (section: string) => jigYaml(`${section}\n${VERSION_YAML}`);
const files = (): Record<string, string> => ({
  "CHANGELOG.md": KEEP_CHANGELOG,
  "a/plugin.json": MANIFEST("1.2.0"),
  "b/plugin.json": MANIFEST("1.2.0"),
  "changes/README.md": "How to write a note.\n",
  "src/x.ts": "x\n",
});

describe("checkNotes", () => {
  const check = (root: string, over = {}) =>
    checkNotes({
      ...resolvedFor(root, VERSION_FILES),
      releasePaths: ["src/"],
      notePaths: [],
      authors: true,
      base: "main",
      ...over,
    });
  function branch(): string {
    const root = repository(files());
    git(root, "checkout", "-qb", "work");
    return root;
  }

  test("on the base itself only the notes are checked", () => {
    const root = repository(files());
    expect(check(root)).toEqual({
      findings: [],
      notices: [],
      skipped: "HEAD is main",
    });
    expect(check(root, { base: null }).skipped).toBe("no base branch given");
  });

  test("a base git cannot compare against is a finding, not a skip", () => {
    const root = branch();
    const result = check(root, { base: "origin/nowhere" });
    expect(result.skipped).toBeNull();
    expect(result.findings.join("\n")).toContain(
      "cannot be compared with origin/nowhere",
    );
  });

  test("only a note the release step reads can ask for the release", () => {
    const root = branch();
    write(root, "src/é.ts", "y\n");
    const asks = "---\nrelease: patch\n---\n### Changed\n\n- y\n";
    write(root, "changes/README.md", asks);
    write(root, "changes/nested/a.md", asks);
    expect(check(root).findings.join("\n")).toContain(
      "src/é.ts changed, which ships only in a release",
    );
  });

  test("deleting the changelog is a finding", () => {
    const root = branch();
    const options = resolvedFor(root, VERSION_FILES);
    rmSync(join(root, "CHANGELOG.md"));
    expect(
      checkNotes({
        ...options,
        releasePaths: [],
        notePaths: [],
        authors: true,
        base: "main",
      }).findings.join("\n"),
    ).toContain("deletes the changelog");
  });

  test("a change to a released path needs a note that asks for a release", () => {
    const root = branch();
    write(root, "src/x.ts", "y\n");
    expect(check(root).findings.join("\n")).toContain(
      "src/x.ts changed, which ships only in a release",
    );
    write(root, "changes/work.md", "### Changed\n\n- y\n");
    expect(check(root).findings).toHaveLength(1);
    write(
      root,
      "changes/work.md",
      "---\nrelease: patch\n---\n### Changed\n\n- y\n",
    );
    expect(check(root)).toEqual({ findings: [], notices: [], skipped: null });
    // Committed counts the same as in the working tree.
    commit(root, {}, "work");
    expect(check(root)).toEqual({ findings: [], notices: [], skipped: null });
  });

  test("a file moved out of a release path is a change to it", () => {
    const root = branch();
    mkdirSync(join(root, "other"), { recursive: true });
    git(root, "mv", "src/x.ts", "other/x.ts");
    commit(root, {}, "move");
    expect(check(root).findings.join("\n")).toContain(
      "src/x.ts changed, which ships only in a release",
    );
  });

  test("a path without a trailing slash holds itself and what is under it, not a longer name", () => {
    expect(under("plugin/x.ts", "plugin")).toBe(true);
    expect(under("plugin", "plugin")).toBe(true);
    expect(under("plugin-docs/x.md", "plugin")).toBe(false);
    expect(under("plugin/x.ts", "plugin/")).toBe(true);
    expect(under("plugin-docs/x.md", "plugin/")).toBe(false);
    const root = repository({ ...files(), "src-docs/a.md": "a\n" });
    git(root, "checkout", "-qb", "work");
    write(root, "src-docs/a.md", "b\n");
    expect(check(root, { releasePaths: ["src"] }).findings).toEqual([]);
    write(root, "src/x.ts", "y\n");
    expect(
      check(root, { releasePaths: ["src"] }).findings.join("\n"),
    ).toContain("src/x.ts changed");
  });

  test("a change to a note path needs a note, with or without a release", () => {
    const root = branch();
    const options = { releasePaths: [], notePaths: ["docs/"] };
    write(root, "docs/guide.md", "y\n");
    expect(check(root, options).findings.join("\n")).toContain(
      "docs/guide.md changed, which needs a change note",
    );
    write(root, "changes/work.md", "### Changed\n\n- y\n");
    expect(check(root, options).findings).toEqual([]);
  });

  test("the version and the changelog's sections are the release step's", () => {
    const root = branch();
    write(root, "a/plugin.json", MANIFEST("1.3.0"));
    write(
      root,
      "CHANGELOG.md",
      KEEP_CHANGELOG.replace(
        "- an earlier docs change",
        "- an earlier docs change\n- mine",
      ).replace(
        "## [1.2.0]",
        "## [1.3.0] - 2026-02-03\n\n### Fixed\n\n- x\n\n## [1.2.0]",
      ),
    );
    const findings = check(root).findings.join("\n");
    expect(findings).toContain(
      "a/plugin.json: the branch moves the version from 1.2.0 to 1.3.0",
    );
    expect(findings).toContain("CHANGELOG.md: the branch adds to Unreleased");
    expect(findings).toContain("adds or removes a release section");
  });

  test("an entry already under Unreleased may be corrected or removed, never added to", () => {
    const root = branch();
    const corrected = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      "- an earlier docs change, corrected",
    );
    expect(corrected).not.toBe(KEEP_CHANGELOG);
    write(root, "CHANGELOG.md", corrected);
    expect(check(root)).toMatchObject({
      findings: [],
      notices: [
        "CHANGELOG.md: the branch corrects or removes entries under Unreleased; check that it changes only what was wrong. Lines it changes or removes:\n  - - an earlier docs change\nLines it adds:\n  - - an earlier docs change, corrected",
      ],
    });
    write(
      root,
      "CHANGELOG.md",
      KEEP_CHANGELOG.replace("- an earlier docs change\n", ""),
    );
    expect(check(root).findings).toEqual([]);
    write(
      root,
      "CHANGELOG.md",
      KEEP_CHANGELOG.replace(
        "- an earlier docs change",
        "- an earlier docs change\n\n### Added\n\n- a new section",
      ),
    );
    const adds = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      return check(root).findings.join("\n");
    };
    expect(adds(KEEP_CHANGELOG)).toBe("");
    // A nested item is an entry too.
    expect(
      adds(
        KEEP_CHANGELOG.replace(
          "- an earlier docs change",
          "- an earlier docs change\n  - and more",
        ),
      ),
    ).toContain("CHANGELOG.md: the branch adds to Unreleased");
    // An entry moved to another section is an entry that section did not have.
    expect(
      adds(
        KEEP_CHANGELOG.replace(
          "### Changed\n\n- an earlier docs change",
          "### Changed\n\n### Fixed\n\n- an earlier docs change",
        ),
      ),
    ).toContain("CHANGELOG.md: the branch adds to Unreleased");
    // Rewriting an entry keeps the count, so it is a correction the notice shows.
    write(
      root,
      "CHANGELOG.md",
      KEEP_CHANGELOG.replace("- an earlier docs change", "- something else"),
    );
    expect(check(root)).toMatchObject({ findings: [] });
    expect(check(root).notices.join("\n")).toContain(
      "  - - an earlier docs change",
    );
  });

  test("any line added under Unreleased is refused, whatever Markdown makes of it", () => {
    const root = branch();
    const adds = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      return check(root).findings.join("\n");
    };
    const after = (text: string) =>
      KEEP_CHANGELOG.replace(
        "- an earlier docs change",
        `- an earlier docs change\n${text}`,
      );
    for (const text of [
      "1. a numbered change",
      "\nA paragraph of its own.",
      "  Additional explanation.",
      "> a quoted change",
      "| a | table |",
      "<details>",
      "***\nA new change.",
      "\n    indented code\nA new change.",
      "```\n- one\n```",
    ])
      expect(adds(after(text))).toContain(
        "CHANGELOG.md: the branch adds to Unreleased",
      );
    // A blank line adds nothing, and neither does the way a heading is written.
    expect(adds(after(""))).toBe("");
    expect(
      adds(KEEP_CHANGELOG.replace("### Changed", "  ### Changed ##")),
    ).toBe("");
  });

  test("a line rewritten under Unreleased stays where it was, in the same structure and section", () => {
    const base = KEEP_CHANGELOG.replace(
      "### Changed\n\n- an earlier docs change",
      "### Changed\n\n- an earlier docs change\n  with more to say\n- Old note - New note\n\n### Fixed\n\n- a fix",
    );
    const root = repository({ ...files(), "CHANGELOG.md": base });
    git(root, "checkout", "-qb", "work");
    const adds = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      return check(root).findings.join("\n");
    };
    const refused = "CHANGELOG.md: the branch adds to Unreleased";
    // Every line kept, or rewritten in place, adds nothing.
    expect(adds(base)).toBe("");
    expect(adds(base.replace("- a fix", "- a fix, corrected"))).toBe("");
    expect(
      adds(base.replace("  with more to say", "  with more to say, corrected")),
    ).toBe("");
    // An entry moved into a heading that already exists keeps every count.
    expect(
      adds(
        base
          .replace("- Old note - New note\n", "")
          .replace("- a fix", "- Old note - New note\n- a fix"),
      ),
    ).toContain(refused);
    // Removing a continuation line does not make room for a new entry.
    expect(
      adds(
        base
          .replace("  with more to say\n", "")
          .replace("- a fix", "- a fix\n- a new fix"),
      ),
    ).toContain(refused);
    // Nor does turning it into one where it stood.
    expect(
      adds(base.replace("  with more to say", "- a new change")),
    ).toContain(refused);
    // Splitting one line into two is a line added, however few words change.
    expect(
      adds(base.replace("- Old note - New note", "- Old note\n- New note")),
    ).toContain(refused);
    expect(
      adds(base.replace("- Old note - New note", "- Old note -\n  New note")),
    ).toContain(refused);
    // Removing a heading moves the entries under it into the one above.
    expect(adds(base.replace("### Fixed\n\n", ""))).toContain(refused);
    // Removing the heading with its entries is a removal.
    expect(adds(base.replace("\n### Fixed\n\n- a fix\n", ""))).toBe("");
    // A line opening a fence changes what every line after it is.
    expect(adds(base.replace("  with more to say", "```"))).toContain(refused);
  });

  test("a line rewritten into the text of the one after it is still in its place", () => {
    const base = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      "- an old change\n- an earlier docs change",
    );
    const root = repository({ ...files(), "CHANGELOG.md": base });
    git(root, "checkout", "-qb", "work");
    write(
      root,
      "CHANGELOG.md",
      base.replace("- an old change", "- an earlier docs change"),
    );
    expect(check(root).findings).toEqual([]);
  });

  test("text repeated inside and outside a fence does not turn a removal into an addition", () => {
    const base = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      "```\n- an earlier docs change\n```\n\n- an earlier docs change",
    );
    const root = repository({ ...files(), "CHANGELOG.md": base });
    git(root, "checkout", "-qb", "work");
    write(
      root,
      "CHANGELOG.md",
      base.replace("```\n- an earlier docs change\n```\n\n", ""),
    );
    expect(check(root).findings).toEqual([]);
  });

  test("a long Unreleased is compared in one pass, not one step per pair of lines", () => {
    const entries = Array.from({ length: 60_000 }, (_, n) => `- entry ${n}`);
    const base = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      entries.join("\n"),
    );
    const root = repository({ ...files(), "CHANGELOG.md": base });
    git(root, "checkout", "-qb", "work");
    write(root, "CHANGELOG.md", base.replace("- entry 0\n", "- entry zero\n"));
    expect(check(root).findings).toEqual([]);
  });

  test("a heading added again or moved to another depth is a section the base did not have", () => {
    const root = branch();
    const adds = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      return check(root).findings.join("\n");
    };
    expect(
      adds(
        KEEP_CHANGELOG.replace(
          "- an earlier docs change",
          "- an earlier docs change\n\n### Changed",
        ),
      ),
    ).toContain("CHANGELOG.md: the branch adds to Unreleased");
    expect(
      adds(KEEP_CHANGELOG.replace("### Changed", "#### Changed")),
    ).toContain("CHANGELOG.md: the branch adds to Unreleased");
  });

  test("removing one of two identical lines names it", () => {
    const twice = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      "- an earlier docs change\n- an earlier docs change",
    );
    const root = repository({ ...files(), "CHANGELOG.md": twice });
    git(root, "checkout", "-qb", "work");
    write(root, "CHANGELOG.md", KEEP_CHANGELOG);
    expect(check(root)).toMatchObject({
      findings: [],
      notices: [
        "CHANGELOG.md: the branch corrects or removes entries under Unreleased; check that it changes only what was wrong. Lines it changes or removes:\n  - - an earlier docs change",
      ],
    });
  });

  test("lines swapped or rewritten in their places are all named, in order", () => {
    const two = KEEP_CHANGELOG.replace("- an earlier docs change", "- A\n- B");
    const root = repository({ ...files(), "CHANGELOG.md": two });
    git(root, "checkout", "-qb", "work");
    const notice = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      const { findings, notices } = check(root);
      expect(findings).toEqual([]);
      return notices;
    };
    const says = (removed: string[], added: string[]) => [
      `CHANGELOG.md: the branch corrects or removes entries under Unreleased; check that it changes only what was wrong. Lines it changes or removes:\n${removed.map((l) => `  - ${l}`).join("\n")}\nLines it adds:\n${added.map((l) => `  - ${l}`).join("\n")}`,
    ];
    expect(notice(two.replace("- A\n- B", "- B\n- A"))).toEqual(
      says(["- A", "- B"], ["- B", "- A"]),
    );
    expect(notice(two.replace("- A\n- B", "- B\n- C"))).toEqual(
      says(["- A", "- B"], ["- B", "- C"]),
    );
  });

  test("removing one of several alike entries names that entry alone", () => {
    const three = KEEP_CHANGELOG.replace(
      "- an earlier docs change",
      "- A\n- B\n- C",
    );
    const root = repository({ ...files(), "CHANGELOG.md": three });
    git(root, "checkout", "-qb", "work");
    const notice = (changelog: string) => {
      write(root, "CHANGELOG.md", changelog);
      const { findings, notices } = check(root);
      expect(findings).toEqual([]);
      return notices;
    };
    const removes = (line: string) => [
      `CHANGELOG.md: the branch corrects or removes entries under Unreleased; check that it changes only what was wrong. Lines it changes or removes:\n  - ${line}`,
    ];
    expect(notice(three.replace("- A\n", ""))).toEqual(removes("- A"));
    expect(notice(three.replace("- B\n", ""))).toEqual(removes("- B"));
  });

  test("a version kept in YAML or TOML is held the same way", () => {
    const root = repository({
      ...files(),
      "Chart.yaml": "name: c\nversion: 1.2.0\n",
      "Cargo.toml": '[package]\nversion = "1.2.0"\n',
    });
    git(root, "checkout", "-qb", "work");
    write(root, "Chart.yaml", "name: c\nversion: 1.3.0\n");
    write(root, "Cargo.toml", '[package]\nversion = "1.3.0"\n');
    const findings = checkNotes({
      ...resolvedFor(root, {
        version: {
          files: [
            { path: "Chart.yaml", key: "version" },
            { path: "Cargo.toml", key: "package.version" },
          ],
        },
      }),
      releasePaths: [],
      notePaths: [],
      authors: true,
      base: "main",
    }).findings.join("\n");
    expect(findings).toContain("Chart.yaml: the branch moves the version");
    expect(findings).toContain("Cargo.toml: the branch moves the version");
  });

  test("an earlier release's text may still be corrected", () => {
    const root = branch();
    write(
      root,
      "CHANGELOG.md",
      KEEP_CHANGELOG.replace("- a skill", "- a new skill"),
    );
    expect(check(root)).toEqual({ findings: [], notices: [], skipped: null });
  });

  test("a note of an earlier branch that this one changes is named for the reviewer", () => {
    const root = repository({
      ...files(),
      "changes/old.md": "### Fixed\n\n- old\n",
    });
    git(root, "checkout", "-qb", "work");
    write(root, "changes/old.md", "### Fixed\n\n- old, reworded\n");
    expect(check(root).notices).toEqual([
      "changes/old.md was added by an earlier branch and this one changes it",
    ]);
    rmSync(join(root, "changes/old.md"));
    expect(check(root).notices[0]).toContain("deletes it");
  });
});

describe("checkNotes in Common Changelog", () => {
  const base = (extra: Record<string, string> = {}) => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/README.md": "x\n",
      "src/x.ts": "x\n",
      ...extra,
    });
    git(root, "checkout", "-qb", "work");
    return root;
  };
  const check = (root: string, section: Record<string, unknown> = {}) =>
    checkNotes({
      ...resolvedFor(root, { format: "common-changelog", ...section }),
      releasePaths: [],
      notePaths: [],
      authors: section.authors !== false,
      base: "main",
    }).findings.join("\n");

  test("a **Breaking:** entry needs release: major, or minor before 1.0.0", () => {
    const root = base();
    write(
      root,
      "changes/a.md",
      "---\nrelease: minor\n---\n### Changed\n\n- **Breaking:** Rename x\n",
    );
    expect(check(root)).toContain(
      "a **Breaking:** entry needs `release: major`, but the note asks for minor",
    );
    write(
      root,
      "changes/a.md",
      "---\nrelease: major\n---\n### Changed\n\n- **Breaking:** Rename x\n",
    );
    expect(check(root)).toBe("");
    write(root, "changes/a.md", "### Changed\n\n- **Breaking:** Rename x\n");
    expect(check(root)).toContain("but the note asks for no release");
    const early = base({ "package.json": `{"version": "0.4.0"}\n` });
    write(
      early,
      "changes/a.md",
      "---\nrelease: minor\n---\n### Changed\n\n- **Breaking:** Rename x\n",
    );
    expect(check(early)).toBe("");
    write(
      early,
      "changes/a.md",
      "---\nrelease: patch\n---\n### Changed\n\n- **Breaking:** Rename x\n",
    );
    expect(check(early)).toContain("(or minor before 1.0.0)");
  });

  test("a version kept only in tags is the changelog's newest heading", () => {
    const root = repository({
      "CHANGELOG.md": "# C\n\n## [0.4.0] - 2026-01-01\n\n### Added\n\n- x\n",
      "changes/README.md": "x\n",
    });
    git(root, "checkout", "-qb", "work");
    write(
      root,
      "changes/a.md",
      "---\nrelease: minor\n---\n### Changed\n\n- **Breaking:** Rename x\n",
    );
    expect(check(root, { version: { tags: true } })).toBe("");
  });

  test("an entry the release could not credit fails the branch, not the release", () => {
    const root = base();
    write(root, "changes/a.md", "### Fixed\n\n- Use `foo\n");
    expect(check(root)).toContain(
      'changes/a.md: the entry "- Use `foo" reads differently once its reference and authors are appended',
    );
    write(root, "changes/a.md", "### Fixed\n\n- Use `foo`\n");
    expect(check(root)).toBe("");
  });

  test("a waiting note the release could not credit fails on every branch, the base included", () => {
    const root = base({ "changes/old.md": "### Fixed\n\n- Use `foo\n" });
    const refusal = 'changes/old.md: the entry "- Use `foo" reads differently';
    expect(check(root)).toContain(refusal);
    git(root, "checkout", "-q", "main");
    expect(check(root)).toContain(refusal);
    expect(
      checkNotes({
        ...resolvedFor(root, { format: "common-changelog" }),
        releasePaths: [],
        notePaths: [],
        authors: true,
        base: null,
      }).findings.join("\n"),
    ).toContain(refusal);
  });

  test("each entry is one line", () => {
    const root = base();
    write(root, "changes/a.md", "### Fixed\n\n- one\n  and more\n");
    expect(check(root)).toContain("runs over more than one line");
  });

  test("a summary is refused when a note waiting on the base has one", () => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/first.md":
        "---\nrelease: patch\n---\nA notice.\n\n### Fixed\n\n- y\n",
    });
    git(root, "checkout", "-qb", "work");
    write(
      root,
      "changes/second.md",
      "---\nrelease: patch\n---\nAnother notice.\n\n### Fixed\n\n- z\n",
    );
    expect(check(root)).toContain(
      "changes/second.md: a release has one notice, and changes/first.md waiting on the base already has a summary",
    );
    write(
      root,
      "changes/second.md",
      "---\nrelease: patch\n---\n### Fixed\n\n- z\n",
    );
    expect(check(root)).toBe("");
  });

  test("a note whose commits are all by bots needs authors", () => {
    const root = base();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Bump\n" },
      "Bump",
      "renovate[bot]",
    );
    expect(check(root)).toContain(
      "changes/a.md: every commit that wrote it is by a bot",
    );
    expect(check(root, { authors: false })).toBe("");
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: patch\nauthors: Mia Merger\n---\n### Fixed\n\n- Bump\n",
      },
      "name",
      "renovate[bot]",
    );
    expect(check(root)).toBe("");
    // A person's later edit credits the note too.
    commit(
      root,
      { "changes/b.md": "---\nrelease: patch\n---\n### Fixed\n\n- Bump\n" },
      "Bump",
      "renovate[bot]",
    );
    expect(check(root)).toContain("changes/b.md");
    commit(
      root,
      {
        "changes/b.md":
          "---\nrelease: patch\n---\n### Fixed\n\n- Bump, again\n",
      },
      "edit",
      "Jane Doe",
    );
    expect(check(root)).toBe("");
  });
});

describe("checkBranch: the configuration is the base's", () => {
  const env = () => ({ JIG_HOME: temporary("jig-home-") });
  const configured = (
    section = "  file: CHANGELOG.md\n  release_paths: [src/]",
  ) =>
    repository({
      ...files(),
      ".config/jig.yaml": yaml(section),
    });

  test("a branch cannot unset the file, empty the release paths or move the notes to pass its own check", () => {
    const root = configured();
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        ".config/jig.yaml": yaml(
          "  file: CHANGELOG.md\n  notes_dir: elsewhere",
        ),
        "src/x.ts": "changed\n",
      },
      "weaken",
    );
    const result = checkBranch(root, "main", env());
    expect(result.configured).toBe(true);
    expect(result.findings.join("\n")).toContain(
      "src/x.ts changed, which ships only in a release",
    );
    // The change is named for the reviewer.
    expect(result.notices.join("\n")).toContain(
      'changelog.release_paths: ["src/"] → []',
    );
    expect(result.notices.join("\n")).toContain(
      'changelog.notes_dir: "changes" → "elsewhere"',
    );
    git(root, "rm", "-q", ".config/jig.yaml");
    const removed = checkBranch(root, "main", env());
    expect(removed.configured).toBe(true);
    expect(removed.notices.join("\n")).toContain(
      "removes the changelog section",
    );
    expect(removed.findings.join("\n")).toContain("src/x.ts changed");
  });

  test("a branch that adds the section is not held to it before the merge", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        ".config/jig.yaml": yaml(
          "  file: CHANGELOG.md\n  release_paths: [src/]",
        ),
        "src/x.ts": "changed\n",
      },
      "adopt",
    );
    const result = checkBranch(root, "main", env());
    expect(result).toMatchObject({
      configured: false,
      findings: [],
      skipped: null,
    });
    expect(result.notices.join("\n")).toContain(
      "takes effect once it is merged",
    );
  });

  test("the section a branch proposes must work", () => {
    const root = configured();
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      { ".config/jig.yaml": yaml("  file: MISSING.md") },
      "move the file",
    );
    expect(checkBranch(root, "main", env()).findings.join("\n")).toContain(
      "the changelog section this branch proposes does not work: changelog.file: MISSING.md does not exist",
    );
    commit(
      root,
      { ".config/jig.yaml": yaml("  file: CHANGELOG.md\n  authors: nope") },
      "break it",
    );
    expect(checkBranch(root, "main", env()).findings.join("\n")).toContain(
      "changelog.authors must be true or false",
    );
  });

  test("a section the base itself holds invalid is a finding, not a pass", () => {
    const root = configured("  file: CHANGELOG.md\n  authors: nope");
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      { ".config/jig.yaml": yaml("  file: CHANGELOG.md") },
      "fix it",
    );
    expect(checkBranch(root, "main", env()).findings.join("\n")).toContain(
      "the changelog configuration at main is invalid, so the branch cannot be held to it: changelog.authors must be true or false",
    );
  });

  test("a branch that deletes its section is not let off when the base cannot be found", () => {
    const root = configured();
    git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    git(root, "checkout", "-qb", "work");
    git(root, "rm", "-q", ".config/jig.yaml");
    commit(root, {}, "drop the section");
    const result = checkBranch(root, null, env(), false);
    expect(result.findings.join("\n")).toContain("pass --base");
    // A clone with no remote at all never adopted the skill.
    const bare = repository({ "a.txt": "x\n" });
    expect(checkBranch(bare, null, env(), false).findings).toEqual([]);
  });

  test("a value from the environment or a user file is refused, not merged", () => {
    const root = configured();
    git(root, "checkout", "-qb", "work");
    const result = checkBranch(root, "main", {
      ...env(),
      JIG__CHANGELOG__RELEASE_PATHS: "[]",
    });
    expect(result.findings.join("\n")).toContain(
      "$JIG__CHANGELOG__RELEASE_PATHS",
    );
  });

  test("a base git cannot find is a finding where the skill is on, and nothing where it is off", () => {
    const on = configured();
    expect(checkBranch(on, null, env(), false).findings.join("\n")).toContain(
      "pass --base",
    );
    expect(
      checkBranch(on, "origin/nowhere", env()).findings.join("\n"),
    ).toContain("cannot be compared with origin/nowhere");
    const off = repository({ "a.txt": "x\n" });
    expect(checkBranch(off, null, env(), false)).toMatchObject({
      configured: false,
      findings: [],
    });
    expect(checkBranch(off, "main", env())).toMatchObject({
      configured: false,
      findings: [],
    });
  });
});
