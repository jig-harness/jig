/**
 * A local git command the tick runs under its own deadline: each call is
 * bounded by the shorter of a fixed timeout and what is left of the tick's
 * time, and a call left no time is not run. The tick's readers of local
 * trees (`pickup-tree.ts`, `priorities-read.ts`) share it, so they time out
 * and report a failure alike.
 */
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";
import { currentMs } from "../../shared/time.ts";

/** The longest one git call may take, whatever time the tick has left. */
const GIT_TIMEOUT_MS = 10_000;

/** A git command's output, or why it failed. */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; why: string };

/**
 * Runs `git <args>` in `cwd` within what is left of `deadlineMs` (epoch
 * milliseconds; none means only the fixed timeout). On failure, `why` says
 * the time was spent, the command timed out, or its exit code and last line
 * of error output; `nameCwd` puts the directory in that text.
 */
export function boundedGit(
  cwd: string,
  args: string[],
  deadlineMs: number | undefined,
  nameCwd = false,
): GitResult {
  const what = nameCwd ? `git ${args[0]} in ${cwd}` : `git ${args[0]}`;
  const left = deadlineMs === undefined ? Infinity : deadlineMs - currentMs();
  if (left < 1)
    return { ok: false, why: `${what} not run: the tick's time is spent` };
  const r = spawnSync("git", args, {
    cwd,
    timeout: Math.min(GIT_TIMEOUT_MS, Math.floor(left)),
    env: withoutLeakyGitEnv(process.env),
  });
  if (r.status === 0) return { ok: true, stdout: r.stdout };
  if (r.error !== undefined)
    return { ok: false, why: `${what}: ${r.error.message}` };
  if (r.signal !== null)
    return {
      ok: false,
      why: `${what} did not finish within ${GIT_TIMEOUT_MS / 1000}s (${r.signal})`,
    };
  const last = (r.stderr ?? "").trim().split("\n").at(-1)?.trim();
  return {
    ok: false,
    why: `${what} exited ${r.status}${last ? `: ${last}` : ""}`,
  };
}
