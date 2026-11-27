/**
 * The dashboard's private socket (`dashboard.socket` in the machine file): a
 * second listener, on a Unix socket only the user running the reader and
 * root can open, that a private-network front targets (`unix:<path>`).
 *
 * The socket's mode is its lock. It is created 0600 under a tightened
 * umask, so no other user can open it even for an instant, and
 * `--status` reads it back (`socketProblem`) so a mode or an owner that
 * changed is seen. No browser can open a Unix socket, so a page that a name
 * rebinds to this host cannot reach it, which is why the server asks it for
 * neither the token nor a `Host` allowlist.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { SOCKET_MODE } from "./lib/listen.ts";

/** A bound socket: stop it and its file goes with it. */
export interface BoundSocket {
  stop(): void;
}

/** The parent directory's own problem as a place for the socket: not the reader's own, or open to writes by others; `null` when it is private. */
export function parentProblem(
  facts: { isDirectory: boolean; mode: number; uid: number },
  uid: number | undefined,
): string | null {
  if (!facts.isDirectory) return "has a parent that is not a directory";
  if (uid !== undefined && facts.uid !== uid && facts.uid !== 0)
    return `has a parent owned by user ${facts.uid}, not the reader's ${uid}`;
  if ((facts.mode & 0o022) !== 0)
    return "has a parent directory that others can write to; use a private one (mode 0700)";
  return null;
}

/**
 * The first ancestor of the socket's directory that another user could rename
 * or replace, so the path could be made to name their socket; `null` when the
 * whole chain is the reader's, root's, or a sticky directory (which only an
 * entry's owner may rename within).
 */
export function ancestorProblem(
  directory: string,
  uid: number | undefined,
): string | null {
  let current = directory;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return null;
    const read = attempt("socket-unreadable", "", () => lstatSync(parent));
    if (!read.ok) return `has an ancestor that cannot be read (${parent})`;
    const facts = read.value;
    if (uid !== undefined && facts.uid !== uid && facts.uid !== 0)
      return `has an ancestor owned by user ${facts.uid} (${parent})`;
    // A link the reader or root made is as safe as the directory holding it,
    // which the next step of the walk checks.
    if (facts.isSymbolicLink()) {
      current = parent;
      continue;
    }
    if (!facts.isDirectory())
      return `has an ancestor that is not a directory (${parent})`;
    const sticky = (facts.mode & 0o1000) !== 0;
    if ((facts.mode & 0o022) !== 0 && !sticky)
      return `has an ancestor directory that others can write to (${parent})`;
    current = parent;
  }
}

/**
 * The first problem along the way the kernel resolves `directory`: every
 * component it visits, link targets and components a `..` later leaves
 * included, must be the reader's or root's and sit in a directory whose own
 * chain only the reader or root can change;
 * `null` when the whole resolution is trusted.
 */
export function linkChainProblem(
  directory: string,
  uid: number | undefined,
): string | null {
  let resolved = "/";
  const queue = directory.split("/").filter((part) => part !== "");
  let hops = 0;
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (name === ".") continue;
    if (name === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, name);
    const read = attempt("socket-unreadable", "", () => lstatSync(next));
    if (!read.ok) return `has a path component that cannot be read (${next})`;
    // Every component the kernel visits is checked, those a later `..` leaves
    // behind included: its owner could swap it for a link and move the `..`.
    if (uid !== undefined && read.value.uid !== uid && read.value.uid !== 0)
      return `has a path component owned by user ${read.value.uid} (${next})`;
    const holder = ancestorProblem(join(resolved, "x"), uid);
    if (holder !== null) return holder;
    if (!read.value.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    if (++hops > 40) return "has too many symbolic links in its path";
    const target = attempt("socket-unreadable", "", () => readlinkSync(next));
    if (!target.ok) return `has a link that cannot be read (${next})`;
    if (target.value.startsWith("/")) resolved = "/";
    queue.unshift(...target.value.split("/").filter((part) => part !== ""));
  }
  return null;
}

/** Whether the socket path may hold a live listener: only a refused connection (or a missing file) proves it stale; any other outcome counts as live. */
function socketIsLive(path: string): boolean {
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'const s=require("node:net").connect(process.env.JIG_PROBE_SOCKET);s.on("connect",()=>process.exit(0));s.on("error",(e)=>process.exit(e.code==="ECONNREFUSED"||e.code==="ENOENT"?3:1));setTimeout(()=>process.exit(1),2000)',
    ],
    { env: { ...process.env, JIG_PROBE_SOCKET: path }, timeout: 5000 },
  );
  return probe.exitCode !== 3;
}

/**
 * Bind `path` mode 0600 and answer from `fetch`. The parent directory must be the
 * reader's own and closed to writes by others. A socket file a stopped
 * reader left behind is replaced; a live listener's or any other file at the
 * path is refused and left alone, and stopping removes only the socket this
 * call bound. The caller binds the dashboard's TCP address first, so a
 * second reader on the same configuration fails there before it can touch
 * a live reader's socket.
 */
