/**
 * The one-time archive of a finished worktree whose ignored content predates
 * marking. Marking accounts only for what was written after Jig's procedures
 * started marking their working files, so a worktree created before then
 * holds unmarked files of the same kind. For such a worktree, and only for
 * it, gc copies the ignored content no rule accounts for into an archive
 * under its state directory before removing the worktree: the copy is the
 * preservation proof. An archive must fit a size bound and be verified
 * complete before removal; otherwise the worktree stays. Archives expire with
 * the receipts (`gc.receipts_days`).
 */
import {
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { isMapping } from "../shared/config-layers.ts";

/** What the archive of one worktree may hold, at most, unless the machine sets `gc.archive_max_bytes`. */
export const DEFAULT_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/** Where archives and the marking stamp live, and the size bound; `maxBytes` 0 archives nothing. */
export interface ArchivePolicy {
  root: string;
  maxBytes: number;
}
/** The archive policy with the instant this host's marking began, read once per run. */
export interface LegacyPolicy extends ArchivePolicy {
  since: number;
}
const STAMP = "marking-since";
const ARCHIVES = "archives";
const MANIFEST = "archive.json";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/**
 * The instant marking began on this host: the first run of a gc that knows
 * the marks records it, and every later run reads it back. A worktree created
 * before it is one whose working files may predate marking.
 */
export function markingSince(root: string): Outcome<number, "unreadable"> {
  const path = join(root, STAMP);
  const read = attempt(
    "unreadable",
    "the marking stamp could not be read",
    () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, `${new Date().toISOString()}\n`);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return Date.parse(readFileSync(path, "utf8").trim());
    },
  );
  if (!read.ok) return read;
  return Number.isFinite(read.value)
    ? read
    : failed("unreadable", `${path} holds no instant`);
}
/**
 * When git created a worktree: the time of the `commondir` file
 * `git worktree add` writes once in its administrative directory.
 */
export function worktreeCreatedAt(
  admin: string,
): Outcome<number, "unreadable"> {
  return attempt(
    "unreadable",
    "the worktree's creation time could not be read",
    () => lstatSync(join(admin, "commondir")).mtimeMs,
  );
}
/** The size and number of entries of ignored content, bounded by a byte limit and a deadline. */
export interface Measured {
  bytes: number;
  entries: number;
}
/**
 * Measure the given paths under `root` without following a link: each file
 * and link counts its own size, each directory nothing. Stops as soon as the
 * total passes `limit` (the bound is then exceeded, whatever the rest holds)
 * or `deadline` passes.
 */
export function measure(
  root: string,
  paths: string[],
  limit: number,
  deadline: number,
): Outcome<Measured, "timed-out" | "unreadable"> {
  const total: Measured = { bytes: 0, entries: 0 };
  const visit = (path: string): Outcome<undefined, "timed-out"> => {
    if (Date.now() > deadline)
      return failed(
        "timed-out",
        "measuring ignored content exceeded its deadline",
      );
    const stat = lstatSync(path);
    total.entries += 1;
    if (!stat.isDirectory()) {
      total.bytes += stat.size;
      return ok(undefined);
    }
    for (const child of readdirSync(path)) {
      if (total.bytes > limit) break;
      const nested = visit(join(path, child));
      if (!nested.ok) return nested;
    }
    return ok(undefined);
  };
  try {
    for (const path of paths) {
      if (total.bytes > limit) break;
      const visited = visit(join(root, path.replace(/\/$/, "")));
      if (!visited.ok) return visited;
    }
  } catch (error) {
    return failed(
      "unreadable",
      `ignored content could not be measured: ${message(error)}`,
      error,
    );
  }
  return ok(total);
}
/**
 * What each path under `root` holds, entry by entry: its type, and a file's
 * content hash or a link's target. Two trees with the same fingerprint hold
 * the same names and the same content, which byte and entry totals cannot say.
 */
function fingerprint(
  root: string,
  paths: string[],
  deadline: number,
): Outcome<Map<string, string>, "timed-out" | "unreadable"> {
  const entries = new Map<string, string>();
  const visit = (relative: string): boolean => {
    if (Date.now() > deadline) return false;
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      entries.set(relative, `link ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      entries.set(relative, "dir");
      for (const child of readdirSync(path).sort())
        if (!visit(join(relative, child))) return false;
    } else if (stat.isFile())
      entries.set(
        relative,
        `file ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
      );
    else entries.set(relative, `other ${stat.mode}`);
    return true;
  };
  try {
    for (const path of paths)
      if (!visit(path.replace(/\/$/, "")))
        return failed(
          "timed-out",
          "verifying ignored content exceeded its deadline",
        );
  } catch (error) {
    return failed(
      "unreadable",
      `ignored content could not be verified: ${message(error)}`,
      error,
    );
  }
  return ok(entries);
}
/** An archive written and verified: where it is, and what it holds. */
export interface Archived extends Measured {
  path: string;
  paths: string[];
}
type ArchiveCode = "oversized" | "timed-out" | "unreadable" | "archive-failed";
/**
 * Copy `paths` (relative to `worktree`) into a new archive under the state
 * directory, keeping each path's place, links as links. The archive is
 * fingerprinted again once written, and the worktree once more, and both must
 * match the worktree as it was before the copy, else it is removed and the
 * copy fails. Nothing in the
 * worktree changes.
 */
