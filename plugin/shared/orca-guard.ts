/**
 * The launch guard record: the files `jig gc` and Jig's plugin for Orca leave
 * each other, so the plugin's launch hook can refuse an agent launch into a
 * worktree gc is removing, and gc can see a launch the hook let through.
 *
 * The hook must answer within two seconds and must not await a call to the
 * host first, so it decides from files it reads directly. The plugin is plain
 * Node with no dependencies and cannot import this module, so the format is
 * a contract, stated byte for byte in
 * [the collector's README](../gc/README.md#the-launch-guard-record). In
 * `<home>/.local/state/jig/orca-guard/`:
 *
 * - `admissions/<key>.json`, written by gc while it collects the worktree;
 * - `launches/<key>.json`, written by the plugin before each launch it lets
 *   through;
 * - `heartbeat.json`, rewritten by the plugin about every minute.
 *
 * `<key>` is the lowercase hexadecimal SHA-256 of the worktree's path exactly
 * as Orca reports it, unnormalised. An admission also names the repository
 * whose collection wrote it and the incarnation of the worktree it claims
 * (`incarnationOf`), so only that repository settles it from Orca's list,
 * and a worktree made again at the same path does not inherit it. Every file carries the record envelope
 * (`records/envelope.ts`) and is published whole: written to a temporary
 * file in its directory and renamed (or, for an admission, linked) into
 * place, so a reader never sees a partial one. gc marks its admission
 * submitted, by a rename over it, just before `orca worktree rm`; a submitted
 * admission is released only by that call's reply or the worktree's absence.
 * A dead collector's admission is taken over, or deleted once its worktree is
 * gone, under a file lock (`file-lock.ts`) beside it.
 *
 * What a reader makes of a file it cannot read fails closed for gc: an
 * admission or a launch marker that does not parse, or names a version this
 * one does not know, counts as present (the worktree is kept), and such a
 * heartbeat counts as absent (collection is unguarded).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
import { tryFileLockSync } from "./file-lock.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";
import { failed, ok, type Outcome } from "./outcome.ts";
import { decode, encode } from "./records/envelope.ts";
import { renameWithRetry } from "./rename-with-retry.ts";
import type { Writer } from "./records/writer.ts";
import { currentMs, isoFromMs, parseMs } from "./time.ts";

export const ADMISSION_KIND = "orca-guard-admission";
export const LAUNCH_KIND = "orca-guard-launch";
export const HEARTBEAT_KIND = "orca-guard-heartbeat";
/** The schema version of the launch marker and the heartbeat, which the plugin writes. */
export const GUARD_VERSION = 1;
/**
 * The schema version of the admission gc writes: 2 names the repository and
 * the worktree's incarnation. gc still reads version 1, which names neither.
 */
export const ADMISSION_VERSION = 2;
/** A heartbeat is fresh while its `at` is within this of now. */
export const HEARTBEAT_FRESH_MS = 180_000;
/** A launch marker keeps its worktree for this long after its `at`. */
export const LAUNCH_SETTLING_MS = 120_000;
/** gc deletes a launch marker this much older than now. */
export const LAUNCH_RETENTION_MS = 86_400_000;

/** The guard directory under a home directory: `<home>/.local/state/jig/orca-guard`. */
export function guardRoot(home = homedir()): string {
  return join(home, ".local", "state", "jig", "orca-guard");
}

/** The key of a worktree: the lowercase hex SHA-256 of its path as Orca reports it, unnormalised. */
export function guardKey(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

const ENTRY = /^[0-9a-f]{64}\.json$/;

/**
 * The repository as an admission names it: its path with links resolved,
 * where it exists, so two spellings of one repository agree.
 */
export function repositoryOwner(repository: string): string {
  try {
    return realpathSync.native(repository);
  } catch (error) {
    swallow(error, "the repository's path is compared as written");
    return normalize(repository);
  }
}

/**
 * The incarnation of what stands at `path`: its inode and birth time, which a
 * worktree made again at the same path does not share (Orca can reuse the
 * worktree's id, so the id cannot tell them apart). `null` when nothing
 * stands there or it cannot be read. A difference proves another
 * incarnation; equal values prove nothing more than that the inode and birth
 * time agree, so a reader only ever acts on a difference.
 */
export function incarnationOf(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    swallow(error, "nothing readable stands at the path");
    return null;
  }
}

