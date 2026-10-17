import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCommonChangelog,
  credited,
  isBreaking,
} from "../scripts/common-changelog.ts";
import { type ChangeNote, parseNote } from "../scripts/change-notes.ts";
import { COMMON_CHANGELOG as COMMON } from "../scripts/formats.ts";
import { hostLinks, parseRemote } from "../scripts/remote.ts";
import { pullRequestOf } from "../scripts/history.ts";
import { release } from "../scripts/release.ts";
import {
  COMMON_CHANGELOG,
  commit,
  git,
  gitAt,
  repository,
  resolvedFor,
  temporary,
} from "./scratch.ts";

const note = (file: string, text: string): ChangeNote => {
  const { note: parsed, errors } = parseNote(file, text, COMMON);
  expect(errors).toEqual([]);
  if (!parsed) throw new Error("unreleased");
  return parsed;
};
const links = hostLinks("https://github.com/o/r.git");
const OPTIONS = {
  date: "2026-02-03",
  tagPrefix: "v",
  unreleased: "wait",
  links,
  version: "1.3.0",
  previous: "1.2.0",
} as const;

describe("applyCommonChangelog", () => {
  test("writes the release above the newest, with its link definition, and leaves earlier ones alone", async () => {
    const out = applyCommonChangelog(
      COMMON_CHANGELOG,
      [note("a.md", "---\nrelease: minor\n---\n### Added\n\n- A thing\n")],
      OPTIONS,
    );
    expect(out).toBe(
      "# Changelog\n\n## [1.3.0] - 2026-02-03\n\n### Added\n\n- A thing\n\n## [1.2.0] - 2026-01-02\n\n### Added\n\n- A skill ([#1](https://github.com/o/r/pull/1)) (Alex Author)\n\n[1.3.0]: https://github.com/o/r/compare/v1.2.0...v1.3.0\n[1.2.0]: https://github.com/o/r/releases/tag/v1.2.0\n",
    );
  });

  test("the sections follow the format's order, breaking entries first, the notice under the heading", async () => {
    const out = applyCommonChangelog(
      "# Changelog\n",
      [
        note(
          "a.md",
          "---\nrelease: major\n---\n_Upgrade with care._\n\n### Fixed\n\n- Repair x\n- **Breaking:** Stop doing y\n\n### Added\n\n- Add z\n\n### Changed\n\n- Tweak w\n- **Breaking:** Rename v\n",
        ),
      ],
      { ...OPTIONS, previous: null, version: "1.0.0" },
    );
    expect(out).toBe(
      "# Changelog\n\n## [1.0.0] - 2026-02-03\n\n_Upgrade with care._\n\n### Changed\n\n- **Breaking:** Rename v\n- Tweak w\n\n### Added\n\n- Add z\n\n### Fixed\n\n- **Breaking:** Stop doing y\n- Repair x\n\n[1.0.0]: https://github.com/o/r/releases/tag/v1.0.0\n",
    );
    expect(isBreaking("- **Breaking:** x")).toBe(true);
    expect(isBreaking("- Breaking x")).toBe(false);
  });

  test("a note that waits writes nothing, and the format needs the host's links and one notice", async () => {
    const waiting = note("a.md", "### Fixed\n\n- x\n");
    expect(
      applyCommonChangelog(COMMON_CHANGELOG, [waiting], {
        ...OPTIONS,
        version: null,
      }),
    ).toBe(COMMON_CHANGELOG);
    const asking = note("b.md", "---\nrelease: patch\n---\n### Fixed\n\n- y\n");
    expect(() =>
      applyCommonChangelog(COMMON_CHANGELOG, [asking], {
        ...OPTIONS,
        links: null,
      }),
    ).toThrow("GitHub and GitLab");
    const notice = (file: string) =>
      note(file, `---\nrelease: patch\n---\nA notice.\n\n### Fixed\n\n- y\n`);
    expect(() =>
      applyCommonChangelog(
        COMMON_CHANGELOG,
        [notice("a.md"), notice("b.md")],
        OPTIONS,
      ),
    ).toThrow("a.md and b.md each write one");
  });

  test("reads the unlinked heading too, and puts the release above it", async () => {
    const out = applyCommonChangelog(
      "# Changelog\n\n## 1.2.0 - 2026-01-02\n\n### Added\n\n- A skill\n",
      [note("a.md", "---\nrelease: patch\n---\n### Fixed\n\n- y\n")],
      { ...OPTIONS, version: "1.2.1" },
    );
    expect(out).toContain(
      "## [1.2.1] - 2026-02-03\n\n### Fixed\n\n- y\n\n## 1.2.0 - 2026-01-02",
    );
    expect(out).toEndWith(
      "\n\n[1.2.1]: https://github.com/o/r/compare/v1.2.0...v1.2.1\n",
    );
  });

  test("credited ends each entry with its reference and the credited authors", async () => {
    const base = note("a.md", "### Fixed\n\n- x\n- y\n");
    const entries = (n: ChangeNote) => n.sections.get("Fixed");
    expect(
      entries(
        credited(
          base,
          { reference: { pullRequest: 4 }, authors: ["A B", "C D"] },
          links,
        ),
      ),
    ).toEqual([
      "- x ([#4](https://github.com/o/r/pull/4)) (A B, C D)",
      "- y ([#4](https://github.com/o/r/pull/4)) (A B, C D)",
    ]);
    expect(
      entries(
        credited(
          base,
          { reference: { commit: "abc1234" }, authors: ["A B"] },
          links,
        ),
      ),
    ).toEqual([
      "- x ([`abc1234`](https://github.com/o/r/commit/abc1234)) (A B)",
      "- y ([`abc1234`](https://github.com/o/r/commit/abc1234)) (A B)",
    ]);
    expect(
      entries(
        credited(base, { reference: { pullRequest: 4 }, authors: [] }, null),
      ),
    ).toEqual(["- x (#4)", "- y (#4)"]);
  });

  test("credited refuses an entry whose reading its reference would change", async () => {
    const commit = { reference: { commit: "abc1234" }, authors: ["A B"] };
    // A lone backtick is literal text alone, but pairs with the reference's.
    expect(() =>
      credited(note("a.md", "### Fixed\n\n- Use `foo\n"), commit, links),
    ).toThrow('a.md: the entry "- Use `foo" reads differently');
    expect(
      credited(
        note("a.md", "### Fixed\n\n- Use `foo`\n"),
        commit,
        links,
      ).sections.get("Fixed"),
    ).toEqual([
      "- Use `foo` ([`abc1234`](https://github.com/o/r/commit/abc1234)) (A B)",
    ]);
  });
});

