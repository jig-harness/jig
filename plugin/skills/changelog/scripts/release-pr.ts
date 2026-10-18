// The branch check's rule for a release pull request, in `pull-request`
// mode: the pull request from `changelog.release.branch` is the release
// step's own output, so instead of the rules for an ordinary branch the check
// reproduces it. It runs the release step on the branch's merge base, in a
// temporary worktree, dated with the date of the branch's new release
// heading, and passes the branch only when the result is the branch's
// change. The release step that reproduces it is the running code: the
// action that runs the check is pinned at the plugin version the release
// workflow runs, so both are the same version (the banner prints it).
//
// `after_version` is not run: its output can depend on what a package
// registry answers on the day. A file the release step does not write itself
// may therefore differ from the reproduction only where the base configures
// `after_version` at all, and only by the version: line for line, in order,
// each of its lines is the reproduction's line or that line with the version
// before the release replaced by the one released, as a whole version (not
// inside a longer version or name). A file that is not valid UTF-8 text
// may not differ at all, no path may change its kind (file, executable
// file, symbolic link, submodule) whatever its content, and no submodule may
// move to another commit. A tracked path's kind is what git's index records,
// not what the file system shows. Every other difference is named.
//
// Which branch a pull request comes from is read from a source the branch
// cannot change: `--head-ref`, else the pull-request event that started the CI
// job, else the current branch's name. Whether the rule applies at all (the
// mode and the branch's name) comes from the base's `changelog:` section. A
// branch that only carries the name gains nothing: it passes only by being
// exactly what the release step writes.
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCleanup } from "../../../shared/cleanup.ts";
import { isMapping } from "../../../shared/config-layers.ts";
import { swallow } from "../../../shared/errors.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  type ChangelogConfig,
  configAtBase,
  resolve as resolveConfig,
} from "./config.ts";
import { type Format, releasedVersions, releaseVersion } from "./formats.ts";
import { blocks } from "./markdown-blocks.ts";
import { gitEnv, isNoteFile, workingTree } from "./notes-dir.ts";
import { isCalendarDay, releaseWithoutAfterVersion } from "./release.ts";
import type { VersionSource } from "./versions.ts";

type Env = Record<string, string | undefined>;

/** How long one git call may take; a worktree checkout is the longest. */
const GIT_TIMEOUT_MS = 300_000;

/** How many offending lines a finding shows of a file. */
const SHOWN_LINES = 3;

/** git's output in `dir`, with a deadline; null when git fails or runs out of time. */
function git(dir: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", dir, ...args], {
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout : null;
}

/** NUL-separated git output as a list. */
const paths = (out: string | null) => (out ?? "").split("\0").filter(Boolean);

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The head branch of the pull-request event that started the CI job; null outside one. */
function eventHead(env: Env): string | null {
  const path = env.GITHUB_EVENT_PATH;
  if (path && existsSync(path))
    try {
      const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
      const pullRequest = isMapping(payload) ? payload.pull_request : null;
      const head = isMapping(pullRequest) ? pullRequest.head : null;
      const ref = isMapping(head) ? text(head.ref) : null;
      if (ref) return ref;
    } catch (error) {
      swallow(error, "the CI event payload is not readable JSON");
    }
  return text(env.GITHUB_HEAD_REF);
}

/**
 * The branch the change comes from: `explicit` (`--head-ref`), else the head
 * of the pull request that started the CI job, else the branch checked out at
 * `root`. Null when none answers (a detached checkout outside a pull request).
 */
export function headRef(
  root: string,
  explicit: string | null,
  env: Env = process.env,
): string | null {
  if (explicit) return explicit;
  const fromEvent = eventHead(env);
  if (fromEvent) return fromEvent;
  return (
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null
  );
}

/** Whether the base's configuration makes a branch named `head` the release pull request. */
export function isReleasePullRequest(
  atBase: ChangelogConfig,
  head: string | null,
): boolean {
  return (
    atBase.release.push === "pull-request" && head === atBase.release.branch
  );
}

/** The release headings `after` has that `before` lacks, each with its version and title. */
function newHeadings(
  before: string,
  after: string,
  format: Format,
): { version: string; title: string }[] {
  const known = new Set(releasedVersions(before, format));
  return blocks(after, 2).parts.flatMap((p) => {
    const version = releaseVersion(p.title, format);
    return version === null || known.has(version)
      ? []
      : [{ version, title: p.title }];
  });
}

