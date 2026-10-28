/**
 * A clone with a remote, a pull request's head branch on it, and a fake `gh`
 * answering for that pull request: what `attach-pr.ts` needs to run for real.
 *
 * Real git throughout (a bare repository stands in for the remote), so the
 * attach's checkouts, fetches and worktree listing are git's own behaviour,
 * not a stub's. Only `gh` is faked: it answers `pr view` and `repo view` from
 * the `FAKE_GH_PR` and `FAKE_GH_REPO` variables.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");
const ATTACH = join(SCRIPTS, "attach-pr.ts");

const FAKE_GH = `#!/usr/bin/env bun
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
  const wanted = field("--json").split(",");
  console.log(project(Object.fromEntries(wanted.map((k) => [k, pr[k]]))));
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view" && process.env.FAKE_GH_REPO) {
  console.log(project({ nameWithOwner: process.env.FAKE_GH_REPO }));
  process.exit(0);
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
  pr(fields: Record<string, unknown>): void;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("GIT_") &&
      !k.startsWith("DRIVE_PR_") &&
      k !== "GH_REPO" &&
      k !== "JIG_OVERLAY"
    )
      env[k] = v;
  return env;
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
    DRIVE_PR_STATE_DIR: join(root, "state"),
    GH_CALL_TIMEOUT: "60",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "probe",
    GIT_AUTHOR_EMAIL: "probe@example.invalid",
    GIT_COMMITTER_NAME: "probe",
    GIT_COMMITTER_EMAIL: "probe@example.invalid",
  };
  mkdirSync(env.HOME as string);
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    return r.stdout.toString().trim();
  };
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const primary = join(root, "clone");
  git(root, "clone", "-q", remote, primary);
  git(primary, "config", "core.hooksPath", join(root, "no-hooks"));
  // A drive writes its handoff under .context/, which a repository ignores.
  writeFileSync(join(primary, ".git", "info", "exclude"), ".context/\n");
  writeFileSync(join(primary, "seed.txt"), "seed\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "seed");
  git(primary, "push", "-q", "origin", "HEAD:main");
  git(primary, "switch", "-q", "-c", "feature");
  writeFileSync(join(primary, "feature.txt"), "feature\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "feature");
  git(primary, "push", "-q", "origin", "feature");
  const head = git(primary, "rev-parse", "HEAD");
  git(primary, "switch", "-q", "main");
  git(primary, "branch", "-q", "-D", "feature");
  const clone: Clone = {
    root,
    remote,
    primary,
    head,
    env,
    git,
    tree(name) {
      const path = join(root, name);
      git(primary, "worktree", "add", "-q", "--detach", path, "main");
      return realpathSync(path);
    },
    attach(cwd, ...args) {
      const r = Bun.spawnSync([process.execPath, ATTACH, ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      };
    },
    pr(fields) {
      env.FAKE_GH_PR = JSON.stringify({
        number: 42,
        state: "OPEN",
        headRefName: "feature",
        headRefOid: head,
        isCrossRepository: false,
        ...fields,
      });
    },
  };
  clone.pr({});
  return clone;
}

/** The drive state of PR #42 as the clone at `cwd` reads it. */
export function driveState(clone: Clone, cwd: string): Record<string, unknown> {
  const r = Bun.spawnSync(
    [process.execPath, join(SCRIPTS, "drive-state.ts"), "get", "42"],
    { cwd, env: clone.env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(r, 0, "drive-state.ts get 42");
  return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
}
