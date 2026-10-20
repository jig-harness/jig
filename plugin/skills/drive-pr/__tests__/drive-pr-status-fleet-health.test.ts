/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  HEAD,
  PREV,
  DORMANT_ARM,
  binDir,
  writeFixture,
  probeIn,
  probe,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

useDrivePrSuite();

// `fleetHealth` in the gate's JSON report and the plain-text
// `fleet-health` stderr line are the ONLY routes a published snapshot takes
// into a round's brief. `fleet-health.test.ts` covers `readFleetHealthAdvisory`
// directly, which cannot notice `drive-status.ts` no longer calling it: these
// tests pin the wiring itself, against a snapshot published to a scratch
// `$DEV_DASHBOARD_DIR`.
describe("drive-status.ts publishes the fleet-health advisory", () => {
  /** Publish a snapshot raising a review-carousel for PR 999 (the probes' PR). */
  function publishSnapshot(
    opts: { ageMs?: number; gaps?: string[] } = {},
  ): string {
    const dashDir = mkdtempSync(join(tmpdir(), "drive-fleet-health-"));
    writeFileSync(
      join(dashDir, "fleet-health.json"),
      JSON.stringify({
        panel: "fleet-health",
        generatedAt: new Date(
          Date.now() - (opts.ageMs ?? 600_000),
        ).toISOString(),
        source: "test",
        ttlSec: 3600,
        error: null,
        everSucceeded: true,
        data: {
          signals: [
            {
              kind: "review-carousel",
              scope: { type: "pr", pr: 999, epics: [] },
              severity: "elevated",
              headline: "10 bot-reviewed heads",
              state: null,
            },
          ],
          gaps: opts.gaps ?? [],
        },
      }),
    );
    return dashDir;
  }

  it("carries the PR-scoped warnings, snapshot age and staleness in the JSON report", async () => {
    const dashDir = publishSnapshot();
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DEV_DASHBOARD_DIR: dashDir },
      });
      const fh = r.json.fleetHealth as {
        warnings: string[];
        snapshotAgeSec: number;
        stale: boolean;
      };
      expect(fh.warnings).toEqual(["review-carousel: 10 bot-reviewed heads"]);
      // ~10 minutes, with slack for the spawn between publish and read.
      expect(fh.snapshotAgeSec).toBeGreaterThanOrEqual(600);
      expect(fh.snapshotAgeSec).toBeLessThan(700);
      expect(fh.stale).toBe(false);
      expect((fh as { partial?: boolean }).partial).toBe(false);
      // Advice never touches the verdict.
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });

  // One flag true at a time, so swapping the `stale`/`partial` mapping in the
  // JSON payload fails a case instead of passing on a both-true fixture.
  it.each([
    {
      label: "STALE only",
      // Past the 3600s TTL, with a clean gap list.
      snapshot: { ageMs: 2 * 3600_000 } as { ageMs?: number; gaps?: string[] },
      stale: true,
      partial: false,
    },
    {
      label: "PARTIAL only",
      // Fresh, with a non-empty gap list.
      snapshot: { gaps: ["Linear unreachable"] } as {
        ageMs?: number;
        gaps?: string[];
      },
      stale: false,
      partial: true,
    },
  ])(
    "forwards a $label snapshot with distinct flags in the JSON report",
    async ({ snapshot, stale, partial }) => {
      const dashDir = publishSnapshot(snapshot);
      try {
        const { dir, stateDir } = writeFixture({
          threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
        });
        const r = await probeIn(dir, stateDir, HEAD, [], {
          env: { DEV_DASHBOARD_DIR: dashDir },
        });
        const fh = r.json.fleetHealth as {
          warnings: string[];
          stale: boolean;
          partial: boolean;
        };
        expect(fh.warnings).toEqual(["review-carousel: 10 bot-reviewed heads"]);
        expect(fh.stale).toBe(stale);
        expect(fh.partial).toBe(partial);
        expect(r.state).toBe("ROUND_READY");
        expect(r.exitCode).toBe(0);
      } finally {
        rmSync(dashDir, { recursive: true, force: true });
      }
    },
  );

  it("reports no warnings when no snapshot is published", async () => {
    const dashDir = mkdtempSync(join(tmpdir(), "drive-fleet-health-empty-"));
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DEV_DASHBOARD_DIR: dashDir },
      });
      expect(r.json.fleetHealth).toEqual({
        warnings: [],
        snapshotAgeSec: null,
        stale: false,
        partial: false,
      });
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });

  it("prints the suspicion line on stderr for the plain-text (non---json) caller", async () => {
    const dashDir = publishSnapshot();
    try {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      });
      const proc = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive-status.ts"),
          "999",
          "--once",
          "--no-reconcile",
          "--head",
          HEAD,
        ),
        {
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_FIXTURES: dir,
            DRIVE_PR_STATE_DIR: stateDir,
            DEV_DASHBOARD_DIR: dashDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(out.trim()).toBe("ROUND_READY");
      expect(stderr).toMatch(/PR #999/);
      expect(stderr).toMatch(/review-carousel: 10 bot-reviewed heads/);
      expect(stderr).toMatch(/suspicion, not a finding/);
    } finally {
      rmSync(dashDir, { recursive: true, force: true });
    }
  });
});