/** The date a release heading's title gives, `[x.y.z] - YYYY-MM-DD` or `x.y.z - YYYY-MM-DD`. */
export function headingDate(title: string): string | null {
  return /^\[?[^\]\s]+\]?\s+-\s+(\S+)/.exec(title)?.[1] ?? null;
}

/** Why `date` cannot be the day a release step ran; null when it can. */
function dateRefusal(date: string, today: string): string | null {
  if (!isCalendarDay(date))
    return `${JSON.stringify(date)} is not a calendar day written YYYY-MM-DD`;
  return date > today
    ? `${date} is later than today (${today} in UTC), so no release step ran on it`
    : null;
}

/** A temporary worktree of `root` at `revision`, removed when disposed. */
function worktree(
  root: string,
  revision: string,
): (Disposable & { dir: string }) | null {
  const scratch = mkdtempSync(join(tmpdir(), "jig-release-pr-"));
  const dir = join(scratch, "tree");
  const cleanup = registerCleanup(() => {
    git(root, ["worktree", "remove", "--force", dir]);
    rmSync(scratch, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  });
  // The empty scratch folder as the hooks path: no repository hook runs on
  // the checkout.
  const added = git(root, [
    "-c",
    `core.hooksPath=${scratch}`,
    "worktree",
    "add",
    "--detach",
    "--quiet",
    dir,
    revision,
  ]);
  if (added === null) {
    cleanup[Symbol.dispose]();
    return null;
  }
  return { dir, [Symbol.dispose]: () => cleanup[Symbol.dispose]() };
}

type Kind =
  | "a file"
  | "an executable file"
  | "a symbolic link"
  | "a submodule"
  | "a directory";

/**
 * What git records for a path: its kind, and its content (a link's target,
 * never what it points to; a submodule's commit, never its files).
 */
interface Entry {
  kind: Kind;
  content: Buffer;
}

/** The kind each index mode records. */
const MODE_KINDS: Record<string, Kind> = {
  "100644": "a file",
  "100755": "an executable file",
  "120000": "a symbolic link",
  "160000": "a submodule",
};

/** What the index of `dir` records for each path it tracks: its kind and object id. */
function indexed(dir: string): Map<string, { kind: Kind; oid: string }> {
  const listing = git(dir, ["ls-files", "--stage", "-z"]);
  if (listing === null) refuse("git could not read the index");
  return new Map(
    paths(listing).flatMap((line) => {
      const match = /^(\d+) ([0-9a-f]+) \d\t(.+)$/s.exec(line);
      const kind = match ? MODE_KINDS[match[1] as string] : undefined;
      return match && kind
        ? [[match[3] as string, { kind, oid: match[2] as string }]]
        : [];
    }),
  );
}

/**
 * The entry at `path` in `dir`; null when nothing is there. A tracked path's
 * kind is what `index` records, so a file system without executable bits or
 * symbolic links reads the kind git commits; a submodule is its commit,
 * whether or not it is checked out.
 */
function entry(
  dir: string,
  path: string,
  index: Map<string, { kind: Kind; oid: string }>,
): Entry | null {
  const recorded = index.get(path);
  if (recorded?.kind === "a submodule")
    return { kind: recorded.kind, content: Buffer.from(recorded.oid) };
  const full = join(dir, path);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink())
    return {
      kind: recorded?.kind ?? "a symbolic link",
      content: Buffer.from(readlinkSync(full)),
    };
  if (!stat.isFile()) return { kind: "a directory", content: Buffer.alloc(0) };
  return {
    kind:
      recorded?.kind ?? (stat.mode & 0o111 ? "an executable file" : "a file"),
    content: readFileSync(full),
  };
}

/** `line` with every whole `previous` (not part of a longer version or name) replaced by `version`. */
export function withVersion(
  line: string,
  previous: string,
  version: string,
): string {
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const whole = new RegExp(
    `(?<![0-9A-Za-z.+-])${escaped}(?![0-9A-Za-z.+-])`,
    "g",
  );
  return line.replace(whole, () => version);
}

/**
 * The lines in which `branch` differs from `reproduced` beyond the version:
 * empty when both have as many lines and each of `branch`'s is the
 * reproduction's line, or that line with `previous` replaced by `version`
 * (`withVersion`). Otherwise the lines that differ, `- ` the reproduction's
 * (with the version replaced, when the line counts differ) and `+ ` the
 * branch's.
 */
