#!/usr/bin/env bun
/**
 * Refresh the package roots whose dependency inputs changed in a base merge.
 * Compare the resolved index to the topic's HEAD before committing a
 * conflict resolution, or the clean merge to its first parent after commit.
 * Print one JSON report, keeping installer output on stderr.
 */
import { join, posix } from "node:path";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readPolicySnapshot } from "../../../shared/autonomy.ts";
import { isMapping } from "../../../shared/config-layers.ts";
import { consumerRoot, layeredConfig } from "../../../shared/consumer.ts";
import { detectPackageManager } from "../../../shared/detect/package-manager.ts";
import { JigError } from "../../../shared/errors.ts";
import { DEPENDENCY_INSTALL_TIMEOUT_SECONDS } from "../../../shared/repo-commands.ts";
import { LOCKFILES } from "../../resolve-conflicts/scripts/lib/classify.ts";
import { shellArgv } from "./lib/overlay.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv, run } from "./lib/proc.ts";

const JS_MANIFESTS = ["package.json", "pnpm-workspace.yaml"];

const otherManagers: Readonly<
  Record<
    string,
    {
      install: string;
      manifests: readonly string[];
    }
  >
> = {
  "Cargo.lock": { install: "cargo fetch --locked", manifests: ["Cargo.toml"] },
  "go.sum": {
    install: "go mod tidy -diff",
    manifests: ["go.mod"],
  },
  "uv.lock": {
    install: "uv sync --locked --all-packages",
    manifests: ["pyproject.toml"],
  },
  "poetry.lock": {
    install: "poetry install --sync",
    manifests: ["pyproject.toml"],
  },
  "Gemfile.lock": { install: "bundle install", manifests: ["Gemfile"] },
  "composer.lock": {
    install:
      "composer validate --check-lock --no-check-publish && composer install --no-interaction",
    manifests: ["composer.json"],
  },
};

type Install = { command: string; cwd: string; exitCode: number };
type Candidate = {
  lockfile: string;
  command: string;
  manifests: readonly string[];
  env?: Record<string, string>;
  matchesLockfile(name: string): boolean;
};
export type DependencyInstallReport =
  | { outcome: "installed" | "skipped"; installs: Install[] }
  | { outcome: "error" | "failed"; installs: Install[]; reason: string };

