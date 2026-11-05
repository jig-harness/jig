/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import { claimCreate, claimRefFor } from "../scripts/lib/state/claims";

import { SCRIPTS, HELD_PUSH, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateClaimFixtures } from "./drive-pr-state-claim-fixtures.ts";
import { claimRow, putClaim } from "./state-rows.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;
  describe("atomic claim over the held batch", () => {
    const stateClaimFixtures = createStateClaimFixtures(
      stateDurabilityFixtures,
    );
    const { hold } = stateClaimFixtures;

    it("DRIVE_PR_CLAIM_STALE_MIN is validated — a negative/non-numeric value falls back to the default rather than making every claim instantly stale", async () => {
      const d = stateDirFor("claim-stale-invalid-env");
      await hold(d, "PRRT_a");
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "-1" };
      const first = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(first.exitCode).toBe(0);
      // A second claim attempt right away must NOT succeed — if -1 were
      // honoured verbatim, the claim just created would already read as
      // stale and lose its exclusivity immediately.
      const second = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("is not a non-negative integer");
    });

    it("DRIVE_PR_CLAIM_STALE_MIN rejects a digit-only value too large to compare exactly", async () => {
      // A value that IS all-digits can still be far outside the range any
      // comparison handles exactly — this one parses to a float well past
      // `Number.MAX_SAFE_INTEGER`. A comparison that fails on it reads as
      // "not true", the SAME outcome as a legitimate in-range value, so
      // neither clamp branch would fire and the astronomical value would
      // flow through unclamped, making an abandoned claim un-reclaimable for
      // an effectively unbounded period instead of the documented 24h
      // maximum. Rejecting on digit COUNT, before any comparison sees the
      // value, is what closes that.
      const d = stateDirFor("claim-stale-overflow-env");
      await hold(d, "PRRT_a");
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "99999999999999999999" };
      const first = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(first.exitCode).toBe(0);
      expect(claimRow(d, "999", "held", "PRRT_a")?.token).toBe(first.stdout);
      // Backdate past the DEFAULT staleness window (10m) but nowhere near
      // the bogus value — if the overflow bypassed the clamp, this claim
      // would still read as live and reclamation would fail (exit 1).
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      putClaim(
        d,
        "999",
        "held",
        "PRRT_a",
        first.stdout,
        twentyMinutesAgo.toISOString(),
      );
      const second = await state(
        d,
        [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ],
        env,
      );
      expect(second.exitCode).toBe(0);
      expect(second.stderr).toContain("too many digits to compare safely");
    });

    it("EXACTLY ONE of many concurrent claimants wins a genuinely STALE claim — no double-winner, ever", async () => {
      // The deep regression probe. 8 rounds x 8-way REAL per-PR-lock
      // contention (the state lock's own sleep-and-retry backoff, compressed
      // to 25ms by the suite-wide DRIVE_PR_LOCK_RETRY_MS but never mocked)
      // is legitimately slower than the file's 30s default under
      // any nontrivial concurrent load — a wider timeout here, not a wider
      // suite-wide default. A protocol can pass the simple "many claimants
      // race an UNCLAIMED key" test above and still let two claimants win
      // when the contested item is a real claim backdated past the
      // staleness window, where every claimant breaks and recreates at once.
      //
      // What this probe pins is the PROTOCOL-level property: exactly one
      // winner over a stale claim, whatever the interleaving. What it can
      // NOT be relied on to catch is a regression of `claimCreate` itself
      // to a check-then-insert pair: the finding path's final locked
      // `claimTokenMatches` verify serialises the win decision, so a
      // non-atomic create only double-wins in a µs-scale interleave that
      // scheduling almost never reaches (the losers arrive a whole lock-poll
      // interval after the breaker's re-create). The create's SHAPE is
      // pinned deterministically by the `claimCreate is one atomic …` test
      // right below instead; this probe stays as the end-to-end guard over
      // the protocol around it.
      for (let round = 0; round < 8; round++) {
        const d = stateDirFor(`claim-stale-race-${round}`);
        await hold(d, "PRRT_stale");
        const original = await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_stale",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        expect(claimRow(d, "999", "held", "PRRT_stale")?.token).toBe(
          original.stdout,
        );
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        putClaim(
          d,
          "999",
          "held",
          "PRRT_stale",
          original.stdout,
          twentyMinutesAgo.toISOString(),
        );
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_stale",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        );
        const winners = results.filter((r) => r.exitCode === 0);
        expect(winners).toHaveLength(1);
      }
    }, 90_000);

    it("claimCreate is one atomic insert that does nothing when the claim exists — shape pinned verbatim", () => {
      // The stale-race probe above cannot be relied on to redden when
      // claimCreate regresses to a check-then-insert pair (see its comment).
      // No schedule-based probe can pin a µs-scale window deterministically,
      // so the atomicity that the whole claim mechanism rests on is pinned
      // verbatim (parse or pin). A legitimate refactor of claimCreate must
      // update this pin consciously — that friction is the point, the same
      // trade EXPECTED_RUN_LINES makes in ci-activation.test.ts.
      const src = readFileSync(
        join(SCRIPTS, "lib", "state", "claims.ts"),
        "utf8",
      );
      // Population check first (rule 1): exactly one claimCreate exists, so
      // a rename or duplicate cannot let the verbatim pin match a decoy.
      expect(src.split("export function claimCreate(").length).toBe(2);
      expect(src).toContain(
        `export function claimCreate(ref: ClaimRef, token: string): boolean {
  const drive = driveDb(ref.stateDir);
  return (
    drive.db.run(
      \`INSERT INTO claims (clone, pr, kind, key, token, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (clone, pr, kind, key) DO NOTHING\`,
      [drive.clone, ref.pr, ref.kind, ref.key, token, new Date().toISOString()],
    ).changes === 1
  );
}`,
      );
      // The pin above is a claim about the FILE. On its own it says nothing
      // about which function the `claimCreate` export is actually bound to
      //: the pinned text can sit in the file
      // untouched while the executable export is something else — declared in
      // another form, re-bound, or re-exported from elsewhere — and every
      // assertion so far still passes.
      //
      // So assert against the EXECUTABLE. `Function.prototype.toString()`
      // returns the source of the function object this module actually
      // exported, which no amount of decoy text elsewhere in the file can
      // forge. Read from the imported binding at the top of this file, i.e.
      // the same symbol production callers get.
      //
      // Matched semantically rather than byte-for-byte because toString()
      // yields bun's TRANSPILED form (types stripped, `true` -> `!0`, quote
      // style normalized) — pinning that verbatim would redden on a bun
      // upgrade while proving nothing extra. What is asserted is exactly what
      // distinguishes atomic from check-then-insert.
      const executable = claimCreate.toString();
      // The atomic create: one insert that does nothing when the row exists,
      // its outcome read from the rows it changed.
      expect(executable).toMatch(
        /ON CONFLICT \(clone, pr, kind, key\) DO NOTHING/,
      );
      expect(executable).toMatch(/\.changes\s*===\s*1/);
      // ...and no separate existence probe or overwrite, which is the
      // regression this whole pin exists to catch — a check-then-insert pair
      // has a window between the check and the insert that two claimants
      // both pass, and a replacing insert lets the second one win outright.
      expect(executable).not.toMatch(
        /SELECT|OR REPLACE|DO UPDATE|claimExists|row\(/,
      );

      // Behavioral half — refusing an existing claim must never overwrite
      // it. (A check-then-insert mutation also passes THIS half, which is
      // why the pins above are the load-bearing guard.)
      const d = stateDirFor("claim-create-atomic");
      const ref = claimRefFor(d, "999", "claim-pin");
      expect(claimCreate(ref, "incumbent")).toBe(true);
      expect(claimCreate(ref, "challenger")).toBe(false);
      expect(claimRow(d, "999", "held", "claim-pin")?.token).toBe("incumbent");
    });

    it("release-held --all refuses while ANY held item still has a live claim", async () => {
      const d = stateDirFor("claim-all-refuses");
      await hold(d, "PRRT_a");
      await hold(d, "PRRT_b");
      const claimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("LIVE claim");
      // Nothing was cleared — not even the uncontended PRRT_b.
      expect((await state(d, ["held-keys", "999"])).stdout.split("\n")).toEqual(
        ["PRRT_a", "PRRT_b"],
      );
      // Once the live claim is released, --all proceeds as normal.
      await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      const all = await state(d, ["release-held", "999", "--all"]);
      expect(all.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("release-held --all with no claims at all is unaffected — the no-contention path", async () => {
      const d = stateDirFor("claim-all-unaffected");
      await hold(d, "PRRT_a");
      await hold(d, "PRRT_b");
      const r = await state(d, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });
  });
});
