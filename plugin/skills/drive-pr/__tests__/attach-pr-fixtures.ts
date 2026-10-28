/**
 * A clone with a remote, a pull request's head branch on it, and a fake `gh`
 * answering for that pull request: what `attach-pr.ts` needs to run for real.
 *
 * Real git throughout (a bare repository at `<root>/example/app.git` stands in
 * for the remote, so its URL names `example/app` as a forge URL would), so the
 * attach's checkouts, fetches and worktree listing are git's own behaviour,
 * not a stub's. Only `gh` is faked: it answers `pr view` from `FAKE_GH_PR`,
 * its head commit read from the remote (`FAKE_GH_REMOTE`) as a forge's is,
 * and `repo view` from `FAKE_GH_REPOS` (a map of directory to `owner/name`,
 * the longest prefix of its working directory winning), else `FAKE_GH_REPO`.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const ATTACH = join(SCRIPTS, "attach-pr.ts");
/** Every spawn here is bounded: a hung child fails the test, not the run. */
const SPAWN_TIMEOUT_MS = 120_000;

const FAKE_GH = `#!/usr/bin/env bun
import { realpathSync } from "node:fs";
const args = process.argv.slice(2);
const field = (name) => args[args.indexOf(name) + 1];
const project = (value) => {
  const q = args.includes("-q") ? field("-q") : args.includes("--jq") ? field("--jq") : null;
  if (q === null) return JSON.stringify(value);
  const picked = value[q.replace(/^\\./, "")];
  return typeof picked === "string" ? picked : JSON.stringify(picked);
};
if (args[0] === "pr" && args[1] === "view") {
  const pr = JSON.parse(process.env.FAKE_GH_PR ?? "null");
  const asked = args[2] && !args[2].startsWith("-") ? args[2] : null;
  if (pr === null || asked === null || String(pr.number) !== asked) {
    console.error("no pull requests found");
    process.exit(1);
  }
  // The head is the remote's, as the forge reports it after every push.
  if (process.env.FAKE_GH_REMOTE) {
    const tip = Bun.spawnSync(
      ["git", "--git-dir", process.env.FAKE_GH_REMOTE, "rev-parse", "refs/heads/" + pr.headRefName],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (tip.exitCode === 0) pr.headRefOid = tip.stdout.toString().trim();
  }
  const wanted = field("--json").split(",");
  console.log(project(Object.fromEntries(wanted.map((k) => [k, pr[k]]))));
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  const cwd = realpathSync(process.cwd());
  const repos = Object.entries(JSON.parse(process.env.FAKE_GH_REPOS ?? "{}"))
    .filter(([dir]) => cwd === dir || cwd.startsWith(dir + "/"))
    .sort((a, b) => b[0].length - a[0].length);
  const slug = repos[0]?.[1] ?? process.env.FAKE_GH_REPO;
  if (slug) {
    console.log(project({ nameWithOwner: slug, url: "https://github.com/" + slug }));
    process.exit(0);
  }
}
console.error("fake gh: unexpected call " + args.join(" "));
process.exit(1);
`;

export interface Ran {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Clone {
  root: string;
  remote: string;
  /** The clone's primary checkout, on `main`. */
  primary: string;
  /** The head commit of the pull request's branch on the remote. */
  head: string;
  env: Record<string, string>;
  git(cwd: string, ...args: string[]): string;
  /** A linked working tree, detached at `main`. */
  tree(name: string): string;
  attach(cwd: string, ...args: string[]): Ran;
  /** Any Bun script, run in `cwd` with the fixture's environment. */
  script(cwd: string, script: string, ...args: string[]): Ran;
  pr(fields: Record<string, unknown>): void;
  /** Commit `file` in `cwd` and return the new commit. */
  commit(cwd: string, file: string): string;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("GIT_") &&
      !k.startsWith("DRIVE_PR_") &&
      k !== "GH_REPO" &&
      k !== "JIG_OVERLAY" &&
      k !== "CLAUDE_PID"
    )
      env[k] = v;
  return env;
}

