/** Keep cancellation and descendant cleanup attached to the driver until all retained work settles. */
import { type DriveLock, processRegistryDir, renewLock } from "./locks.ts";

import {
  registerSignalHandler,
  beginShutdown,
  requestShutdown,
} from "./../../../../../shared/cleanup.ts";

import { driverRuntime } from "./runtime.ts";

import { cancelTrackedProcesses } from "./../../../../../shared/proc.ts";

import { ackDirective, watchImmediateStop } from "./../state/mailbox-stop.ts";

import type { MailboxWatch } from "./mailbox.ts";

import {
  reapRegisteredProcessTrees,
  type WindowsTreeState,
} from "./../../../../../shared/process-tree.ts";

import { fail } from "./../cli.ts";

import { mkdirSync } from "node:fs";

import { PROCESS_REGISTRY_ENV } from "./../../../../../shared/process-registry.ts";

/** Conventional exit status for the driver's signal and cooperative stop paths. */
export function driverStopExitCode(sig: string): number {
  return sig === "SIGINT"
    ? 130
    : sig === "SIGTERM" || sig === "stop request"
      ? 143
      : sig === "SIGBREAK"
        ? 149
        : 129;
}

/**
 * Cancel the active pass and stop on a signal, or on the mailbox `stop` that
 * `drives.ts --stop` addresses to this driver's generation with `now`, read
 * every quarter second from `watch`'s mailbox: the cooperative channel a
 * platform without signals between processes needs. Once the pass tree is
 * witnessed gone, the driver acknowledges that stop in the outbox before its
 * locks are released; an acknowledgement it cannot append keeps the locks, so
 * `drives.ts` does not take a stop it cannot see for a finished one.
 */
export function installStopControls(
  held: DriveLock[],
  registry?: string,
  watch?: MailboxWatch,
): Disposable {
  let shuttingDown = false;
  let requested: string | null = null;
  const cancellation = registerSignalHandler(async (sig) => {
    beginShutdown();
    if (shuttingDown) held.length = 0;
    driverRuntime.driverShuttingDown = true;
    shuttingDown = true;
    let confirmed = false;
    try {
      const helpersGone = await cancelTrackedProcesses();
      const gone = await stopActivePass(
        `received ${requested !== null ? "stop request" : sig}`,
        registry ?? driverRegistry,
      );
      confirmed = helpersGone && gone;
    } finally {
      driverRuntime.driverStopConfirmed = confirmed;
      if (!confirmed) held.length = 0;
    }
    if (confirmed && requested !== null && watch !== undefined)
      await acknowledgeStop(held, watch, requested);
  });
  const pollStop =
    watch === undefined
      ? null
      : watchImmediateStop(watch.dir, watch.pr, watch.generation);
  const stopTimer = setInterval(() => {
    if (shuttingDown || pollStop === null) return;
    const stop = pollStop();
    if (stop === null) return;
    requested = stop;
    requestShutdown("SIGTERM", driverStopExitCode("stop request"));
  }, 250);
  stopTimer.unref?.();
  return {
    [Symbol.dispose]() {
      clearInterval(stopTimer);
      cancellation[Symbol.dispose]();
    },
  };
}

/** Acknowledge the stop the driver acted on; a failure keeps the locks (see `installStopControls`). */
async function acknowledgeStop(
  held: DriveLock[],
  watch: MailboxWatch,
  id: string,
): Promise<void> {
  try {
    await ackDirective(watch.dir, watch.pr, id, watch.generation);
  } catch (error) {
    held.length = 0;
    console.error(
      `drive.ts: could not acknowledge stop ${id} (${error instanceof Error ? error.message : String(error)}) — NOT releasing the locks.`,
    );
  }
}

/** Drain acquisition-owned runner registrations before another pass or lock release. */
export async function drainDriverRegistrations(
  registry: string | null = driverRegistry,
): Promise<{ survived: boolean; confirmed: boolean }> {
  if (registry === null) return { survived: false, confirmed: true };
  const current = registrationDrains.get(registry);
  if (current !== undefined) return current;
  let state = registrationStates.get(registry);
  if (!state) {
    state = { root: null, targets: [] };
    registrationStates.set(registry, state);
  }
  const pending = reapRegisteredProcessTrees(registry, { state });
  registrationDrains.set(registry, pending);
  try {
    return await pending;
  } finally {
    if (registrationDrains.get(registry) === pending)
      registrationDrains.delete(registry);
  }
}

