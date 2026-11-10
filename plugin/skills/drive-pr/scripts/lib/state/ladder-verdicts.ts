/** Per-finding decline-ladder evidence, scoped to the current review round. */
import { isVerdict } from "./ladder-verdict-model.ts";
import { fail } from "../cli.ts";
import { reviewRound } from "./review-rounds.ts";
import type { DriveState } from "./schema.ts";
import type { StateStore } from "./store.ts";

/** Record the ladder's measured round, refusing a result from a different round. */
export async function recordLadderVerdict(
  store: StateStore,
  raw: string,
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    fail(2, "record-ladder: expected JSON {key, stance, round}");
  }
  if (!isVerdict(input))
    fail(
      2,
      "record-ladder: expected one key, accepted|declined stance and a nonnegative round",
    );
  const verdict = input;
  await store.update((state) => {
    if (
      verdict.round !==
      Math.max(state.rounds, reviewRound(store, String(state.pr)))
    )
      fail(
        2,
        "record-ladder: the review round changed; run triage-ladder.ts again",
      );
    return {
      ...state,
      ladderVerdicts: [
        ...(state.ladderVerdicts ?? []).filter((v) => v.key !== verdict.key),
        verdict,
      ],
    };
  });
  return 0;
}

/** Accepted holds need an accepting ladder result for this key and round. */
export function assertLadderAccepted(state: DriveState, key: string): void {
  const verdict = state.ladderVerdicts?.find(
    (v) => v.key === key && v.round === state.rounds,
  );
  if (verdict?.stance !== "accepted")
    fail(
      2,
      `hold: no accepted decline-ladder verdict for '${key}' in round ${state.rounds}; run triage-ladder.ts --pr ${state.pr} --key '${key}' before implementing the finding`,
    );
}
