/**
 * A repository's worktree hooks (M12): executables at fixed paths, read from
 * the worktree itself so each branch runs its own version, and run under a
 * supervisor that ends the hook and every process it started when it fails,
 * outlives its limit, or the tool that started it has gone.
 *
 *   .config/worktree-hooks/create   run in a new worktree, once
 *   .config/worktree-hooks/remove   run in a worktree about to be removed
 *
 * The workspace tools and `jig gc` run them through here, so a hook runs the
 * same way whichever of them opens or removes the worktree.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import {
  spawnSync as guardedSpawnSync,
  withoutLeakyGitEnv,
} from "./guarded-git-spawn.ts";

export const HOOKS_DIR = ".config/worktree-hooks";
/** The longest a create or remove hook may run; a dependency install is slow. */
export const HOOK_TIMEOUT_MS = 15 * 60_000;
/** The hook output kept for the log; a dependency install is verbose. */
const HOOK_OUTPUT_BYTES = 256 * 1024 * 1024;
/** How long past a hook's limit its supervisor may take to end it. */
const SUPERVISOR_SLACK_MS = 10_000;

export type Hook = "create" | "remove";

/** A hook that cannot run: present but not executable. */
export class WorktreeHookError extends Error {
  override name = "WorktreeHookError";
}

/** The hook's path in the worktree, or null when the repository has none. */
export function hookPath(worktree: string, hook: Hook): string | null {
  const path = join(worktree, HOOKS_DIR, hook);
  if (!existsSync(path)) return null;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new WorktreeHookError(
      `${path} exists but is not executable; chmod +x it`,
    );
  }
  return path;
}

/**
 * Runs a hook under a supervisor: a `bun -e` script, since `bun` is on every
 * machine the tool runs on, including a `--host` that has only its bundle.
 * The supervisor starts the hook as the leader of a session and process group
 * of its own (`setsid`, which needs no terminal, where a shell's `set -m`
 * turns job control off without one), and writes its own process id and then
 * the group's to the file it is given, so a waiter can tell while any part of
 * the run, the hook's own children included, is still alive. It ends the
 * whole group when the hook fails, when it outlives its limit, when the
 * supervisor is signalled or fails (a record it cannot write included: its
 * cleanup is in place before the hook starts), and when the tool that started
 * it has gone: a failed run, or one whose tool was killed (by a launcher's or
 * SSH session's deadline), leaves nothing running, with a group record or
 * without one.
 * Arguments: the record file (`-` for none), the hook, its limit in
 * milliseconds and the tool's process id.
 */
export const SUPERVISOR = `
const fs = require("node:fs");
const [file, hook, limitText, ownerText] = process.argv.slice(1);
const owner = Number(ownerText);
const record = (line) => file !== "-" && fs.appendFileSync(file, line + "\\n");
let child;
const end = (code, why) => {
  if (why) console.error(why);
  if (child) try { process.kill(-child.pid, "SIGKILL"); } catch {}
  process.exit(code);
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => end(143));
const failed = (error) => end(1, "the supervisor of " + hook + " failed (" + (error?.message ?? error) + "); ended the hook");
process.on("uncaughtException", failed);
process.on("unhandledRejection", failed);
// The same start as processStart in tools/herdr/owner.ts reads, which this script
// cannot import; empty when it cannot be read, and the id alone is recorded.
const startOf = (pid) => {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return /^[0-9]+$/.test(ticks ?? "") ? boot + ":" + ticks : "";
    }
    const ps = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 10000 });
    const text = ps.stdout.toString().trim();
    return ps.exitCode === 0 ? text.replace(/\\s+/g, "_") : "";
  } catch {
    return "";
  }
};
const named = (role, pid) => { const start = startOf(pid); return role + " " + pid + (start ? " " + start : ""); };
if (file !== "-") fs.writeFileSync(file, "");
record(named("wrapper", process.pid));
try {
  child = Bun.spawn([hook], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
} catch (error) {
  console.error("could not start " + hook + ": " + error.message);
  process.exit(127);
}
try {
  record(named("group", child.pid));
} catch (error) {
  end(1, "could not record the process group of " + hook + " (" + error.message + "); ended it");
}
const deadline = Date.now() + Number(limitText);
const ownerGone = () => {
  if (process.ppid !== owner) return true;
  try { process.kill(owner, 0); return false; } catch (error) { return error.code === "ESRCH"; }
};
const watch = setInterval(() => {
  if (ownerGone()) end(143, "the workspace tool that ran " + hook + " has ended; ending the hook");
  if (Date.now() >= deadline) end(124, hook + " did not finish within its limit of " + Math.round(Number(limitText) / 1000) + " seconds; ended it");
}, 500);
await child.exited;
clearInterval(watch);
const code = child.exitCode ?? 1;
if (code !== 0) end(code);
process.exit(0);
`;

/** How a supervised hook run ended, with its output. */
export interface HookRun {
  /** The supervisor's exit status; null when it was killed. */
  status: number | null;
  /** Why the supervisor could not be run or waited for, when it could not. */
  error?: Error;
  /** The hook's output lines, standard output first. */
  lines: string[];
}

/**
 * Run `path` in `worktree` under the supervisor, for at most `limitMs`.
 * With `groupFile`, the hook's process group is recorded there, so a caller
 * can end what a failed run left behind.
 */
export function superviseHook(
  worktree: string,
  path: string,
  limitMs: number,
  groupFile?: string,
): HookRun {
  const result = guardedSpawnSync(
    process.execPath,
    [
      "-e",
      SUPERVISOR,
      groupFile ?? "-",
      path,
      String(limitMs),
      String(process.pid),
    ],
    {
      cwd: worktree,
      env: withoutLeakyGitEnv(),
      timeout: limitMs + SUPERVISOR_SLACK_MS,
      maxBuffer: HOOK_OUTPUT_BYTES,
    },
  );
  const lines: string[] = [];
  for (const stream of [result.stdout, result.stderr])
    for (const line of (stream ?? "").split("\n"))
      if (line !== "") lines.push(line);
  return {
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    lines,
  };
}

/** A failed run's message, naming the hook; null when it succeeded. */
export function hookFailure(path: string, run: HookRun): string | null {
  if (run.status === 0 && run.error === undefined) return null;
  return run.error === undefined
    ? `${path} failed (exit ${run.status ?? "none: killed"})`
    : `${path} did not complete: ${run.error.message}`;
}
