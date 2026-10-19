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
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerCleanup } from "../../../../shared/cleanup.ts";
import { splitNul } from "./git.ts";
import { DECISIONS } from "./snapshot.ts";

/**
 * The oldest git the replay runs with: `GIT_ATTR_SOURCE`, which keeps today's
 * attributes out of a past merge, came in 2.41, and `merge-tree` reads it
 * without crashing from 2.43.
 */
export const MIN_GIT: readonly [number, number] = [2, 43];

/** The oldest git that honours `GIT_NO_LAZY_FETCH`, so a partial clone never fetches. */
export const NO_LAZY_FETCH_GIT: readonly [number, number] = [2, 45];

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

/** Whether `version` is at least `floor` (`MIN_GIT` by default). */
export function gitIsRecentEnough(
  version: readonly number[],
  floor: readonly [number, number] = MIN_GIT,
): boolean {
  const [major = 0, minor = 0] = version;
  return major > floor[0] || (major === floor[0] && minor >= floor[1]);
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
  /** `-c key=value` settings passed before every command. */
  readonly settings: readonly string[];

  constructor(
    cwd: string,
    env: Record<string, string | undefined> = process.env,
    settings: readonly string[] = [],
  ) {
    this.cwd = cwd;
    this.env = env;
    this.settings = settings;
  }

  raw(args: readonly string[], input?: string): Raw {
    const config = this.settings.flatMap((setting) => ["-c", setting]);
    const r = spawnSync("git", [...STABLE, ...config, ...args], {
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

/** Whether the repository is a partial clone, whose missing objects git would fetch. */
export function isPartialClone(git: Git): boolean {
  const out = git.raw([
    "config",
    "--get-regexp",
    "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
  ]);
  return out.stdout
    .toString("utf8")
    .split("\n")
    .some((line) => {
      const [key = "", value = ""] = line.split(" ");
      return key === "extensions.partialclone"
        ? value !== ""
        : ["true", "yes", "on", "1"].includes(value.toLowerCase());
    });
}

/** Every configured merge driver's command, set to `false`: no driver of the repository's or a person's runs. */
function silencedDrivers(repo: Git): string[] {
  const out = repo.raw([
    "config",
    "--name-only",
    "--get-regexp",
    "^merge\\..+\\.driver$",
  ]);
  return out.stdout
    .toString("utf8")
    .split("\n")
    .filter((key) => key !== "")
    .map((key) => `${key}=false`);
}

/**
 * Run `body` with a git runner whose new objects go to a temporary object
 * directory, removed when `body` returns or throws, and on an interrupt.
 *
 * The runner also keeps today's attributes out of past merges: the working
 * tree's and the index's are read from the empty tree instead
 * (`GIT_ATTR_SOURCE`), and the system's and a person's attributes files are
 * not read. Git still reads `$GIT_DIR/info/attributes`, which nothing here
 * can redirect, so a marker size or a built-in driver (`union`, `binary`)
 * set there still applies. Every configured merge driver is replaced by
 * `false`, so no command of the repository's runs, whichever file names it.
 */
export function withScratchObjects<T>(repo: Git, body: (git: Git) => T): T {
  const objects = repo
    .text(["rev-parse", "--path-format=absolute", "--git-path", "objects"])
    .trim();
  const emptyTree = repo
    .text(["hash-object", "-t", "tree", "--stdin"], "")
    .trim();
  const scratch = mkdtempSync(join(tmpdir(), "jig-merge-replay-"));
  const remove = () => rmSync(scratch, { recursive: true, force: true });
  // Removed on return, on a throw, and on an interrupt or exit that skips both.
  const cleanup = registerCleanup(remove);
  try {
    const objectDir = join(scratch, "objects");
    mkdirSync(objectDir);
    const noAttributes = join(scratch, "attributes");
    writeFileSync(noAttributes, "");
    const alternates = [objects, repo.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
      .filter((dir): dir is string => typeof dir === "string" && dir !== "")
      .join(delimiter);
    const git = new Git(
      repo.cwd,
      {
        ...repo.env,
        GIT_OBJECT_DIRECTORY: objectDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
        // A partial clone's missing object is an error here, never a fetch
        // (git 2.45 and later; an older git is refused a partial clone).
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_ATTR_SOURCE: emptyTree,
        GIT_ATTR_NOSYSTEM: "1",
      },
      [`core.attributesFile=${noAttributes}`, ...silencedDrivers(repo)],
    );
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
  "refs/remotes/*/pull/*/merge",
  "refs/remotes/*/merge-requests/*/merge",
];

/**
 * Every merge commit the repository's refs reach whose committer date falls
 * in `[since, until)` (seconds; null is open), newest first. A first pass reads
 * only ids and dates; the messages are read for the merges in range. Git's own
 * `--since` is not used: it stops a walk at a commit with an older date, and a
 * skewed clock would hide the merges behind it.
 */
export function mergeCommits(
  git: Git,
  since: number | null = null,
  until: number | null = null,
): MergeCommit[] {
  const out = git.text([
    "log",
    ...EXCLUDED_REFS.map((ref) => `--exclude=${ref}`),
    "--all",
    "--merges",
    "--format=%H %ct",
  ]);
  const wanted = out
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([commit = "", time = ""]) => {
      const t = Number(time);
      return (
        commit !== "" &&
        (since === null || t >= since) &&
        (until === null || t < until)
      );
    })
    .map(([commit = ""]) => commit);
  if (wanted.length === 0) return [];
  const bodies = git.text(
    [
      "log",
      "--no-walk=unsorted",
      "--stdin",
      "-z",
      "--format=%H%x1f%P%x1f%cI%x1f%ct%x1f%s%x1f%B",
    ],
    `${wanted.join("\n")}\n`,
  );
  return splitNul(bodies).map((record) => {
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

/** The merge bases of two commits; none for unrelated histories, or a base hidden by a shallow clone. */
export function mergeBases(git: Git, a: string, b: string): string[] {
  const r = git.raw(["merge-base", "--all", a, b]);
  if (r.code === 1) return [];
  if (r.code !== 0)
    throw new ReplayError(
      `git merge-base exited ${r.code}: ${r.stderr.trim()}`,
    );
  return r.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** The commits a shallow clone's history stops at; empty for a full clone. */
export function shallowBoundary(git: Git): Set<string> {
  if (git.text(["rev-parse", "--is-shallow-repository"]).trim() !== "true")
    return new Set();
  const file = git
    .text(["rev-parse", "--path-format=absolute", "--git-path", "shallow"])
    .trim();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  );
}

/**
 * Whether a shallow clone's boundary cuts the history between a merge's
 * parents and their merge bases: a commit there whose parents the clone does
 * not hold could hide a better base, so the replay cannot be trusted.
 */
export function cutByBoundary(
  git: Git,
  parents: readonly string[],
  bases: readonly string[],
  boundary: ReadonlySet<string>,
): boolean {
  if (boundary.size === 0) return false;
  if (bases.length === 0) return true;
  const between = git.text(["rev-list", ...parents, "--not", ...bases]);
  return between.split("\n").some((commit) => boundary.has(commit));
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

export interface SubjectBranches {
  /** The branch (or tag) merged in, as the subject names it. */
  theirs: string | null;
  /** The branch merged into, when the subject names it. */
  ours: string | null;
}

/**
 * The branches a merge's subject names: git's own `Merge branch 'a' into b`,
 * `Merge remote-tracking branch 'origin/a' into b` and `Merge tag 'v1'`, and a
 * forge's `Merge pull request #12 from owner/branch`.
 */
export function subjectBranches(subject: string): SubjectBranches {
  const git = subject.match(
    /^Merge (?:remote-tracking )?(?:branch|tag) '([^']+)'(?: of \S+)?(?: into (\S+))?/,
  );
  if (git) return { theirs: git[1] ?? null, ours: git[2] ?? null };
  const forge = subject.match(/^Merge pull request #\d+ from [^/\s]+\/(\S+)/);
  if (forge) return { theirs: forge[1] ?? null, ours: null };
  return { theirs: null, ours: null };
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

/**
 * Merge two commits as git would, conflicted regions in diff3 style (with
 * their base). `unrelated` merges histories that share no commit, as the
 * original merge must have.
 */
export function mergeTree(
  git: Git,
  ours: string,
  theirs: string,
  unrelated = false,
): TreeMerge {
  const r = git.raw([
    "-c",
    "merge.conflictStyle=diff3",
    "merge-tree",
    "--write-tree",
    "-z",
    ...(unrelated ? ["--allow-unrelated-histories"] : []),
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
  `^- (.+?): (${DECISIONS.join("|")})(?=$| \\(| — | Dropped on purpose: )(.*)$`,
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
