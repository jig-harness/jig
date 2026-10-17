import { describe, expect, test } from "bun:test";
import {
  type ChangeNote,
  MARKDOWN_BUN,
  MarkdownUnavailable,
  nextVersion,
  parseNote,
  rebaseLinks,
} from "../scripts/change-notes.ts";
import { COMMON_CHANGELOG, KEEP_A_CHANGELOG } from "../scripts/formats.ts";

const note = (file: string, text: string): ChangeNote => {
  const { note: parsed, errors } = parseNote(file, text, KEEP_A_CHANGELOG);
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

  const errors = (text: string) =>
    parseNote("n.md", text, KEEP_A_CHANGELOG).errors.join("\n");
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
        parseNote("a.md", `### Fixed\n\n${body}`, KEEP_A_CHANGELOG);
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
    expect(errors("---\nauthors: A B\n---\n### Added\n\n- x\n")).toContain(
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
        KEEP_A_CHANGELOG,
      ).errors.join("\n"),
    ).toContain("<mailto:");
  });

  test("a reference definition is refused: its label would be the changelog's", () => {
    const { errors } = parseNote(
      "changes/a.md",
      "### Fixed\n\n- See [guide][g].\n\n  [g]: ../docs/README.md\n",
      KEEP_A_CHANGELOG,
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
      const { errors } = parseNote(
        "changes/a.md",
        `### Fixed\n\n${body}`,
        KEEP_A_CHANGELOG,
      );
      expect(errors.join("\n")).toContain("write the link inline");
    }
  });

  test("a literal ]: in a code span is not a definition", () => {
    const { errors } = parseNote(
      "changes/a.md",
      "### Fixed\n\n- The `[label]: url` form is refused.\n",
      KEEP_A_CHANGELOG,
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

describe("the structural check", () => {
  const errors = (text: string, format = KEEP_A_CHANGELOG) =>
    parseNote("n.md", text, format).errors.join("\n");

  test("a heading is allowed only with a change type of the format", () => {
    // `blocks` does not see a heading inside a quote; the parser does.
    expect(errors("### Added\n\n- x\n\n> ### Bogus\n")).toContain(
      "`### Bogus` is not a change type",
    );
    expect(errors("### Added\n\n- x\n\n> ### Fixed\n")).not.toContain(
      "not a change type",
    );
  });

  test("a Bun without Bun.markdown fails with the version it needs", () => {
    const bun = Bun as { markdown?: unknown };
    const markdown = bun.markdown;
    bun.markdown = undefined;
    try {
      expect(() =>
        parseNote("n.md", "### Added\n\n- x\n", KEEP_A_CHANGELOG),
      ).toThrow(new RegExp(`Bun ${MARKDOWN_BUN.replaceAll(".", "\\.")}`));
      expect(() =>
        parseNote("n.md", "### Added\n\n- x\n", KEEP_A_CHANGELOG),
      ).toThrow(MarkdownUnavailable);
    } finally {
      bun.markdown = markdown;
    }
  });
});

describe("a note in Common Changelog", () => {
  const common = (text: string) => parseNote("n.md", text, COMMON_CHANGELOG);
  const errors = (text: string) => common(text).errors.join("\n");

  test("lists the format's change types, in the format's words", () => {
    expect(common("### Added\n\n- x\n\n### Fixed\n\n- y\n").errors).toEqual([]);
    expect(errors("### Deprecated\n\n- x\n")).toContain(
      "is not a change type (Changed, Added, Removed, Fixed)",
    );
    expect(errors("### Security\n\n- x\n")).toContain("not a change type");
    // Keep a Changelog's list takes Deprecated and Security.
    expect(
      parseNote("n.md", "### Security\n\n- x\n", KEEP_A_CHANGELOG).errors,
    ).toEqual([]);
  });

  test("front matter may name the authors", () => {
    const authors = (value: string) =>
      common(`---\nrelease: patch\nauthors: ${value}\n---\n### Fixed\n\n- x\n`)
        .note?.authors;
    expect(authors("Jane Doe, John Roe")).toEqual(["Jane Doe", "John Roe"]);
    expect(authors('[Jane Doe, "John Roe"]')).toEqual(["Jane Doe", "John Roe"]);
    // An empty list credits nobody; no key leaves it to the history.
    expect(authors("[]")).toEqual([]);
    expect(common("### Fixed\n\n- x\n").note?.authors).toBeNull();
    expect(errors("---\nauthors: A (b)\n---\n### Fixed\n\n- x\n")).toContain(
      "holds no bracket",
    );
    expect(
      errors("---\nauthors: a\nauthors: b\n---\n### Fixed\n\n- x\n"),
    ).toContain("`authors` twice");
  });

  test("each entry is one line, and the lead is one paragraph", () => {
    expect(errors("### Fixed\n\n- one\n  continued\n")).toContain(
      "runs over more than one line",
    );
    expect(
      errors("---\nrelease: patch\n---\nOne.\n\nTwo.\n\n### Fixed\n\n- x\n"),
    ).toContain("single sentence in one paragraph");
    // Keep a Changelog allows both.
    expect(
      parseNote(
        "n.md",
        "---\nrelease: patch\n---\nOne.\n\nTwo.\n\n### Fixed\n\n- one\n  continued\n",
        KEEP_A_CHANGELOG,
      ).errors,
    ).toEqual([]);
  });
});
