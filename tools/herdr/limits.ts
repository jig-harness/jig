/**
 * How long each command of the workspace tool may run. The tool holds itself
 * to these limits (`withLimit` in runner.ts): every git and Herdr call, hook
 * run, pause and parking of the reflection journal (each of its git calls
 * included) is cut to the time left, so a run ends at its limit whatever
 * its steps add up to. A deadline set around the tool (an SSH session, the
 * launcher's budget) is the limit plus `TRANSPORT_MS`, and so never ends a
 * run the tool itself allows.
 *
 * The limits are sized from the tool's own phases so an ordinary slow run
 * fits. `open` may wait for the plugin event to take the create hook, wait
 * out another run of it and then run it itself, wait for the agent to
 * settle, wait for another launch's kickoff claim and send the prompt;
 * `remove` runs the remove hook and parks the reflection journal. The git and
 * Herdr calls between those phases are allowed for as `COMMAND_ALLOWANCE`
 * calls of `COMMAND_TIMEOUT_MS`.
 */
import { CLAIM_WAIT_MS, PROMPT_TIMEOUT_MS } from "./kickoff.ts";
import { settleLimitMs } from "./herdr.ts";
import {
  HOOK_TIMEOUT_MS,
  PARK_TIMEOUT_MS,
  PLUGIN_GRACE_MS,
} from "./lifecycle.ts";
import { parseOpen, parseRemove, USAGE, UsageError } from "./options.ts";
import { COMMAND_TIMEOUT_MS } from "./runner.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./spawn.ts";

/** The calls outside the bounded phases: git fetches and Herdr requests. */
const COMMAND_ALLOWANCE = 10;
/** Starting the tool, connecting to a host and copying a file, around a run. */
export const TRANSPORT_MS = 2 * 60_000;

export function openLimitMs(waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS): number {
  return (
    PLUGIN_GRACE_MS +
    2 * HOOK_TIMEOUT_MS +
    settleLimitMs(waitTimeoutMs) +
    CLAIM_WAIT_MS +
    PROMPT_TIMEOUT_MS +
    COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS
  );
}

export function removeLimitMs(): number {
  return (
    HOOK_TIMEOUT_MS + PARK_TIMEOUT_MS + COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS
  );
}

/**
 * The limit of a command line of the tool (`open …`, `remove …`), read with
 * the tool's own parser; throws `UsageError` for one the tool would refuse.
 */
export function toolLimitMs(args: readonly string[]): number {
  const [command, ...rest] = args;
  if (command === "open") return openLimitMs(parseOpen(rest).waitTimeoutMs);
  if (command === "remove") {
    parseRemove(rest);
    return removeLimitMs();
  }
  throw new UsageError(USAGE);
}
