/**
 * Read a file the way the commit will carry it: from the index, never the
 * working tree. Paths are git's: `/` separates components and every other
 * character, a backslash included, belongs to a name.
 */
import { git, readBlob, splitNul } from "./git.ts";

/** Hops after which a chain of symbolic links counts as a loop. */
const MAX_LINK_HOPS = 40;

const SYMLINK_MODE = "120000";

/** What the index holds at a path. */
export type IndexRead =
  | { found: "file"; text: string }
  | { found: "absent" }
  | { found: "unmerged"; path: string }
  | { found: "unreadable"; reason: string };

interface Entry {
  mode: string;
  blob: string;
}

/** What the index holds, by path. */
interface Index {
  /** The stage-0 entries. */
  staged: Map<string, Entry>;
  /** The paths that are only conflict stages. */
  unmerged: Set<string>;
  /** Every directory an entry lies in. */
  directories: Set<string>;
}

function indexEntries(root: string): Index {
  const staged = new Map<string, Entry>();
  const unmerged = new Set<string>();
  const directories = new Set<string>();
  for (const record of splitNul(git(root, ["ls-files", "--stage", "-z"]))) {
    const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
    if (!match) continue;
    const [, mode = "", blob = "", stage = "", path = ""] = match;
    if (stage === "0") staged.set(path, { mode, blob });
    else unmerged.add(path);
    for (let slash = path.indexOf("/"); slash !== -1; ) {
      directories.add(path.slice(0, slash));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return { staged, unmerged, directories };
}

/**
 * A path's components, the empty ones dropped. A trailing `/` becomes a
 * trailing `.`: like `.` and `..`, it requires what comes before it to be a
 * directory.
 */
function components(path: string): string[] {
  const names = path.split("/").filter((name) => name !== "");
  return path.endsWith("/") && names.length > 0 ? [...names, "."] : names;
}

/** The components a link at `at` leads to, or why they cannot be followed. */
function linkComponents(
  root: string,
  entry: Entry,
  at: string,
  hops: number,
): string[] | { problem: string } {
  if (hops > MAX_LINK_HOPS)
    return {
      problem: `${at} passes through more than ${MAX_LINK_HOPS} symbolic links`,
    };
  const target = readBlob(root, entry.blob);
  if (target === "") return { problem: `${at} is a link with no target` };
  // Absolute: a POSIX path, or a drive path as Git for Windows records one.
  return /^(\/|[A-Za-z]:[\\/])/.test(target)
    ? { problem: `${at} links outside the repository` }
    : components(target);
}

/**
 * How a read of `path` that goes on through `at` (no link) ends: through a
 * file it fails, through a directory the index does not hold it finds nothing
 * (`null`); `undefined` when `at` is a directory and the read goes on.
 */
function readThrough(
  path: string,
  at: string,
  entry: Entry | undefined,
  directories: ReadonlySet<string>,
): { problem: string } | null | undefined {
  if (entry !== undefined)
    return { problem: `${path} reads through ${at}, which is not a directory` };
  return directories.has(at) ? undefined : null;
}

/** How a walk ends: the file reached, why it cannot be, or nothing there. */
type Walked =
  | { file: string }
  | { problem: string }
  | { unmerged: string }
  | null;

/** A walk under way: the components still to take and those taken. */
interface Walk {
  path: string;
  pending: string[];
  reached: string[];
  hops: number;
}

/**
 * Take the walk's next component: `undefined` while it goes on, else how it
 * ends. A link's target components are taken next, in its place.
 */
function step(root: string, walk: Walk, index: Index): Walked | undefined {
  const { path, pending, reached } = walk;
  const name = pending.shift() as string;
  // What `.` and `..` follow was read through as a directory already.
  if (name === ".") return undefined;
  if (name === "..")
    return reached.pop() === undefined
      ? { problem: `${path} leaves the repository` }
      : undefined;
  reached.push(name);
  const at = reached.join("/");
  const entry = index.staged.get(at);
  // A conflicted component may be a link: where it leads is not known yet.
  if (entry === undefined && index.unmerged.has(at)) return { unmerged: at };
  if (entry?.mode !== SYMLINK_MODE)
    return pending.length > 0
      ? readThrough(path, at, entry, index.directories)
      : undefined;
  const target = linkComponents(root, entry, at, ++walk.hops);
  if ("problem" in target) return target;
  reached.pop();
  pending.unshift(...target);
  return undefined;
}

/**
 * The file a read of `path` (repository-relative) reaches, each symbolic link
 * on the way followed through the link entries the index holds, or why it
 * cannot be reached. Components are taken in the order the system takes them,
 * and a `..` steps out of the directory reached so far. A component a later
 * one is read through must be a directory the index holds: through a file the
 * read fails, through a missing directory it finds nothing (`null`).
 */
function walk(root: string, path: string, index: Index): Walked {
  const state: Walk = { path, pending: components(path), reached: [], hops: 0 };
  while (state.pending.length > 0) {
    const ended = step(root, state, index);
    if (ended !== undefined) return ended;
  }
  return state.reached.length === 0
    ? { problem: `${path} names no file` }
    : { file: state.reached.join("/") };
}

/** The file a read of `path` opens in the index. */
export function readIndexFile(root: string, path: string): IndexRead {
  const index = indexEntries(root);
  const reached = walk(root, path, index);
  if (reached === null) return { found: "absent" };
  if ("problem" in reached)
    return { found: "unreadable", reason: reached.problem };
  if ("unmerged" in reached)
    return { found: "unmerged", path: reached.unmerged };
  const { file } = reached;
  const entry = index.staged.get(file);
  if (entry === undefined)
    return index.directories.has(file)
      ? { found: "unreadable", reason: `${file} is a directory` }
      : { found: "absent" };
  if (entry.mode !== "100644" && entry.mode !== "100755")
    return { found: "unreadable", reason: `${file} is not a regular file` };
  return { found: "file", text: readBlob(root, entry.blob) };
}
