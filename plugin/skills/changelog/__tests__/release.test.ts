import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AFTER_VERSION_IN_CI,
  AFTER_VERSION_TIMEOUT,
  MalformedNotes,
  release,
  releaseWithoutAfterVersion,
  runReleaseCommand,
} from "../scripts/release.ts";
import {
  commit,
  git,
  gitAt,
  KEEP_CHANGELOG,
  KEEP_LF,
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
const files = (): Record<string, string> => ({
  "CHANGELOG.md": KEEP_CHANGELOG,
  "a/plugin.json": MANIFEST("1.2.0"),
  "b/plugin.json": MANIFEST("1.2.0"),
  "changes/README.md": "How to write a note.\n",
  "src/x.ts": "x\n",
});
const text = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

describe("release", () => {
  test("writes the notes in merge order, moves the version, deletes the notes", async () => {
    const root = repository(files());
    const options = () => resolvedFor(root, VERSION_FILES);
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
    const result = await release({ ...options(), date: "2026-02-03" });
    expect(result.version).toBe("1.3.0");
    expect(result.notes).toEqual(["changes/b.md", "changes/a.md"]);
    expect(text(root, "CHANGELOG.md")).toContain(
      "## [1.3.0] - 2026-02-03\n\n### Fixed\n\n- b, in [x](src/x.ts)\n- a\n",
    );
    expect(text(root, "a/plugin.json")).toBe(MANIFEST("1.3.0"));
    expect(text(root, "b/plugin.json")).toBe(MANIFEST("1.3.0"));
    expect(existsSync(join(root, "changes/a.md"))).toBe(false);
    expect(existsSync(join(root, "changes/README.md"))).toBe(true);
  });

  test("a placeholder for the version is filled in only by a release", async () => {
    const placeholders = [
      {
        files: ["criteria/*.yaml"],
        from: "since: next",
        to: "since: {version}",
      },
    ];
    const root = repository(files());
    const options = () => resolvedFor(root, { ...VERSION_FILES, placeholders });
    write(
      root,
      "criteria/a.yaml",
      "- id: x\n  since: next\n- id: y\n  since: 1.0.0\n",
    );
    write(root, "changes/a.md", "### Changed\n\n- docs\n");
    expect((await release(options())).stamped).toEqual([]);
    expect(text(root, "criteria/a.yaml")).toContain("since: next");
    write(root, "changes/b.md", "---\nrelease: minor\n---\n### Added\n\n- x\n");
    expect((await release(options())).stamped).toEqual(["criteria/a.yaml"]);
    expect(text(root, "criteria/a.yaml")).toBe(
      "- id: x\n  since: 1.3.0\n- id: y\n  since: 1.0.0\n",
    );
  });

  test("a placeholder is never filled in a workflow, wherever the glob reached", async () => {
    const root = repository({
      ...files(),
      ".github/workflows/ci.yml": "since: next\n",
    });
    write(root, "changes/a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n");
    const options = resolvedFor(root, VERSION_FILES);
    // The configuration refuses such a glob; a hand-built one is stopped here.
    options.config.placeholders.push({
      files: [".github/workflows/ci.yml"],
      from: "since: next",
      to: "since: {version}",
    });
    await expect(release(options)).rejects.toThrow(
      "never filled in a workflow",
    );
    expect(text(root, ".github/workflows/ci.yml")).toBe("since: next\n");
    expect(text(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
  });

  test("merges waiting together ship as one release: the largest bump, every note, every placeholder", async () => {
    const placeholders = [
      {
        files: ["criteria/*.yaml"],
        from: "since: next",
        to: "since: {version}",
      },
    ];
    const root = repository(files());
    commit(
      root,
      {
        "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- a\n",
        "criteria/x.yaml": "- id: a\n  since: next\n",
      },
      "a",
    );
    commit(
      root,
      {
        "changes/b.md": "---\nrelease: minor\n---\n### Added\n\n- b\n",
        "criteria/x.yaml": "- id: a\n  since: next\n- id: b\n  since: next\n",
      },
      "b",
    );
    const options = () => resolvedFor(root, { ...VERSION_FILES, placeholders });
    const result = await release({ ...options(), date: "2026-02-03" });
    expect([result.version, result.notes]).toEqual([
      "1.3.0",
      ["changes/a.md", "changes/b.md"],
    ]);
    expect(text(root, "criteria/x.yaml")).toBe(
      "- id: a\n  since: 1.3.0\n- id: b\n  since: 1.3.0\n",
    );
    expect(text(root, "CHANGELOG.md")).toContain("## [1.3.0] - 2026-02-03");
    expect(text(root, "CHANGELOG.md")).not.toContain("## [1.2.1]");
    expect((await release(options())).notes).toEqual([]);
  });

  test("notes from several merges in one run make one version and one section", async () => {
    const root = repository(files());
    const options = () => resolvedFor(root, VERSION_FILES);
    commit(
      root,
      { "changes/a.md": "---\nrelease: patch\n---\n### Fixed\n\n- a\n" },
      "a",
    );
    commit(
      root,
      { "changes/b.md": "---\nrelease: major\n---\n### Removed\n\n- b\n" },
      "b",
    );
    commit(
      root,
      { "changes/c.md": "---\nrelease: minor\n---\n### Added\n\n- c\n" },
      "c",
    );
    const result = await release({ ...options(), date: "2026-02-03" });
    // The largest bump any note asks for, applied once to the version before.
    expect([result.previous, result.version]).toEqual(["1.2.0", "2.0.0"]);
    expect(result.notes).toEqual([
      "changes/a.md",
      "changes/b.md",
      "changes/c.md",
    ]);
    const changelog = text(root, "CHANGELOG.md");
    const sections = changelog.match(/^## \[\d[^\]]*\]/gm) ?? [];
    expect(sections[0]).toBe("## [2.0.0]");
    expect(sections.length).toBe(
      (KEEP_CHANGELOG.match(/^## \[\d[^\]]*\]/gm) ?? []).length + 1,
    );
    // Every entry sits in the new version's own section, under its type.
    const start = changelog.indexOf("## [2.0.0]");
    const end = changelog.indexOf("\n## [", start + 1);
    expect(end).toBeGreaterThan(start);
    expect(changelog.slice(start, end)).toBe(
      [
        "## [2.0.0] - 2026-02-03",
        "",
        "### Added",
        "",
        "- c",
        "",
        "### Removed",
        "",
        "- b",
        "",
        "### Fixed",
        "",
        "- a",
        "",
      ].join("\n"),
    );
    expect(text(root, "a/plugin.json")).toBe(MANIFEST("2.0.0"));
    expect(text(root, "b/plugin.json")).toBe(MANIFEST("2.0.0"));
    // The one version is what the release workflow tags: nothing is left to
    // release a second one.
    const again = await release({ ...options(), date: "2026-02-03" });
    expect([again.version, again.notes]).toEqual([null, []]);
  });

  test("a dry run writes nothing, and no notes is no change", async () => {
    const root = repository(files());
    const options = () => ({
      ...resolvedFor(root, VERSION_FILES),
      dryRun: true,
    });
    expect((await release(options())).notes).toEqual([]);
    write(root, "changes/a.md", "### Changed\n\n- docs\n");
    const result = await release(options());
    expect(result.version).toBeNull();
    expect(result.changelog).toContain("- docs");
    expect(text(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });

  test("several notes need the whole history, which tells their merge order", async () => {
    const root = repository(files());
    commit(root, { "changes/b.md": "### Fixed\n\n- b\n" }, "b");
    commit(root, { "changes/a.md": "### Fixed\n\n- a\n" }, "a");
    const shallow = temporary("changelog-shallow-");
    git(
      shallow,
      "clone",
      "-q",
      ...KEEP_LF,
      "--depth",
      "1",
      `file://${root}`,
      ".",
    );
    await expect(release(resolvedFor(shallow, VERSION_FILES))).rejects.toThrow(
      "git fetch --unshallow",
    );
    expect(existsSync(join(shallow, "changes/a.md"))).toBe(true);
    const outside = temporary("changelog-outside-");
    for (const file of ["CHANGELOG.md", "a/plugin.json", "b/plugin.json"])
      write(outside, file, text(root, file));
    write(outside, "changes/a.md", "### Fixed\n\n- a\n");
    expect(
      (await release({ ...resolvedFor(outside, VERSION_FILES), dryRun: true }))
        .notes,
    ).toEqual(["changes/a.md"]);
    write(outside, "changes/b.md", "### Fixed\n\n- b\n");
    await expect(release(resolvedFor(outside, VERSION_FILES))).rejects.toThrow(
      "whole history",
    );
    expect((await release(resolvedFor(root, VERSION_FILES))).notes).toEqual([
      "changes/b.md",
      "changes/a.md",
    ]);
  });

  test("a malformed note or disagreeing version files stop it before any write", async () => {
    const root = repository(files());
    const options = () => resolvedFor(root, VERSION_FILES);
    write(root, "changes/a.md", "### Improved\n\n- x\n");
    await expect(release(options())).rejects.toThrow("not a change type");
    for (const date of ["2026-02-30", "nonsense", "2026-2-3"])
      await expect(release({ ...options(), date })).rejects.toThrow(
        `not ${JSON.stringify(date)}`,
      );
    rmSync(join(root, "changes/a.md"));
    write(root, "b/plugin.json", MANIFEST("1.1.0"));
    write(root, "changes/a.md", "---\nrelease: patch\n---\n### Fixed\n\n- x\n");
    await expect(release(options())).rejects.toThrow("disagree");
    expect(text(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
    // The last file cannot be set (its key is written twice); neither the
    // changelog nor the first file moves.
    write(
      root,
      "b/plugin.json",
      `{\n  "version": "1.2.0",\n  "version": "1.2.0"\n}\n`,
    );
    await expect(release(options())).rejects.toThrow("found 2");
    expect(text(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
    expect(text(root, "a/plugin.json")).toBe(MANIFEST("1.2.0"));
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });
});

describe("every version source", () => {
  const note = "---\nrelease: minor\n---\n### Added\n\n- x\n";
  const run = (root: string, section: Record<string, unknown> = {}) =>
    release({ ...resolvedFor(root, section), date: "2026-02-03" });

  test("JSON, derived from package.json", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "package.json": `{\n  "name": "p",\n  "version": "1.2.0"\n}\n`,
      "changes/a.md": note,
    });
    expect((await run(root)).version).toBe("1.3.0");
    expect(text(root, "package.json")).toBe(
      `{\n  "name": "p",\n  "version": "1.3.0"\n}\n`,
    );
  });

  test("TOML, derived from pyproject.toml and Cargo.toml, edited in each key's own table", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "pyproject.toml": `[project]\nname = "p"\nversion = "1.2.0"\n\n[tool.other]\nversion = "1.2.0"\n`,
      "Cargo.toml": `[package]\nname = "p"\nversion = "1.2.0" # crate\n\n[dependencies]\nx = { version = "1.2.0" }\n`,
      "changes/a.md": note,
    });
    expect((await run(root)).version).toBe("1.3.0");
    expect(text(root, "pyproject.toml")).toBe(
      `[project]\nname = "p"\nversion = "1.3.0"\n\n[tool.other]\nversion = "1.2.0"\n`,
    );
    expect(text(root, "Cargo.toml")).toBe(
      `[package]\nname = "p"\nversion = "1.3.0" # crate\n\n[dependencies]\nx = { version = "1.2.0" }\n`,
    );
  });

  test("YAML, at the configured key", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "chart/Chart.yaml": `apiVersion: v2\nname: c\nversion: 1.2.0\nappVersion: "1.2.0"\n`,
      "changes/a.md": note,
    });
    const section = {
      version: { files: [{ path: "chart/Chart.yaml", key: "version" }] },
    };
    expect((await run(root, section)).version).toBe("1.3.0");
    expect(text(root, "chart/Chart.yaml")).toBe(
      `apiVersion: v2\nname: c\nversion: 1.3.0\nappVersion: "1.2.0"\n`,
    );
  });

  test("a plain VERSION file, with a JSON file that must agree", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      VERSION: "1.2.0\n",
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/a.md": note,
    });
    const section = {
      version: {
        files: [{ path: "VERSION" }, { path: "package.json", key: "version" }],
      },
    };
    expect((await run(root, section)).version).toBe("1.3.0");
    expect(text(root, "VERSION")).toBe("1.3.0\n");
    expect(text(root, "package.json")).toBe(`{"version": "1.3.0"}\n`);
  });

  test("files that disagree stop it, naming each", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      VERSION: "1.1.0\n",
      "package.json": `{"version": "1.2.0"}\n`,
      "changes/a.md": note,
    });
    await expect(
      run(root, {
        version: {
          files: [
            { path: "VERSION" },
            { path: "package.json", key: "version" },
          ],
        },
      }),
    ).rejects.toThrow("VERSION=1.1.0, package.json=1.2.0");
  });

  test("tags: the changelog's newest release counts, then the tags, and no file but the changelog is written", async () => {
    const tags = { version: { tags: true } };
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "changes/a.md": note,
    });
    // The newest heading says 1.2.0, whatever the tags say.
    git(root, "tag", "v9.9.9");
    expect(
      (await release({ ...resolvedFor(root, tags), dryRun: true })).previous,
    ).toBe("1.2.0");
    const result = await run(root, tags);
    expect([result.previous, result.version]).toEqual(["1.2.0", "1.3.0"]);
    // A second run before the tag exists counts from the heading the first wrote.
    write(root, "changes/b.md", "---\nrelease: patch\n---\n### Fixed\n\n- y\n");
    expect((await run(root, tags)).version).toBe("1.3.1");
    // Before the first release there is no heading: the highest tag decides.
    const fresh = repository({
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
      "changes/a.md": note,
    });
    git(fresh, "tag", "v0.4.0");
    git(fresh, "tag", "v0.10.0");
    git(fresh, "tag", "v0.9.0");
    expect((await run(fresh, tags)).version).toBe("0.11.0");
    // And with no tag either, 0.0.0.
    const none = repository({
      "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
      "changes/a.md": note,
    });
    expect((await run(none, tags)).version).toBe("0.1.0");
  });

  test("with no file to derive a version from, it asks for the field", async () => {
    const root = repository({ "CHANGELOG.md": KEEP_CHANGELOG });
    expect(() => resolvedFor(root)).toThrow("changelog.version");
  });
});

