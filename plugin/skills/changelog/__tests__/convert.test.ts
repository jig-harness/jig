import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { checkBranch } from "../scripts/check.ts";
import { convert } from "../scripts/convert.ts";
import { noteName } from "../scripts/notes-dir.ts";
import {
  cleanEnv,
  COMMON_CHANGELOG,
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  MANIFEST,
  repository,
  temporary,
  write,
} from "./scratch.ts";

const section = (extra = "") =>
  jigYaml(`  file: CHANGELOG.md\n  release_paths: [src/]${extra}`);

const files = (extra = ""): Record<string, string> => ({
  "CHANGELOG.md": KEEP_CHANGELOG,
  "package.json": MANIFEST("1.2.0"),
  "src/x.ts": "x\n",
  ".config/jig.yaml": section(extra),
});

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

/** The keep-a-changelog file as a branch that cut 1.3.0 by hand leaves it. */
const EDITED = `# Changelog

Intro.

## [Unreleased]

### Changed

- an earlier docs change
- the branch's docs change

## [1.3.0] - 2026-02-03

A summary.

### Added

- a new command, see [the guide](docs/guide.md).

## [1.2.0] - 2026-01-02

### Added

- a skill for agents

[Unreleased]: https://example.com/r/compare/v1.3.0...HEAD
[1.3.0]: https://example.com/r/compare/v1.2.0...v1.3.0
[1.2.0]: https://example.com/r/compare/v1.1.0...v1.2.0
`;

/** A branch `work` that edited the changelog and the version by hand. */
function edited(extra = ""): string {
  const root = repository(files(extra));
  git(root, "checkout", "-qb", "work");
  commit(
    root,
    {
      "CHANGELOG.md": EDITED,
      "package.json": MANIFEST("1.3.0"),
      "src/x.ts": "y\n",
    },
    "work",
  );
  return root;
}

