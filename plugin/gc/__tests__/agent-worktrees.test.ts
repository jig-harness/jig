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
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { shellQuote } from "../../shared/cli.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt, ReceiptLine } from "../types.ts";
import { FIXTURE_REMOTE, setupWorktreeFixture } from "./worktree-fixture.ts";

const script = resolve(import.meta.dir, "../../jig.ts");
const REMOTE = FIXTURE_REMOTE;
const DAY_MS = 86_400_000;

/** Every fixture root a test made, removed once the file's tests end. */
const made: string[] = [];
afterAll(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gc-agent-")));
  made.push(root);
  const { repo, user, bin, env, command } = setupWorktreeFixture(root);
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
    // With `commit-during-hook` present, the hook commits in the tree: a
    // subagent's commit landing between the final proof and the removal.
    `#!/bin/sh\necho "removing $(pwd)" > ${JSON.stringify(join(root, "hook-ran"))}\n[ -f ${JSON.stringify(join(root, "commit-during-hook"))} ] && git -c user.email=t@example.invalid -c user.name=T commit -q --allow-empty -m late\nexit 0\n`,
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
  /**
   * The fake `gh`, answering a pull request in `state` at the tree's current
   * head, by branch (`gh pr list`) and by commit (`gh api`, in the REST
   * form); `NONE` answers no pull request either way.
   */
  const forge = (state: "MERGED" | "OPEN" | "NONE"): void => {
    const head = command(["git", "-C", tree, "rev-parse", "HEAD"]);
    const listed =
      state === "NONE"
        ? []
        : [
            {
              state,
              headRefOid: head,
              headRepository: { name: "app" },
              headRepositoryOwner: { login: "acme" },
            },
          ];
    const rest =
      state === "NONE"
        ? []
        : [
            {
              state: state === "OPEN" ? "open" : "closed",
              merged_at: state === "MERGED" ? "2026-11-01T00:00:00Z" : null,
              head: { sha: head },
              number: 7,
            },
          ];
    writeFakeProgram(
      join(bin, "gh"),
      `#!/usr/bin/env bun
const rest = process.argv.includes("api");
console.log(JSON.stringify(rest ? ${JSON.stringify(rest)} : ${JSON.stringify(listed)}));
`,
    );
  };
  forge("MERGED");
  /**
   * The fake `lsof`: it writes `warnings` to standard error, then ends with
   * `end`, by default finding no holder.
   */
  const lsof = (warnings = "", end = "exit 1"): void => {
    writeFakeProgram(
      join(bin, "lsof"),
      `#!/bin/sh\ncat >&2 <<'WARNINGS'\n${warnings}WARNINGS\n${end}\n`,
    );
  };
  lsof();
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
  return { root, repo, tree, env, command, forge, lsof };
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

/** The run's one receipt line; a collection that failed ends the run with exit 1. */
function line(result: ReturnType<typeof gc>, exit = 0): ReceiptLine {
  expectSpawnExit(result, exit);
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

  test("a detached one whose commit a merged pull request brought in is collected, its branch kept", () => {
    const f = setup();
    f.command(["git", "switch", "--detach"], f.tree);
    idle(f);
    const collected = line(gc(f, ["--collect"]));
    expect(collected.outcome).toBe("collected");
    expect(existsSync(f.tree)).toBe(false);
    expect(f.command(["git", "branch", "--list", "topic"])).toContain("topic");
  }, 60_000);

  test("a clean detached one with no pull request and no commit the base lacks is collected", () => {
    const f = setup();
    f.command(["git", "switch", "--detach", "main"], f.tree);
    f.forge("NONE");
    idle(f);
    expect(line(gc(f, []))).toMatchObject({
      outcome: "would-collect",
      reason: expect.stringContaining("holds no commit the base lacks"),
    });
    expect(line(gc(f, ["--collect"])).outcome).toBe("collected");
    expect(existsSync(f.tree)).toBe(false);
  }, 60_000);

  test("a detached one that gains a commit after the final proof is kept", () => {
    const f = setup();
    f.command(["git", "switch", "--detach"], f.tree);
    idle(f);
    writeFileSync(join(f.root, "commit-during-hook"), "");
    const kept = line(gc(f, ["--collect"]), 1);
    expect(kept.outcome).toBe("failed");
    expect(kept.reason).toContain("Worktree identity changed");
    expect(existsSync(f.tree)).toBe(true);
    expect(f.command(["git", "-C", f.tree, "log", "-1", "--format=%s"])).toBe(
      "late",
    );
  }, 60_000);

  test("one holding an open pull request's branch is kept, naming the branch and how to release it", () => {
    const f = setup();
    f.forge("OPEN");
    idle(f);
    const kept = line(gc(f, ["--collect"]));
    expect(kept.outcome).toBe("refused");
    expect(kept.reason).toContain("branch has an open pull request");
    expect(kept.reason).toContain(
      `it holds branch topic; \`git -C ${shellQuote(f.tree)} switch --detach\``,
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

  test("an lsof warning about a mount outside the tree leaves it proven idle; one about the tree's own mount keeps it unverified", () => {
    const f = setup();
    idle(f);
    const warning = (mount: string) =>
      `lsof: WARNING: can't stat() fuse.portal file system ${mount}\n      Output information may be incomplete.\n`;
    f.lsof(
      `${warning("/run/user/1000/doc")}${warning("/run/docker/netns/default")}`,
    );
    expect(line(gc(f, []))).toMatchObject({ outcome: "would-collect" });
    f.lsof(`${warning("/run/user/1000/doc")}${warning(f.root)}`);
    expect(line(gc(f, []))).toMatchObject({
      outcome: "unverified",
      reason: expect.stringContaining(
        "process holders could not be enumerated",
      ),
    });
    // Killed after its warnings, it may not have read a process at all.
    f.lsof(warning("/run/user/1000/doc"), "kill -9 $$");
    expect(line(gc(f, [])).outcome).toBe("unverified");
  }, 60_000);

  test("one the idle guard has not passed is kept", () => {
    const f = setup();
    const kept = line(gc(f, ["--collect"]));
    expect(kept.outcome).toBe("refused");
    expect(kept.reason).toContain("idle guard has not elapsed");
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);
});
