/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { ACTOR, HELD_PUSH, useDrivePrSuite } from "./drive-pr-harness.ts";

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

    it("claims a held item and prints a token", async () => {
      const d = stateDirFor("claim-basic");
      await hold(d, "PRRT_a");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toBe("");
    });

    it("refuses to claim a key that is not (or no longer) in the held batch", async () => {
      const d = stateDirFor("claim-not-held");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_ghost",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(4);
      expect(r.stderr).toContain("not in the held batch");
    });

    it("a second claim on a LIVE claim is refused — the actual double-dispatch guard", async () => {
      const d = stateDirFor("claim-contended");
      await hold(d, "PRRT_a");
      const first = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(first.exitCode).toBe(0);
      const second = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("already claimed");
      // The first claimant's token is still the only valid one.
      await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        first.stdout,
      ]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("ONLY ONE of many concurrent claimants wins the same key", async () => {
      // The scripted version of the race this whole issue is about: several
      // processes read the same held snapshot and all try to claim the same
      // item at once. `claimCreate`'s atomic, `O_CREAT|O_EXCL` file
      // creation (see its own comment in lib/state/claims.ts) must let exactly
      // one through.
      //
      // An earlier version of `claimIsLive` judged a claim directory "torn"
      // (not yet live) until its owner marker existed, and broke a directory
      // it found in that state — so a second claimant racing the FIRST
      // claimant's own two-step create window saw a torn slot, broke it,
      // and both ended up with a valid token. Measured empirically at the
      // time: an 8-way race over 40 iterations produced 3 winners once.
      // Repeating the race several times here is what actually catches that
      // regression — a single iteration passed the overwhelming majority of
      // the time even with the bug present.
      for (let round = 0; round < 10; round++) {
        const d = stateDirFor(`claim-race-${round}`);
        await hold(d, "PRRT_a");
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_a",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        );
        const winners = results.filter((r) => r.exitCode === 0);
        expect(winners).toHaveLength(1);
        expect(results.filter((r) => r.exitCode === 1)).toHaveLength(7);
      }
    });

    it("two keys differing only by CASE produce claim files that stay distinct even if the filesystem folds case", async () => {
      // `claimKeyForPath` sanitises a key into a directory name, and the
      // sanitisation alone does not guarantee two distinct keys land on two
      // distinct paths: real thread ids and fingerprints already fit inside
      // the preserved character set, so the `tr` is close to a no-op — the
      // actual source of a collision is a case-insensitive volume (the
      // default on macOS, where these worktrees run), which folds two ids
      // differing only in the case of one character onto the SAME directory.
      // Measured against a real PR in this repo: 7 of 100 thread ids
      // collided that way. A checksum on the exact-case original is what
      // keeps them apart regardless of the filesystem's case sensitivity.
      //
      // This runner's OWN temp filesystem is whatever the host gives it —
      // case-INSENSITIVE on macOS, where these worktrees run, but
      // case-SENSITIVE on Linux CI. On a case-sensitive host, both claims
      // succeeding proves nothing: the raw, un-checksummed "safe" prefix
      // already differs by case there, so a regression that deleted the
      // checksum suffix entirely would still pass this test green on CI —
      // exactly the gap to close. Folding both real
      // filenames to lowercase HERE, in the assertion, reproduces the
      // case-insensitive collision deterministically on any host: it is
      // true if and only if the checksum suffix (not the case-foldable
      // prefix) is what keeps the two files apart, independent of what the
      // actual test-runner filesystem does with case.
      const d = stateDirFor("claim-case-collision");
      await hold(d, "PRRT_AbCdEf");
      await hold(d, "PRRT_ABCDEF");
      const first = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_AbCdEf",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const second = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_ABCDEF",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      // On this host's actual filesystem, both succeed regardless of case
      // sensitivity: a case-sensitive host never collided in the first
      // place, and a case-insensitive one is exactly what the checksum
      // suffix is there to survive.
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      const claimFiles = readdirSync(d).filter((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_"),
      );
      expect(claimFiles).toHaveLength(2);
      const folded = claimFiles.map((f) => f.toLowerCase());
      expect(folded[0]).not.toBe(folded[1]);
    });

    it("claim-held propagates a distinct exit when the state file is unusable", async () => {
      // Must NOT be conflated with "key not in held batch" (exit 4) — one is
      // "nothing to do, move on", the other is "stop, a human has to look at
      // this file". Mirrors read_state's own fail-closed contract elsewhere
      // in this script.
      const d = stateDirFor("claim-malformed-state");
      // A held batch must exist for claim-held to reach the locked read at all —
      // write it well-formed first, THEN corrupt it, so the failure being
      // tested is read_state's, not an earlier, unrelated one.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
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
          held: [
            {
              key: "PRRT_a",
              kind: "finding",
              outcome: "accepted",
              round: 0,
              reason: "reason",
              actor: ACTOR,
              verifiedSha: HELD_PUSH,
            },
          ],
        }),
      );
      writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(r.exitCode).toBe(3);
      expect(r.exitCode).not.toBe(4);
      // The claim taken before the read failed must not be left dangling —
      // a fresh, well-formed state must still be able to claim the key.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
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
          held: [
            {
              key: "PRRT_a",
              kind: "finding",
              outcome: "accepted",
              round: 0,
              reason: "reason",
              actor: ACTOR,
              verifiedSha: HELD_PUSH,
            },
          ],
        }),
      );
      const retry = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(retry.exitCode).toBe(0);
    });

    it("release-held --key refuses without a token while the claim is LIVE", async () => {
      const d = stateDirFor("claim-release-no-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("has a live claim");
      // Untouched — still held, still claimed.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("release-held --key refuses a WRONG token", async () => {
      const d = stateDirFor("claim-release-wrong-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        "owner.not-the-real-one",
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("has a live claim");
    });

    it("release-held --key with the RIGHT token succeeds and clears the claim too", async () => {
      const d = stateDirFor("claim-release-right-token");
      await hold(d, "PRRT_a");
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
      const released = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      expect(released.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("release-held --key with NO prior claim needs no token — the unaffected solo path", async () => {
      // Nobody ever called claim-held for this key, so there is nothing to
      // verify identity against — the older behaviour, unaffected.
      const d = stateDirFor("claim-release-legacy");
      await hold(d, "PRRT_a");
      const r = await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect(r.exitCode).toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("unclaim-held gives back a claim without touching the held batch", async () => {
      const d = stateDirFor("unclaim-basic");
      await hold(d, "PRRT_a");
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
      const unclaimed = await state(d, [
        "unclaim-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        claimed.stdout,
      ]);
      expect(unclaimed.exitCode).toBe(0);
      // Still held — unclaim is not a release.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
      // And immediately reclaimable, unlike waiting out a staleness window.
      const reclaimed = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(reclaimed.exitCode).toBe(0);
      expect(reclaimed.stdout).not.toBe(claimed.stdout);
    });

    it("unclaim-held refuses a WRONG token", async () => {
      const d = stateDirFor("unclaim-wrong-token");
      await hold(d, "PRRT_a");
      await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      const r = await state(d, [
        "unclaim-held",
        "999",
        "--key",
        "PRRT_a",
        "--token",
        "not-the-real-token",
      ]);
      expect(r.exitCode).toBe(1);
      // The real claim is untouched — still contended for anyone else.
      const stillLive = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect(stillLive.exitCode).toBe(1);
    });

    it("a STALE owner calling unclaim-held never deletes a FRESH reclaimer's file", async () => {
      // `unclaim-held` used to check the token and remove the claim file as
      // two SEPARATE, unlocked steps. An owner returning right at the edge of
      // the staleness window could pass its token check against its own
      // still-on-disk (but now stale) file, then have a DIFFERENT driver
      // legitimately break that SAME stale claim and create a fresh one for
      // itself in the gap before this call's own `removeClaimFile` ran —
      // deleting the FRESH claimant's file, not the one this caller ever
      // owned, and leaving a third driver free to claim the key while the
      // second still believed it held it exclusively. Firing the original
      // owner's `unclaim-held` at the same instant as several reclaimers,
      // repeated over several rounds, is what actually exercises that window
      // — a single iteration passes the overwhelming majority of the time
      // even with the bug present, exactly like the sibling stale-claim race
      // probe. Deliberately smaller than that sibling's 8x8 (4 rounds x 4-way
      // here vs. 8x8 there): `drive-pr-selftest`'s commit hook caps the WHOLE
      // suite at a fixed budget, and this test's subprocess count stacks on top
      // of every other race probe already in the file, not in isolation.
      for (let round = 0; round < 4; round++) {
        const d = stateDirFor(`unclaim-race-${round}`);
        await hold(d, "PRRT_a");
        const original = await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        expect(original.exitCode).toBe(0);
        const originalToken = original.stdout;
        const claimFile = readdirSync(d).find((f) =>
          f.startsWith("drive-pr-999.held-claim.PRRT_a."),
        );
        if (!claimFile) throw new Error("claim file was not created");
        const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
        utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);
        // The original, now-stale owner tries to give the claim back at the
        // same instant several OTHER drivers see it as stale and race to
        // reclaim it.
        const [, ...reclaimResults] = await Promise.all([
          state(d, [
            "unclaim-held",
            "999",
            "--key",
            "PRRT_a",
            "--token",
            originalToken,
          ]),
          ...Array.from({ length: 4 }, () =>
            state(d, [
              "claim-held",
              "999",
              "--key",
              "PRRT_a",
              "--kind",
              "finding",
              "--pushed-sha",
              HELD_PUSH,
            ]),
          ),
        ]);
        const winners = reclaimResults.filter((r) => r.exitCode === 0);
        // Exactly one reclaimer must win — not merely "at most one". Under
        // the old unlocked match-then-remove, the stale owner's
        // unclaim-held could delete a fresh claimant's file AFTER
        // claimCreate but BEFORE that claimant's own final ownership
        // check (claim-held's "prove OUR token is still the content
        // actually sitting at $path" step) — so the claimant then exits
        // non-zero too, every contender loses, winners.length is 0, and a
        // `<= 1` assertion would pass right through that exact failure
        // mode without ever reaching the recovery check below.
        expect(winners).toHaveLength(1);
        // A fresh, LIVE claim now exists. A further attempt on the same
        // key must be refused — proof the winner's file was NOT silently
        // deleted by the racing unclaim-held call.
        const after = await state(d, [
          "claim-held",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "finding",
          "--pushed-sha",
          HELD_PUSH,
        ]);
        expect(after.exitCode).toBe(1);
      }
      // Real per-PR-lock contention (the state lock's own 1s sleep-and-retry
      // backoff, not mocked) is legitimately slower than bun's 5s default
      // under any nontrivial concurrent load, hence a wider budget than a
      // single round would need — kept smaller than the sibling 8x8 probe's
      // 90s since this test is 4x4.
    }, 45_000);

    it("a claim racing release-held --all observes the CLEAR, never a stale pre-clear snapshot", async () => {
      // `release-held --all` checks every held key for a live claim, clears
      // `.held = []`, and deletes each key's claim file — all inside ONE lock
      // hold. Before this fix, claim-held's own post-create membership
      // re-check was UNLOCKED, so a concurrent claim-held racing exactly this
      // window could read the PRE-clear snapshot (key still present), pass its
      // own membership check, and return a "valid" token for a key `--all`'s
      // cleanup was about to delete out from under it — the exact
      // duplicate-dispatch bug this whole primitive exists to prevent, just
      // reached one step earlier than the claim-file deletion itself. Locking
      // the re-check closes it: the concurrent claimant's decision is now
      // ordered against `--all`'s clear, so it either wins before `--all`'s OWN
      // contended check (which then refuses to proceed) or loses to the clear
      // (reads `.held = []`, exits 4) — never a token for a key that is being
      // wiped out from under it in the same instant.
      //
      // `$DRIVE_PR_RELEASE_ALL_TEST_DELAY` holds `--all` open inside its lock
      // exactly between its contended check and its clear landing, so the
      // claimant below is GUARANTEED to be deciding while the pre-clear
      // snapshot is still on disk rather than merely likely to be. (The bash
      // original got that window by shimming `mv` on PATH, which a
      // `renameSync` port cannot be stalled by — see `testDelaySeconds`.)
      const d = stateDirFor("claim-vs-release-all");
      await hold(d, "PRRT_a");
      const releaseAll = state(d, ["release-held", "999", "--all"], {
        DRIVE_PR_RELEASE_ALL_TEST_DELAY: "2",
      });
      await new Promise((r) => setTimeout(r, 500));
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect((await releaseAll).exitCode).toBe(0);
      // The concurrent claimant must NOT win a token for a key `--all` is
      // clearing in the same instant — it must observe the clear.
      expect(claim.exitCode).toBe(4);
      expect(claim.stdout).toBe("");
      // No orphaned claim file left behind on either side.
      expect(readdirSync(d).filter((f) => f.includes("held-claim"))).toEqual(
        [],
      );
    }, 15_000);

    it("release-held --all's post-clear cleanup never deletes a RE-HELD key's fresh claim", async () => {
      // `claimPathFor` is a pure function of the key STRING — it encodes no
      // generation. Before this fix, `--all` released its lock and only THEN
      // removed each old key's claim file. A concurrent driver could, in that
      // unlocked window, legitimately `hold` the SAME key again and
      // `claim-held` it (the clear-ordering lock only orders a claimant against
      // `--all`'s CLEAR, not against `--all`'s CLEANUP — a claimant reading the
      // already-cleared `.held` sees its OWN fresh hold and correctly gets a
      // token) — and `--all`'s unconditional path-based removal would then
      // delete that live claim out from under it. Fixed by moving the cleanup
      // inside the same lock hold, so no claim can be CONFIRMED while it runs.
      //
      // `$DRIVE_PR_RELEASE_ALL_CLEANUP_TEST_DELAY` stalls `--all` after the
      // clear has landed and before the cleanup, which is where the two shapes
      // diverge observably: with the cleanup inside the lock the re-`hold`
      // below cannot start until every file is already gone, and with it
      // outside the lock the re-hold and its claim land first and the stalled
      // cleanup carries the fresh claim off.
      const d = stateDirFor("release-all-vs-rehold");
      await hold(d, "PRRT_a");
      const releaseAll = state(d, ["release-held", "999", "--all"], {
        DRIVE_PR_RELEASE_ALL_CLEANUP_TEST_DELAY: "2",
      });
      await new Promise((r) => setTimeout(r, 500));
      await hold(d, "PRRT_a");
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "finding",
        "--pushed-sha",
        HELD_PUSH,
      ]);
      expect((await releaseAll).exitCode).toBe(0);
      // The re-held key must be claimable, and the claim must survive — proof
      // `--all`'s cleanup did not carry off this fresh generation.
      expect(claim.exitCode).toBe(0);
      expect(claim.stdout).not.toBe("");
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.PRRT_a."),
      );
      if (!claimFile) throw new Error("the fresh claim file was deleted");
      expect(readFileSync(join(d, claimFile), "utf8")).toBe(claim.stdout);
    }, 15_000);

    it("an ABANDONED claim is reclaimable after the staleness window, like the per-PR lock", async () => {
      const d = stateDirFor("claim-stale");
      await hold(d, "PRRT_a");
      // A negative staleness value no longer produces an instantly-stale claim
      // (drive-state.ts now clamps/validates DRIVE_PR_CLAIM_STALE_MIN — an
      // invalid value falls back to the default rather than making every
      // claim reclaimable immediately). Use the safe minimum instead and
      // backdate the claim file's mtime past it, the same technique the
      // concurrent-race probe below uses.
      const env = { DRIVE_PR_CLAIM_STALE_MIN: "1" };
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
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      utimesSync(join(d, claimFile), twoMinutesAgo, twoMinutesAgo);
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
      expect(second.stdout).not.toBe(first.stdout);
      expect(second.stderr).toContain("broke an abandoned claim");
    });
  });
});
