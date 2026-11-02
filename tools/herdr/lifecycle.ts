/**
 * M12's worktree lifecycle in Herdr: the repository's create hook when a
 * worktree is created, and its remove hook, with the reflection journal
 * parked, before one is removed
 * (modules/M12-parallel-agent-ergonomics/mappings.md).
 *
 * A repository supplies its hooks as executables at fixed paths, read from
 * the worktree itself so each branch runs its own version, and each runs
 * under the plugin's supervisor (plugin/shared/worktree-hooks.ts):
 *
 *   .config/worktree-hooks/create   run in a new worktree, once
 *   .config/worktree-hooks/remove   run in a worktree about to be removed
 *
 * Herdr starts the create hook through the `worktree.created` plugin event,
 * in the background. An agent must not start in a worktree whose setup is
 * still running, so the hook runs under a claim in the worktree's git
 * directory: whoever takes the claim first runs it (the plugin event, or the
 * workspace tool when no plugin is installed), and the other waits for its
 * result. The claim names its owner's host and process, and the hook runs in
 * a process group of its own that the claim records, under a supervisor that
 * ends the group when the hook outlives its limit or the tool has gone, so a
 * waiter on the same host takes over a claim only once its owner and every
 * process of its hook run have ended without a result.
 *
 * Opening a branch runs that branch's hook, as it runs the branch's code
 * anyway: the hook's dependency install runs the branch's own scripts, and
 * the agent then works in it. Open only branches whose code you would run.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PARK_TIMEOUT_MS,
  parkFindings,
  WorktreeRemovalError,
} from "../../plugin/gc/worktree-removal.ts";
import { errnoCode } from "../../plugin/shared/errors.ts";
import {
  type Hook,
  HOOK_TIMEOUT_MS,
  HOOKS_DIR,
  hookFailure,
  hookPath as sharedHookPath,
  superviseHook,
  WorktreeHookError,
} from "../../plugin/shared/worktree-hooks.ts";
import { assertLinkedWorktree, findGitWorktree, samePath } from "./git.ts";
import { findHerdrWorktree, herdrCall, herdrJson } from "./herdr.ts";
import {
  localOwner,
  type Owner,
  ownerAlive,
  ownerLine,
  processAlive,
  processStart,
} from "./owner.ts";
import { budget, type Context, HerdrError, output } from "./runner.ts";

export {
  type Hook,
  HOOK_TIMEOUT_MS,
  HOOKS_DIR,
  SUPERVISOR,
} from "../../plugin/shared/worktree-hooks.ts";
export { PARK_TIMEOUT_MS } from "../../plugin/gc/worktree-removal.ts";

/** How long the tool waits for the plugin event to take the claim before running the hook itself. */
export const PLUGIN_GRACE_MS = 5_000;
const POLL_MS = 500;

/** The hook's path in the worktree, or null when the repository has none. */
export function hookPath(worktree: string, hook: Hook): string | null {
  try {
    return sharedHookPath(worktree, hook);
  } catch (error) {
    if (error instanceof WorktreeHookError) throw new HerdrError(error.message);
    throw error;
  }
}

/**
 * Run a hook in its worktree under the supervisor; throws when it fails. Its
 * output goes to the log. With `groupFile`, the hook's process group is
 * recorded there, and a failed run's group is ended before this returns, so
 * nothing of it is still running when the hook is run again. The hook gets
 * `HOOK_TIMEOUT_MS`, or what is left of the run's limit when that is less.
 */
export function runHook(
  ctx: Context,
  worktree: string,
  path: string,
  groupFile?: string,
): void {
  const run = superviseHook(
    worktree,
    path,
    budget(ctx, HOOK_TIMEOUT_MS),
    groupFile,
  );
  for (const line of run.lines) ctx.log(line);
  const failure = hookFailure(path, run);
  if (failure !== null) {
    if (groupFile !== undefined) endGroup(ctx, groupFile);
    throw new HerdrError(failure);
  }
}

