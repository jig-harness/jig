/**
 * Scratch repositories for the spec resolver's tests: a Git repository with
 * an outside folder beside it, so a reference can point out of the root.
 * Each is removed once the test file has run, whether its tests passed or not.
 */
import { afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync, withoutLeakyGitEnv } from "../guarded-git-spawn.ts";
import type {
  AdapterRead,
  SpecAdapter,
  SpecReference,
} from "../spec/adapter.ts";
import type { SpecsConfig } from "../spec/config.ts";

export interface Scratch {
  /** The repository root (real path). */
  root: string;
  /** A folder beside the root, outside it. */
  outside: string;
}

/** The environment a resolver test reads configuration with: no user layer. */
export const NO_USER_LAYER = { JIG_USER_LAYER: "off" };

const created: string[] = [];

afterAll(() => {
  for (const base of created.splice(0))
    rmSync(base, { recursive: true, force: true });
});

export function scratchRepo(prefix: string): Scratch {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(base);
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

/** An issue as `get_issue.ts` prints a found one, with `description` as its body. */
export const issue = (description: string) => ({ found: true, description });

/**
 * A layout adapter for the tests: claims `<folder>/*.md` and
 * `<folder>/*\/`, reads each line `ID text` of a file (or of every file in a
 * folder) as a requirement (`FR-`) or a criterion (anything else).
 */
export function stub(
  name: string,
  folder: string,
  reads: SpecReference[] = [],
  present = true,
): SpecAdapter {
  return {
    name,
    patterns: [`${folder}/*.md`, `${folder}/*/`],
    detect: () => Promise.resolve(present),
    async read(ref, signal) {
      reads.push(ref);
      if (ref.kind !== "file") throw new TypeError("files only");
      if (ref.ref.includes("broken")) throw new TypeError("unparseable");
      let text = "";
      for (const file of await ref.files.list(signal))
        text += await ref.files.read(file, signal);
      const out: AdapterRead = { requirements: [], acceptance: [], tasks: [] };
      for (const line of text.split("\n").filter(Boolean)) {
        const [id = "", ...rest] = line.split(" ");
        const req = /FR-\d+/.exec(rest.join(" "))?.[0] ?? null;
        if (id.startsWith("FR-"))
          out.requirements.push({ id, text: rest.join(" ") });
        else
          out.acceptance.push({ id, text: rest.join(" "), requirement: req });
      }
      return out;
    },
  };
}

/** The configuration that runs exactly `names`, with the default heading. */
export function only(...names: string[]): SpecsConfig {
  return { adapters: names, bodySection: "Spec" };
}