/** A file's text, `null` when it does not exist, or why it cannot be read. */
function readText(file: string): Outcome<string | null, "unreadable"> {
  try {
    return ok(readFileSync(file, "utf8"));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return ok(null);
    return failed("unreadable", `${file} cannot be read`, error);
  }
}

/** A temporary file beside `file`, named so no reader takes it for an entry. */
function stagedBeside(dir: string, name: string): string {
  return join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
}

/** What is wrong with `payload`'s kind-specific fields, or `null` when each is present with its type. */
function missingFields(
  payload: Record<string, unknown>,
  fields: Record<string, "string" | "number" | "pid">,
): string | null {
  for (const [name, type] of Object.entries(fields)) {
    const value = payload[name];
    const good =
      type === "string"
        ? typeof value === "string" && value !== ""
        : type === "pid"
          ? typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value > 0
          : typeof value === "number" && Number.isInteger(value);
    if (!good) return `its ${name} is missing or not a ${type}`;
  }
  return null;
}

const LAUNCH_FIELDS = {
  path: "string",
  workspaceId: "string",
  agent: "string",
} as const;

// The heartbeat --------------------------------------------------------------

/** Whether the plugin guards launches now, and why gc says so. */
export interface GuardState {
  guarded: boolean;
  reason: string;
}

/**
 * Whether Jig's plugin for Orca guards launches: its heartbeat reads and its
 * `at` is within `HEARTBEAT_FRESH_MS` of `now`. A heartbeat that is missing,
 * does not read, or names a version this one does not know leaves collection
 * unguarded.
 */
export function guardState(root = guardRoot(), now = currentMs()): GuardState {
  const unguarded = (why: string): GuardState => ({
    guarded: false,
    reason: `unguarded: ${why}`,
  });
  const text = readText(join(root, "heartbeat.json"));
  if (!text.ok) return unguarded("the Orca plugin's heartbeat cannot be read");
  if (text.value === null)
    return unguarded("the Orca plugin has written no heartbeat");
  const read = decode(text.value, HEARTBEAT_KIND);
  if (!read.ok || read.value.envelope.v !== GUARD_VERSION)
    return unguarded(
      `the Orca plugin's heartbeat does not read (${read.ok ? `version ${read.value.envelope.v}` : read.failure.reason})`,
    );
  const shape = missingFields(read.value.payload, {
    pid: "pid",
    pluginVersion: "string",
  });
  if (shape !== null)
    return unguarded(`the Orca plugin's heartbeat does not read (${shape})`);
  const elapsed = now - parseMs(read.value.envelope.at);
  const age = Math.round(elapsed / 1000);
  if (Math.abs(elapsed) > HEARTBEAT_FRESH_MS)
    return unguarded(`the Orca plugin's heartbeat is ${age} s old`);
  return {
    guarded: true,
    reason: `guarded: the Orca plugin's heartbeat is ${age} s old`,
  };
}

// The admission --------------------------------------------------------------

/** gc's admission to collect one worktree, held until `release`. */
export interface Admission {
  file: string;
  key: string;
  /** When it was written: the envelope's `at`. */
  at: string;
  holder: ProcessIdentity;
  /**
   * When `orca worktree rm` was called under this admission, or `null` while
   * it has not been: set by `submit`, or carried over from the submitted
   * admission of a collector that ended, which this one took over.
   */
  submitted: string | null;
  /**
   * Mark the admission submitted, right before the removal call: it is
   * rewritten in place by a rename, so a reader never finds it absent, and
   * only while it is still this one. On a failure nothing is marked.
   */
  submit(now?: number): Outcome<true, AdmissionCode>;
  /** Delete the admission, when it is still this one. */
  release(): void;
}

export type AdmissionCode = "held" | "unreadable" | "unwritable";

