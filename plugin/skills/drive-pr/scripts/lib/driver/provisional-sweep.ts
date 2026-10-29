/**
 * At every round boundary, before the gate: read each standing provisional
 * decision's thread (or, for a provisional `decide` ruling, the pull
 * request's conversation) for a person's comment after it. A comment by an
 * owner, member or collaborator reverses the decision: the reversal is
 * recorded in the drive state (`reverse-decision`) and the item is parked
 * under `human-thread` with a framed decision record, so the round never
 * decides it again and the drive stops for the person once only parked
 * items remain. An unresolve alone is not a reversal and changes nothing.
 *
 * A thread that cannot be read ends the round as INDETERMINATE (exit 1):
 * a resolved thread whose reversal went unread would otherwise let the
 * drive converge over a person's comment.
 */
import { type CommentLike, readDriveState } from "./rearm.ts";
import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";
import { readReversals } from "./../provisional.ts";
import {
  standingProvisional,
  type UnattendedDecision,
} from "./../state/decisions.ts";
import { driveState } from "./paths.ts";

/** The class a reversed provisional decision is parked under. */
export const REVERSAL_CLASS = "human-thread";

/** The framed decision record a reversal is parked with (`framed-park.ts`). */
export function reversalRecord(d: UnattendedDecision, by: CommentLike): string {
  const what =
    d.class === "provisional-reply"
      ? `the provisional \`${d.outcome ?? "reply"}\` on thread \`${d.key}\``
      : `the provisional ruling \`${d.key}\``;
  return [
    "## Question",
    "",
    `Should ${what} stand, now that ${by.author || "a collaborator"} has commented on it?`,
    "",
    "## Options",
    "",
    `- **Follow the comment** Changes: the next round acts on the comment as a person's verdict, and replies with the outcome it leads to. Costs: the work the comment asks for, if it asks for a fix.`,
    `- **Keep the provisional outcome** Changes: nothing on the branch; the provisional decision stands. Costs: the comment goes unanswered unless a person answers it.`,
    "",
    "## Recommended",
    "",
    "**Follow the comment**: a person's comment on a provisional decision reverses it, and the drive never decides it again.",
    "",
    "## Class",
    "",
    REVERSAL_CLASS,
    "",
    "## Steps for a person",
    "",
    `- Answer on ${d.class === "provisional-reply" ? "the thread" : `the pull request with a line \`answer ${d.key}: …\``} (${by.url}) with what the drive should do, then re-arm the drive.`,
    "",
    "## Already done",
    "",
    `Decided ${what} at the \`${d.level}\` autonomy level (${d.record || "no record"}), and recorded the comment ${by.url} as its reversal.`,
    "",
  ].join("\n");
}

async function reverse(
  pr: string,
  d: UnattendedDecision,
  by: CommentLike,
): Promise<boolean> {
  // A person's comment makes the thread theirs: the arbiter's `escalated`
  // ruling gives way to `human-thread`, which `park` then admits.
  if (d.class === "provisional-reply") {
    const ruled = await run(tsArgv(driveState, ["rule", pr]), {
      stdin: JSON.stringify({
        key: d.key,
        verdict: "escalate",
        class: REVERSAL_CLASS,
      }),
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
    });
    if (ruled.code !== 0) return false;
  }
  // Parked first: a park that lands before a failed record is parked again,
  // whole, by the next sweep, which still finds the decision standing.
  const parked = await run(
    tsArgv(driveState, [
      "park",
      pr,
      "--key",
      d.key ?? "",
      "--kind",
      d.class === "provisional-reply" ? "thread" : "finding",
      "--class",
      REVERSAL_CLASS,
    ]),
    {
      stdin: reversalRecord(d, by),
      stdout: "ignore",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (parked.code !== 0) return false;
  const recorded = await run(tsArgv(driveState, ["reverse-decision", pr]), {
    stdin: JSON.stringify({
      key: d.key,
      by: by.author,
      url: by.url,
      at: by.at,
    }),
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  return recorded.code === 0;
}

/**
 * Record and park every reversed provisional decision; `null` to go on with
 * the round, `1` when a thread could not be read or a reversal not parked.
 */
export async function sweepProvisional(pr: string): Promise<number | null> {
  const state = await readDriveState(pr);
  if (state === null) return null;
  const standing = standingProvisional(state.decisions ?? []);
  if (standing.length === 0) return null;
  let failed = 0;
  for (const [d, by] of await readReversals(pr, standing)) {
    if (by === null) continue;
    if (by === undefined) {
      console.error(
        `provisional: could not read the comments on ${d.key}, so whether a person reversed its provisional decision is unknown.`,
      );
      failed += 1;
    } else if (await reverse(pr, d, by)) {
      console.error(
        `provisional: ${by.author} reversed the provisional decision on ${d.key} (${by.url}); parked under ${REVERSAL_CLASS} for them.`,
      );
    } else {
      console.error(
        `provisional: ${by.author} reversed the provisional decision on ${d.key} (${by.url}), but recording or parking it failed; the park class ${REVERSAL_CLASS} must be among autonomy.park_classes.`,
      );
      failed += 1;
    }
  }
  return failed === 0 ? null : 1;
}
