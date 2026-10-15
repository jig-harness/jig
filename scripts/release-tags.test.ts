import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";
import {
  changelogVersions,
  introducingCommits,
  MANIFEST,
  manifestHistory,
  manifestVersion,
  owedTags,
  parseArgs,
  remoteTags,
  replaceCommands,
  tagCommands,
} from "./release-tags.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.3.0] - 2026-01-03

### Added

- a \`## [9.9.9]\` inside a line is not a release

## [0.2.1] - 2026-01-02

## [0.2.0] - 2026-01-02

## [0.1.0-pilot] - 2026-01-01
`;

describe("changelogVersions", () => {
  test("reads every release heading and leaves Unreleased out", () => {
    expect(changelogVersions(CHANGELOG)).toEqual([
      "0.3.0",
      "0.2.1",
      "0.2.0",
      "0.1.0-pilot",
    ]);
  });
});

describe("owedTags", () => {
  const versions = changelogVersions(CHANGELOG);
  const introduced = new Map([
    ["0.1.0-pilot", "p"],
    ["0.2.0", "a"],
    ["0.2.1", "b"],
    ["0.3.0", "c"],
  ]);
  const annotated = (commit: string) => ({ commit, annotated: true });
  const owed = (origin: [string, { commit: string; annotated: boolean }][]) =>
    owedTags(versions, introduced, new Map(origin), new Map()).map(
      (o) => o.version,
    );

  test("owes the untagged versions, oldest first", () => {
    expect(
      owed([
        ["v0.2.0", annotated("a")],
        ["v0.1.0-pilot", annotated("p")],
      ]),
    ).toEqual(["0.2.1", "0.3.0"]);
  });

  test("owes an untagged version older than a tagged one", () => {
    expect(owed([["v0.2.1", annotated("b")]])).toEqual([
      "0.1.0-pilot",
      "0.2.0",
      "0.3.0",
    ]);
  });

  test("owes every version when nothing is tagged yet", () => {
    expect(owed([])).toHaveLength(4);
  });

  test("ignores tags that are not a changelog version", () => {
    expect(
      owed([
        ["v0.3.0", annotated("c")],
        ["v7.0.0", annotated("z")],
        ["nightly", annotated("z")],
      ]),
    ).toEqual(["0.1.0-pilot", "0.2.0", "0.2.1"]);
  });

  test("owes a version whose annotated tag on origin is at another commit", () => {
    const [misplaced] = owedTags(
      ["0.3.0"],
      introduced,
      new Map([["v0.3.0", annotated("b")]]),
      new Map(),
    );
    expect(misplaced?.originTag).toEqual(annotated("b"));
    expect(replaceCommands(misplaced ? [misplaced] : [])).toEqual([
      "git tag -a v0.3.0 c -m v0.3.0",
      "git push origin :refs/tags/v0.3.0",
      "git push origin v0.3.0",
    ]);
  });

  test("settles a version no commit introduced by any annotated tag, and owes it without one", () => {
    const owedOf = (
      origin: Map<string, { commit: string; annotated: boolean }>,
    ) =>
      owedTags(["0.4.0"], introduced, origin, new Map()).map((o) => o.commit);
    expect(owedOf(new Map([["v0.4.0", annotated("c")]]))).toEqual([]);
    expect(owedOf(new Map())).toEqual([null]);
  });
});

describe("manifestVersion", () => {
  test("reads the version whatever the formatting", () => {
    expect(manifestVersion('{"version":"0.4.0"}')).toBe("0.4.0");
    expect(manifestVersion('{\n  "version": "0.4.0"\n}')).toBe("0.4.0");
  });

  test("is null for a missing file or a missing field", () => {
    expect(manifestVersion(null)).toBeNull();
    expect(manifestVersion('{"name":"jig"}')).toBeNull();
  });
});