/** An identity as the envelope's writer: the fields both share. */
function writerOf(identity: ProcessIdentity): Writer {
  return {
    host: identity.host,
    ...(identity.bootId === "" ? {} : { bootId: identity.bootId }),
    pid: identity.pid,
    ...(identity.start === "" ? {} : { start: identity.start }),
  };
}

/**
 * What an admission's text says: the worktree's path, its holder, when it was
 * written and submitted, and the repository and the worktree's incarnation it
 * names (`null` for each in a version 1 admission, and for an incarnation gc
 * could not read when it admitted).
 */
interface Standing {
  path: string;
  holder: ProcessIdentity;
  at: string;
  submitted: string | null;
  repository: string | null;
  incarnation: string | null;
}

/** Whether `value` is a field an admission may leave out: absent, or a non-empty string. */
function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value !== "");
}

/** Whether `value` is an admission's `submitted` as it may stand: absent, or a time. */
function isMark(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && !Number.isNaN(parseMs(value)))
  );
}

/** What an admission's text says, or why it does not read. */
function admissionHolder(
  text: string,
  key: string,
): Outcome<Standing, "unreadable"> {
  const read = decode(text, ADMISSION_KIND);
  if (!read.ok) return failed("unreadable", read.failure.reason);
  const version = read.value.envelope.v;
  if (version !== 1 && version !== ADMISSION_VERSION)
    return failed(
      "unreadable",
      `version ${version} is not one this version of Jig reads`,
    );
  const { path, submitted, repository, incarnation } = read.value.payload;
  if (
    typeof path !== "string" ||
    path === "" ||
    read.value.envelope.key !== key ||
    guardKey(path) !== key
  )
    return failed("unreadable", "it does not name the worktree of its key");
  if (!isMark(submitted))
    return failed("unreadable", "its submitted mark is not a time");
  // Version 1 names neither its repository nor the worktree's incarnation.
  const owner = {
    repository: null as string | null,
    incarnation: null as string | null,
  };
  if (version === ADMISSION_VERSION) {
    if (
      typeof repository !== "string" ||
      repository === "" ||
      !isOptionalText(incarnation)
    )
      return failed(
        "unreadable",
        "it does not name its repository, or its incarnation is not text",
      );
    owner.repository = repository;
    owner.incarnation = incarnation ?? null;
  }
  const holder = decodeIdentity(read.value.payload.holder);
  return holder === null
    ? failed("unreadable", "it names no holder")
    : ok({
        path,
        holder,
        at: read.value.envelope.at,
        submitted: submitted ?? null,
        ...owner,
      });
}

/** Whether the admission at `file` is still the one `mine` wrote. */
function stillMine(
  file: string,
  key: string,
  mine: { holder: ProcessIdentity; at: string },
) {
  const text = readText(file);
  if (!text.ok || text.value === null) return false;
  const read = admissionHolder(text.value, key);
  return (
    read.ok &&
    read.value.at === mine.at &&
    encodeIdentity(read.value.holder) === encodeIdentity(mine.holder)
  );
}

/** Write `body` to a new temporary file beside `file`; its path, or why it cannot be written. */
function stage(
  dir: string,
  file: string,
  body: string,
): Outcome<string, AdmissionCode> {
  const staged = stagedBeside(dir, basename(file));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(staged, body, { flag: "wx", mode: 0o600 });
    return ok(staged);
  } catch (error) {
    rmSync(staged, { force: true });
    return failed(
      "unwritable",
      `the admission ${file} cannot be written`,
      error,
    );
  }
}

/** Whether an admission written for the incarnation `recorded` is provably not for `current`. */
function otherIncarnation(
  recorded: string | null,
  current: string | null,
): boolean {
  return recorded !== null && current !== null && recorded !== current;
}

/**
 * Write gc's admission, for `repository`'s collection, of the worktree Orca
 * reports at `path`, naming the incarnation that stands there now: published
 * whole by a link, which fails while another admission stands. One whose
 * holder is judged dead is taken over, keeping its submitted mark unless it
 * was written for another incarnation of the worktree (that removal is
 * settled: what it removed is gone); one held by a live or unjudgeable
 * process, or that does not read, refuses this one and stays for a person to
 * inspect.
 */
