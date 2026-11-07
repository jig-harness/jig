import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";

export function prNumber(target: string): string | null {
  return /^PR #(\d+)$/.exec(target)?.[1] ?? null;
}

/** A completed PR cannot still need a drive decision; its follow-up can. Unknown state preserves the stop. */
export function reconcileNeeds(
  line: LineSnapshot,
  facts: Map<string, DashboardPr>,
): LineSnapshot {
  return {
    ...line,
    needs: line.needs.filter((n) => {
      const state = facts.get(`${n.repo}#${n.pr}`)?.state;
      return n.stage !== "rearm" || (state !== "MERGED" && state !== "CLOSED");
    }),
  };
}
