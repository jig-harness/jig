import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const roots: string[] = [];
const script = resolve(
  import.meta.dir,
  "../scripts/release-implementer-worktree.ts",
);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function run(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...extraEnv,
    },
  });
}
function git(cwd: string, ...args: string[]) {
  const result = run(cwd, ["git", ...args]);
  expectSpawnExit(result, 0);
  return result.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-delegate-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const tree = join(root, "delegate");
  git(root, "init", "--bare", remote);
  git(root, "init", main);
  writeFileSync(join(main, "file"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  git(main, "remote", "add", "origin", remote);
  git(main, "worktree", "add", "-b", "item", tree);
  git(tree, "push", "-u", "origin", "item");
  return { root, main, tree };
}
function release(main: string, tree: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = run(
    main,
    [
      process.execPath,
      script,
      "--tree",
      tree,
      "--branch",
      "item",
      "--remote",
      "origin",
    ],
    extraEnv,
  );
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout.toString());
}
test("releases the clean pushed delegate branch so another worktree can take it", () => {
  const { main, tree, root } = fixture();
  expect(release(main, tree).outcome).toBe("released");
  expect(git(tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  git(main, "worktree", "add", join(root, "drive"), "item");
});
test("does not inherit git location overrides while inspecting a delegate", () => {
  const { main, tree } = fixture();
  const otherGitDir = git(main, "rev-parse", "--absolute-git-dir");
  expect(
    release(main, tree, {
      GIT_DIR: otherGitDir,
      GIT_INDEX_FILE: join(main, "wrong-index"),
    }).outcome,
  ).toBe("released");
});
test("keeps tracked and untracked local changes and names the release commands", () => {
  const { main, tree } = fixture();
  writeFileSync(join(tree, "file"), "dirty\n");
  const held = release(main, tree);
  expect(held.outcome).toBe("held");
  expect(held.reason).toContain("changes");
  expect(held.commands.length).toBeGreaterThan(0);
  expect(git(tree, "branch", "--show-current")).toBe("item");
  git(tree, "checkout", "--", "file");
  writeFileSync(join(tree, "extra"), "untracked");
  expect(release(main, tree).outcome).toBe("held");
});
test("keeps unpushed commits even when a local tracking ref claims otherwise", () => {
  const { main, tree } = fixture();
  writeFileSync(join(tree, "file"), "next\n");
  git(tree, "commit", "-am", "next");
  git(tree, "update-ref", "refs/remotes/origin/item", "HEAD");
  expect(release(main, tree).reason).toContain("remote");
  expect(git(tree, "branch", "--show-current")).toBe("item");
});
test("keeps an unfinished operation and refuses the session's own tree", () => {
  const { main, tree } = fixture();
  const mergeHead = git(tree, "rev-parse", "--git-path", "MERGE_HEAD");
  writeFileSync(mergeHead, git(tree, "rev-parse", "HEAD"));
  expect(release(main, tree).reason).toContain("operation");
  rmSync(mergeHead);
  expect(release(tree, tree).reason).toContain("session");
});
test("refuses a different branch, primary tree and another clone", () => {
  const { main, tree, root } = fixture();
  git(tree, "branch", "-m", "other");
  expect(release(main, tree).outcome).toBe("held");
  expect(release(tree, main).outcome).toBe("held");
  const another = join(root, "another");
  git(root, "clone", join(root, "remote.git"), another);
  expect(release(main, another).outcome).toBe("held");
});

test("releases a delegate behind its remote and keeps one with hidden index changes", () => {
  const { main, tree } = fixture();
  writeFileSync(join(main, "file"), "remote ahead\n");
  git(main, "commit", "-am", "ahead");
  git(main, "push", "origin", "HEAD:item");
  git(tree, "update-index", "--assume-unchanged", "file");
  writeFileSync(join(tree, "file"), "hidden local change\n");
  expect(release(main, tree).reason).toContain("index flags");
  expect(git(tree, "branch", "--show-current")).toBe("item");
  git(tree, "update-index", "--no-assume-unchanged", "file");
  git(tree, "checkout", "--", "file");
  expect(release(main, tree).outcome).toBe("released");
});

test("keeps dirty submodules even when repository settings hide them", () => {
  const { root, main, tree } = fixture();
  const module = join(root, "module-source");
  git(root, "init", module);
  writeFileSync(join(module, "nested"), "initial\n");
  git(module, "add", ".");
  git(module, "commit", "-m", "module");
  git(
    tree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    module,
    "nested-module",
  );
  git(tree, "commit", "-am", "add module");
  git(tree, "push", "origin", "item");
  git(tree, "config", "diff.ignoreSubmodules", "all");
  writeFileSync(join(tree, "nested-module", "nested"), "dirty\n");
  expect(git(tree, "status", "--porcelain=v1")).toBe("");
  const report = release(main, tree);
  expect(report.outcome).toBe("held");
  expect(report.reason).toContain("changes");
  expect(git(tree, "branch", "--show-current")).toBe("item");
});

test("keeps hidden changes inside initialized submodules", () => {
  const { root, main, tree } = fixture();
  const module = join(root, "module-source");
  git(root, "init", module);
  writeFileSync(join(module, "nested"), "initial\n");
  git(module, "add", ".");
  git(module, "commit", "-m", "initial");
  git(
    tree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    module,
    "nested-module",
  );
  git(tree, "commit", "-am", "add module");
  git(tree, "push", "origin", "item");
  git(
    join(tree, "nested-module"),
    "update-index",
    "--assume-unchanged",
    "nested",
  );
  writeFileSync(join(tree, "nested-module", "nested"), "dirty\n");
  const report = release(main, tree);
  expect(report.outcome).toBe("held");
  expect(report.reason).toContain("submodule");
});

test("holds the delegate when the submodule index matcher fails", () => {
  const { root, main, tree } = fixture();
  const module = join(root, "module-source");
  const bin = join(root, "bin");
  git(root, "init", module);
  writeFileSync(join(module, "nested"), "initial\n");
  git(module, "add", ".");
  git(module, "commit", "-m", "initial");
  git(
    tree,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    module,
    "nested-module",
  );
  git(tree, "commit", "-am", "add module");
  git(tree, "push", "origin", "item");
  mkdirSync(bin);
  const matcher = join(bin, "grep");
  writeFileSync(matcher, "#!/bin/sh\nexit 2\n");
  chmodSync(matcher, 0o755);
  const report = release(main, tree, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  expect(report.outcome).toBe("held");
  expect(report.reason).toContain("submodule");
});

test("includes the failed git read's exit and stderr in a held report", () => {
  const { main, tree, root } = fixture();
  git(tree, "remote", "set-url", "origin", join(root, "missing.git"));
  const report = release(main, tree);
  expect(report.outcome).toBe("held");
  expect(report.reason).toContain("ls-remote");
  expect(report.reason).toContain("exit 128");
  expect(report.reason).toContain("does not appear to be a git repository");
});
