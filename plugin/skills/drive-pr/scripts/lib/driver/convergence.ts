/** Order convergence checks so every remote wait precedes final local certification. */
import type { DriveRoundContext } from "./round-context.ts";

import {
  prepareConvergenceWorktree,
  finishConvergence,
} from "./convergence-worktree.ts";

import { settleConvergedReady } from "./convergence-ready.ts";

import {
  releaseAndReadFinalCi,
  checkFinalCiStatus,
  requiredFailureMayBeStale,
  evaluateFinalCi,
} from "./convergence-ci.ts";

export async function runConvergencePhase(
  context: DriveRoundContext,
  status: Record<string, unknown>,
): Promise<number | "continue"> {
  const prepareConvergenceWorktreeResult = await prepareConvergenceWorktree(
    status,
    context,
  );
  if (typeof prepareConvergenceWorktreeResult !== "object")
    return prepareConvergenceWorktreeResult;
  const { reviewedHead, economy } = prepareConvergenceWorktreeResult;
  {
    const stage = await settleConvergedReady(context, status);
    if (stage !== null) return stage;
  }
  const releaseAndReadFinalCiResult = await releaseAndReadFinalCi(
    context,
    reviewedHead,
  );
  if (typeof releaseAndReadFinalCiResult !== "object")
    return releaseAndReadFinalCiResult;
  const { finalStatus, finalStatusRes, finalVerdict, finalCi, finalCiSignals } =
    releaseAndReadFinalCiResult;
  const checkFinalCiStatusResult = await checkFinalCiStatus(
    finalStatus,
    reviewedHead,
    finalStatusRes,
    finalVerdict,
    finalCi,
    context,
    finalCiSignals,
  );
  if (typeof checkFinalCiStatusResult !== "object")
    return checkFinalCiStatusResult;
  const {
    finalFailingNames,
    finalFailingCheckRunNames,
    finalFailingStatusNames,
  } = checkFinalCiStatusResult;
  const requiredFailureMayBeStaleResult = await requiredFailureMayBeStale(
    context,
    finalCi,
    finalFailingNames,
    finalFailingCheckRunNames,
    finalFailingStatusNames,
  );
  if (typeof requiredFailureMayBeStaleResult !== "object")
    return requiredFailureMayBeStaleResult;
  const { staleRequiredFailure } = requiredFailureMayBeStaleResult;
  {
    const stage = await evaluateFinalCi(
      finalVerdict,
      staleRequiredFailure,
      context,
      finalCi,
      reviewedHead,
      finalCiSignals,
    );
    if (stage !== null) return stage;
  }
  return await finishConvergence(context, reviewedHead, economy);
}
