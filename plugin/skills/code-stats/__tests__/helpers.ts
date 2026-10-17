/**
 * Shared pieces of the code-stats tests: a file's facts from its path and
 * first characters, the classification of one path under a configuration,
 * and scratch git repositories the CLI runs in from outside this one.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { classify, type FileFacts } from "../scripts/lib/classify.ts";
import {
  type CodeStatsConfig,
  parseCodeStatsConfig,
} from "../scripts/lib/config.ts";
import { getExtension, shebangLanguage } from "../scripts/lib/languages.ts";
import type { Classification } from "../scripts/lib/model.ts";
import type { ModuleMap } from "../scripts/lib/modules.ts";

const CLI = join(import.meta.dir, "..", "scripts", "code-stats.ts");

/** The facts of a text file at `path` that starts with `head`. */
export function facts(
  path: string,
  head = "",
  attributes?: Record<string, string>,
): FileFacts {
  const filename = path.split("/").pop() ?? "";
  return {
    path,
    filename,
    ext: getExtension(filename),
    attributes: attributes ? new Map(Object.entries(attributes)) : undefined,
    shape: "text",
    head,
    shebang: shebangLanguage(head),
  };
}

export const DEFAULTS: CodeStatsConfig = parseCodeStatsConfig(undefined);

/** Every dimension of `path` under `config` (the defaults when omitted). */
export function classified(
  path: string,
  head = "",
  config: CodeStatsConfig = DEFAULTS,
  modules: ModuleMap = new Map(),
  attributes?: Record<string, string>,
): Classification {
  return classify(facts(path, head, attributes), config, modules, undefined);
}

export const kindOf = (path: string, head = "", config = DEFAULTS) =>
  classified(path, head, config).kind.value;

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the file's tests. */
export function temporary(prefix = "code-stats-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** This process's environment without what points git or Jig elsewhere. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG__") &&
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

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { env: cleanEnv() });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A git repository holding `files`, committed. */
export function repository(files: Record<string, string>): string {
  const root = temporary();
  git(root, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/** Run the CLI with `root` as its working directory. */
export function runCli(
  root: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: cleanEnv(extra),
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