export function bindSocket(
  path: string,
  fetch: (request: Request) => Response | Promise<Response>,
): Outcome<BoundSocket, "socket-unusable"> {
  const unusable = (reason: string, cause?: unknown) =>
    failed("socket-unusable", `dashboard.socket ${reason}`, cause);
  const made = attempt("socket-unusable", "", () =>
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }),
  );
  const parent = made.ok
    ? attempt("socket-unusable", "", () => lstatSync(dirname(path)))
    : made;
  if (!parent.ok) return unusable("cannot be prepared", parent.failure.cause);
  const placed = parentProblem(
    {
      isDirectory: parent.value.isDirectory(),
      mode: parent.value.mode,
      uid: parent.value.uid,
    },
    process.getuid?.(),
  );
  if (placed !== null) return unusable(placed);
  const resolved = attempt("socket-unusable", "", () =>
    realpathSync(dirname(path)),
  );
  if (!resolved.ok)
    return unusable("cannot be prepared", resolved.failure.cause);
  // The path as configured is what a front reaches, so its own links are
  // checked as well as the resolved directory's chain.
  const chain =
    linkChainProblem(dirname(path), process.getuid?.()) ??
    ancestorProblem(dirname(path), process.getuid?.()) ??
    ancestorProblem(resolved.value, process.getuid?.());
  if (chain !== null) return unusable(chain);
  const found = readSocketFacts(path);
  if (!found.ok) return unusable("cannot be prepared", found.failure.cause);
  if (found.value !== null) {
    if (!found.value.isSocket)
      return unusable("names a file that is not a socket; nothing was removed");
    if (socketIsLive(path))
      return unusable("is in use by a running listener; nothing was removed");
    rmSync(path, { force: true });
  }
  // The socket is born under a umask that grants the group and others
  // nothing, so no other user can open it between bind and chmod.
  const before = process.umask(0o177);
  const bound = attempt("socket-unusable", "", () =>
    Bun.serve({ unix: path, fetch }),
  );
  process.umask(before);
  if (!bound.ok) return unusable("cannot be bound", bound.failure.cause);
  const server = bound.value;
  const own = readSocketFacts(path);
  const inode = own.ok ? lstatIno(path) : null;
  const stop = () => {
    // Bun unlinks the path when a server stops, whatever is there now, so a
    // socket another reader put in this one's place is moved aside meanwhile.
    const now = lstatIno(path);
    // A pathname that is simply gone holds no one else's socket to protect.
    const replaced = inode !== null && now !== null && now !== inode;
    const asidePath = replaced ? parkReplacement(path) : null;
    const parked = asidePath !== null;
    // When the replacement cannot be moved aside, the listener is left to die
    // with the process: stopping it would unlink the other reader's socket.
    if (replaced && !parked) return;
    server.stop(true);
    if (asidePath !== null) renameSync(asidePath, path);
    else if (!replaced) rmSync(path, { force: true });
  };
  const moded = attempt("socket-unusable", "", () =>
    chmodSync(path, SOCKET_MODE),
  );
  if (!moded.ok) {
    stop();
    return unusable("cannot be set to mode 0600", moded.failure.cause);
  }
  return ok({ stop });
}

/** Move whatever replaced the socket aside under the first free name; its new path, or `null` when none works. */
function parkReplacement(path: string): string | null {
  for (const n of [0, 1, 2]) {
    const aside = `${path}.${process.pid}.${n}.aside`;
    // renameSync would silently replace an earlier parked file.
    if (lstatIno(aside) !== null) continue;
    if (attempt("socket-unusable", "", () => renameSync(path, aside)).ok)
      return aside;
  }
  return null;
}

function lstatIno(path: string): number | null {
  const read = attempt("socket-unreadable", "", () => lstatSync(path).ino);
  return read.ok ? read.value : null;
}

/** What `--status` reads of the socket file. */
export interface SocketFacts {
  isSocket: boolean;
  mode: number;
  uid: number;
}

/** Why the socket is not as installed, from what `lstat` read; `null` when it is mode 0600 and the reader's own. */
export function socketProblem(
  facts: SocketFacts | null,
  uid: number | undefined,
): string | null {
  if (facts === null) return "the socket does not exist";
  if (!facts.isSocket) return "the path is not a socket";
  const mode = facts.mode & 0o777;
  if (mode !== SOCKET_MODE)
    return `the socket's mode is ${mode.toString(8).padStart(4, "0")}, not 0600`;
  if (uid !== undefined && facts.uid !== uid)
    return `the socket is owned by user ${facts.uid}, not the reader's ${uid}`;
  return null;
}

/** The socket's own facts; `null` when nothing is at the path. */
export function readSocketFacts(path: string): Outcome<SocketFacts | null> {
  try {
    const stat = lstatSync(path);
    return ok({
      isSocket: stat.isSocket(),
      mode: stat.mode,
      uid: stat.uid,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok(null);
    return failed("socket-unreadable", "the socket cannot be read", cause);
  }
}

/**
 * Whether a request for the page is answered with a success status; never
 * throws, never prints the error (it may name the socket or the private URL).
 */
export async function pageAnswers(
  request: () => Promise<Response>,
  what: string,
): Promise<boolean> {
  const pending = attempt("not-answering", what, request);
  if (!pending.ok) return false;
  const response = await pending.value.then(
    (value) => ok(value),
    (cause) => failed("not-answering", what, cause),
  );
  if (!response.ok) return false;
  // A body that errors after the headers arrive makes cancel() reject.
  const cancelled = await Promise.resolve(response.value.body?.cancel()).then(
    () => true,
    () => false,
  );
  return cancelled && response.value.ok;
}

/** Whether the socket answers a request for the page, within three seconds. */
export function socketAnswers(path: string): Promise<boolean> {
  return pageAnswers(
    () =>
      fetch("http://dashboard/", {
        unix: path,
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      }),
    "socket not answering",
  );
}
