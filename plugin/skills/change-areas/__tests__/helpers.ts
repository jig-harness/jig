/**
 * Shared pieces of the change-areas tests: the fixture catalog, one
 * resolution of it, a fake git, and scratch repositories the scripts run in
 * as a consumer would, spawned with an explicit working directory and
 * environment.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { type Catalog, loadCatalog } from "../scripts/lib/catalog.ts";
import type { ResolutionContext } from "../scripts/lib/emit.ts";
import {
  applyImpliedClosure,
  type GitRunner,
  matchSeedAreas,
} from "../scripts/lib/resolve.ts";

export const FIXTURE = join(import.meta.dir, "fixtures", "catalog.yaml");
const SCRIPTS = join(import.meta.dir, "..", "scripts");

export const fixture = (): Catalog => loadCatalog(FIXTURE);

/** The resolution of `files` against `catalog` (the fixture by default). */
export function resolution(
  files: string[],
  catalog: Catalog = fixture(),
): ResolutionContext {
  const seed = matchSeedAreas(files, catalog);
  return {
    changedFiles: files,
    seed,
    resolved: applyImpliedClosure(seed, catalog),
    catalog,
  };
}

/**
 * A git that answers from `responses` (`<args joined by spaces>` to stdout)
 * and records every call; an unlisted command prints nothing, as an empty
 * diff does.
 */
export function fakeGit(responses: Record<string, string>): {
  git: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const git: GitRunner = (args) => {
    const key = args.join(" ");
    calls.push(key);
    return responses[key] ?? "";
  };
  return { git, calls };
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the file's tests. */
export function temporary(prefix = "change-areas-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * This process's environment without what points git, Jig or a CI event
 * elsewhere, plus `extra`.
 */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG__") &&
      !key.startsWith("GITHUB_") &&
      key !== "JIG_OVERLAY" &&
      key !== "JIG_CONSUMER_ROOT"
    )
      env[key] = value;
  return {
    ...env,
    GIT_AUTHOR_NAME: "Alex Author",
    GIT_AUTHOR_EMAIL: "alex@example.com",
    GIT_COMMITTER_NAME: "Alex Author",
    GIT_COMMITTER_EMAIL: "alex@example.com",
    ...extra,
  };
}

export function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { env: cleanEnv() });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A git repository on `main` holding `files`, committed. */
export function repository(files: Record<string, string>): string {
  const root = temporary();
  git(root, "init", "-q", "-b", "main");
  commit(root, files, "base");
  return root;
}

/** Write `files` into `root` and commit them. */
export function commit(
  root: string,
  files: Record<string, string>,
  message: string,
): void {
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

/** Run one of the skill's scripts with `root` as its working directory. */
export function run(
  root: string,
  script: "resolve.ts" | "check.ts",
  args: string[],
  { input, env = {} }: { input?: string; env?: Record<string, string> } = {},
) {
  const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: root,
    env: cleanEnv(env),
    input,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
