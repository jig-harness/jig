import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../../lib/guarded-git-spawn.ts";
import {
  applyNotes,
  type ChangeNote,
  nextVersion,
  parseNote,
  rebaseLinks,
  releasedVersions,
  unreleasedSection,
} from "./change-notes.ts";
import { checkNotes } from "./check.ts";
import { release } from "./release.ts";

const note = (file: string, text: string): ChangeNote => {
  const { note: parsed, errors } = parseNote(file, text);
  expect(errors).toEqual([]);
  if (!parsed) throw new Error("unreachable");
  return parsed;
};

describe("parseNote", () => {
  test("reads the release, the lead and each section's items", () => {
    const parsed = note(
      "a.md",
      "---\nrelease: minor # a new skill\n---\n\nThe lead.\n\n### Added\n\n- one\n  continued\n- two\n\n### Fixed\n\n- three\n",
    );
    expect(parsed.release).toBe("minor");
    expect(parsed.lead).toBe("The lead.");
    expect([...parsed.sections]).toEqual([
      ["Added", ["- one\n  continued", "- two"]],
      ["Fixed", ["- three"]],
    ]);
  });

  test("a note without front matter ships in no release", () => {
    expect(note("a.md", "### Changed\n\n- docs\n").release).toBeNull();
  });

  const errors = (text: string) => parseNote("n.md", text).errors.join("\n");
  test("a note holds only what the release step models", () => {
    // Each of these could change how the changelog renders after the note.
    expect(
      errors("### Added\n\n- x\n\n      ```\n## [9.9.9]\n      ```\n"),
    ).toContain("no fenced code block");
    expect(
      errors("### Added\n\n- x\n\n      ```\n## [9.9.9]\n      ```\n"),
    ).toContain("writes the version heading");
    expect(errors("### Added\n\n- x\n~~~\n")).toContain("no fenced code block");
    expect(errors("### Added\n\n- x\n\n[9.9.9]\n--------\n")).toContain(
      "makes the line above it a heading",
    );
    expect(errors("### Added\n\n- x\n  ===\n")).toContain(
      "makes the line above it a heading",
    );
    expect(errors("### Added\n\n- x\n\n<!--\n")).toContain("no raw HTML");
    expect(errors("### Added\n\n- x <div>\n")).toContain("no raw HTML");
    expect(errors("### Added\n\n- tags v<version>\n")).toContain("no raw HTML");
    expect(errors("### Added\n\n- [g](../a(b).md)\n")).toContain(
      "cannot rewrite",
    );
    expect(errors("### Added\n\n- [g](../a b.md)\n")).toContain(
      "cannot rewrite",
    );
    // What looks like them but is not.
    note(
      "a.md",
      "### Added\n\n- See <https://x.y/z>, <a@b.c>, \\<b>, `<div>`, ```inline```,\n  [g](<../a b.md>) and [h](../a.md 'T').\n",
    );
  });

  test("refuses what the release step could not place", () => {
    expect(errors("---\nrelease: huge\n---\n### Added\n\n- x\n")).toContain(
      "release is one of",
    );
    expect(errors("---\nscope: x\n---\n### Added\n\n- x\n")).toContain(
      "only `release`",
    );
    expect(errors("---\nrelease: patch\n### Added\n\n- x\n")).toContain(
      "never closed",
    );
    expect(errors("## [1.0.0]\n\n### Added\n\n- x\n")).toContain(
      "writes the version heading",
    );
    expect(errors("### Improved\n\n- x\n")).toContain("not a change type");
    expect(errors("### Added\n\n- x\n\n### Added\n\n- y\n")).toContain(
      "appears twice",
    );
    expect(errors("### Added\n\nprose\n")).toContain("outside a list item");
    expect(errors("### Added\n")).toContain("lists no change");
    expect(errors("just prose\n")).toContain("at least one ### section");
    expect(errors("A lead.\n\n### Added\n\n- x\n")).toContain(
      "needs `release:`",
    );
    expect(errors("### Added\n\n- x\n\n  ```md\n  example\n")).toContain(
      "no fenced code block",
    );
    expect(errors("### Added\n\n- x\n##\t[9.9.9]\n")).toContain(
      "writes the version heading",
    );
  });

  test("malformed front matter is refused, never read leniently", () => {
    expect(
      errors("---\nrelease: major\nrelease: patch\n---\n### Added\n\n- x\n"),
    ).toContain("`release` twice");
    expect(errors("---\nrelease: 'patch\"\n---\n### Added\n\n- x\n")).toContain(
      "release is one of",
    );
    expect(
      note("a.md", "---\nrelease: 'patch'\n---\n### Added\n\n- x\n").release,
    ).toBe("patch");
  });
});

