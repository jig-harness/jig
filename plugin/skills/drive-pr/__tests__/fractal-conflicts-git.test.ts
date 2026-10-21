import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

const collector = pathToFileURL(
  join(import.meta.dir, "../scripts/lib/fractal-conflicts.ts"),
).href;

test("real collector keeps PR sync and final merges, excluding base and imported branch history", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-conflict-ancestry-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "absent-config"),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-18T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-18T00:00:00Z",
  };
  function git(...args: string[]) {
    const child = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdin: new Uint8Array(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(child, 0, `git ${args[0]}`);
    return child.stdout.toString().trim();
  }
  try {
    git("init", "-q");
    const tree = git("mktree");
    const commit = (label: string, parents: string[] = []) =>
      git(
        "commit-tree",
        tree,
        ...parents.flatMap((p) => ["-p", p]),
        "-m",
        label,
      );
    const base = commit("base");
    const baseSide = commit("base-side", [base]);
    const baseMerge = commit("pre-existing-base-merge", [base, baseSide]);
    const prWork = commit("pr-work", [base]);
    const sync = commit("catch-up-with-base", [prWork, baseMerge]);
    const importedWork = commit("another-pr-work", [base]);
    const importedMerge = commit("another-pr-merge", [base, importedWork]);
    const head = commit("combine-branches", [sync, importedMerge]);
    const final = commit("custom-final-subject", [baseMerge, head]);
    const sample = { pr: 1, headRefOid: head, mergeCommitOid: final };
    const probe = `import { realConflictDeps } from ${JSON.stringify(collector)};
const deps = realConflictDeps(${JSON.stringify(dir)}, { owner: "fixture", name: "repository" });
const found = await deps.ancestry(${JSON.stringify(sample)});
const missing = await deps.ancestry({ ...${JSON.stringify(sample)}, headRefOid: "f".repeat(40) });
console.log(JSON.stringify({ commits: [...found.commits], merges: [...found.merges], missing }));`;
    const child = Bun.spawnSync([process.execPath, "-e", probe], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(child, 0, "real ancestry collector");
    const result = JSON.parse(child.stdout.toString()) as {
      commits: string[];
      merges: string[];
      missing: unknown;
    };
    expect(result.commits).toContain(prWork);
    expect(result.commits).toContain(sync);
    expect(result.commits).toContain(head);
    expect(result.commits).not.toContain(baseMerge);
    expect(result.commits).not.toContain(importedMerge);
    expect(result.commits).not.toContain(importedWork);
    expect(result.merges).toContain(sync);
    expect(result.merges).toContain(head);
    expect(result.merges).toContain(final);
    expect(result.missing).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(
  skipsOnWindows("git-bash", "the git shim on PATH is a POSIX shell script"),
)(
  "ancestry is unknown in a partial clone whose git cannot stop a lazy fetch",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-conflict-partial-"));
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    mkdirSync(home);
    mkdirSync(bin);
    mkdirSync(repo);
    const realGit = Bun.which("git") as string;
    // Reports an older git and runs the real one for everything else.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.44.0"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "absent-config"),
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    function git(...args: string[]) {
      const child = Bun.spawnSync([realGit, ...args], {
        cwd: repo,
        env,
        stdin: new Uint8Array(),
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(child, 0, `git ${args[0]}`);
      return child.stdout.toString().trim();
    }
    function ancestry() {
      const probe = `import { realConflictDeps } from ${JSON.stringify(collector)};
const notes = [];
const deps = realConflictDeps(${JSON.stringify(repo)}, { owner: "fixture", name: "repository" }, (m) => notes.push(m));
const sample = ${JSON.stringify(sample)};
const first = await deps.ancestry(sample);
await deps.ancestry(sample);
console.log(JSON.stringify({ found: first !== null, notes }));`;
      const child = Bun.spawnSync([process.execPath, "-e", probe], {
        cwd: repo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(child, 0, "real ancestry collector");
      return JSON.parse(child.stdout.toString()) as {
        found: boolean;
        notes: string[];
      };
    }
    let sample = { pr: 1, headRefOid: "", mergeCommitOid: "" };
    try {
      git("init", "-q");
      const tree = git("mktree");
      const base = git("commit-tree", tree, "-m", "base");
      const work = git("commit-tree", tree, "-p", base, "-m", "work");
      const final = git(
        "commit-tree",
        tree,
        "-p",
        base,
        "-p",
        work,
        "-m",
        "final",
      );
      sample = { pr: 1, headRefOid: work, mergeCommitOid: final };
      expect(ancestry()).toEqual({ found: true, notes: [] });
      git("config", "remote.origin.promisor", "true");
      const refused = ancestry();
      expect(refused.found).toBe(false);
      expect(refused.notes).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
