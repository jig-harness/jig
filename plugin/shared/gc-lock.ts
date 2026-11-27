import { GcError } from "./gc-error.ts";
/**
 * Cooperative reader/writer admission for resource publication. Without
 * captured ownership evidence a lock is never stolen.
 *
 * A creator's admission token (`reader-<pid>-<uuid>`) and a collector's
 * `writer` file each hold their process's identity (`liveness.ts`); a token
 * in its earlier empty form names its pid in its name, and a writer in its
 * earlier form holds a bare pid. A token whose record names its host and
 * whose process that host proves gone (no process has the pid with that
 * start time, or the host restarted since) can no longer protect anything:
 * the collector removes it and says so. Any other token that is not alive,
 * one with no record, an earlier form that names no host, one from another
 * host or one whose process table cannot be read, is reported with its
 * holder and why it counts as gone, kept, and listed by
 * `unprovenAdmissionTokens` for a person to inspect.
 *
 * The `install` kind, which no creator's token admits, takes over a writer
 * whose recorded holder is judged dead (`exclusiveInstallLock`): an
 * install, a refresh or a scheduled upgrade killed while it held the lock
 * would otherwise refuse every later one until a person removed the file.
 * The `scratch` kind takes over a writer only when its record proves its
 * holder gone (`WRITER_TAKEOVER_KINDS`). The takeover runs under a file lock
 * (`file-lock.ts`), and removes the writer only while it still holds what
 * was judged dead. Collection of any other kind never takes a writer over. A
 * fresh fixture publisher may recover its own kind of writer, which carries
 * a distinct marker alongside the identity.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  linkSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
import { tryFileLockSync, withFileLock } from "./file-lock.ts";
import { isRecord } from "./guards.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";
import { log } from "./log.ts";
import { attempt, failed, type Outcome } from "./outcome.ts";
import { currentMs } from "./time.ts";

function gcLockRoot(): string {
  return join(homedir(), ".local", "state", "jig", "gc-locks");
}

/** The identity a token or writer file records, in today's form or the earlier one. */
function recorded(
  content: string,
  namedPid: number | null,
): ProcessIdentity | null {
  const text = content.trim();
  if (text === "") return namedPid === null ? null : legacyIdentity(namedPid);
  if (/^[1-9][0-9]*$/.test(text)) return legacyIdentity(Number(text));
  return decodeIdentity(text);
}

/** What a recorded holder is judged to be: running, ended, or not decidable from this host. */
type Holder = "alive" | "dead" | "unknown";

interface Judged {
  holder: Holder;
  /** The holder is judged dead (it may still be one gc cannot prove). */
  gone: boolean;
  /**
   * The holder is dead on the strength of a record that names its host: no
   * process of this host has that pid and start time, or this host restarted
   * since. An earlier record that names no host is never proof.
   */
  proven: boolean;
  text: string;
}

/**
 * The file at `path` with its holder as judged now: `gone` only for a holder
 * judged dead, never for one that cannot be read or judged. `null` when the
 * file is gone.
 */
function judged(path: string, namedPid: number | null): Judged | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    const cause = error instanceof Error ? error.message : String(error);
    return {
      holder: "unknown",
      gone: false,
      proven: false,
      text: `${path}: its holder cannot be read (${cause})`,
    };
  }
  const identity = recorded(content, namedPid);
  if (identity === null)
    return {
      holder: "unknown",
      gone: false,
      proven: false,
      text: `${path}: it names no holder to judge`,
    };
  const verdict = isAliveSync(identity);
  const reason = verdict.ok ? verdict.value.reason : verdict.failure.reason;
  const holder: Holder = !verdict.ok ? "unknown" : verdict.value.state;
  const names = identity.hostId !== "" || identity.host !== "";
  return {
    holder,
    gone: holder === "dead",
    proven: holder === "dead" && names,
    text: `${path} (${describeIdentity(identity)}): ${reason}`,
  };
}

/** The pid a token's name carries, `reader-<pid>-<uuid>`. */
function namedPid(name: string): number | null {
  const pid = /^reader-([1-9][0-9]*)-/.exec(name)?.[1];
  return pid === undefined ? null : Number(pid);
}

/** A Worker has its own set even when its process id matches this isolate's. */
const heldReaderTokens = new Set<string>();
class GcAdmissionBusy extends GcError {}
class StaleScratchCollector extends GcError {}

