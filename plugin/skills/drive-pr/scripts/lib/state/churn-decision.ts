/**
 * The framed decision the structural-churn brake parks with
 * (`parked-decision/v1`): which files churned in which rounds, and three ways
 * on for a person to choose from. Never a silent defer-all: the drive stops
 * and a person decides. What the next pass does for each option is stated in
 * the option itself and in drive-pr's SKILL.md § "The structural-churn park".
 */
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { CHURN_CLASS, type ChurnTrip } from "./churn.ts";

/** How many files and rounds the question names before it summarizes the rest. */
const LISTED_FILES = 5;
const LISTED_ROUNDS = 12;

function listed(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

const KIND_TEXT: Record<ChurnTrip["kind"], { what: string; why: string }> = {
  "same-file": {
    what: "kept drawing non-blocking findings and being rewritten",
    why: "These files drew only non-blocking findings round after round and each fix rewrote them again, so more rounds spend review, CI and agent time without settling them; deferring the rest lets the drive converge, and blocker and high findings are still fixed.",
  },
  oscillation: {
    what: "returned to an earlier content",
    why: "A file came back to content an earlier round had replaced, so the rounds are undoing each other rather than converging; deferring the rest stops the back-and-forth, and blocker and high findings are still fixed.",
  },
};

/** What the files of a `kind` trip did, for a question or a reason line. */
export function churnWhat(kind: ChurnTrip["kind"]): string {
  return KIND_TEXT[kind].what;
}

/**
 * The decision for `trip`, parked at `round` of pull request `pr`, the brake
 * set to `n` rounds.
 */
export function churnDecision(
  trip: ChurnTrip,
  pr: string,
  round: number,
  n: number,
): ParkedDecision {
  const text = KIND_TEXT[trip.kind];
  const files = listed(
    trip.paths.map((p) => `\`${p}\``),
    LISTED_FILES,
  );
  const rounds = listed(trip.rounds.map(String), LISTED_ROUNDS);
  return {
    schema: "parked-decision/v1",
    class: CHURN_CLASS,
    call: {
      id: "a",
      question: `Pull request #${pr} parked itself on structural churn (${trip.kind}): ${files} ${text.what} in rounds ${rounds}; how should the drive go on?`,
      options: [
        {
          id: "defer",
          name: "Ship as is and defer the rest",
          summary:
            "The next pass defers each open non-blocking finding through the deferral protocol and lets the drive converge on the pull request as it stands; blocker and high findings are still fixed.",
          pay: [
            "The deferred findings wait in the backlog instead of being fixed in this pull request.",
          ],
        },
        {
          id: "narrow",
          name: "Constrain the scope",
          summary:
            "Your note names what this pull request keeps; the next pass reverts or defers the rest and the drive goes on with the narrower change.",
          pay: [
            "A note with your answer naming what stays.",
            "Reverted work comes back in a later pull request if it is still wanted.",
          ],
        },
        {
          id: "continue",
          name: "Continue driving",
          summary: `The drive goes on as it was; the churn count restarts after round ${round}, so the brake fires again only after ${n} more rounds of the same evidence.`,
          pay: [
            "More review rounds, CI runs and agent time on the same files.",
          ],
        },
      ],
      recommended: "defer",
      why: text.why,
    },
    steps: ["Answer the parked decision, then re-arm the drive."],
    alreadyDone: `The drive counted round ${round} and parked itself before running its pass; nothing was pushed for round ${round}.`,
  };
}