describe("convert", () => {
  test("turns the branch's release section and Unreleased additions into one note", () => {
    const root = edited();
    const result = convert(root, "main");
    expect(result).toMatchObject({
      configured: true,
      release: "minor",
      note: `changes/${noteName("work")}`,
      problems: [],
    });
    expect(read(root, `changes/${noteName("work")}`)).toBe(
      `---
release: minor
---

A summary.

### Added

- a new command, see [the guide](../docs/guide.md).

### Changed

- the branch's docs change
`,
    );
  });

  test("puts back the base's open sections and version, and keeps the branch's edits to earlier releases", () => {
    const root = edited();
    convert(root, "main");
    expect(read(root, "CHANGELOG.md")).toBe(
      KEEP_CHANGELOG.replace("- a skill\n", "- a skill for agents\n"),
    );
    expect(read(root, "package.json")).toBe(MANIFEST("1.2.0"));
    expect(result(root)).toEqual(["CHANGELOG.md", "package.json"]);
  });

  test("leaves the result uncommitted, and one the branch check accepts", () => {
    const root = edited();
    convert(root, "main");
    expect(git(root, "status", "--porcelain", "-uall")).toContain(
      `?? changes/${noteName("work")}`,
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "convert");
    expect(checkBranch(root, "main").findings).toEqual([]);
  });

  test("makes the branch merge with a base that moved on, which it could not before", () => {
    const root = edited();
    // The base moves on: another merge's release section and Unreleased line.
    git(root, "checkout", "-q", "main");
    commit(
      root,
      {
        "CHANGELOG.md": KEEP_CHANGELOG.replace(
          "- an earlier docs change\n",
          "- an earlier docs change\n- another merge's change\n",
        ),
      },
      "main moves",
    );
    git(root, "checkout", "-q", "work");
    expect(() => git(root, "merge", "--no-edit", "main")).toThrow();
    git(root, "merge", "--abort");

    convert(root, "main");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "convert");
    git(root, "merge", "--no-edit", "main");
    expect(read(root, "CHANGELOG.md")).toContain("- another merge's change");
    expect(read(root, "package.json")).toBe(MANIFEST("1.2.0"));
  });

  test("a branch that only adds to Unreleased gets a note without a release", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "docs-fix");
    commit(
      root,
      {
        "CHANGELOG.md": KEEP_CHANGELOG.replace(
          "- an earlier docs change\n",
          "- an earlier docs change\n- a clearer error\n",
        ),
      },
      "docs",
    );
    const result = convert(root, "main");
    expect(result.release).toBeNull();
    expect(read(root, `changes/${noteName("docs-fix")}`)).toBe(
      "### Changed\n\n- a clearer error\n",
    );
    expect(read(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
  });

  test("rewrites a link from the changelog's folder to the notes folder", () => {
    const root = repository({
      ...files(),
      "docs/CHANGELOG.md": KEEP_CHANGELOG,
      ".config/jig.yaml": jigYaml("  file: docs/CHANGELOG.md"),
    });
    git(root, "checkout", "-qb", "linked");
    commit(
      root,
      {
        "docs/CHANGELOG.md": KEEP_CHANGELOG.replace(
          "- an earlier docs change\n",
          "- an earlier docs change\n- see [the guide](guide.md) and [it](https://example.com/x)\n",
        ),
      },
      "link",
    );
    convert(root, "main");
    expect(read(root, `changes/${noteName("linked")}`)).toContain(
      "- see [the guide](../docs/guide.md) and [it](https://example.com/x)",
    );
  });

  test("a branch stacked on another converts against it, so only its own edits become its note", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "lower");
    commit(
      root,
      {
        [`changes/${noteName("lower")}`]:
          "---\nrelease: patch\n---\n\n### Fixed\n\n- the lower fix\n",
        "src/x.ts": "lower\n",
      },
      "lower",
    );
    git(root, "checkout", "-qb", "upper");
    commit(
      root,
      {
        "CHANGELOG.md": KEEP_CHANGELOG.replace(
          "- an earlier docs change\n",
          "- an earlier docs change\n- the upper change\n",
        ),
        "package.json": MANIFEST("1.2.1"),
      },
      "upper",
    );
    const result = convert(root, "lower");
    expect(result).toMatchObject({ release: "patch", problems: [] });
    expect(read(root, `changes/${noteName("upper")}`)).toBe(
      "---\nrelease: patch\n---\n\n### Changed\n\n- the upper change\n",
    );
    expect(
      git(
        root,
        "diff",
        "lower",
        "--stat",
        "--",
        "CHANGELOG.md",
        "package.json",
      ),
    ).toBe("");
  });

  test("merges into a note the branch already has", () => {
    const root = edited();
    write(
      root,
      `changes/${noteName("work")}`,
      "---\nrelease: patch\n---\n\n### Fixed\n\n- an earlier fix\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "note");
    convert(root, "main");
    const note = read(root, `changes/${noteName("work")}`);
    expect(note).toContain("release: minor");
    expect(note).toContain("### Added\n\n- a new command");
    expect(note).toContain("### Fixed\n\n- an earlier fix");
  });

  test("a dry run writes nothing", () => {
    const root = edited();
    const result = convert(root, "main", true);
    expect(result.note).toBe(`changes/${noteName("work")}`);
    expect(existsSync(join(root, "changes"))).toBe(false);
    expect(read(root, "CHANGELOG.md")).toBe(EDITED);
  });

  test("a branch that edited neither has nothing to convert", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "plain");
    commit(root, { "src/x.ts": "z\n" }, "code");
    expect(convert(root, "main")).toMatchObject({
      configured: true,
      note: null,
      restored: [],
      reverted: [],
    });
  });

  test("a repository whose base never adopted the skill is left alone", () => {
    const root = repository({ ...files(), ".config/jig.yaml": "other: 1\n" });
    git(root, "checkout", "-qb", "work");
    commit(root, { "CHANGELOG.md": EDITED }, "work");
    expect(convert(root, "main").configured).toBe(false);
    expect(read(root, "CHANGELOG.md")).toBe(EDITED);
  });
});

