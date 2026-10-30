/**
 * Read-only access to the repository under audit: its tracked files, its
 * commits, the files a configured path reaches, and the plugin's installed
 * versions. Commands run through the detector's `run` (`shared/detect.ts`).
 *
 * A probe reads tracked files only, so an untracked scratch file or an ignored
 * build output never counts as a practice the repository has, and a draft
 * record refuses a checkout whose tracked files differ from the commit it
 * names. A derivation reads the checkout as the skills would run in it, and
 * flags a configured program that is present but not tracked.
 */
import {
  manifestVersion,
  pluginVersion,
} from "../../../../shared/plugin-version.ts";
import { run } from "../../../../shared/detect.ts";
import {
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
  win32,
} from "node:path";

export { trackedFiles } from "../../../adr/scripts/locate.ts";
export { pluginVersion, run };

/**
 * Whether the repository at `root` holds `commit`: a record or report naming
 * a commit it does not have was made for another repository.
 */
export function hasCommit(root: string, commit: string): boolean {
  return (
    run("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root }).code ===
    0
  );
}

/**
 * Whether `path` matches `glob`, ignoring letter case: repositories spell
 * `AGENTS.md`, `Agents.md` and `agents.md` alike, and a probe asks whether
 * the file exists, not how it is capitalised. A glob without a `/` matches
 * at the repository root only; write `**\/<name>` to match anywhere.
 */
export function matchGlob(glob: string, path: string): boolean {
  return new Bun.Glob(glob.toLowerCase()).match(path.toLowerCase());
}

/** This skill's own directory, wherever the plugin was installed. */
export function skillDir(): string {
  return dirname(dirname(import.meta.dir));
}

/** Whether `dir` holds an installed plugin of `version`: a manifest that names it. */
function installedAs(dir: string, version: string): boolean {
  return (
    statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
    manifestVersion(dir) === version
  );
}

/** Compare two `major.minor.patch` versions; `next` sorts last, a malformed one first. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    if (v === NEXT_VERSION) return [Number.POSITIVE_INFINITY, 0, 0];
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return match ? match.slice(1).map(Number) : [-1, -1, -1];
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/**
 * What a `since` names before its release: a branch cannot know the version
 * it ships in, so the release step (changes/README.md) writes it.
 */
export const NEXT_VERSION = "next";
/** Whether `value` is a `since`: a version, or `next` before the release. */
export function isSince(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === NEXT_VERSION || VERSION_PATTERN.test(value))
  );
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `v` is a real calendar date written YYYY-MM-DD. */
export function isDate(v: string): boolean {
  if (!DATE_PATTERN.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(v);
}

/** Today's date on this machine, as YYYY-MM-DD. */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A newer version of this plugin installed beside the one running, or
 * `null`. Plugin caches keep each version in a folder named after it
 * (`<plugin>/<version>/skills/…`); a session keeps the version it started
 * with, so an update reaches the next session, not this one. A folder counts
 * only with a manifest naming its version: an interrupted install or a stray
 * file is nothing a restart could load. `pluginDir` is the running plugin's
 * root; a checkout has no version folders beside it.
 */
export function newerInstalledVersion(
  pluginDir = join(skillDir(), "..", ".."),
  running = pluginVersion(),
): string | null {
  if (running === null) return null;
  let siblings: string[];
  try {
    siblings = readdirSync(dirname(pluginDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const newer = siblings
    .filter(
      (v) =>
        VERSION_PATTERN.test(v) &&
        compareVersions(v, running) > 0 &&
        installedAs(join(dirname(pluginDir), v), v),
    )
    .sort(compareVersions);
  return newer.at(-1) ?? null;
}

/**
 * The file a configured setting names from `root`: absolute as written,
 * relative joined to the root, the way the scripts reading a setting
 * resolve it (`join` collapses `link/..` by text).
 */
export function configuredAt(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * The file a command-named `path` reaches from `root`, without normalizing
 * it: a shell running the command from the root follows `link` before `..`.
 */
export function onDisk(root: string, path: string): string {
  return isAbsolute(path) ? path : `${root}${sep}${path}`;
}

/** A repository-relative name for `path`, or null outside the repository. */
function inRepo(realRoot: string, path: string): string | null {
  const name = relative(realRoot, path).replaceAll("\\", "/");
  return name === "" ||
    name === ".." ||
    name.startsWith("../") ||
    isAbsolute(name)
    ? null
    : name;
}

/**
 * `segment` of the real directory `dir` as the directory itself spells it:
 * on a case-insensitive file system `CHECK.ts` reaches the entry
 * `check.ts`, and the tracked name is the entry's. The file system names
 * the entry its own lookup chose (`realpath`), so no comparison is
 * emulated here. A symbolic link cannot be asked without following it, so
 * it is named by its exact spelling, else by every entry here of the same
 * file: hard links of one link are indistinguishable without comparing
 * names, and any of them may be the one the lookup chose.
 */
function spelled(dir: string, segment: string, link: boolean): string[] {
  const entry = join(dir, segment);
  if (!link) return [realpathSync.native(entry)];
  const names = readdirSync(dir);
  if (names.includes(segment)) return [entry];
  const own = lstatSync(entry, { bigint: true });
  if (own.ino === 0n) return [entry];
  const same = names.filter((name) => {
    const other = lstatSync(join(dir, name), {
      bigint: true,
      throwIfNoEntry: false,
    });
    return other?.ino === own.ino && other.dev === own.dev;
  });
  // Directory order is unspecified; sorted, the alternatives read the same
  // on every file system.
  return same.length === 0
    ? [entry]
    : same.sort().map((name) => join(dir, name));
}

/** Links a resolution expands before giving up, as the kernel's SYMLOOP limit does. */
const MAX_LINKS = 40;

/** The components of `path` in order, after its root when it has one. */
function components(path: string): string[] {
  return path
    .slice(parse(path).root.length)
    .split(process.platform === "win32" ? /[\\/]/ : "/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * The repository names a fresh clone needs for the relative `name` to reach
 * from `root` the file it reaches here: every link the resolution passes
 * through, by its own location, including links inside another link's
 * target, and the file it lands on, by its real location. Resolved the way
 * the platform resolves it: on POSIX component by component, so `..` climbs
 * out of where a link led; on Windows `..` is collapsed by text first.
 * Every name is the file system's spelling of what it reaches, never the
 * command's. Each need is a list of alternatives, the names the entry
 * reached may have: a link with several names here may be any of them
 * (`spelled`), and which one cannot be told. Inside the repository only; a
 * path that does not resolve, or loops, needs nothing.
 */
export function namesReached(root: string, name: string): string[][] {
  const realRoot = realpathSync.native(root);
  const pending = components(
    process.platform === "win32" ? win32.normalize(name) : name,
  );
  const names: string[][] = [];
  let real = realRoot;
  let links = 0;
  for (
    let segment = pending.shift();
    segment !== undefined;
    segment = pending.shift()
  ) {
    if (segment === "..") {
      real = dirname(real);
      continue;
    }
    const stat = lstatSync(join(real, segment), { throwIfNoEntry: false });
    if (stat === undefined) return [];
    const entries = spelled(real, segment, stat.isSymbolicLink());
    if (!stat.isSymbolicLink()) {
      real = entries[0] as string;
      continue;
    }
    if (++links > MAX_LINKS) return [];
    const link = entries.flatMap((entry) => inRepo(realRoot, entry) ?? []);
    if (link.length > 0) names.push(link);
    const target = readlinkSync(join(real, segment));
    if (isAbsolute(target)) real = parse(target).root;
    pending.unshift(...components(target));
  }
  const file = inRepo(realRoot, real);
  if (file !== null) names.push([file]);
  return names;
}

/**
 * The needs of `namesReached` a fresh clone holding `tracked` lacks: none
 * of the names tracked, or, for a need with several names, only some. The
 * lookup took one of those and cannot be asked which, so the tracked name
 * may not be the one it took.
 */
export function trackedNeeds(
  root: string,
  name: string,
  tracked: Set<string>,
): { untracked: string[][]; unsure: { reached: string[]; held: string[] }[] } {
  const untracked: string[][] = [];
  const unsure: { reached: string[]; held: string[] }[] = [];
  for (const reached of namesReached(root, name)) {
    const held = reached.filter((alternative) => tracked.has(alternative));
    if (held.length === 0) untracked.push(reached);
    else if (held.length < reached.length) unsure.push({ reached, held });
  }
  return { untracked, unsure };
}