export function linesBeyondVersion(
  reproduced: string,
  branch: string,
  previous: string,
  version: string,
): string[] {
  const a = reproduced.split("\n");
  const b = branch.split("\n");
  const bumped = a.map((line) => withVersion(line, previous, version));
  if (a.length !== b.length) return changedLines(bumped, b);
  return a.flatMap((line, i) => {
    const theirs = b[i] as string;
    return theirs === line || theirs === bumped[i]
      ? []
      : [`- ${line}`, `+ ${theirs}`];
  });
}

/** The lines between the common start and the common end of `a` and `b`, `- ` from `a` and `+ ` from `b`. */
function changedLines(a: string[], b: string[]): string[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(start, endA).map((l) => `- ${l}`),
    ...b.slice(start, endB).map((l) => `+ ${l}`),
  ];
}

/** What the reproduction of a release pull request found. */
export interface ReleasePullRequestCheck {
  findings: string[];
  /** The version and date reproduced; null when the reproduction did not finish. */
  reproduced: { version: string; date: string } | null;
}

/** The files the release step writes itself, which must match the reproduction exactly. */
function releaseWritten(
  config: ChangelogConfig,
  version: VersionSource,
  notes: string,
  stamped: string[],
): (path: string) => boolean {
  const own = new Set([
    config.file,
    ...(version.kind === "files" ? version.files.map((f) => f.path) : []),
    ...stamped,
  ]);
  return (path) => own.has(path) || isNoteFile(notes, path);
}

/** Why the release pull request cannot be reproduced, raised by a step of the check. */
class Refusal extends Error {}

function refuse(finding: string): never {
  throw new Refusal(finding);
}

