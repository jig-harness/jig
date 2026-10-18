import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { checkBranch } from "../scripts/check.ts";
import {
  checkReleasePullRequest,
  headingDate,
  linesBeyondVersion,
  withVersion,
} from "../scripts/release-pr.ts";
import { releaseWithoutAfterVersion } from "../scripts/release.ts";
import {
  cleanEnv,
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  repository,
  resolvedFor,
  temporary,
  write,
} from "./scratch.ts";

const LOCK = (v: string, dependency = "4.0.0") =>
  `{\n  "name": "p",\n  "version": "${v}",\n  "dependencies": {\n    "left": "${dependency}"\n  }\n}\n`;

/** A repository in `push` mode with a note on main asking for a minor release. */
function repo(push = "pull-request", afterVersion = true): string {
  const after = afterVersion ? "\n  after_version: bun install" : "";
  return repository({
    "CHANGELOG.md": KEEP_CHANGELOG,
    "package.json": `{"version": "1.2.0"}\n`,
    "package-lock.json": LOCK("1.2.0"),
    "changes/a.md": "---\nrelease: minor\n---\n### Added\n\n- a\n",
    "src/x.ts": "x\n",
    ".config/jig.yaml": jigYaml(
      `  file: CHANGELOG.md\n  release_paths: [src/]${after}\n  release:\n    push: ${push}`,
    ),
  });
}

/** The release branch as the release workflow makes it: the step's output, dated `date`, committed. */
function releaseBranch(root: string, date = "2026-02-03"): void {
  git(root, "checkout", "-qb", "changelog-release");
  const config = {
    release_paths: ["src/"],
    release: { push: "pull-request" },
  };
  releaseWithoutAfterVersion({ ...resolvedFor(root, config), date });
  write(root, "package-lock.json", LOCK("1.3.0"));
  commit(root, {}, "chore(release): 1.3.0");
}

const env = () => ({ JIG_HOME: temporary("jig-home-") });
const check = (root: string, head: string | null = null) =>
  checkBranch(root, "main", env(), true, head);
const worktrees = (root: string) =>
  git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree ")).length;

