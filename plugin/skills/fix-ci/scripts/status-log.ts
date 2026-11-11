/**
 * The failed log of a commit status, through the repository's
 * `ci.log_command`: a CI service that reports as a commit status (Jenkins
 * through its GitHub Branch Source plugin, for one) keeps its logs on its own
 * server, which only the repository knows how to reach.
 *
 * It is a repository's command (`shared/repo-command.ts`): its text is read
 * from `.config/jig.yaml` as the default branch holds it, and it runs from the
 * repository root with a scrubbed environment, a deadline and at most 64 KiB
 * of output. It reads one JSON object, `{"context": …, "target_url": …}`, on
 * standard input and answers by its exit code:
 *
 * - 0: its standard output is the failed log;
 * - 3: the log is gone (the build was deleted or its log rotated away), and
 *   the first line of its standard output is the reason;
 * - any other exit, a command that cannot start, one still running past the
 *   deadline, or one writing too much output is a failure to read.
 */

import type { FailingStatus } from "../../../shared/ci-status.ts";
import { failed, type Outcome, ok } from "../../../shared/outcome.ts";
import { readTimeoutEnv } from "../../../shared/proc.ts";
import {
  defaultBranchSetting,
  oneLine,
  runRepoCommand,
} from "../../../shared/repo-command.ts";

/** The exit by which `ci.log_command` says the log no longer exists. */
export const LOG_GONE_EXIT = 3;

/** Seconds one run of `ci.log_command` may take, unless the environment says otherwise. */
export const DEFAULT_LOG_COMMAND_SECONDS = 300;

/** The variable that overrides that deadline. */
export const LOG_COMMAND_TIMEOUT_ENV = "JIG_FIX_CI_LOG_COMMAND_TIMEOUT_SEC";

const FIELD = "ci.log_command";

/** What the command answered for one status: its log, or why it has none. */
export type StatusLog =
  | { kind: "log"; text: string }
  | { kind: "gone"; reason: string };

/** The deadline of one run, or a failure naming the variable that is unusable. */
export function logCommandSeconds(): Outcome<number, "invalid-config"> {
  const read = readTimeoutEnv(
    LOG_COMMAND_TIMEOUT_ENV,
    DEFAULT_LOG_COMMAND_SECONDS,
  );
  return read.ok
    ? ok(read.seconds)
    : failed(
        "invalid-config",
        `${LOG_COMMAND_TIMEOUT_ENV} must be a whole number of seconds from 1 to 2147483, not ${JSON.stringify(read.raw)}, so ${FIELD} was not run`,
      );
}

/**
 * The command to run: the default branch's setting, `null` when it sets
 * none. When the default branch cannot be read, a working tree that sets
 * the command fails the read (the command it names is not the reviewed
 * one); one that sets none runs no command.
 */
export async function logCommandOf(
  root: string,
  workingTree: string | undefined,
): Promise<Outcome<string | null, "invalid-config" | "unreadable">> {
  const read = await defaultBranchSetting(root, "ci", "log_command");
  if (!read.ok)
    return workingTree === undefined
      ? ok(null)
      : failed(
          "unreadable",
          `${FIELD} is read from the default branch, which could not be read: ${read.failure.reason}`,
        );
  const value = read.value;
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string" || value.trim() === "")
    return failed(
      "invalid-config",
      `${FIELD} must be a shell command (nonempty text), as the default branch sets it`,
    );
  return ok(value);
}

/** Run `command` for `status` within `seconds`, from the repository root `cwd`. */
export async function readStatusLog(
  command: string,
  status: FailingStatus,
  seconds: number,
  cwd: string,
): Promise<Outcome<StatusLog, "log-command-failed">> {
  const name = `${FIELD} \`${command}\` for status '${status.context}'`;
  const result = await runRepoCommand({
    command,
    cwd,
    stdin: JSON.stringify(status),
    timeoutSec: seconds,
    name,
  });
  if (result.kind === "failed")
    return failed(
      "log-command-failed",
      /still running/.test(result.reason)
        ? `${result.reason}; ${LOG_COMMAND_TIMEOUT_ENV} sets the bound`
        : result.reason,
    );
  if (result.code === LOG_GONE_EXIT) {
    const first = oneLine(result.stdout.split("\n")[0] ?? "");
    return ok({
      kind: "gone",
      reason: first === "" ? `${name} said the log is gone` : first,
    });
  }
  if (result.code !== 0)
    return failed(
      "log-command-failed",
      `${name} failed (exit ${result.code}${result.stderrTail === "" ? "" : `: ${result.stderrTail}`})`,
    );
  return ok({ kind: "log", text: result.stdout });
}
