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
}

/**
 * Record the runner's identity while the child handle still proves
 * ownership, then wait until the runner has started the command, settled
 * without it, or exited. `startBudgetMs` bounds the wait: the runner binds
 * its own identity first, and settles with a result when it cannot. A runner
 * that has done none of these by then is said so on stderr; `wait` reports
 * what it goes on to do.
 */
export async function handOffToRunner(
  runner: Runner,
  registration: { registry: string | undefined; entry: string },
  progress: RunnerProgress,
  startBudgetMs: number,
): Promise<void> {
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
    if (Date.now() >= deadline) {
      console.error(
        `foreground-wait: the runner had not started the command within ${startBudgetMs / 1000}s; \`wait\` reports what it does`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}
