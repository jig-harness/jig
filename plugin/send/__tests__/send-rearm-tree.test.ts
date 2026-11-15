import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { pullDoc } from "../../ask/__tests__/ask-fixtures.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import { recordResult, writeRecord } from "../../dispatch/lib/launches.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import {
  CLONE_ID_FILE,
  cloneKey,
} from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import {
  ledgerOn,
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

let current: SendWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});
const ADDRESS = `drive@${REPO}#12`;
function world() {
  current = sendWorld();
  pullRequest(current, 12, [], [ledgerOn(701, stoppedLedger(12, 12))]);
  current.api(
    `repos/${REPO}/pulls/12`,
    pullDoc(12, { head: { sha: "a".repeat(40), ref: "topic" } }),
  );
  return current;
}
function git(cwd: string, ...args: string[]) {
  expectSpawnExit(
    Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }),
    0,
  );
}
function branchTree(w: SendWorld, name: string) {
  git(
    w.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const tree = join(w.root, name);
  git(w.repo, "worktree", "add", "-b", "topic", tree);
  return tree;
}
function pickup(w: SendWorld, path: string) {
  const id = "20261105T100000Z-abcdef12";
  writeRecord(
    {
      version: 1,
      id,
      token: "token",
      action: "pickup",
      repo: REPO,
      repoPath: w.repo,
      pr: null,
      item: "#14",
      account: "a",
      vendor: "claude",
      configDir: w.root,
      wallBackoffMs: 1,
      replaces: null,
      facts: "",
      createdAt: "2026-11-05T10:00:00Z",
      workspace: { id: "ws", path },
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: true,
      command: null,
      marker: null,
    },
    w.state,
  );
  recordResult(id, "done", w.state, { address: ADDRESS });
}

/** A second clone of the repository on a branch with no pickup result, listed by the machine's dispatch configuration. */
function otherCloneOnTopic(w: SendWorld): string {
  const clone = join(w.root, "other-clone");
  mkdirSync(clone);
  git(clone, "init", "-q");
  git(clone, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  git(
    clone,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  git(clone, "switch", "-c", "topic");
  const jigHome = join(w.home, ".jig");
  mkdirSync(jigHome, { recursive: true });
  writeFileSync(
    join(jigHome, "dispatch.yaml"),
    JSON.stringify({
      repositories: [{ path: clone, stages: ["rearm"] }],
      accounts: [],
    }),
  );
  return clone;
}

function ledgerForTree(w: SendWorld, path: string) {
  const ledger = stoppedLedger(12, 12, {
    driver: {
      actor: `wt-${worktreePathKey(path)}`,
      clone: cloneId(cloneKey(join(w.repo, ".git"))),
      heartbeat: "2026-10-30T22:00:00.000Z",
      state: "stopped",
      exit: 12,
    },
  });
  w.api(
    `repos/${REPO}/pulls/12`,
    pullDoc(12, { head: { sha: "a".repeat(40), ref: "topic" } }),
  );
  w.api(`repos/${REPO}/issues/12/comments`, [ledgerOn(702, ledger)]);
}

describe("rearm's existing tree discovery", () => {
  it("finds the pickup result's tree without any drive launch or listing", async () => {
    const w = world();
    pickup(w, w.tree);
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(w.tree);
    expect(w.writes()).toEqual([]);
  });
  it("finds the pull request branch through git, deduplicating a pickup naming the same tree", async () => {
    const w = world();
    const tree = branchTree(w, "topic tree");
    pickup(w, tree);
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(tree);
  });
  it("finds a branch with no pickup result", async () => {
    const w = world();
    const tree = branchTree(w, "branch-only");
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(tree);
  });
  it("finds the branch in another clone listed by the machine", async () => {
    const w = world();
    const clone = otherCloneOnTopic(w);
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(clone);
  });
});

describe("rearm tree search identity", () => {
  it("scrubs inherited Git identity before enumerating the named clone", async () => {
    const w = world();
    const tree = branchTree(w, "actual-tree");
    const other = join(w.root, "other-repository");
    mkdirSync(other);
    git(other, "init", "-q");
    git(
      other,
      "remote",
      "add",
      "origin",
      "https://github.com/example-org/other.git",
    );
    w.env.GIT_DIR = join(other, ".git");
    w.env.GIT_COMMON_DIR = join(other, ".git");
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(tree);
  });
  it("refuses uniqueness when a configured clone's repository identity cannot be read", async () => {
    const w = world();
    branchTree(w, "known-tree");
    const unreadable = join(w.root, "unreadable-clone");
    mkdirSync(unreadable);
    const jigHome = join(w.home, ".jig");
    mkdirSync(jigHome, { recursive: true });
    writeFileSync(
      join(jigHome, "dispatch.yaml"),
      JSON.stringify({
        repositories: [{ path: unreadable, stages: ["rearm"] }],
        accounts: [],
      }),
    );
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(unreadable);
    expect(r.stderr).toContain("repository identity");
    expect(w.writes()).toEqual([]);
  });
  it("refuses selection when the forge does not provide a pull request head branch", async () => {
    const w = world();
    branchTree(w, "known-tree");
    w.api(
      `repos/${REPO}/pulls/12`,
      pullDoc(12, { head: { sha: "a".repeat(40), ref: undefined } }),
    );
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("head branch");
    expect(w.writes()).toEqual([]);
  });
  it("refuses a branch tree from another clone when it is not the stopped driver's tree", async () => {
    const w = world();
    ledgerForTree(w, w.repo);
    otherCloneOnTopic(w);
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("no existing worktree");
    expect(w.writes()).toEqual([]);
  });
});

describe("rearm tree search refusals and stale records", () => {
  it("does not trust a unique pickup when git worktree enumeration fails", async () => {
    const w = world();
    pickup(w, w.tree);
    const bin = join(w.root, "git-bin");
    mkdirSync(bin);
    const realGit = Bun.which("git");
    writeFakeProgram(
      join(bin, "git"),
      `#!/usr/bin/env bun\nconst args = process.argv.slice(2); if (args.includes("worktree")) { process.stderr.write("unreadable clone"); process.exit(1); } const r = Bun.spawnSync([${JSON.stringify(realGit)}, ...args]); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.exitCode);\n`,
    );
    w.env.PATH = `${bin}${delimiter}${w.env.PATH}`;
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("unreadable clone");
    expect(w.writes()).toEqual([]);
  });
  it("falls back when the drive listing's tree was removed", async () => {
    const w = world();
    w.stoppedDriver(12);
    rmSync(w.tree, { recursive: true });
    const tree = branchTree(w, "replacement-existing");
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(tree);
  });
  it("skips a listed tree that is not the stopped driver's own", async () => {
    const w = world();
    w.stoppedDriver(12);
    const tree = branchTree(w, "ledger-tree");
    ledgerForTree(w, tree);
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(tree);
    expect(r.stdout).not.toContain(w.tree);
  });
  it("refuses, rather than failing as a usage error, when a clone identity file is corrupt", async () => {
    const w = world();
    const tree = branchTree(w, "corrupt-id");
    ledgerForTree(w, tree);
    writeFileSync(join(w.repo, ".git", CLONE_ID_FILE), "not a uuid\n");
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("clone identity");
    expect(w.writes()).toEqual([]);
  });
  it("refuses and names two worktrees holding the branch", async () => {
    const w = world();
    const first = branchTree(w, "first");
    const second = join(w.root, "second");
    git(w.repo, "worktree", "add", "--force", second, "topic");
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(first);
    expect(r.stderr).toContain(second);
    expect(w.writes()).toEqual([]);
  });
  it("ignores a missing pickup workspace and explains all searched sources", async () => {
    const w = world();
    const missing = join(w.root, "missing");
    mkdirSync(missing);
    pickup(w, missing);
    rmSync(missing, { recursive: true });
    const r = await w.send([ADDRESS, "rearm", "--dry-run"]);
    expectSpawnExit(r, 1);
    for (const source of [
      "drive listing",
      "drive launch",
      "pickup",
      "git worktree",
    ])
      expect(r.stderr).toContain(source);
  });
});
