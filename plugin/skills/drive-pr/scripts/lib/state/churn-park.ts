/**
 * `drive-state.ts park-churn [PR] --round R`: the structural-churn brake's
 * park (`churn.ts`). Records the framed decision on stdin under the
 * `structural-churn` class, keyed by the round, through the same validation
 * and admission as any `park`, and stamps `churnAckRound` in the same update,
 * so the evidence that tripped the brake is consumed exactly when the park
 * that answers for it is recorded: neither can land without the other.
 *
 * `--round` must name the state's current round, the one drive-status just
 * counted: a park for any other round would consume evidence nobody judged.
 */
import { isDigits } from "../../../../../shared/cli.ts";
import { fail } from "../cli.ts";
import { CHURN_CLASS, churnKey } from "./churn.ts";
import { framedPark } from "./framed-park.ts";
import type { StateStore } from "./store.ts";

export async function parkChurn(
  store: StateStore,
  a: { restoreRound: string; paths: string[] },
): Promise<number> {
  if (!isDigits(a.restoreRound))
    fail(2, "park-churn requires --round R, the round drive-status counted");
  const round = Number.parseInt(a.restoreRound, 10);
  const current = store.read().state.rounds;
  if (round < 1 || round !== current)
    fail(
      2,
      `park-churn: --round ${round} is not the current round (${current}); the brake parks only the round it judged`,
    );
  return framedPark(
    store,
    {
      key: churnKey(round),
      kind: "finding",
      parkClass: CHURN_CLASS,
      reason: "",
      paths: a.paths,
    },
    (s) => {
      if (s.rounds !== round)
        fail(
          2,
          `park-churn: the round moved to ${s.rounds} before round ${round}'s park was recorded`,
        );
      const { churnEvidenceLost: _cleared, ...rest } = s;
      return { ...rest, churnAckRound: round };
    },
  );
}