/**
 * The processes a hook run recorded, by role; empty when none were. A start
 * the supervisor could not read is null, and the id alone is checked then.
 */
interface Recorded {
  pid: number;
  start: string | null;
}

function recordedRun(groupFile: string): {
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
 * Kill what is left of a failed run's process group, only while the id still
 * names that group (`groupAlive`): once it names another, the hook's group
 * has ended and the other is not this run's to kill. A group that is gone
 * answers ESRCH; on macOS one whose processes have all exited but are not yet
 * reaped answers EPERM, and has nothing left to kill either.
 * Cleanup keeps processStart's own fixed deadline after the run budget expires,
 * so an expired hook still gets its identity checked before any group signal.
 */
function endGroup(ctx: Context, groupFile: string): void {
  const { group } = recordedRun(groupFile);
  if (group === undefined || !groupAlive({ ...ctx, budget: (ms) => ms }, group))
    return;
  try {
    process.kill(-group.pid, "SIGKILL");
  } catch (error) {
    const code = errnoCode(error);
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/** The worktree's own git directory, where the create hook's claim is kept. */
function gitDir(ctx: Context, worktree: string): string {
  const result = ctx.run([
    "git",
    "-C",
    worktree,
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (result.status !== 0)
    throw new HerdrError(
      `${worktree} is not a git checkout: ${output(result)}`,
    );
  return result.stdout.trim();
}

export interface CreateState {
  claim: string;
  result: string;
}

export function createState(ctx: Context, worktree: string): CreateState {
  const dir = join(gitDir(ctx, worktree), "jig");
  mkdirSync(dir, { recursive: true });
  return {
    claim: join(dir, "worktree-create.claim"),
    result: join(dir, "worktree-create.result"),
  };
}

/** Written whole under a temporary name, so a reader sees all of it or none. */
function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function ownerPath(state: CreateState): string {
  return join(state.claim, "owner");
}

function recordOwner(ctx: Context, state: CreateState): void {
  writeWhole(ownerPath(state), ownerLine(ctx));
}

/** Take the create hook's claim; false when another process holds it. */
function claim(ctx: Context, state: CreateState): boolean {
  try {
    mkdirSync(state.claim);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
  recordOwner(ctx, state);
  return true;
}

function groupPath(state: CreateState): string {
  return join(state.claim, "hook");
}

/**
 * Whether any part of the claimed hook run is alive: the owner that runs
 * the tool, the wrapper that started the hook, or any process in the hook's
 * group. The owner can end while its hook goes on, so it alone is not enough.
 */
function runAlive(ctx: Context, state: CreateState, owner: Owner): boolean {
  if (ownerAlive(ctx, owner)) return true;
  const { wrapper, group } = recordedRun(groupPath(state));
  return (
    (wrapper !== undefined && recordedAlive(ctx, wrapper)) ||
    (group !== undefined && groupAlive(ctx, group))
  );
}

function recordedAlive(ctx: Context, run: Recorded): boolean {
  return run.start === null
    ? processAlive(run.pid)
    : ownerAlive(ctx, { pid: run.pid, start: run.start });
}

/**
 * Whether the hook's process group still has a process in it. A group's id
 * is its first process's id, which the system does not give to another
 * process while the group has one left; so when that id now names a process
 * with another start, the group that has it is a new one, and the hook's has
 * ended.
 */
function groupAlive(ctx: Context, group: Recorded): boolean {
  if (!processAlive(-group.pid)) return false;
  if (group.start === null) return true;
  const start = processStart(ctx, group.pid);
  return start === null || start === group.start;
}

/**
 * Take over a claim whose owner, on this host, is no longer running. A claim
 * with no readable owner, or one owned on another host, is never taken over.
 */
function takeOverAbandoned(ctx: Context, state: CreateState): boolean {
  let owner: string;
  try {
    owner = readFileSync(ownerPath(state), "utf8").trim();
  } catch (error) {
    // Not written yet, or the claim went away: nothing to take over.
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  const holder = localOwner(owner);
  if (holder === null || runAlive(ctx, state, holder)) return false;
  if (!takeOverFrom(ctx, state, owner)) return false;
  ctx.log(
    `⚠ the create hook's earlier run (process ${holder.pid}) ended without a result; running it again`,
  );
  return true;
}

/**
 * Take the claim over from `seen`, the owner line a waiter found ended.
 * Exactly one waiter wins: the takeover is a directory named after that
 * owner, which `mkdir` creates once. The claim may have been given back and
 * taken anew since `seen` was read, and the marker then lands in the new
 * claim, so the takeover holds only while the claim's owner is still `seen`:
 * an owner line names one process, which never owns a claim again once it
 * has ended, so any other line is a newer claim, not this one's to take. The
 * marker left there names an ended owner and stops nothing.
 */
export function takeOverFrom(
  ctx: Context,
  state: CreateState,
  seen: string,
): boolean {
  const holder = localOwner(seen);
  if (holder === null) return false;
  try {
    mkdirSync(join(state.claim, `taken-over-${holder.pid}-${holder.start}`));
  } catch (error) {
    if (errnoCode(error) === "EEXIST" || errnoCode(error) === "ENOENT")
      return false;
    throw error;
  }
  let owner: string;
  try {
    owner = readFileSync(ownerPath(state), "utf8").trim();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  if (owner !== seen.trim()) return false;
  recordOwner(ctx, state);
  return true;
}

function readResult(state: CreateState): string | null {
  try {
    return readFileSync(state.result, "utf8").trim();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * Run the create hook under the claim and record how it ended. A failed hook
 * gives the claim back, so the next open of the workspace runs it again.
 */
function runClaimed(
  ctx: Context,
  worktree: string,
  path: string,
  state: CreateState,
): void {
  rmSync(state.result, { force: true });
  try {
    runHook(ctx, worktree, path, groupPath(state));
  } catch (error) {
    writeWhole(state.result, `failed: ${(error as Error).message}\n`);
    rmSync(state.claim, { recursive: true, force: true });
    throw error;
  }
  writeWhole(state.result, "ok\n");
}

/**
 * Run the create hook for a new worktree, unless another process already
 * took it. The plugin event calls this.
 */
export function runCreateHook(ctx: Context, worktree: string): void {
  const path = hookPath(worktree, "create");
  if (path === null) return;
  const state = createState(ctx, worktree);
  if (claim(ctx, state)) runClaimed(ctx, worktree, path, state);
}

/**
 * Before an agent starts in a new worktree: make sure its create hook has
 * finished, and throw when it failed. The plugin event is given a moment to
 * take the claim; when nothing takes it (no plugin installed), the hook runs
 * here.
 */
export function awaitCreateHook(
  ctx: Context,
  worktree: string,
  graceMs = PLUGIN_GRACE_MS,
): void {
  const path = hookPath(worktree, "create");
  if (path === null) return;
  const state = createState(ctx, worktree);
  if (readResult(state) === "ok") return;
  const graceEnds = Date.now() + graceMs;
  while (!existsSync(state.claim) && Date.now() < graceEnds) ctx.sleep(POLL_MS);
  if (claim(ctx, state)) {
    ctx.log(`… running ${HOOKS_DIR}/create`);
    runClaimed(ctx, worktree, path, state);
    return;
  }
  ctx.log(`… waiting for ${HOOKS_DIR}/create`);
  const deadline = Date.now() + HOOK_TIMEOUT_MS;
  for (;;) {
    const result = readResult(state);
    if (result === "ok") return;
    if (result !== null)
      throw new HerdrError(
        `the worktree's create hook ${result}; fix ${path} and open the workspace again, which runs it again`,
      );
    if (takeOverAbandoned(ctx, state)) {
      runClaimed(ctx, worktree, path, state);
      return;
    }
    if (Date.now() >= deadline)
      throw new HerdrError(
        `the worktree's create hook did not finish within ${HOOK_TIMEOUT_MS / 60_000} minutes; if no process is still running it, remove ${state.claim} and open the workspace again, which runs it again`,
      );
    ctx.sleep(POLL_MS);
  }
}

/** The worktree path in a `worktree.created` event, from `HERDR_PLUGIN_EVENT_JSON`. */
export function createdWorktreePath(eventJson: string | undefined): string {
  if (eventJson === undefined || eventJson === "")
    throw new HerdrError(
      "HERDR_PLUGIN_EVENT_JSON is not set; run this from the Herdr plugin event",
    );
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    throw new HerdrError("HERDR_PLUGIN_EVENT_JSON is not JSON");
  }
  const path = (event as { data?: { worktree?: { path?: unknown } } } | null)
    ?.data?.worktree?.path;
  if (typeof path !== "string" || path === "")
    throw new HerdrError("the event names no worktree path");
  return path;
}

/**
 * Park the worktree's unsent reflection findings (`parkFindings`), for
 * `PARK_TIMEOUT_MS` or what is left of the run's limit when that is less.
 */
export async function parkJournal(
  ctx: Context,
  worktree: string,
): Promise<void> {
  try {
    await parkFindings(worktree, Date.now() + budget(ctx, PARK_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof WorktreeRemovalError)
      throw new HerdrError(error.message);
    throw error;
  }
}

export interface RemoveOptions {
  repo: string;
  branch: string;
  /** Remove a checkout with uncommitted changes, which git otherwise refuses. */
  force: boolean;
}

/**
 * Remove a branch's worktree the way M12 asks: run the repository's remove
 * hook inside it and park its reflection findings, on the machine that holds
 * it, and remove it only when both succeeded. Herdr's `worktree.removed`
 * event fires after the checkout is gone, too late for either.
 */
export async function removeWorkspace(
  ctx: Context,
  options: RemoveOptions,
): Promise<string> {
  const path = findGitWorktree(ctx, options.repo, options.branch);
  if (path === null)
    throw new HerdrError(
      `no worktree of ${options.repo} has ${options.branch} checked out`,
    );
  assertLinkedWorktree(ctx, path, `remove the worktree of ${options.branch}`);
  // Herdr's registry is checked against git before anything runs, as opening
  // does: a stale row may name another worktree, which removing would discard.
  const row = findHerdrWorktree(ctx, options.repo, options.branch);
  if (row !== null && !samePath(row.path, path))
    throw new HerdrError(
      `Herdr has ${options.branch} at ${row.path}, but the clone's git worktree list has it at ${path}; not removing either`,
    );
  const hook = hookPath(path, "remove");
  if (hook !== null) {
    ctx.log(`… running ${HOOKS_DIR}/remove`);
    runHook(ctx, path, hook);
  }
  await parkJournal(ctx, path);
  let workspace = row?.open_workspace_id;
  workspace ??= herdrJson<{ workspace: { workspace_id: string } }>(
    ctx,
    [
      "herdr",
      "worktree",
      "open",
      "--cwd",
      options.repo,
      "--path",
      path,
      "--no-focus",
    ],
    "herdr worktree open",
  ).workspace.workspace_id;
  const removed = herdrCall<unknown>(
    ctx,
    [
      "herdr",
      "worktree",
      "remove",
      "--workspace",
      workspace,
      ...(options.force ? ["--force"] : []),
    ],
    "herdr worktree remove",
  );
  if (removed.error)
    throw new HerdrError(
      `herdr worktree remove: ${removed.error.message}${options.force ? "" : " (uncommitted changes: commit them, or pass --force to discard them)"}`,
    );
  ctx.log(`✓ removed ${path}`);
  return path;
}
