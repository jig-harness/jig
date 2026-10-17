import { describe, expect, test } from "bun:test";
import { type ChangeNote, parseNote } from "../scripts/change-notes.ts";
import {
  KEEP_A_CHANGELOG,
  releasedVersions,
  unreleasedSection,
} from "../scripts/formats.ts";
import { applyKeepAChangelog } from "../scripts/keep-a-changelog.ts";
import { KEEP_CHANGELOG } from "./scratch.ts";

const note = (file: string, text: string): ChangeNote => {
  const { note: parsed, errors } = parseNote(file, text, KEEP_A_CHANGELOG);
  expect(errors).toEqual([]);
  if (!parsed) throw new Error("unreachable");
  return parsed;
};

const OPTIONS = {
  previous: "1.2.0",
  date: "2026-02-03",
  tagPrefix: "v",
  unreleased: "write",
  links: null,
  firstRelease: false,
} as const;

describe("applyKeepAChangelog", () => {
  test("a note without a release joins Unreleased, in change-type order", () => {
    const out = applyKeepAChangelog(
      KEEP_CHANGELOG,
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
    const out = applyKeepAChangelog(
      KEEP_CHANGELOG,
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
    expect(releasedVersions(out, KEEP_A_CHANGELOG)).toEqual(["1.3.0", "1.2.0"]);
  });

  test("an empty Unreleased with only links below stays empty", () => {
    const out = applyKeepAChangelog(
      "# Changelog\n\n## [Unreleased]\n\n[Unreleased]: https://example.com/r/compare/v0.1.0...HEAD\n",
      [note("a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n")],
      { ...OPTIONS, previous: "0.1.0", version: "0.2.0" },
    );
    expect(out).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-03\n\n### Added\n\n- x\n\n[Unreleased]: https://example.com/r/compare/v0.2.0...HEAD\n[0.2.0]: https://example.com/r/compare/v0.1.0...v0.2.0\n",
    );
  });

  test("the first release links the version's own tag, there being no tag to compare with", () => {
    const first = `# Changelog

## [Unreleased]

[Unreleased]: https://example.com/r/compare/v0.0.0...HEAD
`;
    const out = applyKeepAChangelog(
      first,
      [note("a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n")],
      { ...OPTIONS, previous: "0.0.0", version: "0.1.0", firstRelease: true },
    );
    expect(out).toContain(
      "[Unreleased]: https://example.com/r/compare/v0.1.0...HEAD\n[0.1.0]: https://example.com/r/releases/tag/v0.1.0\n",
    );
    // Once a release is listed, the next one compares with it.
    const second = applyKeepAChangelog(
      out,
      [note("b.md", "---\nrelease: patch\n---\n### Fixed\n\n- y\n")],
      { ...OPTIONS, previous: "0.1.0", version: "0.1.1" },
    );
    expect(second).toContain(
      "[0.1.1]: https://example.com/r/compare/v0.1.0...v0.1.1\n[0.1.0]: https://example.com/r/releases/tag/v0.1.0",
    );
  });

  test("the first release's tag link is spelled as its host spells it", () => {
    const first = (host: string) =>
      applyKeepAChangelog(
        `# Changelog\n\n## [Unreleased]\n\n[Unreleased]: ${host}compare/v0.0.0...HEAD\n`,
        [note("a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n")],
        { ...OPTIONS, previous: "0.0.0", version: "0.1.0", firstRelease: true },
      );
    expect(first("https://gitlab.com/g/p/-/")).toContain(
      "[0.1.0]: https://gitlab.com/g/p/-/tags/v0.1.0\n",
    );
    expect(first("https://github.com/o/r/")).toContain(
      "[0.1.0]: https://github.com/o/r/releases/tag/v0.1.0\n",
    );
    // A host Jig has no paths for gets GitHub's form.
    expect(first("https://example.com/r/")).toContain(
      "[0.1.0]: https://example.com/r/releases/tag/v0.1.0\n",
    );
  });

  test("a changelog without Unreleased is refused", () => {
    expect(() =>
      applyKeepAChangelog("# Changelog\n", [], { ...OPTIONS, version: null }),
    ).toThrow("no `## [Unreleased]`");
  });

  test("with unreleased: wait, notes go into the next release and Unreleased is left alone", () => {
    const wait = { ...OPTIONS, unreleased: "wait" } as const;
    const pending = note("a.md", "### Fixed\n\n- a fix\n");
    // No note asks for a release: nothing is written.
    expect(
      applyKeepAChangelog(KEEP_CHANGELOG, [pending], {
        ...wait,
        version: null,
      }),
    ).toBe(KEEP_CHANGELOG);
    const out = applyKeepAChangelog(
      KEEP_CHANGELOG,
      [pending, note("b.md", "---\nrelease: minor\n---\n### Added\n\n- b\n")],
      { ...wait, version: "1.3.0" },
    );
    expect(out).toContain(
      "- an earlier docs change\n\n## [1.3.0] - 2026-02-03\n\n### Added\n\n- b\n\n### Fixed\n\n- a fix\n\n## [1.2.0]",
    );
    // A file with no Unreleased section at all takes the release above the
    // newest one.
    const bare = applyKeepAChangelog(
      "# Changelog\n\n## [1.2.0] - 2026-01-02\n\n### Added\n\n- a skill\n",
      [note("b.md", "---\nrelease: minor\n---\n### Added\n\n- b\n")],
      { ...wait, version: "1.3.0" },
    );
    expect(bare).toBe(
      "# Changelog\n\n## [1.3.0] - 2026-02-03\n\n### Added\n\n- b\n\n## [1.2.0] - 2026-01-02\n\n### Added\n\n- a skill\n",
    );
  });

  test("unreleasedSection reads Unreleased without the links", () => {
    expect(unreleasedSection(KEEP_CHANGELOG)).toBe(
      "### Changed\n\n- an earlier docs change",
    );
  });
});
