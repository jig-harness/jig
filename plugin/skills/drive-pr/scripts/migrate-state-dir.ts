#!/usr/bin/env bun
/**
 * Safely move drive-pr state populations to another directory.
 *
 *   migrate-state-dir.ts <absolute-source> <absolute-destination>
 *       move one clone's state directory.
 *   migrate-state-dir.ts --from <dir> [--to <dir>]
 *       move every clone's state found under <dir> (a state root holding one
 *       subdirectory per clone, or one clone's directory) into the same-named
 *       subdirectory of --to, default the current state root
 *       (~/.local/state/jig/drive-pr). `~` is expanded.
 *
 * A repository that schedules `reap-state.ts --delete` (a launchd agent or a
 * crontab entry) names that schedule with DRIVE_PR_REAPER_LAUNCHD_LABEL or
 * DRIVE_PR_REAPER_CRONTAB_MARKER, and the migration refuses while it is
 * enabled: the reaper must not delete from a population mid-move. With
 * neither set there is no schedule to check.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  CLAIM_PREFIX,
  claimLive,
  parseClaimText,
  stagingLive,
} from "./lib/claim.ts";
import { fail, runMain } from "./lib/cli.ts";
import { type RunHandle, type RunResult, run } from "./lib/proc.ts";
import {
  type ArtifactEntry,
  enumerateStateArtifacts,
  type OwnedArtifactEntry,
} from "./lib/state/artifacts.ts";
import {
  createExclusiveDurable,
  ExclusiveDurabilityUnconfirmed,
  fsyncDirectoryBestEffort,
} from "./lib/state/fsutil.ts";

/** The consumer's launchd label for a scheduled reaper, if it has one. */
function reaperLaunchdLabel(): string | undefined {
  const value = process.env.DRIVE_PR_REAPER_LAUNCHD_LABEL?.trim();
  return value ? value : undefined;
}

/** The text that marks the consumer's scheduled-reaper crontab entry, if any. */
function reaperCrontabMarker(): string | undefined {
  const value = process.env.DRIVE_PR_REAPER_CRONTAB_MARKER?.trim();
  return value ? value : undefined;
}

/**
 * The reaper delete-lock names that are a LIVE exclusivity gate: the
 * primary lock, and its short-lived `.recovering` gate (`lib/state/lock.ts`
 * — a second mkdir-based gate a breaker holds while displacing a dead
 * generation). A `.stale.<generation>` suffix on either means the lock was
 * already displaced into quarantine and is dead, not a gate anything still
 * holds — `reap-state.ts`'s own `isSweepable` draws the identical line.
 * Matching only the bare `.lock` name (as an earlier version of this check
 * did) let migration run during a live `.recovering` handoff and race the
 * reaper.
 */
const LIVE_REAP_STATE_DELETE_LOCK_RE =
  /^\.reap-state-delete\.lock(?:\.recovering)?$/;

export interface MigrationReport {
  readonly source: string;
  readonly destination: string;
  readonly mode: "rename" | "copy-verify-remove";
  readonly moved: readonly { name: string; family: string }[];
  /** Non-fatal degradations: the population is fully migrated regardless. */
  readonly warnings: readonly string[];
}

export interface MigrationOptions {
  /** Test seam: production always probes the platform scheduler. */
  readonly assertSchedulerDisabled?: () => Promise<void>;
  /** Test seam for exercising the cross-filesystem protocol on one volume. */
  readonly forceCrossFilesystem?: boolean;
  /** Test seam for process liveness without depending on ambient pids. */
  readonly isClaimLive?: typeof claimLive;
  /** Test seam for staging-directory liveness without depending on ambient pids. */
  readonly isStagingLive?: typeof stagingLive;
  /** Test seam for interruption after a verified cross-filesystem copy. */
  readonly beforeCrossFilesystemPublish?: () => void;
  /**
   * Test seam for a failure in the window between a completed cross-
   * filesystem publish and the source-quarantine call that follows it.
   */
  readonly afterCrossFilesystemPublish?: () => void;
  /** Test seam for destination substitution immediately before local moves. */
  readonly beforeSameFilesystemMove?: () => void;
  /** Test seam for a failure partway through a same-filesystem move. */
  readonly beforeSameFilesystemArtifactMove?: (
    name: string,
    index: number,
  ) => void;
  /** Test seam for a failure partway through source quarantine. */
  readonly beforeSourceQuarantineMove?: (name: string, index: number) => void;
  /** Test seam for a failure during best-effort quarantine cleanup. */
  readonly beforeQuarantineCleanup?: () => void;
  /**
   * Test seam for a failure in the FATAL durability fsyncs that precede
   * quarantine cleanup — distinct from `beforeQuarantineCleanup`, which fires
   * only after those fsyncs have already succeeded.
   */
  readonly beforeSourceDurabilitySync?: () => void;
  /**
   * Test seam for the same-filesystem rollback path: fires with the
   * directories just fsynced, strictly AFTER both durability fsyncs and
   * strictly BEFORE the journal is removed — the one point in that sequence
   * a test can observe the ordering directly (the journal file is still
   * readable from here), without needing to mock the fsync syscall itself.
   */
  readonly beforeRollbackJournalRemoval?: (
    syncedDirs: readonly string[],
  ) => void;
  /**
   * Test seam for exercising Windows-specific behavior on a POSIX runner.
   * Deliberately narrower than spoofing `process.platform` globally: `isInside`
   * above already branches on `process.platform` for its own separator check,
   * and a real filesystem's paths stay POSIX-separated regardless of the
   * spoof, so a global override makes it misclassify sibling directories as
   * nested. Production always reads the real `process.platform`.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Cooperative cancellation / deadline. Checked between artifacts in every
   * per-artifact loop (same-filesystem move, cross-filesystem copy, manifest
   * hashing, tree fsync, source quarantine) — never mid-syscall, since a sync
   * `renameSync`/`cpSync` cannot be interrupted once started. On a large
   * artifact population (the reaper's own measurement: 112k+ entries
   * in one state dir) this bounds how long a caller can be blocked without a
   * cancellation point, which was previously unbounded.
   */
  readonly signal?: AbortSignal;
}

interface ManifestEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly size?: number;
  readonly hash?: string;
}

interface ArtifactIdentity {
  readonly name: string;
  readonly dev: number;
  readonly ino: number;
  readonly kind: "directory" | "file";
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Yields to a MACROTASK before checking, then throws `signal`'s own reason as
 * a plain `Error`, never a bare DOMException. `AbortSignal.timeout`'s own
 * callback is dispatched off the timer queue, which a synchronous artifact
 * loop that never awaits anything never lets drain — a microtask-only yield
 * (`Promise.resolve()`) would not be enough, since microtasks run before the
 * timer queue is serviced. Without this, `.aborted` could stay `false` long
 * past the requested deadline no matter how many times this was called: a
 * 1ms timeout still let a 2,000-artifact same-filesystem migration run to
 * completion in ~169ms. Skipped
 * entirely when no signal was supplied, so the common (`--timeout` unused)
 * path pays no per-artifact yield cost.
 */
async function checkSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw new Error(
    `migration cancelled: ${reason instanceof Error ? reason.message : String(reason ?? "aborted")}`,
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
}

function canonicalDestination(path: string): {
  path: string;
  existed: boolean;
} {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`destination must be a real directory: ${path}`);
    }
    return { path: realpathSync(path), existed: true };
  }
  const parent = realpathSync(dirname(path));
  return { path: join(parent, basename(path)), existed: false };
}

function assertSameDirectory(path: string, dev: number, ino: number): void {
  const now = lstatSync(path);
  if (
    now.isSymbolicLink() ||
    !now.isDirectory() ||
    now.dev !== dev ||
    now.ino !== ino
  ) {
    throw new Error(`directory identity changed during migration: ${path}`);
  }
}

function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`expected a real directory: ${path}`);
  }
  return { dev: info.dev, ino: info.ino };
}