describe("the release pull request is reproduced", () => {
  test("a release pull request as the release step writes it passes, and the worktree is removed", () => {
    const root = repo();
    releaseBranch(root);
    const result = check(root);
    expect(result.findings).toEqual([]);
    expect(result.reproduced).toEqual({ version: "1.3.0", date: "2026-02-03" });
    expect(worktrees(root)).toBe(1);
  });

  test("a release pull request that carries another change fails, naming the file", () => {
    const root = repo();
    releaseBranch(root);
    commit(root, { "src/x.ts": "changed\n" }, "sneak");
    const findings = check(root).findings.join("\n");
    expect(findings).toContain("src/x.ts");
    expect(worktrees(root)).toBe(1);
    commit(root, { "src/y.ts": "new\n" }, "add");
    expect(check(root).findings.join("\n")).toContain(
      "src/y.ts: the branch adds it",
    );
  });

  test("an edit to the changelog the release step wrote fails", () => {
    const root = repo();
    releaseBranch(root);
    const changelog = git(root, "show", "HEAD:CHANGELOG.md");
    commit(
      root,
      { "CHANGELOG.md": changelog.replace("- a\n", "- a, reworded\n") },
      "reword",
    );
    expect(check(root).findings.join("\n")).toContain(
      "CHANGELOG.md: differs from what re-running the release step on its merge base writes",
    );
  });

  test("a heading whose date is not a day the release step could have run fails", () => {
    const invalid = repo();
    releaseBranch(invalid);
    const changelog = git(invalid, "show", "HEAD:CHANGELOG.md");
    commit(
      invalid,
      { "CHANGELOG.md": changelog.replace("2026-02-03", "2026-02-30") },
      "redate",
    );
    expect(check(invalid).findings.join("\n")).toContain(
      '"2026-02-30" is not a calendar day',
    );
    const future = repo();
    releaseBranch(future, "2999-01-01");
    expect(check(future).findings.join("\n")).toContain(
      "2999-01-01 is later than today",
    );
  });

  test("a branch with no new release heading, or two, fails", () => {
    const none = repo();
    git(none, "checkout", "-qb", "changelog-release");
    commit(none, { "src/x.ts": "changed\n" }, "no release");
    expect(check(none).findings.join("\n")).toContain(
      "CHANGELOG.md gains no release heading",
    );
    const two = repo();
    releaseBranch(two);
    const changelog = git(two, "show", "HEAD:CHANGELOG.md");
    commit(
      two,
      {
        "CHANGELOG.md": changelog.replace(
          "## [1.3.0]",
          "## [1.4.0] - 2026-02-03\n\n### Added\n\n- b\n\n## [1.3.0]",
        ),
      },
      "another",
    );
    expect(check(two).findings.join("\n")).toContain(
      "gains 2 release headings (1.4.0, 1.3.0)",
    );
  });

  test("a file after_version touched may differ only by the version in its lines", () => {
    const root = repo();
    releaseBranch(root);
    expect(check(root).findings).toEqual([]);
    commit(root, { "package-lock.json": LOCK("1.3.0", "5.0.0") }, "bump left");
    const findings = check(root).findings.join("\n");
    expect(findings).toContain(
      "package-lock.json: changed beyond 1.2.0 becoming 1.3.0 in its lines",
    );
    expect(findings).toContain('+     "left": "5.0.0"');
  });

  test("a line that only names the new version is still a change beyond it", () => {
    const root = repo();
    releaseBranch(root);
    commit(
      root,
      {
        "package-lock.json": LOCK("1.3.0").replace(
          '"name": "p",',
          '"name": "p", "postinstall": "exec(evil) // 1.3.0",',
        ),
      },
      "smuggle a line",
    );
    const findings = check(root).findings.join("\n");
    expect(findings).toContain("package-lock.json: changed beyond");
    expect(findings).toContain("exec(evil) // 1.3.0");
    // An added line naming the version is caught as well.
    commit(
      root,
      { "package-lock.json": `${LOCK("1.3.0")}// 1.3.0\n` },
      "add a line",
    );
    expect(check(root).findings.join("\n")).toContain("+ // 1.3.0");
  });

  test("a file that is not UTF-8 text may not differ at all, even by bytes that decode alike", () => {
    const root = repo();
    const asset = (version: string, invalid: number) =>
      Buffer.concat([
        Buffer.from(`version ${version}\n`),
        Buffer.from([invalid]),
        Buffer.from("\n"),
      ]);
    writeFileSync(join(root, "asset.bin"), asset("1.2.0", 0xff));
    commit(root, {}, "add an asset");
    releaseBranch(root);
    expect(check(root).findings).toEqual([]);
    // 0xff and 0xfe are both invalid UTF-8: decoded leniently, both read as U+FFFD.
    writeFileSync(join(root, "asset.bin"), asset("1.3.0", 0xfe));
    commit(root, {}, "change the asset");
    expect(check(root).findings.join("\n")).toContain(
      "asset.bin: changed, and is not UTF-8 text",
    );
  });

  test("a path may not change its mode, even with the same content", () => {
    const root = repo();
    releaseBranch(root);
    // The mode is set in the index as well, where a file system without
    // executable bits records it.
    const executable = (on: boolean) => {
      chmodSync(join(root, "src/x.ts"), on ? 0o755 : 0o644);
      git(root, "update-index", `--chmod=${on ? "+" : "-"}x`, "src/x.ts");
    };
    executable(true);
    commit(root, {}, "make it executable");
    expect(check(root).findings.join("\n")).toContain(
      "src/x.ts: the branch makes it an executable file, where re-running the release step on its merge base leaves a file",
    );
    executable(false);
    commit(root, {}, "back");
    expect(check(root).findings).toEqual([]);
  });

  test("a submodule may not move to another commit, checked out or not", () => {
    const root = repo();
    const pinned = git(root, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${pinned},sub`);
    mkdirSync(join(root, "sub"));
    commit(root, {}, "pin a submodule");
    const moved = git(root, "rev-parse", "HEAD").trim();
    releaseBranch(root);
    expect(check(root).findings).toEqual([]);
    git(root, "update-index", "--cacheinfo", `160000,${moved},sub`);
    commit(root, {}, "move the submodule");
    expect(check(root).findings.join("\n")).toContain(
      `sub: the branch moves the submodule to commit ${moved}`,
    );
  });

  // Creating a symbolic link needs a privilege Windows does not grant by default.
  test.skipIf(process.platform === "win32")(
    "a path may not change its kind, even with the same content",
    () => {
      const other = repo();
      write(other, "src/target.ts", "x\n");
      commit(other, {}, "a target");
      releaseBranch(other);
      rmSync(join(other, "src/x.ts"));
      symlinkSync("target.ts", join(other, "src/x.ts"));
      commit(other, {}, "a link with the same content");
      expect(check(other).findings.join("\n")).toContain(
        "src/x.ts: the branch makes it a symbolic link",
      );
    },
  );

  test("without after_version, no file beyond the release step's own may change", () => {
    const root = repo("pull-request", false);
    releaseBranch(root);
    expect(check(root).findings.join("\n")).toContain(
      "package-lock.json: changed, which re-running the release step on its merge base does not change",
    );
  });

  test("in direct mode a branch named like the release branch gets the ordinary rules", () => {
    const root = repo("direct");
    releaseBranch(root);
    const result = check(root);
    expect(result.reproduced).toBeNull();
    expect(result.findings.join("\n")).toContain(
      "adds or removes a release section",
    );
  });

  test("the head ref decides, not the branch checked out", () => {
    const root = repo();
    releaseBranch(root);
    git(root, "checkout", "-qb", "other");
    expect(check(root).reproduced).toBeNull();
    expect(check(root, "changelog-release").findings).toEqual([]);
  });

  test("a release pull request whose merge base cannot be found fails", () => {
    const root = repo();
    releaseBranch(root);
    expect(
      checkReleasePullRequest(root, "origin/nowhere").findings.join("\n"),
    ).toContain("no merge base");
  });
});

describe("the parts of the comparison", () => {
  test("a release heading's date is read in both formats", () => {
    expect(headingDate("[1.3.0] - 2026-02-03")).toBe("2026-02-03");
    expect(headingDate("1.3.0 - 2026-02-03")).toBe("2026-02-03");
    expect(headingDate("[1.3.0]")).toBeNull();
  });

  test("a line may differ only by the previous version becoming the new one", () => {
    expect(
      linesBeyondVersion(LOCK("1.2.0"), LOCK("1.3.0"), "1.2.0", "1.3.0"),
    ).toEqual([]);
    expect(
      linesBeyondVersion(
        "a\n1.2.0\nb\n",
        "a\n1.3.0\nextra\nb\n",
        "1.2.0",
        "1.3.0",
      ),
    ).toEqual(["+ extra"]);
    // A line that names a version on both sides but changes otherwise.
    expect(
      linesBeyondVersion("x 1.2.0\n", "y 1.3.0\n", "1.2.0", "1.3.0"),
    ).toEqual(["- x 1.2.0", "+ y 1.3.0"]);
  });

  test("only a whole version is replaced", () => {
    expect(
      withVersion('"p@1.2.0", 11.2.0, 1.2.0-rc.1, 1.2.0', "1.2.0", "1.3.0"),
    ).toBe('"p@1.3.0", 11.2.0, 1.2.0-rc.1, 1.3.0');
    expect(withVersion("x1.2.0 1.2.0.1 1.2.0+b", "1.2.0", "1.3.0")).toBe(
      "x1.2.0 1.2.0.1 1.2.0+b",
    );
    expect(withVersion("1a2b0 1.2.0", "1.2.0", "1.3.0")).toBe("1a2b0 1.3.0");
  });
});

describe("the head ref in CI", () => {
  const scripts = join(import.meta.dir, "..", "scripts");
  const run = (root: string, extra: Record<string, string>) => {
    const result = spawnSync(process.execPath, [join(scripts, "check.ts")], {
      cwd: root,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-"), ...extra }),
    });
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  test("the pull-request event's head branch makes a detached checkout the release pull request", () => {
    const root = repo();
    releaseBranch(root);
    git(root, "checkout", "-q", "--detach");
    const ci = {
      GITHUB_ACTIONS: "true",
      CI: "true",
      GITHUB_BASE_REF: "main",
    };
    const passed = run(root, { ...ci, GITHUB_HEAD_REF: "changelog-release" });
    expectSpawnExit(passed, 0, "release pull request");
    expect(passed.stdout).toContain(
      "the release pull request is what the release step writes on its merge base: 1.3.0, dated 2026-02-03",
    );
    const ordinary = run(root, { ...ci, GITHUB_HEAD_REF: "feature" });
    expectSpawnExit(ordinary, 1, "ordinary branch");
    expect(ordinary.stderr).toContain("adds or removes a release section");
  });
});
