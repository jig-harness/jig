/**
 * The worktrees kind on a worktree Claude Code's agent tool made under the
 * clone's `.claude/worktrees`: found though no declared root holds it,
 * collected with git once every proof passes, and kept, with the branch it
 * holds named, while its pull request is open or it holds work no remote has.
 *
 * The forge repository is derived from the remote URL, so the fixture remote
 * is `fakeforge:acme/app.git`, served from a local bare clone through an SSH
 * command the repository configures; `gh` is a fake answering the pull
 * request the test sets, and `lsof` a fake reporting no process holding the
 * worktree, so the proof does not depend on what else the machine has mounted.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { gitEnvironment } from "../git.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt, ReceiptLine } from "../types.ts";

const script = resolve(import.meta.dir, "../../jig.ts");
const REMOTE = "fakeforge:acme/app.git";
const DAY_MS = 86_400_000;

function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gc-agent-")));
  const repo = join(root, "repo");
  const user = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, user, bin, join(root, "forge", "acme")])
    mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    HOME: user,
    USERPROFILE: user,
    JIG_HOME: join(user, ".jig"),
    JIG_USER_LAYER: undefined,
    JIG_CONSUMER_ROOT: undefined,
    JIG_GC_HEAVY_LOCK: undefined,
    RESOURCE_LOCK_BYPASS: "1",
    ORCA_CLI_COMMAND: undefined,
    ORCA_CLI_BIN_DIR: undefined,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const command = (args: string[], cwd = repo): string => {
    const result = Bun.spawnSync(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
    return result.stdout.toString().trim();
  };
  // The fixture remote: SSH to `fakeforge` runs the command in the forge.
  const ssh = join(bin, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncd ${JSON.stringify(join(root, "forge"))} && exec sh -c "$last"\n`,
  );
  chmodSync(ssh, 0o755);
  command(["git", "init", "--bare", join(root, "forge", "acme", "app.git")]);
  command(["git", "init", "--initial-branch=main"]);
  command(["git", "config", "user.email", "test@example.invalid"]);
  command(["git", "config", "user.name", "Test"]);
  command(["git", "config", "core.sshCommand", ssh]);
  // A declared root that does not hold the agent tool's worktrees.
  const declaration = {
    kinds: ["worktrees"],
    worktree_roots: [join(root, "worktrees")],
    scratch_prefixes: [],
  };
  mkdirSync(join(repo, ".config", "worktree-hooks"), { recursive: true });
  writeFileSync(join(repo, ".config/jig.yaml"), dump({ gc: declaration }));
  writeFileSync(join(repo, ".gitignore"), ".claude/\n");
  writeFileSync(
    join(repo, ".config/worktree-hooks/remove"),
    `#!/bin/sh\necho "removing $(pwd)" > ${JSON.stringify(join(root, "hook-ran"))}\nexit 0\n`,
  );
  chmodSync(join(repo, ".config/worktree-hooks/remove"), 0o755);
  command(["git", "add", "."]);
  command(["git", "commit", "-m", "fixture"]);
  command(["git", "remote", "add", "origin", REMOTE]);
  command(["git", "push", "origin", "main"]);
  command(["git", "fetch", "origin"]);
  command([
    "git",
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const tree = join(repo, ".claude", "worktrees", "agent-a1");
  command(["git", "worktree", "add", "-b", "topic", tree]);
  writeFileSync(join(tree, "change.txt"), "the subagent's change\n");
  command(["git", "add", "change.txt"], tree);
  command(["git", "commit", "-m", "change"], tree);
  command(["git", "push", "origin", "topic"], tree);
  /** The fake `gh`, answering a pull request in `state` at the tree's current head. */
  const forge = (state: "MERGED" | "OPEN"): void => {
    const head = command(["git", "-C", tree, "rev-parse", "HEAD"]);
    writeFakeProgram(
      join(bin, "gh"),
      `#!/usr/bin/env bun
console.log(JSON.stringify([{ state: ${JSON.stringify(state)}, headRefOid: ${JSON.stringify(head)}, headRepository: { name: "app" }, headRepositoryOwner: { login: "acme" } }]));
`,
    );
  };
  forge("MERGED");
  writeFakeProgram(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
  const machine = {
    repositories: [
      {
        path: repo,
        remote: "origin",
        remote_url: REMOTE,
        base_branch: "main",
        bounds: declaration,
      },
    ],
  };
  mkdirSync(join(user, ".jig"));
  writeFileSync(join(user, ".jig", "jig.yaml"), dump({ gc: machine }));
  const state = join(user, ".local", "state", "jig", "gc");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "marking-since"),
    `${new Date(Date.now() - 30 * DAY_MS).toISOString()}\n`,
  );
  return { root, repo, tree, env, command, forge };
}

