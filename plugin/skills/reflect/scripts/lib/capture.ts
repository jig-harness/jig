/**
 * Findings other skills capture themselves, through the same journal an
 * agent notes into. Each takes an id derived from its fact, so a skill that
 * runs again for the same change records it once.
 */
import { journalPath } from "./context.ts";
import { buildFinding, noteFinding } from "./journal.ts";
import { reflectionSettings } from "./settings.ts";

/**
 * A pull request that took more review rounds than the threshold: the round
 * count, captured at convergence while it is exact. `reflect` names the gap
 * it points at and revises the finding's class and target to it. Returns the
 * finding's id, or null when reflection is off.
 */
export function noteReviewRounds(options: {
  pullRequest: number;
  rounds: number;
  threshold: number;
  skill: string;
}): { id: string; noted: boolean } | null {
  const settings = reflectionSettings();
  if (!settings.on) return null;
  const { pullRequest, rounds, threshold, skill } = options;
  const finding = buildFinding(
    {
      kind: "error",
      severity: rounds > threshold * 2 ? "high" : "medium",
      class: "review-took-many-rounds",
      target: { scope: "repository", name: "review loop" },
      title: `Pull request #${pullRequest} took ${rounds} review rounds to converge`,
      description: `The review needed ${rounds} rounds, past the threshold of ${threshold}. Rounds that keep producing findings usually mean the scaffolding under-served the change: an instruction that did not land, a rule the reviewer had to teach more than once, a convention that should be mechanised, or a reviewer configuration that let a known class through.`,
      suggested_fix:
        "When reflecting, name the gap the repeated findings point at, then revise this finding's class, target and fix to it.",
      change: { pull_request: pullRequest },
    },
    {
      scriptDir: import.meta.dir,
      skill,
      // The count is part of the fact: a later long review of the same pull
      // request is a new measurement, a retry of this one is not.
      fact: [
        "pull-request",
        String(pullRequest),
        "review-rounds",
        String(rounds),
      ],
    },
  );
  return {
    id: finding.id,
    noted: noteFinding(journalPath(settings.journal), finding),
  };
}
export { reflectionSwitch } from "./settings.ts";
