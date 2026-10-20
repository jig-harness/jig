/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { expect } from "bun:test";

import type { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
export function createStateProvenanceFixtures(
  parent: ReturnType<typeof createStateDurabilityFixtures>,
) {
  const { drive } = parent;

  // A held thread's resolve cannot rest on `.verifiedSha`: that is ONE
  // PR-global field in a state file every driver of the PR shares (store.ts
  // keys the state directory per clone precisely so they do). So whichever
  // driver pushed last would move it, and it would then vouch for every held
  // item on the PR, including ones whose promised fix that push never
  // contained. Each hold carries its own push provenance instead.
  //
  // These probes run TWO REAL WORKTREES of one clone — the Conductor
  // topology the hazard lives in, and the only way to exercise the actor
  // derivation rather than a stand-in for it (it is deliberately not
  // overridable; see lib/state/actor.ts).
  //
  // They run at ladder tier 3 (no session identity — `twoDrivers` pins both
  // variables empty) and HAND THE PR OVER between turns, which is the shape
  // the state these probes need is actually reachable in: two actors' holds
  // in one file, one of them unstamped. The gate decides who may drive NOW;
  // provenance decides whose push answers a promise made EARLIER, and those
  // two never answer the same question — a hold outlives the tree that made
  // it, which is why the second half survives the first. `two actors' holds
  // coexist by TAKEOVER, not by concurrency` below builds the same state
  // through a session-identified takeover, so neither route is the sole
  // evidence.
  //
  // Tier 3 used to reach it by CONCURRENCY instead — no lease either side,
  // so both trees simply mutated. That was the hole (two sessionless
  // resolvers), not a licence, and closing it
  // is what made these hand-overs necessary rather than incidental.

  const A_PUSH = "1111111111111111111111111111111111111111";

  const B_PUSH = "2222222222222222222222222222222222222222";

  /**
   * Tree `t` stops driving this PR, so another tree may be admitted.
   *
   * Explicit because a tier-3 holder has no pid whose death could say it
   *: a session lease clears when its process goes, a tree-held
   * record clears only by `clear-lease` or by the staleness window, and a
   * window measured in hours is not something a probe can wait out. So the
   * hand-over is stated. It drops the LEASE only — every hold stays exactly
   * where it was, which is the premise all three probes below are built on.
   */
  function handOver(t: string, env: Record<string, string>): void {
    const r = drive(t, env, ["clear-lease", "999"]);
    // Asserted rather than fired and forgotten: if this ever stopped working,
    // the next command would be refused with 13 and the probe would fail
    // somewhere unrelated to its subject.
    expect({ code: r.exitCode, stderr: r.stderr }).toMatchObject({ code: 0 });
  }
  return { A_PUSH, B_PUSH, handOver };
}
