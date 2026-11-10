/** A successful process exit cannot stand in for committing the fixes it held. */
import { resolveActor } from "../state/actor.ts";
import { openStore } from "../state/store.ts";
import { passLeftovers, describeLeftovers } from "./restart.ts";
import { WORKTREE_UNCLEAN_EXIT } from "./settings.ts";
import { measureStop } from "./stop-measure.ts";
import { driverRuntime } from "./runtime.ts";

/** Stop an unfinished held batch before marking its pass complete or spending another round. */
export async function incompletePassExit(pr: string): Promise<number | null> {
  const leftovers = await passLeftovers({ fingerprint: false });
  // An unknown probe is not positive evidence of this cause. The ordinary
  // worktree/convergence gates retain responsibility for an unreadable tree.
  if (leftovers.uncommitted === null || leftovers.uncommitted === "")
    return null;
  const store = await openStore(pr);
  const { state } = store.read();
  const actor = await resolveActor();
  const held = state.held.filter(
    (item) =>
      item.round === state.rounds &&
      item.actor === actor &&
      item.verifiedSha === undefined,
  );
  if (held.length === 0) return null;
  console.error(
    `WORKTREE_UNCLEAN: pass exited 0 before committing held fixes on PR #${pr}; this tree still has uncommitted work and ${held.length} unverified hold(s) from the current round: ${held.map((item) => item.key).join(", ")}.`,
  );
  for (const line of describeLeftovers(leftovers)) console.error(`  ${line}`);
  console.error(
    "The pass ended before its promised fixes shipped. Validate and commit the work, push through finish-round, then re-arm in this tree; background task notifications cannot resume a headless pass.",
  );
  driverRuntime.stopLeftWork = await measureStop();
  return WORKTREE_UNCLEAN_EXIT;
}
