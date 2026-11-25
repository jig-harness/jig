/**
 * One resident hub per user. `jig hub serve --scheduled` holds an
 * exclusive lock (`shared/file-lock.ts`) under the hub's own directory for
 * as long as it serves, so a scheduler that starts it again while it runs
 * (cron starts the line every minute) finds the lock held and leaves
 * quietly. The lock records its holder's process identity, which
 * `jig uninstall hub` reads to stop the running hub: it signals that
 * process only while the identity still matches, so a reused pid is never
 * signalled, and waits a bounded time for it to end.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileLockOwner, withFileLock } from "../../shared/file-lock.ts";
import { describeIdentity, isAliveSync } from "../../shared/liveness.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { hubHome } from "./settings.ts";

/** How long a second start waits for the lock before it leaves. */
const LOCK_WAIT_MS = 1_000;
/** How long `jig uninstall hub` waits for the running hub to stop: its container's own stop takes up to 10 seconds. */
const STOP_WAIT_MS = 30_000;
const STOP_POLL_MS = 100;

function lockOptions(env: Record<string, string | undefined>) {
  return { root: join(hubHome(env), "locks"), name: "hub-serve" };
}

/**
 * Runs `body` holding the resident hub's lock: `null` when another live
 * process holds it, `unavailable` when the lock cannot be taken at all.
 */
export async function withServeLock<T>(
  body: () => Promise<T>,
  env: Record<string, string | undefined> = process.env,
): Promise<Outcome<{ value: T } | null, "unavailable">> {
  const options = lockOptions(env);
  const made = attempt(
    "unavailable",
    `cannot make the hub's lock directory ${options.root}`,
    () => mkdirSync(options.root, { recursive: true, mode: 0o700 }),
  );
  if (!made.ok) return made;
  // The lock helper throws when its file cannot be written; a throw from
  // `body` itself passes on to the caller's defect boundary.
  let entered = false;
  const enter = () => {
    entered = true;
    return body();
  };
  return withFileLock(hubHome(env), enter, {
    ...options,
    waitMs: LOCK_WAIT_MS,
  }).then(
    (held) => ok(held),
    (cause: unknown) =>
      entered
        ? Promise.reject(cause)
        : failed(
            "unavailable",
            `cannot take the hub's lock in ${options.root}`,
            cause,
          ),
  );
}

export interface StopOptions {
  readonly env?: Record<string, string | undefined>;
  readonly waitMs?: number;
  /** Sends the terminate signal; injected by tests. */
  readonly signal?: (pid: number) => void;
}

/**
 * Stops the resident hub this user runs, if one runs: what was stopped, or
 * null when none ran; `unavailable` when it cannot be told whether one
 * runs, the signal cannot be sent, or it is still running at the deadline.
 */
export async function stopRunningHub(
  options: StopOptions = {},
): Promise<Outcome<string | null, "unavailable">> {
  const env = options.env ?? process.env;
  const owner = fileLockOwner(hubHome(env), lockOptions(env));
  if (owner === null) return ok(null);
  const who = describeIdentity(owner);
  const alive = () => isAliveSync(owner);
  const first = alive();
  if (!first.ok)
    return failed(
      "unavailable",
      `cannot tell whether the hub (${who}) still runs: ${first.failure.reason}; stop it by hand`,
    );
  if (first.value.state === "dead") return ok(null);
  const send = options.signal ?? ((pid) => process.kill(pid, "SIGTERM"));
  const sent = attempt("unavailable", `cannot signal the hub (${who})`, () =>
    send(owner.pid),
  );
  if (!sent.ok) return sent;
  const deadline = performance.now() + (options.waitMs ?? STOP_WAIT_MS);
  for (;;) {
    const now = alive();
    if (now.ok && now.value.state === "dead") return ok(who);
    if (performance.now() >= deadline)
      return failed(
        "unavailable",
        `the hub (${who}) is still running ${Math.round((options.waitMs ?? STOP_WAIT_MS) / 1000)} seconds after it was asked to stop; stop it by hand`,
      );
    await Bun.sleep(STOP_POLL_MS);
  }
}
