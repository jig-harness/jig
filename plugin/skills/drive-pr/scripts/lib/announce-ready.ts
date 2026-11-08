/**
 * The Ready predicate (`merge-ready.ts`) as the merge-ready announcement
 * asks it, on top of its own gates: the forge's protection and review
 * requirements, read live for the announced head. The announcement posts
 * only in merge now or approve first, and words the second as "an approval
 * is still required"; anywhere else it refuses with the predicate's words.
 *
 * The repository's rules are the drive's own (`overlay.ts`), so the review
 * witness is the reviewer app and check the drive's convergence matched.
 */
import { readMergeFacts } from "./merge-facts.ts";
import { type ForgeFacts, type Lane, readiness } from "./merge-ready.ts";
import { ciHoldLabelSetting, reviewerApp } from "./overlay.ts";
import { ghCallTimeoutSeconds } from "./proc.ts";
import { REVIEWER_CHECK } from "./status/evidence.ts";

/** What the predicate says of the announced head: `rc` `0` with its lane, `4` placed elsewhere, `1` unread. */
export interface AnnounceReady {
  rc: 0 | 1 | 4;
  lane: Lane | null;
  says: string;
}

/** Ask the predicate about PR `pr` at `head`, read live from the forge. */
export async function announceReady(
  pr: string,
  head: string,
): Promise<AnnounceReady> {
  const n = Number(pr);
  let facts: ForgeFacts | undefined;
  try {
    facts = (await readMergeFacts(null, [n], ghCallTimeoutSeconds())).pulls.get(
      n,
    );
  } catch (error) {
    return {
      rc: 1,
      lane: null,
      says: `the forge's merge facts did not read: ${String(error)}`,
    };
  }
  if (facts === undefined)
    return { rc: 1, lane: null, says: "the forge's merge facts did not read" };
  const app = reviewerApp();
  const answer = readiness(
    { ...facts, slug: "", converged: true, verifiedSha: head, held: false },
    {
      reviewerApp: app === "" ? null : app,
      reviewerCheck: REVIEWER_CHECK,
      ciHoldLabel: ciHoldLabelSetting() ?? null,
    },
  );
  const ready = answer.lane === "merge-now" || answer.lane === "approve-first";
  if (ready) return { rc: 0, lane: answer.lane, says: answer.says };
  return {
    rc: answer.place === "stay" ? 1 : 4,
    lane: answer.lane,
    says: answer.says,
  };
}
