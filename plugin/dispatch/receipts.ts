/**
 * One receipt per tick under `~/.local/state/jig/dispatch/receipts/<date>/`:
 * the records the tick read and from where, and each action it planned with
 * its reason. The next tick reads the latest receipt for the date the
 * follow-up stage started per repository (`followupSince`), so that window
 * stays where it began however often the tick runs.
 *
 * A tick removes receipts older than the retention, keeping the latest
 * completed one whatever its age, the latest completed one naming each
 * repository, and the latest one recording a follow-up window for each, since
 * a receipt of a refused read names the repository without its window.
 *
 * One tick acts per machine, under the act lock beside the receipts
 * (`tick.lock`), and each repository is read and acted on by one tick at a
 * time, under its observe lock (`observe/<digest>.lock`). A tick takes the
 * observe locks first, never waiting for one, and the act lock last, so no
 * two ticks wait on each other. Each lock holds its holder's pid, which
 * every version of the tick reads, and `<lock>.holder` beside it the
 * identity every lock of the plugin records
 * (`shared/liveness.ts`): host, boot, pid and start time. A lock whose
 * holder ran before this host last restarted, or whose pid now belongs to a
 * process that started at another time, is abandoned and taken over; one
 * whose holder cannot be judged is kept. A lock with no identity beside it,
 * which an earlier version took, is judged by its pid alone.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isMapping } from "../shared/config-layers.ts";
import { swallow } from "../shared/errors.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  legacyIdentity,
  lockIdentity,
  type ProcessIdentity,
} from "../shared/liveness.ts";
import type { LastRun } from "../runtime/component.ts";
import type { ScheduledUpgrade } from "../runtime/upgrade-record.ts";
import type { QuotaRisk, SystemSpending } from "./lib/outbound-report.ts";
import type { NotAdmitted } from "./lib/accounts.ts";
import type { FailureEntry } from "./lib/failures.ts";
import type { LineLoad } from "./lib/dashboard-contract.ts";
import type { ReflectionReport } from "./lib/reflection-route.ts";
import { tickFailure } from "./lib/tick-failure.ts";
import { failureText } from "./lib/text.ts";
import type { Defect, RepoReport } from "./lib/types.ts";

/** Days a receipt is kept unless the machine file's `receipts_days` says otherwise. */
const RETENTION_DAYS = 30;

export interface TickReceipt {
  version: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  /** Whether the tick launched what the machine file enables. */
  apply: boolean;
  exitStatus: number;
  /** Why `--apply` was asked for with a machine file and nothing was started. */
  applyWithheld?: string;
  /** The machine file's accounts a drive's pass is never admitted on, and why: a vendor with no documented pass command, a Codex account while the pass deadline is `0`. */
  accountsNotAdmitted?: NotAdmitted[];
  /** Launch records that do not read, left out of every count. */
  unreadableLaunches?: string[];
  /** Outcome rows that could not be written for records of repositories this tick did not read. */
  unloggedOutcomes?: string[];
  /** Why the outcome log's text copy was not brought up to date. */
  logCopyFailed?: string;
  /** Why the dashboard's line was not written: it keeps showing the tick before. */
  lineFailed?: string;
  /** The repositories another tick held the observe lock of, so this tick neither read nor acted on them. */
  busy?: { path: string; heldBy: string }[];
  /** The outside systems that did not answer in this tick, so no further request went to them in it; the next tick probes each once before it reads on. */
  unanswered?: { system: string; class: string; reason: string }[];
  /** The forge's budget as the tick started, when it was low enough that the optional reads (thread samples, serialization's reads) were skipped. */
  lowBudget?: { remaining: number; limit: number; skipped: string[] };
  /** The host's gauges as the act phase read them, the load factor, each kind's reservation and the launches the load factor held or would hold (`lib/load.ts`); absent from a tick with no machine file. */
  load?: LineLoad;
  /** Why the host's load was not read: the tick admitted its launches by accounts alone. */
  loadUnread?: string;
  /** Milliseconds the tick spent in each of its phases; absent from a receipt written before phases were timed. */
  phasesMs?: Partial<Record<TickPhase, number>>;
  /** The defect that stopped the tick's closing steps; a receipt with one is not completed. */
  defect?: Defect;
  /** The failure ledger after the tick (`lib/failures.ts`): the actions backing off, and the rows at or past the notify threshold; absent when it holds none. */
  failures?: {
    backingOff: FailureEntry[];
    escalated: FailureEntry[];
  };
  /** Why the failure ledger's rows for the repositories and the tick were not written. */
  failuresUnwritten?: string;
  /** The classes that recur, as the reflection route recorded them, left them pending or would record them; absent when it had nothing to do. */
  reflection?: ReflectionReport;
  /** Set on the receipt of a tick that found the tick lock held, naming the holder: it holds only the upgrade its launcher ran, and did nothing else. */
  lockHeldBy?: string;
  /** The plugin upgrade the launcher ran before this tick (`runtime/upgrade-record.ts`); absent from a tick no timer started. */
  upgrade?: ScheduledUpgrade;
  /** Per-system balances and this tick's own spending. */
  outbound?: SystemSpending[];
  /** The ledger did not read; spending and balance are unknown. */
  outboundUnavailable?: boolean;
  /** Quotas the last hour's estimated spending empties before their refill horizon. */
  quotaRisks?: QuotaRisk[];
  repos: RepoReport[];
}

