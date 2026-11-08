/**
 * The documented pass commands: the agent process `drive.ts` starts for
 * each round, one per agent tool the drive documents. Anything else after
 * `drive.ts`'s `--` is a person's own command, run as given.
 *
 *   claude  claude -p "/jig:drive-pr --bots-only <PR>"
 *   codex   codex exec "Use the jig:drive-pr skill: /jig:drive-pr --bots-only <PR>"
 *
 * Claude Code runs a plugin skill from its slash command; Codex runs one
 * when the prompt names it, so its prompt names the skill and carries the
 * same invocation. Neither command takes a permission of its own. A pass
 * pushes, calls the forge and writes the worktree's git directory, which
 * Codex's sandboxes refuse, and nobody is there to approve, so a Codex pass
 * needs `--dangerously-bypass-approvals-and-sandbox`; a host opts in to it
 * with `drive.codex_bypass`, after checking what its account can reach, and
 * without that Codex's own configuration decides. The model each one runs
 * on is decided by `pass-model.ts`, and Claude Code's extra arguments by
 * `pass-args.ts`.
 *
 * The turn-budget hook counts Codex responses and warns, but imposes no
 * runtime turn cap. A Codex pass has no turn cap of its own: the pass deadline
 * (`DRIVE_PR_PASS_TIMEOUT`, `--pass-timeout`) bounds one that runs on.
 */
import type { AccountVendor } from "./identity.ts";

/** The agent tools the drive documents a pass command for. */
export const PASS_VENDORS: readonly AccountVendor[] = ["claude", "codex"];

/** Whether `vendor` names an agent tool with a documented pass command. */
export function isPassVendor(vendor: string): vendor is AccountVendor {
  return (PASS_VENDORS as readonly string[]).includes(vendor);
}

/** The agent tools whose pass has no turn cap of its own, so only the pass deadline bounds it. */
const UNCAPPED: ReadonlySet<AccountVendor> = new Set(["codex"]);

/** Whether a pass of `vendor` is bounded by nothing but the pass deadline. */
export function onlyDeadlineBounds(vendor: AccountVendor): boolean {
  return UNCAPPED.has(vendor);
}

/** The words Codex's command line runs without a sandbox and without asking. */
export const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

/**
 * A skill's invocation as `vendor` takes it in a prompt: Claude Code's
 * slash command as written; for Codex, the skill named, then the same
 * invocation, since Codex runs a skill the prompt names. `invocation`
 * starts with the skill's slash command (`/jig:drive-pr --bots-only 7`).
 */
export function skillPrompt(vendor: AccountVendor, invocation: string): string {
  if (vendor === "claude") return invocation;
  const skill = /^\/(\S+)/.exec(invocation)?.[1] ?? invocation;
  return `Use the ${skill} skill: ${invocation}`;
}

/**
 * The documented pass command of `vendor` for pull request `pr`, its model
 * left to `pass-model.ts`: a Codex pass with the bypass when `codexBypass`
 * says the host opted in, which is Claude Code's to ignore.
 */
export function passCommand(
  vendor: AccountVendor,
  pr: number | string,
  codexBypass = false,
): string[] {
  const prompt = skillPrompt(vendor, `/jig:drive-pr --bots-only ${pr}`);
  return vendor === "claude"
    ? ["claude", "-p", prompt]
    : ["codex", "exec", ...(codexBypass ? [CODEX_BYPASS] : []), prompt];
}
