/**
 * What a question group's card says of each target's answer, as pure
 * functions: the tick's outcome where the line holds one, else what this
 * page's last send did, else what this browser sent before, compared with
 * the answer the card would send now, as a target's own card compares it.
 */
import type { TargetOutcome } from "./question-group-send.ts";
import type { GroupMember } from "./question-group-view.ts";

/** What the line says the tick did with a target's answer. */
function actedWords(member: GroupMember): string | null {
  const [a] = member.acted;
  if (a === undefined) return null;
  const did =
    a.outcome === "done"
      ? "carried out"
      : a.outcome === "held"
        ? "held"
        : a.outcome === "refused"
          ? "refused"
          : "the tick is carrying it out";
  return `${a.author} chose ${a.option}: ${did}${a.detail === null ? "." : ` — ${a.detail}`}`;
}

/**
 * A target's row's words about its answer. `sent` is what this browser
 * posted for it (`sent.ts`); `current` is the answer the card would send it
 * now, absent for a target left out. A send that posted only some of its
 * comments is kept as only those, so it reads as an earlier answer.
 */
export function targetWords(
  member: GroupMember,
  outcome: TargetOutcome | undefined,
  sent: { text: string } | null,
  current: string | undefined,
): { text: string; fault: boolean } | null {
  const acted = actedWords(member);
  if (acted !== null) return { text: acted, fault: false };
  if (outcome?.kind === "refused")
    return { text: `Not sent: ${outcome.reason}`, fault: true };
  if (outcome?.kind === "not attempted")
    return { text: `Not sent: ${outcome.reason}.`, fault: false };
  if (sent !== null)
    return {
      text:
        sent.text === current
          ? "Sent here; the next tick reads it."
          : "An earlier answer was sent here; the next tick reads it.",
      fault: false,
    };
  return null;
}
