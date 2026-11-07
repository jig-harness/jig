/**
 * Scratch git repositories for the one-pass tests, and the one pass run in
 * them as a child process with the repository as its working directory.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";

const CLI = join(import.meta.dir, "..", "scripts", "docs.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the file's tests. */
export function temporary(prefix = "docs-skill-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * What sends the index generator's output elsewhere: a developer's value would
 * have a test write over that developer's file instead of the scratch tree.
 */
const INDEX_OUTPUT_ENV = ["OUT", "ORPHANS", "DOCS_DIR"];

/**
 * Git configuration passed on the command scope rather than in a file: a
 * developer's `commit.gpgsign` there would fail the scratch commits.
 */
const isCommandScopeConfig = (key: string) =>
  key === "GIT_CONFIG_COUNT" ||
  key === "GIT_CONFIG_PARAMETERS" ||
  key.startsWith("GIT_CONFIG_KEY_") ||
  key.startsWith("GIT_CONFIG_VALUE_");

/**
 * This process's environment without what points git, Jig or the index
 * elsewhere, and with no global, system or command-scope git configuration.
 */
export function cleanEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !isCommandScopeConfig(key.toUpperCase()) &&
      !key.startsWith("JIG__") &&
      key !== "JIG_OVERLAY" &&
      key !== "JIG_CONSUMER_ROOT" &&
      key !== "LAST_UPDATED_TODAY" &&
      !INDEX_OUTPUT_ENV.includes(key) &&
      !key.startsWith("ORPHANS_")
    )
      env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A git repository on `main` holding `files`, committed. */
export function repository(files: Record<string, string>): string {
  const root = temporary();
  git(root, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

/** Run the one pass with `root` as its working directory. */
export function runDocs(
  root: string,
  args: string[] = [],
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

/** A document's frontmatter in the M4 template schema's vocabulary. */
export function doc(
  fields: Record<string, string>,
  body = "# A page\n\nText.\n",
): string {
  const all: Record<string, string> = {
    title: "A page",
    type: "guide",
    status: "active",
    lifecycle: "permanent",
    last_updated: "2026-10-01",
    owner: "engineering",
    tags: "[backend]",
    ...fields,
  };
  const lines = Object.entries(all).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}
