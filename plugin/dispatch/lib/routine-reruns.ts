/**
 * A follow-up of this host's whose pass ended short of done on a routine
 * question (`routine-questions.ts`) is run again once with the class's
 * standing answer, rather than handed to a person:
 *
 * 1. the outcome record says what the pass asked (`followup-outcomes.ts`):
 *    its question and, where its prompt offered the tags, the question's
 *    routine class;
 * 2. a failed outcome whose question is tagged with a routine class, or one
 *    that failed before passes tagged their questions (no class field) whose
 *    launch record is still on this host, and whose attempt was not itself a
 *    run again, owes a run again (`routineRerun`); an outcome whose question
 *    does not read owes none;
 * 3. the tick with `--apply` deletes the marker that attempt left, answered
 *    or not (`releaseRoutineMarkers`), as it does for a pass that died; its
 *    wrapper never answers it (`routineEnd`), so another host does not
 *    notify a failure this host runs again;
 * 4. a later tick finds no marker and starts the follow-up again under a
 *    record whose facts carry the recovery tag and whose prompt names the
 *    earlier question and the standing answer (`plan-followups.ts`).
 *
 * The run again counts against the pull request's recovery budget as a
 * death's does, and an attempt that is itself a run again of either kind
 * never owes another: its failure is a person's. A failure from before
 * passes tagged their questions keeps that only on its launch record, so
 * one whose record is gone (past `receipts_days`) is a person's too, and no
 * follow-up is run again more than once by a death and a routine question
 * together. Unlike a death's, a routine run again has no age limit.
 */
import type { MarkedPr } from "./types.ts";
import { stateDb } from "./state.ts";
import { stateRoot } from "../receipts.ts";
import {
  askedBy,
  type FollowupOutcome,
  outcomeOf,
} from "./followup-outcomes.ts";
import type { ReadRecord } from "./launches.ts";
import {
  ROUTINE_QUESTIONS,
  routineClassOf,
  type StandingAnswer,
} from "./routine-questions.ts";
import { isRerun } from "./session-startup.ts";
import { ownMarkers } from "./followup-waits.ts";
import { questionOf } from "./session.ts";
import type { SharedContext } from "./shared-launches.ts";

/** The run again a failed follow-up owes. */
export interface RoutineRerun {
  /** The launch record of the attempt that failed. */
  record: string;
  standing: StandingAnswer;
  /** It failed before passes tagged their questions: every class's standing answer is given. */
  legacy: boolean;
}

/**
 * The run again the follow-up whose latest outcome is `outcome` owes; `null`
 * when it owes none: it did not fail, its question carried no routine tag,
 * or the attempt was itself a run again.
 */
export function routineRerun(
  outcome: FollowupOutcome | undefined,
  launches: readonly ReadRecord[],
): RoutineRerun | null {
  if (outcome?.outcome !== "failed" || outcome.unreadable !== undefined)
    return null;
  const found = launches.find((r) => r.record.id === outcome.record);
  if (outcome.rerun === true || (found !== undefined && isRerun(found.record)))
    return null;
  // A pass that recorded a wait for a rate limit asked nothing: `followup-waits.ts` owns it.
  if (found?.result === "waits") return null;
  const question =
    outcome.question ?? (found === undefined ? null : questionOf(found.state));
  const routine =
    outcome.routine !== undefined
      ? outcome.routine
      : found?.record.routineTags === true
        ? routineClassOf(question)
        : undefined;
  if (routine === null) return null;
  // A failure from before passes tagged their questions keeps no word of whether it was itself a run again unless its row was given that evidence (`keepAsked`) before the marker went; otherwise only its launch record says, so without one it is a person's.
  if (
    routine === undefined &&
    found === undefined &&
    outcome.rerun === undefined
  )
    return null;
  return {
    record: outcome.record,
    standing: {
      question,
      classes:
        routine === undefined ? ROUTINE_QUESTIONS.map((q) => q.id) : [routine],
    },
    legacy: routine === undefined,
  };
}

/** Whether an ended follow-up record owes a routine run again, so its marker is released rather than answered. */
export function routineEnd(r: ReadRecord): boolean {
  const outcome = r.record.action === "followup" ? outcomeOf(r) : null;
  if (outcome !== "failed" || r.record.pr === null) return false;
  return (
    routineRerun(
      {
        repo: r.record.repo,
        pr: r.record.pr,
        record: r.record.id,
        outcome,
        at: "",
        created: r.record.createdAt,
        ...askedBy(r),
      },
      [r],
    ) !== null
  );
}

/**
 * Write what the launch record `found` asked into its outcome row, so the
 * run again it owes survives the record's expiry; `false` when no row
 * of that record exists.
 */
function keepAsked(repo: string, pr: number, found: ReadRecord): boolean {
  const result = stateDb(stateRoot())
    .query(
      "UPDATE followup_outcomes SET asked = ? WHERE repo = ? AND pr = ? AND record = ?",
    )
    .run(
      JSON.stringify({ record: found.record.id, ...askedBy(found) }),
      repo,
      pr,
      found.record.id,
    );
  return result.changes > 0;
}

/**
 * A failure from before passes tagged their questions: persist what its
 * launch record says before the marker goes, so a record pruned later does
 * not turn it into a first follow-up. Why that could not be done, else `null`.
 */
function keptBeforeRelease(
  repo: string,
  pr: number,
  owed: RoutineRerun,
  outcomes: ReadonlyMap<number, FollowupOutcome>,
  records: readonly ReadRecord[],
): string | null {
  if (!owed.legacy || outcomes.get(pr)?.rerun !== undefined) return null;
  const found = records.find((r) => r.record.id === owed.record);
  return found !== undefined && keepAsked(repo, pr, found)
    ? null
    : `PR #${pr}: the recovery owed to the follow-up that stopped on a routine question could not be kept before its marker is released; the next tick tries again.`;
}

/**
 * With `--apply`: delete the marker each follow-up that owes a routine run
 * again left on its merged pull request, so a later tick starts it again;
 * only on the pull requests in `scope` when one is given. Returns why a
 * marker could not be deleted, which the next tick deletes.
 */
export async function releaseRoutineMarkers(
  ctx: Pick<SharedContext, "records" | "host" | "slug">,
  merged: readonly MarkedPr[],
  records: readonly ReadRecord[],
  outcomes: ReadonlyMap<number, FollowupOutcome>,
  scope?: ReadonlySet<number>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const pr of merged) {
    if (scope !== undefined && !scope.has(pr.number)) continue;
    const owed = routineRerun(outcomes.get(pr.number), records);
    if (owed === null) continue;
    const kept = keptBeforeRelease(
      ctx.slug,
      pr.number,
      owed,
      outcomes,
      records,
    );
    if (kept !== null) {
      failures.push(kept);
      continue;
    }
    for (const id of ownMarkers(pr, ctx.host, owed.record)) {
      const released = await ctx.records.release(
        { repo: ctx.slug, pr: pr.number },
        id,
      );
      if (!released.ok && released.failure.code !== "not-found")
        failures.push(
          `PR #${pr.number}: the marker ${id} of the follow-up that stopped on a routine question could not be released: ${released.failure.reason}`,
        );
    }
  }
  return failures;
}
