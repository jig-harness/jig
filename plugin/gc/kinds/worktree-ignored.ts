/**
 * Which of a worktree's ignored content a rule accounts for. Ignored content
 * is the one part of a worktree git cannot give back, so only content
 * marked as rebuildable or disposable where it is written is set aside, each
 * path with the rule that set it aside; everything else stays `other`, which
 * vetoes collection unless it is preserved first.
 */
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { detectPackageManager } from "../../shared/detect/package-manager.ts";
import {
  CACHEDIR_TAG,
  CACHEDIR_TAG_SIGNATURE,
  HANDOFF_MACHINE_BLOCK,
  SCRATCH_DIR,
} from "../../shared/disposable-mark.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/**
 * The rule that set an ignored path aside:
 * - `cache-tag`: under a directory holding a `CACHEDIR.TAG` with its
 *   signature, the mark Jig's working directories and other tools' caches
 *   carry;
 * - `self-ignoring`: under a directory whose own `.gitignore` ignores all of
 *   it, the convention a tool writes for its cache;
 * - `jig-scratch`: under `.context/scratch/`, where Jig's procedures write
 *   the files they never need again;
 * - `drive-handoff`: a drive handoff (`.context/pr-drive-<PR>.md`) whose
 *   machine block the drive wrote;
 * - `empty`: a directory with nothing in it.
 */
export type SetAsideRule =
  | "cache-tag"
  | "self-ignoring"
  | "jig-scratch"
  | "drive-handoff"
  | "empty";
export interface SetAside {
  path: string;
  rule: SetAsideRule;
}
/**
 * Ignored paths by what accounts for them: `rebuildable`, a detected package
 * manager's dependency directory, rebuilt from a tracked lockfile;
 * `setAside`, content marked disposable where it is written; `other`,
 * everything else, which no rule accounts for.
 */
