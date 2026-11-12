// The handoff from `foreground-wait.ts launch` to the runner it started: the
// runner's identity is recorded in the pass's process registry, and `launch`
// returns only once the runner has started the command. Until then the
// command is not in the runner's process tree, so a cancellation that captured
// the recorded runner's tree in that interval would end the runner and miss
// the command it started next, which would then run on unsupervised.
import type { spawn } from "node:child_process";
import {
  handoffProcessRegistration,
  processCompletionPath,
  processIdentityCompleted,
} from "../../../../shared/process-registry.ts";

type Runner = ReturnType<typeof spawn>;

/** How often the launcher checks whether its runner has started the command. */
const START_POLL_MS = 10;

export interface RunnerProgress {
  /** The runner has recorded the command's pid. */
  commandStarted: () => boolean;
  /** The runner has published a result, with or without starting the command. */
  settled: () => boolean;
  /**
   * The runner's live tree with the identities it holds now, or null when
   * the process table cannot say. Called while the launcher still holds the
   * runner's child handle, so the pid cannot belong to anyone else.
   */
  captureRunnerTree: () => Promise<readonly TreeRow[] | null>;
  /**
   * End what a capture holds and say what happened: `none` when it holds
   * nothing but the runner, `ended` when every process was seen gone,
   * `unconfirmed` when one was not.
   */
  endCaptured: (
    tree: readonly TreeRow[],
    runnerPid: number,
  ) => Promise<"none" | "ended" | "unconfirmed">;
}

type TreeRow = { pid: number; start: string };

/** How long ending the runner may take after the budget ran out. */
const CLEANUP_MS = 5_000;

/**
 * Record the runner's identity while the child handle still proves
 * ownership, then wait until the runner has started the command, settled
 * without it, or exited. `startBudgetMs` bounds the wait: the runner binds
 * its own identity first, and settles with a result when it cannot. Returns
 * the exit status of `launch`: 0 after printing `launchedLine`, or
 * 1 (after saying so) when the budget ran out with none of these having happened; the
 * runner is then ended here and waited for, since returning with it live would
 * leave it free to start the command after `launch` reported failure; a command
 * it started in that instant is ended with it.
 */
export async function handOffToRunner(
  runner: Runner,
  registration: { registry: string | undefined; entry: string },
  progress: RunnerProgress,
  startBudgetMs: number,
  launchedLine: string,
): Promise<number> {
  const { registry, entry } = registration;
  const exited = () => runner.exitCode !== null || runner.signalCode !== null;
  if (registry && runner.pid !== undefined) {
    const authority = processCompletionPath(registry, entry);
    const identity = { pid: runner.pid, start: "", resultFile: authority };
    await handoffProcessRegistration(
      registry,
      entry,
      runner.pid,
      () => processIdentityCompleted(identity),
      () => !exited() && !progress.settled(),
      { resultFile: authority },
    );
  }
  const deadline = Date.now() + startBudgetMs;
  while (!progress.commandStarted() && !progress.settled() && !exited()) {
    if (Date.now() >= deadline)
      return await abandonLaunch(runner, progress, startBudgetMs);
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  console.log(launchedLine);
  return 0;
}

/**
 * The budget ran out. Freeze the runner so it cannot start the command
 * while its tree is read, capture the tree with identities, end the runner,
 * then end what was captured: the command is found by the tree, never by a
 * pid file the runner may not have written yet, and never by a fresh read
 * after the runner died.
 */
async function abandonLaunch(
  runner: Runner,
  progress: RunnerProgress,
  startBudgetMs: number,
): Promise<number> {
  const pid = runner.pid;
  const gone = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CLEANUP_MS);
    runner.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (pid !== undefined && process.platform !== "win32") runner.kill("SIGSTOP");
  const tree = pid === undefined ? null : await progress.captureRunnerTree();
  runner.kill("SIGKILL");
  const runnerGone = await gone;
  const ended =
    tree !== null && pid !== undefined
      ? await progress.endCaptured(tree, pid)
      : "unconfirmed";
  if (runnerGone && ended === "none") {
    console.error(
      `foreground-wait: launch failed: the runner had not started the command within ${startBudgetMs / 1000}s`,
    );
  } else if (runnerGone && ended === "ended") {
    console.error(
      "foreground-wait: launch failed: the runner started the command as the start budget ran out; both were ended",
    );
  } else {
    console.error(
      "foreground-wait: launch failed: the runner had not started the command within the start budget, and ending it could not be confirmed; check the process table before relaunching",
    );
  }
  return 1;
}