describe("introducingCommits", () => {
  test("keeps the first commit that set a version, not a later reformatting", () => {
    const first = introducingCommits([
      { commit: "a", manifest: '{"version":"0.3.0"}' },
      { commit: "b", manifest: '{"version":"0.4.0"}' },
      { commit: "c", manifest: '{\n  "version": "0.4.0"\n}' },
    ]);
    expect(first.get("0.3.0")).toBe("a");
    expect(first.get("0.4.0")).toBe("b");
  });

  test("a commit that removes the manifest introduces nothing", () => {
    const first = introducingCommits([
      { commit: "a", manifest: '{"version":"0.3.0"}' },
      { commit: "b", manifest: null },
      { commit: "c", manifest: '{"version":"0.4.0"}' },
    ]);
    expect([...first]).toEqual([
      ["0.3.0", "a"],
      ["0.4.0", "c"],
    ]);
  });

  test("a manifest that does not parse names its commit", () => {
    expect(() => introducingCommits([{ commit: "b", manifest: "{" }])).toThrow(
      "plugin/.claude-plugin/plugin.json at b does not parse",
    );
  });
});

describe("tagCommands", () => {
  test("tags each merged version as the earlier tags were made, then pushes them together", () => {
    expect(
      tagCommands([
        {
          version: "0.2.1",
          tag: "v0.2.1",
          commit: "aaa",
          localTag: null,
          originTag: null,
        },
        {
          version: "0.3.0",
          tag: "v0.3.0",
          commit: "bbb",
          localTag: null,
          originTag: null,
        },
      ]),
    ).toEqual([
      "git tag -a v0.2.1 aaa -m v0.2.1",
      "git tag -a v0.3.0 bbb -m v0.3.0",
      "git push origin v0.2.1 v0.3.0",
    ]);
  });

  test("skips a version no commit on the branch has set yet", () => {
    expect(
      tagCommands([
        {
          version: "0.4.0",
          tag: "v0.4.0",
          commit: null,
          localTag: null,
          originTag: null,
        },
      ]),
    ).toEqual([]);
  });

  test("pushes a tag made here whose push failed, and remakes one at the wrong commit", () => {
    expect(
      tagCommands([
        {
          version: "0.2.1",
          tag: "v0.2.1",
          commit: "aaa",
          localTag: { commit: "aaa", annotated: true },
          originTag: null,
        },
        {
          version: "0.3.0",
          tag: "v0.3.0",
          commit: "bbb",
          localTag: { commit: "zzz", annotated: true },
          originTag: null,
        },
      ]),
    ).toEqual([
      "git tag -d v0.3.0",
      "git tag -a v0.3.0 bbb -m v0.3.0",
      "git push origin v0.2.1 v0.3.0",
    ]);
  });

  test("remakes a lightweight tag at the right commit as an annotated one", () => {
    expect(
      tagCommands([
        {
          version: "0.2.1",
          tag: "v0.2.1",
          commit: "aaa",
          localTag: { commit: "aaa", annotated: false },
          originTag: null,
        },
      ]),
    ).toEqual([
      "git tag -d v0.2.1",
      "git tag -a v0.2.1 aaa -m v0.2.1",
      "git push origin v0.2.1",
    ]);
  });
});

describe("replaceCommands", () => {
  const lightweight = {
    version: "0.2.1",
    tag: "v0.2.1",
    commit: "aaa",
    localTag: { commit: "aaa", annotated: false },
    originTag: { commit: "aaa", annotated: false },
  };

  test("replaces a lightweight tag on origin, which a plain push cannot", () => {
    expect(replaceCommands([lightweight])).toEqual([
      "git tag -d v0.2.1",
      "git tag -a v0.2.1 aaa -m v0.2.1",
      "git push origin :refs/tags/v0.2.1",
      "git push origin v0.2.1",
    ]);
  });

  test("keeps the replacement out of the unattended commands", () => {
    const fresh = {
      version: "0.3.0",
      tag: "v0.3.0",
      commit: "bbb",
      localTag: null,
      originTag: null,
    };
    expect(tagCommands([lightweight, fresh])).toEqual([
      "git tag -a v0.3.0 bbb -m v0.3.0",
      "git push origin v0.3.0",
    ]);
    expect(replaceCommands([fresh])).toEqual([]);
  });
});

