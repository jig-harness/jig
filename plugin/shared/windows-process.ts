import type { ChildProcess } from "node:child_process";
import {
  createProcessRegistry,
  PROCESS_REGISTRY_ENV,
  processRegistryRoots,
} from "./process-registry.ts";
import {
  reapRegisteredProcessTrees,
  stopWindowsTree,
  type WindowsTreeState,
} from "./process-tree.ts";

/** One cancellation promise owns a Windows child's registry until its tree settles. */
export function windowsProcessLifecycle(
  env?: Record<string, string | undefined>,
) {
  const enabled = process.platform === "win32";
  const inherited =
    env?.[PROCESS_REGISTRY_ENV] ?? process.env[PROCESS_REGISTRY_ENV];
  const owned = enabled ? createProcessRegistry(inherited) : undefined;
  const dir = owned?.dir;
  const childEnv = dir
    ? { ...(env ?? process.env), [PROCESS_REGISTRY_ENV]: dir }
    : env;
  let stopping: Promise<boolean> | undefined;
  let child: ChildProcess | undefined;
  let confirmedStop = false;
  let keepRegistry = false;
  let groupSurvived = false;
  const state: WindowsTreeState = { root: null, targets: [] };
  const killOwned = (): void => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* The child handle has already closed. */
    }
  };
  const stop = (
    pid: number | undefined,
    graceMs: number,
    stillOwned?: () => boolean,
  ): Promise<boolean> => {
    if (confirmedStop) return Promise.resolve(true);
    if (stopping) return stopping;
    if (pid === undefined) return Promise.resolve(false);
    const pending = stopWindowsTree(pid, graceMs, dir, stillOwned, {
      state,
      killOwned,
    });
    stopping = pending;
    void pending.then((confirmed) => {
      confirmedStop = confirmed;
      keepRegistry = !confirmed;
      if (stopping === pending) stopping = undefined;
    });
    return pending;
  };
  const dispose = (): void => {
    // A normal command can leave a registered runner behind. Its scope remains
    // discoverable by the acquisition owner until cancellation verifies its exit.
    if (
      confirmedStop ||
      (!keepRegistry && dir && processRegistryRoots(dir)?.length === 0)
    )
      owned?.dispose();
  };
  const finish = (done: () => void): void => {
    const pending = stopping;
    if (pending) {
      void pending.then(() => {
        dispose();
        done();
      });
    } else {
      dispose();
      done();
    }
  };
  return {
    enabled,
    env: childEnv,
    dir,
    stop,
    finish,
    dispose,
    bind: (spawned: ChildProcess) => {
      child = spawned;
    },
    get groupSurvived() {
      return groupSurvived;
    },
    reap(pid: number | undefined): void {
      if (!enabled || !dir || pid === undefined) return;
      if (stopping) return;
      const pending = reapRegisteredProcessTrees(dir).then((result) => {
        groupSurvived = result.survived;
        if (result.confirmed) owned?.dispose();
        return result.confirmed;
      });
      stopping = pending;
      void pending.then((confirmed) => {
        keepRegistry = !confirmed;
        if (stopping === pending) stopping = undefined;
      });
    },
    signal(
      child: ChildProcess,
      detached: boolean,
      signal: NodeJS.Signals,
      graceMs = 2000,
    ): void {
      const pid = child.pid;
      if (pid === undefined) return;
      if (enabled) {
        void stop(
          pid,
          signal === "SIGKILL" ? 0 : graceMs,
          () => child.exitCode === null && child.signalCode === null,
        );
        return;
      }
      try {
        if (detached) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* Already gone. */
        }
      }
    },
  };
}
