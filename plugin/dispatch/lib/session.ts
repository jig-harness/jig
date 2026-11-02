/**
 * What a dispatched interactive session runs: the agent of the account's
 * vendor (Claude Code, Codex) started on `/jig:do-item <key>` for a
 * pickup, with the model and effort of the item's route for that agent, or
 * on the repository's follow-up command and the pull request for a merge's
 * follow-up. Codex runs a skill the prompt names, so its prompt names the
 * skill before the same invocation (`skillPrompt`). The prompt ends by
 * asking the session to record how it ended through `jig dispatch result`,
 * under its launch record's token; it names no agent. The token binds the
 * session to its record; it does not guard the state directory against
 * another process of the same user.
 */
import { resolve } from "node:path";
import { shellQuote } from "../../shared/cli.ts";
import type { AccountVendor } from "../../skills/drive-pr/scripts/lib/identity.ts";
import { skillPrompt } from "../../skills/drive-pr/scripts/lib/pass-command.ts";
import type { LaunchRecord, SessionResult } from "./launches.ts";

/** The skill a pickup starts. */
export const PICKUP_SKILL = "/jig:do-item";

const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const JIG = resolve(import.meta.dir, "../../jig.ts");

/**
 * The vendor session id a launch on `vendor` mints, so the quota adapters
 * can read that session's own wall: Claude Code takes one
 * (`--session-id`); Codex takes none, so its session gets none, records no
 * wall and gets no nudge.
 */
export function sessionIdFor(vendor: AccountVendor): string | null {
  return vendor === "claude" ? crypto.randomUUID() : null;
}

/** `jig dispatch <args>`, under the same trusted startup as the tick. */
function jigCommand(args: string[]): string {
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    JIG,
    "dispatch",
    ...args,
  ]
    .map(shellQuote)
    .join(" ");
}

/** The command a session runs to record its answer. */
function resultCommand(
  record: Pick<LaunchRecord, "id" | "token">,
  result: SessionResult,
): string {
  return jigCommand(["result", record.id, record.token, result]);
}

/** The prompt a pickup's session starts with. */
function pickupPrompt(
  record: Pick<LaunchRecord, "id" | "token" | "item" | "vendor">,
): string {
  return [
    skillPrompt(record.vendor, `${PICKUP_SKILL} ${record.item}`),
    "",
    "jig dispatch started this session for an item assigned to the factory identity; nobody is at the keyboard.",
    "When you stop, record how the pickup ended, once:",
    `- its pull request is open and its drive armed: ${resultCommand(record, "done")}`,
    `- you stopped short of that (a refusal, a question, a failure): ${resultCommand(record, "failed")}`,
  ].join("\n");
}

/** The prompt a follow-up's session starts with. */
function followupPrompt(record: LaunchRecord): string {
  const pr = String(record.pr);
  const marker = String(record.marker);
  return [
    skillPrompt(record.vendor, `${record.command} ${pr}`),
    "",
    "jig dispatch started this session for the follow-up of a merged pull request; nobody is at the keyboard.",
    `It claimed the follow-up with the marker comment ${marker} on the pull request. That claim is this session's: post no marker of your own. Before each act that writes outside the pull request (an issue closed, a tag pushed), check that you still hold the claim, and stop on any nonzero exit (an earlier marker, an unreadable forge, a missing marker): ${jigCommand(["marker", "check", pr, "--comment", marker, "--repo", record.repo])}`,
    "When you stop, record how the follow-up ended, once:",
    `- every arm is settled, what you may carry out carried out and the rest reported: ${resultCommand(record, "done")}`,
    `- you stopped short of that (a question, a failure, an earlier marker): ${resultCommand(record, "failed")}`,
  ].join("\n");
}

/**
 * The session's command line, for the account's vendor: Claude Code with
 * the vendor session id the tick minted (so the quota adapters can read
 * this session's own wall), the route's model and effort, on the prompt;
 * Codex with the route's model (`-m`) and effort (its
 * `model_reasoning_effort` setting), on the prompt.
 */
export function sessionArgv(record: LaunchRecord): string[] {
  const prompt =
    record.action === "followup"
      ? followupPrompt(record)
      : pickupPrompt(record);
  if (record.vendor === "codex")
    return [
      "codex",
      ...(record.model === null ? [] : ["-m", record.model]),
      ...(record.effort === null
        ? []
        : ["-c", `model_reasoning_effort="${record.effort}"`]),
      prompt,
    ];
  const session = record.sessionId ?? null;
  return [
    "claude",
    ...(session === null ? [] : ["--session-id", session]),
    ...(record.model === null ? [] : ["--model", record.model]),
    ...(record.effort === null ? [] : ["--effort", record.effort]),
    prompt,
  ];
}