describe("remoteTags", () => {
  test("tells annotated tags, which carry a peeled record, from lightweight ones", () => {
    const tags = remoteTags(
      [
        "abc\trefs/tags/v0.1.0",
        "def\trefs/tags/v0.2.0",
        "c0d\trefs/tags/v0.2.0^{}",
        "",
      ].join("\n"),
    );
    expect([...tags]).toEqual([
      ["v0.1.0", { commit: "abc", annotated: false }],
      ["v0.2.0", { commit: "c0d", annotated: true }],
    ]);
  });

  test("a lightweight tag on origin leaves its version owed", () => {
    const origin = remoteTags("abc\trefs/tags/v0.1.0\n");
    expect(
      owedTags(["0.1.0"], new Map([["0.1.0", "abc"]]), origin, new Map()).map(
        (o) => o.version,
      ),
    ).toEqual(["0.1.0"]);
  });
});

describe("parseArgs", () => {
  test("defaults to origin/main and takes --branch's value", () => {
    expect(parseArgs([])).toBe("origin/main");
    expect(parseArgs(["--json", "--branch", "main"])).toBe("main");
  });

  test("refuses an unknown argument, including the first one", () => {
    expect(parseArgs(["--al"])).toBeNull();
    expect(parseArgs(["unexpected"])).toBeNull();
    expect(parseArgs(["--branch"])).toBeNull();
    expect(parseArgs(["--branch", "--json"])).toBeNull();
  });
});

describe("manifestHistory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jig-release-tags-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  // The fixture reads no global or system configuration, so a machine's
  // signing or hook settings cannot fail or prompt the scratch commits.
  const gitConfig = join(scratch, "gitconfig");
  writeFileSync(gitConfig, "");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
      ),
    ),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (dir: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(scratch, "no-hooks")}`,
        ...args,
      ],
      { env },
    );
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const source = join(scratch, "source");
  mkdirSync(join(source, "plugin/.claude-plugin"), { recursive: true });
  git(source, "init", "-q", "-b", "main");
  for (const version of ["0.1.0", "0.2.0"]) {
    writeFileSync(join(source, MANIFEST), JSON.stringify({ version }));
    git(source, "add", ".");
    git(source, "commit", "-q", "-m", version);
  }

  test("reads every commit that changed the manifest in a full clone", () => {
    git(scratch, "clone", "-q", `file://${source}`, "full");
    const history = manifestHistory(join(scratch, "full"), "origin/main");
    expect(history.map((h) => manifestVersion(h.manifest))).toEqual([
      "0.1.0",
      "0.2.0",
    ]);
  });

  test("reads a commit that deleted the manifest as having none", () => {
    const repo = join(scratch, "deleted");
    git(scratch, "clone", "-q", `file://${source}`, "deleted");
    git(repo, "rm", "-q", MANIFEST);
    git(repo, "commit", "-q", "-m", "delete");
    const history = manifestHistory(repo, "HEAD");
    expect(history.map((h) => manifestVersion(h.manifest))).toEqual([
      "0.1.0",
      "0.2.0",
      null,
    ]);
  });

  test("throws when a manifest the commit has cannot be read, rather than reading it as deleted", () => {
    const repo = join(scratch, "corrupt");
    mkdirSync(join(repo, "plugin/.claude-plugin"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, MANIFEST), JSON.stringify({ version: "0.1.0" }));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "0.1.0");
    const blob = git(repo, "rev-parse", `HEAD:${MANIFEST}`);
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
    expect(() => manifestHistory(repo, "HEAD")).toThrow("git show");
  });

  test("refuses a shallow clone, whose oldest commit would read as introducing its version", () => {
    git(scratch, "clone", "-q", "--depth", "1", `file://${source}`, "shallow");
    expect(() =>
      manifestHistory(join(scratch, "shallow"), "origin/main"),
    ).toThrow("shallow clone");
  });
});
