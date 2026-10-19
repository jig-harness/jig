/**
 * Replay a repository's merge commits: merge each one's two parents again
 * with `git merge-tree --write-tree`, which merges two commits without a
 * working tree or an index, and read what conflicted.
 *
 * Git writes the merged tree and its blobs as objects. Every call here runs
 * with `GIT_OBJECT_DIRECTORY` pointed at a temporary directory and the
 * repository's own object directory as an alternate, so those objects land in
 * the temporary directory, which is removed afterwards: no ref, index,
 * working tree or object of the repository changes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { registerCleanup } from "../../../../shared/cleanup.ts";
import { splitNul } from "./git.ts";

/** The oldest git whose `merge-tree --write-tree` the replay reads. */
export const MIN_GIT: readonly [number, number] = [2, 38];

const MAX_BUFFER = 512 * 1024 * 1024;

/** Settings that keep git's output machine-stable. */
const STABLE = ["-c", "core.quotePath=false", "-c", "color.ui=false"];

/** `[major, minor, patch]` from `git --version`'s output, or null. */
export function parseGitVersion(
  output: string,
): [number, number, number] | null {
  const match = output.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** Whether `version` is at least `MIN_GIT`. */
export function gitIsRecentEnough(version: readonly number[]): boolean {
  const [major = 0, minor = 0] = version;
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

/** A git call the replay depends on failed. */
export class ReplayError extends Error {
  override name = "ReplayError";
}

export interface Raw {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** A git runner bound to one repository and one environment. */
export class Git {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;

  constructor(
    cwd: string,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.cwd = cwd;
    this.env = env;
  }

  raw(args: readonly string[], input?: string): Raw {
    const r = spawnSync("git", [...STABLE, ...args], {
      cwd: this.cwd,
      env: this.env,
      input,
      maxBuffer: MAX_BUFFER,
    });
    if (r.error)
      throw new ReplayError(`git ${args.join(" ")}: ${r.error.message}`);
    return {
      code: r.status ?? -1,
      stdout: r.stdout,
      stderr: r.stderr.toString("utf8"),
    };
  }

  /** stdout as text; a non-zero exit throws with git's message. */
  text(args: readonly string[], input?: string): string {
    const r = this.raw(args, input);
    if (r.code !== 0)
      throw new ReplayError(
        `git ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`,
      );
    return r.stdout.toString("utf8");
  }
}

/**
 * Run `body` with a git runner whose new objects go to a temporary object
 * directory, removed when `body` returns or throws, and on an interrupt.
 */
export function withScratchObjects<T>(repo: Git, body: (git: Git) => T): T {
  const objects = repo
    .text(["rev-parse", "--path-format=absolute", "--git-path", "objects"])
    .trim();
  const scratch = mkdtempSync(join(tmpdir(), "jig-merge-replay-"));
  const remove = () => rmSync(scratch, { recursive: true, force: true });
  const alternates = [objects, repo.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
    .filter((dir): dir is string => typeof dir === "string" && dir !== "")
    .join(delimiter);
  const git = new Git(repo.cwd, {
    ...repo.env,
    GIT_OBJECT_DIRECTORY: scratch,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    // A partial clone's missing object is an error here, never a fetch.
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  });
  // Removed on return, on a throw, and on an interrupt or exit that skips both.
  const cleanup = registerCleanup(remove);
  try {
    return body(git);
  } finally {
    cleanup[Symbol.dispose]();
  }
}

export interface MergeCommit {
  commit: string;
  parents: string[];
  /** Committer date, ISO 8601. */
  date: string;
  /** Committer date, seconds since the epoch. */
  time: number;
  subject: string;
  message: string;
}

/**
 * Refs the replay leaves out: the stash (its commits are merges of the index
 * and the working tree) and a forge's synthetic test merges of an open pull
 * request, which no one made.
 */
const EXCLUDED_REFS = [
  "refs/stash",
  "refs/pull/*/merge",
  "refs/merge-requests/*/merge",
];

/** Every merge commit the repository's refs reach, newest first. */
export function mergeCommits(git: Git): MergeCommit[] {
  const out = git.text([
    "log",
    ...EXCLUDED_REFS.map((ref) => `--exclude=${ref}`),
    "--all",
    "--merges",
    "-z",
    "--format=%H%x1f%P%x1f%cI%x1f%ct%x1f%s%x1f%B",
  ]);
  return splitNul(out).map((record) => {
    const [
      commit = "",
      parents = "",
      date = "",
      time = "",
      subject = "",
      ...body
    ] = record.split("\x1f");
    return {
      commit,
      parents: parents.split(" ").filter((p) => p !== ""),
      date,
      time: Number(time),
      subject,
      message: body.join("\x1f"),
    };
  });
}

export interface PullRequestHead {
  ref: string;
  number: number;
}

const PR_HEAD_PATTERNS = [
  /^refs\/pull\/(\d+)\/head$/,
  /^refs\/merge-requests\/(\d+)\/head$/,
  /^refs\/remotes\/[^/]+\/pull\/(\d+)(?:\/head)?$/,
  /^refs\/remotes\/[^/]+\/pr\/(\d+)$/,
];

/** Commit → the fetched pull-request head refs that point at it. */
export function pullRequestHeads(git: Git): Map<string, PullRequestHead[]> {
  const heads = new Map<string, PullRequestHead[]>();
  const out = git.text([
    "for-each-ref",
    "--format=%(objectname)%09%(refname)",
    "refs/pull",
    "refs/merge-requests",
    "refs/remotes",
  ]);
  for (const line of out.split("\n")) {
    const [oid = "", ref = ""] = line.split("\t");
    for (const pattern of PR_HEAD_PATTERNS) {
      const match = ref.match(pattern);
      if (!match) continue;
      const list = heads.get(oid) ?? [];
      list.push({ ref, number: Number(match[1]) });
      heads.set(oid, list);
      break;
    }
  }
  return heads;
}

export interface StageEntry {
  mode: string;
  blob: string;
}

export interface ConflictedPath {
  path: string;
  stages: {
    base: StageEntry | null;
    ours: StageEntry | null;
    theirs: StageEntry | null;
  };
  /** Git's own kinds of conflict for the path, such as `contents` or `modify/delete`. */
  conflicts: string[];
  /** Git's messages about the path. */
  messages: string[];
}

export interface TreeMerge {
  /** The tree merge-tree wrote, conflicted files with their markers. */
  tree: string;
  clean: boolean;
  paths: ConflictedPath[];
}

/** Git's kind of conflict from a message type: `CONFLICT (modify/delete)` → `modify/delete`. */
function conflictType(type: string): string | null {
  const match = type.match(/^CONFLICT \((.+)\)$/);
  return match ? (match[1] as string) : null;
}

const STAGE_LINE = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s;
const SLOTS = { "1": "base", "2": "ours", "3": "theirs" } as const;

/** The conflicted file entries from `parts[1]` to the empty part that ends them; returns the index after it. */
function readStages(
  parts: readonly string[],
  entry: (path: string) => ConflictedPath,
): number {
  let i = 1;
  for (; i < parts.length && parts[i] !== ""; i++) {
    const match = (parts[i] as string).match(STAGE_LINE);
    if (!match) continue;
    const [, mode = "", blob = "", stage = "1", path = ""] = match;
    entry(path).stages[SLOTS[stage as keyof typeof SLOTS]] = { mode, blob };
  }
  return i + 1;
}

/** The informational messages from `start`: `<count> <paths…> <type> <message>`, each part NUL-terminated. */
function readMessages(
  parts: readonly string[],
  start: number,
  onMessage: (paths: string[], type: string, message: string) => void,
): void {
  let i = start;
  while (i < parts.length) {
    const count = Number(parts[i]);
    if (!Number.isInteger(count) || count < 1) return;
    onMessage(
      parts.slice(i + 1, i + 1 + count),
      parts[i + 1 + count] ?? "",
      (parts[i + 2 + count] ?? "").trim(),
    );
    i += count + 3;
  }
}

/** Read `merge-tree --write-tree -z`'s output. */
export function parseMergeTree(output: string, clean: boolean): TreeMerge {
  const parts = output.split("\0");
  const byPath = new Map<string, ConflictedPath>();
  const entry = (path: string): ConflictedPath => {
    const found = byPath.get(path) ?? {
      path,
      stages: { base: null, ours: null, theirs: null },
      conflicts: [],
      messages: [],
    };
    byPath.set(path, found);
    return found;
  };
  const messagesAt = clean ? 1 : readStages(parts, entry);
  readMessages(parts, messagesAt, (paths, type, message) => {
    const kind = conflictType(type);
    for (const target of paths.flatMap((path) => byPath.get(path) ?? [])) {
      if (kind !== null && !target.conflicts.includes(kind))
        target.conflicts.push(kind);
      if (type !== "Auto-merging") target.messages.push(message);
    }
  });
  return { tree: parts[0] ?? "", clean, paths: [...byPath.values()] };
}

/** Merge two commits as git would, conflicted regions in diff3 style (with their base). */
export function mergeTree(git: Git, ours: string, theirs: string): TreeMerge {
  const r = git.raw([
    "-c",
    "merge.conflictStyle=diff3",
    "merge-tree",
    "--write-tree",
    "-z",
    "--allow-unrelated-histories",
    ours,
    theirs,
  ]);
  if (r.code !== 0 && r.code !== 1)
    throw new ReplayError(
      `git merge-tree exited ${r.code}: ${r.stderr.trim() || "no message"}`,
    );
  return parseMergeTree(r.stdout.toString("utf8"), r.code === 0);
}

/**
 * The content of each object a spec names (`<blob>` or `<tree>:<path>`), in
 * one `git cat-file --batch`; null for one that does not exist or is not a
 * blob.
 */
export function readObjects(
  git: Git,
  specs: readonly string[],
): (Buffer | null)[] {
  const result: (Buffer | null)[] = specs.map(() => null);
  // The batch reads one spec per line: a path holding a newline is read alone.
  const batched = specs
    .map((spec, i) => ({ spec, i }))
    .filter(({ spec }) => !spec.includes("\n"));
  for (const { spec, i } of specs
    .map((spec, i) => ({ spec, i }))
    .filter(({ spec }) => spec.includes("\n"))) {
    const r = git.raw(["cat-file", "blob", spec]);
    result[i] = r.code === 0 ? r.stdout : null;
  }
  if (batched.length === 0) return result;
  const r = git.raw(
    ["cat-file", "--batch"],
    `${batched.map(({ spec }) => spec).join("\n")}\n`,
  );
  if (r.code !== 0)
    throw new ReplayError(
      `git cat-file --batch exited ${r.code}: ${r.stderr.trim()}`,
    );
  const out = r.stdout;
  let at = 0;
  for (const { i } of batched) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = out.subarray(at, eol).toString("utf8");
    at = eol + 1;
    const match = header.match(/^[0-9a-f]+ (\S+) (\d+)$/);
    if (!match) continue;
    const size = Number(match[2]);
    if (match[1] === "blob") result[i] = out.subarray(at, at + size);
    at += size + 1;
  }
  return result;
}

export interface Resolution {
  decision: string;
  reason: string | null;
  command: string | null;
  dropped: string | null;
}

const DECISION_WORDS = [
  "combined",
  "ours",
  "theirs",
  "rewritten",
  "regenerated",
  "deleted",
  "escalate",
];

/**
 * The `Conflicts resolved:` section of a commit message, by path: the lines
 * `check-resolution.ts --message` writes,
 * `- <path>: <decision>[ (<command>)][ — <reason>][ Dropped on purpose: <why>]`.
 */
export function parseResolutionSection(
  message: string,
): Map<string, Resolution> {
  const found = new Map<string, Resolution>();
  const lines = message.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines.findIndex(
    (line) => line.trim() === "Conflicts resolved:",
  );
  if (start < 0) return found;
  for (const text of lines.slice(start + 1)) {
    if (!text.startsWith("- ")) break;
    const parsed = resolutionLine(text);
    if (parsed !== null) found.set(parsed.path, parsed.resolution);
  }
  return found;
}

const RESOLUTION_LINE = new RegExp(
  `^- (.+?): (${DECISION_WORDS.join("|")})(?=$| \\(| — | Dropped on purpose: )(.*)$`,
);
const DROPPED = " Dropped on purpose: ";

/** Split `rest` at the first `marker`: what precedes it, and what follows it or null. */
function cut(rest: string, marker: string): [string, string | null] {
  const at = rest.indexOf(marker);
  return at < 0
    ? [rest, null]
    : [rest.slice(0, at), rest.slice(at + marker.length)];
}

/** One line of the section, or null when it is not one. */
function resolutionLine(
  text: string,
): { path: string; resolution: Resolution } | null {
  const match = text.match(RESOLUTION_LINE);
  if (!match) return null;
  const [, path = "", decision = ""] = match;
  const [beforeDropped, dropped] = cut(match[3] ?? "", DROPPED);
  let rest = beforeDropped;
  let command: string | null = null;
  if (rest.startsWith(" (")) {
    const close = rest.includes(") — ")
      ? rest.indexOf(") — ")
      : rest.lastIndexOf(")");
    if (close > 0) {
      command = rest.slice(2, close);
      rest = rest.slice(close + 1);
    }
  }
  const reason = rest.startsWith(" — ") ? rest.slice(3).trim() || null : null;
  return {
    path,
    resolution: { decision, reason, command, dropped: dropped?.trim() ?? null },
  };
}
