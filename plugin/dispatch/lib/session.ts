/**
 * What a dispatched interactive session runs: Claude Code started on
 * `/jig:do-item <key>` for a pickup, with the model and effort of the
 * item's route, or on the repository's follow-up command and the pull
 * request for a merge's follow-up. Its prompt ends by asking the session to
 * record how it ended through `jig dispatch result`, under its launch
 * record's token. The token binds the session to its record; it does not
 * guard the state directory against another process of the same user.
 */
import { resolve } from "node:path";
import { shellQuote } from "../../shared/cli.ts";
import type { LaunchRecord, SessionResult } from "./launches.ts";

/** The skill a pickup starts. */
export const PICKUP_SKILL = "/jig:do-item";

const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const JIG = resolve(import.meta.dir, "../../jig.ts");

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
  record: Pick<LaunchRecord, "id" | "token" | "item">,
): string {
  return [
    `${PICKUP_SKILL} ${record.item}`,
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
    `${record.command} ${pr}`,
    "",
    "jig dispatch started this session for the follow-up of a merged pull request; nobody is at the keyboard.",
    `It claimed the follow-up with the marker comment ${marker} on the pull request. That claim is this session's: post no marker of your own. Before each act that writes outside the pull request (an issue closed, a tag pushed), check that you still hold the claim, and stop on any nonzero exit (an earlier marker, an unreadable forge, a missing marker): ${jigCommand(["marker", "check", pr, "--comment", marker, "--repo", record.repo])}`,
    "When you stop, record how the follow-up ended, once:",
    `- every arm is settled, what you may carry out carried out and the rest reported: ${resultCommand(record, "done")}`,
    `- you stopped short of that (a question, a failure, an earlier marker): ${resultCommand(record, "failed")}`,
  ].join("\n");
}

/**
 * The session's command line: Claude Code with the vendor session id the
 * tick minted (so the quota adapters can read this session's own wall),
 * the route's model and effort, on the prompt.
 */
export function sessionArgv(record: LaunchRecord): string[] {
  const session = record.sessionId ?? null;
  return [
    "claude",
    ...(session === null ? [] : ["--session-id", session]),
    ...(record.model === null ? [] : ["--model", record.model]),
    ...(record.effort === null ? [] : ["--effort", record.effort]),
    record.action === "followup"
      ? followupPrompt(record)
      : pickupPrompt(record),
  ];
}
