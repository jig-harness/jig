/**
 * The documented pass commands: the agent process `drive.ts` starts for
 * each round, one per agent tool the drive documents. Anything else after
 * `drive.ts`'s `--` is a person's own command, run as given.
 *
 *   claude  claude -p "/jig:drive-pr --bots-only <PR> <role>"
 *   codex   codex exec "Use the jig:drive-pr skill: /jig:drive-pr --bots-only <PR> <role>"
 *
 * Claude Code runs a plugin skill from its slash command; Codex runs one
 * when the prompt names it, so its prompt names the skill and carries the
 * same invocation. The invocation alone is the words a person or the
 * dispatcher uses to arm a drive, so each prompt goes on to state the pass
 * role (`passRole`): an agent that settles its role from the first words it
 * reads takes the right one. `$DRIVE_PR_TARGET` stays the discriminator the
 * skill routes on. Neither command takes a permission of its own. A pass
 * pushes, calls the forge and writes the worktree's git directory, which
 * Codex's sandboxes refuse, and nobody is there to approve, so a Codex pass
 * needs `--dangerously-bypass-approvals-and-sandbox`; a host opts in to it
 * with `drive.codex_bypass`, after checking what its account can reach, and
 * without that Codex's own configuration decides. The model each one runs
 * on is decided by `pass-model.ts`, and each one's extra arguments
 * (`drive.pass_args` for Claude Code, `drive.codex_pass_args` for Codex) by
 * `pass-args.ts`.
 *
 * The turn-budget hook counts Codex responses and warns, but imposes no
 * runtime turn cap. A Codex pass has no turn cap of its own: the pass deadline
 * (`DRIVE_PR_PASS_TIMEOUT`, `--pass-timeout`) bounds one that runs on.
 */
import {
  harnessFor,
  harnessNamed,
  harnesses,
  isHarnessName,
} from "../../../../shared/agent-harness/index.ts";
import type { HarnessName } from "../../../../shared/agent-harness/index.ts";

/** The agent tools the drive documents a pass command for: every registered harness. */
export const PASS_VENDORS: readonly HarnessName[] = harnesses().map(
  (h) => h.name,
);

/** Whether `vendor` names an agent tool with a documented pass command. */
export function isPassVendor(vendor: string): vendor is HarnessName {
  return isHarnessName(vendor);
}

/** Whether a pass of `vendor` is bounded by nothing but the pass deadline: its harness has no turn cap of its own. */
export function onlyDeadlineBounds(vendor: HarnessName): boolean {
  return harnessNamed(vendor)?.capabilities.turnCap === false;
}

/**
 * The setting a headless pass runs under so that it starts no background
 * task: a pass has no next turn to receive one's result, so a task still
 * running when its turn ends is lost with it. Claude Code removes its
 * background tool parameters and auto-backgrounding under this variable;
 * Codex does not read it, so a Codex pass's prompt carries the rule alone.
 */
export const NO_BACKGROUND_TASKS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

/** The words Codex's command line runs without a sandbox and without asking. */
export { CODEX_BYPASS } from "../../../../shared/agent-harness/codex.ts";

/**
 * A skill's invocation as `vendor` takes it in a prompt: Claude Code's
 * slash command as written; for Codex, the skill named, then the same
 * invocation, since Codex runs a skill the prompt names. `invocation`
 * starts with the skill's slash command (`/jig:drive-pr --bots-only 7`).
 */
export function skillPrompt(vendor: HarnessName, invocation: string): string {
  return harnessFor(vendor).skillPrompt(invocation);
}

/**
 * What a pass is, in the words its prompt carries after the invocation: one
 * round of the drive already running on `pr`, under the driver that started
 * it, not an arm, and what finishing the round takes. One line with no
 * quote, `$` or backtick, so it survives the arm's printed command in any
 * shell unchanged.
 */
export function passRole(pr: number | string): string {
  return (
    `You are a pass: one round of the drive already running on pull request ${pr}, ` +
    "started by its driver (the process whose id DRIVE_PR_SESSION holds), " +
    "not a request to arm, watch or hand off a drive. " +
    "A drive or lock that the drives.ts listing marks self is that driver, not a competitor; " +
    "any other live drive on this pull request is one, and then you stop. " +
    "Read the skill section Driver pass, then finish the round yourself in this turn: " +
    "commit, merge the base when the round says so, push through finish-round.ts, " +
    "reply or park each finding, and end with the round report; " +
    "a round with work to do that ends without these names which it could not do and why."
  );
}

/**
 * The prompt of `vendor`'s documented pass for `pr`: the skill's invocation
 * as `vendor` takes it (`--bots-only` unless `botsOnly` is false), then the
 * pass role.
 */
export function passPrompt(
  vendor: HarnessName,
  pr: number | string,
  botsOnly = true,
): string {
  const mode = botsOnly ? " --bots-only" : "";
  return `${skillPrompt(vendor, `/jig:drive-pr${mode} ${pr}`)} ${passRole(pr)}`;
}

/**
 * The documented pass command of `vendor` for pull request `pr`, its model
 * left to `pass-model.ts`: a Codex pass with the bypass when `codexBypass`
 * says the host opted in, then `codexPassArgs` (the host's
 * `drive.codex_pass_args`) before the prompt; Claude Code's ignores both.
 */
export function passCommand(
  vendor: HarnessName,
  pr: number | string,
  codexBypass = false,
  codexPassArgs: readonly string[] = [],
): string[] {
  const harness = harnessFor(vendor);
  return harness.passCommand({
    prompt: passPrompt(vendor, pr),
    bypass: harness.capabilities.bypassOptIn && codexBypass,
    hostArgs:
      harness.capabilities.hostArgsAt === "admission" ? codexPassArgs : [],
  });
}