describe("rebaseLinks", () => {
  test("a link relative to the note is made relative to the changelog", () => {
    const moved = rebaseLinks(
      note(
        "changes/a.md",
        "---\nrelease: patch\n---\n\nSee [M1](../modules/M1/README.md#x).\n\n### Fixed\n\n- [here](README.md \"the guide\"), [site](https://example.com/a), [top](#top), [root](/abs)\n- [a](a.md 'A'), [b](b.md (B))\n",
      ),
      "changes",
      ".",
    );
    expect(moved.lead).toBe("See [M1](modules/M1/README.md#x).");
    expect(moved.sections.get("Fixed")).toEqual([
      '- [here](changes/README.md "the guide"), [site](https://example.com/a), [top](#top), [root](/abs)',
      "- [a](changes/a.md 'A'), [b](changes/b.md (B))",
    ]);
  });

  test("a link shown as code does not move, even across a paragraph's lines", () => {
    const moved = rebaseLinks(
      note(
        "changes/a.md",
        "### Fixed\n\n- See [g](<../docs/a b.md>), [u](<https://x.y/z>), not `[x](../a.md)` or ``[y](../b.md)``.\n\n  A literal \\` and [z](../c.md) and \\`.\n\n- A span `opens\n  [w](../d.md)\n  closes` here; [v](../e.md) moves.\n",
      ),
      "changes",
      ".",
    );
    expect(moved.sections.get("Fixed")).toEqual([
      "- See [g](<docs/a b.md>), [u](<https://x.y/z>), not `[x](../a.md)` or ``[y](../b.md)``.\n\n  A literal \\` and [z](c.md) and \\`.",
      "- A span `opens\n  [w](../d.md)\n  closes` here; [v](e.md) moves.",
    ]);
  });

  test("a reference definition is refused: its label would be the changelog's", () => {
    const { errors } = parseNote(
      "changes/a.md",
      "### Fixed\n\n- See [guide][g].\n\n  [g]: ../docs/README.md\n",
    );
    expect(errors).toEqual([
      "changes/a.md: `[g]: ../docs/README.md` — write the link inline; a reference label is shared by every note in the changelog, so two notes could define it differently. Put a literal ]: in a code span",
    ]);
  });

  test("a reference definition is refused inside a list item, a quote, or across lines", () => {
    for (const body of [
      "- [Unreleased]: https://example.com/wrong\n- ordinary\n",
      "- ordinary\n\n> [Unreleased]: https://example.com/wrong\n",
      "- ordinary\n\n[Unre\nleased]: https://example.com/wrong\n",
    ]) {
      const { errors } = parseNote("changes/a.md", `### Fixed\n\n${body}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("write the link inline");
    }
  });

  test("a literal ]: in a code span is not a definition", () => {
    const { errors } = parseNote(
      "changes/a.md",
      "### Fixed\n\n- The `[label]: url` form is refused.\n",
    );
    expect(errors).toEqual([]);
  });
});

describe("nextVersion", () => {
  test("the largest bump wins", () => {
    expect(nextVersion("0.29.3", [])).toBeNull();
    expect(nextVersion("0.29.3", ["patch"])).toBe("0.29.4");
    expect(nextVersion("0.29.3", ["patch", "minor"])).toBe("0.30.0");
    expect(nextVersion("0.29.3", ["minor", "major"])).toBe("1.0.0");
  });
  test("a pre-release version is not moved", () => {
    expect(() => nextVersion("1.0.0-pilot", ["patch"])).toThrow("plain");
  });
});

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Changed

- an earlier docs change

## [1.2.0] - 2026-01-02

### Added

- a skill

[Unreleased]: https://example.com/r/compare/v1.2.0...HEAD
[1.2.0]: https://example.com/r/compare/v1.1.0...v1.2.0
`;
const OPTIONS = { previous: "1.2.0", date: "2026-02-03", tagPrefix: "v" };

describe("applyNotes", () => {
  test("a note without a release joins Unreleased, in change-type order", () => {
    const out = applyNotes(
      CHANGELOG,
      [
        note("a.md", "### Fixed\n\n- a fix\n"),
        note("b.md", "### Added\n\n- an addition\n\n### Changed\n\n- more\n"),
      ],
      { ...OPTIONS, version: null },
    );
    expect(out).toContain(
      "## [Unreleased]\n\n### Added\n\n- an addition\n\n### Changed\n\n- an earlier docs change\n- more\n\n### Fixed\n\n- a fix\n\n## [1.2.0] - 2026-01-02",
    );
    expect(out).toContain(
      "[Unreleased]: https://example.com/r/compare/v1.2.0...HEAD",
    );
  });

  test("notes with a release become the version's section, links moved", () => {
    const out = applyNotes(
      CHANGELOG,
      [
        note(
          "a.md",
          "---\nrelease: patch\n---\n\nFirst.\n\n### Fixed\n\n- a\n",
        ),
        note(
          "b.md",
          "---\nrelease: minor\n---\n\nSecond.\n\n### Added\n\n- b\n",
        ),
        note("c.md", "### Changed\n\n- docs\n"),
      ],
      { ...OPTIONS, version: "1.3.0" },
    );
    expect(out).toContain(
      "- an earlier docs change\n- docs\n\n## [1.3.0] - 2026-02-03\n\nFirst.\n\nSecond.\n\n### Added\n\n- b\n\n### Fixed\n\n- a\n\n## [1.2.0] - 2026-01-02",
    );
    expect(out).toContain(
      "[Unreleased]: https://example.com/r/compare/v1.3.0...HEAD\n[1.3.0]: https://example.com/r/compare/v1.2.0...v1.3.0\n[1.2.0]:",
    );
    expect(releasedVersions(out)).toEqual(["1.3.0", "1.2.0"]);
  });

  test("an empty Unreleased with only links below stays empty", () => {
    const out = applyNotes(
      "# Changelog\n\n## [Unreleased]\n\n[Unreleased]: https://example.com/r/compare/v0.1.0...HEAD\n",
      [note("a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n")],
      { ...OPTIONS, previous: "0.1.0", version: "0.2.0" },
    );
    expect(out).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-03\n\n### Added\n\n- x\n\n[Unreleased]: https://example.com/r/compare/v0.2.0...HEAD\n[0.2.0]: https://example.com/r/compare/v0.1.0...v0.2.0\n",
    );
  });

  test("a changelog without Unreleased is refused", () => {
    expect(() =>
      applyNotes("# Changelog\n", [], { ...OPTIONS, version: null }),
    ).toThrow("no `## [Unreleased]`");
  });

  test("unreleasedSection reads Unreleased without the links", () => {
    expect(unreleasedSection(CHANGELOG)).toBe(
      "### Changed\n\n- an earlier docs change",
    );
  });
});

// A scratch repository: notes, a changelog and two manifests on main.
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);
function git(root: string, ...args: string[]): string {
  return gitAt(root, {}, ...args);
}
function gitAt(
  root: string,
  extra: Record<string, string>,
  ...args: string[]
): string {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { env: { ...env, ...extra } },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
const MANIFEST = (v: string) => `{\n  "name": "p",\n  "version": "${v}"\n}\n`;
const CONFIG = {
  notes: "changes",
  changelog: "CHANGELOG.md",
  versionFiles: ["a/plugin.json", "b/plugin.json"],
};
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "change-notes-"));
  scratch.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "CHANGELOG.md", CHANGELOG);
  write(root, "a/plugin.json", MANIFEST("1.2.0"));
  write(root, "b/plugin.json", MANIFEST("1.2.0"));
  write(root, "changes/README.md", "How to write a note.\n");
  write(root, "src/x.ts", "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

describe("release", () => {
  test("writes the notes in merge order, moves the version, deletes the notes", () => {
    const root = repository();
    // b lands before a: merge order, not name order, decides.
    write(
      root,
      "changes/b.md",
      "---\nrelease: patch\n---\n### Fixed\n\n- b, in [x](../src/x.ts)\n",
    );
    // b's commit claims a later date than a's: history decides, not dates.
    git(root, "add", "-A");
    gitAt(
      root,
      { GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" },
      "commit",
      "-qm",
      "b",
    );
    write(root, "changes/a.md", "---\nrelease: minor\n---\n### Fixed\n\n- a\n");
    git(root, "add", "-A");
    gitAt(
      root,
      { GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
      "commit",
      "-qm",
      "a",
    );
    const result = release({
      root,
      ...CONFIG,
      tagPrefix: "v",
      date: "2026-02-03",
    });
    expect(result.version).toBe("1.3.0");
    expect(result.notes).toEqual(["changes/b.md", "changes/a.md"]);
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(
      "## [1.3.0] - 2026-02-03\n\n### Fixed\n\n- b, in [x](src/x.ts)\n- a\n",
    );
    expect(readFileSync(join(root, "a/plugin.json"), "utf8")).toBe(
      MANIFEST("1.3.0"),
    );
    expect(readFileSync(join(root, "b/plugin.json"), "utf8")).toBe(
      MANIFEST("1.3.0"),
    );
    expect(existsSync(join(root, "changes/a.md"))).toBe(false);
    expect(existsSync(join(root, "changes/README.md"))).toBe(true);
  });

  test("per merge, each merge is its own release, and a reused name counts from its new merge", () => {
    const root = repository();
    const land = (file: string, text: string) => {
      write(root, file, text);
      git(root, "add", "-A");
      gitAt(
        root,
        { GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
        "commit",
        "-qm",
        file,
      );
    };
    land("changes/z.md", "### Changed\n\n- old z\n");
    rmSync(join(root, "changes/z.md"));
    land("changes/y.md", "---\nrelease: patch\n---\n### Fixed\n\n- y\n");
    land("changes/z.md", "---\nrelease: minor\n---\n### Added\n\n- z\n");
    const run = () =>
      release({
        root,
        ...CONFIG,
        tagPrefix: "v",
        date: "2026-02-03",
        perMerge: true,
      });
    const first = run();
    expect([first.version, first.notes, first.remaining]).toEqual([
      "1.2.1",
      ["changes/y.md"],
      1,
    ]);
    const second = run();
    expect([second.version, second.notes, second.remaining]).toEqual([
      "1.3.0",
      ["changes/z.md"],
      0,
    ]);
    expect(run().notes).toEqual([]);
  });

  test("a placeholder for the version is filled in only by a release", () => {
    const stamps = [
      {
        files: ["criteria/*.yaml"],
        from: "since: next",
        to: "since: {version}",
      },
    ];
    const root = repository();
    write(
      root,
      "criteria/a.yaml",
      "- id: x\n  since: next\n- id: y\n  since: 1.0.0\n",
    );
    write(root, "changes/a.md", "### Changed\n\n- docs\n");
    expect(
      release({ root, ...CONFIG, tagPrefix: "v", stamps }).stamped,
    ).toEqual([]);
    expect(readFileSync(join(root, "criteria/a.yaml"), "utf8")).toContain(
      "since: next",
    );
    write(root, "changes/b.md", "---\nrelease: minor\n---\n### Added\n\n- x\n");
    const result = release({ root, ...CONFIG, tagPrefix: "v", stamps });
    expect(result.stamped).toEqual(["criteria/a.yaml"]);
    expect(readFileSync(join(root, "criteria/a.yaml"), "utf8")).toBe(
      "- id: x\n  since: 1.3.0\n- id: y\n  since: 1.0.0\n",
    );
  });

  test("per merge, a release fills in only the placeholders its merge or an earlier one added", () => {
    const stamps = [
      {
        files: ["criteria/*.yaml"],
        from: "since: next",
        to: "since: {version}",
      },
    ];
    const root = repository();
    const land = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) write(root, path, text);
      git(root, "add", "-A");
      git(root, "commit", "-qm", Object.keys(files).join(" "));
    };
    land({
      "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- a\n",
      "criteria/x.yaml": "- id: a\n  since: next\n",
    });
    land({
      "changes/b.md": "---\nrelease: minor\n---\n### Added\n\n- b\n",
      "criteria/x.yaml": "- id: a\n  since: next\n- id: b\n  since: next\n",
      "criteria/y.yaml": "- id: c\n  since: next\n",
    });
    const run = () =>
      release({ root, ...CONFIG, tagPrefix: "v", stamps, perMerge: true });
    const first = run();
    expect([first.version, first.stamped]).toEqual([
      "1.2.1",
      ["criteria/x.yaml"],
    ]);
    expect(readFileSync(join(root, "criteria/x.yaml"), "utf8")).toBe(
      "- id: a\n  since: 1.2.1\n- id: b\n  since: next\n",
    );
    git(root, "commit", "-qam", "release 1.2.1");
    const second = run();
    expect([second.version, second.stamped]).toEqual([
      "1.3.0",
      ["criteria/x.yaml", "criteria/y.yaml"],
    ]);
    expect(readFileSync(join(root, "criteria/x.yaml"), "utf8")).toBe(
      "- id: a\n  since: 1.2.1\n- id: b\n  since: 1.3.0\n",
    );
  });

  test("per merge, a shallow clone is refused: its merge order cannot be told", () => {
    const origin = repository();
    write(origin, "changes/a.md", "### Changed\n\n- a\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "a");
    const root = mkdtempSync(join(tmpdir(), "change-notes-shallow-"));
    scratch.push(root);
    git(origin, "clone", "-q", "--depth", "1", `file://${origin}`, root);
    expect(() =>
      release({ root, ...CONFIG, tagPrefix: "v", perMerge: true }),
    ).toThrow("shallow clone");
    expect(
      release({ root, ...CONFIG, tagPrefix: "v", dryRun: true }).notes,
    ).toEqual(["changes/a.md"]);
  });

  test("per merge, history git cannot read and a note no merge holds are refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "change-notes-nogit-"));
    scratch.push(outside);
    write(outside, "CHANGELOG.md", CHANGELOG);
    write(outside, "a/plugin.json", MANIFEST("1.2.0"));
    write(outside, "b/plugin.json", MANIFEST("1.2.0"));
    write(outside, "changes/a.md", "### Changed\n\n- a\n");
    expect(() =>
      release({ root: outside, ...CONFIG, tagPrefix: "v", perMerge: true }),
    ).toThrow("cannot read its history");
    const root = repository();
    write(root, "changes/a.md", "### Changed\n\n- a\n");
    expect(() =>
      release({ root, ...CONFIG, tagPrefix: "v", perMerge: true }),
    ).toThrow("every note must be committed");
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });

  test("a dry run writes nothing, and no notes is no change", () => {
    const root = repository();
    expect(
      release({ root, ...CONFIG, tagPrefix: "v", dryRun: true }).notes,
    ).toEqual([]);
    write(root, "changes/a.md", "### Changed\n\n- docs\n");
    const result = release({ root, ...CONFIG, tagPrefix: "v", dryRun: true });
    expect(result.version).toBeNull();
    expect(result.changelog).toContain("- docs");
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });

  test("a malformed note or disagreeing manifests stop it before any write", () => {
    const root = repository();
    write(root, "changes/a.md", "### Improved\n\n- x\n");
    expect(() => release({ root, ...CONFIG, tagPrefix: "v" })).toThrow(
      "not a change type",
    );
    rmSync(join(root, "changes/a.md"));
    write(root, "b/plugin.json", MANIFEST("1.1.0"));
    write(root, "changes/a.md", "---\nrelease: patch\n---\n### Fixed\n\n- x\n");
    expect(() => release({ root, ...CONFIG, tagPrefix: "v" })).toThrow(
      "disagree",
    );
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    // The last manifest cannot be set; neither the changelog nor the first moves.
    const nested = `{\n  "version": "1.2.0",\n  "x": { "version": "1.2.0" }\n}\n`;
    write(root, "b/plugin.json", nested);
    expect(() => release({ root, ...CONFIG, tagPrefix: "v" })).toThrow(
      "expected one",
    );
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
    expect(readFileSync(join(root, "a/plugin.json"), "utf8")).toBe(
      MANIFEST("1.2.0"),
    );
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });
});

describe("checkNotes", () => {
  const check = (root: string) =>
    checkNotes({ root, ...CONFIG, releasePaths: ["src/"], base: "main" });
  function branch(): string {
    const root = repository();
    git(root, "checkout", "-qb", "work");
    return root;
  }

  test("on the base itself only the notes are checked", () => {
    const root = repository();
    expect(check(root)).toEqual({ findings: [], skipped: "HEAD is main" });
    expect(
      checkNotes({ root, ...CONFIG, releasePaths: [], base: null }).skipped,
    ).toBe("no base branch given");
  });

  test("a base git cannot compare against is a finding, not a skip", () => {
    const root = branch();
    const result = checkNotes({
      root,
      ...CONFIG,
      releasePaths: ["src/"],
      base: "origin/nowhere",
    });
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
    rmSync(join(root, "CHANGELOG.md"));
    expect(check(root).findings.join("\n")).toContain("deletes the changelog");
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
    expect(check(root)).toEqual({ findings: [], skipped: null });
    // Committed counts the same as in the working tree.
    git(root, "add", "-A");
    git(root, "commit", "-qm", "work");
    expect(check(root)).toEqual({ findings: [], skipped: null });
  });

  test("the version and the changelog's sections are the release step's", () => {
    const root = branch();
    write(root, "a/plugin.json", MANIFEST("1.3.0"));
    write(
      root,
      "CHANGELOG.md",
      CHANGELOG.replace(
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
    expect(findings).toContain("CHANGELOG.md: the branch edits Unreleased");
    expect(findings).toContain("adds or removes a release section");
  });

  test("an earlier release's text may still be corrected", () => {
    const root = branch();
    write(
      root,
      "CHANGELOG.md",
      CHANGELOG.replace("- a skill", "- a new skill"),
    );
    expect(check(root)).toEqual({ findings: [], skipped: null });
  });
});
