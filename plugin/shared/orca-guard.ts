/**
 * The Orca guard record: the files `jig gc` and Jig's plugin for Orca leave
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
 * as Orca reports it, unnormalised. Every file carries the record envelope
 * (`records/envelope.ts`) and is published whole: written to a temporary
 * file in its directory and renamed (or, for an admission, linked) into
 * place, so a reader never sees a partial one.
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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
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

export const ADMISSION_KIND = "orca-guard-admission";
export const LAUNCH_KIND = "orca-guard-launch";
export const HEARTBEAT_KIND = "orca-guard-heartbeat";
/** The schema version of all three kinds. */
export const GUARD_VERSION = 1;
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
export function guardState(root = guardRoot(), now = Date.now()): GuardState {
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
  const age = Math.round((now - Date.parse(read.value.envelope.at)) / 1000);
  if (Math.abs(age) * 1000 > HEARTBEAT_FRESH_MS)
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

/** The holder an admission's text names, or why it does not read. */
function admissionHolder(
  text: string,
): Outcome<{ holder: ProcessIdentity; at: string }, "unreadable"> {
  const read = decode(text, ADMISSION_KIND);
  if (!read.ok) return failed("unreadable", read.failure.reason);
  if (read.value.envelope.v !== GUARD_VERSION)
    return failed(
      "unreadable",
      `version ${read.value.envelope.v} is not one this version of Jig reads`,
    );
  const holder = decodeIdentity(read.value.payload.holder);
  return holder === null
    ? failed("unreadable", "it names no holder")
    : ok({ holder, at: read.value.envelope.at });
}

/** Whether the admission at `file` is still the one `mine` wrote. */
function stillMine(
  file: string,
  mine: { holder: ProcessIdentity; at: string },
) {
  const text = readText(file);
  if (!text.ok || text.value === null) return false;
  const read = admissionHolder(text.value);
  return (
    read.ok &&
    read.value.at === mine.at &&
    encodeIdentity(read.value.holder) === encodeIdentity(mine.holder)
  );
}

/**
 * Write gc's admission for the worktree Orca reports at `path`: published
 * whole by a link, which fails while another admission stands. One whose
 * holder is judged dead is replaced; one held by a live or unjudgeable
 * process, or that does not read, refuses this one and stays for a person to
 * inspect.
 */
export function admit(
  path: string,
  root = guardRoot(),
  now = new Date(),
  holder: ProcessIdentity = ownIdentity(),
): Outcome<Admission, AdmissionCode> {
  const dir = join(root, "admissions");
  const key = guardKey(path);
  const file = join(dir, `${key}.json`);
  const at = now.toISOString();
  const body = encode(
    {
      kind: ADMISSION_KIND,
      v: GUARD_VERSION,
      key,
      writer: writerOf(holder),
      at,
    },
    { path, holder: JSON.parse(encodeIdentity(holder)) },
  );
  const staged = stagedBeside(dir, `${key}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(staged, `${body}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(staged, { force: true });
    return failed(
      "unwritable",
      `the admission ${file} cannot be written`,
      error,
    );
  }
  try {
    const placed = publish(staged, file);
    if (!placed.ok) return placed;
    const mine = { holder, at };
    if (!stillMine(file, mine))
      return failed("held", `another collection took ${file} first`);
    return ok({
      file,
      key,
      at,
      holder,
      release: () => {
        if (stillMine(file, mine)) rmSync(file, { force: true });
      },
    });
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Link `staged` into place at `file`, replacing an admission only when its holder is dead. */
function publish(
  staged: string,
  file: string,
  retried = false,
): Outcome<true, AdmissionCode> {
  try {
    linkSync(staged, file);
    return ok(true);
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
      : publish(staged, file, true);
  const standing = admissionHolder(text.value);
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
  try {
    renameWithRetry(staged, file);
    return ok(true);
  } catch (error) {
    return failed(
      "unwritable",
      `the stale admission ${file} cannot be replaced`,
      error,
    );
  }
}

// Launch markers ---------------------------------------------------------------

/**
 * Why a launch marker keeps the worktree `admission` admits, or `null`: a
 * marker whose `at` is within `LAUNCH_SETTLING_MS` of `now` (an agent Orca's
 * registry may not list yet), or not before the admission (a launch the hook
 * let through while gc held it). A marker that cannot be read, does not parse
 * or names a version this one does not know keeps it too.
 */
export function launchVeto(
  admission: Pick<Admission, "key" | "at">,
  root = guardRoot(),
  now = Date.now(),
): string | null {
  const file = join(root, "launches", `${admission.key}.json`);
  const text = readText(file);
  if (!text.ok) return `the launch marker ${file} cannot be read`;
  if (text.value === null) return null;
  const read = decode(text.value, LAUNCH_KIND);
  if (!read.ok)
    return `the launch marker ${file} does not read (${read.failure.reason})`;
  const { v, key, at } = read.value.envelope;
  if (v !== GUARD_VERSION)
    return `the launch marker ${file} is version ${v}, which this version of Jig does not read`;
  if (key !== admission.key)
    return `the launch marker ${file} names another worktree's key`;
  const launched = Date.parse(at);
  if (launched >= Date.parse(admission.at))
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
  if (read.ok && read.value.envelope.v === GUARD_VERSION)
    return Date.parse(read.value.envelope.at);
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
export function sweepLaunches(root = guardRoot(), now = Date.now()): string[] {
  const dir = join(root, "launches");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    swallow(error, "the launch markers cannot be listed; none are swept");
    return [];
  }
  const old = (at: number | null): boolean =>
    at !== null && now - at > LAUNCH_RETENTION_MS;
  const swept: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    if (name.endsWith(".tmp")) {
      if (old(mtime(file)) && remove(file)) swept.push(name);
      continue;
    }
    if (!ENTRY.test(name) || !old(launchedAt(file))) continue;
    const aside = stagedBeside(dir, `${name}.sweep`);
    try {
      renameWithRetry(file, aside);
    } catch (error) {
      swallow(error, "the marker moved or is held open; it stays");
      continue;
    }
    if (!old(launchedAt(aside))) restore(aside, file);
    else swept.push(name);
    remove(aside);
  }
  return swept;
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
function restore(aside: string, file: string): void {
  try {
    linkSync(aside, file);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST")
      swallow(error, "the rewritten marker could not be put back");
  }
}
