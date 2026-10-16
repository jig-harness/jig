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
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
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
    for (const [text, why] of [
      [
        "### Added\n\n- x\n\n      ```\n## [9.9.9]\n      ```\n",
        "no code block",
      ],
      ["### Added\n\n- x\n\n```\ncode\n```\n", "no code block"],
      ["### Added\n\n- x\n~~~\n", "no code block"],
      ["### Added\n\n- x\n\n[9.9.9]\n--------\n", "writes the version heading"],
      ["### Added\n\n- x\n  ===\n", "writes the version heading"],
      ["### Added\n\n- x\n\n---\n", "is a rule"],
      ["### Added\n\n- x\n\n<!--\n", "no raw HTML"],
      ["### Added\n\n- x <div>\n", "no raw HTML"],
      ["### Added\n\n- tags v<version>\n", "no raw HTML"],
      ["### Added\n\n- [<b>x</b>](y)\n", "no raw HTML"],
      ["### Added\n\n- x\n\n> quoted\n", "no quote"],
      ["### Added\n\n- ![alt](a.png)\n", "no image"],
      ["### Added\n\n- [ ] task\n", "no task list"],
      ["### Added\n\n- x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", "no table"],
      ["### Added\n\n- ~~x~~\n", "no strikethrough"],
      ["### Added\n\n- [g](../a(b).md)\n", "cannot rewrite"],
      ["### Added\n\n- [g](../a b.md)\n", "cannot rewrite"],
    ] as const)
      expect(errors(text), text).toContain(why);
    // What looks like them but is not.
    note(
      "a.md",
      "### Added\n\n- See <https://x.y/z>, <mailto:a@b.c>, \\<b>, `<div>`, ```inline```,\n  [g](<../a b.md>) and [h](../a.md 'T'). **Breaking**, _a_.\n",
    );
  });

  test("blocks are told by the parser, not by blank lines", () => {
    // Separate list items are separate blocks without a blank line between
    // them, so a span cannot run from one into the next and hide a comment.
    expect(errors("### Added\n\n- literal ``\n- <!-- \n")).toContain(
      "no raw HTML",
    );
    expect(errors("### Added\n\n- literal `\n- <!-- `\n")).toContain(
      "no raw HTML",
    );
  });

  test("an escaping backslash is told from the whole run before the `<`", () => {
    const html = (backslashes: number) =>
      errors(`### Added\n\n- ${"\\".repeat(backslashes)}<img src="x">\n`);
    // An odd run ends in an escaping backslash; an even one leaves the `<` live.
    for (const run of [2, 4]) expect(html(run)).toContain("no raw HTML");
    for (const run of [1, 3]) expect(html(run)).toBe("");
  });

  test("what a renderer reads differently from the splitter is refused", () => {
    // An indented fence line is no fence: it must not hide a heading.
    expect(
      errors(
        "### Added\n\n- ok\n\ntext\n    ~~~\n### Bogus\n\ntext\n    ~~~\n",
      ),
    ).toContain("not a change type");
    // A declaration with a lowercase letter is HTML to the CommonMark spec.
    expect(
      errors("### Fixed\n\n- Accept a `doc\n<!doctype html` header\n"),
    ).toContain("no raw HTML");
    // A footnote definition moves its text out of the entry.
    expect(errors("### Fixed\n\n- [^1]: hidden text, in words\n")).toContain(
      "no footnote",
    );
    expect(errors("### Fixed\n\n- a\n\n  [^1]: hidden text\n")).toContain(
      "no footnote",
    );
    // Text after the list, or another kind of marker, ends the list.
    expect(errors("### Fixed\n\n- a\n\nstray paragraph\n")).toContain(
      "outside a list item",
    );
    expect(errors("### Fixed\n\n- a\n1. b\n")).toContain("outside a list item");
    // So does a line indented too little to continue the item.
    for (const text of [
      "### Fixed\n\n- a\n\n stray paragraph\n",
      "### Fixed\n\n- a\n 1. b\n",
      "### Fixed\n\n- a\n\n + b\n",
    ])
      expect(errors(text), text).toContain("outside a list item");
    // A backtick inside an autolink pairs with no later one, so the link
    // after it is rewritten like any other.
    expect(
      errors(
        "### Fixed\n\n- See <https://example.com/`x> and [guide](../docs/README.md), then `.\n",
      ),
    ).toContain("reads its links differently");
    // A missed link and a spurious rewrite do not cancel out.
    expect(
      errors(
        "### Fixed\n\n- <https://example.com/`x> [real](../a.md) ` [literal](../b.md) `\n",
      ),
    ).toContain("reads its links differently");
    note(
      "a.md",
      "### Fixed\n\n- a\n  continued\n\n  and a second paragraph\n- b\n",
    );
  });

  test("what is literal to every renderer stays allowed", () => {
    // A declaration or footnote definition inside a code span, escaped, or
    // in a link's title, away from the start of a line.
    note(
      "a.md",
      "### Fixed\n\n- Recognize the `<!doctype html>` declaration.\n",
    );
    note("a.md", "### Fixed\n\n- Recognize \\<!doctype html> too.\n");
    note("a.md", "### Fixed\n\n- Show `[^1]: example` literally.\n");
    note("a.md", '### Fixed\n\n- See [x](a.md "[^1]: t").\n');
    // Indented four or more columns past its list item's text, a line
    // continues the paragraph, so a code span wrapped over it stays one.
    note(
      "a.md",
      "### Fixed\n\n- Show `line\n      <!doctype html>\n  end` literally.\n",
    );
    note(
      "a.md",
      "### Fixed\n\n- Show `line\n      [^1]: example\n  end` literally.\n",
    );
    // Three columns or fewer past it, the same line opens a block.
    for (const indent of ["  ", "     ", "\t"])
      expect(
        errors(
          `### Fixed\n\n- Show \`line\n${indent}<!doctype html>\n  end\` literally.\n`,
        ),
        indent,
      ).toContain("no raw HTML");
    expect(
      errors("### Fixed\n\n- a\n  - Show `line\n     [^1]: x\n    end`\n"),
    ).toContain("no footnote");
    // A nested list that has closed no longer sets where a line opens a block.
    for (const literal of ["[^1]: example", "<!doctype html>"])
      note(
        "a.md",
        `### Fixed\n\n- outer\n  - nested\n- Show \`line\n      ${literal}\n  end\` literally.\n`,
      );
    // A lowercase declaration mid-line is still HTML.
    expect(errors("### Fixed\n\n- Accept <!doctype html> here.\n")).toContain(
      "no raw HTML",
    );
  });

  test("one block-opening token among literal ones is still refused", () => {
    for (const [literal, opening, problem] of [
      ["<!doctype html>", "<!doctype html>", "no raw HTML"],
      ["[^1]: example", "[^2]: example", "no footnote"],
    ] as const) {
      const literals = `- Show \`${literal}\` literally.\n`.repeat(3);
      const opens = `- Show \`line\n  ${opening}\n  end\`\n`;
      for (const body of [literals + opens, opens + literals])
        expect(errors(`### Fixed\n\n${body}`), body).toContain(problem);
    }
  });

  test("the parses a note costs do not grow with the tokens it holds", () => {
    const render = Bun.markdown.render;
    const parses = (body: string): number => {
      let calls = 0;
      Bun.markdown.render = ((...args: Parameters<typeof render>) => {
        calls++;
        return render(...args);
      }) as typeof render;
      try {
        parseNote("a.md", `### Fixed\n\n${body}`);
      } finally {
        Bun.markdown.render = render;
      }
      return calls;
    };
    const item = (n: number) =>
      `- ${"Show `<!doctype html>`, `[^1]: x` and `[l]: y` literally. ".repeat(n)}\n`;
    expect(parses(item(200))).toBe(parses(item(1)));
  });

  test("a code span with backticks on a line of its own is not a fence", () => {
    note("a.md", "### Added\n\n- Example:\n  ```inline```\n");
    note("a.md", "### Added\n\n- Example\n\n  ``` `x` ```\n");
  });

  test("a `]:` in a link's title or destination is not a reference definition", () => {
    note(
      "a.md",
      '### Fixed\n\n- See [guide](https://example.com/guide "Status ]: ready").\n',
    );
    note(
      "a.md",
      "### Fixed\n\n- See [a](<b]:c>) and the text `]:` or a]: b.\n",
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
    expect(errors("#### Added\n\n- x\n")).toContain(
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
      "no code block",
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

  test("a destination holding an @ moves; an email address is written as <mailto:…>", () => {
    const moved = rebaseLinks(
      note(
        "changes/a.md",
        "### Fixed\n\n- [g](guide@2.md), [guide@2.md](guide@2.md), [p](@scope/guide.md), <mailto:a@b.c>\n",
      ),
      "changes",
      ".",
    );
    expect(moved.sections.get("Fixed")).toEqual([
      "- [g](changes/guide@2.md), [guide@2.md](changes/guide@2.md), [p](changes/@scope/guide.md), <mailto:a@b.c>",
    ]);
    // The parser gives a bare email autolink a relative destination the
    // release step does not rewrite, so it is refused rather than guessed at.
    expect(
      parseNote(
        "changes/a.md",
        "### Fixed\n\n- Write to <a@b.c>.\n",
      ).errors.join("\n"),
    ).toContain("<mailto:");
  });

  test("a reference definition is refused: its label would be the changelog's", () => {
    const { errors } = parseNote(
      "changes/a.md",
      "### Fixed\n\n- See [guide][g].\n\n  [g]: ../docs/README.md\n",
    );
    expect(errors).toEqual([
      "changes/a.md: write the link inline; a reference label is shared by every note in the changelog, so two notes could define it differently. Put a literal ]: in a code span",
    ]);
  });

  test("a reference definition is refused inside a list item, a quote, or across lines", () => {
    for (const body of [
      "- [Unreleased]: https://example.com/wrong\n- ordinary\n",
      "- ordinary\n\n> [Unreleased]: https://example.com/wrong\n",
      "- ordinary\n\n[Unre\nleased]: https://example.com/wrong\n",
    ]) {
      const { errors } = parseNote("changes/a.md", `### Fixed\n\n${body}`);
      expect(errors.join("\n")).toContain("write the link inline");
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

  test("merges waiting together ship as one release: the largest bump, every note, every placeholder", () => {
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
    });
    const result = release({
      root,
      ...CONFIG,
      tagPrefix: "v",
      stamps,
      date: "2026-02-03",
    });
    expect([result.version, result.notes]).toEqual([
      "1.3.0",
      ["changes/a.md", "changes/b.md"],
    ]);
    expect(readFileSync(join(root, "criteria/x.yaml"), "utf8")).toBe(
      "- id: a\n  since: 1.3.0\n- id: b\n  since: 1.3.0\n",
    );
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [1.3.0] - 2026-02-03");
    expect(changelog).not.toContain("## [1.2.1]");
    expect(release({ root, ...CONFIG, tagPrefix: "v" }).notes).toEqual([]);
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

  test("several notes need the whole history, which tells their merge order", () => {
    const root = repository();
    write(root, "changes/b.md", "### Fixed\n\n- b\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "b");
    write(root, "changes/a.md", "### Fixed\n\n- a\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "a");
    const shallow = mkdtempSync(join(tmpdir(), "change-notes-shallow-"));
    scratch.push(shallow);
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, ".");
    expect(() => release({ root: shallow, ...CONFIG, tagPrefix: "v" })).toThrow(
      "git fetch --unshallow",
    );
    expect(existsSync(join(shallow, "changes/a.md"))).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), "change-notes-outside-"));
    scratch.push(outside);
    for (const file of ["CHANGELOG.md", "a/plugin.json", "b/plugin.json"])
      write(outside, file, readFileSync(join(root, file), "utf8"));
    write(outside, "changes/a.md", "### Fixed\n\n- a\n");
    expect(
      release({ root: outside, ...CONFIG, tagPrefix: "v", dryRun: true }).notes,
    ).toEqual(["changes/a.md"]);
    write(outside, "changes/b.md", "### Fixed\n\n- b\n");
    expect(() => release({ root: outside, ...CONFIG, tagPrefix: "v" })).toThrow(
      "whole history",
    );
    expect(release({ root, ...CONFIG, tagPrefix: "v" }).notes).toEqual([
      "changes/b.md",
      "changes/a.md",
    ]);
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
