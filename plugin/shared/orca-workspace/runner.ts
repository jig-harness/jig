/**
 * How the workspace tools (Herdr's and Orca's, in tools/) and the plugin code
 * that opens a workspace run a command: one synchronous call per command,
 * with a deadline, through a seam tests replace with a fixture.
 *
 * Every git, herdr and orca call goes through a `Runner`, so the code can be
 * tested without those programs and every call carries a deadline: a stalled
 * socket call or fetch ends the run instead of hanging it. A child that could not be
 * started or was killed reports status -1, which no real exit code equals, so
 * a check that reads one exit status as "absent" can never read a failure to
 * run as that answer.
 */
import { join } from "node:path";
import { jigHome } from "../config-layers.ts";
import { spawnSync, withoutLeakyGitEnv } from "../guarded-git-spawn.ts";

/** A workspace step that cannot go on; the message says why and what to do. */
export class HerdrError extends Error {
  override name = "HerdrError";
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** The call's deadline; `COMMAND_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
  /** Working directory; the caller's when absent. */
  cwd?: string;
}

export type Runner = (argv: string[], options?: RunOptions) => RunResult;

/** The deadline for one command when its caller sets none. */
export const COMMAND_TIMEOUT_MS = 120_000;

/** The most output one command may print before it is cut off. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Lines to the operator; the default writes them to stderr. */
export type Log = (line: string) => void;

export const stderrLog: Log = (line) => console.error(line);

/**
 * Run on this machine. The environment is the caller's without the variables
 * that would point git at another repository (a hook exports them), so a
 * herdr or git call keeps `HERDR_SOCKET_PATH`, the SSH agent and the user's
 * git configuration. Messages are kept untranslated (`LC_ALL=C`), since
 * some of git's are matched as text: a translated "couldn't find remote ref"
 * would read as a transport failure.
 */
export const localRunner: Runner = (argv, options) => {
  const [command, ...args] = argv;
  if (command === undefined) throw new HerdrError("empty command");
  const result = spawnSync(command, args, {
    env: { ...withoutLeakyGitEnv(), LC_ALL: "C", LANGUAGE: "" },
    timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
    // A verbose hook must not die on Bun's 1 MiB default.
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ||
      (result.error ? `spawn error: ${result.error.message}` : ""),
  };
};

/** What every step needs: the runner, where its lines go, and how it waits. */
export interface Context {
  run: Runner;
  log: Log;
  /** A synchronous pause between attempts; tests pass one that returns at once. */
  sleep: (ms: number) => void;
  /**
   * Where the tool keeps what must outlive a worktree (session and kickoff
   * receipts, kickoff claims): `herdr/` under the Jig home, outside every
   * worktree, so removing one never takes them with it.
   */
  stateDir: string;
  /**
   * The time a step may take: `ms`, cut to what is left of the run's limit
   * (`withLimit`); throws once nothing is left. Unlimited when absent.
   */
  budget?: (ms: number) => number;
  /** The context this one was limited from (`withLimit`), which cleanup runs in once the limit has passed. */
  outer?: Context;
}

/**
 * The context for steps that must run even after the run's limit passed
 * (giving a claim back): the unlimited one, each call held to the ordinary
 * command timeout.
 */
export function cleanupContext(ctx: Context): Context {
  const outer = ctx.outer ?? ctx;
  return {
    ...outer,
    run: (argv, options) =>
      outer.run(argv, {
        ...options,
        timeoutMs: Math.min(
          options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
          COMMAND_TIMEOUT_MS,
        ),
      }),
  };
}

/** The time a step of this run may take, at most `ms` (`Context.budget`). */
export function budget(ctx: Context, ms: number): number {
  return ctx.budget === undefined ? ms : ctx.budget(ms);
}

/**
 * The context for a run that must end within `limitMs`: every call and pause
 * is cut to the time left, and the first one asked for once none is left
 * throws. Whatever its steps add up to, the run ends at the limit, so a
 * deadline set around it at that limit plus a margin never cuts it short.
 */
export function withLimit(
  ctx: Context,
  limitMs: number,
  now: () => number = Date.now,
): Context {
  const deadline = now() + limitMs;
  const left = (ms: number): number => {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new HerdrError(
        `the run reached its limit of ${Math.round(limitMs / 60_000)} minutes and stopped; run it again`,
      );
    return Math.min(budget(ctx, ms), remaining);
  };
  return {
    ...ctx,
    outer: ctx.outer ?? ctx,
    budget: left,
    run: (argv, options) =>
      ctx.run(argv, {
        ...options,
        timeoutMs: left(options?.timeoutMs ?? COMMAND_TIMEOUT_MS),
      }),
    sleep: (ms) => ctx.sleep(left(ms)),
  };
}

export function localContext(log: Log = stderrLog): Context {
  return {
    run: localRunner,
    log,
    sleep: (ms) => Bun.sleepSync(ms),
    stateDir: join(jigHome(), "herdr"),
  };
}

/** Quote one argument for the remote shell, which SSH hands the command to. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg)
    ? arg
    : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/** The first non-empty of a result's stderr and stdout, for an error message. */
export function output(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}
