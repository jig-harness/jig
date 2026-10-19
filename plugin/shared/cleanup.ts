/** Scoped resources also remain reachable when a signal or process.exit skips scope disposal. */
type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";
type SignalHandler = (signal: CleanupSignal) => void | Promise<void>;

interface Registry {
  resources: Set<Disposable>;
  signals: Set<SignalHandler>;
  pending: Set<Promise<void>>;
  deferred: Set<Disposable>;
  dispatching: number;
  shutdownRequested: boolean;
}
const registryKey = Symbol.for("jig.cleanup.registry");
const globals = globalThis as typeof globalThis & { [registryKey]?: Registry };

function report(error: unknown): void {
  try {
    console.error(
      "jig cleanup:",
      error instanceof Error ? error.message : String(error),
    );
  } catch {
    return;
  }
}

function disposeResources(resources: Iterable<Disposable>): void {
  for (const resource of [...resources].reverse()) {
    try {
      resource[Symbol.dispose]();
    } catch (error) {
      report(error);
    }
  }
}

function disposeAll(registry: Registry): void {
  disposeResources(registry.resources);
}

function startCancellation(registry: Registry, signal: CleanupSignal): void {
  registry.dispatching++;
  // Start every callback synchronously so cancellation forwarding is prompt.
  for (const handler of [...registry.signals].reverse()) {
    try {
      const result = handler(signal);
      if (result) {
        const pending = result
          .catch(report)
          .finally(() => registry.pending.delete(pending));
        registry.pending.add(pending);
      }
    } catch (error) {
      report(error);
    }
  }
  registry.dispatching--;
}

async function cancellationSettled(registry: Registry): Promise<void> {
  // Repeated signals can add work while an earlier cancellation awaits.
  while (registry.pending.size > 0) await Promise.all([...registry.pending]);
  disposeResources(
    [...registry.resources].filter((resource) =>
      registry.deferred.has(resource),
    ),
  );
}

function signalExitCode(signal: CleanupSignal): number {
  return signal === "SIGINT"
    ? 130
    : signal === "SIGTERM"
      ? 143
      : signal === "SIGBREAK"
        ? 149
        : 129;
}

function createRegistry(): Registry {
  const registry: Registry = {
    resources: new Set(),
    signals: new Set(),
    pending: new Set(),
    deferred: new Set(),
    dispatching: 0,
    shutdownRequested: false,
  };
  process.on("exit", () => disposeAll(registry));
  const signals: CleanupSignal[] =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const onSignal = (): void => {
      const heldResources = registry.resources.size > 0;
      startCancellation(registry, signal);
      void cancellationSettled(registry).then(() => {
        // Respect callers outside the kernel that deliberately own termination.
        if (process.listenerCount(signal) > 1) return;
        const hadResources = heldResources || registry.resources.size > 0;
        disposeAll(registry);
        if (hadResources || process.platform === "win32") {
          process.exit(signalExitCode(signal));
        }
        (process as unknown as import("node:events").EventEmitter).off(
          signal,
          onSignal,
        );
        process.kill(process.pid, signal);
      });
    };
    process.on(signal, onSignal);
  }
  return registry;
}

const registry = globals[registryKey] ?? createRegistry();
globals[registryKey] = registry;

/** Register once; disposal is idempotent and waits behind active cancellation. */
export function registerCleanup(cleanup: () => void): Disposable {
  let live = true;
  const resource: Disposable = {
    [Symbol.dispose]() {
      if (!live) return;
      if (registry.dispatching > 0 || registry.pending.size > 0) {
        registry.deferred.add(resource);
        return;
      }
      live = false;
      registry.deferred.delete(resource);
      registry.resources.delete(resource);
      cleanup();
    },
  };
  registry.resources.add(resource);
  return resource;
}

/**
 * Scoped asynchronous cancellation, run before synchronous resource release.
 * Release waits for every callback to settle and has no deadline of its own: a
 * kernel-level forced exit would release resources beneath work that is still
 * running. A callback bounds its own wait, escalating to SIGKILL where its
 * child may ignore the first signal. Each repeated signal re-runs every
 * callback.
 */
export function registerSignalHandler(handler: SignalHandler): Disposable {
  registry.signals.add(handler);
  return {
    [Symbol.dispose]() {
      registry.signals.delete(handler);
    },
  };
}

/** Explicit shutdown intent prevents new commands while owned cancellation drains. */
export function beginShutdown(): void {
  registry.shutdownRequested = true;
}

export function shutdownRequested(): boolean {
  return registry.shutdownRequested;
}

/** Cooperative shutdown follows the same cancellation-before-release order as signals. */
export function requestShutdown(
  signal: CleanupSignal,
  exitCode = signalExitCode(signal),
): void {
  beginShutdown();
  startCancellation(registry, signal);
  void cancellationSettled(registry).then(() => {
    disposeAll(registry);
    process.exit(exitCode);
  });
}