describe("what the branch's hand edits hold", () => {
  const branchWith = (changelog: string, version = "1.3.0"): string => {
    const root = repository(files());
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      { "CHANGELOG.md": changelog, "package.json": MANIFEST(version) },
      "work",
    );
    return root;
  };

  test("a release cut by moving Unreleased's entries does not duplicate them", () => {
    const root = branchWith(`# Changelog

Intro.

## [Unreleased]

## [1.3.0] - 2026-02-03

### Changed

- an earlier docs change
- the branch's change

## [1.2.0] - 2026-01-02

### Added

- a skill

[Unreleased]: https://example.com/r/compare/v1.3.0...HEAD
[1.3.0]: https://example.com/r/compare/v1.2.0...v1.3.0
[1.2.0]: https://example.com/r/compare/v1.1.0...v1.2.0
`);
    const result = convert(root, "main");
    expect(result.problems).toEqual([]);
    expect(read(root, `changes/${noteName("work")}`)).toBe(
      "---\nrelease: minor\n---\n\n### Changed\n\n- the branch's change\n",
    );
    expect(read(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
  });

  test("an entry outside a ### section is refused, not dropped", () => {
    const root = branchWith(
      KEEP_CHANGELOG.replace(
        "## [Unreleased]\n",
        "## [Unreleased]\n\n- a bare entry\n",
      ),
      "1.2.0",
    );
    expect(() => convert(root, "main")).toThrow(/outside a ### section/);
    expect(read(root, "CHANGELOG.md")).toContain("- a bare entry");
  });

  test("an edited entry of Unreleased is reported, since the base's text comes back", () => {
    const root = branchWith(
      KEEP_CHANGELOG.replace(
        "- an earlier docs change",
        "- an earlier docs change, corrected",
      ),
      "1.2.0",
    );
    const result = convert(root, "main");
    expect(result.problems.join("\n")).toContain("an earlier docs change");
  });

  test("an entry moved into a release under another change type is reported, since the base's type comes back", () => {
    const root = branchWith(`# Changelog

Intro.

## [Unreleased]

## [1.3.0] - 2026-02-03

### Fixed

- an earlier docs change

## [1.2.0] - 2026-01-02

### Added

- a skill

[Unreleased]: https://example.com/r/compare/v1.3.0...HEAD
[1.3.0]: https://example.com/r/compare/v1.2.0...v1.3.0
[1.2.0]: https://example.com/r/compare/v1.1.0...v1.2.0
`);
    const result = convert(root, "main");
    expect(result.problems.join("\n")).toContain(
      "Unreleased's Changed, or moved it under another change type, and the base's text comes back with Unreleased: - an earlier docs change",
    );
    expect(read(root, `changes/${noteName("work")}`)).toContain(
      "### Fixed\n\n- an earlier docs change\n",
    );
  });

  test("a working tree with Windows line endings converts like one without", () => {
    const root = edited();
    write(root, "CHANGELOG.md", EDITED.replaceAll("\n", "\r\n"));
    git(root, "-c", "core.autocrlf=false", "add", "-A");
    git(root, "commit", "-qm", "crlf");
    const result = convert(root, "main");
    expect(result).toMatchObject({ release: "minor", problems: [] });
    expect(read(root, "CHANGELOG.md").replaceAll("\r\n", "\n")).toBe(
      KEEP_CHANGELOG.replace("- a skill\n", "- a skill for agents\n"),
    );
  });
});

describe("placeholders and the branch's version", () => {
  const extra = `\n  placeholders:\n    - { files: ["docs/**"], from: "since: next", to: "since: {version}" }`;
  function filled(): string {
    const root = repository({
      ...files(extra),
      "docs/old.md": "since: 1.1.0\n",
      "docs/new.md": "intro\n",
      "README.md": "intro\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": EDITED,
        "package.json": MANIFEST("1.3.0"),
        "src/x.ts": "y\n",
        "docs/new.md": "intro\nsince: 1.3.0\n",
        "README.md": "intro\nInstall version 1.3.0 of the tool.\n",
      },
      "work",
    );
    return root;
  }

  test("a value the branch filled goes back to its placeholder, and another merge's stamp is left alone", () => {
    const root = filled();
    const result = convert(root, "main");
    expect(read(root, "docs/new.md")).toBe("intro\nsince: next\n");
    expect(read(root, "docs/old.md")).toBe("since: 1.1.0\n");
    expect(result.reverted).toEqual(["docs/new.md"]);
  });

  test("any other line naming the version is listed, not changed", () => {
    const root = filled();
    const result = convert(root, "main");
    expect(result.check).toEqual([
      "README.md:2: Install version 1.3.0 of the tool.",
    ]);
    expect(read(root, "README.md")).toContain("Install version 1.3.0");
  });

  test("a stamp equal to the branch's version that the base already had stays", () => {
    const root = repository({
      ...files(extra),
      "docs/old.md": "since: 1.3.0\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": EDITED,
        "package.json": MANIFEST("1.3.0"),
        "docs/old.md": "since: 1.3.0\nmore\n",
      },
      "work",
    );
    convert(root, "main");
    expect(read(root, "docs/old.md")).toBe("since: 1.3.0\nmore\n");
  });
});

describe("a stamp the branch repeats", () => {
  test("is listed, not put back, when the base has the same line", () => {
    const extra = `\n  placeholders:\n    - { files: ["docs/**"], from: "since: next", to: "since: {version}" }`;
    const root = repository({
      ...files(extra),
      "docs/a.md": "intro\nsince: 1.3.0\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": EDITED,
        "package.json": MANIFEST("1.3.0"),
        "docs/a.md": "since: 1.3.0\nintro\nsince: 1.3.0\n",
      },
      "work",
    );
    const result = convert(root, "main");
    expect(read(root, "docs/a.md")).toBe("since: 1.3.0\nintro\nsince: 1.3.0\n");
    expect(result.reverted).toEqual([]);
    expect(result.check.join("\n")).toContain("docs/a.md:");
  });
});

describe("Common Changelog", () => {
  const section = jigYaml(
    "  file: CHANGELOG.md\n  format: common-changelog\n  release_paths: [src/]",
  );
  test("takes the reference and the authors off an entry, and names the authors in the note", () => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": MANIFEST("1.2.0"),
      "src/x.ts": "x\n",
      ".config/jig.yaml": section,
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": COMMON_CHANGELOG.replace(
          "## [1.2.0]",
          "## [1.3.0] - 2026-02-03\n\n### Added\n\n- Add the retry option ([#7](https://github.com/o/r/pull/7)) (Jane Doe, John Roe)\n\n## [1.2.0]",
        ).replace(
          "[1.2.0]: https",
          "[1.3.0]: https://github.com/o/r/compare/v1.2.0...v1.3.0\n[1.2.0]: https",
        ),
        "package.json": MANIFEST("1.3.0"),
        "src/x.ts": "y\n",
      },
      "work",
    );
    const result = convert(root, "main");
    expect(result).toMatchObject({ release: "minor", problems: [] });
    expect(read(root, `changes/${noteName("work")}`)).toBe(
      "---\nrelease: minor\nauthors: Jane Doe, John Roe\n---\n\n### Added\n\n- Add the retry option\n",
    );
    expect(read(root, "CHANGELOG.md")).toBe(COMMON_CHANGELOG);
  });
});

