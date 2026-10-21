import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

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
