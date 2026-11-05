/**
 * This loop's half of the review round counter: `await-round.ts` counts a
 * round when one becomes ready, and settles the rounds when the pull request
 * converges. The count lives in `/drive-pr`'s database, one record per pull
 * request shared with the drive (`drive-pr/scripts/lib/state/review-rounds.ts`),
 * reached through its state script's unleased verbs (`count-round`,
 * `open-rounds`, `settle-rounds`), spawned by path rather than imported: the
 * import direction is `/drive-pr` → this skill, and a standalone install of
 * this skill has no `/drive-pr` beside it and counts nothing.
 *
 * The record is written whether or not a driver runs: a hand-driven loop
 * counts into it as a drive does, so `current-round.ts`, the drive's ledger
 * and this loop's reflection prompt read one number.
 *
 * A verb that fails is announced and counts nothing: the round ordinal feeds
 * the decline ladder's round-indexed cutoff, which only declines findings,
 * so a missed count delays it, the fail-open direction.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDigits } from "../../../../shared/cli.ts";
import { siblingSkill } from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { run, tsArgv } from "../../../../shared/proc.ts";

const DRIVE_STATE = join(
  siblingSkill("drive-pr", join(import.meta.dirname, "..")),
  "scripts",
  "drive-state.ts",
);

/**
 * `/jig:reflect`'s capture helper, beside this skill in the plugin: absent
 * when this skill is installed on its own. Not looked up in the repository,
 * whose own `.claude/skills/reflect` may be an unrelated skill of that name.
 */
const REFLECT_CAPTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "reflect",
  "scripts",
  "lib",
  "capture.ts",
);

/** A review round verb's output, `null` when there is no `/drive-pr` or the verb failed (announced). */
async function roundVerb(args: string[]): Promise<string | null> {
  if (!existsSync(DRIVE_STATE)) return null;
  const r = await run(tsArgv(DRIVE_STATE, args), {
    stderr: "inherit",
    timeoutSec: 60,
  });
  if (r.code === 0) return r.stdout.trim();
  console.error(
    `await-round: the review round record could not be reached (drive-state.ts ${args[0]} ${r.timedOut ? "timed out" : `exited ${r.code}`}); the rounds go uncounted this time`,
  );
  return null;
}

/**
 * Count `head` as a review round of `pr`. Past `threshold` rounds since the
 * loop last converged, each newly counted round prints the
 * structural-escalation nudge: rounds spent patching one variant of the same
 * root cause at a time is the failure mode, and the round count is the one
 * robust signal a script has of it (theme detection is the agent's).
 */
export async function countRound(
  pr: string,
  head: string,
  threshold: number,
): Promise<void> {
  const out = await roundVerb(["count-round", pr, "--head", head]);
  if (out === null) return;
  let answer: unknown;
  try {
    answer = JSON.parse(out);
  } catch {
    answer = null;
  }
  if (!isRecord(answer)) {
    console.error(
      `await-round: drive-state.ts count-round printed no count (${JSON.stringify(out.slice(0, 80))})`,
    );
    return;
  }
  const { round, open, counted } = answer;
  if (counted === true && typeof open === "number" && open > threshold)
    console.error(
      `round ${round} on #${pr}: if this round's accepted fixes target the same root cause as the last round's (another race vector, another scanner depth, another heuristic), stop patching variants — propose the structural fix or defer it (SKILL.md step 3)`,
    );
}

/**
 * At convergence: past `threshold` rounds since the loop last converged, and
 * with reflection on, note the count in the reflection journal and ask for
 * `/jig:reflect`; then settle the rounds, so the next review of the pull
 * request is weighed on its own. A count the journal could not take is kept
 * open for the next convergence.
 */
export async function settleRounds(
  pr: string,
  threshold: number,
): Promise<void> {
  const raw = await roundVerb(["open-rounds", pr]);
  if (raw === null) return;
  const n = isDigits(raw) ? Number.parseInt(raw, 10) : 0;
  const settle = async (): Promise<void> => {
    await roundVerb(["settle-rounds", pr]);
  };
  if (n <= threshold || !existsSync(REFLECT_CAPTURE)) return settle();
  const capture = (await import(
    REFLECT_CAPTURE
  )) as typeof import("../../../reflect/scripts/lib/capture.ts");
  const reflection = capture.reflectionSwitch();
  if (reflection instanceof Error)
    console.error(
      `reflection settings unreadable, not asking for /jig:reflect: ${reflection.message}`,
    );
  // With reflection off there is nowhere for the lesson to go.
  if (reflection !== true) return settle();
  let where =
    "The round count is in the reflection journal; now that the rounds have\n  wound down,";
  try {
    capture.noteReviewRounds({
      pullRequest: Number(pr),
      rounds: n,
      threshold,
      skill: "resolve-review-comments",
    });
    await settle();
  } catch (error) {
    console.error(
      `could not note the round count in the reflection journal (kept for the next convergence): ${error instanceof Error ? error.message : String(error)}`,
    );
    where =
      "The round count could not be written to the reflection journal;\n  note it yourself, and now that the rounds have wound down,";
  }
  console.error(`
──────────────────────────────────────────────────────────────
  #${pr} converged after ${n} rounds (> ${threshold}).

  That many rounds usually means the scaffolding under-served
  this change, not that the reviewer was noisy. ${where}
  run /jig:reflect while the detail is still recoverable,
  and consider whether the fix belongs in an instruction file,
  a skill, a rule, or the reviewer config.
──────────────────────────────────────────────────────────────`);
}
