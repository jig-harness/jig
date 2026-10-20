/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { claimPathFor, newClaimToken } from "../scripts/lib/state/claims";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";
import { createStateProvenanceFixtures } from "./drive-pr-state-provenance-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state, twoDrivers, drive, liveSession, awaitPidGone } =
    stateDurabilityFixtures;
  describe("per-hold push provenance across drivers", () => {
    const stateProvenanceFixtures = createStateProvenanceFixtures(
      stateDurabilityFixtures,
    );
    const { A_PUSH, B_PUSH, handOver } = stateProvenanceFixtures;

    it("refuses to resolve driver A's held thread against driver B's unrelated push — the acceptance probe", async () => {
      const { a, b, env } = twoDrivers("provenance-cross-resolve");
      // Round 1. Driver A triages, replies `**accepted**`, holds — and then
      // stalls before pushing its own fix.
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(a, env, [
        "hold",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/driver-a-reply",
      ]);
      // Driver A stops driving; driver B picks the PR up from its own worktree,
      // finishes unrelated work and pushes. No counting drive-status gate runs
      // (SKILL.md § 6's own post-push wait passes --no-count), so `.rounds`
      // does not move either.
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);
      // And hands back, so A's retry below is an admitted command rather than
      // a refusal at the gate — which would pass this probe for the wrong
      // reason, never reaching the provenance check it is about.
      handOver(b, env);

      // The round is unchanged, while the intermediate push deliberately does
      // not advance the final-CI-only PR-global pointer.
      expect(drive(a, env, ["rounds", "999"]).stdout.trim()).toBe("1");
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");

      // A's worktree later syncs to that head and retries.
      const claim = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--pushed-sha",
        B_PUSH,
      ]);
      expect(claim.exitCode).toBe(1);
      expect(claim.stderr).toContain("is not the push recorded against");
      // Refused, not consumed: the reply still stands and the item is still
      // there for the push that actually carries its fix.
      expect(drive(a, env, ["held-keys", "999"]).stdout.trim()).toBe("PRRT_x");

      // And the legitimate path still works, so this is a real gate rather
      // than a wedge: once A itself pushes and records it, the same claim
      // succeeds.
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      const ok = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "PRRT_x",
        "--kind",
        "thread",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(drive(a, env, ["held-keys", "999"]).stdout.trim()).toBe("");
    });

    it("stamp-held stamps only the caller's OWN holds, and the two drivers get distinct actors", async () => {
      // The state-level statement of the same property, and the one that shows
      // WHY the claim above refuses: two `stamp-held` calls from different
      // actors against one shared batch must leave two differently-stamped
      // items, not one pointer both read.
      const { a, b, env } = twoDrivers("provenance-scoped-stamp");
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(a, env, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/a-reply",
      ]);
      handOver(a, env);
      drive(b, env, [
        "hold",
        "999",
        "--key",
        "PRRT_b",
        "--kind",
        "thread",
        "--outcome",
        "moot",
        "--comment-url",
        "https://example.invalid/b-reply",
      ]);
      handOver(b, env);
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);

      const held: Array<{
        key: string;
        actor: string;
        verifiedSha?: string;
      }> = JSON.parse(drive(a, env, ["held", "999"]).stdout);
      const byKey = Object.fromEntries(held.map((h) => [h.key, h]));
      expect(byKey.PRRT_a?.verifiedSha).toBe(A_PUSH);
      expect(byKey.PRRT_b?.verifiedSha).toBe(B_PUSH);
      // Two worktrees, two identities — derived from the tree, so this is the
      // real mechanism and not a value the test handed the script.
      expect(byKey.PRRT_a?.actor).not.toBe(byKey.PRRT_b?.actor);
      // Intermediate pushes cannot move the final-CI-only PR-global pointer.
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");
    });

    it("refuses driver A's held FINDING against driver B's push too — the same defect, the more dangerous kind", async () => {
      // A finding needed this more than a thread did, not less:
      // `answer-summary-finding.ts` checks only that --pushed-sha is the PR's
      // live head and a clean local HEAD, which a concurrent driver's push
      // satisfies perfectly — and its dispatch is NOT idempotent, so a wrong
      // answer is a permanent, standing claim on the PR.
      const { a, b, env } = twoDrivers("provenance-cross-finding");
      drive(a, env, ["bump-round", "999", "--head", "aaa"]);
      drive(
        a,
        env,
        [
          "hold",
          "999",
          "--key",
          "f00d",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        "fixed the thing A promised",
      );
      handOver(a, env);
      drive(b, env, ["stamp-held", "999", "--sha", B_PUSH]);
      handOver(b, env);
      expect(drive(a, env, ["verified", "999"]).stdout.trim()).toBe("");

      const claim = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--pushed-sha",
        B_PUSH,
      ]);
      expect(claim.exitCode).toBe(1);
      expect(claim.stderr).toContain("is not the push recorded against");
      // The mutex must be given back on this path, not left holding the key:
      // a refusal that leaked its claim file would block the legitimate claim
      // below for a whole staleness window.
      drive(a, env, ["stamp-held", "999", "--sha", A_PUSH]);
      const ok = drive(a, env, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).not.toBe("");
    });

    it("two actors' holds coexist by TAKEOVER, not by concurrency", async () => {
      // The reachability argument for the tier-3 probes above, run for real.
      //
      // Two worktrees cannot drive one PR at the same time — so if that were
      // the only way two actors' holds could land in one state file,
      // per-hold provenance would be guarding an impossible state and
      // could be deleted. It is not. A hold deliberately OUTLIVES its driver
      // (SKILL.md § 6), so the state arrives sequentially: A holds and its
      // session dies, B is admitted precisely because A's lease is no longer
      // live, and A's unstamped promise is still sitting there for B's
      // `stamp-held` to wrongly vouch for. Both mechanisms are load-bearing
      // at once, and this is the probe that says so.
      const { a, b, env } = twoDrivers("provenance-after-takeover");
      const sessionA = liveSession();
      try {
        const ea = { ...env, DRIVE_PR_SESSION: String(sessionA.pid) };
        const eb = { ...env, DRIVE_PR_SESSION: String(process.pid) };

        drive(a, ea, ["bump-round", "999", "--head", "aaa"]);
        drive(a, ea, [
          "hold",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/driver-a-reply",
        ]);
        // B is refused while A is live — the control, so the takeover below is
        // a takeover rather than a gate that never fired.
        expect(
          drive(b, eb, ["stamp-held", "999", "--sha", B_PUSH]).exitCode,
        ).toBe(13);

        // A's session dies. Its HOLD survives, which is the whole premise.
        sessionA.stop();
        await awaitPidGone(sessionA.pid);
        expect(drive(b, eb, ["held-keys", "999"]).stdout.trim()).toBe("PRRT_x");

        // B is now legitimately admitted, and pushes unrelated work.
        expect(
          drive(b, eb, ["stamp-held", "999", "--sha", B_PUSH]).exitCode,
        ).toBe(0);
        expect(drive(b, eb, ["verified", "999"]).stdout.trim()).toBe("");

        // B's push must NOT have vouched for A's stranded promise: the stamp
        // is per-hold and scoped to the calling tree, so A's item is still
        // unstamped and B may not resolve it on this SHA.
        const held: Array<{ key: string; verifiedSha?: string }> = JSON.parse(
          drive(b, eb, ["held", "999"]).stdout,
        );
        expect(held).toHaveLength(1);
        expect(held[0]?.verifiedSha).toBeUndefined();
        const claim = drive(b, eb, [
          "claim-held",
          "999",
          "--key",
          "PRRT_x",
          "--kind",
          "thread",
          "--pushed-sha",
          B_PUSH,
        ]);
        expect(claim.exitCode).toBe(1);
        expect(claim.stderr).toContain("is not the push recorded against");
      } finally {
        sessionA.stop();
      }
    });

    it("a claim of a held finding without --pushed-sha is a usage error, not a mutex-only claim", async () => {
      // The check is worthless if the flag carrying it is optional — a caller
      // that omits it would silently get the old, unguarded behaviour.
      const d = stateDirFor("provenance-finding-requires-sha");
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
        "reason",
      );
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("requires --pushed-sha");
      // And it refused BEFORE taking the mutex — a usage error that left a
      // claim file behind would block the corrected retry.
      expect(
        readdirSync(d).filter((f) => f.includes("held-claim")),
      ).toHaveLength(0);
    });

    it("re-holding a key CLEARS its stamp, so an earlier push cannot answer a later promise", async () => {
      // The ordering hold → push → resolve, made structural. A reply posted
      // now promises a fix that is not pushed yet by definition, so the only
      // push that may answer it is a later one; carrying a previous hold's
      // stamp forward would let this reply inherit provenance from a push that
      // predates the promise it makes.
      const d = stateDirFor("provenance-rehold-clears");
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
        "https://example.invalid/first-reply",
      ]);
      await state(d, ["stamp-held", "999", "--sha", A_PUSH]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout)[0].verifiedSha,
      ).toBe(A_PUSH);

      // Step 3 of a later pass re-holds the same key against a NEW reply.
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
        "https://example.invalid/second-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout)[0].verifiedSha,
      ).toBeUndefined();
      const r = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--pushed-sha",
        A_PUSH,
      ]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the push recorded against");
    });

    it("restore-held demands the provenance back verbatim rather than re-deriving it", async () => {
      // Re-deriving the actor would stamp the RESTORING tree, which is the same
      // tree on every path that exists today — and would hand one driver's hold
      // to another the first time it is not, which is the cross-resolve this
      // whole mechanism exists to prevent.
      const d = stateDirFor("provenance-restore-required");
      const base = [
        "restore-held",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--round",
        "0",
        "--comment-url",
        "https://example.invalid/restored",
      ];
      const noActor = await state(d, [...base, "--verified-sha", A_PUSH]);
      expect(noActor.exitCode).toBe(2);
      expect(noActor.stderr).toContain("requires --actor");

      const noSha = await state(d, [...base, "--actor", ACTOR]);
      expect(noSha.exitCode).toBe(2);
      expect(noSha.stderr).toContain("requires --verified-sha");

      // The exact `claim-held`-printed shape is required, not merely
      // "no newline" — a hand-composed value that names a DIFFERENT worktree,
      // or that carries a backtick/pipe rather than a newline, is just as
      // dangerous: the former lets that worktree's `stamp-held` vouch for
      // this hold, and the latter breaks the handoff's markdown table (both
      // fields render inside backtick code spans) exactly as a newline would
      // split its row.
      for (const [flag, value] of [
        ["--actor", `${ACTOR}\nwt-someone-else`],
        ["--verified-sha", `${A_PUSH}\r| forged | row |`],
        // No newline at all — the class the CR/LF-only check used to miss.
        ["--actor", "wt-aaaaaaaaaaaaaaaa|forged"],
        ["--verified-sha", `${A_PUSH}\`| forged |`],
      ] as const) {
        const args = [...base, "--actor", ACTOR, "--verified-sha", A_PUSH];
        args[args.indexOf(flag) + 1] = value;
        const bad = await state(d, args);
        expect({ flag, exit: bad.exitCode }).toEqual({ flag, exit: 2 });
        expect(bad.stderr).toContain(`restore-held: ${flag} must be`);
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");

      const ok = await state(d, [
        ...base,
        "--actor",
        ACTOR,
        "--verified-sha",
        A_PUSH,
      ]);
      expect(ok.exitCode).toBe(0);
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/restored",
          actor: ACTOR,
          verifiedSha: A_PUSH,
        },
      ]);
    });

    it("refuses a held entry with no actor at all, rather than reading it as unowned", async () => {
      // A hand-edited or older file. An unattributable hold is one
      // `stamp-held` has no basis to skip, so tolerating it would mean
      // falling back to vouching for everything — the PR-global behaviour this
      // closes. Backward compatibility is deferred pre-GA, so the file is
      // refused, never silently migrated.
      const d = stateDirFor("provenance-actorless-refused");
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
          lastProgressAt: "",
          quotaPark: null,
          rounds: 1,
          lastCountedHead: "aaa",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          verifiedSha: A_PUSH,
          phase: "",
          parked: [],
          held: [
            {
              key: "PRRT_a",
              kind: "thread",
              outcome: "accepted",
              round: 1,
              commentUrl: "https://example.invalid/legacy",
            },
          ],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).toBe(3);
      expect(r.stdout).toBe("");
    });

    it("re-holding a FINDING breaks its own STALE claim file, so the fresh record is stampable again", async () => {
      // The gap: `hold` inserts a fresh `.held` record
      // carrying no `verifiedSha`, but a finding's claim is a SEPARATE
      // filesystem file `hold` never touched — so a prior dispatch's claim
      // file, left behind by the interrupted-dispatch scenario the test above
      // covers, would make `stamp-held`'s own
      // `existsSync(claimPathFor(...))` check refuse to stamp the fresh
      // record forever, defeating the "re-hold via SKILL.md § 3" recovery
      // this command exists to provide.
      const SHA_OLD = "5555555555555555555555555555555555555555";
      const SHA_NEW = "6666666666666666666666666666666666666666";
      const d = stateDirFor("rehold-finding-breaks-stale-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dstale",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dstale",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      // The dispatch "died" here without releasing — the claim file is left
      // on disk, backdated past the staleness window (matching every other
      // stale-claim probe in this file).
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.f00dstale."),
      );
      if (!claimFile) throw new Error("claim file was not created");
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(join(d, claimFile), twentyMinutesAgo, twentyMinutesAgo);

      // Re-hold, per SKILL.md § 3 — this must break the now-stale claim file
      // as part of creating the fresh record.
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dstale",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "confirmed fixed in def5678",
      );
      expect(existsSync(join(d, claimFile))).toBe(false);

      // The push that carries the RE-held promise now stamps successfully...
      await state(d, ["stamp-held", "999", "--sha", SHA_NEW]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dstale", verifiedSha: SHA_NEW }]);
      // ...and the recovery actually completes: a fresh claim against that
      // push succeeds, where before this fix it would have refused forever.
      const reclaim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dstale",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_NEW,
      ]);
      expect(reclaim.exitCode).toBe(0);
    });

    it("re-holding a FINDING refuses while its claim is still LIVE — an in-flight dispatch must not be undercut", async () => {
      const SHA_OLD = "9999999999999999999999999999999999999999";
      const d = stateDirFor("rehold-finding-refuses-live-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dlive",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      await state(d, ["stamp-held", "999", "--sha", SHA_OLD]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "f00dlive",
        "--kind",
        "finding",
        "--pushed-sha",
        SHA_OLD,
      ]);
      expect(claim.exitCode).toBe(0);
      // No backdating this time — the claim is fresh, i.e. genuinely live.
      const claimFile = readdirSync(d).find((f) =>
        f.startsWith("drive-pr-999.held-claim.f00dlive."),
      );
      if (!claimFile) throw new Error("claim file was not created");

      const rehold = await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00dlive",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "confirmed fixed in def5678",
      );
      expect(rehold.exitCode).toBe(1);
      expect(rehold.stderr).toContain("has a LIVE claim");
      // Refused, not silently swallowed: the live claim file is untouched,
      // and the ORIGINAL held record (still stamped SHA_OLD) still stands.
      expect(existsSync(join(d, claimFile))).toBe(true);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00dlive", verifiedSha: SHA_OLD }]);
    });

    it("stamp-held stamps an UNSTAMPED finding even while a concurrent (about-to-fail) claim-held attempt has a claim file open on it", async () => {
      // The race: `claimFinding` creates its claim file BEFORE acquiring the
      // state lock and validating anything (deliberate — see claims.ts's own
      // doc comment on why the claim precedes the check). If a driver's
      // FIRST-EVER `stamp-held` for a brand-new hold lands while that raw,
      // unvalidated claim file happens to exist, the OLD guard treated mere
      // file existence as "already dispatched" and skipped stamping — even
      // though a claim over an unstamped item can only ever be a claim still
      // in flight (claim-held refuses whenever item.verifiedSha !==
      // --pushed-sha, and an absent stamp can never satisfy that), never a
      // completed dispatch. Simulated directly rather than via a real
      // concurrent claim-held call: a real one would validate-and-fail-and-
      // clean-up in one synchronous pass, never leaving the file behind long
      // enough to race — the raw file is exactly the state a REAL race
      // leaves mid-flight, for the instant between claimCreate and the
      // failing claimant's own lock acquisition.
      const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const d = stateDirFor("stamp-held-stamps-through-unvalidated-claim");
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "f00drace",
          "--kind",
          "finding",
          "--outcome",
          "accepted",
        ],
        {},
        "fixed in abc1234",
      );
      // No stamp-held yet — this hold has never been stamped.
      const racingClaimPath = claimPathFor(d, "999", "f00drace");
      writeFileSync(racingClaimPath, newClaimToken(), { flag: "wx" });

      await state(d, ["stamp-held", "999", "--sha", SHA]);

      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "f00drace", verifiedSha: SHA }]);
    });
  });
});
