/**
 * How the Herdr workspace tool runs a command: one synchronous call per
 * command, with a deadline, through a seam tests replace with a fixture.
 *
 * Every git and herdr call goes through a `Runner`, so the tool can be tested
 * without either program and every call carries a deadline: a stalled socket
 * call or fetch ends the run instead of hanging it. A child that could not be
 * started or was killed reports status -1, which no real exit code equals, so
 * a check that reads one exit status as "absent" can never read a failure to
 * run as that answer.
 */
import { join } from "node:path";
import { jigHome } from "../../plugin/shared/config-layers.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../plugin/shared/guarded-git-spawn.ts";

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
}

export function localContext(log: Log = stderrLog): Context {
  return {
    run: localRunner,
    log,
    sleep: (ms) => Bun.sleepSync(ms),
    stateDir: join(jigHome(), "herdr"),
  };
}

/** The first non-empty of a result's stderr and stdout, for an error message. */
export function output(result: RunResult): string {
  return result.stderr.trim() || result.stdout.trim();
}