describe("when a note without a release is written", () => {
  test("wait: nothing is written until a note asks for a release, and then all go in", async () => {
    const root = repository({
      ...files(),
      "changes/a.md": "### Fixed\n\n- a fix\n",
    });
    const options = () => ({
      ...resolvedFor(root, { ...VERSION_FILES, unreleased: "wait" }),
      date: "2026-02-03",
    });
    const idle = await release(options());
    expect(idle.notes).toEqual([]);
    expect(idle.waiting).toEqual(["changes/a.md"]);
    expect(text(root, "CHANGELOG.md")).toBe(KEEP_CHANGELOG);
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
    write(root, "changes/b.md", "---\nrelease: minor\n---\n### Added\n\n- b\n");
    const done = await release(options());
    expect([done.version, done.notes, done.waiting]).toEqual([
      "1.3.0",
      ["changes/a.md", "changes/b.md"],
      [],
    ]);
    expect(text(root, "CHANGELOG.md")).toContain(
      "## [1.3.0] - 2026-02-03\n\n### Added\n\n- b\n\n### Fixed\n\n- a fix\n",
    );
  });

  test("write: it goes under Unreleased at once and the notes are deleted", async () => {
    const root = repository({
      ...files(),
      "changes/a.md": "### Fixed\n\n- a fix\n",
    });
    const result = await release(resolvedFor(root, VERSION_FILES));
    expect([result.version, result.notes, result.waiting]).toEqual([
      null,
      ["changes/a.md"],
      [],
    ]);
    expect(text(root, "CHANGELOG.md")).toContain(
      "## [Unreleased]\n\n### Changed\n\n- an earlier docs change\n\n### Fixed\n\n- a fix\n",
    );
  });
});

