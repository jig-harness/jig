/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { writeFileSync } from "node:fs";

import { join } from "node:path";

import {
  HEAD,
  PREV,
  gitCleanEnv,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();
describe("finish-round.ts", () => {
  const findingsFinishRoundFixtures = createFindingsFinishRoundFixtures();
  const { seed, finishRound } = findingsFinishRoundFixtures;

  it("reports a per-item refusal and still drains the rest of the batch", async () => {
    const r = await finishRound({
      // `PRRT_stale` needs no live thread entry: `claim-held` refuses it on
      // the round mismatch BEFORE resolve-held-thread.ts's own
      // staleness recheck ever runs. `PRRT_current` DOES reach that recheck.
      fixture: {
        threads: [
          { id: "PRRT_live", path: "a.ts", bot: true },
          {
            id: "PRRT_current",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "**accepted** — fixed.",
              },
            ],
          },
        ],
      },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        // A thread held in an EARLIER round — the shape a crash between the
        // reply and the resolve leaves behind. `claim-held` refuses it on the
        // round check, and that refusal must not take the current round's own
        // held thread down with it.
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_stale",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/held-comment-stale",
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          HEAD,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_current",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/PRRT_current/comment-1",
        ]);
      },
    });
    expect(r.exitCode).toBe(6);
    expect(r.report.state).toBe("PARTIAL");
    const items = r.report.items as Array<Record<string, unknown>>;
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("PRRT_current")?.action).toBe("resolved");
    expect(byKey.get("PRRT_stale")?.action).toBe("refused");
    // The refusing script's own diagnostic, not a re-worded one — that text is
    // what names the § 3 reconciliation the operator has to perform.
    expect(String(byKey.get("PRRT_stale")?.diagnostic)).toContain(
      "was held in round",
    );
    // The good one really did resolve; the refusal did not abort the drain.
    expect(r.resolved.trim()).toBe("PRRT_current");
    // And the refused one is STILL held, so a re-run after reconciling finds it.
    const held = JSON.parse(
      await seed(r.stateDir, r.fixtureDir, r.repo.dir, ["held", "999"]),
    ) as Array<{ key: string }>;
    expect(held.map((h) => h.key)).toEqual(["PRRT_stale"]);
  });

  it("re-reads the batch instead of refusing when a CONCURRENT resolve removes a different held thread", async () => {
    const r = await finishRound({
      // Only PRRT_vanisher needs a live thread entry: PRRT_victim is released
      // (vanish-key-on-resolve below) before its own dispatch would reach
      // resolve-held-thread.ts's staleness recheck at all.
      fixture: {
        threads: [
          { id: "PRRT_live", path: "a.ts", bot: true },
          {
            id: "PRRT_vanisher",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "**accepted** — fixed.",
              },
            ],
          },
        ],
      },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        // Held in this order — `held`'s array preserves hold order, and the
        // drain processes `pending` in that same order, so PRRT_vanisher is
        // dispatched first.
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_vanisher",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/PRRT_vanisher/comment-1",
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_victim",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/held-comment-victim",
        ]);
        // Resolving PRRT_vanisher has a side effect, via the shared gh stub's
        // resolveReviewThread branch, of releasing PRRT_victim — simulating a
        // CONCURRENT driver resolving it between this drain's own batch
        // snapshot and its own dispatch reaching it.
        writeFileSync(join(fixtureDir, "vanish-key-on-resolve"), "PRRT_victim");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.report.state).toBe("FINISHED");
    // Only the real mutation — PRRT_vanisher — actually resolved via the API;
    // PRRT_victim was already gone by the time its own dispatch would have
    // run, so no second mutation call for it exists.
    expect(r.resolved.trim()).toBe("PRRT_vanisher");
    const items = r.report.items as Array<Record<string, unknown>>;
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("PRRT_vanisher")?.action).toBe("resolved");
    // A stale outcome (exit 4: "not in the held batch") is never recorded as
    // a refusal — recording it would have made a batch that genuinely
    // finished report PARTIAL over work that was never really outstanding.
    expect(byKey.has("PRRT_victim")).toBe(false);
    const held = JSON.parse(
      await seed(r.stateDir, r.fixtureDir, r.repo.dir, ["held", "999"]),
    ) as Array<{ key: string }>;
    expect(held).toEqual([]);
  });

  it("re-running after a completed drain dispatches nothing a second time", async () => {
    const first = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-resume-1",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "bounded, as asked.",
        );
      },
    });
    expect(first.exitCode).toBe(0);
    expect(first.posted.trim().split("\n").length).toBe(1);

    // The SAME state dir and the SAME tree, run again — the crash-recovery
    // shape. `answer-summary-finding.ts`'s none-answered path posts a NEW
    // top-level comment on every call, so a second dispatch here is a
    // duplicate standing claim on the PR that no later round undoes.
    const second = await finishRound({
      repo: first.repo,
      stateDir: first.stateDir,
      fixtureDir: first.fixtureDir,
    });
    expect(second.exitCode).toBe(0);
    expect(second.report.items).toEqual([]);
    expect(second.posted).toBe(first.posted);
  });

  it("refuses a held finding whose claim is still live, rather than answering it twice", async () => {
    // The interrupted-dispatch shape: a pass claimed the key, and died before
    // `release-held`. The claim file is what stops the successor — and it must
    // stop it BEFORE the POST, since that POST is the non-idempotent one.
    const r = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-inflight-1",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "bounded, as asked.",
        );
        // The predecessor's own § 6 stamp, then its claim — left standing.
        const localHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
          cwd,
          env: gitCleanEnv(),
          stdout: "pipe",
        })
          .stdout.toString()
          .trim();
        await seed(stateDir, fixtureDir, cwd, [
          "stamp-held",
          "999",
          "--sha",
          localHead,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "claim-held",
          "999",
          "--key",
          "fp-inflight-1",
          "--kind",
          "finding",
          "--pushed-sha",
          localHead,
        ]);
      },
    });
    expect(r.exitCode).toBe(6);
    expect(r.report.state).toBe("PARTIAL");
    // Nothing was posted — the whole point.
    expect(r.posted).toBe("");
    const items = r.report.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe("refused");
    expect(String(items[0]?.diagnostic)).toContain("already claimed");
  });
});