async function gitOutput(root: string, args: string[]): Promise<string> {
  const result = await git(args, {
    cwd: root,
    env: gitIdentityEnv(),
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (result.code !== 0)
    throw new JigError(
      "git-failed",
      `git ${args[0]} failed: ${result.stderr.trim() || result.code}`,
    );
  return result.stdout;
}

function pathList(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

function knownLockfile(name: string): boolean {
  return Object.hasOwn(LOCKFILES, name);
}

function dependenciesName(name: string): boolean {
  return (
    knownLockfile(name) ||
    JS_MANIFESTS.includes(name) ||
    Object.values(otherManagers).some(({ manifests }) =>
      manifests.includes(name),
    )
  );
}

async function changePaths(
  root: string,
  before: string | undefined,
): Promise<string[]> {
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  if (before === undefined) {
    await gitOutput(root, ["rev-parse", "--verify", "MERGE_HEAD"]);
    const unresolved = await gitOutput(root, [
      ...diff,
      "--cached",
      "--diff-filter=U",
      "--",
    ]);
    if (unresolved !== "")
      throw new JigError("git-failed", "the merge index still has conflicts");
    return pathList(await gitOutput(root, [...diff, "--cached", "HEAD", "--"]));
  }
  const firstParent = (
    await gitOutput(root, ["rev-parse", "--verify", "HEAD^1"])
  ).trim();
  if (before !== "HEAD^1" && before !== firstParent)
    throw new JigError(
      "git-failed",
      "--before must name the current merge commit's first parent",
    );
  await gitOutput(root, ["rev-parse", "--verify", "HEAD^2"]);
  if (await gitOutput(root, [...diff, "--cached", "HEAD", "--"]))
    throw new JigError(
      "git-failed",
      "the index differs from the concluded merge",
    );
  return pathList(await gitOutput(root, [...diff, firstParent, "HEAD", "--"]));
}

function installConfig(root: string): Record<string, unknown> {
  const snapshot = readPolicySnapshot(process.env, root);
  if (snapshot.from === "unreadable")
    throw new JigError(
      "config-invalid",
      `drive.dependency_install configuration cannot be read: ${snapshot.reason}`,
    );
  return snapshot.from === "base"
    ? (snapshot.bound ?? snapshot).values
    : layeredConfig(root).values;
}

function overrideCommands(root: string): Map<string, string> {
  const config = installConfig(root);
  const drive = config.drive;
  if (drive == null) return new Map();
  if (!isMapping(drive))
    throw new JigError("config-invalid", "drive must be a mapping");
  const value = drive.dependency_install;
  if (value == null) return new Map();
  if (!isMapping(value))
    throw new JigError(
      "config-invalid",
      "drive.dependency_install must map lockfile names to commands",
    );

  const commands = new Map<string, string>();
  for (const [lockfile, command] of Object.entries(value)) {
    if (
      !knownLockfile(lockfile) ||
      typeof command !== "string" ||
      command.trim() === ""
    )
      throw new JigError(
        "config-invalid",
        `drive.dependency_install.${lockfile} must name a recognized lockfile and a nonempty command`,
      );
    commands.set(lockfile, command);
  }
  return commands;
}

function trackedLockfiles(tracked: string[]): Map<string, Set<string>> {
  const locksByDirectory = new Map<string, Set<string>>();
  for (const path of tracked) {
    const name = posix.basename(path);
    if (!knownLockfile(name)) continue;
    const dir = posix.dirname(path);
    const names = locksByDirectory.get(dir) ?? new Set();
    names.add(name);
    locksByDirectory.set(dir, names);
  }

  return locksByDirectory;
}

function managersAt(root: string, names: Set<string>): Candidate[] {
  const candidates: Candidate[] = [];
  const js = detectPackageManager(root, names).found;
  if (js !== null)
    candidates.push({
      lockfile: js.lockfile,
      command: js.install,
      manifests: JS_MANIFESTS,
      matchesLockfile: (name) =>
        knownLockfile(name) && !Object.hasOwn(otherManagers, name),
    });
  for (const name of names) {
    if (!Object.hasOwn(otherManagers, name)) continue;
    const other = otherManagers[name];
    if (other === undefined) continue;
    candidates.push({
      lockfile: name,
      command: other.install,
      manifests: other.manifests,
      ...(name === "Gemfile.lock" ? { env: { BUNDLE_FROZEN: "true" } } : {}),
      matchesLockfile: (changedName) => changedName === name,
    });
  }
  return candidates;
}

function matchingManagers(
  managersIn: (dir: string) => Candidate[],
  path: string,
): { dir: string; candidates: Candidate[] } | null {
  const name = posix.basename(path);
  const isLockfile = knownLockfile(name);
  let dir = posix.dirname(path);
  for (;;) {
    const candidates = managersIn(dir).filter((manager) =>
      isLockfile
        ? manager.matchesLockfile(name)
        : manager.manifests.includes(name),
    );
    if (candidates.length !== 0) return { dir, candidates };
    if (dir === "." || isLockfile) return null;
    dir = posix.dirname(dir);
  }
}

async function installCandidates(
  root: string,
  changed: string[],
): Promise<Map<string, Candidate[]>> {
  const changedInputs = changed.filter((path) =>
    dependenciesName(posix.basename(path)),
  );
  const installs = new Map<string, Candidate[]>();
  if (changedInputs.length === 0) return installs;

  const tracked = pathList(await gitOutput(root, ["ls-files", "-z", "--"]));
  const locks = trackedLockfiles(tracked);
  const available = new Map<string, Candidate[]>();
  const managersIn = (dir: string): Candidate[] => {
    const known = available.get(dir);
    if (known !== undefined) return known;
    const names = locks.get(dir);
    const candidates =
      names === undefined ? [] : managersAt(join(root, dir), names);
    available.set(dir, candidates);
    return candidates;
  };

  // A workspace member's manifest can change without touching its root's
  // lockfile. The nearest applicable lockfile owns the changed input.
  for (const path of changedInputs) {
    const match = matchingManagers(managersIn, path);
    if (match === null) continue;
    const selected = installs.get(match.dir) ?? [];
    installs.set(match.dir, [...new Set([...selected, ...match.candidates])]);
  }
  return installs;
}

async function modifiedDependencyInputs(root: string): Promise<string[]> {
  const result = await gitOutput(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "--",
  ]);
  return pathList(result).filter((path) =>
    dependenciesName(posix.basename(path)),
  );
}

async function workingTreeState(root: string): Promise<string> {
  const entries = pathList(await gitOutput(root, ["ls-files", "-s", "-z"]));
  const contents = entries
    .map((entry) => entry.match(/^(\d+) [0-9a-f]+ 0\t(.*)$/s))
    .filter(
      (match): match is RegExpMatchArray =>
        match !== null && match[1] !== "160000" && match[2] !== undefined,
    )
    .map((match) => {
      const path = match[2];
      if (path === undefined) return "";
      try {
        const stat = lstatSync(join(root, path));
        const content = stat.isSymbolicLink()
          ? readlinkSync(join(root, path))
          : readFileSync(join(root, path));
        return `${path}\0${createHash("sha256").update(content).digest("hex")}`;
      } catch {
        return `${path}\0<missing>`;
      }
    });
  const raw = await gitOutput(root, [
    "diff",
    "--raw",
    "-z",
    "--ignore-submodules=none",
    "--",
  ]);
  const submodules = entries
    .map((entry) => entry.match(/^160000 [0-9a-f]+ 0\t(.*)$/s)?.[1])
    .filter(
      (path): path is string =>
        path !== undefined && existsSync(join(root, path, ".git")),
    )
    .map(
      async (path) => `${path}\0${await workingTreeState(join(root, path))}`,
    );
  return `${raw}\0${contents.join("\0")}\0${(await Promise.all(submodules)).join("")}`;
}

async function untrackedLockfiles(
  root: string,
  jobs: InstallJob[],
): Promise<string[]> {
  const result = await gitOutput(root, [
    "ls-files",
    "--others",
    "-z",
    "--",
    ...new Set(
      jobs.flatMap(({ dir }) =>
        Object.keys(LOCKFILES).map(
          (file) => `:(literal)${posix.join(dir, file)}`,
        ),
      ),
    ),
  ]);
  return pathList(result);
}

async function dependencyInputChanges(
  root: string,
  indexTree: string,
  jobs: InstallJob[],
  untracked: ReadonlySet<string>,
  workingTreeBefore: string,
): Promise<string[]> {
  const staged = pathList(
    await gitOutput(root, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      indexTree,
      "--",
    ]),
  );
  const created = (await untrackedLockfiles(root, jobs)).filter(
    (path) => !untracked.has(path),
  );
  const workingTreeAfter = await workingTreeState(root);
  return [
    ...staged,
    ...(workingTreeAfter === workingTreeBefore ? [] : ["working tree"]),
    ...created,
  ];
}

type InstallJob = {
  lockfile: string;
  command: string;
  dir: string;
  env?: Record<string, string>;
};

function installDirectory(root: string, job: InstallJob): string {
  const cwd = join(root, job.dir);
  if (realpathSync(cwd) !== cwd)
    throw new JigError(
      "git-failed",
      `install directory is a symbolic link: ${job.dir}`,
    );
  if (!lstatSync(join(cwd, job.lockfile)).isFile())
    throw new JigError(
      "git-failed",
      `install lockfile is not a regular file: ${posix.join(job.dir, job.lockfile)}`,
    );
  return cwd;
}

async function runInstall(
  root: string,
  job: InstallJob,
  deadline: number,
  installs: Install[],
): Promise<string | null> {
  const cwd = installDirectory(root, job);
  const timeoutSec = Math.floor((deadline - performance.now()) / 1000);
  if (timeoutSec <= 0)
    return `dependency install deadline expired before ${job.command} in ${job.dir}`;
  const result = await run(shellArgv(job.command), {
    cwd,
    env: { ...gitIdentityEnv(), ...job.env },
    timeoutSec,
  });
  process.stderr.write(result.stdout + result.stderr);
  installs.push({ command: job.command, cwd: job.dir, exitCode: result.code });
  return result.code === 0
    ? null
    : `dependency install failed in ${job.dir} (exit ${result.code})`;
}

function installJobs(
  candidates: Map<string, Candidate[]>,
  overrides: Map<string, string>,
): InstallJob[] {
  return Array.from(candidates).flatMap(([dir, managers]) =>
    managers.map(({ lockfile, command, env }) => ({
      dir,
      lockfile,
      command: overrides.get(lockfile) ?? command,
      ...(env === undefined ? {} : { env }),
    })),
  );
}

async function installAll(
  root: string,
  jobs: InstallJob[],
  installs: Install[],
): Promise<DependencyInstallReport> {
  const dirty = await modifiedDependencyInputs(root);
  if (dirty.length !== 0)
    throw new JigError(
      "git-failed",
      `dependency inputs have unstaged edits: ${dirty.join(", ")}`,
    );

  const indexTree = (await gitOutput(root, ["write-tree"])).trim();
  const untracked = new Set(await untrackedLockfiles(root, jobs));
  const workingTreeBefore = await workingTreeState(root);
  const deadline =
    performance.now() + DEPENDENCY_INSTALL_TIMEOUT_SECONDS * 1000;
  for (const job of jobs) {
    const failure = await runInstall(root, job, deadline, installs);
    const modified = await dependencyInputChanges(
      root,
      indexTree,
      jobs,
      untracked,
      workingTreeBefore,
    );
    if (modified.length !== 0)
      return {
        outcome: "failed",
        installs,
        reason: `${failure ?? "dependency install failed to preserve the merge tree"}. Changed paths: ${modified.join(", ")}`,
      };
    if (failure !== null)
      return { outcome: "failed", installs, reason: failure };
  }
  return { outcome: "installed", installs };
}

export async function installMergedDependencies(
  root: string,
  before?: string,
): Promise<DependencyInstallReport> {
  const installs: Install[] = [];
  try {
    const realRoot = realpathSync(root);
    const candidates = await installCandidates(
      realRoot,
      await changePaths(realRoot, before),
    );
    if (candidates.size === 0) return { outcome: "skipped", installs };
    return await installAll(
      realRoot,
      installJobs(candidates, overrideCommands(realRoot)),
      installs,
    );
  } catch (error) {
    return {
      outcome: "error",
      installs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid =
    args.length === 0 || (args.length === 2 && args[0] === "--before");
  const report: DependencyInstallReport = valid
    ? await installMergedDependencies(
        process.env.DRIVE_PR_WORKTREE || consumerRoot(),
        args[1],
      )
    : {
        outcome: "error",
        installs: [],
        reason: "usage: dependency-install.ts [--before <first-parent>]",
      };
  console.log(JSON.stringify(report));
  if (report.outcome === "failed") process.exitCode = 1;
  if (report.outcome === "error") process.exitCode = 2;
}
