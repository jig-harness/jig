/**
 * The circuit breaker's parks: `round-ceiling`, when a pull request has spent
 * its round ceiling or its wall-clock cap, and `divergence-stop`, when its
 * rounds raise as many review findings as they fix. Each is a framed
 * decision for a person, recorded in the drive state the way the
 * converged-CI park is, and the drive stops `HITL_PARKED` on it.
 */
import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { currentIso } from "../../../../../shared/time.ts";
import type { PendingVerdict } from "../state/pass-handoff.ts";
import {
  parkAdmissionContext,
  parkAdmissionProblem,
} from "../state/park-admission.ts";
import { resolveParkPerson } from "../state/park-person.ts";
import type { RoundFindings } from "../state/circuit-breaker.ts";
import { openStore } from "../state/store.ts";

/** The park key of a spent round ceiling or wall-clock cap. */
export const ROUND_CEILING_PARK = "round-ceiling";

/** The park key of a diverging drive. */
export const DIVERGENCE_PARK = "divergence-stop";

/** The `round-ceiling` option whose answer is a person's override. */
export const PAST_CEILING_OPTION = "past";

/** What a `round-ceiling` park states. */
export interface CeilingFacts {
  pr: string;
  /** The distinct reviewed heads the pull request has spent. */
  rounds: number;
  /** The hours since it was first driven. */
  hoursDriven: number;
  /** The round ceiling and where it comes from. */
  ceiling: number;
  ceilingSource: string;
  /** The rounds overrides already added to the ceiling. */
  raised: number;
  /** The wall-clock cap and its source, or `null` when none is set. */
  wallClock: { hours: number; source: string; raisedHours: number } | null;
  /** Which limit stopped the drive. */
  cause: "rounds" | "wall-clock";
  /** The rounds an override adds: one `--max-rounds` block. */
  block: number;
  /** The arm command for a person's override. */
  overrideCommand: string;
}

const hours = (n: number) => `${Math.round(n * 10) / 10}h`;

/** The limits a `round-ceiling` park names, in one sentence. */
export function ceilingStatement(f: CeilingFacts): string {
  const raised =
    f.raised > 0 ? `, ${f.raised} of them added by a person's override` : "";
  const wall =
    f.wallClock === null
      ? "No wall-clock cap is set (drive.max_wall_clock_hours)."
      : `The wall-clock cap is ${hours(f.wallClock.hours + f.wallClock.raisedHours)} (${f.wallClock.source}${f.wallClock.raisedHours > 0 ? `, ${hours(f.wallClock.raisedHours)} added by a person's override` : ""}).`;
  const limit = f.cause === "rounds" ? "round ceiling" : "wall-clock cap";
  return `PR #${f.pr} stopped at its ${limit}: it has spent ${f.rounds} distinct reviewed head(s) in ${hours(f.hoursDriven)} since it was first driven, against a round ceiling of ${f.ceiling} (${f.ceilingSource}${raised}). ${wall} Automatic re-arming is refused: a re-arm's grant never reaches past the ceiling, and only a person's override raises it.`;
}

/** The `round-ceiling` park's framed decision. */
export function roundCeilingDecision(f: CeilingFacts): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question: `Should PR #${f.pr} be driven past its ${f.cause === "rounds" ? "round ceiling" : "wall-clock cap"}?`,
      options: [
        {
          id: PAST_CEILING_OPTION,
          name: "Allow one more budget",
          summary: `Raise this pull request's ceiling by one round budget (${f.block} more distinct heads${f.wallClock === null ? "" : ", and the wall-clock cap by one more cap from now"}) and drive on.`,
          pay: [
            "Another round budget of passes and reviews on a drive that has not converged in the rounds it had.",
          ],
        },
        {
          id: "hand",
          name: "Finish by hand",
          summary:
            "Leave the drive parked; a person settles the open review findings, or re-scopes or closes the pull request.",
          pay: ["A person's time on the open findings."],
        },
      ],
      recommended: "hand",
      why: "A drive that spent its ceiling without converging is more often stuck on a finding it cannot settle than one round short; a person reading the open findings decides faster than another budget.",
    },
    steps: [
      ceilingStatement(f),
      `To allow one more budget, answer with that option and re-arm the drive, or arm it by hand with the override: ${f.overrideCommand}`,
    ],
    alreadyDone: `The drive stopped before another pass. ${ceilingStatement(f)}`,
  };
}

