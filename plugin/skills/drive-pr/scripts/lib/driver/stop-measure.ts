/**
 * What a stop whose re-drive must run where its work is measures of its tree,
 * for its stop event (`events.ts`): whether the tree holds work no push
 * carries, and which tree it is (`<actor>@<host>`). A stall and a pass
 * deadline with its restarts spent record it; the dispatcher re-drives such a
 * stop that left work, or never measured, only in that tree, and a re-arm
 * there inherits the edits as its own (`stop-pickup.ts`).
 */
import { resolveActor } from "./../state/actor.ts";
import { hostLabel } from "./../state/ledger-mirror.ts";
import { passLeftovers } from "./restart.ts";

/** The tree a stop ran in and whether it left work there, measured now. */
export async function measureStop(): Promise<{
  leftWork: boolean;
  tree: string;
}> {
  return {
    leftWork: leftWork(await passLeftovers({ fingerprint: false })),
    tree: `${await resolveActor()}@${hostLabel()}`,
  };
}

/**
 * Whether the tree holds work no push carries: uncommitted edits, an open
 * git operation, or commits the pull request lacks. A probe that failed
 * counts as work, so a re-drive stays in the tree rather than leave it.
 */
function leftWork(l: Awaited<ReturnType<typeof passLeftovers>>): boolean {
  return (
    l.uncommitted !== "" ||
    l.operation !== null ||
    !l.operationProbed ||
    (l.unpushed === null ? l.baseExists !== false : l.unpushed > 0)
  );
}
