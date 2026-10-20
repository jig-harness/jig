/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { NO_OUTCOME_MARKER } from "../scripts/lib/outcome.ts";

import { ROUND_PATHS_MAX_PER_ROUND } from "../scripts/lib/state/schema";

// Imported, never restated: every fixture age below is derived from the
// production floor, so raising it cannot silently leave a probe sitting
// underneath it and passing vacuously.
import { isLeftOpenThread } from "../scripts/lib/status/evaluate";

import {
  HEAD,
  PREV,
  writeFixture,
  probeIn,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { createStatusEscalationFixtures } from "./drive-pr-status-escalation-fixtures.ts";

useDrivePrSuite();
describe("drive-status.ts structuralEscalationDue", () => {
  const statusEscalationFixtures = createStatusEscalationFixtures();
  const { driveState } = statusEscalationFixtures;

  // The trusted no-outcome CLARIFICATION branch (a question, no outcome token
  // yet) has the identical requirement as the leave-open-marker branch — it
  // was once fixed in the OTHER branch of this SAME function while this
  // branch was still missed.
  describe("isLeftOpenThread — the no-outcome clarification pause is also human-thread-only", () => {
    const clarificationReply = {
      author: "example-user-2",
      authorAssociation: "OWNER",
      body: `Can you clarify which caller you mean?\n\n${NO_OUTCOME_MARKER}`,
    };

    it("grants the pause when confirmedHumanStarted is explicitly true", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: true,
          comments: [
            { authorAssociation: "NONE", body: "a human finding" },
            clarificationReply,
          ],
        }),
      ).toBe(true);
    });

    it("refuses the pause when confirmedHumanStarted is false — a bot thread must not silently drop out of the live count", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: false,
          comments: [
            { authorAssociation: "NONE", body: "a bot finding" },
            clarificationReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the pause when confirmedHumanStarted is missing (fail closed)", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            clarificationReply,
          ],
        }),
      ).toBe(false);
    });
  });

  // `--no-count` is a re-read, not a pass entry. `record-paths` keys itself to
  // the CURRENT round, so recording under it would overwrite the previous
  // round's anchors with this snapshot — collapsing two rounds' findings into
  // one entry, which destroys the pair the predicate was about to compare.
  it("a --no-count re-read files nothing", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(dir, stateDir, HEAD, ["--no-count", "--no-reconcile"]);
    expect(
      JSON.parse((await driveState(stateDir, ["round-paths", "999"])).stdout),
    ).toEqual([]);
  });

  // A PR-level thread names no file, so it cannot feed a signal about one file
  // recurring — and must not contribute a `"null"` pseudo-path that would then
  // "recur" every round.
  it("a thread with no path contributes nothing", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
  });

  // A summary-only finding creates no thread at all (summary-findings.ts's own
  // doc comment: false convergence mode 1), so a recurrence signal
  // fed only from `threads` never arms for one that keeps landing on the same
  // file across rounds. This fixture has ZERO threads — only the two backlog
  // entries, both anchored to `AGENTS.md` — so a paths list still missing
  // `AGENTS.md` here can only be explained by the completeness gap,
  // not by a thread this fixture never had.
  it("a summary-only finding’s path feeds the recurrence signal too, not only a thread’s", async () => {
    const { dir, stateDir } = writeFixture({ backlog: true });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["AGENTS.md"]);
  });

  // The same recurrence the earlier "arms on the same file two consecutive
  // rounds" probe demonstrates for a thread, but with no thread on that file
  // at all in either round — only the standing backlog entries, which stay
  // unaddressed on both independently-built rounds. Proves the signal now
  // arms on a purely summary-only recurrence, which it could not before.
  it("arms on the same file two consecutive rounds when only a summary finding recurs there", async () => {
    const round1 = writeFixture({ backlog: true });
    expect(
      (await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]))
        .json.structuralEscalationDue,
    ).toBe(false);

    const round2 = writeFixture({ head: PREV, backlog: true });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.json.structuralEscalationDue).toBe(true);
  });

  // The cap-truncation warning `record-paths` writes on stdout-success (its
  // own probe in structural-escalation.test.ts) has nowhere to surface if the
  // caller that spawns it discards its stderr — which `recordRoundPaths()`
  // used to do unconditionally. Passing it through (the same convention
  // `parked-keys` above already uses) is what lets a repeated file sorted
  // outside the retained 200 paths still show up on an operator's screen
  // instead of silently vanishing from the
  // recurrence signal.
  it("passes record-paths’s own cap-truncation warning through to stderr", async () => {
    const many = Array.from(
      { length: ROUND_PATHS_MAX_PER_ROUND + 5 },
      (_, i) => ({ id: `PRRT_${i}`, path: `f${i}.ts`, bot: true }),
    );
    const { dir, stateDir } = writeFixture({ threads: many });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("exceeding the");
    expect(r.stderr).toContain("5 dropped");
  });
});
