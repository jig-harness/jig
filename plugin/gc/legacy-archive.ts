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
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
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
/** An archive written and verified: where it is, and what it holds. */
export interface Archived extends Measured {
  path: string;
  paths: string[];
}
type ArchiveCode = "oversized" | "timed-out" | "unreadable" | "archive-failed";
/**
 * Copy `paths` (relative to `worktree`) into a new archive under the state
 * directory, keeping each path's place, links as links. The archive is
 * measured again once written and must match the source entry for entry and
 * byte for byte, else it is removed and the copy fails. Nothing in the
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
    ? verify(path, paths, source.value, deadline)
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
  if (!recorded.ok) {
    rmSync(path, { recursive: true, force: true });
    return recorded;
  }
  return ok({ path, paths, ...source.value });
}
/** The copy, measured again: it must hold what the worktree held, entry for entry and byte for byte. */
function verify(
  path: string,
  paths: string[],
  source: Measured,
  deadline: number,
): Outcome<undefined, ArchiveCode> {
  const copied = measure(
    join(path, "content"),
    paths,
    Number.MAX_SAFE_INTEGER,
    deadline,
  );
  if (!copied.ok) return copied;
  if (
    copied.value.bytes === source.bytes &&
    copied.value.entries === source.entries
  )
    return ok(undefined);
  return failed(
    "archive-failed",
    `the archive holds ${copied.value.entries} entries of ${copied.value.bytes} bytes, the worktree ${source.entries} of ${source.bytes}`,
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
/** When an archive was written, from its manifest; null when the manifest cannot be read. */
export function archivedAt(path: string): number | null {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(path, MANIFEST), "utf8"),
    );
    if (!isMapping(manifest) || typeof manifest.createdAt !== "string")
      return null;
    const at = Date.parse(manifest.createdAt);
    return Number.isFinite(at) ? at : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