/** Every entry of the worktree and its git directory, eight days old. */
function idle(f: ReturnType<typeof setup>): void {
  const then = new Date(Date.now() - 8 * DAY_MS);
  const age = (path: string): void => {
    if (lstatSync(path).isDirectory())
      for (const entry of readdirSync(path)) age(join(path, entry));
    if (!lstatSync(path).isSymbolicLink()) utimesSync(path, then, then);
  };
  age(f.tree);
  age(join(f.repo, ".git", "worktrees", "agent-a1"));
}

function gc(f: ReturnType<typeof setup>, args: string[]) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(script), "gc", "bunfig.toml")}`,
      script,
      "gc",
      "--repo",
      f.repo,
      "--kind",
      "worktrees",
      "--json",
      ...args,
    ],
    {
      cwd: f.repo,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
}

function line(result: ReturnType<typeof gc>): ReceiptLine {
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources).toHaveLength(1);
  return receipt.resources[0] as ReceiptLine;
}

describe.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote is served through a shell script as the SSH command, and the remove hook is one",
  ),
)("worktrees the agent tool made", () => {
  test("a clean one whose pull request merged is found outside the declared roots and collected with git", () => {
    const f = setup();
    idle(f);
    expect(line(gc(f, []))).toMatchObject({
      resource: f.tree,
      outcome: "would-collect",
      reason: expect.stringContaining("an agent tool's worktree"),
      details: { runtime: "agent-tool" },
    });
    const collected = line(gc(f, ["--collect"]));
    expect(collected).toMatchObject({
      outcome: "collected",
      reason: expect.stringContaining(
        "ran .config/worktree-hooks/remove, parked reflection findings, git worktree remove",
      ),
      proof: expect.stringContaining("pull request merged"),
      details: { runtime: "agent-tool", parked: true },
    });
    expect(readFileSync(join(f.root, "hook-ran"), "utf8")).toContain(f.tree);
    expect(existsSync(f.tree)).toBe(false);
    expect(f.command(["git", "worktree", "list"])).not.toContain("agent-a1");
  }, 60_000);

  test("one holding an open pull request's branch is kept, naming the branch and how to release it", () => {
    const f = setup();
    f.forge("OPEN");
    idle(f);
    const kept = line(gc(f, ["--collect"]));
    expect(kept.outcome).toBe("refused");
    expect(kept.reason).toContain("branch has an open pull request");
    expect(kept.reason).toContain(
      `it holds branch topic; \`git -C ${f.tree} switch --detach\``,
    );
    expect(existsSync(join(f.tree, "change.txt"))).toBe(true);
  }, 60_000);

  test("one with uncommitted changes or a commit no remote holds is never touched", () => {
    const dirty = setup();
    writeFileSync(join(dirty.tree, "draft.txt"), "unsaved\n");
    idle(dirty);
    const keptDirty = line(gc(dirty, ["--collect"]));
    expect(keptDirty.outcome).toBe("refused");
    expect(keptDirty.reason).toContain("uncommitted or untracked changes");
    expect(readFileSync(join(dirty.tree, "draft.txt"), "utf8")).toBe(
      "unsaved\n",
    );

    const ahead = setup();
    writeFileSync(join(ahead.tree, "more.txt"), "after the merge\n");
    ahead.command(["git", "add", "more.txt"], ahead.tree);
    ahead.command(["git", "commit", "-m", "more"], ahead.tree);
    idle(ahead);
    const keptAhead = line(gc(ahead, ["--collect"]));
    expect(keptAhead.outcome).toBe("refused");
    expect(keptAhead.reason).toContain(
      "commits are outside remote branches and merged pull request heads",
    );
    expect(existsSync(join(ahead.tree, "more.txt"))).toBe(true);
  }, 120_000);

  test("one the idle guard has not passed is kept", () => {
    const f = setup();
    const kept = line(gc(f, ["--collect"]));
    expect(kept.outcome).toBe("refused");
    expect(kept.reason).toContain("idle guard has not elapsed");
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);
});