function lockClaim(
  entry: ArtifactEntry,
  isLive: typeof claimLive,
  isStagingLive: typeof stagingLive,
): void {
  if (entry.category !== "driver-lock") return;
  const info = lstatSync(entry.path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`cannot verify driver lock directory: ${entry.name}`);
  }
  const staging = /^.+\.lock\.([1-9][0-9]*)\.(.+)\.staging$/.exec(entry.name);
  if (staging !== null) {
    const record = {
      pid: Number.parseInt(staging[1] as string, 10),
      host: staging[2] as string,
    };
    const ageMs = Math.max(0, Date.now() - info.mtimeMs);
    if (isStagingLive({ ...record, ageMs })) {
      throw new Error(
        `live drive may still be creating ${entry.name} (pid ${record.pid}, host ${record.host})`,
      );
    }
    // Stale by NAME alone — return without ever looking inside. The
    // producer's own contract (`drive.ts`'s `sweepStaleStaging` doc comment)
    // is that a staging directory's identity is its name, never its
    // contents: the claim file inside is written by a separate, non-atomic
    // `writeFileSync` after the directory itself becomes visible, so it can
    // be torn or simply stale from an abandoned publish. Falling through to
    // the claims check below would let that unreliable content override a
    // name-based "stale" verdict already reached the same way `drive.ts`
    // reclaims it.
    return;
  }
  const claims = readdirSync(entry.path).filter((name) =>
    name.startsWith(CLAIM_PREFIX),
  );
  if (claims.length > 1) {
    throw new Error(
      `cannot verify driver lock with multiple claims: ${entry.name}`,
    );
  }
  if (claims.length === 1) {
    const claimPath = join(entry.path, claims[0] as string);
    const record = parseClaimText(readFileSync(claimPath, "utf8"));
    if (record === null) {
      throw new Error(
        `cannot verify malformed driver claim: ${entry.name}/${claims[0]}`,
      );
    }
    const ageMs = Math.max(0, Date.now() - statSync(claimPath).mtimeMs);
    if (isLive({ ...record, ageMs })) {
      throw new Error(
        `live drive still owns ${entry.name} (pid ${record.pid}, host ${record.host || "local"})`,
      );
    }
  }
}

async function captureArtifactIdentities(
  artifacts: readonly OwnedArtifactEntry[],
  signal?: AbortSignal,
): Promise<ArtifactIdentity[]> {
  const identities: ArtifactIdentity[] = [];
  for (const entry of artifacts) {
    await checkSignal(signal);
    const info = lstatSync(entry.path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(
        `artifact must be a real file or directory: ${entry.name}`,
      );
    }
    identities.push({
      name: entry.name,
      dev: info.dev,
      ino: info.ino,
      kind: info.isDirectory() ? "directory" : "file",
    });
  }
  return identities;
}

function assertArtifactIdentity(
  source: string,
  identity: ArtifactIdentity,
): void {
  const info = lstatSync(join(source, identity.name));
  const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
  if (
    info.isSymbolicLink() ||
    kind !== identity.kind ||
    info.dev !== identity.dev ||
    info.ino !== identity.ino
  ) {
    throw new Error(
      `artifact identity changed during migration: ${identity.name}`,
    );
  }
}

async function manifestEntry(
  path: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<ManifestEntry[]> {
  const result: ManifestEntry[] = [];
  const visit = async (
    currentPath: string,
    currentDisplayPath: string,
  ): Promise<void> => {
    await checkSignal(signal);
    const info = lstatSync(currentPath);
    if (info.isDirectory()) {
      result.push({ path: currentDisplayPath, kind: "directory" });
      for (const name of readdirSync(currentPath).sort((a, b) =>
        a.localeCompare(b),
      )) {
        await visit(join(currentPath, name), join(currentDisplayPath, name));
      }
    } else if (info.isFile()) {
      result.push({
        path: currentDisplayPath,
        kind: "file",
        size: info.size,
        hash: createHash("sha256")
          .update(readFileSync(currentPath))
          .digest("hex"),
      });
    } else {
      throw new Error(
        `unsupported filesystem entry in drive-pr artifact: ${currentDisplayPath}`,
      );
    }
  };
  await visit(path, displayPath);
  return result;
}

async function manifest(
  root: string,
  signal?: AbortSignal,
): Promise<ManifestEntry[]> {
  const result: ManifestEntry[] = [];
  for (const name of readdirSync(root).sort((a, b) => a.localeCompare(b))) {
    result.push(...(await manifestEntry(join(root, name), name, signal)));
  }
  return result;
}

function assertManifestEqual(
  expected: readonly ManifestEntry[],
  actual: readonly ManifestEntry[],
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("cross-filesystem copy verification failed");
  }
}

/**
 * Fsync every regular file under `root`, then every directory bottom-up
 * (directories via the shared best-effort helper; files are not
 * best-effort — a real fsync failure on a file must propagate). Run on the
 * cross-filesystem staging tree before publish: `cpSync` and the manifest
 * hash check above can both succeed entirely through the page cache, so
 * without this a power loss right after the publish rename (durable) can
 * still leave the copied file CONTENT missing or truncated even though the
 * directory entry survived.
 */
async function fsyncTreeBestEffort(
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  await checkSignal(signal);
  const info = lstatSync(root);
  if (info.isDirectory()) {
    for (const name of readdirSync(root)) {
      await fsyncTreeBestEffort(join(root, name), signal);
    }
    fsyncDirectoryBestEffort(root);
    return;
  }
  const fd = openSync(root, "r");
  // Capture-then-rethrow OUTSIDE a `finally` — see `fsyncDirectoryBestEffort`'s
  // own doc comment for why a plain `try { ... } finally { closeSync(fd) }`
  // would let a close error mask a real fsync failure.
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    fsyncSync(fd);
  } catch (e) {
    primaryFailed = true;
    primaryError = e;
  }
  let closeError: unknown;
  let closeFailed = false;
  try {
    closeSync(fd);
  } catch (e) {
    closeFailed = true;
    closeError = e;
  }
  if (primaryFailed) throw primaryError;
  if (closeFailed) throw closeError;
}

interface MigrationJournal {
  readonly op: "same-filesystem-move" | "quarantine";
  readonly source: string;
  readonly destination: string;
  readonly artifacts: readonly string[];
  readonly startedAt: string;
}

/**
 * `JSON.parse` only proves the journal is syntactically valid JSON, not that
 * it has this shape — a truncated or hand-edited journal (e.g. `{}`) parses
 * fine and previously reached `journal.artifacts.join(...)` in the refusal
 * message below, throwing an opaque `TypeError` instead of the intended
 * fail-closed diagnostic that tells the operator how to reconcile the
 * migration.
 */
function isMigrationJournal(value: unknown): value is MigrationJournal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.op === "same-filesystem-move" ||
      candidate.op === "quarantine") &&
    typeof candidate.source === "string" &&
    typeof candidate.destination === "string" &&
    typeof candidate.startedAt === "string" &&
    Array.isArray(candidate.artifacts) &&
    candidate.artifacts.every((entry) => typeof entry === "string")
  );
}

/**
 * One well-known path beside `source`, keyed on a hash of `source`'s own
 * absolute path rather than just its parent directory — two distinct
 * sources sharing one parent (`/state/a`, `/state/b`) previously collided on
 * the identical `dirname`-only path, so one migration's completion silently
 * deleted the other's still-needed recovery record.
 */
function migrationJournalPath(source: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return join(dirname(source), `.drive-pr-migrate-journal.${digest}.json`);
}