// A draft is DRIVEN, not refused. `PR_IS_DRAFT` (exit 10) used to be terminal
// here, on the premise that no reviewer arm looks at a draft; measured false
// when `example-review` posted findings on two PRs — both created as drafts
// and never marked Ready — about a minute after each was opened: that
// reviewer's deployment reviews drafts.
//
// CodeRabbit still refuses a draft ("Review skipped / Draft detected", on the
// same PRs), and that asymmetry is the point: the drive works the in-house
// findings on the draft and marks it Ready afterwards, so the paid reviewer's
// one pass lands on a cleaned-up head. `mark-ready.ts` owns the transition;
// these tests own the gate's half, which is simply that draftness no longer
// decides anything.
describe("drive-status.ts draft PRs", () => {
  /** The check-run set on a head the reviewer has not run on at all. */
  const NO_REVIEWER = [DORMANT_ARM];

  it("a draft with findings is an ordinary ROUND_READY", async () => {
    // The whole retirement, in one assertion: a draft is worked exactly as a
    // Ready PR is. Before this, the identical fixture returned exit 10 and the
    // round was never dispatched.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraft: true,
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    // Measured and published, so a caller can act on it — mark-ready.ts does.
    expect(r.json.draft).toBe(true);
  });

  it("a clean draft CONVERGES — the reviewer’s stamp counts on a draft head", async () => {
    // `CONVERGED` is defined against the arm that reviews drafts, so every
    // witness it rests on is available on one. This is the assertion that would
    // have been unreachable under the old gate: exit 10 fired before any
    // reviewer evidence was read.
    const r = await probe({ threads: [], reviewedSha: HEAD, isDraft: true });
    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
    expect(r.json.draft).toBe(true);
  });

  it("names the draft-review setting when a DRAFT has no reviewer run", async () => {
    // Whether drafts are reviewed is a deployment setting this gate cannot
    // read; the consumer declares it as drive.reviews_drafts.
    // So the one wait a draft can enter that a Ready PR cannot is named rather
    // than gated on: refusing to drive drafts on the chance the dial is off is
    // exactly the stall retiring PR_IS_DRAFT removed, but leaving an operator
    // to guess why a 30-minute poll learned nothing is the failure.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: true,
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
    expect(r.json.reason).toContain("drive.reviews_drafts");

    // The note is DRAFT-SPECIFIC. On a Ready PR the same wait has no such
    // cause, and appending it there would send every operator chasing a
    // setting that has nothing to do with their stall.
    const ready = await probe({ threads: [], checkRuns: NO_REVIEWER });
    expect(ready.state).toBe("AWAITING_REVIEWER");
    expect(ready.json.reason).not.toContain("drive.reviews_drafts");
  });

  it("does not short-circuit head sync — a stale draft head is HEAD_LAG", async () => {
    // The old gate sat AHEAD of head sync deliberately, so a draft could not
    // present as HEAD_LAG. With draftness deciding nothing, that ordering has
    // no work left to do and the honest answer for a lagging head is HEAD_LAG —
    // which clears in seconds, as it does on any Ready PR.
    const r = await probe(
      { threads: [], checkRuns: NO_REVIEWER, isDraft: true, head: PREV },
      ["--head", HEAD],
    );
    expect(r.state).toBe("HEAD_LAG");
    expect(r.exitCode).toBe(4);
  });

  it("is still checked BEHIND liveness — a closed draft is PR_NOT_OPEN", async () => {
    // Both flags can arrive together — a draft that was then closed — so the
    // order decides which is reported rather than being moot. The contract is
    // that a PR no longer open stops the loop before anything else is said
    // about it, draftness included.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: true,
      prState: "CLOSED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it('an absent isDraft is INDETERMINATE, never "Ready for review"', async () => {
    // The silent-disarm shape: `null` coerces to `false` under a truthiness
    // read. That answer is still the dangerous one after the retirement, but
    // for a different consumer — `isDraft` stopped being a GATE and stayed
    // DECISION evidence, because mark-ready.ts reads it to decide whether the
    // draft→Ready transition is owed, and `false` means "already Ready,
    // nothing to do". A partial response accepted here would silently skip the
    // transition on the one PR that needs it.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraft: null,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.json.reason).toContain("isDraft");
    // Unmeasured stays unmeasured — `false` here would be the very claim the
    // read failed to establish.
    expect(r.json.draft).toBeNull();
  });

  it("a GENUINELY OMITTED isDraft key is INDETERMINATE too, same as null", async () => {
    // `isDraft: null` models the field answered WITH a null value; a key
    // dropped from the response entirely is a distinct wire shape `gh` could
    // just as well produce on a partial response. `evaluate()` reads both the
    // same way (`typeof draft !== 'boolean'`), so this must reach the
    // identical outcome as the null case above (the fixture builder could not
    // previously produce this shape at all).
    // mark-ready.ts applies the same rule to its own read of the field, in the
    // same direction, for the same reason.
    const r = await probe({
      threads: [],
      checkRuns: NO_REVIEWER,
      isDraftAbsent: true,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.json.reason).toContain("isDraft");
    expect(r.json.reason).toContain("<absent>");
    expect(r.json.draft).toBeNull();
  });

  it("a mid-evaluation flip TO draft no longer invalidates CONVERGED", async () => {
    // The deliberate inverse of a guard that used to live in `still_on_head`:
    // a PR converted back to draft while reviewer and thread evidence
    // was being gathered reported PR_IS_DRAFT rather than CONVERGED, because a
    // terminal claim was only sound while a reviewer was scheduled to look.
    //
    // It is sound now regardless. Every witness CONVERGED rests on — the
    // reviewer's check-run, its reviewed-SHA stamp, the thread and summary
    // counts — describes this head and is unaffected by draftness, so tripping
    // on the flip would stop a drive over a state change that costs the claim
    // nothing. `headMovesAfter: 1` opens the same window the old guard used.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      isDraftMovesTo: true,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("CONVERGED");
    expect(r.exitCode).toBe(3);
  });

  it("a mid-evaluation flip TO draft no longer withholds a ROUND_READY", async () => {
    // Same retirement on the other path.
    // The round is dispatched: the findings are real, the reviewer that posted
    // them reads drafts, and the fixes land on the same branch either way.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraftMovesTo: true,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
  });

  it("closes mid-evaluation on the ROUND_READY path — the surviving half of the recheck", async () => {
    // `closedSinceOpen` is what `draftOrClosedSinceOpen` became. Its draft half
    // is gone with the premise; this half is why the function was KEPT rather
    // than deleted alongside it — a round dispatched onto a PR that merged or
    // closed during enumeration is a whole triage-fix-push pass with nowhere to
    // land, which was always an independent justification.
    //
    // `isDraftMovesTo` rides along to pin the PRECEDENCE that outlived the
    // guard it was found in: GitHub keeps `isDraft` true on a closed draft, so
    // this fixture is simultaneously "became a draft" and "got closed", and
    // PR_NOT_OPEN must still win. It does so now by construction — nothing
    // reads draftness here at all — and this is what would go red if a future
    // draft check were reintroduced ahead of the liveness one.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      isDraftMovesTo: true,
      stateMovesTo: "CLOSED",
      headMovesAfter: 1,
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("a Ready PR reports draft:false and proceeds normally", async () => {
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    expect(r.json.draft).toBe(false);
  });

  it("publishes draft:null from a gate that returned before the snapshot", async () => {
    // Same rule as the work counts: a state decided before the read happened
    // has nothing to say about draftness, and `false` there would be a claim.
    const r = await probe({ threads: [], transientMergeabilityFailure: true });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.json.draft).toBeNull();
  });
});
