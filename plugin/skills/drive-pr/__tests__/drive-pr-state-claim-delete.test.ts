/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;

  describe("claim-held — atomic compare-and-delete", () => {
    // resolve-held-thread.ts used to read `held` and `rounds` as two separate,
    // unlocked calls and only decide afterwards whether to resolve — a window
    // in which a concurrent driver could change either. `claim-held --kind
    // thread` folds the whole predicate (kind, round, verifiedSha) and the
    // removal into ONE lock hold, so these probes exercise it directly —
    // including a forced concurrent overlap, since sequential calls prove
    // nothing about the mutex itself.

    it("removes a matching held thread and returns it", async () => {
      const d = stateDirFor("claim-happy");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-9",
      ]);
      // AFTER the hold, which is the order SKILL.md § 6 prescribes and the
      // order the mechanism requires: `stamp-held` stamps the batch as it
      // stands, so a hold made later is not vouched for by a push that
      // predates the promise it represents.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(0);
      // The whole item, including the provenance `restore-held` demands back
      // verbatim if the mutation that follows a claim fails.
      expect(JSON.parse(r.stdout)).toEqual({
        key: "PRRT_a",
        kind: "thread",
        outcome: "accepted",
        round: 1,
        commentUrl: "https://example.invalid/synthetic-comment-9",
        actor: ACTOR,
        verifiedSha: "ffffffffffffffffffffffffffffffffffffffff",
      });
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("a SECOND claim on the same key fails — proven with a FORCED concurrent overlap", async () => {
      // Two calls merely launched close together race real process-scheduling
      // jitter — on a fast/idle machine the first can finish entirely before
      // the second even starts its own `mkdir`, so a bug that dropped the
      // lock ENTIRELY would still pass a "launch both, await both" test (the
      // gap a sequential-await version of this test leaves). Proving the mutex
      // itself needs a deterministically FORCED overlap: process A signals the
      // instant it holds the lock, this test waits for that signal before
      // starting process B, and A is told to hold the lock open for another
      // 500ms — so B's `mkdir` is guaranteed to contend for a lock A still
      // holds, not merely scheduled near it.
      const d = stateDirFor("claim-race");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-10",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);

      const signal = join(d, "a-is-holding");
      const claimArgs = [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ];
      // Started but NOT awaited yet — this must run concurrently with B, not
      // resolve before B is even spawned.
      const firstPromise = state(d, claimArgs, {
        DRIVE_PR_CLAIM_HELD_TEST_SIGNAL: signal,
        DRIVE_PR_CLAIM_HELD_TEST_DELAY: "0.5",
      });

      const deadline = Date.now() + 5000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline) {
          throw new Error(
            "process A never signalled that it was holding the lock",
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      // A is now DEFINITELY holding the lock and will for another ~0.5s — B's
      // own acquire_lock call below is forced to wait on A's mkdir, exercising
      // the real contention path rather than an accident of ordering.
      const second = await state(d, claimArgs);
      const first = await firstPromise;

      expect(first.exitCode).toBe(0);
      // Exit 4, not 1: "no held item at all" is the snapshot going stale — B
      // lost the race, and A's claim is why the key is gone — not a property
      // of B's own round/SHA the way exit 1 is reserved for.
      expect(second.exitCode).toBe(4);
      expect(second.stderr).toContain("no held item with key 'PRRT_a'");
    });

    it("refuses — without removing anything — when the pushed SHA is not the one recorded against this hold, even though the round matches", async () => {
      // The exact bypass: an unrelated push lands without
      // ever going through a counting drive-status.ts gate, so `.rounds` never
      // advances and a round-only comparison would read this as a match. The
      // stamp is written by exactly one call site (`stamp-held`, from a real
      // guarded push), so it stays stale here and the claim must refuse.
      const d = stateDirFor("claim-sha-mismatch");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-11",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "unrelated-push-sha",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
      // Names the stamp it DID find, not just that something mismatched — a
      // refusal a reader cannot act on sends them to the state file by hand.
      expect(r.stderr).toContain("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
      // Refused, not consumed — a legitimate retry with the right SHA must
      // still find it.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses a hold whose own driver has not pushed at all, even when the PR-GLOBAL verifiedSha matches", async () => {
      // The single-driver shadow of the cross-driver bug, and the cheapest
      // possible proof that the check moved off `state.verifiedSha`: the
      // PR-global field says this exact SHA was green-verified, the round
      // matches, and the claim must STILL refuse — because the hold was made
      // after that push, so nothing has yet vouched for the fix IT promises.
      const d = stateDirFor("claim-global-sha-not-enough");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const statePath = join(d, "drive-pr-999.json");
      const seeded = JSON.parse(readFileSync(statePath, "utf8"));
      seeded.verifiedSha = "ffffffffffffffffffffffffffffffffffffffff";
      writeFileSync(statePath, JSON.stringify(seeded));
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-11b",
      ]);
      expect((await state(d, ["verified", "999"])).stdout.trim()).toBe(
        "ffffffffffffffffffffffffffffffffffffffff",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses on a round mismatch before ever checking verifiedSha", async () => {
      const d = stateDirFor("claim-round-mismatch");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-12",
      ]);
      await state(d, ["bump-round", "999", "--head", "bbb"]);
      // A NEW push also satisfies verifiedSha, so only the round check can be
      // what refuses this.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        "ffffffffffffffffffffffffffffffffffffffff",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("held in round 1");
      expect(r.stderr).toContain("round is 2");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("preserves a held FINDING's stamp while its claim is outstanding — a later, unrelated push from the SAME actor must not risk a duplicate answer", async () => {
      // The interrupted-dispatch scenario the finding describes: this actor
      // claims a finding (right before dispatching `answer-summary-
      // finding.ts`, per SKILL.md § 6) — which locks it with a SEPARATE
      // claim FILE rather than removing it from `held` — the dispatch POSTs
      // successfully, and the process dies before `release-held`. The claim
      // file is still there; nothing removed it. This SAME working tree
      // later pushes UNRELATED work and calls `stamp-held` again. Blindly
      // advancing the stamp would let a later `claim-held --pushed-sha
      // SHA_NEW` accept an entry whose actual posted marker sits at SHA_OLD,
      // and `--check-addressed --marker-sha SHA_NEW` would miss it and
      // dispatch a duplicate.
      const SHA_OLD = "3333333333333333333333333333333333333333";
      const SHA_NEW = "4444444444444444444444444444444444444444";
      const d = stateDirFor("stamp-held-preserves-outstanding-finding-claim");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dfeed",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      // The push that carries this finding's own promised fix.
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);

      // Claim it, exactly as a real dispatch pass would right before calling
      // `answer-summary-finding.ts` — this leaves a claim file on disk
      // WITHOUT removing the entry from `held` (unlike a thread's claim).
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dfeed",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);

      // This SAME actor pushes unrelated work and records it — "the process
      // died here" without ever calling release-held.
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);

      // The outstanding claim's stamp must survive untouched.
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dfeed", verifiedSha: SHA_OLD }]);
    });

    it("advances an UNCLAIMED held item's stamp on a later push from the same actor — an ordinary pending hold must not wedge, on both a thread AND an unclaimed finding", async () => {
      // The counterweight to the fix above: preserving EVERY held item's
      // stamp unconditionally would strand ordinary pending/restored holds
      // the moment their frozen SHA stops being the PR's live head, since a
      // later verified push is normally a descendant commit that still
      // contains the fix. Only a FINDING with an outstanding claim (the test
      // above) has a real duplicate-dispatch risk to protect against.
      //
      // A version of this test that only constructed a THREAD — which never
      // touches the finding-only `existsSync( claimPathFor(...))` branch at all
      // (a thread's claim always removes it from `held` atomically, so this
      // whole code path is unreachable for one), so it never actually proved an
      // UNCLAIMED finding advances. A mutation that preserved every finding's
      // old stamp unconditionally would have left this test green. Both kinds
      // are constructed below.
      const SHA_OLD = "7777777777777777777777777777777777777777";
      const SHA_NEW = "8888888888888888888888888888888888888888";
      const d = stateDirFor("stamp-held-advances-unclaimed-hold");
      await state(d, ["bump-round", "999", "--head", "aaa"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_pending",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/pending-reply",
      ]);
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dpending",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in def5678",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const byKey = async () => {
        const items = JSON.parse((await state(d, ["held", "999"])).stdout);
        return Object.fromEntries(
          items.map((h: { key: string }) => [h.key, h]),
        );
      };
      expect((await byKey()).PRRT_pending).toMatchObject({
        verifiedSha: SHA_OLD,
      });
      expect((await byKey()).f00dpending).toMatchObject({
        verifiedSha: SHA_OLD,
      });

      // A later push, still unclaimed on BOTH — must ADVANCE, not freeze:
      // nothing has dispatched against either yet, so there is nothing to
      // protect, and freezing it would wedge it the moment SHA_OLD stops
      // being the live head.
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);
      expect((await byKey()).PRRT_pending).toMatchObject({
        verifiedSha: SHA_NEW,
      });
      expect((await byKey()).f00dpending).toMatchObject({
        verifiedSha: SHA_NEW,
      });

      const threadClaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_pending",
        "--kind",
        "thread",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(threadClaim.exitCode).toBe(0);

      const findingClaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dpending",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(findingClaim.exitCode).toBe(0);
    });

    it("refuses a held FINDING — claim-held --kind thread is thread-only", async () => {
      const d = stateDirFor("claim-kind");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "moot",
        ],
        {},
        "no longer applies",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "thread",
        "--pushed-sha",
        "fff",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("is a held 'finding', not a 'thread'");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("f00d");
    });

    it("requires --key, --kind and --pushed-sha", async () => {
      const d = stateDirFor("claim-usage");
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--kind",
            "thread",
            "--pushed-sha",
            "fff",
          ])
        ).exitCode,
      ).toBe(2);
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_a",
            "--kind",
            "thread",
          ])
        ).exitCode,
      ).toBe(2);
      expect(
        (await state(d, ["claim-held", "999", "--key", "PRRT_a"])).exitCode,
      ).toBe(2);
    });
  });
});
