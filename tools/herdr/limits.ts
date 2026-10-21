/**
 * How long each command of the workspace tool may run, summed from the
 * limits of its own phases, so a deadline set around the tool (an SSH
 * session, the launcher's budget) never ends a run the tool itself allows.
 *
 * `open` may wait for the plugin event to take the create hook, run the hook,
 * wait for the agent to settle, wait for another launch's kickoff claim and
 * send the prompt; `remove` runs the remove hook. The git and Herdr calls
 * between those phases each have `COMMAND_TIMEOUT_MS`, and
 * `COMMAND_ALLOWANCE` of them are allowed for.
 */
import { CLAIM_WAIT_MS, PROMPT_TIMEOUT_MS } from "./kickoff.ts";
import { settleLimitMs } from "./herdr.ts";
import { HOOK_TIMEOUT_MS, PLUGIN_GRACE_MS } from "./lifecycle.ts";
import { COMMAND_TIMEOUT_MS } from "./runner.ts";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./spawn.ts";

/** The calls outside the bounded phases: git fetches and Herdr requests. */
const COMMAND_ALLOWANCE = 5;

export function openLimitMs(waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS): number {
  return (
    PLUGIN_GRACE_MS +
    HOOK_TIMEOUT_MS +
    settleLimitMs(waitTimeoutMs) +
    CLAIM_WAIT_MS +
    PROMPT_TIMEOUT_MS +
    COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS
  );
}

export function removeLimitMs(): number {
  return HOOK_TIMEOUT_MS + COMMAND_ALLOWANCE * COMMAND_TIMEOUT_MS;
}

/**
 * The limit for a command line of the tool (`open …`, `remove …`), with
 * `open`'s `--wait-timeout-ms` when it gives a usable one. A value the tool
 * would refuse ends the run at once, so the default stands for it.
 */
export function toolLimitMs(args: readonly string[]): number {
  if (args[0] !== "open") return removeLimitMs();
  const at = args.indexOf("--wait-timeout-ms");
  const wait = at === -1 ? Number.NaN : Number(args[at + 1]);
  return openLimitMs(
    Number.isInteger(wait) && wait > 0 ? wait : DEFAULT_WAIT_TIMEOUT_MS,
  );
}
