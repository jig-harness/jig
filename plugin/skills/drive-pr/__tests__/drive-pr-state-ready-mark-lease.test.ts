/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { resolveActor } from "../scripts/lib/state/actor";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;
  describe("the held batch", () => {
    it("refuses to renew a ready-mark lease that is no longer ours", async () => {
      // The dispatch-point guard: `renew-ready-mark` is what stands between a
      // suspended holder and a duplicate `ready_for_review`, so it has to
      // refuse a reclaimed lease rather than reset someone else's clock.
      const d = stateDirFor("ready-lease-renew");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "successor-token");
      const refused = await state(d, [
        "renew-ready-mark",
        "999",
        "--token",
        "the-suspended-owners-token",
      ]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("no longer yours");
      expect(refused.stderr).toContain("Do NOT fire 'gh pr ready'");

      // And it DOES renew one that is still ours — the half that buys the full
      // staleness window for the outbound call.
      const old = new Date(Date.now() - 9 * 60 * 1000);
      utimesSync(lease, old, old);
      const ok = await state(d, [
        "renew-ready-mark",
        "999",
        "--token",
        "successor-token",
      ]);
      expect(ok.exitCode).toBe(0);
      expect(Date.now() - statSync(lease).mtimeMs).toBeLessThan(60_000);
    });

    it("refuses to renew into a window the configuration cannot cover", async () => {
      // The two knobs are independent and can contradict: a staleness window
      // shorter than one outbound call's deadline lets the lease become
      // reclaimable while the very `gh pr ready` it protects is still running
      //. A renewal cannot make the guarantee its own
      // comment claims under that configuration, so it refuses rather than
      // renewing into a window it cannot cover.
      const d = stateDirFor("ready-lease-window");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "our-token");
      const bad = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "1", GH_CALL_TIMEOUT: "120" },
      );
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("DRIVE_PR_CLAIM_STALE_MIN");
      expect(bad.stderr).toContain("GH_CALL_TIMEOUT");

      // The same lease renews fine once the two are consistent.
      const ok = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "10", GH_CALL_TIMEOUT: "30" },
      );
      expect(ok.exitCode).toBe(0);
    });

    it("accounts for the kill-escalation grace, not just $GH_CALL_TIMEOUT", async () => {
      // `ghCall` does not settle AT its deadline — it SIGTERMs there and waits
      // `KILL_ESCALATE_MS` (2000ms) more before force-killing and returning.
      // Comparing the staleness window only against the raw timeout let
      // `DRIVE_PR_CLAIM_STALE_MIN=1` (60s) pass against `GH_CALL_TIMEOUT=59`
      // (60 > 59), even though the protected call can still be in flight for
      // ~61s — reclaimable and running at once.
      const d = stateDirFor("ready-lease-window-escalation");
      const lease = join(d, "drive-pr-999.ready-claim");
      writeFileSync(lease, "our-token");
      const bad = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "1", GH_CALL_TIMEOUT: "59" },
      );
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("kill-escalation grace");

      // One second of margin past the grace is enough to pass.
      const ok = await state(
        d,
        ["renew-ready-mark", "999", "--token", "our-token"],
        { DRIVE_PR_CLAIM_STALE_MIN: "2", GH_CALL_TIMEOUT: "59" },
      );
      expect(ok.exitCode).toBe(0);
    });

    it("reset clears the ready-mark lease, which no claim sweep covers", async () => {
      // The lease deliberately sits outside `claimPrefix` so the held-batch
      // sweep never sees it — which meant reset's sweep never did either
      //. An operator resetting to unwedge a drive would get
      // a fresh JSON plus an orphaned lease that keeps reporting contention
      // for a full staleness window, with nothing left to explain why.
      const d = stateDirFor("reset-ready-lease");
      const lease = join(d, "drive-pr-999.ready-claim");
      await state(d, ["phase", "999", "--set", "probe"]);
      writeFileSync(lease, "an-abandoned-token");
      const r = await state(d, ["reset", "999"]);
      expect(r.exitCode).toBe(0);
      expect(existsSync(lease)).toBe(false);
      // And the very next claim succeeds rather than reporting contention.
      const claim = await state(d, ["claim-ready-mark", "999"]);
      expect(claim.stdout.trim().startsWith("claimed ")).toBe(true);
    });

    it("rejects a COUNTER that is negative or fractional, not merely non-numeric", async () => {
      // These fields are positions and sentinels, not arbitrary numbers, and
      // `typeof x === 'number'` accepted values no writer here can produce.
      // Tolerating them is not neutral: `readyMarkedRound: 0.5` is non-zero,
      // so every consumer reads it as "already marked" and the draft→Ready
      // transition is suppressed forever — while mark-ready.ts's own digits
      // check rejects the decimal point and exits 1, wedging the drive rather
      // than the field. Found on `readyMarkedRound`; fixed for the whole class,
      // which is what this enumerates.
      const base = {
        pr: 999,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [],
        held: [],
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
      };
      const fields = [
        "rounds",
        "attempts",
        "lastReflectedRound",
        "lastReflectedAttempts",
        "readyMarkedRound",
        // The escalation acknowledgment is the same construct with the same
        // invariant, so it joins the class rather than being trusted to be
        // different. A fractional or negative value here reads as
        // an acknowledgment position no writer can produce.
        "lastEscalatedRound",
      ];
      for (const field of fields) {
        for (const bad of [0.5, -1]) {
          const d = stateDirFor(`counter-${field}-${bad}`);
          writeFileSync(
            join(d, "drive-pr-999.json"),
            JSON.stringify({ ...base, [field]: bad }),
          );
          const r = await state(d, ["get", "999"]);
          expect(r.exitCode).not.toBe(0);
          expect(r.stderr).toContain("not usable drive state");
        }
      }
    });

    it("still accepts the UNCONFIRMED hold sentinel, which is deliberately -1", async () => {
      // The counter check above must not close over `hold --unconfirmed`,
      // whose whole mechanism is a round no `claim-held` can ever match
      //. -1 is a writer-produced value here where it is nowhere
      // else, so this is the boundary the class fix had to stop at — and a
      // probe for it, since nothing else in the suite would notice the day it
      // stopped being legal.
      const d = stateDirFor("held-unconfirmed-round");
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 3,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 0,
          ciHold: null,
          verifiedSha: "",
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_unconfirmed",
              kind: "thread",
              outcome: "accepted",
              round: -1,
              commentUrl: "https://example.invalid/c1",
              actor: await resolveActor(),
            },
          ],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("PRRT_unconfirmed");
    });

    it("rejects a malformed NESTED round — parked[].round and the ordinary held[].round branch, not just the top-level counters", async () => {
      // The top-level-counter test above never injects into parked[].round or
      // the ordinary held[].round branch — only the held[].round === -1
      // sentinel test above it does, and that one asserts the OPPOSITE
      // (accepted, not rejected). So removing `isCount(e.round)` for parked
      // entries, or weakening the held[].round integer/lower-bound check,
      // would not turn this suite red without a probe here.
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 3,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
      };
      const actor = await resolveActor();
      for (const bad of [0.5, -1]) {
        const d = stateDirFor(`parked-round-${bad}`);
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({
            ...base,
            parked: [
              { key: "PRRT_a", kind: "thread", reason: "x", round: bad },
            ],
            held: [],
          }),
        );
        const r = await state(d, ["get", "999"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("not usable drive state");
      }
      // held[].round's lower bound is -1 (the unconfirmed sentinel), not 0 —
      // so -2 is the value that actually probes it; -1 itself must NOT be
      // rejected here, or this test would just re-cover the sentinel test.
      for (const bad of [0.5, -2]) {
        const d = stateDirFor(`held-round-${bad}`);
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({
            ...base,
            parked: [],
            held: [
              {
                key: "PRRT_a",
                kind: "thread",
                outcome: "accepted",
                round: bad,
                commentUrl: "https://example.invalid/c1",
                actor,
              },
            ],
          }),
        );
        const r = await state(d, ["get", "999"]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("not usable drive state");
      }
    });

    it("rejects a `finding` entry with an empty or missing reason", async () => {
      // `hold --kind finding` refuses to write one without a non-empty reason
      // (it is the verbatim text step 6 must send to
      // answer-summary-finding.ts), so a state file with a finding entry
      // that has none can only be hand-edited or corrupted — but the schema
      // has to actually say so, or step 6 is left with an outcome and
      // nothing to explain it. A `thread` entry needs no reason at all.
      const d = stateDirFor("held-finding-empty-reason");
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        lastReflectedRound: 0,
        lastReflectedAttempts: 0,
        readyMarkedRound: 0,
        ciHold: null,
        verifiedSha: "",
        phase: "",
        parked: [],
      };
      for (const held of [
        [
          {
            key: "f00d",
            kind: "finding",
            outcome: "moot",
            round: 0,
            reason: "",
          },
        ],
        [{ key: "f00d", kind: "finding", outcome: "moot", round: 0 }],
      ]) {
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({ ...base, held }),
        );
        const r = await state(d, ["held-keys", "999"]);
        expect(r.exitCode).not.toBe(0);
      }
      // A thread entry with no `reason` key at all remains valid (but still
      // needs a commentUrl — required for kind: thread, see the sibling test
      // below).
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          ...base,
          held: [
            {
              key: "PRRT_a",
              kind: "thread",
              outcome: "accepted",
              round: 0,
              commentUrl: "https://example.invalid/x",
              actor: ACTOR,
            },
          ],
        }),
      );
      expect((await state(d, ["held-keys", "999"])).exitCode).toBe(0);
    });

    it("rejects a `thread` entry with an empty or missing commentUrl", async () => {
      // `hold` itself refuses to write a thread entry without --comment-url
      // (either path), so a state file with one that has an
      // empty or absent commentUrl can only be hand-edited, corrupted, or
      // written by an older version of this script — but the schema
      // has to actually say so, or a provenance-free confirmed hold remains
      // claimable, bypassing the exact-comment protection this state adds.
      const d = stateDirFor("held-thread-empty-commenturl");
      const base = {
        pr: 999,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
        roundPaths: [],
        lastProgressAt: "",
        quotaPark: null,
        rounds: 0,
        lastCountedHead: "",
        attempts: 0,
        attemptsHead: "",
        verifiedSha: "",
        phase: "",
        parked: [],
      };
      for (const held of [
        [
          {
            key: "PRRT_a",
            kind: "thread",
            outcome: "accepted",
            round: 0,
            commentUrl: "",
          },
        ],
        [{ key: "PRRT_a", kind: "thread", outcome: "accepted", round: 0 }],
      ]) {
        writeFileSync(
          join(d, "drive-pr-999.json"),
          JSON.stringify({ ...base, held }),
        );
        const r = await state(d, ["held-keys", "999"]);
        expect(r.exitCode).not.toBe(0);
      }
    });
  });
});