export function admit(
  path: string,
  repository: string,
  root = guardRoot(),
  now = currentMs(),
  holder: ProcessIdentity = ownIdentity(),
): Outcome<Admission, AdmissionCode> {
  const dir = join(root, "admissions");
  const key = guardKey(path);
  const file = join(dir, `${key}.json`);
  const at = isoFromMs(now);
  const owner = repositoryOwner(repository);
  const incarnation = incarnationOf(path);
  const body = (submitted: string | null): string =>
    `${encode(
      {
        kind: ADMISSION_KIND,
        v: ADMISSION_VERSION,
        key,
        writer: writerOf(holder),
        at,
      },
      {
        path,
        repository: owner,
        ...(incarnation === null ? {} : { incarnation }),
        holder: JSON.parse(encodeIdentity(holder)),
        ...(submitted === null ? {} : { submitted }),
      },
    )}\n`;
  const staged = stage(dir, file, body(null));
  if (!staged.ok) return staged;
  try {
    const placed = publish(staged.value, file, (from) => {
      if (
        from.submitted === null ||
        otherIncarnation(from.incarnation, incarnation)
      )
        return null;
      writeFileSync(staged.value, body(from.submitted));
      return from.submitted;
    });
    if (!placed.ok) return placed;
    const mine = { holder, at };
    if (!stillMine(file, key, mine))
      return failed("held", `another collection took ${file} first`);
    const admission: Admission = {
      file,
      key,
      at,
      holder,
      submitted: placed.value.submitted,
      submit: (when = currentMs()) => {
        const mark = isoFromMs(when);
        const marked = stage(dir, file, body(mark));
        if (!marked.ok) return marked;
        try {
          if (!stillMine(file, key, mine))
            return failed(
              "held",
              `the admission ${file} is no longer this collection's`,
            );
          renameWithRetry(marked.value, file);
          admission.submitted = mark;
          return ok(true);
        } catch (error) {
          return failed(
            "unwritable",
            `the admission ${file} cannot be marked submitted`,
            error,
          );
        } finally {
          rmSync(marked.value, { force: true });
        }
      },
      release: () => {
        if (stillMine(file, key, mine)) rmSync(file, { force: true });
      },
    };
    return ok(admission);
  } finally {
    rmSync(staged.value, { force: true });
  }
}

/**
 * Rewrite the staged admission to carry the submitted mark of the admission
 * it takes over, when that mark still holds; the mark carried, or `null`.
 */
type CarryMark = (from: Standing) => string | null;

/**
 * Link `staged` into place at `file`, taking over an admission only when its
 * holder is dead; the submitted mark it carried over, or `null`.
 */
function publish(
  staged: string,
  file: string,
  carry: CarryMark,
  retried = false,
): Outcome<{ submitted: string | null }, AdmissionCode> {
  try {
    linkSync(staged, file);
    return ok({ submitted: null });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST")
      return failed(
        "unwritable",
        `the admission ${file} cannot be written`,
        error,
      );
  }
  const text = readText(file);
  if (!text.ok) return text;
  // Gone between the link and the read: its holder released it.
  if (text.value === null)
    return retried
      ? failed("held", `another collection is taking ${file}`)
      : publish(staged, file, carry, true);
  return replaceDead(staged, file, text.value, carry);
}

/** The standing admission at `file` when its holder is judged dead, or why it is not gc's to take. */
function deadStanding(
  file: string,
  text: string,
): Outcome<Standing, AdmissionCode> {
  const standing = admissionHolder(text, basename(file, ".json"));
  if (!standing.ok)
    return failed(
      "unreadable",
      `an admission gc cannot read stands at ${file} (${standing.failure.reason}); remove it after inspection`,
    );
  const verdict = isAliveSync(standing.value.holder);
  const who = describeIdentity(standing.value.holder);
  if (!verdict.ok || verdict.value.state !== "dead")
    return failed(
      "held",
      `another collection holds ${file} (${who}: ${verdict.ok ? verdict.value.reason : verdict.failure.reason})`,
    );
  return standing;
}