export function sharedGcLock(kind: string, root = gcLockRoot()): () => void {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = join(dir, `reader-${process.pid}-${randomUUID()}`);
  writeFileSync(token, encodeIdentity(ownIdentity()), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    // A reader publishes before checking the writer. The writer publishes
    // before enumerating readers, so at least one side observes the other.
    // A writer whose process is gone collects nothing, so it cannot race
    // this creation; it stays for the next collector to report.
    const writer = readdirSync(dir).includes("writer")
      ? judged(join(dir, "writer"), null)
      : null;
    if (writer !== null && !writer.gone)
      throw new GcAdmissionBusy(
        `gc ${kind}: collection in progress (${writer.text}); retry creation`,
      );
  } catch (error) {
    rmSync(token);
    throw error;
  }
  heldReaderTokens.add(token);
  return () => {
    heldReaderTokens.delete(token);
    rmSync(token, { force: true });
  };
}

/**
 * The kinds whose collector takes over a writer left by a collector that was
 * killed, once the writer's own record proves its process gone. `install`
 * takes over any writer judged dead, a record that names no host included
 * (`exclusiveInstallLock`). The scratch collector proves every scope again
 * before it removes anything, removes a root before it retires that root's
 * registration, and finds a registration whose roots are gone retirable, so
 * a successor can go on from a stop between those steps.
 */
const WRITER_TAKEOVER_KINDS: ReadonlySet<string> = new Set(["scratch"]);

/** Whether the collector of `kind` removes this writer itself. */
function takesOverWriter(kind: string, writer: Judged): boolean {
  return kind === "install"
    ? writer.gone
    : writer.proven && WRITER_TAKEOVER_KINDS.has(kind);
}

/**
 * Removes every creator's token whose record proves its process gone, and
 * returns the names that remain. Under the writer, no creator is admitted,
 * and a token's name is unique, so a token judged dead cannot be written
 * again.
 */
function reapProvenDeadTokens(
  kind: string,
  dir: string,
  names: string[],
): string[] {
  return names.filter((name) => {
    const path = join(dir, name);
    if (heldReaderTokens.has(path)) return true;
    const token = judged(path, namedPid(name));
    if (token === null) return false;
    if (!token.proven) return true;
    rmSync(path, { force: true });
    log.warn("Removed an admission token whose process is gone", {
      kind,
      holder: token.text,
    });
    return false;
  });
}

/**
 * Why collection cannot be admitted while creators' tokens stand: the live
 * or unjudgeable ones as creators holding the lock, the stale ones, whose
 * process is gone but not provably, with their holders and why each counts as
 * gone, for a person to inspect and remove.
 */
function admissionRefusal(kind: string, dir: string, names: string[]): string {
  const tokens = names.flatMap((name) => {
    const token = judged(join(dir, name), namedPid(name));
    return token === null ? [] : [token];
  });
  const held = tokens.filter((t) => !t.gone).map((t) => t.text);
  const stale = tokens.filter((t) => t.gone).map((t) => t.text);
  const parts: string[] = [];
  if (held.length > 0)
    parts.push(`a creator holds the lock: ${held.join("; ")}`);
  if (stale.length > 0)
    parts.push(
      `stale admission token ${stale.join("; stale admission token ")}; gc removes a token only when its record names this host and the host proves its process gone, and this one cannot be proven: remove it after inspection`,
    );
  if (parts.length === 0)
    parts.push("a creator held the lock as collection began; retry");
  return `gc ${kind}: ${parts.join("; ")}`;
}

/** How long a token that no one can judge may stand before it is a need: a creator on another host holds one only while it creates a scope. */
const UNPROVEN_TOKEN_GRACE_MS = 10 * 60_000;

/**
 * Each admission token the collector will not remove and whose holder is not
 * known to be running: a token with no record, an earlier record that names
 * no host, a token of another host, a holder whose process table cannot be
 * read, and a writer whose holder is gone that its kind's collector does not
 * take over. A token of a live process is no entry. Entries stay for a
 * person to inspect: `path` is the file and `why` says what is known of its
 * holder.
 */
export function unprovenAdmissionTokens(
  root = gcLockRoot(),
  now = currentMs(),
): { path: string; why: string }[] {
  return listNames(root).flatMap((kind) =>
    listNames(join(root, kind)).flatMap((name) => {
      const path = join(root, kind, name);
      const why = unprovenReason(kind, name, path, now);
      return why === null ? [] : [{ path, why }];
    }),
  );
}

