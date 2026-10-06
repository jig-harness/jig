import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cli } from "../../lib/cli.ts";
import { LEAKY_GIT_ENV, spawnSync } from "../../lib/guarded-git-spawn.ts";
import {
  digest,
  inventory,
  MANIFEST,
  record,
  releaseExcluded,
  safePath,
  type FileRecord,
  verify,
} from "./integrity.ts";
import { locked } from "./lock.ts";
import { type Overlay, render, skillName, validateOverlay } from "./render.ts";
import { release } from "./release.ts";

export interface Pin {
  version: string;
  repository: string;
  revision: string;
  manifest: string;
}
interface Installed {
  path: string;
  target?: string;
  file?: FileRecord;
}
interface InstallLock {
  schema: 1;
  fingerprint: string;
  release: string;
  manifest: string;
  skills: string[];
  entries: Installed[];
  /**
   * Set while an install is publishing; a lock left pending means an interrupted
   * run. `entries` is what the run planned to publish and `previous` holds the
   * record sets it replaces. A discovery path counts as owned only where disk
   * matches one of those sets exactly.
   */
  pending?: true;
  previous?: Installed[][];
}
export interface Options {
  consumer: string;
  pin: Pin;
  overlay: Overlay;
  cache?: string;
  local?: string;
  check?: boolean;
  copies?: boolean;
}
const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
};
function plainParents(root: string, path: string): void {
  const parts = path.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (
      present(current) &&
      (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
    )
      throw new Error(
        `installation parent is not a real directory: ${current}`,
      );
  }
}
export function validatePin(pin: Pin): void {
  if (
    !pin ||
    typeof pin.version !== "string" ||
    typeof pin.revision !== "string" ||
    typeof pin.manifest !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(pin.version) ||
    !/^[a-f0-9]{40}$/.test(pin.revision) ||
    !/^[a-f0-9]{64}$/.test(pin.manifest) ||
    typeof pin.repository !== "string" ||
    !pin.repository ||
    pin.repository.startsWith("-")
  )
    throw new Error(
      "pin requires version, repository, full Git revision and SHA-256 manifest digest",
    );
}
export const defaultCache = (): string =>
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "groundwork");
async function cached(options: Options): Promise<string> {
  const { pin } = options;
  if (options.local) {
    const source = resolve(options.local);
    if (existsSync(join(source, MANIFEST))) {
      verify(source);
      return source;
    }
    const inputs = ["skills", "lib", "tools"].flatMap((part) =>
      existsSync(join(source, part))
        ? inventory(
            join(source, part),
            part === "skills" ? releaseExcluded : undefined,
          ).map((file) => ({
            ...file,
            path: `${part}/${file.path}`,
          }))
        : [],
    );
    for (const path of ["package.json", "bun.lock", "bun.lockb", "mise.toml"])
      if (existsSync(join(source, path))) inputs.push(record(source, path));
    const cache = resolve(options.cache ?? defaultCache());
    const path = join(cache, `local-${digest(JSON.stringify(inputs))}`);
    if (present(path)) {
      verify(path);
      return path;
    }
    if (options.check) throw new Error("local working tree changed; reinstall");
    mkdirSync(cache, { recursive: true });
    return locked(`${path}.lock`, async () => {
      if (present(path)) {
        verify(path);
        return path;
      }
      const temp = mkdtempSync(join(cache, ".local-"));
      try {
        await release(source, join(temp, "release"), "local");
        verify(join(temp, "release"));
        renameSync(join(temp, "release"), path);
        return path;
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  }
  const cache = resolve(options.cache ?? defaultCache()),
    path = join(cache, `${pin.version}-${pin.manifest}`);
  if (present(path)) {
    if (verify(path, pin.manifest).version !== pin.version)
      throw new Error("release version mismatch");
    return path;
  }
  if (options.check) throw new Error(`pinned release is not cached: ${path}`);
  mkdirSync(cache, { recursive: true });
  return locked(`${path}.lock`, async () => {
    if (present(path)) {
      if (verify(path, pin.manifest).version !== pin.version)
        throw new Error("release version mismatch");
      return path;
    }
    const temp = mkdtempSync(join(cache, ".fetch-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
      ),
    );
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { env, timeout: 120_000 });
      if (result.status !== 0)
        throw new Error(
          `release fetch failed: ${result.stderr || result.error?.message}`,
        );
      return result.stdout.trim();
    };
    try {
      const checkout = join(temp, "checkout");
      git(["init", checkout]);
      git(["-C", checkout, "remote", "add", "origin", pin.repository]);
      git(["-C", checkout, "fetch", "--depth=1", "origin", pin.revision]);
      // info/attributes outranks attributes inside the fetched tree, so checkout
      // conversions (eol, filters, ident, encodings) cannot alter the pinned bytes.
      const attributes = resolve(
        checkout,
        git(["-C", checkout, "rev-parse", "--git-path", "info/attributes"]),
      );
      mkdirSync(dirname(attributes), { recursive: true });
      writeFileSync(
        attributes,
        "* -text -crlf -eol -filter -ident -working-tree-encoding\n",
      );
      git([
        "-C",
        checkout,
        "-c",
        "core.symlinks=true",
        "-c",
        "core.autocrlf=false",
        "checkout",
        "--detach",
        "FETCH_HEAD",
      ]);
      if (git(["-C", checkout, "rev-parse", "HEAD"]) !== pin.revision)
        throw new Error("fetched wrong revision");
      const payload = join(checkout, "release");
      if (lstatSync(payload).isSymbolicLink())
        throw new Error("release directory is a symlink");
      const manifest = verify(payload, pin.manifest);
      if (manifest.version !== pin.version)
        throw new Error("release version mismatch");
      renameSync(payload, path);
      return path;
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

const DISCOVERY_SURFACES = [".claude", ".agents"];
const IGNORE_START =
  "# >>> groundwork (managed block, rewritten on install) >>>";
const IGNORE_END = "# <<< groundwork <<<";
/**
 * Rewrite the installer's own block of .gitignore lines. Ownership is the block
 * itself, so retiring a deselected skill's rule never touches a rule the project
 * wrote, and an interrupted run needs no record elsewhere. The file's line
 * endings are kept.
 */
function managedIgnore(text: string, wanted: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n",
    lines = text.split(/\r?\n/),
    start = lines.indexOf(IGNORE_START),
    end = start < 0 ? -1 : lines.indexOf(IGNORE_END, start + 1);
  const outside =
    end > start && start >= 0
      ? [...lines.slice(0, start), ...lines.slice(end + 1)]
      : lines;
  const theirs = new Set(outside),
    add = wanted.filter((line) => !theirs.has(line));
  let body = outside.join(eol);
  if (!add.length) return body;
  if (body && !body.endsWith(eol)) body += eol;
  return `${body}${[IGNORE_START, ...add, IGNORE_END].join(eol)}${eol}`;
}
/**
 * Replace a file by writing beside it and renaming, so a failure keeps the
 * original. The temp file is created exclusively: a planted link or an existing
 * file at that name makes the install fail instead of being written through.
 */
function replaceFile(path: string, content: string): void {
  const temp = `${path}.groundwork-${process.pid}`;
  let created = false;
  try {
    const fd = openSync(temp, "wx");
    created = true;
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    if (existsSync(path)) chmodSync(temp, lstatSync(path).mode & 0o777);
    renameSync(temp, path);
  } catch (error) {
    if (created) rmSync(temp, { force: true });
    throw error;
  }
}
function readLock(path: string): InstallLock | undefined {
  if (!present(path)) return undefined;
  const lock = JSON.parse(readFileSync(path, "utf8")) as InstallLock;
  if (
    lock.schema !== 1 ||
    !Array.isArray(lock.skills) ||
    lock.skills.some((name) => typeof name !== "string" || !skillName(name)) ||
    (lock.previous !== undefined &&
      (!Array.isArray(lock.previous) || !lock.previous.every(Array.isArray)))
  )
    throw new Error("invalid installation lock");
  return lock;
}
/**
 * Record sets a retry must keep until a completed install replaces them: the
 * lock's own plan and what it replaced, without repeats or empty sets, and never
 * truncated, since the oldest set may be the only evidence for paths on disk.
 */
function carriedRecords(lock: InstallLock | undefined): Installed[][] {
  const seen = new Set<string>();
  return [lock?.entries ?? [], ...(lock?.previous ?? [])].filter((records) => {
    const key = JSON.stringify(records);
    if (!records.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** True when the path on disk is exactly what the lock recorded for it. */
function entryMatches(consumer: string, entry: Installed): boolean {
  try {
    safePath(entry.path);
    const path = join(consumer, entry.path),
      stat = lstatSync(path);
    if (entry.target)
      return (
        stat.isSymbolicLink() &&
        resolve(dirname(path), readlinkSync(path)) === entry.target
      );
    if (!entry.file) return false;
    const actual = record(consumer, entry.path);
    return (
      actual.digest === entry.file.digest &&
      (process.platform === "win32" ||
        actual.executable === entry.file.executable)
    );
  } catch {
    return false;
  }
}
/** A linked path matches its record; a copied directory must match its record set exactly. */
function exactInstall(
  consumer: string,
  records: Installed[],
  path: string,
  allowMissing = false,
): boolean {
  const mine = records.filter(
    (entry) => entry.path === path || entry.path.startsWith(`${path}/`),
  );
  if (
    !mine.length ||
    !mine.every((entry) =>
      allowMissing && !present(join(consumer, entry.path))
        ? true
        : entryMatches(consumer, entry),
    )
  )
    return false;
  if (mine.length === 1 && mine[0]?.path === path) return true;
  try {
    const root = join(consumer, path);
    if (!lstatSync(root).isDirectory()) return false;
    const actual = new Set<string>();
    // Inspect leaves without following links: helper trees contain file links
    // in normal installs and regular files in copy mode. A directory no record
    // lies under is unmanaged, so it counts as a stray leaf even when empty.
    function leaves(relative: string): void {
      for (const name of readdirSync(join(consumer, relative))) {
        const child = `${relative}/${name}`,
          stat = lstatSync(join(consumer, child));
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          mine.some((entry) => entry.path.startsWith(`${child}/`))
        )
          leaves(child);
        else actual.add(child);
      }
    }
    leaves(path);
    if (allowMissing)
      return [...actual].every((leaf) =>
        mine.some((entry) => entry.path === leaf),
      );
    return (
      actual.size === mine.length &&
      mine.every((entry) => actual.has(entry.path))
    );
  } catch {
    return false;
  }
}
/**
 * May the installer replace or delete this discovery path? Per path, since a
 * project can own one surface's copy of a skill while the other is ours.
 * Completed locks vouch for their skills; a pending lock vouches only for what
 * on disk matches the records it wrote or the ones they replaced.
 */
function ownsDiscovery(
  consumer: string,
  lock: InstallLock | undefined,
  skill: string,
  surface: string,
): boolean {
  const path = `${surface}/skills/${skill}`;
  if (!present(join(consumer, path))) return true;
  if (!lock) return false;
  if (!lock.pending) return lock.skills.includes(skill);
  return [lock.entries, ...(lock.previous ?? [])].some((records) =>
    exactInstall(consumer, records, path),
  );
}
/** Every skill name the lock has ever recorded, including a pending run's. */
function recordedSkills(lock: InstallLock | undefined): string[] {
  if (!lock) return [];
  const names = new Set(lock.skills);
  for (const records of [lock.entries, ...(lock.previous ?? [])])
    for (const entry of records) {
      const m = /^\.(?:claude|agents)\/skills\/([^/]+)/.exec(entry.path);
      if (m?.[1] && skillName(m[1])) names.add(m[1]);
    }
  return [...names];
}

export async function install(options: Options): Promise<void> {
  validatePin(options.pin);
  validateOverlay(options.overlay);
  const consumer = resolve(options.consumer);
  if (!lstatSync(consumer).isDirectory())
    throw new Error("consumer must be a directory");
  for (const path of [
    ".groundwork/install.lock.json",
    ".groundwork/overlay.json",
    ".claude/skills/placeholder",
    ".agents/skills/placeholder",
    ".gitignore",
  ])
    plainParents(consumer, path);
  const root = await cached(options),
    manifest = verify(root, options.local ? undefined : options.pin.manifest);
  const manifestDigest = digest(readFileSync(join(root, MANIFEST)));
  const helpers = manifest.files.filter((item) => item.path.startsWith("lib/"));
  const fingerprint = digest(
    JSON.stringify({
      pin: options.pin,
      overlay: options.overlay,
      local: options.local ? root : null,
      manifest: manifestDigest,
    }),
  );
  const statePath = join(consumer, ".groundwork/install.lock.json");
  const overlayText = `${JSON.stringify(options.overlay, null, 2)}\n`;
  if (present(statePath) && !lstatSync(statePath).isFile())
    throw new Error("install lock must be a regular file");
  let old = readLock(statePath);
  const adapters = new Map<string, string>();
  for (const skill of options.overlay.skills) {
    const source = readFileSync(
      join(root, "skills", skill, "SKILL.md"),
      "utf8",
    );
    for (const surface of ["claude", "codex"] as const)
      adapters.set(
        `${surface}/${skill}`,
        render(source, options.overlay, skill, surface),
      );
  }
  if (options.check) {
    if (old?.pending)
      throw new Error("installation was interrupted; reinstall");
    if (
      !old ||
      old.fingerprint !== fingerprint ||
      old.release !== root ||
      old.manifest !== manifestDigest
    )
      throw new Error("installation inputs changed; reinstall");
    const expected: string[] = [];
    const overlayPath = ".groundwork/overlay.json";
    expected.push(overlayPath);
    if (readFileSync(join(consumer, overlayPath), "utf8") !== overlayText)
      throw new Error("runtime overlay changed: .groundwork/overlay.json");
    for (const [key, content] of adapters) {
      const path = `.groundwork/adapters/${key}/SKILL.md`;
      expected.push(path);
      if (readFileSync(join(consumer, path), "utf8") !== content)
        throw new Error(`rendered adapter changed: ${path}`);
    }
    for (const entry of old.entries) {
      safePath(entry.path);
      plainParents(consumer, entry.path);
      const path = join(consumer, entry.path),
        stat = lstatSync(path);
      if (entry.target) {
        if (
          !stat.isSymbolicLink() ||
          resolve(dirname(path), readlinkSync(path)) !== entry.target
        )
          throw new Error(`wrong release link: ${entry.path}`);
      } else if (entry.file) {
        const actual = record(consumer, entry.path);
        if (
          actual.digest !== entry.file.digest ||
          (process.platform !== "win32" &&
            actual.executable !== entry.file.executable)
        )
          throw new Error(`installed file changed: ${entry.path}`);
      } else throw new Error("invalid install record");
    }
    // The lock is only a record of link-vs-copy choices. What must exist, where
    // links point and which bytes copies hold comes from the verified release.
    const known = new Set<string>(expected);
    const entryAt = (path: string) =>
      old?.entries.find((entry) => entry.path === path);
    const expectFile = (path: string, want: FileRecord | undefined) => {
      const entry = entryAt(path);
      if (!entry) throw new Error(`missing install record: ${path}`);
      known.add(path);
      if (!want) return;
      if (entry.target)
        throw new Error(`unexpected link for generated file: ${path}`);
      if (
        entry.file?.digest !== want.digest ||
        (process.platform !== "win32" &&
          entry.file.executable !== want.executable)
      )
        throw new Error(`install record disagrees with release: ${path}`);
    };
    for (const item of helpers) {
      const path = `.groundwork/${item.path}`,
        entry = entryAt(path);
      if (!entry) throw new Error(`missing install record: ${path}`);
      known.add(path);
      if (entry.target) {
        if (entry.target !== join(root, item.path))
          throw new Error(`wrong release link: ${path}`);
      } else expectFile(path, item);
    }
    for (const [key, content] of adapters) {
      const [surface, skill] = key.split("/") as [string, string];
      const dir = `.groundwork/adapters/${key}`,
        prefix = `skills/${skill}/`,
        files = new Map<string, FileRecord>([
          [
            "SKILL.md",
            {
              path: "SKILL.md",
              digest: digest(content),
              executable: false,
            },
          ],
        ]);
      expectFile(`${dir}/SKILL.md`, files.get("SKILL.md"));
      for (const item of manifest.files)
        if (item.path.startsWith(prefix) && item.path !== `${prefix}SKILL.md`) {
          const rel = item.path.slice(prefix.length),
            entry = entryAt(`${dir}/${rel}`);
          files.set(rel, item);
          if (!entry) throw new Error(`missing install record: ${dir}/${rel}`);
          known.add(`${dir}/${rel}`);
          if (entry.target) {
            if (entry.target !== join(root, item.path))
              throw new Error(`wrong release link: ${dir}/${rel}`);
          } else expectFile(`${dir}/${rel}`, item);
        }
      const discovery = `${surface === "claude" ? ".claude" : ".agents"}/skills/${skill}`,
        linked = entryAt(discovery);
      if (linked) {
        known.add(discovery);
        if (linked.target !== join(consumer, dir))
          throw new Error(`wrong release link: ${discovery}`);
      } else
        for (const [rel, want] of files)
          expectFile(`${discovery}/${rel}`, want);
    }
    for (const entry of old.entries)
      if (!known.has(entry.path))
        throw new Error(`unexpected install record: ${entry.path}`);
    // Reject unexpected files and type replacements without following links.
    function tree(relative: string): void {
      const stat = lstatSync(join(consumer, relative));
      if (old?.entries.some((entry) => entry.path === relative)) return;
      // A directory is ours only if a record lies under it; an added empty one
      // would otherwise pass for want of anything to validate.
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !old?.entries.some((entry) => entry.path.startsWith(`${relative}/`))
      )
        throw new Error(`unexpected installed entry: ${relative}`);
      for (const name of readdirSync(join(consumer, relative)))
        tree(`${relative}/${name}`);
    }
    if (present(join(consumer, ".groundwork/adapters")))
      tree(".groundwork/adapters");
    if (present(join(consumer, ".groundwork/lib"))) tree(".groundwork/lib");
    for (const skill of options.overlay.skills)
      for (const surface of [".claude", ".agents"])
        tree(`${surface}/skills/${skill}`);
    return;
  }
  mkdirSync(join(consumer, ".groundwork"), { recursive: true });
  await locked(join(consumer, ".groundwork/install.lock"), async () => {
    // Read after acquiring the worktree lock, since another installer may have changed ownership while we waited.
    old = readLock(statePath);
    // Never remove a helper tree created or altered by the consumer, including
    // after an interrupted install. Ownership comes from exact disk records.
    const helperPath = ".groundwork/lib";
    const runtimeOverlayPath = ".groundwork/overlay.json";
    if (
      present(join(consumer, runtimeOverlayPath)) &&
      !carriedRecords(old).some((records) =>
        exactInstall(consumer, records, runtimeOverlayPath, true),
      )
    )
      throw new Error(
        "unmanaged or changed runtime overlay; move .groundwork/overlay.json aside before reinstalling",
      );
    if (
      present(join(consumer, helperPath)) &&
      !carriedRecords(old).some((records) =>
        exactInstall(consumer, records, helperPath, true),
      )
    )
      throw new Error(
        "unmanaged or changed shared helpers; move .groundwork/lib aside before reinstalling",
      );
    const ignorePath = join(consumer, ".gitignore");
    if (present(ignorePath) && !lstatSync(ignorePath).isFile())
      throw new Error("gitignore must be a regular file");
    // Refuse unmanaged skills: adoption explicitly removes or moves the old copy first.
    for (const skill of options.overlay.skills)
      for (const surface of DISCOVERY_SURFACES)
        if (!ownsDiscovery(consumer, old, skill, surface))
          throw new Error(
            `unmanaged skill exists: ${join(consumer, surface, "skills", skill)}; move it aside before adoption`,
          );
    const entries: Installed[] = [];
    const stage = mkdtempSync(join(consumer, ".groundwork/stage-"));
    const stagedEntries: Installed[] = [];
    function file(path: string, content: string): void {
      const dest = join(stage, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      chmodSync(dest, 0o644);
      stagedEntries.push({ path, file: record(stage, path) });
    }
    /** Keep imported files physically within the consumer's owned installation. */
    function copy(path: string, from: string): void {
      const dest = join(stage, path);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(from, dest, { recursive: true, dereference: true });
      if (lstatSync(dest).isDirectory())
        for (const item of inventory(dest, undefined, true))
          stagedEntries.push({
            path: `${path}/${item.path}`,
            file: { ...item, path: `${path}/${item.path}` },
          });
      else stagedEntries.push({ path, file: record(stage, path) });
    }
    /** `from` is where the content is read now when `target` is not published yet. */
    function link(path: string, target: string, from = target): void {
      const dest = join(stage, path);
      mkdirSync(dirname(dest), { recursive: true });
      if (!options.copies) {
        try {
          symlinkSync(
            target,
            dest,
            lstatSync(from).isDirectory() ? "dir" : "file",
          );
          stagedEntries.push({ path, target });
          return;
        } catch (e) {
          if (
            !["EPERM", "EACCES", "ENOSYS"].includes(
              (e as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw e;
        }
      }
      copy(path, from);
    }
    try {
      file(runtimeOverlayPath, overlayText);
      for (const item of helpers)
        copy(`.groundwork/${item.path}`, join(root, item.path));
      for (const [key, content] of adapters) {
        const path = `.groundwork/adapters/${key}`;
        file(`${path}/SKILL.md`, content);
        const skill = key.split("/")[1];
        if (!skill) throw new Error("invalid generated adapter key");
        for (const item of manifest.files.filter(
          (item) =>
            item.path.startsWith(`skills/${skill}/`) &&
            item.path !== `skills/${skill}/SKILL.md`,
        ))
          copy(
            `${path}/${item.path.slice(`skills/${skill}/`.length)}`,
            join(root, item.path),
          );
      }
      // Stage every discovery path too, so nothing below can fail for lack of a
      // complete staged tree once the worktree starts changing.
      const discovery: string[] = [];
      const stagedAdapters = stagedEntries.splice(0);
      for (const [key] of adapters) {
        const [surface, skill] = key.split("/");
        const path = `${surface === "claude" ? ".claude" : ".agents"}/skills/${skill}`;
        link(
          path,
          join(consumer, ".groundwork/adapters", key),
          join(stage, ".groundwork/adapters", key),
        );
        discovery.push(path);
      }
      entries.push(...stagedAdapters, ...stagedEntries);
      const wanted = [
        "/.groundwork/",
        ...options.overlay.skills.flatMap((name) => [
          `/.claude/skills/${name}`,
          `/.agents/skills/${name}`,
        ]),
      ];
      const ignore = managedIgnore(
        existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "",
        wanted,
      );
      // Mark the lock pending before anything is published; check refuses it
      // until publishing completes. The record sets it replaces stay in the lock
      // so a retry can tell what the installer put on disk from what the project did.
      const writeLock = (skills: string[], pending = false) => {
        const state: InstallLock = {
          schema: 1,
          fingerprint,
          release: root,
          manifest: manifestDigest,
          skills,
          entries,
          ...(pending && {
            pending: true as const,
            previous: carriedRecords(old),
          }),
        };
        writeFileSync(
          join(stage, "lock.json"),
          `${JSON.stringify(state, null, 2)}\n`,
        );
        renameSync(join(stage, "lock.json"), statePath);
      };
      writeLock(options.overlay.skills, true);
      replaceFile(ignorePath, ignore);
      for (const skill of new Set([
        ...recordedSkills(old),
        ...options.overlay.skills,
      ]))
        for (const surface of DISCOVERY_SURFACES)
          if (ownsDiscovery(consumer, old, skill, surface))
            rmSync(join(consumer, surface, "skills", skill), {
              recursive: true,
              force: true,
            });
      rmSync(join(consumer, ".groundwork/adapters"), {
        recursive: true,
        force: true,
      });
      if (existsSync(join(stage, ".groundwork/adapters")))
        renameSync(
          join(stage, ".groundwork/adapters"),
          join(consumer, ".groundwork/adapters"),
        );
      rmSync(join(consumer, helperPath), { recursive: true, force: true });
      if (existsSync(join(stage, helperPath)))
        renameSync(join(stage, helperPath), join(consumer, helperPath));
      renameSync(
        join(stage, runtimeOverlayPath),
        join(consumer, runtimeOverlayPath),
      );
      for (const path of discovery) {
        mkdirSync(dirname(join(consumer, path)), { recursive: true });
        renameSync(join(stage, path), join(consumer, path));
      }
      writeLock(options.overlay.skills);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

if (import.meta.main)
  cli(async () => {
    const args = process.argv.slice(2),
      values: Record<string, string> = {},
      flags = new Set<string>();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      const value = args[i + 1];
      if (["--check", "--copies"].includes(arg)) flags.add(arg);
      else if (
        ["--consumer", "--pin", "--overlay", "--cache", "--local"].includes(
          arg,
        ) &&
        value &&
        !value.startsWith("--")
      ) {
        values[arg.slice(2)] = value;
        i++;
      } else throw new Error(`unknown or incomplete option: ${arg}`);
    }
    const consumer = resolve(values.consumer ?? ".");
    const pin = JSON.parse(
      readFileSync(resolve(consumer, values.pin ?? ".groundwork.json"), "utf8"),
    ) as Pin;
    if (!values.overlay)
      throw new Error("--overlay <consumer-overlay.json> is required");
    const overlay = JSON.parse(
      readFileSync(resolve(consumer, values.overlay), "utf8"),
    ) as Overlay;
    await install({
      consumer,
      pin,
      overlay,
      cache: values.cache,
      local: values.local ?? process.env.GROUNDWORK_LOCAL_RELEASE,
      check: flags.has("--check"),
      copies: flags.has("--copies"),
    });
    console.log(
      flags.has("--check")
        ? "Groundwork installation verified"
        : "Groundwork installed",
    );
    return 0;
  });
