/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { SCRIPTS, ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { exceptOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;
  describe("the held batch", () => {
    // The window between replying `**accepted**` and resolving the thread after
    // the push. That list used to live only in the agent's context, so anything
    // that ended the context inside the window dropped it — silently, and in
    // both directions: a fixed finding re-triaged next round as unfixed, or a
    // second outcome token on a thread that already carries one. `--handoff-at
    // never` expects a compaction there by design, which is why it does not
    // ship without these.

    it("survives a pass KILLED between the reply and the resolve", async () => {
      // The acceptance probe. Model the round exactly: the pass records its
      // holds at reply time, then dies before step 6 ever runs. A fresh process
      // — which is what a successor, or the agent after a compaction, is — must
      // recover the batch from state rather than re-deriving or dropping it.
      //
      // SIGKILL, not a clean exit: an EXIT trap could otherwise be what makes
      // this pass, and a compacted agent fires no traps.
      const d = stateDirFor("held-killed");
      const holder = Bun.spawn(
        [
          "bash",
          "-c",
          [
            `"${join(SCRIPTS, "drive-state.ts")}" hold 999 --key PRRT_a --kind thread --outcome accepted --comment-url https://example.invalid/killed-pass-reply`,
            `"${join(SCRIPTS, "drive-state.ts")}" hold 999 --key f00d --kind finding --outcome moot <<'REASON_EOF'`,
            "code already gone, superseded by round 2",
            "REASON_EOF",
            // …and the pass dies here, before it resolves anything.
            "kill -9 $$",
          ].join("\n"),
        ],
        {
          env: { ...process.env, DRIVE_PR_STATE_DIR: d },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await holder.exited;
      // Killed by SIGKILL where signals exist. On Windows, Git Bash's
      // `kill -9 $$` ends the shell with status 0, so there the recovery
      // below is the only check.
      exceptOnWindows("Git Bash's kill -9 $$ exits 0 on Windows", () =>
        expect(holder.signalCode !== null || holder.exitCode !== 0).toBe(true),
      );

      const recovered = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(recovered).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/killed-pass-reply",
          // Recorded at hold time, on both kinds: which driver is promising
          // this fix. No `verifiedSha` — the killed pass never pushed, which is
          // exactly the state a hold starts in.
          actor: ACTOR,
        },
        {
          key: "f00d",
          kind: "finding",
          outcome: "moot",
          round: 0,
          // The trailing newline survives — same deliberate preservation
          // reply-to-thread.ts's own body handling uses, not truncation.
          reason: "code already gone, superseded by round 2\n",
          actor: ACTOR,
        },
      ]);
    });

    it("records the KIND, because it decides which script releases the item", async () => {
      // A thread is resolved with resolve-thread.ts; a summary finding is
      // answered with answer-summary-finding.ts --pushed-sha. A successor that
      // has to guess gets one of them wrong, and the wrong guess on a finding
      // leaves it blocking convergence forever.
      const d = stateDirFor("held-kind");
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
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)[0].kind).toBe(
        "finding",
      );
    });

    it("refuses to hold a DURABLE outcome", async () => {
      // `rejected` / `wont-fix` / `deferred` are claims about the finding's
      // MERIT, which no later commit changes, so they are replied to AND
      // resolved in the same step. Holding one records a thread that is already
      // resolved, which step 6 then tries to resolve again.
      const d = stateDirFor("held-outcome");
      for (const outcome of ["rejected", "wont-fix", "deferred", ""]) {
        const r = await state(d, [
          "hold",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "thread",
          "--outcome",
          outcome,
          "--comment-url",
          "https://example.invalid/synthetic-comment-1",
        ]);
        expect({ outcome, exit: r.exitCode }).toEqual({ outcome, exit: 2 });
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("requires a --kind, like park does", async () => {
      const d = stateDirFor("held-nokind");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--outcome",
        "accepted",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--kind thread|finding");
    });

    it("requires the reason body on stdin for a `finding` hold, unlike `thread`", async () => {
      // A thread's reply is already posted to GitHub by hold time (the
      // reply-to-thread.ts call that precedes this one), so its text survives
      // independently. A finding's answer can't be posted until step 6, after
      // the push — so at hold time the reasoning exists nowhere but the
      // triaging agent's own context, and a crash before the push would lose
      // it entirely without this.
      const d = stateDirFor("held-finding-noreason");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--outcome",
        "accepted",
      ]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("reason body on stdin");
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");

      // A `thread` hold needs no stdin at all and carries no `reason` field.
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
        "https://example.invalid/synthetic-comment-2",
      ]);
      const held = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(held).toEqual([
        {
          key: "PRRT_a",
          kind: "thread",
          outcome: "accepted",
          round: 0,
          commentUrl: "https://example.invalid/synthetic-comment-2",
          actor: ACTOR,
        },
      ]);
    });

    it("re-holding one key updates it instead of duplicating it", async () => {
      const d = stateDirFor("held-dupe");
      for (const outcome of ["accepted", "moot"]) {
        await state(d, [
          "hold",
          "999",
          "--key",
          "PRRT_a",
          "--kind",
          "thread",
          "--outcome",
          outcome,
          "--comment-url",
          "https://example.invalid/synthetic-comment-3",
        ]);
      }
      const held = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(held).toHaveLength(1);
      expect(held[0].outcome).toBe("moot");
    });

    it("releases one key, or the whole batch — but never on a bare invocation", async () => {
      // `--all` is explicit on purpose. A typo'd `--key` silently falling back
      // to "clear everything" drops the very items the batch exists to
      // remember, which is the failure this command was added to close.
      const d = stateDirFor("held-release");
      for (const key of ["PRRT_a", "PRRT_b"]) {
        await state(d, [
          "hold",
          "999",
          "--key",
          key,
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/synthetic-comment-4",
        ]);
      }
      const bare = await state(d, ["release-held", "999"]);
      expect(bare.exitCode).toBe(2);
      expect((await state(d, ["held-keys", "999"])).stdout.split("\n")).toEqual(
        ["PRRT_a", "PRRT_b"],
      );

      await state(d, ["release-held", "999", "--key", "PRRT_a"]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_b");

      await state(d, ["release-held", "999", "--all"]);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("SERIALISES concurrent release-held --key calls so none is silently dropped", async () => {
      // The existence check and the removal used to run as two separate
      // steps — a precheck before `update_state`'s own lock acquisition —
      // which reopened the exact TOCTOU the mutex exists to close elsewhere:
      // a release for key A racing a release for key B could interleave
      // between A's check and A's write. Holding the lock continuously
      // across the check and the write (not two separate acquisitions)
      // closes it; six concurrent releases for six distinct real keys must
      // all succeed and the batch must end up completely empty, not missing
      // a write or resurrecting one that already happened.
      const d = stateDirFor("release-held-concurrent");
      for (let i = 0; i < 6; i++) {
        await state(d, [
          "hold",
          "999",
          "--key",
          `PRRT_${i}`,
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/synthetic-comment-5",
        ]);
      }
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          state(d, ["release-held", "999", "--key", `PRRT_${i}`]),
        ),
      );
      for (const r of results) {
        expect(r.exitCode).toBe(0);
      }
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("");
    });

    it("refuses to silently no-op releasing a key that is not held", async () => {
      // A typo'd or already-released `--key` used to succeed with exit 0 and
      // an unchanged batch — indistinguishable from a real release. The caller
      // believes the real item is gone; for a `finding`, the next thing that
      // happens on that wrong belief is a second, non-idempotent
      // `answer-summary-finding.ts` post on a later round.
      const d = stateDirFor("held-release-typo");
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
        "https://example.invalid/synthetic-comment-6",
      ]);
      const r = await state(d, ["release-held", "999", "--key", "PRRT_typo"]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no held item with key");
      // The real held item is untouched.
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("refuses --key and --all together rather than guessing", async () => {
      const d = stateDirFor("held-both");
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
        "https://example.invalid/synthetic-comment-7",
      ]);
      const r = await state(d, [
        "release-held",
        "999",
        "--key",
        "PRRT_a",
        "--all",
      ]);
      expect(r.exitCode).toBe(2);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_a");
    });

    it("a malformed state file blocks a hold, so nothing is built on it", async () => {
      const d = stateDirFor("held-malformed");
      writeFileSync(join(d, "drive-pr-999.json"), "not json at all");
      const r = await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-8",
      ]);
      expect(r.exitCode).not.toBe(0);
    });

    it("rejects a well-formed array of ILL-SHAPED held entries, not just non-arrays", async () => {
      // `.held` being an array was not enough: an empty key, a `kind` outside
      // thread|finding, or a missing `round` all satisfied "array" while
      // being unusable by `held-keys`/`release-held`/step 6. Only a
      // hand-edited or externally-corrupted file can reach this shape — every
      // writer here (`hold`) already enforces it — but a state file that
      // parses and passes the shape check is treated as trustworthy, so the
      // check has to actually cover the shape.
      const d = stateDirFor("held-ill-shaped");
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
          held: [{ key: "", kind: "bogus", outcome: "rejected" }],
        }),
      );
      const r = await state(d, ["held-keys", "999"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("not usable drive state");
    });

    it("the refusal message NAMES every field the predicate requires", async () => {
      // That message says of itself: "This list is exhaustive on purpose: it
      // is the only thing that tells a reader WHICH field is missing." Nothing
      // enforced it, so it drifted the moment a field was added —
      // `readyMarkedRound` was checked by the
      // predicate and absent from the message, so a file missing exactly that
      // field got a diagnostic listing only the fields it *did* have
      // (measured). A hand-written tally standing in for "only the fields it
      // did have" would itself be a hand-maintained count that drifts.
      //
      // Derived from BEHAVIOUR, not from a second hand-maintained list, which
      // would drift the same way: drop each field in turn from a known-good
      // state, confirm the predicate actually rejects it, and only then
      // require the message to name it. A field the predicate stops caring
      // about drops out of this test automatically.
      const complete: Record<string, unknown> = {
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
      // THE BASELINE IS THE MUTATION. `complete` is hand-written, so if
      // production adds a required field that this fixture AND the message
      // both omit, every deletion case below is rejected for the wrong reason
      // (the missing new field), the assertions only ever inspect the old
      // names, and the test stays green while proving nothing — the vacuity
      // this whole test exists to prevent, reached through its own fixture
      //. Asserting the untouched fixture is
      // ACCEPTED is what turns that into a red: a new required field fails
      // here first, and names itself in the refusal it triggers.
      const baseDir = stateDirFor("msg-names-baseline");
      writeFileSync(
        join(baseDir, "drive-pr-999.json"),
        JSON.stringify(complete),
      );
      expect((await state(baseDir, ["held-keys", "999"])).exitCode).toBe(0);

      const unnamed: string[] = [];
      for (const field of Object.keys(complete)) {
        // `pr` is named by number rather than by key ("this PR's number"), so
        // it is the one field the message identifies differently.
        if (field === "pr") continue;
        const d = stateDirFor(`msg-names-${field}`);
        const partial = { ...complete };
        delete partial[field];
        writeFileSync(join(d, "drive-pr-999.json"), JSON.stringify(partial));
        const res = await state(d, ["held-keys", "999"]);
        // Guard against a vacuous pass: if dropping the field is ACCEPTED,
        // there is no refusal message to inspect and this field proves
        // nothing either way.
        if (res.exitCode === 0) continue;
        if (!res.stderr.includes(field)) unnamed.push(field);
      }
      expect(unnamed).toEqual([]);
    });

    it("the refusal message names every NESTED field the predicate requires", async () => {
      // The exhaustiveness claim covers `parked` and `held` ENTRIES too, and
      // the top-level sweep above cannot reach them: it deletes whole
      // containers, so removing `commentUrl` or `outcome` from the message
      // left that test green while a file missing exactly those fields got a
      // diagnostic that named neither. Nested
      // entries are where the message earns its keep — a state file whose
      // top-level keys all look fine is precisely the one a reader cannot
      // diagnose unaided.
      //
      // Derived from behaviour, exactly as above: mutate one nested field at a
      // time out of a known-good record, require the predicate to reject it,
      // and only then require the message to name it.
      const actor = "wt-0123456789abcdef";
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
        parked: [
          {
            key: "PRRT_park",
            kind: "thread",
            reason: "awaiting a human",
            round: 1,
          },
        ],
        held: [
          {
            key: "PRRT_thread",
            kind: "thread",
            outcome: "accepted",
            round: 1,
            commentUrl: "https://example.invalid/#discussion_r1",
            actor,
          },
          {
            key: "fingerprint0001",
            kind: "finding",
            outcome: "moot",
            round: 1,
            reason: "the anchored code was rewritten",
            actor,
          },
        ],
      };
      // Every required field of every nested entry, by container and index —
      // one case per field, so a message that names some but not others fails
      // on exactly the ones it omits.
      const cases: Array<{
        container: "parked" | "held";
        index: number;
        field: string;
      }> = [];
      for (const field of Object.keys(base.parked[0] ?? {})) {
        cases.push({ container: "parked", index: 0, field });
      }
      for (const [index, entry] of base.held.entries()) {
        for (const field of Object.keys(entry)) {
          cases.push({ container: "held", index, field });
        }
      }
      // Same baseline mutation as the top-level test above, and needed for the
      // same reason: `base` is hand-written, so a newly required nested field
      // absent from BOTH it and the message would have every case below
      // rejected for that field instead of the one under test, with the
      // assertions none the wiser. A fixture that
      // is not itself accepted proves nothing about which deletion caused a
      // refusal.
      const baseDir = stateDirFor("msg-nested-baseline");
      writeFileSync(join(baseDir, "drive-pr-999.json"), JSON.stringify(base));
      expect((await state(baseDir, ["held-keys", "999"])).exitCode).toBe(0);

      const unnamed: string[] = [];
      const accepted: string[] = [];
      for (const { container, index, field } of cases) {
        const label = `${container}[${index}].${field}`;
        const d = stateDirFor(`msg-nested-${container}-${index}-${field}`);
        const partial = JSON.parse(JSON.stringify(base)) as Record<
          string,
          unknown
        >;
        const entries = partial[container] as Array<Record<string, unknown>>;
        delete entries[index]?.[field];
        writeFileSync(join(d, "drive-pr-999.json"), JSON.stringify(partial));
        const res = await state(d, ["held-keys", "999"]);
        // Not the vacuous-pass SKIP the top-level sweep uses: every field here
        // is one `isUsableState` demands, so an accepted deletion is a
        // predicate regression and must fail this test rather than drop out of
        // it silently.
        if (res.exitCode === 0) {
          accepted.push(label);
          continue;
        }
        if (!res.stderr.includes(field)) unnamed.push(label);
      }
      expect(accepted).toEqual([]);
      expect(unnamed).toEqual([]);
    });

    it("re-checks the durable mark AFTER winning the lease, not only before", async () => {
      // The read and the `claimCreate` are not one atomic step. A caller can
      // read `readyMarkedRound === 0`, be pre-empted for arbitrarily long, and
      // resume only after some OTHER caller has committed the mark AND released
      // its lease — at which point this caller's create succeeds against a
      // now-vacant path and its driver fires a second `gh pr ready`, which is
      // the duplicate paid review the lease exists to prevent.
      //
      // The commit landing during the gap is what makes this deterministic:
      // it strictly happens-before the release that frees the path, which
      // strictly happens-before this create can succeed, so a plain re-read is
      // guaranteed to observe it — no lock needed on this half.
      const d = stateDirFor("ready-claim-recheck");
      const signal = join(d, "claim-read-done");
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "drive-state.ts"), "claim-ready-mark", "999"),
        {
          env: {
            ...process.env,
            DRIVE_PR_STATE_DIR: d,
            DRIVE_PR_CLAIM_READY_TEST_SIGNAL: signal,
            DRIVE_PR_CLAIM_READY_TEST_DELAY: "2",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(signal)) {
        if (Date.now() > deadline)
          throw new Error("claim signal never appeared");
        await Bun.sleep(10);
      }
      // The other driver commits and releases while this one is pre-empted.
      writeFileSync(
        join(d, "drive-pr-999.json"),
        JSON.stringify({
          pr: 999,
          rounds: 0,
          lastCountedHead: "",
          attempts: 0,
          attemptsHead: "",
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          readyMarkedRound: 3,
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
        }),
      );
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(stdout.trim()).toBe("already");
      // And it left no lease behind for a later caller to trip over.
      expect(existsSync(join(d, "drive-pr-999.ready-claim"))).toBe(false);
    });

    it("never destroys a ready-mark lease generation it does not own", async () => {
      // The cross-generation delete: an owner returning at the edge of the
      // staleness window passes its own token check, and a DIFFERENT driver
      // legitimately breaks that stale claim and writes a fresh one in the gap
      // before the removal runs — so the removal deletes the successor's file,
      // not the one this caller ever owned, and that successor (which has
      // already read `readyMarkedRound === 0`) can proceed as a second winner.
      //
      // Under one lock hold the check and the removal cannot be interleaved,
      // so a token that no longer matches never reaches a removal at all. That
      // is the property here, and it is deterministic: replacing the token IS
      // the successor's reclaim, minus the timing.
      for (const cmd of ["commit-ready-mark", "release-ready-mark"]) {
        const d = stateDirFor(`ready-lease-generation-${cmd}`);
        const lease = join(d, "drive-pr-999.ready-claim");
        writeFileSync(lease, "successor-token");
        const r = await state(d, [
          cmd,
          "999",
          "--token",
          "the-dead-owners-token",
        ]);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("not yours");
        // The successor's lease survives, and nothing was recorded on its behalf.
        expect(readFileSync(lease, "utf8")).toBe("successor-token");
        expect((await state(d, ["ready-marked", "999"])).stdout.trim()).toBe(
          "0",
        );
      }
    });
  });
});