/**
 * Run `body` under the reclaim lock of the admission at `file`: two
 * collectors can judge the same dead admission, and only the lock's holder
 * may act on it. The lock is the shared file lock (`file-lock.ts`), which
 * publishes it whole and hands a dead holder's lock to one reclaimer at a
 * time without moving a live owner's.
 */
function underReclaimLock<T, Code extends string>(
  file: string,
  body: () => Outcome<T, Code>,
): Outcome<T, Code | AdmissionCode> {
  try {
    const held = tryFileLockSync(file, body, {
      root: dirname(file),
      name: "reclaim",
    });
    if (held !== null) return held.value;
  } catch (error) {
    return failed(
      "unwritable",
      `the stale admission ${file} cannot be settled`,
      error,
    );
  }
  return failed(
    "held",
    `another collection is settling the stale admission ${file}`,
  );
}

/**
 * Take over the admission `text` at `file` with `staged` when its holder is
 * judged dead, under the reclaim lock: the lock's holder reads the admission
 * again and replaces it, by a rename so the hook never finds the worktree
 * unclaimed, only while it is still the one judged; a contender that finds
 * the lock taken or the admission changed is refused. A submitted admission
 * stays submitted, its mark carried into the one that replaces it, unless
 * `carry` finds the mark settled.
 */
function replaceDead(
  staged: string,
  file: string,
  text: string,
  carry: CarryMark,
): Outcome<{ submitted: string | null }, AdmissionCode> {
  const standing = deadStanding(file, text);
  if (!standing.ok) return standing;
  return underReclaimLock(
    file,
    (): Outcome<{ submitted: string | null }, AdmissionCode> => {
      try {
        const now = readText(file);
        if (!now.ok) return now;
        if (now.value !== null && now.value !== text)
          return failed("held", `another collection took ${file} first`);
        const submitted = carry(standing.value);
        if (now.value === null) linkSync(staged, file);
        else renameWithRetry(staged, file);
        return ok({ submitted });
      } catch (error) {
        if (errnoCode(error) === "EEXIST")
          return failed("held", `another collection took ${file} first`);
        return failed(
          "unwritable",
          `the stale admission ${file} cannot be replaced`,
          error,
        );
      }
    },
  );
}

/**
 * An admission whose holder is judged dead: its file, the worktree it names,
 * whether its removal was submitted, and the repository and incarnation it
 * names (`null` when it does not name one).
 */
export interface StaleAdmission {
  file: string;
  path: string;
  submitted: string | null;
  repository: string | null;
  incarnation: string | null;
}

/**
 * The admissions under `root` whose holder is judged dead, each with the
 * worktree path it names. One that does not read, or whose holder is live or
 * cannot be judged, is left out, and so is every one when the directory
 * cannot be listed.
 */
export function staleAdmissions(root = guardRoot()): StaleAdmission[] {
  const dir = join(root, "admissions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => ENTRY.test(name));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      swallow(error, "the admissions cannot be listed; none are settled");
    return [];
  }
  const stale: StaleAdmission[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const text = readText(file);
    if (!text.ok || text.value === null) continue;
    const standing = deadStanding(file, text.value);
    if (standing.ok) {
      const { path, submitted, repository, incarnation } = standing.value;
      stale.push({ file, path, submitted, repository, incarnation });
    }
  }
  return stale;
}

/** An admission under the guard root that gc cannot read: the file and why. */
export interface UnreadableAdmission {
  file: string;
  reason: string;
}

/**
 * The admissions under `root` that do not read or are malformed. They still
 * block launches under the fail-closed contract, so a collection reports each
 * for a person to inspect.
 */
