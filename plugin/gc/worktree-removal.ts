/**
 * Removing a worktree a workspace runtime manages the way M12 asks: run the
 * repository's remove hook inside it, park its unsent reflection findings,
 * and only then have the runtime remove it, so the runtime's own records of
 * it (in Orca, the workspace card, its terminals and its agents) go with the
 * checkout. When a step fails the worktree stays.
 *
 * `jig gc` collects an Orca-managed worktree through here from the installed
 * plugin, and the Orca workspace tool's `remove` (tools/orca) runs the same
 * sequence with its own seams: a server's host reached over SSH.
 */
import { main as journalMain } from "../skills/reflect/scripts/journal.ts";
import { withGitDeadline } from "../skills/reflect/scripts/lib/context.ts";
import { withoutLeakyGitEnv } from "../shared/guarded-git-spawn.ts";
import { orcaEnvelope, orcaErrorText, orcaFailure } from "../shared/orca.ts";
import { failed, ok, type Outcome } from "../shared/outcome.ts";
import {
  HOOK_TIMEOUT_MS,
  HOOKS_DIR,
  hookFailure,
  hookPath,
  superviseHook,
} from "../shared/worktree-hooks.ts";
import { currentMs } from "../shared/time.ts";

/** The longest parking a worktree's reflection findings may take: a few git calls. */
export const PARK_TIMEOUT_MS = 3 * 60_000;

/** A removal step's answer: done, or why it failed and the worktree stays. */
export type StepOutcome = Outcome<undefined>;

/**
 * Park the worktree's unsent reflection findings where the next reflection
 * in any worktree of the repository adopts them, through the reflect skill's
 * own `journal.ts park`, run as if from inside the worktree.
 *
 * It runs in this process, since a workspace tool's `--host` run has only its
 * bundle on the host, so the worktree is named the ways the journal reads it:
 * the working directory, `JIG_CONSUMER_ROOT` (which the journal prefers to
 * it), and an environment without the git variables that would route its git
 * calls to another repository. All three are restored afterwards. Every git
 * call the journal makes is cut to the time left before `deadline`. With
 * `log`, the journal's report goes there instead of standard output, which a
 * caller printing JSON keeps for its own answer.
 */
export async function parkFindings(
  worktree: string,
  deadline: number,
  log?: (line: string) => void,
): Promise<Outcome<undefined, "park-refused" | "park-failed">> {
  // A session's configuration overrides may have moved the journal its
  // findings were written to, and parking without them could succeed on an
  // empty one, so the worktree stays while any is set.
  const overridden = Object.keys(process.env).filter(
    (key) => key.startsWith("JIG__") || key === "JIG_OVERLAY",
  );
  if (overridden.length > 0)
    return failed(
      "park-refused",
      `the reflection journal of ${worktree} cannot be established while ${overridden.join(", ")} is set; remove it from a session without the override`,
    );
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const previousLog = console.log;
  if (log !== undefined)
    console.log = (...values: unknown[]) => log(values.map(String).join(" "));
  let status: number;
  try {
    const clean = withoutLeakyGitEnv();
    for (const key of Object.keys(process.env))
      if (!(key in clean)) delete process.env[key];
    process.env.JIG_CONSUMER_ROOT = worktree;
    process.chdir(worktree);
    status = await withGitDeadline(deadline, () => journalMain(["park"]));
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env))
      if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  if (status !== 0)
    return failed(
      "park-failed",
      `parking the reflection findings of ${worktree} failed (exit ${status})`,
    );
  return ok(undefined);
}

/** Where the remove hook and the park run: the seams a caller may replace. */
export interface RemovalSteps {
  /** The worktree's remove hook, or null when the repository has none. */
  hook(worktree: string): string | null;
  /** Run the hook in the worktree; fails when it fails. */
  runHook(worktree: string, hook: string): StepOutcome | Promise<StepOutcome>;
  /** Park the worktree's findings, or refuse while removing it would lose them. */
  park(worktree: string): Promise<StepOutcome>;
  /**
   * Run last, right before the runtime removes the worktree, for a caller that
   * must refuse a removal the hook's long run made unsafe (an agent started
   * meanwhile); fails to keep the worktree.
   */
  admit?(worktree: string): Promise<StepOutcome>;
}

/**
 * The steps on this machine: the hook under the supervisor, the park in this
 * process, each for its own limit or what is left before `deadline`.
 */
export function localSteps(
  deadline: number,
  log: (line: string) => void,
): RemovalSteps {
  const left = (ms: number): number =>
    Math.max(0, Math.min(ms, deadline - currentMs()));
  return {
    hook: (worktree) => hookPath(worktree, "remove"),
    runHook: (worktree, hook) => {
      const run = superviseHook(worktree, hook, left(HOOK_TIMEOUT_MS));
      for (const line of run.lines) log(line);
      const failure = hookFailure(hook, run);
      return failure === null ? ok(undefined) : failed("hook-failed", failure);
    },
    park: (worktree) =>
      parkFindings(worktree, currentMs() + left(PARK_TIMEOUT_MS), log),
  };
}

/**
 * Runs Orca's command with `args`, adding `--json` and, for a paired server,
 * `--environment`; answers its exit status and output.
 */
export type OrcaCall = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface OrcaRemoval {
  /** The worktree's path. */
  worktree: string;
  /** Orca's id of the worktree (`orca worktree list --json`). */
  id: string;
  /** Remove a checkout with uncommitted changes, which Orca otherwise refuses. */
  force: boolean;
  orca: OrcaCall;
  log: (line: string) => void;
  steps: RemovalSteps;
}

/** What a removal ran: the hook's path, when the repository has one. */
export interface Removed {
  hook: string | null;
}

/**
 * Remove an Orca-managed worktree: the remove hook, the park, then `orca
 * worktree rm`. The first step that fails is the answer, its code unchanged,
 * and the worktree stays.
 */
export async function removeThroughOrca(
  removal: OrcaRemoval,
): Promise<Outcome<Removed>> {
  const { worktree, steps } = removal;
  const hook = steps.hook(worktree);
  if (hook !== null) {
    removal.log(`… running ${HOOKS_DIR}/remove`);
    const ran = await steps.runHook(worktree, hook);
    if (!ran.ok) return ran;
  }
  const parked = await steps.park(worktree);
  if (!parked.ok) return parked;
  const admitted = (await steps.admit?.(worktree)) ?? ok(undefined);
  if (!admitted.ok) return admitted;
  const what = "orca worktree rm";
  const done = await removal.orca([
    "worktree",
    "rm",
    "--worktree",
    `id:${removal.id}`,
    ...(removal.force ? ["--force"] : []),
  ]);
  // `{ ok: false }` naming no error is no answer, as a result without `ok` is.
  const parsed = orcaEnvelope(done.stdout);
  const envelope =
    parsed?.ok === false && parsed.code === null && parsed.message === null
      ? null
      : parsed;
  if (envelope?.ok === false)
    return failed(
      "orca-refused",
      `${what}: ${orcaErrorText(envelope)}${removal.force ? "" : " (uncommitted changes: commit them, or pass --force to discard them)"}`,
    );
  if (done.code !== 0)
    return failed("orca-failed", `${what} failed ${orcaFailure(done)}`);
  if (envelope === null)
    return failed(
      "orca-unreadable",
      `${what}: unreadable output ${orcaFailure(done)}`,
    );
  removal.log(`✓ removed ${worktree}`);
  return ok({ hook });
}