/**
 * Durable, EXCLUSIVE create-only write with a domain-specific `EEXIST`
 * message: publishes via `createExclusiveDurable` (`fsutil.ts`), which
 * itself publishes via `linkSync` — failing with `EEXIST` rather than
 * silently replacing an existing target the way `renameSync`/`atomicWrite`
 * would. Two concurrent migrations against the same `source` can both pass
 * `assertNoStaleMigrationJournal`'s read before either writes — only
 * exclusivity AT THE WRITE closes that race; the loser must fail rather than
 * overwrite the winner's journal and later delete it out from under a
 * still-running migration.
 *
 * A THIN WRAPPER, not a second implementation of `createExclusiveDurable`'s
 * publish/durability discipline: an earlier version of this function
 * reimplemented that discipline inline and, in doing so, left the trailing
 * temp-file cleanup AFTER a successful `linkSync` unguarded — a failure
 * there threw exactly like every earlier, path-never-touched failure, even
 * though the destination lock (this function's own caller, below) was by
 * then already durably published. The one call site that tracks ownership
 * off this function returning without throwing (`lockState.acquired`) would
 * then leave that published-but-unconfirmed lock untracked, with nothing to
 * ever release it. `createExclusiveDurable`
 * already distinguishes the two cases via `ExclusiveDurabilityUnconfirmed`
 * (thrown only once `link` has actually succeeded) vs. every earlier failure
 * — reusing it here, instead of re-deriving the same distinction a second
 * time, is what closes the class rather than this one instance of it.
 */
function writeExclusiveDurable(
  path: string,
  content: string,
  describeConflict: string,
): void {
  try {
    createExclusiveDurable(path, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(
        `a ${describeConflict} already exists at ${path} — another migration ` +
          "may already be in progress; if none is, inspect and remove it " +
          "manually before retrying",
      );
    }
    // Any other failure — including `ExclusiveDurabilityUnconfirmed` — is
    // rethrown as-is so a caller that cares (the destination-lock acquire
    // below) can `instanceof`-check it directly, exactly like `clone-key.ts`
    // already does against the same error type.
    throw error;
  }
}

/**
 * Durably records intent BEFORE the first destructive rename of a per-artifact
 * sequence. If the process is killed mid-loop (SIGKILL, host reboot, Bun
 * crash), this is the only record that a migration was in flight — without
 * it, a crash left `source` and `destination` (or `source` and an orphaned
 * quarantine) split with no durable signal of what happened, and a rerun's
 * "destination must be empty" refusal gave no context to recover from.
 */
function writeMigrationJournal(
  op: MigrationJournal["op"],
  source: string,
  destination: string,
  artifacts: readonly string[],
): void {
  const journal: MigrationJournal = {
    op,
    source,
    destination,
    artifacts,
    startedAt: new Date().toISOString(),
  };
  writeExclusiveDurable(
    migrationJournalPath(source),
    JSON.stringify(journal, null, 2),
    "migration journal",
  );
}

/**
 * Best-effort removal, called only once the operation it was guarding is
 * durably complete — never from a catch block covering a partial failure.
 * Returns a warning string rather than throwing: every caller invokes this
 * only after a successful rollback or after crossing the migration's own
 * durability boundary, so a removal failure (EACCES, EIO, a directory-fsync
 * failure) must not convert an already-completed operation into a reported
 * migration failure — a rerun would then find `source` already drained (or
 * `destination` already populated) and refuse with no working retry, exactly
 * the false failure the fatal/non-fatal fsync split above exists to prevent.
 */
function removeMigrationJournal(source: string): string | null {
  const path = migrationJournalPath(source);
  try {
    unlinkSync(path);
    fsyncDirectoryBestEffort(dirname(source));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return `migration completed, but removing its crash-recovery journal failed; remove manually: ${path} (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Refuse to start a new migration over a `source` that still carries a
 * journal from a previous attempt: crash-safety at the granularity this file
 * offers is "detect and hand off to a human", not silent auto-resume — an
 * auto-resume would have to re-derive which artifacts already reached
 * `destination` vs. an orphaned quarantine/stage directory, which is exactly
 * the reconciliation only a human can safely judge.
 */
function assertNoStaleMigrationJournal(source: string): void {
  const path = migrationJournalPath(source);
  if (!existsSync(path)) return;
  let journal: MigrationJournal | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isMigrationJournal(parsed)) journal = parsed;
  } catch {
    // fall through to the generic message below
  }
  if (journal === null) {
    throw new Error(
      `a previous migration attempt left an unreadable journal at ${path}; ` +
        `it may have been interrupted mid-move — reconcile ${source} and its ` +
        "destination manually, then remove the journal before retrying",
    );
  }
  throw new Error(
    `a previous migration attempt did not complete: ${journal.op} from ` +
      `${journal.source} to ${journal.destination} (started ${journal.startedAt}), ` +
      `artifacts: ${journal.artifacts.join(", ")}. It may have been interrupted ` +
      `mid-move (crash, SIGKILL, reboot) — inspect both directories, reconcile ` +
      `by hand, then remove ${path} before retrying`,
  );
}

/**
 * One well-known path beside `destination`, keyed on a hash of its own
 * resolved path — same rationale as `migrationJournalPath`. Exclusive
 * mutual-exclusion for the DESTINATION side: the source-keyed journal above
 * prevents two migrations of the same SOURCE from racing each other, but two
 * DIFFERENT sources can both legally pass every source-side check while
 * targeting the same destination — each artifact-name collision check only
 * ever compares against its own source's own artifact names, so two
 * migrations with disjoint artifact names can both pass it and interleave
 * into one merged destination undetected.
 */
function destinationLockPath(destination: string): string {
  const digest = createHash("sha256")
    .update(destination)
    .digest("hex")
    .slice(0, 16);
  return join(
    dirname(destination),
    `.drive-pr-migrate-dest-lock.${digest}.json`,
  );
}

/**
 * Deliberately simpler than the source journal's lifecycle: acquired right
 * after the destination is confirmed empty, and released ONLY once the
 * whole migration has verified successfully at the very end — never on a
 * partial failure, even one that fully reverted. A stale lock left behind
 * by a crash or a rejected concurrent attempt costs one manual cleanup step
 * on retry; a released lock that let a second migration merge into the same
 * destination undetected is the data-corruption class this exists to
 * prevent, so this errs toward leaving it in place.
 */
function assertNoStaleDestinationLock(destination: string): void {
  const path = destinationLockPath(destination);
  if (!existsSync(path)) return;
  throw new Error(
    `a lock for this destination already exists at ${path} — another ` +
      `migration may already be targeting ${destination}, or a previous ` +
      `attempt was interrupted before completing. Inspect and reconcile, ` +
      `then remove the lock before retrying`,
  );
}

/**
 * Delete the destination lock ONLY if the file currently at its path is
 * still the exact one this invocation created — verified by a per-
 * invocation ownership token embedded in the lock's own content, read and
 * compared immediately before the unlink.
 *
 * `lockState.acquired`/`lockState.destination` prove only that THIS
 * invocation once wrote a lock at this path; they say nothing about what is
 * there now. If an operator or cleanup process removed it and a different
 * migration acquired the same destination since, unlinking by recomputed
 * pathname alone would delete that migration's live lock and let a further
 * migration into the same destination undetected. Reading the content and
 * comparing the token narrows, though does not fully close, that race — a
 * full close would need an atomic compare-and-delete `node:fs` does not
 * offer. The remaining window is deliberately resolved toward safety: an
 * unreadable, unparseable, or mismatched lock is left in place rather than
 * removed, exactly like `assertNoStaleDestinationLock`'s own fail-closed
 * default — a stale lock costs one manual cleanup, a wrongly deleted live one
 * lets two migrations interleave.
 */
function unlinkOwnedDestinationLock(destination: string, token: string): void {
  const path = destinationLockPath(destination);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unparseable content at our path is not provably ours to delete
  }
  const owner =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { owner?: unknown }).owner
      : undefined;
  if (owner !== token) return; // not (or no longer) our lock — leave it
  unlinkSync(path);
}

/**
 * Returns non-fatal warnings from best-effort cleanup. Split in two: the two
 * fsyncs below are what make the already-completed renames into `quarantine`
 * durable — until they succeed, a crash could revert `source` to still
 * showing the artifacts, contradicting an already-published `destination`.
 * A failure there is a real durability failure and must propagate rather than
 * be reported as a warning. Only PAST that point is `quarantine` a redundant
 * backup copy: removing it is pure best-effort reclamation, and a failure
 * there must not be reported as a migration failure — `migrateStateDir` would
 * throw, but a rerun would find `source` already drained and refuse with
 * "source contains no drive-pr artifacts" while `destination` sits correctly
 * published, a false failure with no working retry. An earlier version
 * downgraded both phases together.
 */
async function quarantineSourceArtifacts(
  source: string,
  artifacts: readonly OwnedArtifactEntry[],
  identitiesByName: ReadonlyMap<string, ArtifactIdentity>,
  beforeMove?: (name: string, index: number) => void,
  beforeCleanup?: () => void,
  signal?: AbortSignal,
  beforeDurabilitySync?: () => void,
): Promise<string[]> {
  // The journal for this whole cross-filesystem operation (publish through
  // source removal) is written by the caller BEFORE the publish rename, not
  // here — writing it only at this point left a crash between publish and
  // this call with no recovery record at all.
  const quarantine = mkdtempSync(
    join(dirname(source), ".drive-pr-source-removal-"),
  );
  if (statSync(quarantine).dev !== statSync(source).dev) {
    rmSync(quarantine, { recursive: true });
    throw new Error(
      "cannot create a same-filesystem source-removal quarantine",
    );
  }
  const hidden: OwnedArtifactEntry[] = [];
  try {
    for (const [index, entry] of artifacts.entries()) {
      await checkSignal(signal);
      beforeMove?.(entry.name, index);
      assertArtifactIdentity(
        source,
        identitiesByName.get(entry.name) as ArtifactIdentity,
      );
      renameSync(entry.path, join(quarantine, entry.name));
      hidden.push(entry);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const entry of hidden.reverse()) {
      try {
        renameSync(join(quarantine, entry.name), entry.path);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${entry.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `source quarantine failed and rollback was incomplete (${rollbackFailures.join("; ")}); original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    rmSync(quarantine, { recursive: true });
    // Do NOT remove the journal here. By the time this function runs, the
    // caller has already published the cross-filesystem copy to
    // `destination` (`renameSync(stage, destination)`) — so a rollback that
    // fully restores `source` does not return the migration to its
    // pre-migration shape, it leaves TWO complete populations: the restored
    // `source` and the already-published `destination`. The journal is the
    // only durable record of that split state, and removing it here reads as
    // "nothing left to describe" when there is exactly the opposite — a
    // reconciliation an operator still owes.
    throw error;
  }
  // Past this point `source` and `quarantine` are both fixed — nothing below
  // can change what a crash would recover to. These two fsyncs are the
  // durability boundary described above and MUST propagate on failure.
  beforeDurabilitySync?.();
  fsyncDirectoryBestEffort(source);
  fsyncDirectoryBestEffort(dirname(source));
  const journalWarning = removeMigrationJournal(source);
  try {
    beforeCleanup?.();
    rmSync(quarantine, { recursive: true });
    fsyncDirectoryBestEffort(dirname(source));
    return journalWarning === null ? [] : [journalWarning];
  } catch (cleanupError) {
    const warnings = [
      `source artifacts are safely migrated, but quarantine cleanup failed; remove manually: ${quarantine} (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`,
    ];
    if (journalWarning !== null) warnings.push(journalWarning);
    return warnings;
  }
}

