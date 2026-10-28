import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { gcGit, gitEnvironment } from "../git.ts";
import { worktreeProof } from "../kinds/worktree-proof.ts";

function repository() {
  const root = mkdtempSync(join(tmpdir(), "gc-git-observation-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      env: gitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
  };
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "retained\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  return { root, repo, git };
}

test("read-only status cannot run a configured monitor hook or refresh the index", async () => {
  const f = repository();
  const marker = join(f.root, "hook-ran");
  const hook = writeFakeProgram(
    join(f.root, "monitor"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("token\\0");
`,
  );
  f.git("config", "core.fsmonitor", hook);
  f.git("config", "core.fsmonitorHookVersion", "2");
  writeFileSync(join(f.repo, "tracked.txt"), "retained\n");
  const index = join(f.repo, ".git", "index");
  const before = readFileSync(index);
  await gcGit(f.repo, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(index)).toEqual(before);
});

test("collector ref updates cannot run a hook from the configured hooks path", async () => {
  const f = repository();
  const marker = join(f.root, "hook-ran");
  const hooks = join(f.repo, ".githooks");
  mkdirSync(hooks);
  writeFakeProgram(
    join(hooks, "reference-transaction"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
`,
  );
  f.git("config", "core.hooksPath", ".githooks");
  await gcGit(f.repo, ["update-ref", "refs/jig-gc/probe", "HEAD"]);
  await gcGit(f.repo, ["update-ref", "--no-deref", "-d", "refs/jig-gc/probe"]);
  expect(existsSync(marker)).toBe(false);
});

test("pull request evidence excludes identically named branches in unrelated forks", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const entry = (state: string, owner: string) => ({
    state,
    headRefOid: "a".repeat(40),
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: owner },
  });
  writeFakeProgram(
    join(bin, "gh"),
    `#!/usr/bin/env bun
console.log(JSON.stringify(${JSON.stringify([entry("MERGED", "other"), entry("OPEN", "another"), entry("CLOSED", "Team")])}));
`,
  );
  const source = `import { requests } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await requests(${JSON.stringify(f.repo)}, "origin", "topic")));`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    {
      cwd: f.repo,
      env: {
        ...gitEnvironment(),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toEqual([
    { state: "CLOSED", head: "a".repeat(40) },
  ]);
});

test("submodule settings cannot hide edits or execute a monitor during a report", async () => {
  const f = repository();
  const source = repository();
  f.git(
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    source.repo,
    "child",
  );
  f.git("commit", "-am", "add submodule");
  f.git("config", "submodule.child.ignore", "all");
  const marker = join(f.root, "child-monitor-ran");
  const hook = writeFakeProgram(
    join(f.root, "child-monitor"),
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdout.write("token\\0");
`,
  );
  const child = join(f.repo, "child");
  f.git("-C", child, "config", "core.fsmonitor", hook);
  writeFileSync(join(child, "tracked.txt"), "personal edits\n");
  expect(
    await worktreeProof(f.repo, { remote: "origin", base: "main" }, 7),
  ).toMatchObject({
    state: "live",
    reason: "uncommitted or untracked changes",
  });
  expect(existsSync(marker)).toBe(false);
});

test("a detached worktree is proven by the pull request a drive attached it to", () => {
  const f = repository();
  f.git("remote", "add", "origin", "https://github.com/team/repo.git");
  f.git("checkout", "--quiet", "--detach");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const calls = join(f.root, "gh-calls");
  writeFakeProgram(
    join(bin, "gh"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
console.log(JSON.stringify({ state: "OPEN", headRefOid: "a".repeat(40), headRepository: { name: "repo" }, headRepositoryOwner: { login: "team" } }));
`,
  );
  const proof = (record: boolean) => {
    const source = `import { writeDrivenTree } from ${JSON.stringify(resolve(import.meta.dir, "../../shared/driven-tree.ts"))};
import { worktreeProof } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-proof.ts"))};
if (${record}) writeDrivenTree(${JSON.stringify(join(f.repo, ".git"))}, { pr: 7, branch: "topic", remote: "origin", created: true });
try { console.log(JSON.stringify(await worktreeProof(${JSON.stringify(f.repo)}, { remote: "origin", base: "main" }, 7))); }
catch (error) { console.log(JSON.stringify({ error: String(error) })); }`;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        "-e",
        source,
      ],
      {
        cwd: f.repo,
        env: {
          ...gitEnvironment(),
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    expectSpawnExit(result, 0);
    return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  };
  expect(String(proof(false).error)).toContain("no drive attached");
  expect(proof(true)).toMatchObject({
    state: "live",
    reason: "branch has an open pull request",
  });
  expect(readFileSync(calls, "utf8")).toContain(
    "pr view 7 --repo github.com/team/repo",
  );
});