describe("the hosting service's addresses", () => {
  test("from the origin remote, whatever its form, without credentials", async () => {
    for (const address of [
      "https://github.com/o/r.git",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r",
      "https://x-access-token:secret@github.com/o/r.git/",
    ])
      expect(hostLinks(address)?.web, address).toBe("https://github.com/o/r");
    expect(
      parseRemote("https://x-access-token:secret@github.com/o/r.git"),
    ).toEqual({
      host: "github.com",
      path: "o/r",
    });
    const lab = hostLinks("git@gitlab.example.com:g/p.git");
    expect(lab?.pullRequest(3)).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/3",
    );
    expect(lab?.compare("v1", "v2")).toBe(
      "https://gitlab.example.com/g/p/-/compare/v1...v2",
    );
    expect(hostLinks("https://git.example.org/o/r.git")).toBeNull();
    expect(hostLinks("not a remote")).toBeNull();
  });

  test("the pull request a commit subject names", async () => {
    expect(pullRequestOf("Add the thing (#12)")).toBe(12);
    expect(pullRequestOf("Merge pull request #7 from o/feat")).toBe(7);
    expect(pullRequestOf("Fix #5 properly")).toBeNull();
    expect(pullRequestOf("Add (#12) things")).toBeNull();
  });
});

describe("release in Common Changelog", () => {
  const repo = (origin = "https://github.com/o/r.git") => {
    const root = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/README.md": "How to write a note.\n",
    });
    if (origin) git(root, "remote", "add", "origin", origin);
    return root;
  };
  const run = (root: string, section: Record<string, unknown> = {}) =>
    release({
      ...resolvedFor(root, { format: "common-changelog", ...section }),
      date: "2026-02-03",
    });
  const changelog = (root: string) =>
    readFileSync(join(root, "CHANGELOG.md"), "utf8");

  test("a squash merge's number is the reference and the commit's author the credit", async () => {
    const root = repo();
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: minor\n---\n### Added\n\n- Add the thing\n",
      },
      "Add the thing (#12)",
      "Jane Doe",
    );
    expect((await run(root)).version).toBe("1.3.0");
    expect(changelog(root)).toContain(
      "## [1.3.0] - 2026-02-03\n\n### Added\n\n- Add the thing ([#12](https://github.com/o/r/pull/12)) (Jane Doe)\n\n## [1.2.0]",
    );
    expect(changelog(root)).toContain(
      "[1.3.0]: https://github.com/o/r/compare/v1.2.0...v1.3.0\n[1.2.0]:",
    );
    expect(existsSync(join(root, "changes/a.md"))).toBe(false);
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain("1.3.0");
  });

  test("a merge commit's number, and every author of the branch and of later edits, bots left out", async () => {
    const root = repo();
    git(root, "checkout", "-qb", "feat");
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: minor\n---\n### Added\n\n- Add the thing\n",
      },
      "wip",
      "Jane Doe",
    );
    commit(root, { "src.txt": "1" }, "more", "dependabot[bot]");
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: minor\n---\n### Added\n\n- Add the thing!\n",
      },
      "wording",
      "John Roe",
    );
    git(root, "checkout", "-q", "main");
    gitAt(
      root,
      {},
      "merge",
      "--no-ff",
      "-qm",
      "Merge pull request #7 from o/feat",
      "feat",
    );
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: minor\n---\n### Added\n\n- Add the thing, well\n",
      },
      "wording after the merge",
      "Kim Poe",
    );
    await run(root);
    expect(changelog(root)).toContain(
      "- Add the thing, well ([#7](https://github.com/o/r/pull/7)) (Jane Doe, John Roe, Kim Poe)",
    );
  });

  test("without a number the short hash of the commit that brought the note is the reference", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Fix it\n" },
      "Fix it",
    );
    const short = git(root, "rev-parse", "--short=7", "HEAD").trim();
    await run(root);
    expect(changelog(root)).toContain(
      `- Fix it ([\`${short}\`](https://github.com/o/r/commit/${short})) (Alex Author)`,
    );
  });

  test("a note whose commits are all by bots needs its authors named; a note may name them", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Bump x\n" },
      "Bump x (#3)",
      "renovate[bot]",
    );
    await expect(run(root)).rejects.toThrow(
      "every commit that wrote it is by a bot",
    );
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: patch\nauthors: Mia Merger\n---\n### Fixed\n\n- Bump x\n",
      },
      "name the author",
      "renovate[bot]",
    );
    await run(root);
    expect(changelog(root)).toContain("(Mia Merger)");
    expect(changelog(root)).not.toContain("renovate");
  });

  test("credited writes every name as literal text, never as Markdown or HTML", async () => {
    const base = note("a.md", "### Fixed\n\n- x\n");
    expect(
      credited(
        base,
        {
          reference: null,
          authors: ["<!-- x", "[A](u)", "*B*_\n C", "Jo O'Neil-Ray"],
        },
        null,
      ).sections.get("Fixed"),
    ).toEqual([
      "- x (\\<\\!-- x, \\[A\\]\\(u\\), \\*B\\*\\_ C, Jo O'Neil-Ray)",
    ]);
  });

  test("a git author name that holds Markdown is escaped in the changelog", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Fix it\n" },
      "Fix it (#2)",
      "Eve *Ill* [x](y)",
    );
    await run(root);
    expect(changelog(root)).toContain(
      "- Fix it ([#2](https://github.com/o/r/pull/2)) (Eve \\*Ill\\* \\[x\\]\\(y\\))",
    );
  });

  test("changelog.authors: false leaves out a note's own authors too", async () => {
    const root = repo();
    commit(
      root,
      {
        "changes/a.md":
          "---\nrelease: patch\nauthors: Mia Merger\n---\n### Fixed\n\n- Fix it\n",
      },
      "Fix it (#2)",
    );
    await run(root, { authors: false });
    expect(changelog(root)).toContain(
      "- Fix it ([#2](https://github.com/o/r/pull/2))\n",
    );
    expect(changelog(root)).not.toContain("Mia Merger");
  });

  test("changelog.authors: false leaves the authors out", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Fix it\n" },
      "Fix it (#2)",
    );
    await run(root, { authors: false });
    expect(changelog(root)).toContain(
      "- Fix it ([#2](https://github.com/o/r/pull/2))\n",
    );
    expect(changelog(root)).not.toContain("Alex Author) ");
  });

  test("notes without a release wait, and join the release a later note asks for", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "### Fixed\n\n- Quiet fix\n" },
      "Quiet fix (#4)",
    );
    const idle = await run(root);
    expect([idle.version, idle.notes, idle.waiting]).toEqual([
      null,
      [],
      ["changes/a.md"],
    ]);
    expect(changelog(root)).toBe(COMMON_CHANGELOG);
    commit(
      root,
      {
        "changes/b.md":
          "---\nrelease: minor\n---\n### Added\n\n- Loud change\n",
      },
      "Loud change (#5)",
    );
    const done = await run(root);
    expect(done.notes).toEqual(["changes/a.md", "changes/b.md"]);
    expect(changelog(root)).toContain("### Added\n\n- Loud change ([#5]");
    expect(changelog(root)).toContain("### Fixed\n\n- Quiet fix ([#4]");
  });

  test("two waiting notes with a summary are refused, naming both", async () => {
    const root = repo();
    for (const name of ["a", "b"])
      commit(
        root,
        {
          [`changes/${name}.md`]:
            "---\nrelease: patch\n---\nA notice.\n\n### Fixed\n\n- y\n",
        },
        `${name} (#1)`,
      );
    await expect(run(root)).rejects.toThrow(
      "changes/a.md and changes/b.md each have a summary",
    );
  });

  test("the first release links its own tag, the version coming from the tags", async () => {
    const root = repository({
      "CHANGELOG.md":
        "# Changelog\n\nSee [Common Changelog](https://common-changelog.org).\n",
      "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- First\n",
    });
    git(root, "remote", "add", "origin", "https://github.com/o/r.git");
    const result = await release({
      ...resolvedFor(root, { version: { tags: true } }),
      date: "2026-02-03",
    });
    expect([result.previous, result.version]).toEqual(["0.0.0", "0.1.0"]);
    expect(changelog(root)).toMatch(
      /\n## \[0\.1\.0\] - 2026-02-03\n\n### Added\n\n- First \(\[`[0-9a-f]{7}`\]\(https:\/\/github\.com\/o\/r\/commit\/[0-9a-f]{7}\)\) \(Alex Author\)\n\n\[0\.1\.0\]: https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.1\.0\n$/,
    );
  });

  test("a credited note needs the whole history even when it is the only one", async () => {
    const root = repo();
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- Fix it\n" },
      "Fix it (#2)",
    );
    const shallow = temporary("changelog-shallow-");
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, ".");
    git(shallow, "remote", "set-url", "origin", "https://github.com/o/r.git");
    await expect(run(shallow)).rejects.toThrow("git fetch --unshallow");
    expect(existsSync(join(shallow, "changes/a.md"))).toBe(true);
    // The whole history answers.
    expect((await run(root)).version).toBe("1.2.1");
  });

  test("without an origin on a host Jig knows, the links cannot be made and nothing is written", async () => {
    const root = repo("");
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- y\n" },
      "y (#1)",
    );
    await expect(run(root)).rejects.toThrow("origin remote");
    expect(changelog(root)).toBe(COMMON_CHANGELOG);
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });
});
