import type { ChildProcess } from "node:child_process";
import {
  createProcessRegistry,
  PROCESS_REGISTRY_ENV,
} from "./process-registry.ts";
import {
  captureRegisteredProcessTrees,
  forceIdentityTargetsAndWitness,
  stopWindowsTree,
} from "./process-tree.ts";

/** One cancellation promise owns a Windows child's registry until its tree settles. */
export function windowsProcessLifecycle(
  env?: Record<string, string | undefined>,
) {
  const enabled = process.platform === "win32";
  const inherited =
    env?.[PROCESS_REGISTRY_ENV] ?? process.env[PROCESS_REGISTRY_ENV];
  const owned = enabled && !inherited ? createProcessRegistry() : undefined;
  const dir = inherited ?? owned?.dir;
  const childEnv = dir
    ? { ...(env ?? process.env), [PROCESS_REGISTRY_ENV]: dir }
    : env;
  let stopping: Promise<boolean> | undefined;
  let settled = false;
  let keepRegistry = false;
  let groupSurvived = false;
  const stop = (
    pid: number | undefined,
    graceMs: number,
    stillOwned?: () => boolean,
  ): Promise<boolean> =>
    (stopping ??=
      pid === undefined
        ? Promise.resolve(false)
        : stopWindowsTree(pid, graceMs, dir, stillOwned));
  const finish = (done: () => void): void => {
    if (stopping && !settled) {
      void stopping.then((confirmed) => {
        keepRegistry = !confirmed;
        settled = true;
        finish(done);
      });
      return;
    }
    if (!keepRegistry) owned?.dispose();
    done();
  };
  return {
    enabled,
    env: childEnv,
    dir,
    stop,
    finish,
    dispose: () => owned?.dispose(),
    get groupSurvived() {
      return groupSurvived;
    },
    reap(pid: number | undefined): void {
      if (!enabled || !dir || pid === undefined) return;
      stopping ??= (async () => {
        const targets = await captureRegisteredProcessTrees(dir);
        groupSurvived = targets === null || targets.length > 0;
        if (targets === null) return false;
        if (!groupSurvived) return true;
        return forceIdentityTargetsAndWitness(targets);
      })();
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