/**
 * The phases of a tick: its start, the observe phase (every repository read
 * at once), the wait for the act lock, the act phase (each repository's
 * plan, log, launches and labels, in turn) and the close. A receipt written
 * before the phases split carries `repos` for the two together.
 */
export type TickPhase =
  | "start"
  | "observe"
  | "wait"
  | "act"
  | "repos"
  | "close";

export function stateRoot(): string {
  return join(homedir(), ".local", "state", "jig", "dispatch");
}

function receiptsRoot(root: string): string {
  return join(root, "receipts");
}

const RUN_ID = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-\d+-[a-f\d]{8}$/;

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Write the receipt atomically; returns its path. */
export function writeReceipt(receipt: TickReceipt, root = stateRoot()): string {
  const dir = join(receiptsRoot(root), receipt.startedAt.slice(0, 10));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${receipt.runId}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // The file's time is when it is published, which the morning report reads:
  // the fsync above can take arbitrarily long, so stamp it just before the
  // rename, which keeps it.
  const published = new Date();
  utimesSync(temporary, published, published);
  renameSync(temporary, path);
  return path;
}

/** Every receipt's path, oldest first. */
export function receiptPaths(root = stateRoot()): string[] {
  let days: string[];
  try {
    days = readdirSync(receiptsRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return days
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort((a, b) => a.localeCompare(b))
    .flatMap((day) =>
      readdirSync(join(receiptsRoot(root), day))
        .filter(
          (name) =>
            name.endsWith(".json") && RUN_ID.test(basename(name, ".json")),
        )
        .sort()
        .map((name) => join(receiptsRoot(root), day, name)),
    );
}

/** Whether a repository entry's `followupSince` is absent or a parseable time. */
function validFollowupSince(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function isRepoEntry(value: unknown): boolean {
  return (
    isMapping(value) &&
    typeof value.path === "string" &&
    Array.isArray(value.actions) &&
    Array.isArray(value.records) &&
    Array.isArray(value.unplaced) &&
    value.unplaced.every(isMapping) &&
    value.records.every(isMapping) &&
    validFollowupSince(value.followupSince)
  );
}

/** A receipt, or `null` when the file does not hold one. */
export function readReceipt(path: string): TickReceipt | null {
  const read = receiptOrWhy(path);
  return typeof read === "string" ? null : read;
}

/** A receipt, or why the file does not hold one: the read's or the parse's error, or the shape it lacks. */
export function receiptOrWhy(path: string): TickReceipt | string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return String(err);
  }
  return isMapping(value) &&
    value.version === 1 &&
    typeof value.runId === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.completed === "boolean" &&
    Array.isArray(value.repos) &&
    value.repos.every(isRepoEntry)
    ? (value as unknown as TickReceipt)
    : "it is not a tick's receipt";
}

/** Receipts read back for a run of failed ticks: each can be large, and a host failing for days holds thousands. */
const FAILED_RUN_READ = 100;

/** Whether a tick that ran passed: it completed with exit 0. */
function passed(receipt: TickReceipt): boolean {
  return receipt.completed && receipt.exitStatus === 0;
}

/**
 * A receipt read back for the last run: the tick's receipt when it ran,
 * `"held"` when it found the lock held and ran nothing (demonstrably no run),
 * `"invalid"` when the file does not hold a receipt (it may record a run that
 * cannot be interpreted, so it is no proof of none).
 */
function ranTick(path: string): TickReceipt | "held" | "invalid" {
  const receipt = readReceipt(path);
  if (receipt === null) return "invalid";
  return receipt.lockHeldBy !== undefined ? "held" : receipt;
}

/**
 * The newest receipt of a tick that ran, for `jig status` and `jig doctor`;
 * null when there is none. A tick that found the lock held ran nothing. A
 * failed one carries its reason and the failed ticks in a row it ends. Every
 * receipt file read, held or invalid ones included, spends one of
 * `FAILED_RUN_READ`; a run still going when they are spent is `capped`, and
 * with none that ran found by then the answer is `unread` when receipts
 * remain, null when there are none to read. A receipt that does not read is
 * an unknown tick, never an absent one: when it is newer than every tick that
 * ran the last run is `unread`, and when it lies inside a run of failed ticks
 * the run is `capped`, at least as long as counted.
 */
export function lastTick(root = stateRoot()): LastRun | null {
  const paths = receiptPaths(root).reverse();
  let reads = 0;
  const next = (
    from: number,
  ): { at: number; receipt: TickReceipt } | "invalid" | null => {
    for (let at = from; at < paths.length && reads < FAILED_RUN_READ; at++) {
      reads++;
      const receipt = ranTick(paths[at] as string);
      if (receipt === "invalid") return "invalid";
      if (receipt !== "held") return { at, receipt };
    }
    return null;
  };
  const newest = next(0);
  if (newest === "invalid" || newest === null) {
    // Receipts left unread, or one that does not read, are an unknown
    // history, not an absent one.
    return newest === "invalid" ||
      (reads >= FAILED_RUN_READ && reads < paths.length)
      ? {
          runId: "",
          startedAt: "",
          completed: false,
          exitStatus: 1,
          path: paths[0] as string,
          unread: reads,
        }
      : null;
  }
  const { receipt } = newest;
  const path = paths[newest.at] as string;
  const last: LastRun = {
    runId: receipt.runId,
    startedAt: receipt.startedAt,
    completed: receipt.completed,
    exitStatus: receipt.exitStatus,
    path,
  };
  if (passed(receipt)) return last;
  let runs = 1;
  let since = receipt.startedAt;
  let from = newest.at + 1;
  let capped = false;
  for (;;) {
    const earlier = next(from);
    if (earlier === "invalid") {
      capped = true;
      break;
    }
    if (earlier === null) {
      // Every read is the next file in order, so `reads` is how far the scan got.
      capped = reads >= FAILED_RUN_READ && reads < paths.length;
      break;
    }
    if (passed(earlier.receipt)) break;
    runs++;
    since = earlier.receipt.startedAt;
    from = earlier.at + 1;
  }
  return {
    ...last,
    reason: tickFailure(receipt),
    failing: {
      runs,
      since,
      capped,
    },
  };
}

/**
 * The follow-up window's start for a repository, as the latest completed
 * receipt that names it recorded; `null` when no receipt does.
 */
export function previousFollowupSince(
  repoPath: string,
  root = stateRoot(),
): string | null {
  for (const path of receiptPaths(root).reverse()) {
    const receipt = readReceipt(path);
    if (receipt === null || !receipt.completed) continue;
    const repo = receipt.repos.find((r) => r.path === repoPath);
    if (repo?.followupSince) return repo.followupSince;
  }
  return null;
}

/** The receipts to keep whatever their age: the latest completed one overall, the latest naming each repository, and the latest holding each repository's follow-up window. */
function newestPerRepository(paths: string[]): Set<string> {
  const keep = new Set<string>();
  const named = new Set<string>();
  const windowed = new Set<string>();
  const first = (seen: Set<string>, repo: string) => {
    const fresh = !seen.has(repo);
    seen.add(repo);
    return fresh;
  };
  const completed = [...paths]
    .reverse()
    .map((path) => ({ path, receipt: readReceipt(path) }))
    .filter((r) => r.receipt?.completed);
  if (completed[0] !== undefined) keep.add(completed[0].path);
  for (const { path, receipt } of completed)
    for (const repo of receipt?.repos ?? []) {
      if (first(named, repo.path)) keep.add(path);
      if (repo.followupSince && first(windowed, repo.path)) keep.add(path);
    }
  return keep;
}

/** Remove receipts past the retention, except those `newestPerRepository` keeps. */
export function pruneReceipts(
  nowMs: number,
  root = stateRoot(),
  days = RETENTION_DAYS,
): string[] {
  const paths = receiptPaths(root);
  const keep = newestPerRepository(paths);
  const cutoff = nowMs - days * 86_400_000;
  const removed: string[] = [];
  for (const path of paths) {
    if (keep.has(path)) continue;
    const day = Date.parse(`${basename(dirname(path))}T00:00:00Z`);
    if (!Number.isFinite(day) || day + 86_400_000 > cutoff) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/** Seconds an unreadable or empty lock is given before it counts as abandoned. */
const LOCK_GRACE_MS = 10_000;
/** The content a reclaim guard holds once its owner is done with it. */
const FINISHED = "finished";

/**
 * Publish `text` at `path` whole and only when nothing is there: it is
 * written to a private file that is then linked to the path, so the file
 * never exists empty and only one writer can create it. False when
 * something already is there.
 */
function publishOnce(path: string, text: string): boolean {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A lock or guard file holding this process's pid, published by `publishOnce`. */
function publishLock(path: string): boolean {
  return publishOnce(path, String(process.pid));
}

/** Where the identity of a lock's holder is recorded, beside the pid the lock itself holds. */
const holderFile = (path: string) => `${path}.holder`;

/**
 * Record this process's identity (`shared/liveness.ts`) beside the lock it
 * has just taken: its host, its boot, its pid and its start time. The lock
 * itself keeps only the pid, which every version of the tick reads. A record
 * that cannot be written leaves the lock judged by its pid alone.
 */
function recordHolder(path: string): void {
  const staged = `${holderFile(path)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(staged, encodeIdentity(lockIdentity()), { mode: 0o600 });
    renameSync(staged, holderFile(path));
  } catch (err) {
    swallow(
      err,
      `${holderFile(path)} cannot be written; the pid alone decides`,
    );
    rmSync(staged, { force: true });
  }
}

/** A lock file's text; `null` when it cannot be read. */
function lockText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    swallow(err, `${path} cannot be read`);
    return null;
  }
}

/**
 * The holder a lock's text names: the identity recorded beside it when that
 * names the same pid and was written no earlier than the lock, else the pid
 * alone, as a lock with no record beside it (a guard, or one an earlier
 * version took) is judged; `null` while the lock is empty or finished.
 */
function holderOf(path: string, text: string | null): ProcessIdentity | null {
  const pid = text?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(pid) || !Number.isSafeInteger(Number(pid)))
    return null;
  try {
    const recorded = decodeIdentity(readFileSync(holderFile(path), "utf8"));
    if (
      recorded !== null &&
      String(recorded.pid) === pid &&
      statSync(holderFile(path)).mtimeMs >= statSync(path).mtimeMs
    )
      return recorded;
  } catch (err) {
    swallow(err, `no holder recorded beside ${path}; its pid decides`);
  }
  return legacyIdentity(Number(pid));
}

function lockHolder(path: string): ProcessIdentity | null {
  return holderOf(path, lockText(path));
}

/**
 * Whether a holder is gone: judged dead because no process has its pid, its
 * pid now belongs to a process that started at another time, or it ran
 * before this host last restarted. A holder that cannot be judged keeps its
 * lock.
 */
function holderGone(holder: ProcessIdentity): boolean {
  const verdict = isAliveSync(holder);
  return verdict.ok && verdict.value.state === "dead";
}

/** Whether the lock file at `path`, whose text is `text`, is abandoned: its holder gone, or none written within the grace. */
function abandoned(path: string, text: string | null): boolean {
  const holder = holderOf(path, text);
  return holder === null ? olderThan(path, LOCK_GRACE_MS) : holderGone(holder);
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms;
  } catch (err) {
    swallow(err, `${path} is gone`);
    return false;
  }
}

/** Whether a lock file's owner is gone: dead, or never wrote its identity within the grace. */
function ownerGone(file: string): boolean {
  if (finished(file)) return true;
  return abandoned(file, lockText(file));
}

/** Whether a guard was marked finished by its owner. */
function finished(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim() === FINISHED;
  } catch (err) {
    swallow(err, `${file} cannot be read`);
    return false;
  }
}

/** The guards of a lock, oldest generation first. */
function guardsOf(path: string): { generation: number; file: string }[] {
  const prefix = `${basename(path)}.reclaim.`;
  const found: { generation: number; file: string }[] = [];
  for (const name of readdirSync(dirname(path)))
    if (name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
      found.push({
        generation: Number(name.slice(prefix.length)),
        file: join(dirname(path), name),
      });
  return found.sort((a, b) => a.generation - b.generation);
}

/**
 * Remove the guards below the newest generation whose owners are gone. The
 * newest guard stays, finished or not, so the next generation is always above
 * every one ever published and a number is never reused.
 */
function sweepGuards(path: string): void {
  const all = guardsOf(path);
  for (const g of all.slice(0, -1))
    if (ownerGone(g.file)) rmSync(g.file, { force: true });
}

/** Replace the lock under the guard when it is still the abandoned one the caller saw. */
function replaceSeen(path: string, seen: string | null): boolean {
  const now = lockText(path);
  if (now !== seen || !abandoned(path, now)) return false;
  rmSync(path, { force: true });
  if (!publishLock(path)) return false;
  recordHolder(path);
  return true;
}

/**
 * Replace a lock the caller saw to be abandoned. Contenders serialize on a
 * guard and re-read the lock under it, so a lock another tick took in the
 * meantime is left alone. A guard is never removed on someone else's
 * observation: a contender publishes the guard of the generation after the
 * newest one, whose owner is gone or which is marked finished, and yields when
 * a newer generation than its own exists. The newest guard is kept, so
 * generations only grow and two contenders never hold the same abandoned lock
 * at once.
 */
function reclaim(path: string, seen: string | null): boolean {
  const newest = guardsOf(path).at(-1);
  if (newest !== undefined && !ownerGone(newest.file)) return false;
  const generation = (newest?.generation ?? 0) + 1;
  const guard = `${path}.reclaim.${generation}`;
  if (!publishLock(guard)) return false;
  try {
    return (
      !guardsOf(path).some((g) => g.generation > generation) &&
      replaceSeen(path, seen)
    );
  } finally {
    writeFileSync(guard, FINISHED);
    sweepGuards(path);
  }
}

/**
 * The index of this tick among the ticks that applied launches, kept in the
 * state directory and advanced by one per call, so rotation does not depend
 * on the timer's interval or on when a tick happens to start. Call it only
 * while holding the tick lock. A counter that is missing or malformed starts
 * over; one that cannot be read or written returns the reason, for an index that
 * is not recorded would repeat and the tick must launch nothing rather than
 * retry the same targets forever.
 */
export function nextTickIndex(root = stateRoot()): number | { failed: string } {
  const path = join(root, "tick-index");
  let last = -1;
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    if (Number.isSafeInteger(value) && value >= 0) last = value;
  } catch (err) {
    // A counter that does not exist yet starts the count; one that cannot be read is an I/O fault.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      swallow(err, `${path} cannot be read`);
      return { failed: `${path} cannot be read: ${failureText(err)}` };
    }
  }
  const index = last + 1;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${index}\n`, { mode: 0o600 });
  } catch (err) {
    swallow(err, `${path} cannot be written`);
    return { failed: `${path} cannot be written: ${failureText(err)}` };
  }
  return index;
}

/** A lock: its release, or who holds it. */
export type Lock = { release: () => void } | { heldBy: string };

/** Take the lock at `path`, taking over one whose holder is gone; its release, or the holder. */
function takeLockAt(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = () => {
    // Only the owner removes the lock: a replaced one belongs to another tick.
    // Its record goes first, so the lock is never left naming a holder it does not have.
    if (lockHolder(path)?.pid !== process.pid) return;
    rmSync(holderFile(path), { force: true });
    rmSync(path, { force: true });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishLock(path)) {
      recordHolder(path);
      return { release };
    }
    const seen = lockText(path);
    if (!abandoned(path, seen)) {
      const holder = holderOf(path, seen);
      const who =
        holder === null ? "a process not yet named" : describeIdentity(holder);
      return { heldBy: `${who} (${path})` };
    }
    if (reclaim(path, seen)) return { release };
  }
  return { heldBy: path };
}

/**
 * The act lock, `tick.lock`: one tick acts per machine. It is the file every
 * earlier version took for its whole tick, so a tick of an older version and
 * one of this version never act at once. Returns its release, or the holder.
 */
export function takeTickLock(root = stateRoot()): Lock {
  return takeLockAt(join(root, "tick.lock"));
}

/**
 * A repository's observe lock, under `observe/` and named by its path's
 * digest: held by one tick from the start of its reads of the repository
 * until its act phase is done with it, so no tick acts on a repository from
 * reads another tick made before acting on it.
 */
export function takeObserveLock(path: string, root = stateRoot()): Lock {
  return takeObserveKey(resolve(path), root);
}

/**
 * A forge repository's observe lock: the records an observation reads and
 * writes belong to the repository, not to a checkout of it, so two checkouts
 * of one repository exclude each other through this lock, taken once the
 * observation knows which repository its checkout is.
 */
export function takeRepositoryLock(slug: string, root = stateRoot()): Lock {
  return takeObserveKey(`repository:${slug}`, root);
}

function takeObserveKey(key: string, root: string): Lock {
  const digest = createHash("sha256").update(key).digest("hex");
  return takeLockAt(join(root, "observe", `${digest.slice(0, 16)}.lock`));
}
