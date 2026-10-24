import { describe, expect, test } from "bun:test";
import {
  changes,
  configAtBase,
  DEFAULTS,
  loadChangelogConfig,
  parseChangelogSection,
  resolve,
} from "../scripts/config.ts";
import { detectFormat } from "../scripts/formats.ts";
import {
  commit,
  git,
  jigYaml,
  repository,
  temporary,
  write,
} from "./scratch.ts";

const parse = (section: Record<string, unknown>) =>
  parseChangelogSection({ file: "CHANGELOG.md", ...section });
const refused = (section: Record<string, unknown>) => {
  try {
    parse(section);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

describe("the section", () => {
  test("setting file turns it on, and everything else has its default", () => {
    expect(parse({})).toEqual({
      file: "CHANGELOG.md",
      format: null,
      notesDir: DEFAULTS.notesDir,
      version: null,
      releasePaths: [],
      notePaths: [],
      placeholders: [],
      afterVersion: null,
      unreleased: null,
      authors: true,
      tagPrefix: "v",
      release: { push: "direct", branch: "changelog-release" },
    });
    expect(parseChangelogSection(undefined)).toBeNull();
    // Without a file it is off, even when other fields are set; they are still checked.
    expect(parseChangelogSection({ release_paths: ["src/"] })).toBeNull();
    expect(() => parseChangelogSection({ relase_paths: [] })).toThrow(
      "changelog.relase_paths is not a changelog field",
    );
  });

  test("every field is validated, and a message opens with the field at fault", () => {
    for (const [section, message] of [
      [{ file: "/etc/passwd" }, "changelog.file must stay inside"],
      [{ file: "../CHANGELOG.md" }, "changelog.file must stay inside"],
      [{ format: "keepachangelog" }, "changelog.format must be one of"],
      [{ notes_dir: 3 }, "changelog.notes_dir must be a path"],
      [{ release_paths: "plugin/" }, "changelog.release_paths must be a list"],
      [{ note_paths: ["a", ""] }, "changelog.note_paths must be a list"],
      [{ unreleased: "later" }, "changelog.unreleased must be one of"],
      [{ authors: "yes" }, "changelog.authors must be true or false"],
      [{ tag_prefix: "v 1" }, "changelog.tag_prefix must be text"],
      [{ after_version: 3 }, "changelog.after_version must be a command"],
      [{ release: { push: "force" } }, "changelog.release.push must be one of"],
      [
        { release: { branch: "a b" } },
        "changelog.release.branch must be a branch name",
      ],
      [{ release: { when: "x" } }, "changelog.release.when is not a field"],
    ] as const)
      expect(refused({ ...section }), JSON.stringify(section)).toContain(
        message,
      );
  });

  test("file and notes_dir name a file and a folder below the root", () => {
    for (const file of [".", "./", "", "docs/", "a/..", "."])
      expect(refused({ file }), JSON.stringify(file)).toMatch(
        /changelog\.file must (name a file|be a path|stay inside)/,
      );
    for (const notes_dir of [".", "./", "", "/", "changes/.."])
      expect(refused({ notes_dir }), JSON.stringify(notes_dir)).toMatch(
        /changelog\.notes_dir must (name a folder|be a path|stay inside)/,
      );
    expect(parse({ notes_dir: "./changes/" })?.notesDir).toBe("changes");
    expect(parse({ notes_dir: "docs/./notes" })?.notesDir).toBe("docs/notes");
    expect(parse({ file: "./docs/CHANGELOG.md" })?.file).toBe(
      "docs/CHANGELOG.md",
    );
  });

  test("a release pull request is opened only for a release, so unreleased: write is refused with it", () => {
    expect(
      refused({ unreleased: "write", release: { push: "pull-request" } }),
    ).toContain("cannot be write");
    expect(
      parse({ unreleased: "wait", release: { push: "pull-request" } })
        ?.unreleased,
    ).toBe("wait");
  });

  test("version is files or tags, and a file is a kind that can hold one", () => {
    expect(parse({ version: { tags: true } })?.version).toEqual({
      kind: "tags",
    });
    expect(
      parse({
        version: {
          files: [
            { path: "app/pyproject.toml", key: "project.version" },
            { path: "VERSION" },
          ],
        },
      })?.version,
    ).toEqual({
      kind: "files",
      files: [
        { path: "app/pyproject.toml", key: "project.version" },
        { path: "VERSION", key: "" },
      ],
    });
    for (const [version, message] of [
      [{}, "files or tags, one of them"],
      [{ tags: true, files: [] }, "files or tags, one of them"],
      [{ tags: false }, "tags must be true"],
      [{ files: [] }, "at least one file"],
      [{ files: [{ path: "setup.py", key: "v" }] }, "not a kind of file"],
      [{ files: [{ path: "a.json" }] }, "key must name"],
      [{ files: [{ path: "VERSION", key: "v" }] }, "holds the version alone"],
      [
        { files: [{ path: "a.json", key: "v", extra: 1 }] },
        "unknown key extra",
      ],
      [{ files: [{ path: "../a.json", key: "v" }] }, "must stay inside"],
      [{ other: 1 }, "unknown key other"],
      [
        {
          files: [
            { path: "a.json", key: "v" },
            { path: "./a.json", key: '"v"' },
          ],
        },
        "files[1] names a.json",
      ],
      [
        {
          files: [
            { path: "a.json", key: "v" },
            { path: "././a.json", key: "v" },
          ],
        },
        "files[1] names a.json",
      ],
      [
        {
          files: [
            { path: "dir/a.json", key: "v" },
            { path: "dir/./a.json", key: "v" },
          ],
        },
        "files[1] names dir/a.json",
      ],
      [
        {
          files: [
            { path: "dir/a.json", key: "v" },
            { path: "dir//a.json", key: "v" },
          ],
        },
        "files[1] names dir/a.json",
      ],
      [{ files: [{ path: "dir/", key: "v" }] }, "not a folder"],
      [
        { files: [{ path: "VERSION" }, { path: "VERSION" }] },
        "list each version once",
      ],
    ] as const)
      expect(refused({ version }), JSON.stringify(version)).toContain(message);
  });

  test("a placeholder fills {version}, and never reaches a workflow", () => {
    const entry = (files: string[], over = {}) => ({
      placeholders: [
        { files, from: "since: next", to: "since: {version}", ...over },
      ],
    });
    expect(parse(entry(["docs/*.md"]))?.placeholders).toHaveLength(1);
    for (const files of [
      [".github/workflows/ci.yml"],
      [".github/workflows/*"],
      [".github/workflows"],
      [".github/**/*.yml"],
      ["**/*.yml"],
      ["**/*.yaml"],
      ["./.github/workflows/release.yml"],
    ])
      expect(refused(entry(files)), files.join()).toContain("workflow");
    expect(refused(entry(["a.md"], { to: "since: next" }))).toContain(
      "holding {version}",
    );
    expect(refused(entry(["a.md"], { from: "" }))).toContain(
      "one line of text",
    );
    expect(refused(entry([], {}))).toContain("must name a file");
    expect(
      refused({
        placeholders: [{ files: ["a"], from: "x", to: "{version}", more: 1 }],
      }),
    ).toContain("unknown key more");
  });

  test("describes what a proposal changes", () => {
    const before = parse({ release_paths: ["src/"] });
    const after = parse({ release_paths: ["src/", "lib/"], authors: false });
    if (!before || !after) throw new Error("unreachable");
    expect(changes(before, before)).toEqual([]);
    expect(changes(before, after)).toEqual([
      'changelog.release_paths: ["src/"] → ["src/","lib/"]',
      "changelog.authors: true → false",
    ]);
  });
});

describe("where the section is read from", () => {
  const yaml = jigYaml("  file: CHANGELOG.md\n  notes_dir: notes");
  const env = (extra: Record<string, string> = {}) => ({
    JIG_HOME: temporary("jig-home-"),
    ...extra,
  });

  test("the repository's own file turns it on", () => {
    const root = repository({ ".config/jig.yaml": yaml });
    expect(loadChangelogConfig(root, env())?.notesDir).toBe("notes");
  });

  test("a repository without the field sees nothing", () => {
    expect(loadChangelogConfig(repository({ "a.txt": "x" }), env())).toBeNull();
    const root = repository({
      ".config/jig.yaml": "gates:\n  command: bun test\n",
    });
    expect(loadChangelogConfig(root, env())).toBeNull();
  });

  test("an environment variable cannot turn it on, nor change it", () => {
    const off = repository({ ".config/jig.yaml": "gates:\n  command: x\n" });
    expect(() =>
      loadChangelogConfig(off, env({ JIG__CHANGELOG__FILE: "CHANGELOG.md" })),
    ).toThrow("$JIG__CHANGELOG__FILE");
    const on = repository({ ".config/jig.yaml": yaml });
    expect(() =>
      loadChangelogConfig(
        on,
        env({ JIG__CHANGELOG__RELEASE__PUSH: "pull-request" }),
      ),
    ).toThrow("$JIG__CHANGELOG__RELEASE__PUSH");
    expect(() =>
      loadChangelogConfig(on, env({ JIG__CHANGELOG__NOTES_DIR: "other" })),
    ).toThrow("read from the repository's own .config/jig.yaml only");
  });

  test("JIG_OVERLAY neither turns the section on nor replaces it", () => {
    const other = temporary("overlay-");
    write(
      other,
      "other.yaml",
      jigYaml("  file: CHANGELOG.md\n  notes_dir: swapped"),
    );
    const off = repository({ "a.txt": "x" });
    expect(
      loadChangelogConfig(off, env({ JIG_OVERLAY: `${other}/other.yaml` })),
    ).toBeNull();
    const on = repository({ ".config/jig.yaml": yaml });
    expect(
      loadChangelogConfig(on, env({ JIG_OVERLAY: `${other}/other.yaml` }))
        ?.notesDir,
    ).toBe("notes");
  });

  test("a user file cannot either", () => {
    const home = temporary("jig-home-");
    write(home, "jig.yaml", "changelog:\n  file: CHANGELOG.md\n");
    const root = repository({ "a.txt": "x" });
    expect(() => loadChangelogConfig(root, { JIG_HOME: home })).toThrow(
      "changelog.file describes one repository",
    );
  });

  test("an invalid section names the file it is in", () => {
    const root = repository({
      ".config/jig.yaml": jigYaml("  file: CHANGELOG.md\n  authors: nope"),
    });
    expect(() => loadChangelogConfig(root, env())).toThrow(
      /changelog\.authors must be true or false: .*\.config[\\/]jig\.yaml/,
    );
  });
});

describe("the section at a base", () => {
  test("is the base's, whatever the working tree says now", () => {
    const root = repository({
      ".config/jig.yaml": jigYaml(
        "  file: CHANGELOG.md\n  release_paths: [src/]",
      ),
    });
    git(root, "checkout", "-qb", "work");
    commit(
      root,
      { ".config/jig.yaml": jigYaml("  file: CHANGELOG.md") },
      "weaken",
    );
    expect(configAtBase(root, "main")?.releasePaths).toEqual(["src/"]);
    expect(configAtBase(root, "work")?.releasePaths).toEqual([]);
  });

  test("none at a base without the file or the field; invalid is an error naming the base", () => {
    const root = repository({ "a.txt": "x" });
    expect(configAtBase(root, "main")).toBeNull();
    commit(root, { ".config/jig.yaml": "gates:\n  command: x\n" }, "other");
    expect(configAtBase(root, "main")).toBeNull();
    commit(
      root,
      { ".config/jig.yaml": jigYaml("  file: x\n  authors: 3") },
      "bad",
    );
    expect(() => configAtBase(root, "main")).toThrow(
      /changelog\.authors must be true or false: \.config\/jig\.yaml at main/,
    );
  });
});

describe("resolving the section against the repository", () => {
  const resolveWith = (files: Record<string, string>, section = {}) => {
    const root = repository(files);
    const config = parseChangelogSection({ file: "CHANGELOG.md", ...section });
    if (!config) throw new Error("unreachable");
    return resolve(root, config, (path) => files[path] ?? null);
  };
  const manifest = { "package.json": '{"version": "1.0.0"}' };

  test("detects the format from the file, and refuses a file that does not say", () => {
    expect(detectFormat("# C\n\n## [Unreleased]\n")?.id).toBe(
      "keep-a-changelog",
    );
    expect(detectFormat("# C\n\nSee https://keepachangelog.com/\n")?.id).toBe(
      "keep-a-changelog",
    );
    expect(detectFormat("# C\n\nSee https://common-changelog.org/\n")?.id).toBe(
      "common-changelog",
    );
    expect(detectFormat("# C\n\n```\n## [Unreleased]\n```\n")).toBeNull();
    for (const text of [
      "",
      "# Changelog\n",
      "https://keepachangelog.com https://common-changelog.org",
    ])
      expect(() => resolveWith({ "CHANGELOG.md": text, ...manifest })).toThrow(
        "set changelog.format to keep-a-changelog or common-changelog",
      );
    expect(
      resolveWith(
        { "CHANGELOG.md": "", ...manifest },
        { format: "common-changelog" },
      ).format.id,
    ).toBe("common-changelog");
  });

  test("a missing changelog names the field", () => {
    expect(() => resolveWith({ ...manifest })).toThrow(
      "changelog.file: CHANGELOG.md does not exist",
    );
  });

  test("when a note without a release is written: at once, unless releases go through a pull request or the format has no Unreleased", () => {
    const keep = { "CHANGELOG.md": "## [Unreleased]\n", ...manifest };
    expect(resolveWith(keep).unreleased).toBe("write");
    expect(resolveWith(keep, { unreleased: "wait" }).unreleased).toBe("wait");
    expect(
      resolveWith(keep, { release: { push: "pull-request" } }).unreleased,
    ).toBe("wait");
    const common = {
      "CHANGELOG.md": "https://common-changelog.org\n",
      ...manifest,
    };
    expect(resolveWith(common, { unreleased: "write" }).unreleased).toBe(
      "wait",
    );
  });

  test("derives the version files, or asks for the field", () => {
    const keep = { "CHANGELOG.md": "## [Unreleased]\n" };
    expect(resolveWith({ ...keep, ...manifest }).version).toEqual({
      kind: "files",
      files: [{ path: "package.json", key: "version" }],
    });
    expect(() => resolveWith(keep)).toThrow("Set changelog.version");
  });
});