export function unreadableAdmissions(
  root = guardRoot(),
): UnreadableAdmission[] {
  const dir = join(root, "admissions");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => ENTRY.test(name));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      swallow(error, "the admissions cannot be listed; none are reported");
    return [];
  }
  const found: UnreadableAdmission[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const text = readText(file);
    if (!text.ok) {
      found.push({ file, reason: text.failure.reason });
      continue;
    }
    if (text.value === null) continue;
    const standing = admissionHolder(text.value, basename(file, ".json"));
    if (!standing.ok) found.push({ file, reason: standing.failure.reason });
  }
  return found;
}

/**
 * Delete the admission for the worktree at `path` when its holder is judged
 * dead, it names `repository` (whose list of Orca's worktrees the caller has
 * already read the worktree's absence from), and `absent` (the worktree's
 * absence from the disk, read last) holds: under the reclaim lock, after
 * reading the admission again.
 */
export function releaseAbsent(
  path: string,
  repository: string,
  absent: () => boolean,
  root = guardRoot(),
): Outcome<true, AdmissionCode | "present"> {
  const owner = repositoryOwner(repository);
  return releaseSettled(
    path,
    (standing) =>
      standing.repository !== owner
        ? `the claim on ${path} is not ${owner}'s to settle`
        : absent()
          ? null
          : `the worktree at ${path} is on the disk again`,
    root,
  );
}

/**
 * Delete the admission for the worktree at `path` when its holder is judged
 * dead and it was written for an incarnation other than the one standing at
 * `path` now (read last): what it claimed is gone, and the worktree made
 * again there is not its to keep. An admission that names no incarnation, or
 * a worktree whose incarnation cannot be read, is kept.
 */
export function releaseSuperseded(
  path: string,
  root = guardRoot(),
): Outcome<true, AdmissionCode | "present"> {
  return releaseSettled(
    path,
    (standing) =>
      otherIncarnation(standing.incarnation, incarnationOf(path))
        ? null
        : `the worktree at ${path} is still the one the claim was written for, or its incarnation cannot be told`,
    root,
  );
}

/**
 * Delete the admission for the worktree at `path` when its holder is judged
 * dead and `unsettled`, given what it says, finds nothing that keeps it
 * (`null`; otherwise why it stays): under the reclaim lock, after reading the
 * admission again.
 */
function releaseSettled(
  path: string,
  unsettled: (standing: Standing) => string | null,
  root: string,
): Outcome<true, AdmissionCode | "present"> {
  const file = join(root, "admissions", `${guardKey(path)}.json`);
  return underReclaimLock(
    file,
    (): Outcome<true, AdmissionCode | "present"> => {
      const text = readText(file);
      if (!text.ok) return text;
      if (text.value === null) return ok(true);
      const standing = deadStanding(file, text.value);
      if (!standing.ok) return standing;
      const why = unsettled(standing.value);
      if (why !== null) return failed("present", why);
      try {
        rmSync(file, { force: true });
        return ok(true);
      } catch (error) {
        return failed(
          "unwritable",
          `the stale admission ${file} cannot be deleted`,
          error,
        );
      }
    },
  );
}

// Launch markers ---------------------------------------------------------------

/**
 * Why a launch marker keeps the worktree `admission` admits, or `null`: a
 * marker whose `at` is within `LAUNCH_SETTLING_MS` of `now` (an agent Orca's
 * registry may not list yet), or not before the admission (a launch the hook
 * let through while gc held it). A marker that cannot be read, does not parse,
 * lacks a field of its kind or names a version this one does not know keeps it
 * too. A sweep interrupted while it held the marker aside leaves it under
 * another name; that copy counts when the canonical file is absent, and a
 * directory that cannot be listed (other than by not existing) keeps it too.
 */
export function launchVeto(
  admission: Pick<Admission, "key" | "at">,
  root = guardRoot(),
  now = currentMs(),
): string | null {
  const dir = join(root, "launches");
  const name = `${admission.key}.json`;
  const canonical = vetoOf(join(dir, name), admission, now);
  if (canonical !== undefined) return canonical;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((entry) =>
      entry.startsWith(`.${name}.sweep.`),
    );
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      return `the launch markers in ${dir} cannot be listed`;
  }
  for (const entry of names) {
    const aside = vetoOf(join(dir, entry), admission, now);
    if (typeof aside === "string") return aside;
  }
  return null;
}

