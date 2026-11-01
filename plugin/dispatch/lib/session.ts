/**
 * What a pickup's interactive session runs: Claude Code started on
 * `/jig:do-item <key>`, with the model and effort of the item's route, and
 * a prompt that ends by asking the session to record how it ended through
 * `jig dispatch result`, under its launch record's token. The token binds
 * the session to its record; it does not guard the state directory against
 * another process of the same user.
 */
import { resolve } from "node:path";
import type { LaunchRecord, SessionResult } from "./launches.ts";

/** The skill a pickup starts. */
export const PICKUP_SKILL = "/jig:do-item";

const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const JIG = resolve(import.meta.dir, "../../jig.ts");

/** The command a session runs to record its answer. */
function resultCommand(
  record: Pick<LaunchRecord, "id" | "token">,
  result: SessionResult,
): string {
  return [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    JIG,
    "dispatch",
    "result",
    record.id,
    record.token,
    result,
  ].join(" ");
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

/** The session's command line: Claude Code with the route's model and effort, on the prompt. */
export function sessionArgv(record: LaunchRecord): string[] {
  return [
    "claude",
    ...(record.model === null ? [] : ["--model", record.model]),
    ...(record.effort === null ? [] : ["--effort", record.effort]),
    pickupPrompt(record),
  ];
}
