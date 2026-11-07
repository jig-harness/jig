import { GcError } from "./gc-error.ts";
/**
 * Cooperative reader/writer admission for resource publication. Stale tokens
 * are retained: without captured ownership evidence a lock is never stolen.
 *
 * A creator's admission token (`reader-<pid>-<uuid>`) and a collector's
 * `writer` file each hold their process's identity (`liveness.ts`); a token
 * in its earlier empty form names its pid in its name, and a writer in its
 * earlier form holds a bare pid. A token found stale is reported with its
 * holder and why it counts as gone, and is still never removed by gc.
 *
 * The `install` kind, which no creator's token admits, alone takes over a
 * writer whose recorded holder is judged dead (`exclusiveInstallLock`): an
 * install, a refresh or a scheduled upgrade killed while it held the lock
 * would otherwise refuse every later one until a person removed the file.
 * The takeover runs under a file lock (`file-lock.ts`), and removes the
 * writer only while it still holds what was judged dead. Collection's kinds
 * never take a writer over.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errnoCode } from "./errors.ts";
import { withFileLock } from "./file-lock.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";

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

/**
 * The file at `path` with its holder as judged now: `gone` only for a holder
 * judged dead, never for one that cannot be read or judged. `null` when the
 * file is gone.
 */
function judged(
  path: string,
  namedPid: number | null,
): { gone: boolean; text: string } | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return { gone: false, text: `${path}: its holder cannot be read` };
  }
  const identity = recorded(content, namedPid);
  if (identity === null)
    return { gone: false, text: `${path}: it names no holder to judge` };
  const verdict = isAliveSync(identity);
  const reason = verdict.ok ? verdict.value.reason : verdict.failure.reason;
  return {
    gone: verdict.ok && verdict.value.state === "dead",
    text: `${path} (${describeIdentity(identity)}): ${reason}`,
  };
}

/** The pid a token's name carries, `reader-<pid>-<uuid>`. */
function namedPid(name: string): number | null {
  const pid = /^reader-([1-9][0-9]*)-/.exec(name)?.[1];
  return pid === undefined ? null : Number(pid);
}

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
      throw new GcError(
        `gc ${kind}: collection in progress (${writer.text}); retry creation`,
      );
  } catch (error) {
    rmSync(token);
    throw error;
  }
  return () => rmSync(token, { force: true });
}

/**
 * Why collection cannot be admitted while creators' tokens stand: the live
 * or unjudgeable ones as creators holding the lock, the stale ones with their
 * holders and why each counts as gone, for a person to remove.
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
      `stale admission token ${stale.join("; stale admission token ")}; gc never removes an admission token: remove it after inspection`,
    );
  if (parts.length === 0)
    parts.push("a creator held the lock as collection began; retry");
  return `gc ${kind}: ${parts.join("; ")}`;
}

/** Creates the writer file holding this process's identity; false when one exists. */
function publishWriter(writer: string): boolean {
  try {
    writeFileSync(writer, encodeIdentity(ownIdentity()), {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
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
 * file lock, only while it still holds `seen`; false when it changed or
 * another process published first.
 */
async function takeOverDead(writer: string, seen: string): Promise<boolean> {
  const taken = await withFileLock(
    writer,
    async () => {
      if (writerText(writer) !== seen) return false;
      rmSync(writer, { force: true });
      return publishWriter(writer);
    },
    { root: dirname(writer), name: "writer-takeover" },
  );
  return taken?.value === true;
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
    const taken =
      options.takeOverDead === true &&
      held?.gone === true &&
      seen !== null &&
      (await takeOverDead(writer, seen));
    if (!taken)
      throw new GcError(
        held?.gone === true
          ? `gc ${kind}: ${writer} names a process that has exited (${held.text}); remove it after inspection`
          : `gc ${kind}: another collection holds ${held?.text ?? writer}`,
      );
    console.error(
      `gc ${kind}: took over ${writer} from a holder that has exited (${held?.text})`,
    );
  }
  try {
    const tokens = readdirSync(dir).filter((name) =>
      name.startsWith("reader-"),
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
