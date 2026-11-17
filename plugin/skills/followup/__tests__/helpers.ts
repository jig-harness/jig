/**
 * Shared pieces of the follow-up's tests: scratch git repositories the
 * script runs in from outside this one, a run's facts, and the script
 * spawned with a scratch repository as its working directory.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";
import type { Facts } from "../scripts/lib/facts.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "followup.ts");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the file's tests. */
function temporary(prefix = "followup-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** This process's environment without what points git or Jig elsewhere, with a fixed author. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG__") &&
      !key.startsWith("ORCA_CLI_") &&
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
  };
}

/** Run git in `root`; its output, or a thrown error naming the command. */
export function gitRun(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    env: cleanEnv(),
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return String(result.stdout).trim();
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A git repository on `main` holding `files`, committed. */
export function repository(files: Record<string, string>): string {
  const root = temporary();
  gitRun(root, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  gitRun(root, "add", "-A");
  gitRun(root, "commit", "-q", "--allow-empty", "-m", "base");
  return root;
}

/** The facts of a merged pull request, with `over` laid on top. */
export function factsOf(over: Partial<Facts> = {}): Facts {
  return {
    schema: 1,
    pr: 7,
    url: "https://example.com/pulls/7",
    title: "fix: keep the export's column order",
    mode: "post-merge",
    remote: "origin",
    integrationBranch: "main",
    baseBranch: "main",
    headRefName: "eng-12-keep-column-order",
    headRefOid: "b".repeat(40),
    mergeSha: "c".repeat(40),
    range: { kind: "squash", base: "a".repeat(40), head: "c".repeat(40) },
    changedFiles: ["src/export.ts"],
    changeAreas: { known: false, reason: "no catalog" },
    item: { key: "ENG-12", source: "branch" },
    items: [{ key: "ENG-12", source: "branch" }],
    itemRead: true,
    epics: [],
    outOfTree: { declared: true, saysNone: true, steps: [] },
    labels: [],
    scaffolding: [],
    configOrigin: "working tree",
    notes: [],
    ...over,
  };
}

/** Run the script with `root` as its working directory, `env` laid over the clean environment. */
export function runScript(
  root: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: { ...cleanEnv(), ...env },
    encoding: "utf8",
  });
  return {
    exitCode: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}
