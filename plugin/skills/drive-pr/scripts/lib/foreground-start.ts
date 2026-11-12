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
  /** The runner's published result: null when none, "unreadable" when damaged. */
  result: () =>
    | { note?: string; treeWitnessed?: boolean }
    | "unreadable"
    | null;
  /**
   * The runner's live tree with the identities it holds now, or null when
   * the process table cannot say. Called while the launcher still holds the
   * runner's child handle, so the pid cannot belong to anyone else.
   */
  captureRunnerTree: () => Promise<readonly TreeRow[] | null>;
  /** Ask the runner to end the launch: it checks before and after it spawns. */
  requestCancel: () => void;
  /** Publish a failed launch's result, unwitnessed unless cleanup was proved. */
  recordFailure: (witnessed: boolean, note: string) => void;
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
      return await abandonLaunch(runner, progress, startBudgetMs, launchedLine);
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  console.log(launchedLine);
  return 0;
}

/** The note a runner's result carries when it ended the launch on request. */
export const LAUNCH_CANCELLED_NOTE = "launch cancelled";

function outcomeOf(
  progress: RunnerProgress,
): { cancelled: boolean; witnessed: boolean } | null {
  const result = progress.result();
  if (result === null) return null;
  if (result === "unreadable") return { cancelled: true, witnessed: false };
  return {
    cancelled: result.note?.startsWith(LAUNCH_CANCELLED_NOTE) === true,
    witnessed: result.treeWitnessed === true,
  };
}

async function waitFor(until: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!until()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  return true;
}

/**
 * The budget ran out. Ask the runner to end the launch itself: it checks the
 * request before it spawns the command and again right after, so the command
 * cannot appear unsupervised on any platform, and its own result says whether
 * its tree was witnessed gone. Only a runner that does not answer is frozen,
 * its tree captured with identities, and ended from that capture; when no
 * capture can be taken the runner is resumed, not killed, because it is the
 * only anchor to the command. A launch ended without the runner's own result
 * records one, so later launches see whether it was proved clean.
 */
async function abandonLaunch(
  runner: Runner,
  progress: RunnerProgress,
  startBudgetMs: number,
  launchedLine: string,
): Promise<number> {
  const exited = () => runner.exitCode !== null || runner.signalCode !== null;
  progress.requestCancel();
  await waitFor(() => progress.settled() || exited(), CLEANUP_MS);
  const outcome = outcomeOf(progress);
  if (outcome !== null && !outcome.cancelled && progress.commandStarted()) {
    console.log(launchedLine);
    return 0;
  }
  let witnessed: boolean;
  let started = progress.commandStarted();
  if (outcome !== null) {
    witnessed = outcome.witnessed;
  } else {
    const forced = await endUnansweringRunner(runner, progress);
    witnessed = forced.witnessed;
    started = started || forced.started;
    progress.recordFailure(witnessed, LAUNCH_CANCELLED_NOTE);
  }
  if (witnessed && !started) {
    console.error(
      `foreground-wait: launch failed: the runner had not started the command within ${startBudgetMs / 1000}s`,
    );
  } else if (witnessed) {
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

/**
 * The runner did not answer. Freeze it, capture its tree with identities, end
 * it and then what was captured. With no capture the runner is resumed, not
 * killed: it is the only anchor to a command it may have started.
 */
async function endUnansweringRunner(
  runner: Runner,
  progress: RunnerProgress,
): Promise<{ witnessed: boolean; started: boolean }> {
  const pid = runner.pid;
  const exited = () => runner.exitCode !== null || runner.signalCode !== null;
  const gone = new Promise<boolean>((resolve) => {
    if (exited()) return resolve(true);
    const timer = setTimeout(() => resolve(false), CLEANUP_MS);
    runner.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const freeze = pid !== undefined && process.platform !== "win32";
  if (freeze && !exited()) runner.kill("SIGSTOP");
  const tree = pid === undefined ? null : await progress.captureRunnerTree();
  if (tree === null) {
    if (freeze && !exited()) runner.kill("SIGCONT");
    return { witnessed: false, started: false };
  }
  runner.kill("SIGKILL");
  const runnerGone = await gone;
  const ended = await progress.endCaptured(tree, pid as number);
  return {
    witnessed: runnerGone && ended !== "unconfirmed",
    started: ended !== "none",
  };
}
