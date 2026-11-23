import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { proveBaseMerge } from "../scripts/lib/base-merge-proof.ts";

async function inRepo(
  body: (
    git: (label: string, ...args: string[]) => string,
    write: (path: string, contents: string) => void,
    cwd: string,
  ) => Promise<void>,
): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "jig-base-merge-"));
  const git = (label: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Jig Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(result, 0, label);
    return result.stdout.toString().trim();
  };
  const write = (path: string, contents: string) =>
    writeFileSync(join(cwd, path), contents);
  try {
    git("initialize fixture", "init", "-b", "main");
    write("shared.txt", "original\n");
    git("stage fixture", "add", ".");
    git("commit fixture", "commit", "-m", "Initial");
    await body(git, write, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("proves a series of clean base merges and refuses further PR edits", async () => {
  await inRepo(async (git, write, cwd) => {
    git("create PR branch", "switch", "-c", "feature");
    write("feature.txt", "reviewed change\n");
    git("stage PR change", "add", "feature.txt");
    git("commit PR change", "commit", "-m", "Feature");
    const verified = git("verified head", "rev-parse", "HEAD");
    for (const i of [1, 2]) {
      git("switch to base", "switch", "main");
      write("shared.txt", `base change ${i}\n`);
      git("advance base", "commit", "-am", `Base ${i}`);
      git("switch to PR", "switch", "feature");
      git("merge the base", "merge", "--no-edit", "main");
    }
    const base = git("base head", "rev-parse", "main");
    const head = git("merged head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, head, base)).toBe(true);

    write("feature.txt", "additional change\n");
    git("commit new PR change", "commit", "-am", "More work");
    const changed = git("edited head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, changed, base)).toBe(false);
    expect(await proveBaseMerge(cwd, verified, "1".repeat(40), base)).toBe(
      false,
    );
  });
});

test("refuses a merge whose tree includes a manual change", async () => {
  await inRepo(async (git, write, cwd) => {
    git("create PR branch", "switch", "-c", "feature");
    write("feature.txt", "reviewed change\n");
    git("stage PR change", "add", "feature.txt");
    git("commit PR change", "commit", "-m", "Feature");
    const verified = git("verified head", "rev-parse", "HEAD");
    git("switch to base", "switch", "main");
    write("shared.txt", "base change\n");
    git("advance base", "commit", "-am", "New base");
    const base = git("base head", "rev-parse", "HEAD");
    git("switch to PR", "switch", "feature");
    git("prepare merge without commit", "merge", "--no-commit", "main");
    write("feature.txt", "changed during merge\n");
    git("stage manual change", "add", "feature.txt");
    git("commit merge", "commit", "-m", "Merge with an edit");
    const head = git("edited merge head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, head, base)).toBe(false);
  });
});

test("refuses a hand-resolved conflict and a second parent outside the base", async () => {
  await inRepo(async (git, write, cwd) => {
    git("create PR branch", "switch", "-c", "feature");
    write("shared.txt", "reviewed change\n");
    git("commit PR change", "commit", "-am", "Feature");
    const verified = git("verified head", "rev-parse", "HEAD");
    git("switch to base", "switch", "main");
    write("shared.txt", "incompatible base change\n");
    git("advance base", "commit", "-am", "New base");
    const base = git("base head", "rev-parse", "HEAD");

    git("switch to PR", "switch", "feature");
    git(
      "resolve conflict by keeping the PR content",
      "merge",
      "-s",
      "ours",
      "--no-edit",
      "main",
    );
    const resolved = git("resolved merge head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, resolved, base)).toBe(false);

    git("create unrelated branch", "switch", "-c", "unrelated", "main~");
    write("unrelated.txt", "clean unrelated change\n");
    git("stage unrelated change", "add", "unrelated.txt");
    git("commit unrelated change", "commit", "-m", "Unrelated");
    git(
      "create PR branch before base merge",
      "switch",
      "-c",
      "other-feature",
      verified,
    );
    git("merge unrelated branch", "merge", "--no-edit", "unrelated");
    const unrelated = git("unrelated merge head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, unrelated, base)).toBe(false);
  });
});

test("refuses a clean merge when the base absorbed part of the reviewed change", async () => {
  await inRepo(async (git, write, cwd) => {
    git("create PR branch", "switch", "-c", "feature");
    write("one.txt", "shared addition\n");
    write("two.txt", "PR-only addition\n");
    git("stage additions", "add", ".");
    git("commit the reviewed change", "commit", "-m", "Feature");
    const verified = git("verified head", "rev-parse", "HEAD");

    git("return to base", "switch", "main");
    write("one.txt", "shared addition\n");
    git("stage shared addition", "add", "one.txt");
    git("advance base", "commit", "-m", "Independent addition");
    const base = git("base head", "rev-parse", "HEAD");

    git("return to PR", "switch", "feature");
    git("merge base cleanly", "merge", "--no-edit", "main");
    const head = git("merged head", "rev-parse", "HEAD");
    expect(await proveBaseMerge(cwd, verified, head, base)).toBe(false);
  });
});
