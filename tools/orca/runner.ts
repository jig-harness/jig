/**
 * How the Orca workspace tool runs commands. It reuses the Herdr tool's
 * runner (tools/herdr/runner.ts): one synchronous call per command, with a
 * deadline, through a seam tests replace with a fixture.
 *
 * Two machines take part. Orca's command-line tool runs on this machine and
 * reaches Orca here or, with `--environment`, a paired Orca server. Git and
 * the repository's worktree hooks run where the clone is: here, or on the
 * server's host over SSH. The two runners differ only in where a command
 * runs, so every step reads the same `Context` interface.
 *
 * A hook is the one step that differs in kind. On this machine it runs under
 * the Herdr tool's supervisor (tools/herdr/lifecycle.ts): the leader of a
 * process group of its own, ended with its children when it fails, outlives
 * its limit, or the tool has gone. On a server's host it runs as one SSH
 * command under the call's deadline, with nothing from Jig there to
 * supervise it: a hook that outlives the deadline, or starts a child that
 * outlives it, is left to the host (design/plan.md, Orca: what is left).
 */
import { join } from "node:path";
import { jigHome } from "../../plugin/shared/config-layers.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { HOOK_TIMEOUT_MS, runHook } from "../herdr/lifecycle.ts";
import { assertHost, SSH_OPTIONS, shellQuote } from "../herdr/remote.ts";
import {
  budget,
  COMMAND_TIMEOUT_MS,
  type Context,
  HerdrError,
  type Log,
  type RunOptions,
  type Runner,
  type RunResult,
  stderrLog,
} from "../herdr/runner.ts";

/** A workspace step that cannot go on; the message says why and what to do. */
export class OrcaError extends HerdrError {
  override name = "OrcaError";
}

/** Orca's command and, for a paired server, which one. */
export interface OrcaTarget {
  /** The command that runs Orca's command-line tool (`orca`, `orca-ide`, or a path). */
  command: string;
  /** A paired Orca server by name (`orca environment list`); Orca on this machine when absent. */
  environment?: string;
}

/**
 * Runs a worktree hook (`hook`, a path in `worktree`) through `ctx`, with the
 * hook's output in the log; throws when it fails. `groupFile`, where the
 * runner supervises a process group, records the group so a failed run's
 * leftovers can be ended.
 */
export type HookRunner = (
  ctx: Context,
  worktree: string,
  hook: string,
  groupFile?: string,
) => void;

/** The two machines of a run, and Orca. */
export interface Workspace {
  /** Runs Orca's command-line tool, on this machine. */
  orca: Context;
  /** Runs git and the hooks where the clone is: this machine, or the host over SSH. */
  host: Context;
  /** Runs a hook through `host`: supervised on this machine, one SSH command on a server's host. */
  runHook: HookRunner;
  target: OrcaTarget;
  /** The SSH destination `host` runs on; absent when the clone is on this machine. */
  ssh?: string;
}

/**
 * Run a hook on a server's host: one command over SSH in the worktree, bounded
 * by the hook's limit, its output logged line by line. The SSH session is the
 * only hold on it (see the module comment).
 */
export const remoteHook: HookRunner = (ctx, worktree, hook) => {
  const done = ctx.run([hook], {
    cwd: worktree,
    timeoutMs: budget(ctx, HOOK_TIMEOUT_MS),
  });
  for (const stream of [done.stdout, done.stderr])
    for (const line of stream.split("\n")) if (line !== "") ctx.log(line);
  if (done.status !== 0)
    throw new OrcaError(`${hook} failed (exit ${done.status})`);
};

/** How often an open that waits for another's hook run or agent start looks again. */
export const WAIT_POLL_MS = 1_000;

/** Where the tool keeps what must outlive a worktree: kickoff receipts. */
export function orcaStateDir(): string {
  return join(jigHome(), "orca");
}

function completed(result: ReturnType<typeof spawnSync>): RunResult {
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ||
      (result.error ? `spawn error: ${result.error.message}` : ""),
  };
}

/**
 * Run on this machine with `env`: the caller's environment without the
 * variables that would point git at another repository, and untranslated
 * messages, since some of git's are matched as text.
 */
export function localRunnerWith(env: NodeJS.ProcessEnv): Runner {
  const clean = { ...withoutLeakyGitEnv(env), LC_ALL: "C", LANGUAGE: "" };
  return (argv, options) => {
    const [command, ...args] = argv;
    if (command === undefined) throw new OrcaError("empty command");
    return completed(
      spawnSync(command, args, {
        env: clean,
        timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      }),
    );
  };
}

/** The remote shell's command line for one call: its directory, then the command. */
export function remoteCommand(argv: string[], options?: RunOptions): string {
  return [
    ...(options?.cwd === undefined ? [] : [`cd ${shellQuote(options.cwd)} &&`]),
    "LC_ALL=C",
    "LANGUAGE=",
    ...argv.map(shellQuote),
  ].join(" ");
}

/**
 * Run on `host` over SSH, one session per call. The host's own login
 * environment applies, so a `git` installed where only the shell profile
 * adds it is found. The connection has SSH's own bound; the call has the
 * deadline every other call has.
 */
export function remoteRunner(
  host: string,
  spawn: typeof spawnSync = spawnSync,
): Runner {
  assertHost(host);
  return (argv, options) => {
    if (argv.length === 0) throw new OrcaError("empty command");
    return completed(
      spawn("ssh", [...SSH_OPTIONS, host, remoteCommand(argv, options)], {
        env: withoutLeakyGitEnv(),
        timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  };
}

function context(run: Runner, log: Log): Context {
  return {
    run,
    log,
    sleep: (ms) => Bun.sleepSync(ms),
    stateDir: orcaStateDir(),
  };
}

/**
 * The machines of a run: Orca's tool on this machine with `env`, and git on
 * this machine too, or on `ssh` when the clone is there.
 */
export function workspace(
  target: OrcaTarget,
  options: { env?: NodeJS.ProcessEnv; ssh?: string; log?: Log } = {},
): Workspace {
  const env = options.env ?? process.env;
  const log = options.log ?? stderrLog;
  const local = localRunnerWith(env);
  return {
    orca: context(local, log),
    host: context(
      options.ssh === undefined ? local : remoteRunner(options.ssh),
      log,
    ),
    runHook: options.ssh === undefined ? runHook : remoteHook,
    target,
    ...(options.ssh === undefined ? {} : { ssh: options.ssh }),
  };
}