/** The value `step` returns, refusing with `why` and its error when it throws. */
function orRefuse<T>(why: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    refuse(`${why}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reproduce the release pull request checked out at `root` on its merge base
 * with `base`, and compare. `today` is the day in UTC the check runs on.
 */
export function checkReleasePullRequest(
  root: string,
  base: string,
  today = new Date().toISOString().slice(0, 10),
): ReleasePullRequestCheck {
  try {
    return reproduce(root, base, today);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      findings: [`release pull request: ${error.message}`],
      reproduced: null,
    };
  }
}

/** The check `checkReleasePullRequest` makes; raises a `Refusal` where it cannot finish. */
function reproduce(
  root: string,
  base: string,
  today: string,
): ReleasePullRequestCheck {
  const mergeBase =
    git(root, ["merge-base", "HEAD", base])?.trim() ||
    refuse(
      `it cannot be compared with ${base} (no merge base): fetch it, or give a base git can find`,
    );
  const config =
    orRefuse("the changelog configuration at its merge base is invalid", () =>
      configAtBase(root, mergeBase),
    ) ??
    refuse(
      "its merge base holds no changelog section, so the release step releases nothing there",
    );
  const atMergeBase = (path: string) =>
    git(root, ["show", `${mergeBase}:${path}`]);
  const format = orRefuse(
    "the changelog configuration does not work at its merge base",
    () => resolveConfig(root, config, atMergeBase).format,
  );
  const { version, date } = newRelease(
    config.file,
    atMergeBase(config.file) ?? "",
    workingTree(root)(config.file) ?? "",
    format,
    today,
  );
  using tree = worktree(root, mergeBase);
  if (tree === null)
    refuse(`git could not check its merge base ${mergeBase} out`);
  const { result, written } = orRefuse(
    "the release step fails on its merge base",
    () => {
      const resolved = resolveConfig(tree.dir, config, workingTree(tree.dir));
      const result = releaseWithoutAfterVersion({ ...resolved, date });
      const written = releaseWritten(
        config,
        resolved.version,
        resolved.notes,
        result.stamped,
      );
      return { result, written };
    },
  );
  if (result.version !== version)
    refuse(
      result.version === null
        ? `the release step releases nothing on its merge base (no waiting note asks for a release), but ${config.file} gains ${version}`
        : `the release step releases ${result.version} on its merge base, but ${config.file} gains ${version}`,
    );
  const candidates = candidatePaths(root, tree.dir, mergeBase);
  const ourIndex = indexed(tree.dir);
  const theirIndex = indexed(root);
  const findings = candidates.flatMap((path) => {
    const ours = entry(tree.dir, path, ourIndex);
    const theirs = entry(root, path, theirIndex);
    if (ours !== null && theirs !== null && ours.kind !== theirs.kind)
      return [
        `${path}: the branch makes it ${theirs.kind}, where re-running the release step on its merge base leaves ${ours.kind}`,
      ];
    if (ours === null ? theirs === null : theirs?.content.equals(ours.content))
      return [];
    if (ours?.kind === "a submodule" && theirs !== null)
      return [
        `${path}: the branch moves the submodule to commit ${theirs.content}, which re-running the release step on its merge base does not`,
      ];
    return difference(path, ours?.content ?? null, theirs?.content ?? null, {
      written: written(path),
      afterVersion: config.afterVersion !== null,
      previous: result.previous,
      version,
    });
  });
  return {
    findings: findings.map((f) => `release pull request: ${f}`),
    reproduced: { version, date },
  };
}

/** The one release heading `branch` gains over `atMergeBase` in `file`, with the day it dates. */
function newRelease(
  file: string,
  atMergeBase: string,
  branch: string,
  format: Format,
  today: string,
): { version: string; date: string } {
  const headings = newHeadings(atMergeBase, branch, format);
  if (headings.length !== 1)
    refuse(
      headings.length
        ? `${file} gains ${headings.length} release headings (${headings.map((h) => h.version).join(", ")}); the release step writes one`
        : `${file} gains no release heading; the release step opens a release pull request only for a release`,
    );
  const [heading] = headings as [{ version: string; title: string }];
  const date = headingDate(heading.title);
  const why = date === null ? "it gives no date" : dateRefusal(date, today);
  if (date === null || why !== null)
    refuse(
      `the new heading "## ${heading.title}" cannot date the release: ${why}`,
    );
  return { version: heading.version, date };
}

/**
 * Every path the reproduction in `dir` or the branch at `root` changes from
 * `mergeBase`, untracked files included, sorted.
 */
function candidatePaths(
  root: string,
  dir: string,
  mergeBase: string,
): string[] {
  if (git(dir, ["add", "-A"]) === null)
    refuse("git could not list what the reproduction changed");
  const listings = [
    git(dir, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"]),
    git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  if (listings.includes(null))
    refuse("git could not list what the branch changes");
  return [...new Set(listings.flatMap(paths))].sort();
}

/**
 * `content` as UTF-8 text; null when it is not valid UTF-8. A lenient decode
 * would read every invalid byte as U+FFFD, so two files differing only in
 * such bytes would read the same; a byte order mark is kept, so a file
 * gaining or losing one differs.
 */
function utf8(content: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      content,
    );
  } catch (err) {
    swallow(err, "not valid UTF-8: compared as bytes only");
    return null;
  }
}

/**
 * Why a file that differs from the reproduction, byte for byte, fails the
 * release pull request; empty when it may differ.
 */
function difference(
  path: string,
  ours: Buffer | null,
  theirs: Buffer | null,
  how: {
    written: boolean;
    afterVersion: boolean;
    previous: string;
    version: string;
  },
): string[] {
  const rerun = "re-running the release step on its merge base";
  if (ours === null || theirs === null)
    return [
      `${path}: the branch ${theirs === null ? "deletes" : "adds"} it, which ${rerun} does not`,
    ];
  if (how.written)
    return [
      `${path}: differs from what ${rerun} writes; the release branch is regenerated, never edited: put a wording change in the note`,
    ];
  if (!how.afterVersion)
    return [`${path}: changed, which ${rerun} does not change`];
  const ourText = utf8(ours);
  const theirText = utf8(theirs);
  if (ourText === null || theirText === null)
    return [
      `${path}: changed, and is not UTF-8 text, so it cannot differ only by ${how.previous} becoming ${how.version} in its lines`,
    ];
  const beyond = linesBeyondVersion(
    ourText,
    theirText,
    how.previous,
    how.version,
  );
  if (!beyond.length) return [];
  const shown = beyond.slice(0, SHOWN_LINES).join("\n    ");
  const more =
    beyond.length > SHOWN_LINES
      ? `\n    and ${beyond.length - SHOWN_LINES} more`
      : "";
  return [
    `${path}: changed beyond ${how.previous} becoming ${how.version} in its lines, the only change after_version may make:\n    ${shown}${more}`,
  ];
}
