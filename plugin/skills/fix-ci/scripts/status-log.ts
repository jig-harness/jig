/**
 * The failed log of a commit status, through the repository's
 * `ci.log_command`: a CI service that reports as a commit status (Jenkins
 * through its GitHub Branch Source plugin, for one) keeps its logs on its own
 * server, which only the repository knows how to reach.
 *
 * The command runs from the repository root through the platform shell. It
 * reads one JSON object, `{"context": …, "target_url": …}`, on stdin and
 * prints the failed log on stdout; it exits 3, with the reason on stderr,
 * when the log is gone (the build was deleted or its log rotated away). Any
 * other exit, and a run past the deadline, is a failure to read.
 */

import type { FailingStatus } from "../../../shared/ci-status.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { failed, type Outcome, ok } from "../../../shared/outcome.ts";
import { readTimeoutEnv, run } from "../../../shared/proc.ts";

/** The exit by which `ci.log_command` says the log no longer exists. */
export const LOG_GONE_EXIT = 3;

/** Seconds one run of `ci.log_command` may take, unless the environment says otherwise. */
export const DEFAULT_LOG_COMMAND_SECONDS = 300;

/** The variable that overrides that deadline. */
export const LOG_COMMAND_TIMEOUT_ENV = "FIX_CI_LOG_COMMAND_TIMEOUT";

/** What the command answered for one status: its log, or why it has none. */
export type StatusLog =
  | { kind: "log"; text: string }
  | { kind: "gone"; reason: string };

/** The deadline of one run, or a failure naming the variable that is unusable. */
export function logCommandSeconds(): Outcome<number, "bad-timeout"> {
  const read = readTimeoutEnv(
    LOG_COMMAND_TIMEOUT_ENV,
    DEFAULT_LOG_COMMAND_SECONDS,
  );
  return read.ok
    ? ok(read.seconds)
    : failed(
        "bad-timeout",
        `${LOG_COMMAND_TIMEOUT_ENV} must be a positive whole number of seconds no greater than 2147483, got '${read.raw}'`,
      );
}

/** Run `command` for `status` within `seconds`, from the repository root. */
export async function readStatusLog(
  command: string,
  status: FailingStatus,
  seconds: number,
  cwd: string = consumerRoot(),
): Promise<Outcome<StatusLog, "log-command-failed">> {
  const argv =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  const result = await run(argv, {
    cwd,
    stdin: JSON.stringify(status),
    timeoutSec: seconds,
    reapGroup: true,
  });
  const what = `ci.log_command for status '${status.context}'`;
  if (result.timedOut)
    return failed("log-command-failed", `${what} ran past ${seconds}s`);
  if (result.spawnFailed)
    return failed(
      "log-command-failed",
      `${what} could not start: ${result.stderr.trim()}`,
    );
  if (result.bufferExceeded)
    return failed(
      "log-command-failed",
      `${what} printed more than the capture limit`,
    );
  if (result.code === LOG_GONE_EXIT)
    return ok({
      kind: "gone",
      reason: result.stderr.trim() || "the command said the log is gone",
    });
  if (result.code !== 0)
    return failed(
      "log-command-failed",
      `${what} exited ${result.code}: ${result.stderr.trim()}`,
    );
  return ok({ kind: "log", text: result.stdout });
}
