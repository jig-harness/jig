/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync } from "node:fs";

import { join } from "node:path";

import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;
  describe("per-hold push provenance across drivers", () => {
    it("hold's claim-check and held-record replacement happen under ONE lock hold — a REAL concurrent claim-held racing in never sees a torn state", async () => {
      // An earlier fix made `hold --kind finding` break a stale claim before
      // replacing the record, but did so as tryBreakStaleClaim() (its OWN
      // lock acquire/release) followed by a SEPARATE store.update() (a
      // second acquire/release) — leaving a real window between them for a
      // concurrent claim-held to slip its own validate-and-succeed in
      // against the OLD record moments before hold silently replaced it out
      // from under the dispatch that had just been told to proceed. The
      // fix folds both into ONE `store.locked` hold (this file's `hold`
      // case). Proven here with a FORCED concurrent overlap, not a
      // sequential simulation — a claim file created by a genuinely
      // concurrent process, while `hold`'s lock is provably still held, per
      // the same idiom the "atomic claim over the held batch" block above
      // uses for claim-held's own mutex.
      //
      // Under the fix, a claimant's raw (unlocked) `claimCreate` landing
      // ANY TIME while `hold` holds the state lock is observed by `hold`'s
      // OWN existsSync check (since that check and the write are now one
      // atomic section) as a LIVE claim — so `hold` correctly REFUSES
      // rather than racing past it, and the claimant's own blocked
      // lock.acquire() only unblocks once `hold` has released without
      // having touched the record at all. The old record must therefore
      // survive completely untouched, and the claimant's own claim must
      // still validate against it successfully — the self-consistent
      // outcome the old two-lock version could not guarantee.
      const SHA_OLD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const d = stateDirFor("hold-claim-check-and-replace-one-lock");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dtorn",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);

      const signal = join(d, "hold-is-holding");
      const reholdPromise = state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dtorn",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "0.5",
        },
        "confirmed fixed in def5678",
      );
      const deadline = Date.now() + 5000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) {
          throw new Error("hold never signalled that it holds the lock");
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      // `hold` is now DEFINITELY holding the state lock, for another ~0.5s.
      // The claimant's own `claimCreate` is unlocked, so it wins the file
      // immediately; its `store.lock.acquire()` is what is forced to
      // genuinely contend with `hold`'s still-open hold.
      const claimPromise = state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dtorn",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      const [rehold, claim] = await Promise.all([reholdPromise, claimPromise]);

      expect(rehold.exitCode).toBe(1);
      expect(rehold.stderr).toContain("has a LIVE claim");
      expect(claim.exitCode).toBe(0);
      // The old record must have survived completely untouched — `hold`
      // refused before ever reaching its replacement write.
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dtorn", verifiedSha: SHA_OLD }]);
    });
  });
});