describe("refusals", () => {
  test("uncommitted changes", () => {
    const root = edited();
    write(root, "scratch.txt", "x\n");
    expect(() => convert(root, "main")).toThrow(/uncommitted changes/);
  });

  test("a stopped merge", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "other");
    commit(root, { "src/x.ts": "other\n" }, "other");
    git(root, "checkout", "-q", "main");
    commit(root, { "src/x.ts": "main\n" }, "main");
    expect(() => git(root, "merge", "other")).toThrow();
    expect(() => convert(root, "main")).toThrow(/merge is stopped/);
  });

  test("a stopped cherry-pick", () => {
    const root = repository(files());
    git(root, "checkout", "-qb", "other");
    commit(root, { "src/x.ts": "other\n" }, "other");
    git(root, "checkout", "-q", "main");
    commit(root, { "src/x.ts": "main\n" }, "main");
    expect(() => git(root, "cherry-pick", "other")).toThrow();
    expect(() => convert(root, "main")).toThrow(/cherry-pick is stopped/);
  });

  test("a base git cannot find", () => {
    const root = edited();
    expect(() => convert(root, "nowhere")).toThrow(/no such revision/);
  });

  test("a detached HEAD", () => {
    const root = edited();
    git(root, "checkout", "-q", "--detach");
    expect(() => convert(root, "main")).toThrow(/detached/);
  });

  test("a note the branch has that cannot be read", () => {
    const root = edited();
    write(root, `changes/${noteName("work")}`, "not a note\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "bad note");
    expect(() => convert(root, "main")).toThrow(/cannot be read/);
  });
});