export async function finishDriverPassRegistrations(
  locks: DriveLock[],
  registry: string | null = driverRegistry,
): Promise<boolean> {
  if (driverRuntime.driverShuttingDown)
    await new Promise<never>(() => {
      // The shutdown coordinator owns process exit.
    });
  const result = await drainDriverRegistrations(registry).catch((error) => {
    locks.length = 0;
    throw error;
  });
  if (driverRuntime.driverShuttingDown)
    await new Promise<never>(() => {
      // The shutdown coordinator owns process exit.
    });

  if (!result.confirmed) {
    locks.length = 0;
    console.error(
      "drive.ts: retained runner termination could NOT be witnessed — NOT releasing the locks.",
    );
    return false;
  }
  if (result.survived) {
    console.error(
      "drive.ts: the pass left registered work running; it was forced to stop — not advancing this drive.",
    );
    return false;
  }
  return true;
}

export async function requireDriverPassRegistrations(
  held: DriveLock[],
  registry?: string,
): Promise<void> {
  if (!(await finishDriverPassRegistrations(held, registry)))
    fail(1, "retained acquisition work prevented a clean driver completion");
}

function driverRegistryDrain(
  held: DriveLock[],
  registry?: string,
): AsyncDisposable {
  return {
    [Symbol.asyncDispose]() {
      return requireDriverPassRegistrations(held, registry);
    },
  };
}

/** Keep signal and cooperative cancellation installed until the final drain settles. */
export function installDriverLifecycle(
  held: DriveLock[],
  registry?: string,
  watch?: MailboxWatch,
): AsyncDisposable {
  const controls = installStopControls(held, registry, watch);
  const drain = driverRegistryDrain(held, registry);
  return {
    async [Symbol.asyncDispose]() {
      try {
        await drain[Symbol.asyncDispose]();
      } finally {
        controls[Symbol.dispose]();
      }
    },
  };
}

let driverRegistry: string | null = null;

const registrationStates = new Map<string, WindowsTreeState>();

const registrationDrains = new Map<
  string,
  Promise<{ survived: boolean; confirmed: boolean }>
>();

export function createDriverRegistry(held: DriveLock[]): void {
  // The registry belongs to this acquisition. Detached foreground runners
  // inherit it, so the operator can also capture them if a driver is wedged.
  if (process.platform === "win32") {
    const prLock = held[held.length - 1];
    if (prLock?.nonce !== undefined) {
      const registry = processRegistryDir(prLock) as string;
      mkdirSync(registry);
      driverRegistry = registry;
      process.env[PROCESS_REGISTRY_ENV] = registry;
    }
  }
}

/**
 * End the running pass and report whether its termination was WITNESSED.
 *
 * The answer comes from `RunHandle.stop()`, which polls the pass's process
 * group until no member is left, and never from the pass process's own exit or
 * from the fact that a signal was sent. Those two are what the first cuts of
 * this used, and both were wrong in the same direction: the leader closing
 * says nothing about a descendant that ignored SIGTERM, and delivering SIGKILL
 * says nothing about a process wedged in uninterruptible sleep.
 *
 * `false` therefore means "still running, as far as anything can tell" — and
 * callers must treat it as "the locks may NOT be released". A live pass under
 * a released lock is precisely the concurrent driver the lock exists to
 * prevent, while a lock left behind costs a refusal a human clears in one
 * command (`acquire` says how) or that the staleness window clears by itself.
 */
async function stopActivePass(
  why: string,
  registry: string | null = driverRegistry,
): Promise<boolean> {
  const handle = driverRuntime.activePass;
  if (handle === null)
    return (await drainDriverRegistrations(registry)).confirmed;
  console.error(`drive.ts: stopping the active pass — ${why}`);
  // Recorded before the await so the loop can re-join this same wait — `stop()`
  // memoises, so a second caller shares the outcome rather than restarting it.
  driverRuntime.passStopWitness = handle.stop();
  const passGone = await driverRuntime.passStopWitness;
  const registered = await drainDriverRegistrations(registry);
  const gone = passGone && registered.confirmed;
  if (!gone) {
    console.error(
      "drive.ts: could not witness the pass tree terminating — NOT releasing the locks.",
    );
    console.error(
      "  A released lock plus a live pass is two drivers on one tree. Leaving the",
    );
    console.error(
      "  lock costs a refusal instead: run drives.ts --stop once the pass is gone.",
    );
  }
  return gone;
}

/**
 * Renew this driver's heartbeat on `lock`. A renewal that finds the lock no
 * longer carries this acquisition's token means another driver recovered it:
 * the takeover is noted and the active pass stopped. A renewal that fails
 * (the database was busy past its wait) is transient: the next heartbeat
 * tries again, and the lock is still this driver's.
 */
export function touchLock(lock: DriveLock): void {
  if (lock.nonce === undefined) return; // never taken
  let renewed: boolean;
  try {
    renewed = renewLock(lock);
  } catch {
    return;
  }
  if (!renewed) noteTakeover(lock);
}

export function noteTakeover(lock: DriveLock): void {
  if (driverRuntime.compromised !== "") return;
  driverRuntime.compromised = lock.what;
  void stopActivePass(`the ${lock.what} lock was recovered by another driver`);
  driverRuntime.quotaSleepAbort?.abort();
}
