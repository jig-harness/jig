/**
 * Running a worktree hook on this machine under the shared supervisor
 * (`shared/worktree-hooks.ts`), with the hook's process group recorded where
 * its caller asks, so a failed run's leftovers can be told apart and ended.
 * The Herdr and Orca workspace tools run a hook on this machine through here,
 * and so does the plugin code that opens an Orca workspace: whoever opens
 * the worktree, nothing of a failed run is still running when its claim is
 * given back and the next open runs the hook again.
 */
import { readFileSync } from "node:fs";
import { errnoCode } from "../errors.ts";
import { currentMs } from "../time.ts";
import { hookFailure, superviseHook } from "../worktree-hooks.ts";
import { HOOK_TIMEOUT_MS } from "./limits.ts";
import type { HookRunner } from "./port.ts";
import { processAlive, processStart } from "./process-start.ts";
import {
  budget,
  type Context,
  HerdrError,
  UnendedGroupError,
} from "./runner.ts";

/**
 * Run a hook in its worktree under the supervisor; throws when it fails. Its
 * output goes to the log. With `groupFile`, the hook's process group is
 * recorded there, and a failed run's group is ended before this returns, so
 * nothing of it is still running when the hook is run again. The hook gets
 * `HOOK_TIMEOUT_MS`, or what is left of the run's limit when that is less.
 * The hook runs on this machine whatever `ctx` runs its commands on. When
 * the group cannot be ended, the error names the hook's own failure first,
 * then why its group may still be running.
 */
export const supervisedHook: HookRunner = (ctx, worktree, path, groupFile) => {
  const run = superviseHook(
    worktree,
    path,
    budget(ctx, HOOK_TIMEOUT_MS),
    groupFile,
  );
  for (const line of run.lines) ctx.log(line);
  const failure = hookFailure(path, run);
  if (failure === null) return;
  if (groupFile !== undefined)
    try {
      endGroup(ctx, groupFile);
    } catch (error) {
      throw new UnendedGroupError(
        `${failure}; its process group may still be running, as it could not be ended (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
  throw new HerdrError(failure);
};

/**
 * A process a hook run recorded. A start the supervisor could not read is
 * null, and the id alone is checked then.
 */
export interface Recorded {
  pid: number;
  start: string | null;
}

/** The processes a hook run recorded in `groupFile`, by role; empty when none were. */
export function recordedRun(groupFile: string): {
  wrapper?: Recorded;
  group?: Recorded;
} {
  let text: string;
  try {
    text = readFileSync(groupFile, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return {};
    throw error;
  }
  const run: { wrapper?: Recorded; group?: Recorded } = {};
  for (const line of text.split("\n")) {
    const [role, pidText, start] = line.split(" ");
    const pid = Number(pidText);
    if (
      (role === "wrapper" || role === "group") &&
      Number.isInteger(pid) &&
      pid > 0
    )
      run[role] = { pid, start: start || null };
  }
  return run;
}

/**
 * Whether the hook's process group still has a process in it. A group's id
 * is its first process's id, which the system does not give to another
 * process while the group has one left; so when that id now names a process
 * with another start, the group that has it is a new one, and the hook's has
 * ended.
 */
export function groupAlive(ctx: Context, group: Recorded): boolean {
  if (!processAlive(-group.pid)) return false;
  if (group.start === null) return true;
  const start = processStart(ctx, group.pid);
  return start === null || start === group.start;
}

/** How long a killed group may take to disappear before it counts as not ended. */
const GROUP_END_TIMEOUT_MS = 5_000;
const GROUP_POLL_MS = 50;

/**
 * Kill what is left of a failed run's process group, only while the id still
 * names that group (`groupAlive`): once it names another, the hook's group
 * has ended and the other is not this run's to kill. A group that is gone
 * answers ESRCH. A kill is a request: this returns only once the group is
 * seen gone, within a bounded wait, and throws when it is not, EPERM
 * included, which a live group the caller may not signal answers too.
 * Cleanup keeps processStart's own fixed deadline after the run budget expires,
 * so an expired hook still gets its identity checked before any group signal.
 */
function endGroup(ctx: Context, groupFile: string): void {
  const { group } = recordedRun(groupFile);
  const cleanup = { ...ctx, budget: (ms: number) => ms };
  if (group === undefined || !groupAlive(cleanup, group)) return;
  try {
    process.kill(-group.pid, "SIGKILL");
  } catch (error) {
    if (errnoCode(error) !== "ESRCH" && errnoCode(error) !== "EPERM")
      throw error;
  }
  const deadline = currentMs() + GROUP_END_TIMEOUT_MS;
  while (groupAlive(cleanup, group)) {
    if (currentMs() >= deadline)
      throw new HerdrError(
        `process group ${group.pid} still has processes ${GROUP_END_TIMEOUT_MS / 1000} seconds after SIGKILL`,
      );
    ctx.sleep(GROUP_POLL_MS);
  }
}
