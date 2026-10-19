/** Scoped resources also remain reachable when a signal or process.exit skips scope disposal. */
type CleanupSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";
type SignalHandler = (signal: CleanupSignal) => void | Promise<void>;

interface Registry {
  resources: Set<Disposable>;
  signals: Set<SignalHandler>;
  pending: Set<Promise<void>>;
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

function disposeAll(registry: Registry): void {
  for (const resource of [...registry.resources].reverse()) {
    try {
      resource[Symbol.dispose]();
    } catch (error) {
      report(error);
    }
  }
}

function createRegistry(): Registry {
  const registry: Registry = {
    resources: new Set(),
    signals: new Set(),
    pending: new Set(),
  };
  process.on("exit", () => disposeAll(registry));
  const signals: CleanupSignal[] =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    const onSignal = (): void => {
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
      const settled = async (): Promise<void> => {
        // Repeated signals may add more work while an earlier callback awaits.
        while (registry.pending.size > 0)
          await Promise.all([...registry.pending]);
      };
      void settled().then(() => {
        // Respect callers outside the kernel that deliberately own termination.
        if (process.listenerCount(signal) > 1) return;
        const hadResources = registry.resources.size > 0;
        disposeAll(registry);
        if (hadResources || process.platform === "win32") {
          process.exit(
            signal === "SIGINT"
              ? 130
              : signal === "SIGTERM"
                ? 143
                : signal === "SIGBREAK"
                  ? 149
                  : 129,
          );
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

/** Register once; disposal detaches before invoking the callback and is idempotent. */
export function registerCleanup(cleanup: () => void): Disposable {
  let live = true;
  const resource: Disposable = {
    [Symbol.dispose]() {
      if (!live) return;
      live = false;
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
