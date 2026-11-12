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
 * place, so a reader never sees a partial one. A stale admission is replaced
 * under a `.<key>.json.reclaim` lock created exclusively beside it.
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
import { basename, dirname, join } from "node:path";
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
import { currentMs, isoFromMs, parseMs } from "./time.ts";

export const ADMISSION_KIND = "orca-guard-admission";
export const LAUNCH_KIND = "orca-guard-launch";
export const HEARTBEAT_KIND = "orca-guard-heartbeat";
/** The schema version of every guard record kind. */
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
  key: string,
): Outcome<{ holder: ProcessIdentity; at: string }, "unreadable"> {
  const read = decode(text, ADMISSION_KIND);
  if (!read.ok) return failed("unreadable", read.failure.reason);
  if (read.value.envelope.v !== GUARD_VERSION)
    return failed(
      "unreadable",
      `version ${read.value.envelope.v} is not one this version of Jig reads`,
    );
  const { path } = read.value.payload;
  if (
    typeof path !== "string" ||
    path === "" ||
    read.value.envelope.key !== key ||
    guardKey(path) !== key
  )
    return failed("unreadable", "it does not name the worktree of its key");
  const holder = decodeIdentity(read.value.payload.holder);
  return holder === null
    ? failed("unreadable", "it names no holder")
    : ok({ holder, at: read.value.envelope.at });
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
  now = currentMs(),
  holder: ProcessIdentity = ownIdentity(),
): Outcome<Admission, AdmissionCode> {
  const dir = join(root, "admissions");
  const key = guardKey(path);
  const file = join(dir, `${key}.json`);
  const at = isoFromMs(now);
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
    if (!stillMine(file, key, mine))
      return failed("held", `another collection took ${file} first`);
    return ok({
      file,
      key,
      at,
      holder,
      release: () => {
        if (stillMine(file, key, mine)) rmSync(file, { force: true });
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
  return replaceDead(staged, file, text.value);
}

/**
 * Replace the admission `text` at `file` with `staged` when its holder is
 * judged dead. Two collectors can read the same dead admission, so the
 * replacement runs under a reclaim lock created exclusively beside it: the
 * holder of the lock reads the admission again, replaces it only while it is
 * still the one judged, and a contender that finds the lock taken or the
 * admission changed is refused.
 */
function replaceDead(
  staged: string,
  file: string,
  text: string,
): Outcome<true, AdmissionCode> {
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
  const lock = join(dirname(file), `.${basename(file)}.reclaim`);
  try {
    writeFileSync(lock, `${encodeIdentity(ownIdentity())}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (errnoCode(error) === "EEXIST")
      return failed(
        "held",
        `another collection is replacing the stale admission ${file}; if no collection runs, remove ${lock} after inspection`,
      );
    return failed(
      "unwritable",
      `the stale admission ${file} cannot be replaced`,
      error,
    );
  }
  try {
    const now = readText(file);
    if (!now.ok) return now;
    if (now.value !== null && now.value !== text)
      return failed("held", `another collection took ${file} first`);
    if (now.value !== null) rmSync(file, { force: true });
    linkSync(staged, file);
    return ok(true);
  } catch (error) {
    if (errnoCode(error) === "EEXIST")
      return failed("held", `another collection took ${file} first`);
    return failed(
      "unwritable",
      `the stale admission ${file} cannot be replaced`,
      error,
    );
  } finally {
    rmSync(lock, { force: true });
  }
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
