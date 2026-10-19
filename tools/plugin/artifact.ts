#!/usr/bin/env bun
/**
 * The `jig` plugin as the agent tools install it: the two marketplace files
 * and `plugin/`, less the files only Jig's development needs. The release
 * channels (`latest`, `stable`) carry this artifact, built from a tagged
 * commit's objects; the gates and the plugin tests build it from the working
 * tree, so what they check is what a machine installs.
 *
 * Usage:
 *   bun tools/plugin/artifact.ts <dir>   write the working tree's artifact to <dir>
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../lib/cli.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../plugin/shared/guarded-git-spawn.ts";

/** A release-channel or artifact step that cannot go on; the message says why. */
export class ChannelError extends Error {
  override name = "ChannelError";
}

/** The marketplace files, one per tool; each lists `./plugin`. */
export const MARKETPLACE_FILES = [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
] as const;

export const PLUGIN_DIR = "plugin";

/**
 * Whether a repository path is part of the artifact. A skill may rely at run
 * time on every file under `plugin/` except tests (`__tests__/`) and the
 * instructions for agents working on Jig itself (`AGENTS.md`, `CLAUDE.md`),
 * which no tool loads from a plugin.
 */
export function isShipped(path: string): boolean {
  if ((MARKETPLACE_FILES as readonly string[]).includes(path)) return true;
  const parts = path.split("/");
  if (parts[0] !== PLUGIN_DIR || parts.length < 2) return false;
  if (parts.includes("__tests__")) return false;
  const name = parts.at(-1);
  return name !== "AGENTS.md" && name !== "CLAUDE.md";
}

/** The README a channel branch carries in place of the repository's. */
export function channelReadme(channel: string, version: string): string {
  return [
    `# Jig plugin, \`${channel}\` channel`,
    "",
    `This branch is generated: it holds version ${version} of the \`jig\``,
    "plugin as the agent tools install it, built from the tagged source on",
    "`main`. Never edit it; every commit here is written by the release",
    "tooling. How to install from it, and what each channel means:",
    "https://github.com/jig-harness/jig/blob/main/plugin/README.md#release-channels",
    "",
  ].join("\n");
}

/** The environment for a child: the caller's, less what reroutes git elsewhere. */
export function gitEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...withoutLeakyGitEnv(), ...extra };
}

/** Run `command`; throw with its output when it fails; return its stdout. */
export function runChecked(
  command: string,
  args: string[],
  options: {
    input?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {},
): string {
  const result = spawnSync(command, args, {
    env: options.env ?? gitEnv(),
    input: options.input,
    timeout: options.timeout,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new ChannelError(
      `${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
}

/** Run git in `repo`. */
export function git(repo: string, args: string[], input?: string): string {
  return runChecked(
    "git",
    ["-C", repo, ...args],
    input === undefined ? {} : { input },
  );
}

/** One file of a tree: its git mode, blob, and path. */
interface Entry {
  mode: string;
  sha: string;
  path: string;
}

/** The artifact's files in `commit`, from its objects, without a checkout. */
export function shippedEntries(repo: string, commit: string): Entry[] {
  const listing = git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    "--",
    PLUGIN_DIR,
    ...MARKETPLACE_FILES,
  ]);
  const entries: Entry[] = [];
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode = "", type = "", sha = ""] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (type !== "blob")
      throw new ChannelError(
        `${commit}: ${path} is a ${type}; the plugin may hold only files`,
      );
    if (isShipped(path)) entries.push({ mode, sha, path });
  }
  for (const file of MARKETPLACE_FILES)
    if (!entries.some((entry) => entry.path === file))
      throw new ChannelError(`${commit} has no ${file}`);
  return entries;
}

interface Dir {
  files: Map<string, { mode: string; sha: string }>;
  dirs: Map<string, Dir>;
}

/** Write `dir` and everything under it as tree objects; return its sha. */
function writeTree(repo: string, dir: Dir): string {
  const lines: string[] = [];
  for (const [name, sub] of dir.dirs)
    lines.push(`040000 tree ${writeTree(repo, sub)}\t${name}`);
  for (const [name, file] of dir.files)
    lines.push(`${file.mode} blob ${file.sha}\t${name}`);
  return git(repo, ["mktree", "-z"], `${lines.join("\0")}\0`).trim();
}

/**
 * The tree of the artifact built from `commit`, with `extra` files (path →
 * text) added, written to `repo`'s object store.
 */
export function artifactTree(
  repo: string,
  commit: string,
  extra: Record<string, string> = {},
): string {
  const root: Dir = { files: new Map(), dirs: new Map() };
  const place = (path: string, mode: string, sha: string) => {
    const parts = path.split("/");
    const name = parts.pop() as string;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(name, { mode, sha });
  };
  for (const entry of shippedEntries(repo, commit))
    place(entry.path, entry.mode, entry.sha);
  for (const [path, text] of Object.entries(extra))
    place(
      path,
      "100644",
      git(repo, ["hash-object", "-w", "--stdin"], text).trim(),
    );
  return writeTree(repo, root);
}

/**
 * Write the working tree's artifact to `out`: the tracked and untracked (not
 * ignored) files the artifact holds, as they are on disk, so the gates check
 * a change before it is committed.
 */
export function writeWorkingArtifact(repo: string, out: string): string[] {
  const listing = git(repo, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    PLUGIN_DIR,
    ...MARKETPLACE_FILES,
  ]);
  const written: string[] = [];
  for (const path of new Set(listing.split("\0"))) {
    if (!path || !isShipped(path)) continue;
    const from = join(repo, path);
    // A file deleted in the working tree but still in the index is gone.
    if (!existsSync(from) && !isLink(from)) continue;
    const to = join(out, path);
    mkdirSync(dirname(to), { recursive: true });
    if (isLink(from)) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
    written.push(path);
  }
  return written.sort();
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

if (import.meta.main)
  cli(() => {
    const out = process.argv[2];
    if (!out || process.argv.length > 3)
      throw new ChannelError("usage: bun tools/plugin/artifact.ts <dir>");
    const root = resolve(import.meta.dir, "../..");
    if (existsSync(out))
      throw new ChannelError(`${out} exists; name a directory that does not`);
    const written = writeWorkingArtifact(root, resolve(out));
    console.log(`${written.length} files written to ${out}`);
    return 0;
  });