/** A marker's veto, `null` when it keeps nothing, `undefined` when there is no such file. */
function vetoOf(
  file: string,
  admission: Pick<Admission, "key" | "at">,
  now: number,
): string | null | undefined {
  const text = readText(file);
  if (!text.ok) return `the launch marker ${file} cannot be read`;
  if (text.value === null) return undefined;
  const read = decode(text.value, LAUNCH_KIND);
  if (!read.ok)
    return `the launch marker ${file} does not read (${read.failure.reason})`;
  const { v, key, at } = read.value.envelope;
  if (v !== GUARD_VERSION)
    return `the launch marker ${file} is version ${v}, which this version of Jig does not read`;
  if (key !== admission.key)
    return `the launch marker ${file} names another worktree's key`;
  const shape = missingFields(read.value.payload, LAUNCH_FIELDS);
  if (shape !== null)
    return `the launch marker ${file} does not read (${shape})`;
  const launched = parseMs(at);
  if (launched >= parseMs(admission.at))
    return `Orca launched an agent in the worktree at ${at}, after gc's admission`;
  const age = Math.round((now - launched) / 1000);
  return now - launched <= LAUNCH_SETTLING_MS
    ? `Orca launched an agent in the worktree ${age} s ago, within the ${LAUNCH_SETTLING_MS / 1000} s settling window`
    : null;
}

/** When a launch marker's text says it was written, or its file's modification time when it does not read. */
function launchedAt(file: string): number | null {
  const text = readText(file);
  if (!text.ok || text.value === null) return null;
  const read = decode(text.value, LAUNCH_KIND);
  if (
    read.ok &&
    read.value.envelope.v === GUARD_VERSION &&
    missingFields(read.value.payload, LAUNCH_FIELDS) === null
  )
    return parseMs(read.value.envelope.at);
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    swallow(error, "the marker is gone");
    return null;
  }
}

/**
 * Delete the launch markers, and the plugin's abandoned temporary files,
 * older than `LAUNCH_RETENTION_MS`. A marker is set aside under another name
 * and read again before it is deleted; one the plugin rewrote meanwhile goes
 * back unless a newer one already took its place. Returns the names deleted.
 */
export function sweepLaunches(root = guardRoot(), now = currentMs()): string[] {
  const dir = join(root, "launches");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      swallow(error, "the launch markers cannot be listed; none are swept");
    return [];
  }
  const old = (at: number | null): boolean =>
    at !== null && now - at > LAUNCH_RETENTION_MS;
  return names.filter((name) => sweepOne(dir, name, old));
}

/** Delete one entry of the launch markers' directory when it is old; whether it was deleted. */
function sweepOne(
  dir: string,
  name: string,
  old: (at: number | null) => boolean,
): boolean {
  const file = join(dir, name);
  if (name.endsWith(".tmp")) return old(mtime(file)) && remove(file);
  if (!ENTRY.test(name) || !old(launchedAt(file))) return false;
  const aside = stagedBeside(dir, `${name}.sweep`);
  try {
    renameWithRetry(file, aside);
  } catch (error) {
    swallow(error, "the marker moved or is held open; it stays");
    return false;
  }
  const stillOld = old(launchedAt(aside));
  // A marker rewritten meanwhile stays where launchVeto reads it, under the
  // aside's name, until it is back or a newer one stands in its place.
  if (stillOld || restore(aside, file)) remove(aside);
  return stillOld;
}

function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    swallow(error, "the file is gone");
    return null;
  }
}

function remove(file: string): boolean {
  try {
    rmSync(file, { force: true });
    return true;
  } catch (error) {
    swallow(error, "the file stays for the next sweep");
    return false;
  }
}

/** Put a marker rewritten during the sweep back, unless a newer one took its place. */
function restore(aside: string, file: string): boolean {
  try {
    linkSync(aside, file);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return true;
    swallow(error, "the rewritten marker stays aside, where it still counts");
    return false;
  }
}
