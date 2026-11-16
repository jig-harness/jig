/**
 * Removing a worktree a workspace runtime manages the way M12 asks: run the
 * repository's remove hook inside it, park its unsent reflection findings,
 * and only then have the runtime remove it, so the runtime's own records of
 * it (in Orca, the workspace card, its terminals and its agents) go with the
 * checkout. When a step fails the worktree stays.
 *
 * `jig gc` collects an Orca-managed worktree through here from the installed
 * plugin, and the Orca workspace tool's `remove` (tools/orca) runs the same
 * sequence with its own seams: a server's host reached over SSH. A worktree
 * an agent tool made, which no runtime keeps records of, goes the same way
 * with `git worktree remove` as the last step.
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
  /**
   * Run after `admit`, immediately before the runtime's removal call, for a
   * caller that records the call is about to be made; fails, and the call is
   * not made, when that record cannot be written.
   */
  submit?(worktree: string): StepOutcome | Promise<StepOutcome>;
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
 * `--environment`; answers its exit status and output, and `timedOut` when
 * its deadline ended it.
 */
export type OrcaCall = (args: string[]) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}>;

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
 * Whether `removed` is the answer of `orca worktree rm` itself: success, or
 * Orca's explicit refusal. A failure of an earlier step is not, and neither
 * is a call that gave no answer (`orca-timeout`, `orca-failed`,
 * `orca-unreadable`) or said Orca is still deleting (`orca-pending`):
 * whether the worktree is gone is then unknown.
 */
export function removalAnswered(removed: Outcome<unknown>): boolean {
  return removed.ok || removed.failure.code === "orca-refused";
}

/** The failures of an `orca worktree rm` call that leave the worktree's fate unknown. */
const UNSETTLED = new Set([
  "orca-timeout",
  "orca-failed",
  "orca-unreadable",
  "orca-pending",
]);

/**
 * Whether `orca worktree rm` was called and its answer leaves the worktree's
 * fate unknown, so Orca may be deleting it still.
 */
export function removalUnsettled(removed: Outcome<unknown>): boolean {
  return !removed.ok && UNSETTLED.has(removed.failure.code);
}

/** What `orca worktree rm` answered `done`: done, or why the worktree may stay. */
function removalAnswer(
  done: Awaited<ReturnType<OrcaCall>>,
  force: boolean,
): StepOutcome {
  const what = "orca worktree rm";
  if (done.timedOut === true)
    return failed(
      "orca-timeout",
      `${what} did not answer before its deadline ${orcaFailure(done)}`,
    );
  // `{ ok: false }` naming no error, or only empty ones, is no answer, as a
  // result without `ok` is.
  const parsed = orcaEnvelope(done.stdout);
  const envelope =
    parsed?.ok === false && !parsed.code?.trim() && !parsed.message?.trim()
      ? null
      : parsed;
  // Orca stopped waiting, or answered on accepting the removal: its host
  // goes on deleting the checkout in the background.
  if (
    (envelope?.ok === false &&
      envelope.code === "worktree_removal_in_progress") ||
    (envelope?.ok === true && envelope.result.removing === true)
  )
    return failed(
      "orca-pending",
      `${what}: Orca is still deleting the checkout in the background ${orcaFailure(done)}`,
    );
  if (envelope?.ok === false)
    return failed(
      "orca-refused",
      `${what}: ${orcaErrorText(envelope)}${force ? "" : " (uncommitted changes: commit them, or pass --force to discard them)"}`,
    );
  if (done.code !== 0)
    return failed("orca-failed", `${what} failed ${orcaFailure(done)}`);
  if (envelope === null)
    return failed(
      "orca-unreadable",
      `${what}: unreadable output ${orcaFailure(done)}`,
    );
  // Only an affirmative removal is done: another successful envelope says
  // nothing of whether the checkout is gone.
  if (envelope.ok !== true || envelope.result.removed !== true)
    return failed(
      "orca-unreadable",
      `${what}: its answer does not say the worktree was removed ${orcaFailure(done)}`,
    );
  return ok(undefined);
}

/**
 * What every removal runs before the checkout goes: the remove hook, the
 * park, then the caller's last admission. The first step that fails is the
 * answer, and the worktree stays.
 */
async function prepareRemoval(removal: {
  worktree: string;
  log: (line: string) => void;
  steps: RemovalSteps;
}): Promise<Outcome<Removed>> {
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
  return ok({ hook });
}

/** A worktree no workspace runtime manages, removed with git itself. */
export interface GitRemoval {
  worktree: string;
  log: (line: string) => void;
  steps: RemovalSteps;
  /**
   * Run `git worktree remove` for the worktree, never with `--force`, so git
   * itself refuses a checkout that gained changes; answers git's failure.
   */
  remove(worktree: string): Promise<StepOutcome>;
}

/**
 * Remove a worktree no runtime keeps records of (an agent tool's): the remove
 * hook, the park, then `git worktree remove`. The first step that fails is
 * the answer, its code unchanged, and the worktree stays.
 */
export async function removeWithGit(
  removal: GitRemoval,
): Promise<Outcome<Removed>> {
  const prepared = await prepareRemoval(removal);
  if (!prepared.ok) return prepared;
  const removed = await removal.remove(removal.worktree);
  if (!removed.ok) return removed;
  removal.log(`✓ removed ${removal.worktree}`);
  return prepared;
}

/**
 * Remove an Orca-managed worktree: the remove hook, the park, then `orca
 * worktree rm`. The first step that fails is the answer, its code unchanged,
 * and the worktree stays.
 */
export async function removeThroughOrca(
  removal: OrcaRemoval,
): Promise<Outcome<Removed>> {
  const prepared = await prepareRemoval(removal);
  if (!prepared.ok) return prepared;
  const { hook } = prepared.value;
  const submitted =
    (await removal.steps.submit?.(removal.worktree)) ?? ok(undefined);
  if (!submitted.ok) return submitted;
  const done = await removal.orca([
    "worktree",
    "rm",
    "--worktree",
    `id:${removal.id}`,
    ...(removal.force ? ["--force"] : []),
  ]);
  const answer = removalAnswer(done, removal.force);
  if (!answer.ok) return answer;
  removal.log(`✓ removed ${removal.worktree}`);
  return ok({ hook });
}
