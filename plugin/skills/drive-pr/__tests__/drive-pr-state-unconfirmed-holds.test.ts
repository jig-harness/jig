/**
 * drive-pr suite: drive-state.ts durability.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { ACTOR, useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();
describe("drive-state.ts durability", () => {
  const stateDurabilityFixtures = createStateDurabilityFixtures();
  const { stateDirFor, state } = stateDurabilityFixtures;

  describe("hold --unconfirmed", () => {
    // reconcile-replied-threads.ts re-holds a reply it found already POSTED,
    // not one it verified. The ordinary `hold` upsert stamps `round:.rounds`
    // unconditionally — sound for a live pass's own step 3, which only calls
    // it after confirming the promised fix, but NOT for a caller with no such
    // ability: round and .verifiedSha are both PR-global, not scoped to which
    // hold's fix a given push actually contains, so granting round-currency
    // on faith let a stale, never-verified reply ride an UNRELATED later
    // push's set-verified to a false resolve. `--unconfirmed`
    // closes this by stamping round -1, which bump-round (always >= 0,
    // starting at 0) can never equal. Insert-if-absent keyed on outcome alone
    // still let a SUPERSEDING same-outcome reply inherit an earlier
    // hold's round-currency, and tolerating an absent commentUrl on the
    // ordinary (live-pass-confirmed) path closed that only within a
    // chain of standalone re-holds, not for a confirmed hold. `--comment-url`
    // is now REQUIRED and compared exactly on BOTH paths: insert-
    // if-absent by (key, outcome, commentUrl), so any newer qualifying
    // comment — confirmed or not, same outcome word or not — invalidates a
    // stale hold rather than inheriting it.

    it("stamps round -1, which no future bump-round/set-verified pair can ever satisfy", async () => {
      const d = stateDirFor("unconfirmed-never-claims");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_stale",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/c1",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "PRRT_stale", round: -1 }]);

      // Simulate an UNRELATED live pass's own round, complete with a real
      // push — exactly the scenario the finding described: some other
      // thread's fix lands, round advances, verifiedSha moves. None of that
      // has anything to do with PRRT_stale's own promised fix.
      await state(d, ["bump-round", "999", "--head", "unrelated-head"]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "dddddddddddddddddddddddddddddddddddddddd",
      ]);

      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_stale",
        "--kind",
        "thread",
        "--pushed-sha",
        "dddddddddddddddddddddddddddddddddddddddd",
      ]);
      // MUST refuse — round -1 can never equal the real (now >= 1) round.
      expect(claim.exitCode).not.toBe(0);
      expect((await state(d, ["held-keys", "999"])).stdout).toBe("PRRT_stale");
    });

    it("requires --comment-url on --kind thread, unconfirmed or not", async () => {
      const d = stateDirFor("unconfirmed-requires-url");
      const withoutUrl = [
        "--key",
        "PRRT_no_url",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
      ];
      const r1 = await state(d, [
        "hold",
        "999",
        ...withoutUrl,
        "--unconfirmed",
      ]);
      expect(r1.exitCode).toBe(2);
      expect(r1.stderr).toContain("--comment-url");

      const r2 = await state(d, ["hold", "999", ...withoutUrl]);
      expect(r2.exitCode).toBe(2);
      expect(r2.stderr).toContain("--comment-url");
    });

    it("does not touch an EXISTING held entry representing the SAME comment — insert-if-absent, never a downgrade", async () => {
      const d = stateDirFor("unconfirmed-insert-if-absent");
      // A live pass legitimately confirms the fix and holds at the current
      // (real) round.
      await state(d, ["bump-round", "999", "--head", "confirmed-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/original-reply",
      ]);
      const before = JSON.parse((await state(d, ["held", "999"])).stdout);
      expect(before).toMatchObject([{ key: "PRRT_confirmed", round: 1 }]);

      // A concurrent standalone reconcile pass sees the SAME already-posted
      // reply (same comment url) and tries to re-hold it too — this must be
      // a no-op, not a downgrade to round -1 that would strand the
      // already-confirmed hold.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/original-reply",
      ]);
      expect(JSON.parse((await state(d, ["held", "999"])).stdout)).toEqual(
        before,
      );

      // And the legitimately-confirmed hold still claims normally.
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_confirmed",
        "--kind",
        "thread",
        "--pushed-sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      expect(claim.exitCode).toBe(0);
    });

    it("invalidates a stale hold whose OUTCOME differs — a superseding reply must not inherit round-currency", async () => {
      const d = stateDirFor("unconfirmed-outcome-changed");
      // A live pass legitimately confirmed and held an `accepted` claim.
      await state(d, ["bump-round", "999", "--head", "first-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-15",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      // Confirm the legitimate hold really would have claimed, to prove the
      // invalidation below is doing real work, not asserting a no-op.
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_superseded",
            "--kind",
            "thread",
            "--pushed-sha",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ])
        ).exitCode,
      ).toBe(0);
      // Re-establish it (claim-held above removed it) to continue the scenario.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/synthetic-comment-16",
      ]);

      // A later trusted reply supersedes the original with a DIFFERENT
      // fix-dependent outcome (and, necessarily, a different comment url).
      // Reconcile re-holds — this must invalidate the stale `accepted`
      // round-currency, not preserve it under the new `moot` outcome.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--outcome",
        "moot",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/superseding-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([{ key: "PRRT_superseded", outcome: "moot", round: -1 }]);

      // The stale round+verifiedSha pairing that would have claimed the OLD
      // outcome must not silently carry over to resolve the new one.
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_superseded",
        "--kind",
        "thread",
        "--pushed-sha",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      expect(claim.exitCode).not.toBe(0);
    });

    it("invalidates a CONFIRMED (live-pass) hold when a superseding reply appears — the absent-commentUrl tolerance's own acknowledged residual", async () => {
      // Tolerating an absent commentUrl left one case open: the ORDINARY (non
      // --unconfirmed) hold path never recorded commentUrl at all, so an
      // absent-vs-set comparison had to treat "no commentUrl on file" as
      // trustworthy — otherwise every legitimately-confirmed hold would
      // spuriously downgrade the first time reconcile ran afterward, changed or
      // not. That leniency, though, meant a genuinely SUPERSEDING reply on a
      // live-pass-confirmed thread was never caught either. Both `hold` paths
      // now require --comment-url, so there is no more "absent" case to be
      // lenient about — comparison is exact on both sides.
      const d = stateDirFor("confirmed-hold-superseded");
      await state(d, ["bump-round", "999", "--head", "confirmed-head"]);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/the-reply-a-live-pass-confirmed",
      ]);
      await state(d, [
        "stamp-held",
        "999",
        "--sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      // Prove the confirmed hold really would have claimed, so the
      // invalidation below is doing real work, not asserting a no-op. Then
      // re-establish it (claim-held above removed it) to continue.
      expect(
        (
          await state(d, [
            "claim-held",
            "999",
            "--key",
            "PRRT_confirmed_superseded",
            "--kind",
            "thread",
            "--pushed-sha",
            "cccccccccccccccccccccccccccccccccccccccc",
          ])
        ).exitCode,
      ).toBe(0);
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/the-reply-a-live-pass-confirmed",
      ]);

      // A DIFFERENT trusted comment later supersedes it with the SAME
      // outcome word but a different promised fix. A standalone reconcile
      // pass sees this as the latest qualifying reply and re-holds
      // (unconfirmed) — this must invalidate the confirmed hold's
      // round-currency, not preserve it because the outcome word matches.
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/a-different-superseding-reply",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        { key: "PRRT_confirmed_superseded", outcome: "accepted", round: -1 },
      ]);

      // The stale round+verifiedSha pairing from the ORIGINAL confirmed hold
      // must not silently resolve the thread against the new promise.
      const claim = await state(d, [
        "claim-held",
        "999",
        "--key",
        "PRRT_confirmed_superseded",
        "--kind",
        "thread",
        "--pushed-sha",
        "cccccccccccccccccccccccccccccccccccccccc",
      ]);
      expect(claim.exitCode).not.toBe(0);
    });

    it("a chain of standalone re-holds tracks the LATEST comment — a newer same-outcome comment replaces an older unconfirmed entry's provenance", async () => {
      // Two reconcile passes, no live pass in between: the first pins
      // provenance to comment #1; a later run sees a DIFFERENT trusted
      // comment (same outcome word, different promise) and must not silently
      // keep pointing at the stale one — outcome-only comparison would have
      // read these as identical and left the OLD provenance
      // standing.
      const d = stateDirFor("unconfirmed-chain-tracks-latest-comment");
      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_restated",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/reply-1",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        {
          key: "PRRT_restated",
          outcome: "accepted",
          commentUrl: "https://example.invalid/reply-1",
        },
      ]);

      await state(d, [
        "hold",
        "999",
        "--key",
        "PRRT_restated",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--unconfirmed",
        "--comment-url",
        "https://example.invalid/reply-2-a-different-promise",
      ]);
      expect(
        JSON.parse((await state(d, ["held", "999"])).stdout),
      ).toMatchObject([
        {
          key: "PRRT_restated",
          outcome: "accepted",
          round: -1,
          commentUrl: "https://example.invalid/reply-2-a-different-promise",
        },
      ]);
    });
  });

  describe("handoff rendering", () => {
    async function handoff(reasons: string[], previousNarrative?: string) {
      const d = stateDirFor("handoff");
      const hd = join(d, "handoff");
      for (const [i, reason] of reasons.entries()) {
        await state(
          d,
          [
            "park",
            "999",
            "--key",
            `PRRT_${i}`,
            "--kind",
            "thread",
            "--reason",
            reason,
          ],
          { DRIVE_PR_HANDOFF_DIR: hd },
        );
      }
      if (previousNarrative !== undefined) {
        await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
        const p = join(hd, "pr-drive-999.md");
        writeFileSync(p, `${readFileSync(p, "utf8")}${previousNarrative}`);
      }
      await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
      return readFileSync(join(hd, "pr-drive-999.md"), "utf8");
    }

    it("keeps a reason containing a PIPE inside its own table cell", async () => {
      const out = await handoff(["choose A | B — a product call"]);
      const row = out.split("\n").find((l) => l.includes("PRRT_0"));
      expect(row).toBeDefined();
      // Four cells, so the decision is still in the column that states it.
      expect((row as string).match(/\|/g)?.length).toBe(5);
      expect(row).toContain("&#124;");
    });

    it("keeps a MULTILINE reason on one row instead of spilling into prose", async () => {
      const out = await handoff(["first line\nsecond line"]);
      const row = out.split("\n").find((l) => l.includes("PRRT_0"));
      expect(row).toContain("first line second line");
    });

    it("a reason QUOTING the narrative marker does not move the boundary", async () => {
      // The awk preservation pass used to cut at the first line merely
      // CONTAINING the marker text. A parked reason quoting it is reachable —
      // reasons routinely quote reviewer prose about this very file — and it
      // moves the boundary UP into the parked table, so everything below the
      // quoting row is copied into the narrative and re-copied every round.
      // Two parked items are what makes that visible: the second row is the
      // machine-block content that leaks.
      const out = await handoff(
        [
          "reviewer says the narrative below this line is agent-authored and preserved",
          "a second, ordinary decision",
        ],
        "\n## Narrative\n\nreal narrative text\n",
      );
      expect(out).toContain("real narrative text");
      const marker =
        "<!-- narrative below this line is agent-authored and preserved -->";
      const below = out.slice(out.indexOf(marker) + marker.length);
      // The machine block stays above the boundary, in one copy.
      expect(below).not.toContain("PRRT_1");
      expect(out.split("\n").filter((l) => l.includes("PRRT_1")).length).toBe(
        1,
      );
    });

    it("carries the HELD batch, which is what a compacted agent has lost", async () => {
      // The handoff file is the resumption point for the two paths where
      // context does not reset by construction: interactive `/loop`, and
      // `--handoff-at never`. The parked set alone is not enough — parked items
      // are things a HUMAN owes, while the held batch is work THIS round
      // already did and must not do twice.
      const d = stateDirFor("handoff-held");
      const hd = join(d, "handoff");
      const env = { DRIVE_PR_HANDOFF_DIR: hd };
      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "PRRT_held",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/handoff-held-reply",
        ],
        env,
      );
      await state(d, ["handoff", "999"], env);
      const out = readFileSync(join(hd, "pr-drive-999.md"), "utf8");
      const row = out.split("\n").find((l) => l.includes("PRRT_held"));
      expect(row).toContain("accepted");
      expect(row).toContain("thread");
      // The provenance columns — a reader who cannot see WHO holds
      // an item and whether its fix is pushed cannot tell a dispatchable batch
      // from one `claim-held` will refuse outright.
      expect(row).toContain(ACTOR);
      expect(row).toContain("not yet");
      expect(out).toContain("Held — replied, awaiting the push");
      expect(out).toContain("Do NOT re-reply");
      // A successor session copy-pasting the literal rendered command must
      // get ONE runnable invocation, not `drive-state.ts` alone on one line
      // and `claim-held ...` as a bogus separate command on the next. Each
      // command has to sit fully inside its own line, script name and
      // subcommand together — including `--pushed-sha`, which the claim
      // requires.
      expect(out).toContain(
        '`drive-state.ts claim-held 999 --key K --kind finding --pushed-sha "$(git rev-parse HEAD)"`\nfirst.',
      );
      expect(out).toContain(
        "`drive-state.ts release-held 999 --key K --token T`",
      );
    });

    it("regenerates itself on `hold`, `park` and `release-held` — no explicit `handoff` call needed", async () => {
      // The block claims to be "written at the moment of each event", so it
      // must hold for `hold` and `park` too, not only for `handoff`-triggered
      // fields (round, phase, verifiedSha). Otherwise a mid-round hold stays
      // invisible in the .md until the NEXT explicit `handoff` call (step 7,
      // or `drive.ts` at the start of the following round), and a successor
      // reading only the file — the case `--handoff-at never` exists for —
      // could miss a hold made just before a compaction.
      const d = stateDirFor("handoff-live");
      const hd = join(d, "handoff");
      const env = { DRIVE_PR_HANDOFF_DIR: hd };
      const path = join(hd, "pr-drive-999.md");

      await state(
        d,
        [
          "hold",
          "999",
          "--key",
          "PRRT_live",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/handoff-live-reply",
        ],
        env,
      );
      let out = readFileSync(path, "utf8");
      expect(out).toContain("PRRT_live");
      expect(out).toContain("accepted");

      await state(
        d,
        [
          "park",
          "999",
          "--key",
          "PRRT_parked",
          "--kind",
          "thread",
          "--reason",
          "product call",
        ],
        env,
      );
      out = readFileSync(path, "utf8");
      expect(out).toContain("PRRT_parked");
      expect(out).toContain("product call");

      await state(d, ["release-held", "999", "--key", "PRRT_live"], env);
      out = readFileSync(path, "utf8");
      expect(out).not.toContain("PRRT_live");
      // Unrelated state (the parked item) survives the release untouched.
      expect(out).toContain("PRRT_parked");
    });

    it("prefers itself over a compacted recollection, WITHOUT overclaiming exactness with the JSON", async () => {
      // Deliberate, not decoration. A successor starting fresh has nothing to
      // weigh the file against; an agent resuming after a compaction still
      // holds a degraded summary of its own round and will prefer it unless
      // the file says otherwise. But the claim stops there: the JSON write
      // and this file's write are two separate `mv`s, so it cannot honestly
      // claim to be a transactional mirror of the state — it says so, and
      // points anything consequential back at `drive-state.ts` directly.
      const d = stateDirFor("handoff-authority");
      const hd = join(d, "handoff");
      await state(d, ["handoff", "999"], { DRIVE_PR_HANDOFF_DIR: hd });
      const out = readFileSync(join(hd, "pr-drive-999.md"), "utf8");
      expect(out).toContain("Prefer this block over your own recollection");
      expect(out).toContain("not a transactional mirror");
      expect(out).toContain("drive-state.ts held");
      // And it sits ABOVE the agent-authored half, or it is describing the
      // wrong text.
      const marker =
        "<!-- narrative below this line is agent-authored and preserved -->";
      expect(
        out.indexOf("Prefer this block over your own recollection"),
      ).toBeLessThan(out.indexOf(marker));
    });
  });
});
