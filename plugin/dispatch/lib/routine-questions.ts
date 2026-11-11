/**
 * The routine question classes: the questions a follow-up's pass may stop
 * on that have one safe answer, which the dispatcher gives without a person.
 * The registry is fixed here, in the dispatcher's code, and lists only
 * questions with an answer that needs no person: keep and list a local
 * leftover, report a step only a person can take as owed, file the items
 * the pass drafted within its own authority.
 *
 * A pass classifies its own question: when it is only one of these classes,
 * its question line carries the class's tag right after the prefix
 * (`Question: [local-leftover] …`, `followupPrompt` in `session.ts`). The
 * dispatcher reads the tag (`routineClassOf`) and never classifies free
 * text: an untagged question, or a tag the registry does not list, is a
 * person's.
 *
 * A follow-up that stopped on a routine question is run again once with the
 * class's standing answer (`plan-followups.ts`, `routine-reruns.ts`).
 */

/** One routine question class. */
export interface RoutineQuestion {
  /** The tag a question line carries: lowercase letters, digits and dashes. */
  id: string;
  /** What the class covers, as the pass is told it. */
  covers: string;
  /** The answer the dispatcher gives a run again of a pass that stopped on it. */
  answer: string;
}

export const ROUTINE_QUESTIONS: readonly RoutineQuestion[] = [
  {
    id: "local-leftover",
    covers:
      "a local branch or worktree the follow-up may not delete without asking",
    answer:
      "keep it, list it in the result, finish every other arm and record done",
  },
  {
    id: "person-owed",
    covers:
      "who takes, authorizes or scopes a step after the merge that only a person can: a live check against a real service, a rollout to another repository, an organization's setting, an operational action, a release gate that failed",
    answer:
      "take none of it; report it as owed by a person, file one item for it in this repository's tracker when none tracks it yet (naming no other repository), finish every other arm and record done",
  },
  {
    id: "drafted-items",
    covers:
      "whether to file the follow-up items the pass drafted itself: deferred findings, carve-outs, scope cuts, a review the work skipped",
    answer:
      "file them as drafted, related to the merged work's item, list them in the result, finish every other arm and record done",
  },
];

/** The class `id` names; `undefined` when the registry lists none by it. */
export function routineQuestion(id: string): RoutineQuestion | undefined {
  return ROUTINE_QUESTIONS.find((q) => q.id === id);
}

/** A question's tag, right after the prefix: `[<id>]`. */
const TAG = /^\[([a-z0-9-]+)\]/;

/**
 * The routine class a question (the text after `Question:`) is tagged
 * with; `null` when it carries no tag, or a tag the registry does not list.
 */
export function routineClassOf(question: string | null): string | null {
  if (question === null) return null;
  const id = TAG.exec(question.trim())?.[1];
  return id !== undefined && routineQuestion(id) !== undefined ? id : null;
}

/**
 * What a routine run again acts on, kept on its launch record and its
 * action: the question the earlier pass stopped on, when it stated one, and
 * the classes whose standing answers its prompt gives (every class, for a
 * follow-up that failed before passes tagged their questions).
 */
export interface StandingAnswer {
  question: string | null;
  classes: string[];
}

/** Whether a value is a `StandingAnswer`, as a launch record reads it back: a non-empty set of registered classes. */
export function isStandingAnswer(value: unknown): value is StandingAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.question === null || typeof v.question === "string") &&
    Array.isArray(v.classes) &&
    v.classes.length > 0 &&
    new Set(v.classes).size === v.classes.length &&
    v.classes.every((c) => typeof c === "string" && routineQuestion(c))
  );
}
