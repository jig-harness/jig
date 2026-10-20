/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { claimCreate } from "../scripts/lib/state/claims";

import { SCRIPTS, HELD_PUSH, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateClaimFixtures } from "./drive-pr-state-claim-fixtures.ts";

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
      // `Number.MAX_SAFE_INTEGER`. The bash original's `[ "$v" -gt 1440 ]`
      // failed outright on it with "integer expression expected", an exit
      // `if` reads as simply "not true" — the SAME outcome as a legitimate
      // in-range value — so NEITHER clamp branch fired and the astronomical
      // original flowed straight through unclamped, making an abandoned claim
      // un-reclaimable for an effectively unbounded period instead of the
      // documented 24h maximum. Rejecting on digit COUNT, before any
      // comparison sees the value, is what closes that in either language.
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
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_a."),
      );
      if (!claimFile) throw new Error("claim file was not created");
      // Backdate past the DEFAULT staleness window (10m) but nowhere near
      // the bogus value — if the overflow bypassed the clamp, this claim
      // would still read as live and reclamation would fail (exit 1).
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
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
      // suite-wide default. Every earlier shape of this mechanism
      // passed the simple "many claimants race an UNCLAIMED key" test above
      // and still let two claimants win when the contested item was a real,
      // backdated-past-the-staleness-window claim instead: the two-step
      // "win a slot, then separately write an identity marker inside it"
      // protocol left a window where one claimant's identity-write could
      // land inside a DIFFERENT claimant's directory generation once enough
      // concurrent break-and-recreate cycles were in flight — reproduced
      // empirically at 3/40, then 10/50 (worse) after a naive verify-before-
      // destroy fix, then ~20/150 after removing the destructive restore
      // entirely. None of those patches touched the actual defect. Only
      // replacing the two-step create with ONE atomic `O_CREAT|O_EXCL`
      // write (see claimCreate's own comment in lib/state/claims.ts) closed it:
      // 0/200 over the same probe.
      //
      // What this probe pins is the PROTOCOL-level property: exactly one
      // winner over a stale claim, whatever the interleaving. What it can
      // NOT be relied on to catch is a regression of `claimCreate` itself
      // back to a check-then-write pair — measured directly (
      // 2026-08-15): a statSync-then-write mutation of claimCreate PASSED
      // this probe, because the finding path's final locked
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
        await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_stale",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        const claimFile = readdirSync(d).find((f) =>
          f.startsWith("drive-pr-999.held-claim.PRRT_stale."),
        );
        if (!claimFile) throw new Error("claim file was not created");
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
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

    it("claimCreate is one atomic O_CREAT|O_EXCL syscall — shape pinned verbatim", () => {
      // The stale-race probe above cannot be relied on to redden when
      // claimCreate regresses to a check-then-write pair (see its comment:
      // the mutation was run, and passed). No schedule-based probe can pin a
      // µs-scale window deterministically, so the atomicity that the whole
      // claim mechanism rests on is pinned verbatim (parse or pin). A
      // legitimate refactor of claimCreate must update this pin consciously —
      // that friction is the point, the same trade EXPECTED_RUN_LINES makes in
      // ci-activation.test.ts.
      const src = readFileSync(
        join(SCRIPTS, "lib", "state", "claims.ts"),
        "utf8",
      );
      // Population check first (rule 1): exactly one claimCreate exists, so
      // a rename or duplicate cannot let the verbatim pin match a decoy.
      expect(src.split("export function claimCreate(").length).toBe(2);
      expect(src).toContain(
        `export function claimCreate(path: string, token: string): boolean {
  try {
    writeFileSync(path, token, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
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
      // distinguishes atomic from check-then-write.
      const executable = claimCreate.toString();
      // The atomic create: `wx` fails when the path exists, in ONE syscall.
      expect(executable).toMatch(/flag:\s*['"]wx['"]/);
      // ...and no separate existence probe, which is the regression this
      // whole pin exists to catch — a check-then-write pair has a window
      // between the check and the write that two claimants both pass.
      expect(executable).not.toMatch(/existsSync|readFileSync|statSync/);

      // Behavioral half — refusing an existing claim must never truncate or
      // overwrite it. (A check-then-write mutation also passes THIS half,
      // which is why the pins above are the load-bearing guard.)
      const d = stateDirFor("claim-create-atomic");
      const path = join(d, "claim-pin");
      writeFileSync(path, "incumbent");
      expect(claimCreate(path, "challenger")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("incumbent");
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