/**
 * Recognizes the documented empty-crontab diagnostic (`no crontab for
 * <user>`, optionally prefixed with the crontab binary's own progname,
 * optionally suffixed " - using an empty one") — not merely stderr that
 * starts with that text. A single greedy `[^\r\n:]+` payload accepted the
 * whole of "No crontab for alice - permission denied" as this benign case,
 * so migration proceeded without scheduler state actually being verified.
 * This resolves that ambiguity: it requires the entire (trimmed) stderr to be
 * exactly one line of this shape, strips the one documented optional suffix,
 * and requires what remains to be nothing but a plausible username — no
 * space, colon, or other character a genuine trailing error message would
 * carry.
 */
export function noCrontabDiagnostic(stderr: string): boolean {
  const text = stderr.trim();
  if (text.length === 0 || /\r?\n/.test(text)) return false;
  const match = /^(?:crontab: )?[Nn]o crontab for (.+)$/.exec(text);
  if (match === null) return false;
  const rest = (match[1] ?? "").replace(/ - using an empty one$/, "");
  return /^[a-zA-Z0-9._-]+$/.test(rest);
}

export function crontabHasScheduledReaper(
  crontab: string,
  marker: string | undefined = reaperCrontabMarker(),
): boolean {
  if (marker === undefined) return false;
  return crontab.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    return !trimmed.startsWith("#") && trimmed.includes(marker);
  });
}

/**
 * Races `run(argv, { timeoutSec: 10 })` against `signal` directly, rather
 * than letting the probe's own fixed 10s deadline run regardless of it: with
 * no signal given (or none aborting first) this is exactly `run(argv, {
 * timeoutSec: 10 })`. On abort it SIGTERMs (escalating to SIGKILL) the
 * still-live child via the handle `onSpawn` hands back and rejects
 * immediately — it does not wait out the probe's own deadline. Without this,
 * `assertScheduledReaperDisabled`'s probe ran to its fixed 10s regardless of
 * the caller's own `--timeout`, and the very next step after it returns
 * durably creates the destination lock — so a caller with `--timeout 0.1`
 * could still block for ~10s and mutate lock state before cancellation took
 * effect.
 */
/**
 * Cancellation reaches THIS process as one of these — the same set
 * `lib/proc.ts`'s own import-time forwarder treats as cancellation, since
 * `onSpawn` below (see `PROCESS_SIGNAL_EXIT_CODE`'s own comment) removes this
 * probe's child from that forwarder's reach and this function has to cover
 * the same three itself.
 */
const PROCESS_CANCEL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Conventional 128+signum exit code, so a killed probe exits the way an unhandled signal would have. */
const PROCESS_SIGNAL_EXIT_CODE: Record<
  (typeof PROCESS_CANCEL_SIGNALS)[number],
  number
> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export async function runProbe(
  argv: string[],
  signal: AbortSignal | undefined,
): Promise<RunResult> {
  if (signal === undefined) return run(argv, { timeoutSec: 10 });
  await checkSignal(signal);
  let handle: RunHandle | undefined;
  const result = run(argv, {
    timeoutSec: 10,
    onSpawn: (h) => {
      handle = h;
    },
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void handle?.stop();
      const reason = signal.reason;
      reject(
        new Error(
          `migration cancelled: ${reason instanceof Error ? reason.message : String(reason ?? "aborted")}`,
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // Taking `onSpawn` above is `lib/proc.ts`'s signal that THIS function now
  // owns the child's cancellation — which excludes it from that library's
  // own process-wide SIGINT/SIGTERM/SIGHUP forwarding
  // (`cancellableGroups`). Left unhandled here, a signal to this process
  // would leave the probe running as an orphan (it is a detached child, in
  // its own process group) until its own internal `timeoutSec: 10` deadline
  // — a `setTimeout` that dies with the process it was scheduled in, so it
  // never fires either.
  // Registering our own listener means `lib/proc.ts`'s forwarder sees more
  // than one listener and defers termination to us, so this handler has to
  // actually end the process once its own cleanup is done — the same
  // ownership contract `drive.ts`'s SIGINT/SIGTERM handler already honors.
  // That ownership includes AWAITING `handle.stop()`, not just starting it:
  // `stop()` sends SIGTERM and arms a SIGKILL escalation timer scheduled in
  // THIS process, so a synchronous `process.exit()` right behind a
  // fire-and-forget `void handle?.stop()` tears the timer down before it can
  // fire — a SIGTERM-ignoring probe then survives as an orphan, exactly the
  // failure this handler exists to prevent.
  const signalCleanups: Array<() => void> = [];
  for (const sig of PROCESS_CANCEL_SIGNALS) {
    const onProcessSignal = async (): Promise<void> => {
      await handle?.stop();
      for (const cleanup of signalCleanups) cleanup();
      process.exit(PROCESS_SIGNAL_EXIT_CODE[sig]);
    };
    process.once(sig, onProcessSignal);
    signalCleanups.push(() =>
      // bun-types 1.4.0 regression: process.removeListener/off overloads
      // collapse to only 'memoryPressure' (process.on/once still accept
      // signals) — the same cast `lib/proc.ts`'s own forwarder already uses.
      (process as unknown as import("node:events").EventEmitter).removeListener(
        sig,
        onProcessSignal,
      ),
    );
  }
  try {
    return await Promise.race([result, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    for (const cleanup of signalCleanups) cleanup();
  }
}

/** Prove the scheduled reaper cannot start during the migration. */
export async function assertScheduledReaperDisabled(
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform === "darwin") {
    const label = reaperLaunchdLabel();
    if (label === undefined) return;
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error("cannot determine uid for launchd probe");
    const result = await runProbe(
      ["launchctl", "print", `gui/${uid}/${label}`],
      signal,
    );
    if (result.code === 0)
      throw new Error(`scheduled reaper is enabled (${label})`);
    if (result.spawnFailed || !/could not find service/i.test(result.stderr)) {
      throw new Error(
        `could not verify launchd reaper state: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    return;
  }
  if (process.platform === "linux") {
    if (reaperCrontabMarker() === undefined) return;
    const result = await runProbe(["crontab", "-l"], signal);
    if (result.code !== 0) {
      if (!result.spawnFailed && noCrontabDiagnostic(result.stderr)) return;
      throw new Error(
        `could not verify crontab reaper state: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }
    if (crontabHasScheduledReaper(result.stdout)) {
      throw new Error("scheduled reaper is enabled in crontab");
    }
    return;
  }
  if (process.platform === "win32") {
    // No Windows scheduler is probed for this reaper: the schedules a
    // consumer can name are a launchd agent (darwin) or a crontab entry
    // (linux); there is no Windows Task Scheduler counterpart to probe. Refusing here unconditionally made
    // every CLI invocation on Windows fail before reaching any of this
    // file's own Windows-specific handling (the `platform` test seam, the
    // Windows-specific mount/rename checks) — none of it was ever
    // reachable outside a test that overrides `assertSchedulerDisabled`
    // directly, since the CLI's `main()` never exposes that override
    //. Absence of the
    // mechanism this checks for is a real "disabled" on this platform, not
    // an unverifiable unknown.
    return;
  }
  throw new Error(
    `scheduled reaper verification is unsupported on ${process.platform}`,
  );
}

/**
 * `token` is the ownership value written into the lock's own JSON content —
 * see `unlinkOwnedDestinationLock` for why a deletion must verify it rather
 * than trust `acquired`/`destination` (proof this invocation once wrote a
 * lock here) alone.
 */
interface DestinationLockState {
  acquired: boolean;
  destination: string | null;
  token: string | null;
}

/** Migrate every classified artifact, leaving unrelated source entries alone. */
export async function migrateStateDir(
  sourceArg: string,
  destinationArg: string,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  // Ownership tracking, not just observed state: `lockState.acquired` is set
  // true ONLY by the `writeExclusiveDurable` call inside `migrateStateDirImpl`
  // actually succeeding for THIS invocation. An earlier version released the
  // lock in the catch below whenever `destination` merely LOOKED empty —
  // which is also true while a DIFFERENT, still-in-progress migration owns
  // the lock and simply hasn't moved anything yet. A refused THIRD migration
  // would then delete the second migration's still-live lock and let a
  // fourth one in, merging state undetected. Only the invocation that
  // actually created the lock may ever remove it — and `lockState.destination`
  // records the EXACT resolved path that was locked, rather than re-deriving it
  // from `destinationArg` here. A symlinked ancestor retargeted between
  // acquisition and this catch could otherwise make
  // `canonicalDestination(destinationArg)` resolve to a DIFFERENT directory
  // than the one actually locked, and — if that directory happened to be empty
  // — unlink an unrelated migration's live lock. `lockState.token` narrows this
  // further still: even the resolved destination path can be legitimately
  // reused by a LATER migration once this one's lock is gone, so the unlink
  // below verifies the lock's own content, not just its path.
  const lockState: DestinationLockState = {
    acquired: false,
    destination: null,
    token: null,
  };
  try {
    return await migrateStateDirImpl(
      sourceArg,
      destinationArg,
      options,
      lockState,
    );
  } catch (error) {
    // Best-effort: if this invocation actually owns the lock AND
    // `destination` ended up genuinely untouched (never created, or exists
    // but empty), it has nothing left to protect — release it so a
    // corrected retry doesn't need manual cleanup. Any other observable
    // state (partially populated, or unreadable) leaves it in place, per
    // `assertNoStaleDestinationLock`'s fail-closed default. Best-effort
    // throughout: a failure here must never mask the real error.
    if (
      lockState.acquired &&
      lockState.destination !== null &&
      lockState.token !== null
    ) {
      try {
        const destination = lockState.destination;
        if (!existsSync(destination) || readdirSync(destination).length === 0) {
          unlinkOwnedDestinationLock(destination, lockState.token);
          fsyncDirectoryBestEffort(dirname(destination));
        }
      } catch {
        // best-effort cleanup on an already-failing path
      }
    }
    throw error;
  }
}

async function migrateStateDirImpl(
  sourceArg: string,
  destinationArg: string,
  options: MigrationOptions,
  lockState: DestinationLockState,
): Promise<MigrationReport> {
  await checkSignal(options.signal);
  if (!isAbsolute(sourceArg) || !isAbsolute(destinationArg)) {
    throw new Error("source and destination must be absolute paths");
  }
  const sourceInfo = lstatSync(sourceArg);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error(`source must be a real directory: ${sourceArg}`);
  }
  const source = realpathSync(sourceArg);
  assertNoStaleMigrationJournal(source);
  const destinationResult = canonicalDestination(destinationArg);
  const destination = destinationResult.path;
  assertNoStaleDestinationLock(destination);
  if (
    source === destination ||
    isInside(source, destination) ||
    isInside(destination, source)
  ) {
    throw new Error(
      "source and destination must be distinct, non-nested directories",
    );
  }

  // `enumerateStateArtifacts` itself is a single synchronous scan (reap-
  // state.ts has measured 112k-entry enumerations taking 130-520ms) that
  // this file cannot yield partway through without changing that shared
  // module's own signature — out of scope for this fix. Checking
  // immediately on either side at least bounds how many such synchronous
  // phases can run back-to-back with zero cancellation points between them.
  await checkSignal(options.signal);
  const inventory = enumerateStateArtifacts(source);
  await checkSignal(options.signal);
  if (inventory.unknown.length > 0) {
    throw new Error(
      `unclassified drive-pr artifacts: ${inventory.unknown.map((entry) => entry.name).join(", ")}`,
    );
  }
  if (inventory.artifacts.length === 0) {
    throw new Error(`source contains no drive-pr artifacts: ${source}`);
  }
  const identities = await captureArtifactIdentities(
    inventory.artifacts,
    options.signal,
  );
  const identitiesByName = new Map(
    identities.map((identity) => [identity.name, identity]),
  );
  const isLive = options.isClaimLive ?? claimLive;
  const isStagingLive = options.isStagingLive ?? stagingLive;
  for (const entry of inventory.artifacts) {
    await checkSignal(options.signal);
    lockClaim(entry, isLive, isStagingLive);
  }
  if (
    inventory.artifacts.some(
      (entry) =>
        entry.category === "reaper" &&
        LIVE_REAP_STATE_DELETE_LOCK_RE.test(entry.name),
    )
  ) {
    throw new Error(
      "a reaper delete lock is present; quiescence cannot be verified",
    );
  }
  // The test seam takes no signal (a test already controls its own
  // resolution point); only the real, subprocess-backed default needs one to
  // honor `--timeout` here too rather than blocking for its own fixed
  // deadline regardless of it.
  if (options.assertSchedulerDisabled) {
    await options.assertSchedulerDisabled();
  } else {
    await assertScheduledReaperDisabled(options.signal);
  }

  if (destinationResult.existed && readdirSync(destination).length > 0) {
    throw new Error(`destination must be empty: ${destination}`);
  }
  // Exclusive from this point on: two migrations from different sources can
  // both legally pass every source-side check while targeting this same
  // destination, since each one's checks only ever compare against its own
  // source's own artifact names.
  //
  // `owner` is a fresh per-invocation token, not derived from anything an
  // operator or a later migration could reproduce — it is what
  // `unlinkOwnedDestinationLock` compares against before ever deleting this
  // file, so a replacement lock a different migration writes at this same
  // path later can never be mistaken for this invocation's own.
  const lockOwnerToken = randomBytes(16).toString("hex");
  // Set the INSTANT the exclusive write below succeeds — not, say, at the
  // top of this function — so a throw from `writeExclusiveDurable` itself
  // (the EEXIST conflict case, or any other own-write failure) correctly
  // leaves `acquired` false. Record the exact resolved `destination`
  // alongside it, so the wrapper's catch never has to re-derive it from the
  // (possibly since-retargeted) raw argument.
  const recordAcquired = (): void => {
    lockState.acquired = true;
    lockState.destination = destination;
    lockState.token = lockOwnerToken;
  };
  try {
    writeExclusiveDurable(
      destinationLockPath(destination),
      JSON.stringify(
        {
          source,
          destination,
          startedAt: new Date().toISOString(),
          owner: lockOwnerToken,
        },
        null,
        2,
      ),
      "destination lock",
    );
  } catch (error) {
    // `ExclusiveDurabilityUnconfirmed` means the publishing `link` already
    // succeeded — the lock IS durably on disk — and only the trailing
    // directory-fsync that would confirm it failed. This invocation DOES own
    // it despite the throw, so ownership must still be recorded before
    // rethrowing: otherwise the top-level catch's `lockState.acquired` check
    // never fires, and a lock this call actually published is left on disk
    // with nothing tracking it.
    if (error instanceof ExclusiveDurabilityUnconfirmed) recordAcquired();
    throw error;
  }
  recordAcquired();
  assertSameDirectory(source, sourceInfo.dev, sourceInfo.ino);
  await checkSignal(options.signal);
  const verifiedInventory = enumerateStateArtifacts(source);
  await checkSignal(options.signal);
  const expectedNames = inventory.artifacts.map((entry) => entry.name);
  if (
    verifiedInventory.unknown.length > 0 ||
    verifiedInventory.artifacts.map((entry) => entry.name).join("\0") !==
      expectedNames.join("\0")
  ) {
    throw new Error(
      "drive-pr artifact population changed during quiescence verification",
    );
  }
  for (const entry of verifiedInventory.artifacts) {
    await checkSignal(options.signal);
    lockClaim(entry, isLive, isStagingLive);
  }
  // A pre-existing destination that is itself a mount point has a device
  // that differs from its own parent's — `sameFilesystem` below only checks
  // the PARENT (correct for an ordinary path, where the parent decides which
  // filesystem receives the new directory entry), so a mount-point
  // destination would silently pick a path that then fails deep inside
  // `rename(2)`/`rmdirSync` with an opaque EXDEV/EBUSY. Refuse explicitly
  // instead.
  if (
    destinationResult.existed &&
    statSync(destination).dev !== statSync(dirname(destination)).dev
  ) {
    throw new Error(`destination must not be a mount point: ${destination}`);
  }
  const sameFilesystem =
    !options.forceCrossFilesystem &&
    statSync(dirname(destination)).dev === sourceInfo.dev;
  // A `source` that is itself a mount point has a device that differs from
  // its own parent's. Only the cross-filesystem (copy-verify-remove) path is
  // exposed to this: its `quarantineSourceArtifacts` stages a safety-net
  // quarantine directory in `dirname(source)` and requires that directory to
  // share `source`'s own device (so the quarantined copies can later be
  // atomically renamed out of `source`) — a mount-point `source` fails that
  // check, but only AFTER the destination has already been durably
  // published (renamed into place and fsynced) and the migration journal
  // written, leaving complete source and destination populations plus a
  // "quarantine"-phase journal and a held destination lock for manual
  // reconciliation. Refuse up front instead, before any of that becomes
  // irrevocable — same posture, and same parent-vs-self device comparison,
  // as the destination check above. The same-filesystem `rename` path never
  // reaches `quarantineSourceArtifacts`, so this is scoped to `!sameFilesystem`
  // — a mount-point source migrating onto the same device it already sits on is
  // not exposed to the defect this refusal exists to prevent.
  if (
    !sameFilesystem &&
    statSync(source).dev !== statSync(dirname(source)).dev
  ) {
    throw new Error(`source must not be a mount point: ${source}`);
  }
  // The device check above still passes for a Linux bind mount (or a btrfs/
  // bcachefs subvolume) that shares `source`'s parent's device number
  // without sharing its actual mount — `rename(2)` can still refuse that
  // pairing with EXDEV, and this file already accounts for the same fact
  // elsewhere (the same-filesystem branch's own EXDEV diagnosis below). For
  // THIS path the consequence is worse than there: the real cross-boundary
  // rename does not happen until `quarantineSourceArtifacts`, which by then
  // runs AFTER the destination has been durably published — so an EXDEV
  // there leaves complete source and destination populations plus a
  // "quarantine"-phase journal for manual reconciliation, exactly what the
  // check above exists to prevent and cannot, on its own, catch. A device
  // number cannot distinguish the two cases (they are equal by
  // construction); an actual throwaway rename across the identical boundary
  // can — performed here, before the copy and before the publish, so a
  // negative turns into an up-front refusal with nothing yet to reconcile.
  if (!sameFilesystem) {
    const probeSource = mkdtempSync(join(source, ".drive-pr-mount-probe-"));
    let probeQuarantine: string | null = null;
    try {
      probeQuarantine = mkdtempSync(
        join(dirname(source), ".drive-pr-mount-probe-"),
      );
      renameSync(probeSource, join(probeQuarantine, "probe"));
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException)?.code === "EXDEV") {
        throw new Error(
          `source and its parent directory do not support atomic rename ` +
            `between them despite matching device numbers (likely a bind ` +
            `mount or filesystem subvolume boundary): ${source}`,
        );
      }
      throw probeError;
    } finally {
      rmSync(probeSource, { recursive: true, force: true });
      if (probeQuarantine !== null) {
        rmSync(probeQuarantine, { recursive: true, force: true });
      }
    }
  }
  // Windows' `MoveFileEx` refuses to replace an existing directory outright,
  // empty or not (documented precedent: `drive.ts`'s own lock retirement,
  // which removes an emptied slot for exactly this reason). The
  // cross-filesystem publish below relies on `renameSync(stage, destination)`
  // atomically replacing a pre-verified-empty `destination`, which is safe on
  // POSIX but would fail on Windows for a destination that already existed —
  // reject that case up front rather than fail deep inside the publish with
  // an opaque error, or worse, corrupt state via a two-step rmdir+rename that
  // reopens the crash window the atomic-rename comment below exists to close.
  if (
    !sameFilesystem &&
    (options.platform ?? process.platform) === "win32" &&
    destinationResult.existed
  ) {
    throw new Error(
      `destination must not already exist for a cross-filesystem migration on Windows (rename cannot replace an existing directory): ${destination}`,
    );
  }
  const moved = inventory.artifacts.map((entry) => ({
    name: entry.name,
    family: entry.family,
  }));
  let publishedDestinationIdentity: DirectoryIdentity;
  let warnings: string[] = [];

  if (sameFilesystem) {
    if (!destinationResult.existed) mkdirSync(destination);
    publishedDestinationIdentity = directoryIdentity(destination);
    options.beforeSameFilesystemMove?.();
    writeMigrationJournal(
      "same-filesystem-move",
      source,
      destination,
      inventory.artifacts.map((entry) => entry.name),
    );
    const relocated: OwnedArtifactEntry[] = [];
    try {
      for (const [index, entry] of inventory.artifacts.entries()) {
        await checkSignal(options.signal);
        assertSameDirectory(source, sourceInfo.dev, sourceInfo.ino);
        assertSameDirectory(
          destination,
          publishedDestinationIdentity.dev,
          publishedDestinationIdentity.ino,
        );
        const identity = identitiesByName.get(entry.name) as ArtifactIdentity;
        assertArtifactIdentity(source, identity);
        if (identity.kind === "directory") {
          // `renameSync` below moves the whole subtree in one syscall — it
          // repoints a directory entry, never opens or reads what is inside
          // it — so a symlink nested anywhere under a directory artifact
          // passes through completely unexamined and unmodified. The
          // cross-filesystem branch below rejects the identical tree as a
          // side effect of `manifestEntry`'s own recursive walk (it throws
          // on any entry that is neither a directory nor a file), so
          // whether this migration accepts a directory artifact containing
          // a nested symlink used to depend on which filesystem branch ran,
          // for byte-identical input: a relative link can resolve somewhere
          // different after relocation, and an absolute one leaves the
          // migrated state dependent on content outside the destination
          // either way. Reused rather than reimplemented — discarding the
          // manifest it builds — so the two branches cannot drift on what
          // counts as a supported entry; `assertManifestEqual`'s content
          // hashing is unneeded here (`rename(2)` never touches content),
          // but every artifact this migration owns is a small state/lock
          // file, so the extra hashing is not a measurable cost.
          await manifestEntry(entry.path, entry.name, options.signal);
        }
        options.beforeSameFilesystemArtifactMove?.(entry.name, index);
        // `renameSync` silently REPLACES an existing target on POSIX — if
        // some other writer creates an entry of this name in `destination`
        // after the upfront emptiness check, this would destroy it instead
        // of reporting a conflict. This narrows the race rather than closing
        // it outright (Node exposes no `RENAME_NOREPLACE`); it is the same
        // class of best-effort mitigation `assertSameDirectory`/
        // `assertArtifactIdentity` already apply elsewhere in this loop.
        if (existsSync(join(destination, entry.name))) {
          throw new Error(
            `destination already contains an entry named ${entry.name} — ` +
              `refusing to overwrite it (a concurrent writer may have created ` +
              `it): ${join(destination, entry.name)}`,
          );
        }
        try {
          renameSync(entry.path, join(destination, entry.name));
        } catch (renameError) {
          // A matching `st_dev` does not rule out a Linux bind mount over a
          // different underlying filesystem — `sameFilesystem` can pick this
          // path and still hit EXDEV on the first cross-device rename. The
          // rollback below already unwinds safely either way; this only
          // replaces an opaque EXDEV with a diagnosis.
          if ((renameError as NodeJS.ErrnoException)?.code === "EXDEV") {
            throw new Error(
              `same-filesystem move failed with EXDEV (cross-device link) even ` +
                `though device IDs matched — ${destination} is likely a bind ` +
                `mount over a different filesystem than ${source}: ${entry.name}`,
            );
          }
          throw renameError;
        }
        relocated.push(entry);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const entry of relocated.reverse()) {
        try {
          renameSync(join(destination, entry.name), entry.path);
        } catch (rollbackError) {
          rollbackFailures.push(
            `${entry.name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (rollbackFailures.length > 0) {
        throw new Error(
          `same-filesystem move failed and rollback was incomplete (${rollbackFailures.join("; ")}); original error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Rollback fully succeeded — source and destination are both back to
      // their pre-migration shape, so there is nothing left for the journal
      // to describe. Fsync BOTH directories first: the reverse renames above
      // are not otherwise durable, and removing the journal before they are
      // would let a crash retain the journal's deletion while losing some of
      // the rollback's own directory-entry updates — recreating the split
      // population with no recovery marker left to describe it.
      fsyncDirectoryBestEffort(source);
      fsyncDirectoryBestEffort(destination);
      options.beforeRollbackJournalRemoval?.([source, destination]);
      removeMigrationJournal(source);
      throw error;
    }
    fsyncDirectoryBestEffort(source);
    fsyncDirectoryBestEffort(destination);
    // When `destination` did not previously exist, `mkdirSync` above created
    // a new directory entry in its parent; without this, a power loss after
    // this function returns could discard that unsynced entry even though
    // the source removals were persisted, losing the migrated population.
    // The cross-filesystem publish path below already fsyncs its parent for
    // the same reason.
    fsyncDirectoryBestEffort(dirname(destination));
    const journalWarning = removeMigrationJournal(source);
    if (journalWarning !== null) warnings.push(journalWarning);
  } else {
    const stage = join(
      dirname(destination),
      `.${basename(destination)}.drive-pr-migrate-${randomBytes(12).toString("hex")}`,
    );
    mkdirSync(stage);
    try {
      for (const entry of inventory.artifacts) {
        await checkSignal(options.signal);
        assertArtifactIdentity(
          source,
          identitiesByName.get(entry.name) as ArtifactIdentity,
        );
        cpSync(entry.path, join(stage, entry.name), {
          recursive: true,
          errorOnExist: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      }
      const expected: ManifestEntry[] = [];
      for (const entry of inventory.artifacts) {
        expected.push(
          ...(await manifestEntry(entry.path, entry.name, options.signal)),
        );
      }
      const actual = await manifest(stage, options.signal);
      assertManifestEqual(expected, actual);
      await fsyncTreeBestEffort(stage, options.signal);
      // Checked PER ARTIFACT, matching every other loop over `inventory.
      // artifacts`/`identities` in this function — a cross-filesystem
      // migration is exactly the large-population case (a 2,000-artifact
      // measurement) where a signal check only at the loop's end would leave a
      // fired timeout unnoticed for the loop's entire duration, right up
      // against the publish below.
      for (const identity of identities) {
        await checkSignal(options.signal);
        assertArtifactIdentity(source, identity);
      }
      options.beforeCrossFilesystemPublish?.();
      // One more check here, past every per-artifact one above: this is the
      // last point before the journal write and the publish rename both
      // become effectively irrevocable (a rename that already landed cannot
      // be un-published, and a journal already on disk describes a
      // migration that has not actually failed). A signal that fires during
      // the identity loop or the (synchronous) test seam just above would
      // otherwise go unobserved straight through both, publishing a
      // "cancelled" migration anyway and leaving complete source and
      // destination populations plus a recovery journal that needs manual
      // reconciliation rather than a clean cancellation.
      await checkSignal(options.signal);
      // Written BEFORE the publish rename, not only before source quarantine
      // — a crash after publish but before this write left the destination
      // populated with no recovery record at all, and a rerun then refused
      // on "destination must be empty" with nothing to explain why.
      writeMigrationJournal(
        "quarantine",
        source,
        destination,
        inventory.artifacts.map((entry) => entry.name),
      );
      try {
        // `destination`, when it pre-existed, was verified empty above and is
        // never re-populated between that check and here — POSIX `rename(2)`
        // atomically replaces an existing EMPTY directory, so publishing is one
        // atomic rename either way. An earlier version issued a separate
        // `rmdirSync(destination)` first, opening a window where a crash
        // between the two calls left neither a destination nor any marker
        // pointing at the orphaned `stage`.
        renameSync(stage, destination);
      } catch (publishError) {
        // The publish never happened — `source` and `stage` are both
        // untouched, so there is nothing for the journal to describe. The
        // outer catch below still cleans up `stage`.
        removeMigrationJournal(source);
        throw publishError;
      }
      publishedDestinationIdentity = directoryIdentity(destination);
      fsyncDirectoryBestEffort(destination);
      fsyncDirectoryBestEffort(dirname(destination));
      options.afterCrossFilesystemPublish?.();
      warnings = await quarantineSourceArtifacts(
        source,
        inventory.artifacts,
        identitiesByName,
        options.beforeSourceQuarantineMove,
        options.beforeQuarantineCleanup,
        options.signal,
        options.beforeSourceDurabilitySync,
      );
    } catch (error) {
      if (existsSync(stage)) rmSync(stage, { recursive: true });
      throw error;
    }
  }

  const sourceAfter = enumerateStateArtifacts(source);
  assertSameDirectory(
    destination,
    publishedDestinationIdentity.dev,
    publishedDestinationIdentity.ino,
  );
  const destinationAfter = enumerateStateArtifacts(destination);
  assertSameDirectory(
    destination,
    publishedDestinationIdentity.dev,
    publishedDestinationIdentity.ino,
  );
  if (sourceAfter.artifacts.length !== 0 || sourceAfter.unknown.length !== 0) {
    throw new Error("source still contains drive-pr artifacts after migration");
  }
  if (
    destinationAfter.unknown.length !== 0 ||
    destinationAfter.artifacts.map((entry) => entry.name).join("\0") !==
      moved.map((entry) => entry.name).join("\0")
  ) {
    throw new Error(
      "destination does not contain the complete migrated population",
    );
  }
  // Released only here, at fully-verified success — never on a partial or
  // reverted failure. See `assertNoStaleDestinationLock`'s own doc comment
  // for why this errs toward leaving a stale lock behind rather than ever
  // releasing one too early. `unlinkOwnedDestinationLock` re-verifies
  // `lockOwnerToken` against the file's own content immediately before
  // deleting it, so a lock some other migration has since acquired at this
  // same path is left alone rather than deleted out from under it.
  try {
    unlinkOwnedDestinationLock(destination, lockOwnerToken);
    fsyncDirectoryBestEffort(dirname(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnings.push(
        `migration completed, but removing the destination lock failed; remove manually: ${destinationLockPath(destination)} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return {
    source,
    destination,
    mode: sameFilesystem ? "rename" : "copy-verify-remove",
    moved,
    warnings,
  };
}

/**
 * `undefined` means "no `--timeout` given"; `null` means "given, but
 * invalid". Validates the CONVERTED millisecond value that actually reaches
 * `AbortSignal.timeout`, not just the raw seconds float: that function
 * requires a non-negative integer within `setTimeout`'s own delay range
 * (2^31 - 1 ms), and a value such as `0.0001` or `1e300` passes a
 * finite-and-positive check on the seconds value while still producing an
 * out-of-range or non-integer millisecond delay, crashing with an uncaught
 * RangeError instead of this command's own usage error.
 *
 * `Number.parseFloat` accepts a valid numeric PREFIX and silently ignores
 * trailing garbage (`"30seconds"`, `"1x"`, `"1 2"` all parse as `30`, `1`,
 * `1`) — the numeric-grammar check below requires the ENTIRE trimmed
 * argument to match before any conversion happens.
 */
const TIMEOUT_NUMERIC_GRAMMAR = /^[+-]?(\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseTimeoutMs(
  raw: string | undefined,
): number | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!TIMEOUT_NUMERIC_GRAMMAR.test(trimmed)) return null;
  const timeoutSec = Number.parseFloat(trimmed);
  const timeoutMs = Math.round(timeoutSec * 1000);
  const MAX_TIMEOUT_MS = 2147483647;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return timeoutMs;
}

const USAGE =
  "usage: migrate-state-dir.ts (<absolute-source> <absolute-destination> | --from <dir> [--to <dir>]) [--json] [--timeout <seconds>]";

export interface CliArgs {
  /** `--from` mode: the source and destination are state ROOTS. */
  readonly roots: boolean;
  readonly source: string;
  readonly destination: string;
  readonly json: boolean;
  readonly timeoutMs: number | undefined;
}

/** The default state root every clone's directory sits in. */
export function defaultStateRootDir(): string {
  return join(homedir(), ".local", "state", "jig", "drive-pr");
}

/** `~` and `~/…` expanded, then made absolute against the cwd. */
export function expandDir(raw: string): string {
  const expanded =
    raw === "~"
      ? homedir()
      : raw.startsWith("~/")
        ? join(homedir(), raw.slice(2))
        : raw;
  return resolve(expanded);
}

/**
 * The per-clone moves a `--from` migration makes: the root itself when it is
 * one clone's directory (it holds drive-pr artifacts directly), else each
 * immediate subdirectory that holds them, each into the same-named
 * subdirectory of the destination root.
 */
export function planRootMigration(
  fromRoot: string,
  toRoot: string,
): { source: string; destination: string }[] {
  if (enumerateStateArtifacts(fromRoot).artifacts.length > 0)
    return [
      { source: fromRoot, destination: join(toRoot, basename(fromRoot)) },
    ];
  const moves: { source: string; destination: string }[] = [];
  for (const name of readdirSync(fromRoot).sort()) {
    const source = join(fromRoot, name);
    let isDir = false;
    try {
      isDir = lstatSync(source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    if (enumerateStateArtifacts(source).artifacts.length === 0) continue;
    moves.push({ source, destination: join(toRoot, name) });
  }
  return moves;
}

/**
 * Exported so it is directly, hermetically testable — matching every other
 * pure piece of this file (`parseTimeoutMs`, `enumerateStateArtifacts`,
 * `migrateStateDir` itself). Before this it was the one part of the CLI with
 * no testable seam of its own, inlined into `main()` and reachable only by
 * spawning the real process (which also runs the real scheduler probe and
 * real filesystem migration — not a hermetic way to pin argv handling).
 *
 * A single forward pass, not an index-arithmetic filter over the raw argv:
 * the prior version derived positionals via
 * `index !== timeoutIndex && index !== timeoutIndex + 1`, which is correct
 * only while `--timeout` is present. With no `--timeout` at all,
 * `timeoutIndex` is `-1` and `timeoutIndex + 1` is `0` — silently dropping
 * argv[0], the source path, on the documented no-timeout invocation
 *. Consuming each arg exactly
 * once, left to right, has no `-1` to do arithmetic on in the first place.
 */
export function parseCliArgs(args: readonly string[]): CliArgs {
  let json = false;
  let timeoutArg: string | undefined;
  let fromArg: string | undefined;
  let toArg: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--from" || arg === "--to") {
      const value = args[index + 1];
      if (
        value === undefined ||
        (arg === "--from" ? fromArg : toArg) !== undefined
      )
        fail(2, USAGE);
      if (arg === "--from") fromArg = value;
      else toArg = value;
      index++;
    } else if (arg === "--timeout") {
      if (timeoutArg !== undefined || index + 1 >= args.length) {
        fail(2, USAGE);
      }
      timeoutArg = args[++index];
    } else if (arg.startsWith("--")) {
      fail(2, USAGE);
    } else {
      positional.push(arg);
    }
  }
  const timeoutMs = parseTimeoutMs(timeoutArg);
  if (
    timeoutArg !== undefined &&
    (timeoutMs === undefined || timeoutMs === null)
  )
    fail(2, USAGE);
  if (fromArg !== undefined || toArg !== undefined) {
    if (fromArg === undefined || positional.length !== 0) fail(2, USAGE);
    return {
      roots: true,
      source: expandDir(fromArg),
      destination:
        toArg === undefined ? defaultStateRootDir() : expandDir(toArg),
      json,
      timeoutMs: timeoutMs ?? undefined,
    };
  }
  if (positional.length !== 2) fail(2, USAGE);
  return {
    roots: false,
    source: positional[0] as string,
    destination: positional[1] as string,
    json,
    timeoutMs: timeoutMs ?? undefined,
  };
}

function printReport(report: MigrationReport): void {
  console.log(
    `Migrated ${report.moved.length} drive-pr artifacts via ${report.mode}:`,
  );
  for (const item of report.moved)
    console.log(`  ${item.family}\t${item.name}`);
  console.log(`Source: ${report.source}`);
  console.log(`Destination: ${report.destination}`);
  for (const warning of report.warnings) console.warn(`Warning: ${warning}`);
}

async function main(): Promise<number> {
  const { roots, source, destination, json, timeoutMs } = parseCliArgs(
    process.argv.slice(2),
  );
  const options =
    timeoutMs == null ? {} : { signal: AbortSignal.timeout(timeoutMs) };
  if (!roots) {
    const report = await migrateStateDir(source, destination, options);
    if (json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    return 0;
  }
  if (!existsSync(source))
    fail(1, `migrate-state-dir: no such directory: ${source}`);
  const moves = planRootMigration(source, destination);
  if (moves.length === 0)
    fail(1, `migrate-state-dir: no drive-pr state found under ${source}`);
  // One clone at a time, each with the full single-population protocol; a
  // failure stops the run so the operator sees which clone it reached.
  const reports: MigrationReport[] = [];
  for (const move of moves) {
    const report = await migrateStateDir(
      move.source,
      move.destination,
      options,
    );
    reports.push(report);
    if (!json) printReport(report);
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  return 0;
}

if (import.meta.main) runMain("migrate-state-dir", main);
