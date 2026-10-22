#!/usr/bin/env bun
// Cross-worktree mutex: run a heavy command under a machine-wide lock.
//
// Several agents on one machine each kicking off a full build-and-test run at
// once thrash the CPU, the disk, and shared caches — every run gets slower and
// some fall over. This wrapper serializes such runs: only one holder of a named
// lock runs its command at a time; the others WAIT (up to a timeout) and then
// proceed. It coordinates ACROSS worktrees because the lock lives at a
// machine-global path (TMPDIR), not inside any one worktree.
//
// On POSIX the lock is a SYMLINK whose target is the holder's PID. Creating a symlink is
// ATOMIC on POSIX and fails if the name already exists, so exactly one racer
// wins — and because the target IS the PID, ownership and owner-identity are
// established in the SAME atomic step. There is no "won the lock but has not
// recorded its owner yet" window (the flaw of mkdir-a-dir-then-write-a-pidfile:
// a holder paused between the two leaves an ownerless lock another process could
// steal, breaking mutual exclusion). A lock left by a CRASHED holder is reclaimed
// once its PID is gone from the process table; a live holder is never torn out.
//
// Reclaiming a stale lock needs a compare-and-delete that the filesystem does
// not offer, so it is made safe by construction. A lock is only ever removed
// because its recorded owner is a DEAD pid, and a dead pid never records a new
// lock. To remove it, a reclaimer must first publish a CLAIM named after that
// dead owner (`<lock>.reclaim.<pid>`), itself recorded atomically like the
// lock. Only the claim holder may remove a lock naming that owner, and it
// re-reads the lock under the claim, so a lock that was already replaced by a
// live holder's is left alone. A claim abandoned by a crashed reclaimer is
// stale in the same way and is recovered by the same rule, one level up (a
// claim on the dead claimer). Acquisition itself never takes a claim.
//
// Windows publishes a prewritten PID file with an atomic hard link, requiring
// no symbolic-link privileges and preserving the same owner-before-acquire rule.
//
// CI bypass: on a CI runner each job already gets its own isolated machine, so
// there is nothing to serialize and the wait is pure latency. If CI=1 (or
// CI=true) or RESOURCE_LOCK_BYPASS=1, the command runs immediately, unlocked.
//
// Config via env (or --lock for the name):
//     LOCK_NAME     the lock to contend on (default "heavy"); --lock NAME wins
//     LOCK_TIMEOUT  seconds to wait for the lock before giving up (default 60)
//     LOCK_POLL     poll interval while waiting, seconds (default 0.2)
//     LOCK_ROOT     directory the lock lives under (default ${TMPDIR:-/tmp})
//
// Exit codes: the command's own exit code on success; 2 on a usage error;
//             3 if the lock could not be acquired within LOCK_TIMEOUT.
//
// Usage:
//   with-resource-lock.ts pnpm test            # LOCK_NAME defaults to "heavy"
//   LOCK_NAME=build with-resource-lock.ts make build
//   with-resource-lock.ts --lock e2e -- ./run-e2e.ts   # -- ends option parsing
import { registerCleanup, registerSignalHandler } from "./cleanup.ts";
import {
  accessSync,
  constants,
  lstatSync,
  linkSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const MAX_TIMEOUT_SECONDS = 604800,
  MIN_POLL_SECONDS = 0.001,
  MAX_POLL_SECONDS = 3600;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;
// One read of who owns `path`: the owner text, "" for an entry that carries no
// owner (a directory or foreign file), or undefined if nothing is there or it
// cannot be read. Callers never treat undefined as stale.
function holder(path: string, fileOwners = false): string | undefined {
  try {
    return readlinkSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (fileOwners) {
      try {
        return readFileSync(path, "utf8");
      } catch (readError) {
        // Only a directory is known to carry no owner; any other failure
        // (a delete-pending or briefly locked file) is unknown, never stale.
        return errorCode(readError) === "EISDIR" ? "" : undefined;
      }
    }
    return errorCode(error) === "EINVAL" ? "" : undefined;
  }
}
function alive(pid: string): boolean {
  if (!/^[1-9][0-9]*$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function commandArguments(
  args: string[],
  name: string,
): { args: string[]; name: string } {
  args = [...args];
  while (args.length) {
    const arg = args[0] ?? "";
    if (arg === "-l" || arg === "--lock") {
      if (!args[1]) throw new Error("--lock needs a name");
      name = args[1];
      args.splice(0, 2);
    } else if (arg === "--") {
      args.shift();
      break;
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else break;
  }
  if (!args.length) throw new Error("no command given to run under the lock");
  return { args, name };
}
function waitSeconds(timeout: string): number {
  const timeoutSeconds = Number(timeout);
  if (!/^[0-9]+$/.test(timeout) || !(timeoutSeconds <= MAX_TIMEOUT_SECONDS))
    throw new Error(
      `LOCK_TIMEOUT must be a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}: ${timeout}`,
    );
  return timeoutSeconds;
}
function pollingSeconds(poll: string): number {
  const pollSeconds = Number(poll);
  if (
    !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(poll) ||
    !(pollSeconds >= MIN_POLL_SECONDS && pollSeconds <= MAX_POLL_SECONDS)
  )
    throw new Error(
      `LOCK_POLL must be a number of seconds from ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS}: ${poll}`,
    );
  return pollSeconds;
}
function lockArguments(args: string[], env: NodeJS.ProcessEnv) {
  const { args: command, name } = commandArguments(
    args,
    env.LOCK_NAME || "heavy",
  );
  const timeout = env.LOCK_TIMEOUT || "60",
    poll = env.LOCK_POLL || "0.2",
    root = env.LOCK_ROOT || env.TMPDIR || tmpdir();
  const timeoutSeconds = waitSeconds(timeout),
    pollSeconds = pollingSeconds(poll);
  return { args: command, name, timeout, root, timeoutSeconds, pollSeconds };
}
async function runLockedCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let child: Bun.Subprocess<"inherit", "inherit", "inherit">;
  try {
    child = Bun.spawn(args, {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      console.error(`ERROR: cannot execute ${args[0]}: ${String(error)}`);
      return code === "ENOENT" ? 127 : 126;
    }
    throw error;
  }
  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {}
  };
  using cancellation = registerSignalHandler(async (signal) => {
    forward(signal);
    await child.exited;
  });
  void cancellation;
  return await child.exited;
}
export function resourceLockPath(root: string, name: string): string {
  const safe = Array.from(new TextEncoder().encode(name), (b) =>
    /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : "_",
  ).join("");
  return join(root, `jig-lock.${safe}`);
}
export async function main(
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
): Promise<number> {
  const {
    args: command,
    name,
    root,
    timeout,
    timeoutSeconds,
    pollSeconds,
  } = lockArguments(args, env);
  const run = () => runLockedCommand(command, env);
  if (env.CI === "1" || env.CI === "true" || env.RESOURCE_LOCK_BYPASS === "1")
    return run();
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
    if (!lstatSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`LOCK_ROOT is not a writable directory: ${root}`);
  }
  const lock = resourceLockPath(root, name),
    owner = String(process.pid);
  const fileOwners = platform === "win32";
  // Windows hard links need no symlink permission. The unique source file has
  // its owner before publishing it atomically, avoiding a create-then-write gap.
  const source = `${lock}.owner.${owner}.${crypto.randomUUID()}`;
  if (fileOwners) writeFileSync(source, owner, { flag: "wx" });
  const publish = (path: string) => {
    if (fileOwners) linkSync(source, path);
    else symlinkSync(owner, path);
  };
  const unpublish = (path: string) => {
    if (holder(path, fileOwners) === owner) {
      try {
        rmSync(path);
      } catch {}
    }
  };
  // Remove `path` if its owner is dead (or it carries no owner at all), holding
  // a claim named after that owner and re-reading under the claim first.
  const reclaim = (path: string) => {
    const seen = holder(path, fileOwners);
    if (seen === undefined || alive(seen)) return;
    const claim = `${path}.reclaim.${/^[1-9][0-9]*$/.test(seen) ? seen : "foreign"}`;
    try {
      publish(claim);
    } catch (error) {
      if (errorCode(error) === "EEXIST") reclaim(claim);
      return;
    }
    try {
      if (holder(path, fileOwners) === seen && !alive(seen))
        rmSync(path, {
          recursive: !lstatSync(path).isSymbolicLink(),
          force: true,
        });
    } catch {
    } finally {
      unpublish(claim);
    }
  };
  const deadline = performance.now() + timeoutSeconds * 1000;
  let acquired = false;
  try {
    for (;;) {
      try {
        publish(lock);
        acquired = true;
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      reclaim(lock);
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await Bun.sleep(Math.min(pollSeconds * 1000, remaining));
    }
  } finally {
    if (fileOwners) rmSync(source, { force: true });
  }
  if (!acquired) {
    console.error(
      `ERROR: could not acquire lock '${name}' within ${timeout}s (held by another worktree?)`,
    );
    return 3;
  }
  using release = registerCleanup(() => unpublish(lock));
  void release;
  return await run();
}