describe("after_version", () => {
  const scratch = () => {
    const root = repository({
      ...files(),
      "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- x\n",
    });
    return root;
  };
  // This process's environment with no CI marker, whatever job runs these
  // tests: the command runs in it, so it keeps PATH.
  const local = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![
          "CI",
          "GITHUB_ACTIONS",
          "GITLAB_CI",
          "BUILDKITE",
          "CIRCLECI",
          "TF_BUILD",
          "JENKINS_URL",
        ].includes(name),
    ),
  );
  const options = (root: string, command: string) => ({
    ...resolvedFor(root, { ...VERSION_FILES, after_version: command }),
    env: local,
  });
  const touch = (name: string) =>
    process.platform === "win32" ? `type nul > ${name}` : `touch ${name}`;

  test("runs after the version is written and before the notes are deleted, from the root, and its changes stay", async () => {
    const root = scratch();
    const command =
      process.platform === "win32"
        ? `findstr 1.3.0 a\\plugin.json > seen.txt`
        : "cp a/plugin.json seen.txt && test -f changes/a.md";
    await release(options(root, command));
    expect(text(root, "seen.txt")).toContain("1.3.0");
    expect(existsSync(join(root, "changes/a.md"))).toBe(false);
  });

  test("does not run on a dry run, nor when no note asks for a release", async () => {
    const root = scratch();
    await release({ ...options(root, touch("ran.txt")), dryRun: true });
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    rmSync(join(root, "changes/a.md"));
    write(root, "changes/b.md", "### Fixed\n\n- y\n");
    await release(options(root, touch("ran.txt")));
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "runs in the environment the release was given, not this process's",
    async () => {
      const root = scratch();
      const { HOME: _home, ...given } = local;
      await release({
        ...options(root, 'printf "%s|%s" "$JIG_GIVEN" "$HOME" > seen.txt'),
        env: { ...given, JIG_GIVEN: "given" },
      });
      expect(text(root, "seen.txt")).toBe("given|");
    },
  );

  test.skipIf(process.platform === "win32")(
    "past its deadline nothing it started goes on writing",
    async () => {
      const root = scratch();
      await expect(
        release({
          ...options(root, "(sleep 3; touch late.txt) & wait"),
          env: { ...local, [AFTER_VERSION_TIMEOUT]: "1" },
        }),
      ).rejects.toThrow("still running after 1s");
      expect(existsSync(join(root, "changes/a.md"))).toBe(true);
      // The descendant would have written two seconds after the deadline.
      const deadline = Date.now() + 6_000;
      while (Date.now() < deadline) {
        expect(existsSync(join(root, "late.txt"))).toBe(false);
        await Bun.sleep(200);
      }
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "a process it leaves in the background is stopped and fails the release",
    async () => {
      const root = scratch();
      await expect(
        release(options(root, "(sleep 2; touch late.txt) &")),
      ).rejects.toThrow("still running in the background");
      expect(existsSync(join(root, "changes/a.md"))).toBe(true);
      // The descendant would have written two seconds after the command returned.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        expect(existsSync(join(root, "late.txt"))).toBe(false);
        await Bun.sleep(200);
      }
    },
    20_000,
  );

  test("a failing command stops the release with the notes still in place", async () => {
    const root = scratch();
    await expect(release(options(root, "exit 3"))).rejects.toThrow(
      "changelog.after_version `exit 3` failed",
    );
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });

  test("inside a CI job it is refused unless the job says it holds no key", async () => {
    const root = scratch();
    const ci = { ...local, GITHUB_ACTIONS: "true" };
    await expect(
      release({ ...options(root, touch("ran.txt")), env: ci }),
    ).rejects.toThrow(AFTER_VERSION_IN_CI);
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    expect(text(root, "a/plugin.json")).toBe(MANIFEST("1.2.0"));
    await release({
      ...options(root, touch("ran.txt")),
      env: { ...ci, [AFTER_VERSION_IN_CI]: "1" },
    });
    expect(existsSync(join(root, "ran.txt"))).toBe(true);
  });

  test("the release step's own writes run without it, in a CI job too", () => {
    const root = scratch();
    const ci = { ...local, GITHUB_ACTIONS: "true" };
    const result = releaseWithoutAfterVersion({
      ...options(root, touch("ran.txt")),
      date: "2026-02-03",
      env: ci,
    });
    expect(result.version).toBe("1.3.0");
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
    expect(text(root, "a/plugin.json")).toBe(MANIFEST("1.3.0"));
    expect(text(root, "CHANGELOG.md")).toContain("## [1.3.0] - 2026-02-03");
    expect(existsSync(join(root, "changes/a.md"))).toBe(false);
  });

  test("every common CI marker counts, but a marker set to false does not", async () => {
    for (const marker of [
      "CI",
      "GITLAB_CI",
      "BUILDKITE",
      "CIRCLECI",
      "TF_BUILD",
      "JENKINS_URL",
    ]) {
      const root = scratch();
      await expect(
        release({
          ...options(root, touch("ran.txt")),
          env: {
            ...local,
            [marker]: marker === "JENKINS_URL" ? "http://j" : "true",
          },
        }),
        marker,
      ).rejects.toThrow(`${marker} set`);
      expect(existsSync(join(root, "ran.txt"))).toBe(false);
    }
    const root = scratch();
    await release({
      ...options(root, touch("ran.txt")),
      env: { ...local, CI: "false", GITHUB_ACTIONS: "0" },
    });
    expect(existsSync(join(root, "ran.txt"))).toBe(true);
  });
});