function spawn(cwd: string, argv: string[], env: Record<string, string>): Ran {
  const r = Bun.spawnSync(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** A clone of a fresh remote whose `feature` branch carries PR #42. */
export function makeClone(): Clone {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "attach-pr-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  const env: Record<string, string> = {
    ...cleanEnv(),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    JIG_HOME: join(root, "home", ".jig"),
    DRIVE_PR_STATE_DIR: join(root, "state"),
    GH_CALL_TIMEOUT: "60",
    FAKE_GH_REMOTE: join(root, "example", "app.git"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "probe",
    GIT_AUTHOR_EMAIL: "probe@example.invalid",
    GIT_COMMITTER_NAME: "probe",
    GIT_COMMITTER_EMAIL: "probe@example.invalid",
  };
  mkdirSync(env.JIG_HOME as string, { recursive: true });
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawn(cwd, ["git", "-c", "commit.gpgsign=false", ...args], env);
    expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    return r.stdout.trim();
  };
  const remote = join(root, "example", "app.git");
  mkdirSync(join(root, "example"));
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const primary = join(root, "clone");
  git(root, "clone", "-q", remote, primary);
  git(primary, "config", "core.hooksPath", join(root, "no-hooks"));
  // A drive writes its handoff under .context/, which a repository ignores.
  writeFileSync(join(primary, ".git", "info", "exclude"), ".context/\n");
  const commit = (cwd: string, file: string): string => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  commit(primary, "seed.txt");
  git(primary, "push", "-q", "origin", "HEAD:main");
  git(primary, "switch", "-q", "-c", "feature");
  const head = commit(primary, "feature.txt");
  git(primary, "push", "-q", "origin", "feature");
  git(primary, "switch", "-q", "main");
  git(primary, "branch", "-q", "-D", "feature");
  // As `drive.ts` exports it: the clone's resolved state leaf and its identity.
  const stateDir = scopedStateDir(join(root, "state"), primary);
  env.DRIVE_PR_STATE_DIR = stateDir;
  env.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentityToken(stateDir);
  const clone: Clone = {
    root,
    remote,
    primary,
    head,
    env,
    git,
    commit,
    tree(name) {
      const path = join(root, name);
      git(primary, "worktree", "add", "-q", "--detach", path, "main");
      return realpathSync(path);
    },
    attach(cwd, ...args) {
      return spawn(cwd, [process.execPath, ATTACH, ...args], env);
    },
    script(cwd, script, ...args) {
      return spawn(
        cwd,
        [process.execPath, join(SCRIPTS, script), ...args],
        env,
      );
    },
    pr(fields) {
      env.FAKE_GH_PR = JSON.stringify({
        number: 42,
        state: "OPEN",
        headRefName: "feature",
        headRefOid: head,
        isCrossRepository: false,
        headRepository: { name: "app" },
        headRepositoryOwner: { login: "example" },
        ...fields,
      });
    },
  };
  clone.pr({});
  return clone;
}

/** The drive state of PR #42 as the clone at `cwd` reads it. */
export function driveState(clone: Clone, cwd: string): Record<string, unknown> {
  const r = clone.script(cwd, "drive-state.ts", "get", "42");
  expectSpawnExit(r, 0, "drive-state.ts get 42");
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** The branch `tree` has checked out, or '' on a detached head. */
export function branchOf(clone: Clone, tree: string): string {
  const r = spawn(
    tree,
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    clone.env,
  );
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

/** Plant a live driver's claim on the lock `name` in the clone's state. */
export function plantLiveLock(clone: Clone, name: string): void {
  const lock = join(clone.env.DRIVE_PR_STATE_DIR as string, name);
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "claim.live0001"),
    `${process.pid} ${hostname()} ${process.platform}\n`,
  );
}

/** The worktree lock's name for `tree`, as `drive.ts` there computes it. */
export function worktreeLock(clone: Clone, tree: string): string {
  const store = join(SCRIPTS, "lib", "state", "store.ts");
  const r = spawn(
    tree,
    [
      process.execPath,
      "-e",
      `import { worktreeLockName } from ${JSON.stringify(store)}; console.log(await worktreeLockName());`,
    ],
    clone.env,
  );
  expectSpawnExit(r, 0, "worktreeLockName");
  return r.stdout.trim();
}