/** The round-over-round counts, as a `divergence-stop` park lists them. */
export function divergenceLines(history: readonly RoundFindings[]): string[] {
  return history.map(
    (r) =>
      `Round ${r.round} (head ${r.head.slice(0, 12)}): ${r.newFindings} new finding(s), ${r.fixedFindings} fixed, ${r.open} open.`,
  );
}

/** The `divergence-stop` park's framed decision. */
export function divergenceDecision(
  pr: string,
  history: readonly RoundFindings[],
  rounds: number,
): ParkedDecision {
  const counts = divergenceLines(history);
  return {
    schema: "parked-decision/v1",
    class: "human-decision",
    call: {
      id: "a",
      question: `How should PR #${pr}, whose last ${rounds} rounds each raised as many review findings as they fixed, proceed?`,
      options: [
        {
          id: "continue",
          name: "Continue driving",
          summary:
            "Re-arm the drive; the count of diverging rounds starts again from zero.",
          pay: [
            "More rounds that may keep raising findings as fast as they fix them.",
          ],
        },
        {
          id: "hand",
          name: "Finish by hand",
          summary:
            "Leave the drive parked; a person settles the open review findings.",
          pay: ["A person's time on the open findings."],
        },
        {
          id: "rescope",
          name: "Re-scope or close",
          summary:
            "Split the change, narrow it, or close the pull request; the findings suggest its scope keeps growing under review.",
          pay: ["Rework of the change's plan."],
        },
      ],
      recommended: "hand",
      why: "Rounds whose fixes raise as many findings as they resolve do not converge on their own; a person can tell whether the reviewer or the change is the cause.",
    },
    steps: [
      ...counts,
      "Answer with one option; to continue, answer and re-arm the drive.",
    ],
    alreadyDone: `The drive stopped before another pass after ${rounds} diverging rounds in a row, with findings still open. ${counts.join(" ")}`,
  };
}

/**
 * Record a circuit park in the drive state. A park already held under the
 * key is kept as it is, so an answer later than it still counts. False when
 * the park could not be recorded or admitted.
 */
export async function parkCircuit(
  pr: string,
  key: string,
  decision: ParkedDecision,
): Promise<boolean> {
  try {
    const store = await openStore(pr);
    if (store.read().state.parked.some((p) => p.key === key)) return true;
    const person = await resolveParkPerson(pr, key, "finding", "");
    const capacity = await parkAdmissionContext(pr, store.stateDir);
    let admitted = true;
    await store.update((state) => {
      if (state.parked.some((p) => p.key === key)) return state;
      const next = {
        ...state,
        parked: [
          ...state.parked,
          {
            key,
            kind: "finding" as const,
            reason: decision.call.question,
            class: decision.class,
            person,
            decision,
            round: state.rounds,
            at: currentIso(),
          },
        ],
      };
      const problem = parkAdmissionProblem(next, decision, capacity);
      if (problem === null) return next;
      console.error(
        `circuit breaker: the ${key} park was not admitted: ${problem}`,
      );
      admitted = false;
      return state;
    });
    return admitted;
  } catch (err) {
    console.error(
      `circuit breaker: the ${key} park was not recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Whether a person's answers to the `round-ceiling` park all choose the
 * override; a provisional decision, a disputed set, a note narrowing it or
 * another option is no override.
 */
export function answerRaisesCeiling(verdict: PendingVerdict): boolean {
  if (verdict.key !== ROUND_CEILING_PARK || verdict.provisional === true)
    return false;
  const option = verdict.decision?.call.options.find(
    (o) => o.id === PAST_CEILING_OPTION,
  );
  return (
    option !== undefined &&
    verdict.answers.length > 0 &&
    verdict.answers.every(
      (a) =>
        a.choice?.option === option.name && (a.choice.note ?? "").trim() === "",
    )
  );
}

/** Whether a person answered the `divergence-stop` park (any option but a provisional one). */
export function answerSettlesDivergence(verdict: PendingVerdict): boolean {
  return (
    verdict.key === DIVERGENCE_PARK &&
    verdict.provisional !== true &&
    verdict.answers.length > 0
  );
}