describe("the command", () => {
  const script = join(import.meta.dir, "..", "scripts", "convert.ts");
  const run = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
    });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };

  test("converts, reports and exits 0", () => {
    const root = edited();
    const result = run(root, "--base", "main");
    expect(result.code).toBe(0);
    expect(result.out).toContain("jig changelog convert (plugin ");
    expect(result.out).toContain(
      `wrote changes/${noteName("work")} (release: minor)`,
    );
    expect(result.out).toContain("uncommitted");
  });

  test("a refusal exits 1 with its reason", () => {
    const root = edited();
    write(root, "scratch.txt", "x\n");
    const result = run(root, "--base", "main");
    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted changes");
  });

  test("--json prints the result alone", () => {
    const root = edited();
    const result = run(root, "--base", "main", "--json", "--dry-run");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      configured: true,
      dryRun: true,
      release: "minor",
    });
  });

  test("an unconfigured repository passes and says so", () => {
    const root = repository({ "a.txt": "a\n" });
    git(root, "checkout", "-qb", "work");
    commit(root, { "a.txt": "b\n" }, "work");
    const result = run(root, "--base", "main");
    expect(result.code).toBe(0);
    expect(result.out).toContain("not configured");
  });
});

/** The files the conversion changed in the working tree, tracked ones only. */
function result(root: string): string[] {
  return git(root, "diff", "--name-only").split("\n").filter(Boolean).sort();
}

