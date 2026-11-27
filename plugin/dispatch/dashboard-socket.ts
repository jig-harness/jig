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
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { attempt, failed, ok, type Outcome } from "../shared/outcome.ts";
import { SOCKET_MODE } from "./lib/listen.ts";

/** A bound socket: stop it and its file goes with it. */
export interface BoundSocket {
  stop(): void;
}

/**
 * Bind `path` mode 0600 and answer from `fetch`. A socket file a stopped
 * reader left behind is replaced; anything else at the path is refused and
 * left alone. The caller binds the dashboard's TCP address first, so a
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
  const found = made.ok ? readSocketFacts(path) : made;
  if (!found.ok) return unusable("cannot be prepared", found.failure.cause);
  if (found.value !== null) {
    if (!found.value.isSocket)
      return unusable("names a file that is not a socket; nothing was removed");
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
  const stop = () => {
    server.stop(true);
    rmSync(path, { force: true });
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

/** Whether the socket answers a request for the page, within three seconds; never throws, never prints the error. */
export async function socketAnswers(path: string): Promise<boolean> {
  // Never print a fetch error: it names the socket's path.
  const pending = attempt("not-answering", "socket not answering", () =>
    fetch("http://dashboard/", {
      unix: path,
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    }),
  );
  if (!pending.ok) return false;
  const response = await pending.value.then(
    (value) => ok(value),
    (cause) => failed("not-answering", "socket not answering", cause),
  );
  if (!response.ok) return false;
  const cancelled = await Promise.resolve(response.value.body?.cancel()).then(
    () => true,
    () => false,
  );
  return cancelled && response.value.ok;
}