/** The sorted names in a folder; none when it cannot be read. */
function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    swallow(error, "a folder that cannot be read holds no admission token");
    return [];
  }
}

/** What is known of a token's holder when it is one to report, else `null`. */
function unprovenReason(
  kind: string,
  name: string,
  path: string,
  now: number,
): string | null {
  const role = name === "writer" ? "writer" : "reader";
  if (role === "reader" && !name.startsWith("reader-")) return null;
  const token = judged(path, role === "writer" ? null : namedPid(name));
  return token !== null && isUnproven(kind, role, token, path, now)
    ? token.text
    : null;
}

/** Whether nothing shows the token's holder running and gc will not remove the token. */
function isUnproven(
  kind: string,
  role: "reader" | "writer",
  token: Judged,
  path: string,
  now: number,
): boolean {
  if (token.holder === "alive") return false;
  if (role === "writer" ? takesOverWriter(kind, token) : token.proven)
    return false;
  return token.holder !== "unknown" || older(path, now);
}

/** Whether the file was last written more than the grace ago; a file whose age cannot be read counts as old. */
function older(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > UNPROVEN_TOKEN_GRACE_MS;
  } catch (error) {
    swallow(error, "a token whose age cannot be read is old enough to report");
    return true;
  }
}

/**
 * Creates the writer file holding this process's identity; false when one
 * exists. The identity is written to a private file and linked into place, so
 * a process killed mid-write leaves no empty or partial writer to refuse.
 */