describe("what the conversion keeps", () => {
  const branchWith = (
    changelog: string,
    version = "1.3.0",
    extra: Record<string, string> = {},
  ): string => {
    const root = repository(files());
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": changelog,
        "package.json": MANIFEST(version),
        ...extra,
      },
      "work",
    );
    return root;
  };
  const release = (body: string) =>
    KEEP_CHANGELOG.replace(
      "## [1.2.0]",
      `## [1.3.0] - 2026-02-03\n\n${body}\n\n## [1.2.0]`,
    );

  test("a change type that appears twice in a release keeps the entries of both", () => {
    const root = branchWith(
      release("### Added\n\n- the first\n\n### Added\n\n- the second"),
    );
    convert(root, "main");
    expect(read(root, `changes/${noteName("work")}`)).toContain(
      "### Added\n\n- the first\n- the second\n",
    );
  });

  test("a paragraph or a numbered list under a change type is refused, not dropped", () => {
    for (const body of [
      "### Added\n\nA paragraph first.\n\n- an entry",
      "### Added\n\n1. a numbered entry",
      "### Added\n\n+ a plus entry",
    ]) {
      const root = branchWith(release(body));
      expect(() => convert(root, "main")).toThrow(/other than "- " entries/);
      expect(read(root, "CHANGELOG.md")).toBe(release(body));
    }
  });

  test("an entry outside a ### section in another list style is refused", () => {
    const root = branchWith(release("+ a bare entry\n\n### Added\n\n- one"));
    expect(() => convert(root, "main")).toThrow(/outside a ### section/);
  });

  test("a branch that removed the Unreleased heading neither duplicates nor drops its entries", () => {
    const root = branchWith(
      KEEP_CHANGELOG.replace(
        "## [Unreleased]\n\n### Changed\n\n- an earlier docs change\n\n",
        "## [1.3.0] - 2026-02-03\n\n### Changed\n\n- an earlier docs change\n- the branch's change\n\n",
      ),
    );
    const result = convert(root, "main");
    expect(result.problems).toEqual([]);
    expect(read(root, `changes/${noteName("work")}`)).toBe(
      "---\nrelease: minor\n---\n\n### Changed\n\n- the branch's change\n",
    );
    expect(read(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
  });

  test("a branch that removed Unreleased with its entries is told so", () => {
    const root = branchWith(
      KEEP_CHANGELOG.replace(
        "## [Unreleased]\n\n### Changed\n\n- an earlier docs change\n\n",
        "",
      ),
      "1.2.0",
    );
    const result = convert(root, "main");
    expect(result.problems.join("\n")).toContain("an earlier docs change");
    expect(read(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
  });

  test("a removed or renamed release section is refused", () => {
    const root = branchWith(
      KEEP_CHANGELOG.replace(
        "## [1.2.0] - 2026-01-02",
        "## [1.2.5] - 2026-01-02",
      ),
      "1.2.0",
    );
    expect(() => convert(root, "main")).toThrow(
      /removes or renames the release section of 1\.2\.0/,
    );
  });

  test("an entry the note already holds is not added twice", () => {
    const root = edited();
    write(
      root,
      `changes/${noteName("work")}`,
      "---\nrelease: minor\n---\n\n### Changed\n\n- the branch's docs change\n",
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "note begun");
    convert(root, "main");
    const note = read(root, `changes/${noteName("work")}`);
    expect(note.split("- the branch's docs change").length - 1).toBe(1);
  });

  test("a reference-style link in the release summary is reported", () => {
    const root = branchWith(
      release("See [the guide][guide].\n\n### Added\n\n- one"),
    );
    const result = convert(root, "main");
    expect(result.problems.join("\n")).toContain("reference-style link");
  });

  test("a changelog the base created after the branch forked has nothing to convert", () => {
    const root = repository({
      "package.json": MANIFEST("1.2.0"),
      "src/x.ts": "x\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(root, { "src/x.ts": "y\n" }, "work");
    git(root, "checkout", "-q", "main");
    commit(
      root,
      { "CHANGELOG.md": KEEP_CHANGELOG, ".config/jig.yaml": section() },
      "adopt",
    );
    git(root, "checkout", "-q", "work");
    const result = convert(root, "main");
    expect(result).toMatchObject({
      configured: true,
      note: null,
      restored: [],
      problems: [],
    });
    expect(existsSync(join(root, "CHANGELOG.md"))).toBe(false);
  });

  test("a version file the base added after the branch forked leaves the branch's other edits converted", () => {
    const root = edited();
    git(root, "checkout", "-q", "main");
    commit(
      root,
      {
        VERSION: "1.2.0\n",
        ".config/jig.yaml": section(
          "\n  version:\n    files:\n      - { path: package.json, key: version }\n      - { path: VERSION }",
        ),
      },
      "a second version file",
    );
    git(root, "checkout", "-q", "work");
    const result = convert(root, "main");
    expect(result).toMatchObject({
      note: `changes/${noteName("work")}`,
      release: "minor",
      restored: ["CHANGELOG.md", "package.json"],
    });
    expect(read(root, "package.json")).toBe(MANIFEST("1.2.0"));
    expect(existsSync(join(root, "VERSION"))).toBe(false);
  });

  test("a changelog both the branch and the base created after the fork is refused", () => {
    const root = repository({
      "package.json": MANIFEST("1.2.0"),
      "src/x.ts": "x\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(root, { "CHANGELOG.md": EDITED }, "work");
    git(root, "checkout", "-q", "main");
    commit(
      root,
      { "CHANGELOG.md": KEEP_CHANGELOG, ".config/jig.yaml": section() },
      "adopt",
    );
    git(root, "checkout", "-q", "work");
    expect(() => convert(root, "main")).toThrow(
      /CHANGELOG\.md: the branch created it on its own/,
    );
  });

  test("a stamp the base had on a line the branch edits stays", () => {
    const extra = `\n  placeholders:\n    - { files: ["docs/**"], from: "since: next", to: "since: {version}" }`;
    const root = repository({
      ...files(extra),
      "docs/a.md": "Feature A — since: 1.3.0\n",
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      {
        "CHANGELOG.md": EDITED,
        "package.json": MANIFEST("1.3.0"),
        "docs/a.md": "Feature A clarified — since: 1.3.0\n",
      },
      "work",
    );
    convert(root, "main");
    expect(read(root, "docs/a.md")).toBe(
      "Feature A clarified — since: 1.3.0\n",
    );
  });

  test("a long branch name gives a bounded note name that still tells names apart", () => {
    const long = `feature/${"a".repeat(300)}`;
    expect(noteName(long).length).toBeLessThanOrEqual(64 + 1 + 8 + 3);
    expect(noteName(long)).not.toBe(noteName(`${long}b`));
  });
});

describe("authors in Common Changelog", () => {
  const section = jigYaml(
    "  file: CHANGELOG.md\n  format: common-changelog\n  release_paths: [src/]",
  );
  const credited = COMMON_CHANGELOG.replace(
    "## [1.2.0]",
    "## [1.3.0] - 2026-02-03\n\n### Added\n\n- Add the retry option ([#7](https://github.com/o/r/pull/7)) (Jane Doe)\n\n## [1.2.0]",
  ).replace(
    "[1.2.0]: https",
    "[1.3.0]: https://github.com/o/r/compare/v1.2.0...v1.3.0\n[1.2.0]: https",
  );
  const withNote = (note: string): string => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": MANIFEST("1.2.0"),
      "src/x.ts": "x\n",
      ".config/jig.yaml": section,
    });
    git(root, "checkout", "-qb", "work");
    commit(root, { [`changes/${noteName("work")}`]: note }, "note", "Sam Note");
    commit(
      root,
      {
        "CHANGELOG.md": credited,
        "package.json": MANIFEST("1.3.0"),
        "src/x.ts": "y\n",
      },
      "work",
    );
    return root;
  };

  test("a note whose authors come from history keeps them beside the converted credits", () => {
    const root = withNote(
      "---\nrelease: patch\n---\n\n### Fixed\n\n- Fix it\n",
    );
    convert(root, "main");
    expect(read(root, `changes/${noteName("work")}`)).toContain(
      "authors: Sam Note, Jane Doe\n",
    );
  });

  test("an explicit empty authors list is kept", () => {
    const root = withNote(
      "---\nrelease: patch\nauthors: []\n---\n\n### Fixed\n\n- Fix it\n",
    );
    write(
      root,
      "CHANGELOG.md",
      credited.replace(" ([#7](https://github.com/o/r/pull/7)) (Jane Doe)", ""),
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "no credit");
    convert(root, "main");
    expect(read(root, `changes/${noteName("work")}`)).toContain(
      "authors: []\n",
    );
  });
});

describe("the command's exit codes", () => {
  const script = join(import.meta.dir, "..", "scripts", "convert.ts");
  test("an invalid configuration at the base exits 2", () => {
    const root = repository({
      ...files(),
      ".config/jig.yaml": jigYaml("  file: CHANGELOG.md\n  format: nonsense"),
    });
    git(root, "checkout", "-qb", "work");
    commit(root, { "src/x.ts": "y\n" }, "work");
    const result = spawnSync(process.execPath, [script, "--base", "main"], {
      cwd: root,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
    });
    expect([result.status, result.stderr]).toEqual([2, expect.any(String)]);
    expect(result.stderr).toContain("changelog.format");
  });
});
