/**
 * Re-arming a HITL-parked drive at the `wide` autonomy level, with parked
 * items still unanswered.
 *
 * At `attended` and `unattended` a re-arm unparks nothing until every parked
 * item is answered (`rearm.ts`). At `wide` the items nobody answered are
 * handed to the first round to be decided provisionally, where their class
 * allows it: only `escalated`, a call the review arbiter or `decide`
 * escalated with no class the human-in-the-loop registry reserves and no
 * recorded human decision behind it. One unanswered item of any other class
 * (a registry class, `human-decision`, `human-thread` from a reversal)
 * refuses the whole re-arm, and nothing is unparked.
 *
 * The level is read here, at the re-arm, so a drive parked during the day
 * and re-armed inside an off-hours window picks up the day's escalations.
 */
import { currentAutonomy } from "../../../../../shared/autonomy.ts";
import type { PendingVerdict } from "./../state/pass-handoff.ts";
import type { ParkedItem } from "./../state/schema.ts";

/** The one park class a provisional decision may take over. */
export const PROVISIONAL_PARK_CLASS = "escalated";

function levelNow(): string {
  try {
    return currentAutonomy().level;
  } catch (err) {
    console.error(
      `re-arm: the autonomy level cannot be read (${err instanceof Error ? err.message : String(err)}); unanswered items stay parked.`,
    );
    return "unreadable";
  }
}

/**
 * The unanswered items as verdicts to decide provisionally, or `null` when
 * the level is not `wide` or one item's class is a person's (each logged).
 */
export function provisionalDuties(
  unanswered: readonly ParkedItem[],
): PendingVerdict[] | null {
  if (unanswered.length === 0) return [];
  const level = levelNow();
  const reserved = unanswered.filter((p) => p.class !== PROVISIONAL_PARK_CLASS);
  if (level !== "wide" || reserved.length > 0) {
    const why =
      level !== "wide"
        ? `the autonomy level is ${level}, and only wide decides an unanswered item provisionally`
        : `${reserved.map((p) => `${p.kind} ${p.key} is class ${p.class ?? "(none recorded)"}`).join(", ")}, which only a person decides`;
    console.error(
      `re-arm: ${unanswered.length} parked item(s) unanswered (${unanswered.map((p) => `${p.kind} ${p.key}`).join(", ")}); ${why}. Nothing is unparked until every one is answered.`,
    );
    return null;
  }
  return unanswered.map((p) => ({
    kind: p.kind,
    key: p.key,
    reason: p.reason,
    answers: [],
    provisional: true,
  }));
}

/** The first round's instructions for the items it decides provisionally; `''` for none. */
export function provisionalNotice(verdicts: readonly PendingVerdict[]): string {
  const duties = verdicts.filter((v) => v.provisional === true);
  if (duties.length === 0) return "";
  return [
    "RE-ARMED TO DECIDE PROVISIONALLY: the autonomy level is wide, and these parked items had no answer and the class escalated, which a provisional decision may take. They are unparked.",
    "Before deciding each one, check again that it may be decided provisionally: read the level afresh (an off-hours window may have closed since the re-arm), and check decide's wide conditions on the item: no sensitivity flag, no stakeholder category, no persisted-data or published-contract consequence, and for a thread an arbiter ruling of escalate with the class escalated and no person's decision behind it. Where any check fails, park the item again under its class (drive-pr § 4), with its decision record.",
    "Otherwise decide it this round with a reply outcome only (rejected, wont-fix or deferred), never a fix: a thread with provisional-reply.ts --class escalated, a finding with decide's provisional ruling recorded as decide-provisional. Each stays reversible by a person's comment and is listed first in the morning report.",
    ...duties.map((v) => `- [${v.kind}] ${v.key} — parked: ${v.reason}`),
  ].join("\n");
}
