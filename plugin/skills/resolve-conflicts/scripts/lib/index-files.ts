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

/** The stage-0 entries by path, and the paths that are only conflict stages. */
function indexEntries(root: string): {
  staged: Map<string, Entry>;
  unmerged: Set<string>;
} {
  const staged = new Map<string, Entry>();
  const unmerged = new Set<string>();
  for (const record of splitNul(git(root, ["ls-files", "--stage", "-z"]))) {
    const match = record.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
    if (!match) continue;
    const [, mode = "", blob = "", stage = "", path = ""] = match;
    if (stage === "0") staged.set(path, { mode, blob });
    else unmerged.add(path);
  }
  return { staged, unmerged };
}

/** A path's components, the empty and `.` ones dropped. */
function components(path: string): string[] {
  return path.split("/").filter((name) => name !== "" && name !== ".");
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
  return target.startsWith("/")
    ? { problem: `${at} links outside the repository` }
    : components(target);
}

/**
 * The file a read of `path` (repository-relative) reaches, each symbolic link
 * on the way followed through the link entries the index holds, or why it
 * cannot be reached. Components are taken in the order the system takes them,
 * and a `..` steps out of the directory reached so far.
 */
function walk(
  root: string,
  path: string,
  staged: ReadonlyMap<string, Entry>,
  unmerged: ReadonlySet<string>,
): { file: string } | { problem: string } | { unmerged: string } {
  const pending = components(path);
  const reached: string[] = [];
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === "..") {
      if (reached.pop() === undefined)
        return { problem: `${path} leaves the repository` };
      continue;
    }
    reached.push(name);
    const at = reached.join("/");
    const entry = staged.get(at);
    // A conflicted component may be a link: where it leads is not known yet.
    if (entry === undefined && unmerged.has(at)) return { unmerged: at };
    if (entry?.mode !== SYMLINK_MODE) continue;
    const target = linkComponents(root, entry, at, ++hops);
    if ("problem" in target) return target;
    reached.pop();
    pending.unshift(...target);
  }
  return reached.length === 0
    ? { problem: `${path} names no file` }
    : { file: reached.join("/") };
}

/** The file a read of `path` opens in the index. */
export function readIndexFile(root: string, path: string): IndexRead {
  const { staged, unmerged } = indexEntries(root);
  const reached = walk(root, path, staged, unmerged);
  if ("problem" in reached)
    return { found: "unreadable", reason: reached.problem };
  if ("unmerged" in reached)
    return { found: "unmerged", path: reached.unmerged };
  const { file } = reached;
  const entry = staged.get(file);
  if (entry === undefined) return { found: "absent" };
  if (entry.mode !== "100644" && entry.mode !== "100755")
    return { found: "unreadable", reason: `${file} is not a regular file` };
  return { found: "file", text: readBlob(root, entry.blob) };
}