export function archiveIgnored(
  worktree: string,
  paths: string[],
  policy: ArchivePolicy,
  deadline: number,
): Outcome<Archived, ArchiveCode> {
  const source = measure(worktree, paths, policy.maxBytes, deadline);
  if (!source.ok) return source;
  if (source.value.bytes > policy.maxBytes)
    return failed(
      "oversized",
      `ignored content exceeds the archive bound of ${policy.maxBytes} bytes`,
    );
  const before = fingerprint(worktree, paths, deadline);
  if (!before.ok) return before;
  const now = new Date();
  const path = join(
    policy.root,
    ARCHIVES,
    now.toISOString().slice(0, 10),
    `${now.toISOString().replace(/:/g, "-")}-${basename(worktree)}-${randomUUID().slice(0, 8)}`,
  );
  const written = attempt(
    "archive-failed",
    `archiving the ignored content of ${worktree} failed`,
    () => {
      mkdirSync(join(path, "content"), { recursive: true, mode: 0o700 });
      for (const entry of paths) {
        const relative = entry.replace(/\/$/, "");
        cpSync(join(worktree, relative), join(path, "content", relative), {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
      }
    },
  );
  const verified = written.ok
    ? verify(path, worktree, paths, before.value, deadline)
    : written;
  const recorded = verified.ok
    ? attempt(
        "archive-failed",
        `recording the archive of ${worktree} failed`,
        () =>
          writeFileSync(
            join(path, MANIFEST),
            `${JSON.stringify({ version: 1, worktree, createdAt: now.toISOString(), paths, ...source.value }, null, 2)}\n`,
            { mode: 0o600 },
          ),
      )
    : verified;
  const durable = recorded.ok
    ? attempt("archive-failed", `flushing the archive of ${worktree}`, () =>
        syncPublication(path, policy.root),
      )
    : recorded;
  if (!durable.ok) {
    // A copy that cannot be removed either stays to expire with the receipts.
    attempt("archive-failed", `removing ${path}`, () =>
      rmSync(path, { recursive: true, force: true }),
    );
    return durable;
  }
  return ok({ path, paths, ...source.value });
}
/**
 * Flush a directory entry's own durability. Windows refuses to open a
 * directory, and Node offers no other flush there, so the entry is left to the
 * file system, as `receipts.ts` leaves its own.
 */
function syncEntry(path: string): void {
  if (process.platform === "win32" && lstatSync(path).isDirectory()) return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Flush every file and directory of a tree to disk. */
function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory())
    for (const child of readdirSync(path)) syncTree(join(path, child));
  syncEntry(path);
}
/**
 * Flush the archive and every directory that names it up to the state root,
 * so a removal that follows cannot outlive the archive's name.
 */
function syncPublication(path: string, root: string): void {
  syncTree(path);
  for (
    let parent = dirname(path);
    parent.startsWith(root) && parent.length >= root.length;
    parent = dirname(parent)
  ) {
    syncEntry(parent);
    if (parent === root) break;
  }
}
/** The copy and the worktree, fingerprinted again: both must match the worktree as it was before the copy. */
function verify(
  path: string,
  worktree: string,
  paths: string[],
  source: Map<string, string>,
  deadline: number,
): Outcome<undefined, ArchiveCode> {
  const copied = fingerprint(join(path, "content"), paths, deadline);
  if (!copied.ok) return copied;
  // The worktree again: content changed while it was copied is not in the copy.
  const now = fingerprint(worktree, paths, deadline);
  if (!now.ok) return now;
  const differs = (other: Map<string, string>): string | null => {
    for (const [name, mark] of source)
      if (other.get(name) !== mark) return name;
    for (const name of other.keys()) if (!source.has(name)) return name;
    return null;
  };
  const drift = differs(copied.value) ?? differs(now.value);
  return drift === null
    ? ok(undefined)
    : failed(
        "archive-failed",
        `the archive or the worktree no longer matches the content first read: ${drift} differs`,
      );
}
/** Every archive under the state directory, oldest day first. */
export function archivePaths(root: string): string[] {
  const base = join(root, ARCHIVES);
  let days: string[];
  try {
    days = readdirSync(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return days
    .filter(
      (day) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day) &&
        lstatSync(join(base, day)).isDirectory(),
    )
    .sort()
    .flatMap((day) =>
      readdirSync(join(base, day), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(base, day, entry.name))
        .sort(),
    );
}
/**
 * When an archive was written: from its manifest, else the end of the day its
 * day directory names (a copy cut short before its manifest was written);
 * null when neither can be read.
 */
export function archivedAt(path: string): number | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(path, MANIFEST), "utf8"),
    );
    if (!isMapping(manifest) || typeof manifest.createdAt !== "string")
      return dayOf(path);
    const at = Date.parse(manifest.createdAt);
    return Number.isFinite(at) ? at : dayOf(path);
  } catch (error) {
    if (error instanceof SyntaxError) return dayOf(path);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return dayOf(path);
    throw error;
  }
}
function dayOf(path: string): number | null {
  const day = basename(dirname(path));
  const start = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? Date.parse(`${day}T00:00:00.000Z`)
    : Number.NaN;
  return Number.isFinite(start) ? start + 86_400_000 : null;
}
