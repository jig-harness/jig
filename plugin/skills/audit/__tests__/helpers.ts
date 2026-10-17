/**
 * Scratch repositories for the audit's tests, and a way to run the audit's
 * scripts in one the way the plugin cache does: from outside this repository,
 * with the scratch repository as the working directory.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../shared/guarded-git-spawn.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

/** The test environment, without anything that points git or the skills elsewhere. */
export function cleanEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
      !key.startsWith("JIG_") &&
      !key.startsWith("LINEAR_") &&
      !key.startsWith("DRIVE_PR_")
    )
      env[key] = value;
  return {
    ...env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    ...extra,
  };
}

/** A git repository holding `files`, all committed. */
export function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jig-audit-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const env = cleanEnv();
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "--allow-empty", "-m", "scratch"],
  ]) {
    const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
  return root;
}

/** Run git in a scratch repository; throws when it fails, and returns its output. */
export function git(root: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Write `files` into a scratch repository and commit them all; returns the new commit. */
export function commitFiles(
  root: string,
  files: Record<string, string>,
  message = "change",
): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** Run one of the audit's scripts in `cwd`, with `input` on its standard input. */
export function runScript(
  script: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = cleanEnv(),
  input = "",
): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/**
 * A fake `gh` that answers from `answers`: the first key that the joined
 * arguments contain wins; its value is printed, or, when it starts with
 * `!`, written to stderr with exit 1. Unknown calls fail.
 */
export function fakeGh(dir: string, answers: Record<string, string>): string {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "answers.json"), JSON.stringify(answers));
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const answers = require(${JSON.stringify(join(bin, "answers.json"))});
const call = process.argv.slice(2).join(" ");
const key = Object.keys(answers).find((k) => call.includes(k));
if (key === undefined) { console.error("fake gh: no answer for " + call); process.exit(1); }
const answer = answers[key];
if (answer.startsWith("!")) { console.error(answer.slice(1)); process.exit(1); }
console.log(answer);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

/** PATH with `bin` first. */
export function withPath(bin: string): string {
  return `${bin}${delimiter}${process.env.PATH ?? ""}`;
}
