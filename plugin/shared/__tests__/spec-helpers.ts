/**
 * Scratch repositories for the spec resolver's tests: a Git repository with
 * an outside folder beside it, so a reference can point out of the root.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync, withoutLeakyGitEnv } from "../guarded-git-spawn.ts";
import type { SpecsConfig } from "../spec/config.ts";

export interface Scratch {
  /** The repository root (real path). */
  root: string;
  /** A folder beside the root, outside it. */
  outside: string;
}

/** The environment a resolver test reads configuration with: no user layer. */
export const NO_USER_LAYER = { JIG_USER_LAYER: "off" };

export function scratchRepo(prefix: string): Scratch {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const root = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const init = spawnSync("git", ["init", "-q"], {
    cwd: root,
    env: withoutLeakyGitEnv(),
  });
  expectSpawnExit({ ...init, exitCode: init.status }, 0, "git init");
  return { root, outside };
}

/** Write `text` at `path` under `dir`, creating its folders. */
export function put(dir: string, path: string, text: string): string {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

/** The configuration that runs exactly `names`, with the default heading. */
export function only(...names: string[]): SpecsConfig {
  return { adapters: names, bodySection: "Spec" };
}
