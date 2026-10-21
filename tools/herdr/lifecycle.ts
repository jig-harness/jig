/**
 * M12's worktree lifecycle in Herdr: the repository's create hook when a
 * worktree is created, and its remove hook, with the reflection journal
 * parked, before one is removed
 * (modules/M12-parallel-agent-ergonomics/mappings.md).
 *
 * A repository supplies its hooks as executables at fixed paths, read from
 * the worktree itself so each branch runs its own version:
 *
 *   .config/worktree-hooks/create   run in a new worktree, once
 *   .config/worktree-hooks/remove   run in a worktree about to be removed
 *
 * Herdr starts the create hook through the `worktree.created` plugin event,
 * in the background. An agent must not start in a worktree whose setup is
 * still running, so the hook runs under a claim in the worktree's git
 * directory: whoever takes the claim first runs it (the plugin event, or the
 * workspace tool when no plugin is installed), and the other waits for its
 * result. The claim names its owner's host and process, so a waiter on the
 * same host takes over a claim whose owner ended without a result.
 *
 * Opening a branch runs that branch's hook, as it runs the branch's code
 * anyway: the hook's dependency install runs the branch's own scripts, and
 * the agent then works in it. Open only branches whose code you would run.
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { errnoCode } from "../../plugin/shared/errors.ts";
import {
  spawnSync as guardedSpawnSync,
  withoutLeakyGitEnv,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { main as journalMain } from "../../plugin/skills/reflect/scripts/journal.ts";
import { assertLinkedWorktree, findGitWorktree, samePath } from "./git.ts";
import { findHerdrWorktree, herdrCall, herdrJson } from "./herdr.ts";
import { type Context, HerdrError, output } from "./runner.ts";

export const HOOKS_DIR = ".config/worktree-hooks";
/** The longest a create or remove hook may run; a dependency install is slow. */
export const HOOK_TIMEOUT_MS = 15 * 60_000;
/** How long the tool waits for the plugin event to take the claim before running the hook itself. */
export const PLUGIN_GRACE_MS = 5_000;
const POLL_MS = 500;

export type Hook = "create" | "remove";

/** The hook's path in the worktree, or null when the repository has none. */
export function hookPath(worktree: string, hook: Hook): string | null {
  const path = join(worktree, HOOKS_DIR, hook);
  if (!existsSync(path)) return null;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new HerdrError(`${path} exists but is not executable; chmod +x it`);
  }
  return path;
}

/** Run a hook in its worktree; throws when it fails. Its output goes to the log. */
export function runHook(ctx: Context, worktree: string, path: string): void {
  const result = guardedSpawnSync(path, [], {
    cwd: worktree,
    env: withoutLeakyGitEnv(),
    timeout: HOOK_TIMEOUT_MS,
  });
  for (const stream of [result.stdout, result.stderr])
    for (const line of (stream ?? "").split("\n"))
      if (line !== "") ctx.log(line);
  if (result.status !== 0)
    throw new HerdrError(
      `${path} failed (exit ${result.status ?? "none: killed or timed out"})`,
    );
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

interface CreateState {
  claim: string;
  result: string;
}

function createState(ctx: Context, worktree: string): CreateState {
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

function recordOwner(state: CreateState): void {
  writeWhole(ownerPath(state), `${hostname()} ${process.pid}\n`);
}

/** Take the create hook's claim; false when another process holds it. */
function claim(state: CreateState): boolean {
  try {
    mkdirSync(state.claim);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
  recordOwner(state);
  return true;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/**
 * Take over a claim whose owner, on this host, is no longer running. Exactly
 * one waiter wins: the takeover is a directory named after the dead owner,
 * which `mkdir` creates once. A claim with no readable owner, or one owned on
 * another host, is never taken over.
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
  const [host, pidText] = owner.split(" ");
  const pid = Number(pidText);
  if (host !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  if (processAlive(pid)) return false;
  try {
    mkdirSync(join(state.claim, `taken-over-${pid}`));
  } catch (error) {
    if (errnoCode(error) === "EEXIST" || errnoCode(error) === "ENOENT")
      return false;
    throw error;
  }
  recordOwner(state);
  ctx.log(
    `⚠ the create hook's earlier run (process ${pid}) ended without a result; running it again`,
  );
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
    runHook(ctx, worktree, path);
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
  if (claim(state)) runClaimed(ctx, worktree, path, state);
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
  if (claim(state)) {
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
 * Park the worktree's unsent reflection findings where the next reflection
 * in any worktree of the repository adopts them, through the reflect skill's
 * own `journal.ts park`, run as if from inside the worktree.
 *
 * It runs in this process, since a `--host` run has only this bundle on the
 * host, so the worktree is named the ways the journal reads it: the working
 * directory, `JIG_CONSUMER_ROOT` (which the journal prefers to it), and an
 * environment without the git variables that would route its git calls to
 * another repository. All three are restored afterwards.
 */
export async function parkJournal(worktree: string): Promise<void> {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const clean = withoutLeakyGitEnv();
  for (const key of Object.keys(process.env))
    if (!(key in clean)) delete process.env[key];
  process.env.JIG_CONSUMER_ROOT = worktree;
  process.chdir(worktree);
  let status: number;
  try {
    status = await journalMain(["park"]);
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env))
      if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
  if (status !== 0)
    throw new HerdrError(
      `parking the reflection findings of ${worktree} failed (exit ${status})`,
    );
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
  await parkJournal(path);
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
