/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync } from "node:fs";

import { join } from "node:path";

import { newClaimToken } from "../scripts/lib/state/claims";

import {
  clearAllLeases,
  leaseRef,
  treeLeaseRef,
} from "../scripts/lib/state/lease";

import {
  claimRow,
  hasState,
  putClaim,
  putLease,
  readLease,
  removeLease,
  removeTreeLease,
} from "./state-rows.ts";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateSessionLeaseFixtures } from "./drive-pr-state-session-lease-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const {
    stateDirFor,
    state,
    gitPathOf,
    twoDrivers,
    drive,
    liveSession,
    awaitPidGone,
  } = stateDurabilityFixtures;
  describe("the session lease over one working tree", () => {
    const stateSessionLeaseFixtures = createStateSessionLeaseFixtures(
      stateDurabilityFixtures,
    );
    const { A_URL, B_URL, holdAs } = stateSessionLeaseFixtures;

    it("reset REFUSES while another tree is live, deleting nothing", async () => {
      // Preserving the foreign lease is not enough: the state and the CLAIMS
      // are shared across trees. A live session mid-dispatch has already
      // created its claim and may not have posted yet — deleting it lets this
      // tree rebuild state, see the finding as unaddressed, and dispatch the
      // same non-idempotent answer again.
      //
      // Still exit 9 under the PR-wide admission gate, and WHY is worth
      // stating: this tree took its lease at the `bump-round` below, before the
      // foreign one existed, so `reset`'s claim is a fresh renewal and takes the
      // lock-free fast path — the gate does not re-litigate an admission that
      // already happened. Reaching this branch is therefore the narrow case it
      // is documented as: a tree that starts driving after this one was
      // admitted. The gate's own refusal is exercised separately below.
      const d = stateDirFor("reset-refuses-live");
      const other = liveSession();
      try {
        // This tree's own state, plus a live lease belonging to ANOTHER tree.
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        const foreign = leaseRef(d, "999", "wt-00000000000000ff");
        putLease(foreign, {
          pid: other.pid,
          worktree: "/tmp/probe-tree",
          command: "hold",
        });
        // A claim standing in for that session's in-flight dispatch.
        putClaim(d, "999", "held", "FP", newClaimToken());

        const r = await state(d, ["reset", "999"], {
          DRIVE_PR_SESSION: String(process.pid),
        });
        expect(r.exitCode).toBe(9);
        expect(r.stderr).toContain("refusing to reset");
        expect(r.stderr).toContain(`pid ${other.pid}`);
        // Nothing shared was touched — that is the whole point.
        expect(hasState(d, "999")).toBe(true);
        expect(claimRow(d, "999", "held", "FP")).not.toBeNull();
        expect(readLease(foreign)).not.toBeNull();
      } finally {
        other.stop();
      }
    });

    it("a MIXED lease set refuses without sweeping the stale ones", async () => {
      // `reset`'s exit-9 diagnostic promises nothing was deleted. A sweep
      // that removed the stale leases of a set holding one live foreign lease
      // and THEN returned the refusal would break that promise. The sweep
      // decides before deleting, so the promise holds and the function's own
      // contract is simply "everything, or nothing".
      const d = stateDirFor("sweep-mixed-refuses");
      const other = liveSession();
      try {
        const stale = leaseRef(d, "999", "wt-0000000000000001");
        putLease(stale, {
          pid: 999_999,
          host: "nowhere",
          platform: "linux",
          worktree: "/tmp/probe-tree",
          startedAt: "2020-01-01T00:00:00.000Z",
          lastSeen: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-01T06:00:00.000Z",
          command: "hold",
        });
        const liveForeign = leaseRef(d, "999", "wt-0000000000000002");
        putLease(liveForeign, {
          pid: other.pid,
          worktree: "/tmp/probe-tree",
          command: "hold",
        });

        const { preservedForeign, removed } = await clearAllLeases(
          d,
          "999",
          null,
        );
        expect(preservedForeign).toHaveLength(1);
        // Nothing was removed — the point this test makes, checked directly
        // against the function's own report as well as against the rows.
        expect(removed).toEqual([]);
        // The stale one is UNTOUCHED — that is the claim `reset` makes.
        expect(readLease(stale)).not.toBeNull();
        expect(readLease(liveForeign)).not.toBeNull();
      } finally {
        other.stop();
      }
    });

    it("CREATING a lease takes the state mutex, not just taking one over", async () => {
      // Scoping the state mutex to TAKEOVERS alone would leave `reset` exposed
      // to a tree it had never seen: a new actor's first claim writes its lease
      // AFTER `clearAllLeases` enumerated, so the sweep reports no live foreign
      // lease, reset deletes the shared state and claims, and the freshly
      // admitted command then runs against reset state with its own lease
      // intact. The rule is "any write that MINTS a new generation takes the
      // state mutex", which covers creation as well as takeover.
      //
      // Modelled by removing the lease mid-stall so the next claim is a
      // CREATION (`held === null`) — the same state a never-seen tree is in —
      // rather than by adding a second worktree, since the cross-tree helper is
      // synchronous and cannot express concurrency.
      //
      // Asserted as completion ORDER, like the takeover case: with the mutex a
      // creation can only finish after the holder releases; without it, it
      // takes no state lock at all and finishes first.
      const d = stateDirFor("create-takes-mutex");
      const holder = liveSession();
      try {
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(holder.pid),
        });

        const done: string[] = [];
        const signal = join(d, "create-is-holding");
        const running = state(d, ["bump-round", "999", "--head", "bbb"], {
          DRIVE_PR_SESSION: String(holder.pid),
          DRIVE_PR_UPDATE_TEST_SIGNAL: signal,
          DRIVE_PR_UPDATE_TEST_DELAY: "3",
        }).then((r) => {
          done.push("holder");
          return r;
        });
        const deadline = Date.now() + 8000;
        while (!existsSync(signal)) {
          if (Date.now() > deadline) throw new Error("never signalled");
          await new Promise((r) => setTimeout(r, 10));
        }

        // No lease for this actor any more: the next claim must CREATE one.
        // `holder`'s pid, not a different one: this probes the PER-PR
        // creation-takes-the-mutex rule in isolation (`held === null` alone
        // already forces `mintsNewGeneration`, regardless of session), and a
        // genuinely different session here would now ALSO collide with
        // `holder`'s still-live TREE lease — a real, separate
        // mechanism this test is not about.
        const ref = leaseRef(d, "999", ACTOR);
        removeLease(ref);

        const creating = state(d, ["bump-round", "999", "--head", "ccc"], {
          DRIVE_PR_SESSION: String(holder.pid),
        }).then((r) => {
          done.push("creator");
          return r;
        });

        // The assertion is about WHEN THE LEASE APPEARS, not about completion
        // order. `bump-round` blocks on the state mutex for its own mutation
        // either way, so both orderings finish holder-then-creator and an
        // order-only probe cannot tell them apart, staying green under
        // mutation. `claimLease` writes the lease only after taking the state
        // mutex, so while the holder still owns it the row must not exist. A
        // claim that skipped the mutex would write it almost immediately,
        // which is precisely how `reset` would miss it.
        await new Promise((r) => setTimeout(r, 1200));
        expect(readLease(ref)).toBeNull();

        await Promise.all([running, creating]);
        expect(done).toEqual(["holder", "creator"]);
        // …and once the mutex frees, the lease really is created.
        expect(readLease(ref)).not.toBeNull();
      } finally {
        holder.stop();
      }
    });

    it("an UNIDENTIFIED reset is blocked by a live lease in its own tree", async () => {
      // Actor equality is a claim about the TREE, not about ownership, and
      // equating the two broke in the case the lease exists for: run `reset`
      // from this checkout with no session identity at all (tier 3 — both
      // `$DRIVE_PR_SESSION` and `$CLAUDE_PID` unset) and `claimLease` admits
      // nothing, yet a real driver's live lease here still has
      // `actor === selfActor`. Treated as "mine, not news", reset would delete
      // the shared state and claims out from under a live driver whose
      // generation is unchanged — so its fence would still pass and its
      // in-flight finding dispatch could be duplicated.
      const d = stateDirFor("reset-unidentified");
      const driver = liveSession();
      try {
        // A live driver in THIS tree.
        await state(d, ["bump-round", "999", "--head", "aaa"], {
          DRIVE_PR_SESSION: String(driver.pid),
        });
        // The tree lease is removed: while it lives, an unidentified caller
        // refuses MUCH earlier, at `claimLease` time (exit 11) — see
        // `checkNoForeignSessionInTree`, which covers this exact scenario.
        // Dropping it isolates the mechanism THIS test actually pins:
        // `clearAllLeases`'s own `isOwn` protection, which remains the last
        // line for a per-PR lease with no accompanying tree lease — a driver
        // whose tree lease independently expired.
        removeTreeLease(treeLeaseRef(d, ACTOR));
        putClaim(d, "999", "held", "FP", newClaimToken());

        // …and a reset with no session identity whatsoever.
        const r = await state(d, ["reset", "999"], {
          DRIVE_PR_SESSION: "",
          CLAUDE_PID: "",
        });
        expect(r.exitCode).toBe(9);
        expect(r.stderr).toContain("refusing to reset");
        expect(r.stderr).toContain(`pid ${driver.pid}`);
        // Nothing shared was deleted underneath the live driver.
        expect(hasState(d, "999")).toBe(true);
        expect(claimRow(d, "999", "held", "FP")).not.toBeNull();
        expect(readLease(leaseRef(d, "999", ACTOR))).not.toBeNull();
      } finally {
        driver.stop();
      }
    });

    it("reset refuses while a claim is LIVE, even one of its own session", async () => {
      // A finding's answer is POSTed outside the state mutex, between claiming
      // and releasing. So the claiming session's own lease is `isOwn` —
      // `clearAllLeases`'s ownership test says "mine, not blocking" — while
      // its dispatch has not landed. Deleting the claim there lets any later
      // command see the finding as unaddressed and answer it again, which is
      // the duplicate top-level comment the claim protocol exists to prevent.
      //
      // Keyed on the CLAIM rather than on ownership, precisely because
      // ownership is what fails to discriminate here: this reset runs under the
      // SAME session that holds the claim, and must still refuse.
      const d = stateDirFor("reset-live-claim");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(d, ["bump-round", "999", "--head", "aaa"], S);
      const token = newClaimToken();
      putClaim(d, "999", "held", "FP", token);

      const r = await state(d, ["reset", "999"], S);
      expect(r.exitCode).toBe(9);
      expect(r.stderr).toContain("live claim");
      expect(claimRow(d, "999", "held", "FP")).not.toBeNull();
      expect(hasState(d, "999")).toBe(true);

      // A STALE claim is not a dispatch in flight, so it must NOT block the
      // reset a human ran to clear exactly that kind of debris. A claim's age
      // is its row's `at`.
      putClaim(
        d,
        "999",
        "held",
        "FP",
        token,
        new Date(Date.now() - 60 * 60_000).toISOString(),
      );
      const second = await state(d, ["reset", "999"], S);
      expect(second.exitCode).toBe(0);
      expect(claimRow(d, "999", "held", "FP")).toBeNull();
    });

    it("reset refused by a live claim still reports a stale lease it already swept", async () => {
      // The mixed case the previous test's own comment flagged as uncovered:
      // `clearAllLeases` runs BEFORE the live-claim check and sweeps stale
      // leases unconditionally on its non-refusing path, so a reset that goes
      // on to refuse on a live claim can still have mutated the lease set,
      // and an unconditional "Nothing has been deleted" would then be false.
      const d = stateDirFor("reset-live-claim-mixed-lease");
      const S = { DRIVE_PR_SESSION: String(process.pid) };
      await state(d, ["bump-round", "999", "--head", "aaa"], S);
      putClaim(d, "999", "held", "FP", newClaimToken());

      // A lease from a session that is definitively gone — stale by both age
      // and a pid nothing owns, same fixture shape as the MIXED-set probe
      // above.
      const stale = leaseRef(d, "999", "wt-0000000000000099");
      putLease(stale, {
        pid: 999_999,
        host: "nowhere",
        platform: "linux",
        worktree: "/tmp/probe-tree",
        startedAt: "2020-01-01T00:00:00.000Z",
        lastSeen: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T06:00:00.000Z",
        command: "hold",
      });

      const r = await state(d, ["reset", "999"], S);
      expect(r.exitCode).toBe(9);
      // Swept, even though the reset as a whole refused.
      expect(readLease(stale)).toBeNull();
      // What the refusal is actually FOR — the state and the live claim —
      // stayed untouched.
      expect(claimRow(d, "999", "held", "FP")).not.toBeNull();
      expect(hasState(d, "999")).toBe(true);
      // The message must not claim nothing was deleted when a lease was.
      expect(r.stderr).not.toContain("Nothing has been deleted");
      expect(r.stderr).toContain("stale session lease");
    });

    it("clear-lease is the way out, and reports the record it overrode", async () => {
      const d = stateDirFor("lease-clear");
      const a = liveSession();
      try {
        await holdAs(d, a.pid, A_URL);
        expect((await holdAs(d, process.pid, B_URL)).exitCode).toBe(11);

        const cleared = await state(d, ["clear-lease", "999"]);
        expect(cleared.exitCode).toBe(0);
        // A human running this is overriding a refusal; the record they are
        // overriding is the evidence for whether that was right.
        expect(cleared.stderr).toContain(`pid ${a.pid}`);

        const now = await holdAs(d, process.pid, B_URL);
        expect(now.exitCode).toBe(0);
        expect(
          JSON.parse((await state(d, ["held", "999"])).stdout),
        ).toMatchObject([{ key: "PRRT_x", commentUrl: B_URL }]);
      } finally {
        a.stop();
      }
    });

    it("never gates a READ — the refused session can still see why", async () => {
      // The session being refused is the one that most needs to inspect the
      // state and the lease. Gating the readers would leave it with nothing but
      // an exit code.
      const d = stateDirFor("lease-reads");
      const a = liveSession();
      try {
        await holdAs(d, a.pid, A_URL);
        const b = { DRIVE_PR_SESSION: String(process.pid) };
        for (const cmd of [
          ["get", "999"],
          ["rounds", "999"],
          ["held", "999"],
          ["held-keys", "999"],
          ["parked-keys", "999"],
          ["verified", "999"],
          ["lease", "999"],
        ]) {
          expect({
            cmd: cmd[0],
            code: (await state(d, cmd, b)).exitCode,
          }).toEqual({ cmd: cmd[0], code: 0 });
        }
        // And `lease` answers with the HOLDER, which is the whole point of
        // being able to read it from the refused side.
        expect(
          JSON.parse((await state(d, ["lease", "999"], b)).stdout),
        ).toMatchObject({ pid: a.pid, actor: ACTOR });
      } finally {
        a.stop();
      }
    });

    it("REFUSES a second WORKTREE driving one PR, with a distinct exit 13", async () => {
      // Per-tree lease scoping serves the Conductor topology per-hold
      // provenance is built for, but it is no reason to let two trees TRIAGE
      // one PR: two worktrees enumerating the same unresolved threads would
      // each reply with its own outcome, so every thread both reached would
      // carry two outcome replies — the same damage as a double dispatch
      // within one tree (seventeen doubled `**accepted**` replies, measured),
      // reached across trees instead.
      //
      // Two REAL worktrees, because the actor is derived and deliberately not
      // overridable: a stand-in would prove the refusal fires on a value the
      // test chose rather than on the topology.
      const { a, b, env } = twoDrivers("lease-cross-tree");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };
        expect(
          drive(a, ea, [
            "hold",
            "999",
            "--key",
            "PRRT_a",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            A_URL,
          ]).exitCode,
        ).toBe(0);
        const fromB = drive(b, eb, [
          "hold",
          "999",
          "--key",
          "PRRT_b",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          B_URL,
        ]);
        // 13, not 11: a caller must be able to tell "another session in YOUR
        // tree" from "another tree entirely" without parsing prose, because
        // the remedies differ.
        expect(fromB.exitCode).toBe(13);
        expect(fromB.stderr).toContain("ANOTHER working tree");
        // Actionable: it names the holder's session AND a place a human can go.
        // The actor is a sha256 prefix, so a refusal carrying only that tells
        // the reader which tree in the one form they cannot act on.
        expect(fromB.stderr).toContain(`pid ${sessionA.pid}`);
        // `gitPathOf`, because git's `--show-toplevel` resolves symlinks and
        // the macOS temp root is one (`/var` → `/private/var`). Comparing the
        // unresolved path passes on Linux and fails here for a reason that has
        // nothing to do with the behaviour under test.
        expect(fromB.stderr).toContain(gitPathOf(a));
        expect(fromB.stderr).toContain("clear-lease 999 --all");

        // NOTHING was written by the refused tree — not the hold, and not a
        // lease of its own. A refusal that installed a lease would leave one
        // this session's next command fast-paths off without ever re-reaching
        // the gate, which would make the whole admission model decorative.
        const held = JSON.parse(drive(a, ea, ["held", "999"]).stdout);
        expect(held.map((h: { key: string }) => h.key)).toEqual(["PRRT_a"]);
        const leases = JSON.parse(
          drive(a, ea, ["lease", "999", "--all"]).stdout,
        );
        expect(leases).toHaveLength(1);
      } finally {
        sessionA.stop();
      }
    });

    it("refuses a SESSIONLESS tree too — taking a lease needs an identity, checking one does not", async () => {
      // A ladder tier 3 that returned before the PR-wide gate ran would let a
      // runtime that identifies no session mutate straight through it — and
      // two such resolvers in two worktrees would still produce the doubled
      // outcome replies this module exists to prevent. Taking a lease
      // and reading someone else's are different capabilities, and only the
      // first needs an identity.
      const { a, b, env } = twoDrivers("lease-cross-tree-sessionless");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        expect(
          drive(a, ea, ["bump-round", "999", "--head", "aaa"]).exitCode,
        ).toBe(0);

        // No session identity at all: BOTH variables unset, which is what tier
        // 3 actually is — not merely an unusable value.
        const sessionless = { ...env, DRIVE_PR_SESSION: "", CLAUDE_PID: "" };
        const fromB = drive(b, sessionless, [
          "phase",
          "999",
          "--set",
          "triage",
        ]);
        expect(fromB.exitCode).toBe(13);
        expect(fromB.stderr).toContain("ANOTHER working tree");

        // A REFUSED tree installs nothing — which is a claim about the
        // refusal, not about tier 3: a sessionless caller that is ADMITTED
        // does leave a record (see the two-sessionless probe
        // below). Refusing first and writing second is what keeps that true;
        // the reverse order would leave a refused tree holding a live record
        // its own next command would fast-path off. Asserted through the read
        // surface because these two worktrees share the CLONE-WIDE state dir
        // that `twoDrivers` deliberately leaves unset: only A's lease exists.
        const leases = JSON.parse(
          drive(a, ea, ["lease", "999", "--all"]).stdout,
        );
        expect(leases).toHaveLength(1);
        expect(leases[0].self).toBe(true);

        // And the refusal is not blanket: with A gone, the same sessionless
        // invocation is admitted. Otherwise this test would pass against a gate
        // that simply refuses every sessionless caller.
        sessionA.stop();
        await awaitPidGone(sessionA.pid);
        expect(
          drive(b, sessionless, ["phase", "999", "--set", "triage"]).exitCode,
        ).toBe(0);
      } finally {
        sessionA.stop();
      }
    });
  });
});
