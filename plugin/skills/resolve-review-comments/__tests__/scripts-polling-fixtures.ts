/** An asynchronous review-loop fixture, with its cache and accounting in its own home. */
import { delimiter, join } from "node:path";
import { spawn } from "../../../shared/guarded-git-spawn.ts";
import {
  SCRIPTS,
  repoDir,
  binDir,
  gitCleanEnv,
  type Fixture,
} from "./scripts-harness.ts";

/** The real loop, running, with its own throwaway ETag cache. */
export function spawnLoop(
  fix: Fixture,
  args: string[],
  env: Record<string, string> = {},
): { done: Promise<{ code: number; stderr: string }>; kill: () => void } {
  const child = spawn(
    process.execPath,
    [join(SCRIPTS, "await-round.ts"), fix.pr, ...args],
    {
      cwd: repoDir,
      env: {
        ...gitCleanEnv(),
        HOME: fix.dir,
        USERPROFILE: fix.dir,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        RRC_FIX: fix.dir,
        GH_CALL_TIMEOUT: "20",
        JIG_GH_CACHE_DIR: join(fix.dir, "etag-cache"),
        AWAIT_ROUND_POLL_MS: "100",
        ...env,
      },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
  return { done, kill: () => child.kill("SIGKILL") };
}