describe("a placeholder never overwrites what the release computed", () => {
  const placeholders = (files: string[]) => [
    { files, from: "1.2.0", to: "{version}" },
  ];

  test("the configuration refuses a glob that reaches the changelog or a version file", async () => {
    const root = repository(files());
    for (const glob of ["a/plugin.json", "CHANGELOG.md", "*/plugin.json"])
      expect(
        () =>
          resolvedFor(root, {
            ...VERSION_FILES,
            placeholders: placeholders([glob]),
          }),
        glob,
      ).toThrow(
        /matches (a\/plugin.json|b\/plugin.json|CHANGELOG.md), which the release writes itself/,
      );
  });

  test("and a hand-built one fills the computed text, not a fresh read", async () => {
    const root = repository(files());
    write(root, "changes/a.md", "---\nrelease: minor\n---\n### Added\n\n- x\n");
    const options = resolvedFor(root, VERSION_FILES);
    options.config.placeholders.push({
      files: ["a/plugin.json"],
      from: '"name": "p"',
      to: '"name": "p-{version}"',
    });
    await release(options);
    expect(text(root, "a/plugin.json")).toBe(
      `{\n  "name": "p-1.3.0",\n  "version": "1.3.0"\n}\n`,
    );
  });
});

describe("a repository that did not turn it on", () => {
  test("is told so and nothing is written", async () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- x\n",
      "package.json": `{"version": "1.2.0"}`,
    });
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      expect(
        await runReleaseCommand({ root, env: { JIG_HOME: temporary() } }),
      ).toBe(0);
      expect(
        await runReleaseCommand({
          root,
          json: true,
          env: { JIG_HOME: temporary() },
        }),
      ).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("not configured");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      configured: false,
      version: null,
      notes: [],
    });
    expect(text(root, "package.json")).toBe(`{"version": "1.2.0"}`);
    expect(existsSync(join(root, "changes/a.md"))).toBe(true);
  });

  test("a malformed note is a refusal naming it", async () => {
    const root = repository(files());
    write(root, "changes/a.md", "### Improved\n\n- x\n");
    await expect(release(resolvedFor(root, VERSION_FILES))).rejects.toThrow(
      MalformedNotes,
    );
  });
});
