/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { HELD_PUSH } from "./drive-pr-harness.ts";

import type { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
export function createStateClaimFixtures(
  parent: ReturnType<typeof createStateDurabilityFixtures>,
) {
  const { state } = parent;

  // `hold`/`held`/`release-held` serialise the JSON, but say nothing about
  // who may DISPATCH the external mutation for a held item — that call
  // happens entirely outside this script, between reading `held` and
  // eventually releasing the key. Two concurrent drivers reading the same
  // snapshot could both decide to process the same item and both dispatch,
  // which is a duplicate, permanent GitHub comment for a `finding`
  // (`answer-summary-finding.ts` is not idempotent). `claim-held` is the
  // gate that makes only one of them allowed to dispatch.

  // Holds the finding AND stamps it with the push whose fix it is waiting on
  // — `claim-held --kind finding` now refuses a `--pushed-sha`
  // that is not the item's own. `stamp-held` runs AFTER the hold on purpose:
  // it stamps the batch as it stands, so an item held later is not
  // retroactively vouched for by an earlier push. Every test in this block is
  // about the MUTEX, so each one starts from a legitimately claimable item;
  // the provenance check has its own block below.
  async function hold(
    d: string,
    key: string,
    outcome: "accepted" | "moot" = "accepted",
  ) {
    await state(
      d,
      ["hold", "999", "--key", key, "--kind", "finding", "--outcome", outcome],
      {},
      "reason",
    );
    await state(d, ["stamp-held", "999", "--sha", HELD_PUSH]);
  }
  return { hold };
}