export interface IgnoredContent {
  rebuildable: string[];
  setAside: SetAside[];
  other: string[];
}
/** The ignored-content scan's failure once its deadline has passed. */
type Late = { ok: false; failure: { code: "timed-out"; reason: string } };
function late(deadline: number): Late | null {
  return Date.now() > deadline
    ? failed("timed-out", "Ignored-content scan exceeded its deadline")
    : null;
}
function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
/** Whether `path` is a regular file, never following a link. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
/** Whether `path` is a directory, never following a link. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
/** The first `length` bytes of a regular file, as text. */
function head(path: string, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
/** Whether a directory carries a cache directory tag with its signature. */
function cacheTagged(directory: string): boolean {
  const tag = join(directory, CACHEDIR_TAG);
  return (
    isFile(tag) &&
    head(tag, CACHEDIR_TAG_SIGNATURE.length) === CACHEDIR_TAG_SIGNATURE
  );
}
/** Whether a directory's own `.gitignore` ignores everything in it, and nothing else. */
function selfIgnoring(directory: string): boolean {
  const file = join(directory, ".gitignore");
  if (!isFile(file)) return false;
  const patterns = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return patterns.length === 1 && patterns[0] === "*";
}
/** The rule that marks one directory (a path relative to `root`, no trailing slash) as disposable. */
function directoryMark(root: string, directory: string): SetAsideRule | null {
  const absolute = join(root, directory);
  if (!isDirectory(absolute)) return null;
  if (directory === SCRATCH_DIR) return "jig-scratch";
  if (cacheTagged(absolute)) return "cache-tag";
  if (selfIgnoring(absolute)) return "self-ignoring";
  return null;
}
/** The mark of the nearest marked directory above an entry, if any. */
function ancestorMark(
  root: string,
  entry: string,
  marks: Map<string, SetAsideRule | null>,
): SetAsideRule | null {
  const parts = entry.replace(/\/$/, "").split("/");
  for (let depth = 1; depth < parts.length; depth++) {
    const directory = parts.slice(0, depth).join("/");
    if (!marks.has(directory))
      marks.set(directory, directoryMark(root, directory));
    const mark = marks.get(directory);
    if (mark) return mark;
  }
  return null;
}
/** Whether a file is a drive handoff the drive wrote. */
function driveHandoff(root: string, entry: string): boolean {
  if (!/^\.context\/pr-drive-\d+\.md$/.test(entry)) return false;
  const path = join(root, entry);
  return (
    isFile(path) &&
    head(path, 4096).split(/\r?\n/).includes(HANDOFF_MACHINE_BLOCK)
  );
}
/**
 * Whether `directory` (a path under `root`) holds nothing but dependency
 * directories: the shape of a wholly ignored workspace folder that git
 * reports as one collapsed entry, hiding the `node_modules` inside it. A
 * symbolic link or any other file is local state and fails it. The walk
 * is bounded by `deadline` (checked on entering a directory and per entry,
 * like `worktreeActivity`) and fails `timed-out` when it passes, so a huge
 * ignored cache cannot hold the collector.
 */
function onlyDependencyDirectories(
  directory: string,
  deadline: number,
): Outcome<boolean, "timed-out"> {
  const entering = late(deadline);
  if (entering) return entering;
  const children = readdirSync(directory);
  if (children.length === 0) return ok(false);
  for (const child of children) {
    const passed = late(deadline);
    if (passed) return passed;
    const path = join(directory, child);
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return ok(false);
    if (child === "node_modules") continue;
    const nested = onlyDependencyDirectories(path, deadline);
    if (!nested.ok || !nested.value) return nested;
  }
  return ok(true);
}
/** Whether the root holds a manifest and a recognised lockfile to rebuild from. */
function rebuildInputs(root: string): boolean {
  if (detectPackageManager(root).found === null) return false;
  return isFile(join(root, "package.json"));
}
/**
 * Whether one ignored entry is a dependency directory: a directory named
 * `node_modules`, or a collapsed one holding nothing but dependency
 * directories.
 */
function dependencyEntry(
  root: string,
  path: string,
  deadline: number,
): Outcome<boolean, "timed-out"> {
  if (!path.endsWith("/")) return ok(false);
  const directory = path.slice(0, -1);
  if (directory.split("/").pop() === "node_modules") return ok(true);
  return onlyDependencyDirectories(join(root, directory), deadline);
}
interface Scan {
  root: string;
  inputs: boolean;
  deadline: number;
  marks: Map<string, SetAsideRule | null>;
}
function empty(): IgnoredContent {
  return { rebuildable: [], setAside: [], other: [] };
}
function merge(into: IgnoredContent, from: IgnoredContent): void {
  into.rebuildable.push(...from.rebuildable);
  into.setAside.push(...from.setAside);
  into.other.push(...from.other);
}
/**
 * A collapsed directory no mark covers, read entry by entry so that marked
 * content inside it is set aside and the rest is named. A subtree nothing in
 * accounts for stays one entry, so a reason names it once.
 */
function unmarkedDirectory(
  scan: Scan,
  entry: string,
): Outcome<IgnoredContent, "timed-out"> {
  const entering = late(scan.deadline);
  if (entering) return entering;
  const directory = entry.slice(0, -1);
  const children = readdirSync(join(scan.root, directory));
  if (children.length === 0)
    return ok({ ...empty(), setAside: [{ path: entry, rule: "empty" }] });
  const found = empty();
  for (const child of children.sort()) {
    const passed = late(scan.deadline);
    if (passed) return passed;
    const path = `${directory}/${child}`;
    const nested = readableEntry(
      scan,
      isDirectory(join(scan.root, path)) ? `${path}/` : path,
      false,
    );
    if (!nested.ok) return nested;
    merge(found, nested.value);
  }
  if (found.rebuildable.length === 0 && found.setAside.length === 0)
    return ok({ ...empty(), other: [entry] });
  return ok(found);
}
/**
 * One entry, where a path the platform cannot read (no permission, gone
 * since git listed it) is content no rule accounts for: it is named and
 * vetoes, rather than failing the whole proof.
 */
function readableEntry(
  scan: Scan,
  entry: string,
  checkAncestors: boolean,
): Outcome<IgnoredContent, "timed-out"> {
  try {
    return classifyEntry(scan, entry, checkAncestors);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code !== "string") throw error;
    return ok({ ...empty(), other: [entry] });
  }
}
/** One ignored entry, `/`-terminated when it is a directory. */
function classifyEntry(
  scan: Scan,
  entry: string,
  checkAncestors: boolean,
): Outcome<IgnoredContent, "timed-out"> {
  const dependency = scan.inputs
    ? dependencyEntry(scan.root, entry, scan.deadline)
    : ok(false);
  if (!dependency.ok) return dependency;
  if (dependency.value) return ok({ ...empty(), rebuildable: [entry] });
  const above = checkAncestors
    ? ancestorMark(scan.root, entry, scan.marks)
    : null;
  if (above)
    return ok({ ...empty(), setAside: [{ path: entry, rule: above }] });
  if (entry.endsWith("/")) {
    const own = directoryMark(scan.root, entry.slice(0, -1));
    if (own) return ok({ ...empty(), setAside: [{ path: entry, rule: own }] });
    return unmarkedDirectory(scan, entry);
  }
  if (driveHandoff(scan.root, entry))
    return ok({
      ...empty(),
      setAside: [{ path: entry, rule: "drive-handoff" }],
    });
  return ok({ ...empty(), other: [entry] });
}
/**
 * Classify the ignored entries git lists for a worktree (`--directory`, so a
 * wholly ignored directory is one `/`-terminated entry). Dependency
 * directories count wherever they sit (a monorepo's nested `node_modules`
 * too), rebuildable from the root's `package.json` and the lockfile
 * `detectPackageManager` found; only a real directory counts, so an ignored
 * file or link named `node_modules` stays local state. A mark counts only as
 * the writer leaves it: a tool's cache by the tag or the `.gitignore` it
 * writes inside its directory, never by its name, and Jig's own working files
 * by `.context/scratch/`, a tag, or a handoff's machine block. A link is
 * never followed. The walk fails `timed-out` once `deadline` passes.
 */
export function classifyIgnored(
  root: string,
  paths: string[],
  deadline = Date.now() + 30_000,
): Outcome<IgnoredContent, "timed-out"> {
  const scan: Scan = {
    root,
    inputs: rebuildInputs(root),
    deadline,
    marks: new Map(),
  };
  const content = empty();
  for (const path of paths) {
    const passed = late(deadline);
    if (passed) return passed;
    const entry = readableEntry(scan, path, true);
    if (!entry.ok) return entry;
    merge(content, entry.value);
  }
  return ok(content);
}
