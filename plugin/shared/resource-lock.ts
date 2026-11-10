#!/usr/bin/env bun
// Cross-worktree limit on heavy commands: run a command under a machine-wide
// lock that admits as many runs as the machine can carry.
//
// Several agents on one machine each kicking off a full build-and-test run at
// once thrash the CPU, the disk, and shared caches — every run gets slower and
// some fall over. This wrapper bounds such runs: a holder of a named lock runs
// its command; the others WAIT (up to a timeout) and then proceed. It
// coordinates ACROSS worktrees because the lock lives at a machine-global path
// (TMPDIR), not inside any one worktree.
//
// A lock has SLOTS. Slot 0 is the lock's own name (`jig-lock.<name>`), so an
// earlier version of this script, which knows only that name, still excludes
// and queues with it; slots 1 and up are `<name>-slot-<n>`. A free slot 0 is
// taken at once. Any other slot is taken only when the machine has room for
// one more run (`host-load.ts`: the predicted load under the cores times a
// target, the available memory above a floor; the first run always fits), and
// only while no exclusive holder is announced. A waiter sweeps the slots
// without blocking, with a jittered pause between sweeps; a slot whose pid
// answers is skipped cheaply, and every tenth sweep judges each holder fully.
// The check and the sweep run under a short admission lock
// (`jig-lock.<name>.admission`), so each new holder is counted before the
// next waiter decides. Only the check's explicit denial keeps a waiter
// waiting: a reading that fails admits, and the slot ceiling decides. With a
// ceiling of one slot the lock is the single mutex it has always been.
//
// An EXCLUSIVE holder (--exclusive; `jig gc --collect` is one) announces
// itself (`jig-lock.<name>.exclusive`), which stops new runs from taking any
// slot, then takes every slot the lock can have, in order, and holds them all
// while its command runs. Exclusive holders queue on the announcement, so two
// never deadlock on the slots.
//
// On POSIX each lock file is a SYMLINK whose target is the holder's PID. Creating a symlink is
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
// The holder's process identity (`liveness.ts`: host, boot, pid and start
// time) stands beside the lock in `<lock>.holder`, written once the lock is
// taken and removed before it is released or reclaimed. The lock itself
// still names only the pid, so an earlier version of this script excludes
// this one and judges its lock as it always has. A recorded identity is
// trusted only when it names the lock's pid and was written no earlier than
// the lock, so a leftover never judges a later holder; then a pid now held by
// a process that started at another time no longer keeps a crashed holder's
// lock. Without one, the pid alone decides, as before. A wait says what it
// waits on and who holds the slots, again when that changes; a reclaim, and
// a wait that runs out, say whose lock it was.
//
// A waiter announces itself beside the lock (`jig-lock.<name>.waiting.<pid>`)
// from the moment it starts waiting until it holds a slot or gives up, so
// another mechanism can count the runs that wait (`lockOccupancy`; the
// dispatcher's load factor reads it). An announcement whose pid no longer
// answers is not counted.
//
// CI bypass: on a CI runner each job already gets its own isolated machine, so
// there is nothing to serialize and the wait is pure latency. If CI=1 (or
// CI=true) or RESOURCE_LOCK_BYPASS=1, the command runs immediately, unlocked.
//
// Config via env (or --lock for the name):
//     LOCK_NAME          the lock to contend on (default "heavy"); --lock NAME wins
//     LOCK_TIMEOUT       seconds to wait for the lock before giving up (default 60)
//     LOCK_POLL          poll interval while waiting, seconds (default 0.2); with
//                        several slots, the shortest pause between sweeps
//                        (default: a pause of 2 to 5 seconds)
//     LOCK_ROOT          directory the lock lives under (default ${TMPDIR:-/tmp})
//     LOCK_SLOTS         the most runs that may hold the lock at once, 1 to 64
//                        (default 64, so load decides; 8 with LOCK_STATIC_SLOTS)
//     LOCK_STATIC_SLOTS  1 admits up to LOCK_SLOTS runs whatever the load
//     LOCK_TARGET_UTIL   the share of the cores predicted load stays under (0.85)
//     LOCK_RUN_COST      the load one run adds (default 4)
//     LOCK_MIN_MEM_GB    the available memory, in GiB, that must remain (8)
//
// Exit codes: the command's own exit code on success; 2 on a usage error;
//             3 if the lock could not be acquired within LOCK_TIMEOUT.
//
// Usage:
//   with-resource-lock.ts pnpm test            # LOCK_NAME defaults to "heavy"
//   LOCK_NAME=build with-resource-lock.ts make build
//   with-resource-lock.ts --lock e2e -- ./run-e2e.ts   # -- ends option parsing
//   with-resource-lock.ts --exclusive -- ./collect.ts  # the machine to itself
import { registerCleanup, registerSignalHandler } from "./cleanup.ts";
import {
  accessSync,
  constants,
  lstatSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { swallow } from "./errors.ts";
import {
  readHostLoad,
  roomForOneMore,
  type Admission,
  type AdmissionPolicy,
  type HostLoad,
} from "./host-load.ts";
import {
  decodeIdentity,
  describeIdentity,
  encodeIdentity,
  isAliveSync,
  legacyIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";
/** The longest `LOCK_TIMEOUT` the lock accepts, in seconds. */
export const MAX_TIMEOUT_SECONDS = 604800;
/** The most slots a lock has, and so the slots an exclusive holder takes. */
const MAX_SLOTS = 64;
/** The slot ceiling when the count is static rather than decided by load. */
const STATIC_SLOTS = 8;
/** How long a run counts as just started, before the load average shows it, in seconds. */
const FRESH_SECONDS = 60;
/** Every how many sweeps each holder is judged by its identity, not by its pid alone. */
const FULL_CHECK_EVERY = 10;
const GIB = 1024 ** 3;
const MIN_POLL_SECONDS = 0.001,
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
const holderFile = (path: string) => `${path}.holder`;
// The identity recorded beside `path` when it names `pid` and is no older than
// `path` itself; otherwise the pid alone, as an earlier holder wrote it.
function recordedHolder(path: string, pid: string): ProcessIdentity {
  try {
    const recorded = decodeIdentity(readFileSync(holderFile(path), "utf8"));
    if (
      recorded !== null &&
      String(recorded.pid) === pid &&
      statSync(holderFile(path)).mtimeMs >= lstatSync(path).mtimeMs
    )
      return recorded;
  } catch (error) {
    swallow(error, "no holder recorded beside the lock; its pid decides");
  }
  return legacyIdentity(Number(pid));
}
// Whether the owner `seen` at `path` keeps it, and who that owner is: only an
// owner judged dead, or an entry naming no owner, gives it up.
function judgeOwner(
  path: string,
  seen: string,
  deadline?: number,
): { alive: boolean; who: string } {
  if (!/^[1-9][0-9]*$/.test(seen))
    return { alive: false, who: "an entry that names no owner" };
  const holder = recordedHolder(path, seen);
  const verdict = isAliveSync(holder, undefined, deadline);
  const reason = verdict.ok ? verdict.value.reason : verdict.failure.reason;
  return {
    alive: !verdict.ok || verdict.value.state === "alive",
    who: `${describeIdentity(holder)}: ${reason}`,
  };
}
// Who holds `lock`, for a wait that ran out: the recorded holder, with no
// further probe once the time is spent.
function heldBy(lock: string, fileOwners: boolean): string {
  const seen = holder(lock, fileOwners);
  if (seen === undefined) return "another worktree";
  return /^[1-9][0-9]*$/.test(seen)
    ? describeIdentity(recordedHolder(lock, seen))
    : "an entry that names no owner";
}
// Record this holder's identity beside the lock it has just taken.
function recordHolder(lock: string): void {
  const staged = `${lock}.holder.${process.pid}.${crypto.randomUUID()}`;
  try {
    writeFileSync(staged, encodeIdentity(ownIdentity()), { flag: "wx" });
    renameSync(staged, holderFile(lock));
  } catch (error) {
    swallow(error, "the holder's identity is not recorded; its pid decides");
    rmSync(staged, { force: true });
  }
}
// A wait announcement is named for its process id. If that id was reused
// after a crash, only its recorded identity can prove the old announcement is
// stale. Never unlink an unreadable entry or one that names a live process.
function reclaimWaitingAnnouncement(path: string): boolean {
  try {
    const announced = decodeIdentity(readFileSync(path, "utf8"));
    const verdict = announced === null ? null : isAliveSync(announced);
    if (
      announced === null ||
      verdict === null ||
      !verdict.ok ||
      verdict.value.state === "alive"
    )
      return false;
    if (!lstatSync(path).isFile()) return false;
    rmSync(path);
    return true;
  } catch (error) {
    swallow(error, "the stale wait announcement was not reclaimed");
    return false;
  }
}
/** Refuse a setting or an argument: the entry point reports it and exits 2. */
function refuse(message: string): never {
  throw new Error(message);
}
function commandArguments(
  args: string[],
  name: string,
): { args: string[]; name: string; exclusive: boolean } {
  args = [...args];
  let exclusive = false;
  for (let arg = args[0]; arg?.startsWith("-"); arg = args[0]) {
    args.shift();
    if (arg === "--") break;
    if (arg === "--exclusive") exclusive = true;
    else if (arg === "-l" || arg === "--lock")
      name = args.shift() || refuse("--lock needs a name");
    else refuse(`unknown option: ${arg}`);
  }
  if (!args.length) refuse("no command given to run under the lock");
  return { args, name, exclusive };
}
function waitSeconds(timeout: string): number {
  const timeoutSeconds = Number(timeout);
  if (!/^[0-9]+$/.test(timeout) || !(timeoutSeconds <= MAX_TIMEOUT_SECONDS))
    refuse(
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
    refuse(
      `LOCK_POLL must be a number of seconds from ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS}: ${poll}`,
    );
  return pollSeconds;
}
// A decimal setting from `min` (exclusive when `open`) to `max`, or `fallback` when unset.
function decimal(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  [min, max]: [number, number],
  open = true,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(raw) ||
    !(open ? value > min : value >= min) ||
    !(value <= max)
  )
    refuse(
      `${name} must be a number ${open ? "above" : "from"} ${min} ${open ? "and at most" : "to"} ${max}: ${raw}`,
    );
  return value;
}
/** How many runs a lock admits and by what rule. */
interface SlotSettings {
  slots: number;
  /** Whether load and memory decide, below the ceiling. */
  adaptive: boolean;
  policy: AdmissionPolicy;
}
/** The slot settings in `env`; a malformed one is a usage error. */
function slotSettings(env: NodeJS.ProcessEnv): SlotSettings {
  const switched = env.LOCK_STATIC_SLOTS || "0";
  if (switched !== "0" && switched !== "1")
    refuse(`LOCK_STATIC_SLOTS must be 0 or 1: ${switched}`);
  const adaptive = switched === "0";
  const raw = env.LOCK_SLOTS || String(adaptive ? MAX_SLOTS : STATIC_SLOTS);
  if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_SLOTS)
    refuse(`LOCK_SLOTS must be a whole number from 1 to ${MAX_SLOTS}: ${raw}`);
  return {
    slots: Number(raw),
    adaptive,
    policy: {
      targetUtilization: decimal(env, "LOCK_TARGET_UTIL", 0.85, [0, 4]),
      runCost: decimal(env, "LOCK_RUN_COST", 4, [0, 4096]),
      minAvailableBytes:
        decimal(env, "LOCK_MIN_MEM_GB", 8, [0, 65536], false) * GIB,
    },
  };
}
function lockArguments(args: string[], env: NodeJS.ProcessEnv) {
  const {
    args: command,
    name,
    exclusive,
  } = commandArguments(args, env.LOCK_NAME || "heavy");
  const timeout = env.LOCK_TIMEOUT || "60",
    poll = env.LOCK_POLL || "0.2",
    root = lockPlace(env).root;
  const timeoutSeconds = waitSeconds(timeout),
    pollSeconds = pollingSeconds(poll);
  return {
    args: command,
    name,
    exclusive,
    timeout,
    root,
    timeoutSeconds,
    pollSeconds,
    pollGiven: Boolean(env.LOCK_POLL),
    settings: slotSettings(env),
  };
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
function resourceLockPath(root: string, name: string): string {
  const safe = Array.from(new TextEncoder().encode(name), (b) =>
    /[A-Za-z0-9._-]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : "_",
  ).join("");
  return join(root, `jig-lock.${safe}`);
}
/** Slot `slot` of the lock `name`: slot 0 is the lock's own name, the others `<name>-slot-<n>`. */
function resourceLockSlotPath(
  root: string,
  name: string,
  slot: number,
): string {
  return resourceLockPath(root, slot === 0 ? name : `${name}-slot-${slot}`);
}
/** The lock's root and name as `env` sets them for a run: `LOCK_ROOT`, else the temporary directory; `LOCK_NAME`, else `heavy`. */
export function lockPlace(env: NodeJS.ProcessEnv = process.env): {
  root: string;
  name: string;
} {
  return {
    root: env.LOCK_ROOT || env.TMPDIR || tmpdir(),
    name: env.LOCK_NAME || "heavy",
  };
}
/**
 * How many runs hold a slot of the lock `name` under `root`, and how many
 * announce they wait for one; read without taking anything, so a reader
 * never delays a run.
 */
export function lockOccupancy(
  root: string,
  name: string,
  windows = process.platform === "win32",
): { holders: number; waiters: number } {
  const slots = Array.from({ length: MAX_SLOTS }, (_, n) =>
    resourceLockSlotPath(root, name, n),
  );
  const prefix = `${basename(resourceLockPath(root, name))}.waiting.`;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { holders: 0, waiters: 0 };
    throw error;
  }
  const waiters = entries.filter((entry) => {
    if (!entry.startsWith(prefix)) return false;
    const pid = entry.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(pid)) return false;
    try {
      const announced = decodeIdentity(readFileSync(join(root, entry), "utf8"));
      if (announced !== null) {
        const verdict = isAliveSync(announced);
        return verdict.ok && verdict.value.state === "alive";
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    return answers(Number(pid));
  }).length;
  return { holders: slotHolders(slots, windows).length, waiters };
}
/** Whether a process with this pid answers a signal probe (one owned by another user does). */
function answers(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
/** A live holder of a slot, as a wait reports it and admission counts it. */
interface SlotHolder {
  path: string;
  pid: number;
  /** Seconds since the holder took the slot. */
  ageSeconds: number;
}
/** The slots among `paths` whose recorded pid answers: a cheap read, no identity check. */
function slotHolders(
  paths: readonly string[],
  windows = process.platform === "win32",
  now = Date.now(),
): SlotHolder[] {
  return paths.flatMap((path) => {
    const seen = holder(path, windows);
    if (seen === undefined || !/^[1-9][0-9]*$/.test(seen)) return [];
    const pid = Number(seen);
    if (!answers(pid)) return [];
    try {
      const ageSeconds = Math.max(0, (now - lstatSync(path).mtimeMs) / 1000);
      return [{ path, pid, ageSeconds }];
    } catch (error) {
      swallow(error, "the slot was released while it was read");
      return [];
    }
  });
}
function duration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}
/** The holders as a person reads them: each pid, the directory it runs in where readable, and how long it has held. */
function describeHolders(holders: readonly SlotHolder[]): string {
  if (holders.length === 0) return "no live holder";
  return holders
    .map(({ pid, ageSeconds }) => {
      let where = "";
      try {
        where = ` in ${readlinkSync(`/proc/${pid}/cwd`)}`;
      } catch (error) {
        swallow(error, "the holder's directory is not readable here");
      }
      return `pid ${pid}${where}, for ${duration(ageSeconds)}`;
    })
    .join("; ");
}
/** Publishing, releasing and reclaiming one process's lock files. */
interface Publisher {
  /** Publish `path` if nothing holds it; false when something already does. */
  take(path: string): boolean;
  /** Remove `path` if this process holds it. */
  release(path: string): void;
  /** Remove `path` if its owner is dead, or it names none. */
  reclaim(path: string): void;
  /**
   * Take `path` unless a live holder keeps it. A holder whose pid answers is
   * skipped without the identity check unless `full`; one that does not is
   * judged, and reclaimed when it is dead.
   */
  attempt(path: string, full: boolean): boolean;
  holders(paths: readonly string[]): SlotHolder[];
}
function publisher(
  lock: string,
  fileOwners: boolean,
  deadline: number,
): Publisher {
  const owner = String(process.pid);
  // Windows hard links need no symlink permission. A unique source file has
  // its owner before it is published atomically, avoiding a create-then-write
  // gap; one per publication, so the published file's modification time is
  // the moment of acquisition, not of a wait that came before it.
  const publish = (path: string) => {
    if (!fileOwners) {
      symlinkSync(owner, path);
      return;
    }
    const source = `${lock}.owner.${owner}.${crypto.randomUUID()}`;
    writeFileSync(source, owner, { flag: "wx" });
    try {
      linkSync(source, path);
    } finally {
      rmSync(source, { force: true });
    }
  };
  const release = (path: string) => {
    if (holder(path, fileOwners) === owner) {
      try {
        rmSync(holderFile(path), { force: true });
        rmSync(path);
      } catch {}
    }
  };
  const take = (path: string): boolean => {
    try {
      publish(path);
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return false;
    }
  };
  // Remove `path` if its owner is dead (or it carries no owner at all), holding
  // a claim named after that owner and re-reading under the claim first. The
  // identity recorded beside it goes first: no holder can record one while
  // the stale entry stands.
  const reclaim = (path: string) => {
    const seen = holder(path, fileOwners);
    if (seen === undefined || judgeOwner(path, seen, deadline).alive) return;
    const claim = `${path}.reclaim.${/^[1-9][0-9]*$/.test(seen) ? seen : "foreign"}`;
    try {
      publish(claim);
    } catch (error) {
      if (errorCode(error) === "EEXIST") reclaim(claim);
      return;
    }
    try {
      const owner = judgeOwner(path, seen, deadline);
      if (holder(path, fileOwners) === seen && !owner.alive) {
        rmSync(holderFile(path), { force: true });
        rmSync(path, {
          recursive: !lstatSync(path).isSymbolicLink(),
          force: true,
        });
        console.error(`resource lock: took over ${path} from ${owner.who}`);
      }
    } catch {
    } finally {
      release(claim);
    }
  };
  const holders = (paths: readonly string[]) => slotHolders(paths, fileOwners);
  return {
    take,
    release,
    reclaim,
    holders,
    attempt(path, full) {
      if (full) reclaim(path);
      else if (holders([path]).length > 0) return false;
      if (take(path)) return true;
      if (full) return false;
      reclaim(path);
      return take(path);
    },
  };
}
/** What one acquisition works with. */
interface Acquisition {
  locks: Publisher;
  name: string;
  /** The path of each slot. */
  slot: (n: number) => string;
  settings: SlotSettings;
  probe: () => HostLoad;
  pollMs: number;
  /** Explicit `LOCK_POLL`, which also sets the pause between sweeps. */
  pollGiven: boolean;
  remaining: () => number;
  /** Say what the wait is on, when `key` changes. */
  say: (key: string, text: string) => void;
  /** The paths taken, in order; on a wait that ran out, what blocked it. */
  taken: string[];
  blocker: string;
  /** What the wait was last on, for the message of a wait that runs out. */
  waitingOn: string;
}
// Keep `path`: released with the rest, and its holder's identity recorded
// beside it at once, so a reused pid never keeps a partial hold alive.
function hold(a: Acquisition, path: string): void {
  a.taken.push(path);
  recordHolder(path);
}
const keyOf = (kind: string, holders: readonly SlotHolder[]) =>
  `${kind} ${holders.map((h) => h.pid).join(",")}`;
// Sleep `ms`, never past the deadline; false once the wait is spent.
async function pause(a: Acquisition, ms: number): Promise<boolean> {
  if (a.remaining() <= 0) return false;
  await Bun.sleep(Math.min(ms, a.remaining()));
  return true;
}
// One mutex, as the lock has always been: poll the one name.
async function takeSingle(a: Acquisition): Promise<void> {
  const lock = a.slot(0);
  const announcement = `${lock}.exclusive`;
  for (;;) {
    // An announcement whose holder died, or whose pid was reused, is not a wait.
    a.locks.reclaim(announcement);
    const announced = a.locks.holders([announcement]);
    if (announced.length > 0) {
      a.blocker = announcement;
      a.say(
        keyOf("exclusive", announced),
        `an exclusive holder takes every slot: ${describeHolders(announced)}`,
      );
      if (!(await pause(a, a.pollMs))) return;
      continue;
    }
    a.blocker = lock;
    if (a.locks.take(lock)) {
      hold(a, lock);
      return;
    }
    a.locks.reclaim(lock);
    const holders = a.locks.holders([lock]);
    a.say(keyOf("held", holders), `held by ${describeHolders(holders)}`);
    if (!(await pause(a, a.pollMs))) return;
  }
}
// Every slot the lock can have, in order, after announcing the hold.
async function takeEvery(a: Acquisition): Promise<void> {
  const ceiling = Array.from({ length: a.settings.slots }, (_, n) => a.slot(n));
  const order = [
    `${a.slot(0)}.exclusive`,
    ...Array.from({ length: MAX_SLOTS }, (_, n) => a.slot(n)),
  ];
  for (const [index, path] of order.entries()) {
    a.blocker = path;
    while (!a.locks.attempt(path, true)) {
      const holders = a.locks.holders(index === 0 ? [path] : ceiling);
      a.say(
        keyOf(path, holders),
        index === 0
          ? `another exclusive holder: ${describeHolders(holders)}`
          : `exclusive: every slot, held by ${describeHolders(holders)}`,
      );
      if (!(await pause(a, a.pollMs))) return;
    }
    hold(a, path);
  }
}
// Whether the machine has room for one more run; a reading that fails admits.
function admitOneMore(
  a: Acquisition,
  holders: readonly SlotHolder[],
): Admission {
  if (!a.settings.adaptive)
    return { admit: true, reason: "the slot count is static" };
  try {
    return roomForOneMore(
      a.probe(),
      {
        count: holders.length,
        fresh: holders.filter((h) => h.ageSeconds < FRESH_SECONDS).length,
      },
      a.settings.policy,
    );
  } catch (error) {
    swallow(error, "the host's load could not be read; the ceiling decides");
    return { admit: true, reason: "the host's load could not be read" };
  }
}
// Under the admission lock: a slot beyond the first, if one more run fits.
function admittedSlot(a: Acquisition, full: boolean): string | undefined {
  const ceiling = Array.from({ length: a.settings.slots }, (_, n) => a.slot(n));
  // A full sweep judges identities first, so a slot whose pid was reused
  // after its holder died neither counts as running nor blocks admission.
  if (full) for (const path of ceiling) a.locks.reclaim(path);
  const holders = a.locks.holders(ceiling);
  const decision = admitOneMore(a, holders);
  if (!decision.admit) {
    a.say(
      keyOf(decision.binds, holders),
      `${decision.reason}; ${holders.length} running: ${describeHolders(holders)}`,
    );
    return undefined;
  }
  const free = ceiling.slice(1).find((path) => a.locks.attempt(path, full));
  if (free === undefined)
    a.say(
      keyOf("full", holders),
      `all ${a.settings.slots} slots held: ${describeHolders(holders)}`,
    );
  return free;
}
// One sweep: the slot it took, "busy" when the admission lock was, or nothing.
function sweepOnce(a: Acquisition, full: boolean): string | "busy" | undefined {
  const announcement = `${a.slot(0)}.exclusive`;
  if (full) a.locks.reclaim(announcement);
  const announced = a.locks.holders([announcement]);
  if (announced.length > 0) {
    a.say(
      keyOf("exclusive", announced),
      `an exclusive holder takes every slot: ${describeHolders(announced)}`,
    );
    return undefined;
  }
  if (a.locks.attempt(a.slot(0), full)) return a.slot(0);
  const admission = `${a.slot(0)}.admission`;
  if (!a.locks.attempt(admission, full)) return "busy";
  recordHolder(admission);
  try {
    return admittedSlot(a, full);
  } finally {
    a.locks.release(admission);
  }
}
// Sweep the slots: a free slot 0 at once, any other one when admitted.
async function takeSlot(a: Acquisition): Promise<void> {
  // Every retry counts, busy ones too: the identity check on the admission
  // lock must come round even while a crashed holder keeps it busy.
  let sweeps = 0;
  for (;;) {
    const got = sweepOnce(a, sweeps % FULL_CHECK_EVERY === 0);
    if (got !== undefined && got !== "busy") {
      hold(a, got);
      return;
    }
    sweeps++;
    const jitter = a.pollGiven
      ? a.pollMs * (1 + 1.5 * Math.random())
      : (2 + 3 * Math.random()) * 1000;
    if (!(await pause(a, got === "busy" ? Math.min(jitter, 300) : jitter)))
      return;
  }
}
export async function main(
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  probe: () => HostLoad = readHostLoad,
): Promise<number> {
  const {
    args: command,
    name,
    exclusive,
    root,
    timeout,
    timeoutSeconds,
    pollSeconds,
    pollGiven,
    settings,
  } = lockArguments(args, env);
  const run = () => runLockedCommand(command, env);
  if (env.CI === "1" || env.CI === "true" || env.RESOURCE_LOCK_BYPASS === "1")
    return run();
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
    if (!lstatSync(root).isDirectory()) refuse("not a directory");
  } catch {
    refuse(`LOCK_ROOT is not a writable directory: ${root}`);
  }
  const fileOwners = platform === "win32";
  const started = performance.now();
  const deadline = started + timeoutSeconds * 1000;
  const lock = resourceLockPath(root, name);
  const locks = publisher(lock, fileOwners, deadline);
  let said: string | undefined;
  const waiting = `${lock}.waiting.${process.pid}`;
  let announced = false;
  const unannounce = () => {
    if (announced) rmSync(waiting, { force: true });
    announced = false;
  };
  const a: Acquisition = {
    locks,
    name,
    slot: (n) => resourceLockSlotPath(root, name, n),
    settings,
    probe,
    pollMs: pollSeconds * 1000,
    pollGiven,
    remaining: () => deadline - performance.now(),
    say: (key, text) => {
      a.waitingOn = text;
      if (!announced)
        try {
          // The predictable name is in a shared temporary directory: never
          // follow a pre-existing entry while publishing this announcement.
          writeFileSync(waiting, encodeIdentity(ownIdentity()), { flag: "wx" });
          announced = true;
        } catch (error) {
          if (
            errorCode(error) === "EEXIST" &&
            reclaimWaitingAnnouncement(waiting)
          ) {
            try {
              writeFileSync(waiting, encodeIdentity(ownIdentity()), {
                flag: "wx",
              });
              announced = true;
            } catch (retryError) {
              swallow(retryError, "the wait goes uncounted, not unserved");
            }
          } else swallow(error, "the wait goes uncounted, not unserved");
        }
      if (key === said) return;
      said = key;
      console.error(
        `resource lock: waiting for '${name}' (${text}); up to ${timeout}s`,
      );
    },
    taken: [],
    blocker: lock,
    waitingOn: "",
  };
  const releaseAll = () => {
    for (const path of a.taken.splice(0).reverse()) locks.release(path);
  };
  // Registered before the wait, so a signal releases a partial hold too.
  using release = registerCleanup(() => {
    unannounce();
    releaseAll();
  });
  void release;
  if (exclusive) await takeEvery(a);
  else if (settings.slots === 1) await takeSingle(a);
  else await takeSlot(a);
  unannounce();
  if (a.taken.length === 0 || (exclusive && a.taken.length < MAX_SLOTS + 1)) {
    releaseAll();
    console.error(refusal(a, timeout, fileOwners, exclusive));
    return 3;
  }
  if (said !== undefined) reportTaken(a, exclusive, started);
  return await run();
}
// Why a wait ran out: who holds what blocked it, and what admission last said.
function refusal(
  a: Acquisition,
  timeout: string,
  fileOwners: boolean,
  exclusive: boolean,
): string {
  const holders = a.locks.holders([a.blocker]);
  const who = holders.length
    ? describeHolders(holders)
    : heldBy(a.blocker, fileOwners);
  const why =
    a.settings.slots === 1 || exclusive || a.waitingOn === ""
      ? ""
      : `; last waiting on: ${a.waitingOn}`;
  return `ERROR: could not acquire lock '${a.name}' within ${timeout}s (held by ${who}${why})`;
}
// After a wait: which slot was taken, and how long the wait was.
function reportTaken(
  a: Acquisition,
  exclusive: boolean,
  started: number,
): void {
  const what = exclusive
    ? " with every slot"
    : a.taken[0] === a.slot(0)
      ? ""
      : ` (${basename(a.taken[0] ?? "")})`;
  console.error(
    `resource lock: took '${a.name}'${what} after ${duration((performance.now() - started) / 1000)}`,
  );
}