function publishWriter(writer: string, fixture = false): boolean {
  const staged = `${writer}.init-${process.pid}-${randomUUID()}`;
  try {
    const holder = ownIdentity();
    const identity = fixture
      ? JSON.stringify({ ...holder, fixturePublisher: randomUUID() })
      : encodeIdentity(holder);
    writeFileSync(staged, identity, { flag: "wx", mode: 0o600 });
    linkSync(staged, writer);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Earlier collectors decode the identity and ignore this extra marker. */
function isFixturePublisher(seen: string): boolean {
  try {
    const value: unknown = JSON.parse(seen);
    return isRecord(value) && typeof value.fixturePublisher === "string";
  } catch (error) {
    swallow(error, "writer record has no fixture-publisher marker");
    return false;
  }
}

function recoverFixturePublisher(writer: string): boolean {
  const seen = writerText(writer);
  if (seen === null || !isFixturePublisher(seen) || !judged(writer, null)?.gone)
    return false;
  const taken = tryFileLockSync(
    writer,
    () => {
      if (writerText(writer) !== seen) return false;
      const held = judged(writer, null);
      if (!held?.gone) return false;
      rmSync(writer);
      log.warn("Recovered a dead fixture publisher's lock", {
        writer,
        holder: held.text,
      });
      return publishWriter(writer, true);
    },
    { root: dirname(writer), name: "writer-takeover" },
  );
  return taken?.value === true;
}

function fixtureWriterRefusal(writer: string): GcError {
  const seen = writerText(writer);
  if (seen !== null && !isFixturePublisher(seen)) {
    const held = judged(writer, null);
    if (held?.gone && writerText(writer) === seen)
      return new StaleScratchCollector(refusal("scratch", writer, held));
  }
  return new GcAdmissionBusy(
    "gc scratch: a collector or fixture publisher holds the lock",
  );
}

/** The text of the first reader token, not held by this isolate, whose owner is alive. */
function liveReaderBlocker(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    const token = join(dir, name);
    if (!name.startsWith("reader-") || heldReaderTokens.has(token)) continue;
    const held = judged(token, namedPid(name));
    if (held !== null && !held.gone) return held.text;
  }
  return null;
}

/**
 * Exclude older fixture publishers while a fresh registration inventories and
 * modifies the store. Readers held by this isolate cannot publish in parallel.
 */
export function exclusiveFixtureGcLock<T>(root: string, body: () => T): T {
  const dir = join(root, "scratch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const writer = join(dir, "writer");
  if (!publishWriter(writer, true) && !recoverFixturePublisher(writer))
    throw fixtureWriterRefusal(writer);
  let threw = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    const blocker = liveReaderBlocker(dir);
    if (blocker !== null)
      throw new GcAdmissionBusy(
        `gc scratch: another creator holds the lock: ${blocker}`,
      );
    value = body();
  } catch (error) {
    threw = true;
    failure = error;
  }
  try {
    rmSync(writer);
  } catch (error) {
    // The body's own failure, and its retry class, outranks a cleanup fault.
    if (!threw) throw error;
    log.warn("Could not remove the fixture publisher's lock", {
      writer,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (threw) throw failure;
  return value as T;
}

const FIXTURE_ADMISSION_WAIT_MS = 6000;
const FIXTURE_ADMISSION_POLL_MS = 20;

/** Retry a fixture admission only after its attempt has released every lock. */
export function retryFixtureGcAdmission<T>(
  admit: () => Outcome<T>,
): Outcome<T> {
  const deadline = performance.now() + FIXTURE_ADMISSION_WAIT_MS;
  for (;;) {
    const result = admit();
    if (result.ok) return result;
    const { cause } = result.failure;
    if (cause instanceof StaleScratchCollector)
      return failed("fixture-stale-collector", cause.message, cause);
    if (!(cause instanceof GcAdmissionBusy)) return result;
    if (performance.now() >= deadline)
      return failed("fixture-admission-busy", cause.message, cause);
    Bun.sleepSync(FIXTURE_ADMISSION_POLL_MS);
  }
}

export function sharedFixtureGcLock(root = gcLockRoot()): () => void {
  const result = retryFixtureGcAdmission(() =>
    attempt("fixture-admission", "Cannot open scratch admission", () =>
      sharedGcLock("scratch", root),
    ),
  );
  if (!result.ok) throw result.failure.cause;
  return result.value;
}

/** The writer file's text; null when it is gone. */
function writerText(writer: string): string | null {
  try {
    return readFileSync(writer, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Replaces a writer whose holder is judged dead with this process's, under a
 * file lock, only while it still holds `seen`. Null when it took over;
 * otherwise why not: another process holds the writer now, or the takeover's
 * own lock was not taken in time.
 */
async function takeOverDead(
  writer: string,
  seen: string,
): Promise<string | null> {
  const now = () => {
    const held = judged(writer, null);
    return `another process holds it now (${held?.text ?? writer})`;
  };
  const taken = await withFileLock(
    writer,
    async () => {
      if (writerText(writer) !== seen) return now();
      rmSync(writer, { force: true });
      return publishWriter(writer) ? null : now();
    },
    { root: dirname(writer), name: "writer-takeover" },
  );
  return taken === null
    ? "another process is taking it over: the takeover's lock was not taken in time"
    : taken.value;
}

/** Why `writer` cannot be taken: its holder, or, for a holder that exited, what to do. */
function refusal(
  kind: string,
  writer: string,
  held: ReturnType<typeof judged>,
): string {
  return held?.gone === true
    ? `gc ${kind}: ${writer} names a process that has exited (${held.text}); remove it after inspection`
    : `gc ${kind}: another collection holds ${held?.text ?? writer}`;
}

export async function exclusiveGcLock<T>(
  kind: string,
  body: () => Promise<T>,
  root = gcLockRoot(),
  options: { takeOverDead?: boolean } = {},
): Promise<T> {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const writer = join(dir, "writer");
  if (!publishWriter(writer)) {
    const seen = writerText(writer);
    const held = judged(writer, null);
    if (
      held === null ||
      !(options.takeOverDead === true
        ? held.gone
        : takesOverWriter(kind, held)) ||
      seen === null
    )
      throw new GcError(refusal(kind, writer, held));
    const lost = await takeOverDead(writer, seen);
    if (lost !== null)
      throw new GcError(
        `gc ${kind}: ${writer} was not taken over from the holder that exited (${held.text}): ${lost}`,
      );
    console.error(
      `gc ${kind}: took over ${writer} from a holder that has exited (${held?.text})`,
    );
  }
  try {
    const tokens = reapProvenDeadTokens(
      kind,
      dir,
      readdirSync(dir).filter((name) => name.startsWith("reader-")),
    );
    if (tokens.length > 0)
      throw new GcError(admissionRefusal(kind, dir, tokens));
    return await body();
  } finally {
    rmSync(writer);
  }
}

/**
 * The lock installs, refreshes and the scheduled upgrade's opt-out take
 * around the machine files and the scheduler: `exclusiveGcLock`'s `install`
 * kind, taking over a writer whose holder has exited.
 */
export function exclusiveInstallLock<T>(
  body: () => Promise<T>,
  root = gcLockRoot(),
): Promise<T> {
  return exclusiveGcLock("install", body, root, { takeOverDead: true });
}
