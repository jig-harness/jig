/**
 * Synchronous git calls for the conflict scripts. Every call runs against the
 * repository's top level (`git -C <root>`), so paths read from git are always
 * relative to the root, whatever directory the script was started from.
 */
import { spawnSync } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Large enough for any lockfile or generated file a stage blob can hold. */
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Settings that make git's output machine-stable (unquoted paths, no colour)
 * and read every path argument literally, never as a glob.
 */
const STABLE = [
  "--literal-pathspecs",
  "-c",
  "core.quotePath=false",
  "-c",
  "color.ui=false",
];

function spawnGit(
  root: string | null,
  args: readonly string[],
  encoding: "utf8" | "buffer",
  input?: string,
  env?: NodeJS.ProcessEnv,
) {
  const full = [...STABLE, ...(root === null ? [] : ["-C", root]), ...args];
  const r = spawnSync("git", full, {
    encoding,
    maxBuffer: MAX_BUFFER,
    input,
    env,
  });
  if (r.error) throw new Error(`git ${args.join(" ")}: ${r.error.message}`);
  return r;
}

export function gitRaw(
  root: string | null,
  args: readonly string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): GitResult {
  const r = spawnGit(root, args, "utf8", input, env);
  return {
    code: r.status ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function succeeded<T extends { code: number; stderr: string; stdout: unknown }>(
  args: readonly string[],
  r: T,
): T["stdout"] {
  if (r.code !== 0)
    throw new Error(
      `git ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || String(r.stdout).trim()}`,
    );
  return r.stdout;
}

/** Run git and return its stdout; any non-zero exit throws with git's message. */
export function git(
  root: string | null,
  args: readonly string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): string {
  return succeeded(args, gitRaw(root, args, input, env));
}

/** The repository's top level, or null outside a work tree. */
export function topLevel(): string | null {
  const r = gitRaw(null, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** An absolute path inside the repository's git directory (worktree-safe). */
export function gitPath(root: string, name: string): string {
  return git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    name,
  ]).trim();
}

/** The commit a revision names, or null when it names none. */
export function resolveCommit(root: string, rev: string): string | null {
  const r = gitRaw(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}^{commit}`,
  ]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** A commit's subject line. */
export function subject(root: string, commit: string): string {
  return git(root, ["log", "-1", "--format=%s", commit]).trim();
}

/** The content of a blob. */
export function readBlob(root: string, blob: string): string {
  return git(root, ["cat-file", "blob", blob]);
}

/**
 * Whether git calls a blob's content binary: a zero byte in its first 8000
 * bytes. Read as bytes, since a decoded string counts characters, and a
 * character can take up to 4 bytes.
 */
export function isBinaryBlob(root: string, blob: string): boolean {
  const args = ["cat-file", "blob", blob];
  const r = spawnGit(root, args, "buffer");
  const bytes = succeeded(args, {
    code: r.status ?? -1,
    stdout: r.stdout as Buffer,
    stderr: r.stderr.toString(),
  });
  return bytes.subarray(0, 8000).includes(0);
}

/** Split NUL-terminated output into its records, dropping the final empty one. */
export function splitNul(text: string): string[] {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** The blob staged for `path` (stage 0), or null when the index has none. */
export function indexBlob(root: string, path: string): string | null {
  for (const record of splitNul(
    git(root, ["ls-files", "--stage", "-z", "--", path]),
  )) {
    const match = record.match(/^\d+ ([0-9a-f]+) 0\t(.*)$/s);
    if (match && match[2] === path) return match[1] as string;
  }
  return null;
}
