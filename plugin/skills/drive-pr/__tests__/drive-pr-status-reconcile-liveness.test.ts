/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  HEAD,
  DORMANT_ARM,
  writeFixture,
  probeIn,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { createStatusReconcileFixtures } from "./drive-pr-status-reconcile-fixtures.ts";

useDrivePrSuite();
describe("drive-status.ts reconciles replied threads on every pass", () => {
  const statusReconcileFixtures = createStatusReconcileFixtures();
  const { repliedThread, resolvedIn, heldKeysIn } = statusReconcileFixtures;

  it("an unreadable liveness probe cannot hand back a NON-RE-ARMING verdict", async () => {
    // The reachable path a silent fail-closed skip opened, and the reason the
    // probe sits inside the loop rather than above it. HITL_PARKED (8) is one
    // of the verdicts that do not re-arm — SKILL.md § Guardrails: "never
    // re-arm on HITL_PARKED" — so a pass that skipped the sweep on a
    // transient blip and then returned it would strand the reply forever,
    // rebuilding the exact leak the sweep closes, with nothing left to retry
    // it.
    //
    // The fixture is the discriminating one: ONLY the probe fails, so the
    // evaluation below it succeeds and WOULD reach 8. Reading 1 instead is
    // therefore evidence about the degrade, not about `gh` being broken —
    // `transientMergeabilityFailure` (the next test) cannot say that, since
    // its evaluation fails too.
    const { dir, stateDir } = writeFixture({
      // No `checkRuns` override, so the reviewer run is present and completed
      // on this head — which is what lets the evaluation below actually REACH
      // HITL_PARKED. With the degrade removed this probe reports 8; the whole
      // assertion is that it reports 1 instead.
      threads: [repliedThread("PRRT_stranded", "**rejected**")],
      liveProbeFails: true,
    });
    await park(stateDir, "PRRT_stranded", "thread");
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
  });

  it("does NOT sweep when liveness is UNREADABLE — the guard fails closed", async () => {
    // The failure direction matters as much as the merged one. Skipping a
    // sweep costs a deferral to the next pass entry — every action it takes is
    // idempotent and re-derived from GitHub — while sweeping a PR that may
    // already be finished costs a mutation nothing undoes. So an unreadable
    // `state` suppresses the sweep rather than being read as "probably still
    // open".
    const { dir, stateDir } = writeFixture({
      threads: [repliedThread("PRRT_unreadable", "**rejected**")],
      checkRuns: [DORMANT_ARM],
      transientMergeabilityFailure: true,
    });
    const r = await probeIn(dir, stateDir, HEAD, [], { reconcile: true });

    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(resolvedIn(dir)).toEqual([]);
    expect(await heldKeysIn(stateDir)).toBe("");
  });
});
