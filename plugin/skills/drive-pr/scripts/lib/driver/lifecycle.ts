/** Keep cancellation and descendant cleanup attached to the driver until all retained work settles. */
import type { DriveLock } from "./locks.ts";

import {
  registerSignalHandler,
  beginShutdown,
  requestShutdown,
  registerCleanup,
} from "./../../../../../shared/cleanup.ts";

import { driverRuntime } from "./runtime.ts";

import { cancelTrackedProcesses } from "./../../../../../shared/proc.ts";

import {
  driverStopRequested,
  publishDriverStopCompletion,
} from "./../stop-request.ts";

import {
  reapRegisteredProcessTrees,
  type WindowsTreeState,
} from "./../../../../../shared/process-tree.ts";

import { fail } from "./../cli.ts";

import { join } from "node:path";

import { mkdirSync, utimesSync, existsSync } from "node:fs";

import { PROCESS_REGISTRY_ENV } from "./../../../../../shared/process-registry.ts";

import { claimName } from "./../claim.ts";

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

export function installStopControls(
  held: DriveLock[],
  registry?: string,
): Disposable {
  let shuttingDown = false;
  let requested = false;
  const cancellation = registerSignalHandler(async (sig) => {
    beginShutdown();
    if (shuttingDown) held.length = 0;
    driverRuntime.driverShuttingDown = true;
    shuttingDown = true;
    let confirmed = false;
    try {
      const helpersGone = await cancelTrackedProcesses();
      const gone = await stopActivePass(
        `received ${requested ? "stop request" : sig}`,
        registry ?? driverRegistry,
      );
      confirmed = helpersGone && gone;
    } finally {
      driverRuntime.driverStopConfirmed = confirmed;
      if (!confirmed) held.length = 0;
    }
  });
  const stopTimer = setInterval(() => {
    if (
      !shuttingDown &&
      held.some(
        (lock) =>
          lock.nonce !== undefined && driverStopRequested(lock.dir, lock.nonce),
      )
    ) {
      requested = true;
      requestShutdown("SIGTERM", driverStopExitCode("stop request"));
    }
  }, 250);
  stopTimer.unref?.();
  return {
    [Symbol.dispose]() {
      clearInterval(stopTimer);
      cancellation[Symbol.dispose]();
    },
  };
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
): AsyncDisposable {
  const controls = installStopControls(held, registry);
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

/** Publish success only behind the cancellation barrier, before claims are released. */
export function driverStopCompletionCleanup(held: DriveLock[]): Disposable {
  return registerCleanup(() => {
    if (!driverRuntime.driverStopConfirmed) return;
    try {
      for (const lock of held)
        if (
          lock.nonce !== undefined &&
          driverStopRequested(lock.dir, lock.nonce)
        )
          publishDriverStopCompletion(lock.dir, lock.nonce, process.pid);
    } catch (error) {
      held.length = 0;
      throw error;
    }
  });
}

export function createDriverRegistry(held: DriveLock[]): void {
  // The registry belongs to this acquisition. Detached foreground runners
  // inherit it, so the operator can also capture them if a driver is wedged.
  if (process.platform === "win32") {
    const prLock = held[held.length - 1];
    if (prLock?.nonce !== undefined) {
      const registry = join(prLock.dir, `processes.${prLock.nonce}`);
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
      "  lock costs a refusal instead: remove the lock dir once the pass is gone.",
    );
  }
  return gone;
}

/**
 * Refresh this process's claim on a lock it holds, and notice if it has
 * stopped holding it.
 *
 * `utimes` on the claim's own generation-keyed name is the whole operation.
 * There is no ownership check in front of it to race, because the only entry
 * it can reach is the one this process published — a successor's carries a
 * different name and is not addressable from here at all.
 *
 * So a MISSING claim is the takeover signal, and it is exact: the only thing
 * that removes `claim.<ours>` is a recovery of this generation. A refresh that
 * fails for any other reason must not be read that way — a drive must not die
 * because it could not write — so the absence is confirmed before the drive
 * gives up on a lock it may still hold.
 */
export function touchLock(lock: DriveLock): void {
  if (lock.nonce === undefined) return; // never taken
  const claim = join(lock.dir, claimName(lock.nonce));
  const now = Date.now() / 1000;
  try {
    utimesSync(claim, now, now);
    return;
  } catch {
    if (existsSync(claim)) return; // transient: the claim is still ours
  }
  // Our GENERATION is gone, so another driver recovered this path while we
  // believed we held it. A drive that keeps going from here is the second
  // driver the lock exists to prevent, so record it and let the loop stop;
  // `release` will not touch the successor's lock, because the only name it
  // removes is ours.
  noteTakeover(lock);
}

/**
 * The one response to a detected takeover, called the moment one is detected
 * and before anything else is done or printed about it: `compromised` is what
 * stops the driver log rotating (`mayRotateDriverLog`), and a diagnostic
 * written while it is still unset could rename the log over the successor's
 * history.
 *
 * Recording it is not enough on its own: the loop only reads `compromised`
 * at a round boundary, and a pass already running does not pause at one. So
 * the pass is stopped HERE, the moment ownership is lost — the
 * fire-and-forget is deliberate, since a timer callback cannot block and
 * `stop()` is synchronous up to the SIGTERM; the loop awaits the same handle
 * before it decides anything. The quota sleep is aborted for the same
 * reason: `stopActivePass` is a no-op when nothing is running, which is
 * exactly the state the driver is in for up to six hours while sleeping out a
 * short quota window, and a controller with no listener is a harmless no-op.
 */
export function noteTakeover(lock: DriveLock): void {
  if (driverRuntime.compromised !== "") return;
  driverRuntime.compromised = lock.what;
  void stopActivePass(`the ${lock.what} lock was recovered by another driver`);
  driverRuntime.quotaSleepAbort?.abort();
}
