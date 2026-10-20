/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { join, delimiter } from "node:path";

// Imported, never restated: every fixture age below is derived from the
// production floor, so raising it cannot silently leave a probe sitting
// underneath it and passing vacuously.
import {
  RECONCILIATION_INTERVAL_SEC,
  RECONCILIATION_REACTIVATION_SEC,
  REVIEW_PUBLICATION_MARGIN_SEC,
  STALLED_MIN_AGE_SEC,
} from "../scripts/lib/status/evaluate";

import {
  SCRIPTS,
  HEAD,
  PREV,
  realHead,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  makeOrphanCommit,
  writeFixture,
  probeIn,
  probe,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createStatusConvergenceFixtures } from "./drive-pr-status-convergence-fixtures.ts";

useDrivePrSuite();
describe("drive-status.ts refuses to converge — the measured false-convergence modes", () => {
  const statusConvergenceFixtures = createStatusConvergenceFixtures();
  const { seedRounds } = statusConvergenceFixtures;

  it("mode 1: summary-only findings are open work even with zero threads", async () => {
    const r = await probe({ threads: [], backlog: true, anchored: [] });
    expect(r.state).not.toBe("CONVERGED");
    expect(r.state).toBe("ROUND_READY");
    // Two backlog entries plus the unanchored body bullet.
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(3);
  });

  it("mode 1b: answering every summary finding lets it converge", async () => {
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      addressed: ["b9a7a18089043564", "c773d9fdb7974e6d"],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("mode 2+4: a settled non-posting reviewer does not stand in for the posting one", async () => {
    // Exactly the observed set on a fresh head: the dormant CI arm (SKIPPED)
    // plus a rate-limited CodeRabbit reporting SUCCESS as a commit status,
    // while `AI review (shadow)` has not been created yet.
    const r = await probe({
      threads: [],
      checkRuns: [DORMANT_ARM],
      statuses: [
        {
          context: "CodeRabbit",
          state: "success",
          description: "Review rate limited",
        },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("mode 2b: a reviewer check-run that was SKIPPED never reviewed anything", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "skipped" }],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("mode 2c: a reviewer check-run still in progress, with no sticky posted at all, is not settled", async () => {
    // `reviewedSha: null` is load-bearing here — the default fixture posts a
    // matching sticky, which is exactly the stranded-check-run shape the gate
    // trusts (see the tests below). This probe models the genuinely
    // still-running case: in_progress AND no marker evidence of any kind.
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, status: "in_progress", conclusion: null }],
      reviewedSha: null,
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  describe("stranded-check-run bypass", () => {
    // Measured live: the check-run for a head sat 'in_progress' 3.5+ hours
    // while the review had already published its sticky (round 6, matching
    // `ai-reviewed-sha`), three inline threads, and a wind-down entry. The gate
    // reported AWAITING_REVIEWER forever, learning nothing from the marker it
    // already trusts on the no-check-run path.

    // Comfortably past the $DRIVE_PR_STALLED_MIN_AGE_SEC age floor — the
    // fourth bypass condition, which rules out reading a sticky that was
    // upserted before its own inline threads finished posting (outbox
    // semantics; see terminal-states.md § the age-floor test below). Older
    // than `DEFAULT_STICKY_UPDATED_AT` so condition 5 (the sticky post-dates
    // the run) holds for every probe that is not specifically about it.
    const OLD_ENOUGH_STARTED = new Date(
      Date.now() - STALLED_MIN_AGE_SEC * 3 * 1000,
    ).toISOString();

    it("an in_progress check-run whose sticky already reviewed THIS head at a NEWER round yields ROUND_READY", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        // Default reviewedSha (== HEAD) and default sticky round (7,
        // STICKY_ROUND) — the sticky names this exact head.
      });
      seedRounds(stateDir, 6); // one behind the sticky's round 7
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
      // AC: the reason states the check-run and the marker disagree.
      expect(r.json.reason).toContain("reads 'in_progress'");
      expect(r.json.reason).toContain("round 7");
      expect(r.json.reason).toContain("comment-marker");
    });

    it("the same shape with zero live work converges instead of blocking", async () => {
      // The bypass does not only unlock ROUND_READY — it unlocks whatever the
      // enumerated work supports, exactly as the no-check-run 'comment-marker'
      // path already does for CONVERGED.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("CONVERGED");
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("the same shape with every thread parked reaches HITL_PARKED, not stuck AWAITING_REVIEWER", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      await park(stateDir, "t1", "thread");
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("HITL_PARKED");
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("a marker naming an EARLIER head still blocks — the fix must not race a real review", async () => {
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        reviewedSha: PREV,
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a marker at a round the drive has ALREADY counted does not bypass", async () => {
      // Sticky round is 7 (default); counting 7 already means this exact
      // round's evidence was already consumed by a prior evaluation, so it is
      // not fresh — replaying it would let a stale in_progress check-run be
      // waved through on evidence that predates it.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 7);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a QUEUED check-run does not bypass — only in_progress does", async () => {
      // Queued has not started at all, so there is nothing a marker could
      // have overtaken; the bypass is scoped to in_progress specifically.
      const { dir, stateDir } = writeFixture({
        threads: [{ id: "t1", path: "a.ts", bot: true }],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "queued",
            conclusion: null,
            started: null,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an in_progress run that just started does NOT bypass — the outbox-race guard", async () => {
      // Publication is not atomic: the sticky can land before its own inline
      // threads finish posting. A run that started SECONDS ago, still
      // reading zero threads, must not be trusted as "the round already
      // published nothing" — only a run old enough that a real publish would
      // have finished is. Everything else about the fixture matches the
      // CONVERGED-via-bypass test above; only the run's age differs.
      //
      // The sticky is dated a second after that start, so it is genuinely
      // THIS run's evidence (condition 5 holds) and the young sticky is the
      // sole decider — without that, the fixture would trip condition 5 and
      // pass vacuously, asserting nothing about the floor (a fail-closed
      // conjunction needs each clause to be the sole decider in its probe).
      const startedMs = Date.now() - 5000;
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: new Date(startedMs).toISOString(),
          },
        ],
        stickyUpdatedAt: new Date(startedMs + 1000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a FRESHLY-EDITED sticky on a long-stranded run does NOT bypass — the floor ages the evidence, not the run", async () => {
      // The first cut floored the CHECK-RUN's own
      // `started_at`, which the stranded run clears by construction — it has
      // been stuck for hours. So a sticky rewritten seconds before the read,
      // with its inline threads still mid-publish, sailed through the very
      // window the floor exists to exclude and reached a false CONVERGED.
      //
      // Everything here matches the CONVERGED-via-bypass probe above except
      // the sticky's own age: the run is comfortably past the floor, and only
      // basing the floor on `updated_at` blocks it.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a sticky PREDATING the run does NOT bypass — a re-run on an unchanged head cannot inherit the old attempt evidence", async () => {
      // A re-run never rewrites `ai-reviewed-sha`,
      // so the previous attempt's sticky still names this exact head and
      // clears the SHA pin; the round comparison is near-vacuous against a
      // per-drive counter. Once the re-run itself crossed the age floor,
      // every remaining condition held and the stale sticky authorized
      // convergence on evidence THIS attempt never produced.
      //
      // The sticky is old enough to clear the age floor on its own, so
      // condition 5 — it must post-date the run's start — is the sole
      // decider here rather than the floor catching it incidentally.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        // Older than OLD_ENOUGH_STARTED, and derived from the same constant so
        // it stays that way if the floor moves — condition 5 is the sole
        // decider here only while the sticky both clears the floor and
        // predates the run.
        stickyUpdatedAt: new Date(
          Date.now() - STALLED_MIN_AGE_SEC * 4 * 1000,
        ).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an ABBREVIATED sticky marker that resolves to this head DOES bypass", async () => {
      // The bypass compared `sticky.sha` to the head
      // raw, while the marker grammar admits 7-40 hex — so an abbreviated
      // marker could never match a 40-character head, and the one situation
      // this bypass exists to unblock stayed blocked forever. The reviewed-SHA
      // gate a few hundred lines down had resolved abbreviations through git
      // all along; both now share `resolveMarkerSha`.
      //
      // Needs a head git can actually resolve, so `realHead()` rather than the
      // opaque `HEAD` token — same reasoning as the mode-5b probes.
      const head = await realHead();
      const { dir, stateDir } = writeFixture({
        threads: [],
        head,
        reviewedSha: head.slice(0, 8),
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, head);
      expect(r.state).toBe("CONVERGED");
      // Specifically via the bypass, not some other route to CONVERGED.
      expect(r.json.reason).toContain("reads 'in_progress'");
    });

    it("an abbreviated sticky marker that resolves to a DIFFERENT commit does NOT bypass", async () => {
      // The other half: resolving must not become accepting. A marker that
      // resolves to some other object is not a witness to this head, and the
      // stranded run keeps blocking. Without this, the fix above could have
      // been "resolve, then compare prefixes" and still pass.
      const head = await realHead();
      const other = makeOrphanCommit("drive-pr-probe-bypass-abbrev");
      const { dir, stateDir } = writeFixture({
        threads: [],
        head,
        reviewedSha: other.slice(0, 16),
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, head);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an EMPTY $DRIVE_PR_STALLED_MIN_AGE_SEC does not disable the floor", async () => {
      // `Math.max(0, Number(''))` is 0, so an empty
      // env var silently switched the whole floor off — failing OPEN on a
      // misconfiguration that reads like it set a bound. (A non-numeric value
      // already failed closed through NaN; empty-string and negative did not.)
      //
      // The fixture is the freshly-edited-sticky shape, which the floor is the
      // sole reason to reject: with the floor disabled this converges, with the
      // default restored it blocks.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "" },
      });
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("a NEGATIVE $DRIVE_PR_STALLED_MIN_AGE_SEC does not disable the floor", async () => {
      // The other value the old `Math.max(0, ...)` clamp swallowed.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "-1" },
      });
      expect(r.state).toBe("AWAITING_REVIEWER");
    });

    it("an explicit positive $DRIVE_PR_STALLED_MIN_AGE_SEC is still honoured", async () => {
      // The dial must stay a dial: rejecting junk must not mean ignoring a
      // legitimate operator setting. Same freshly-edited sticky as the two
      // probes above — a low-but-positive floor is exactly what lets it
      // through, so this fails if the fix hardcoded the default.
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: new Date(Date.now() - 5000).toISOString(),
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir, HEAD, [], {
        env: { DRIVE_PR_STALLED_MIN_AGE_SEC: "1" },
      });
      expect(r.state).toBe("CONVERGED");
    });

    it("the default floor covers reconciliation THRESHOLD + one full pass INTERVAL + publication", async () => {
      // The floor's job is to let the reviewer service's own outbox
      // reconciliation repair a crashed-mid-publish head before the drive
      // trusts a sticky with zero threads behind it — so it has to cover the
      // worst case of that repair, not its best.
      //
      // Clearing the 30-minute threshold alone is not enough: the floor must
      // also cover the 15-minute pass cadence (the threshold is evaluated when
      // a pass runs, so worst-case detection is threshold + interval) and the
      // re-run's own publication time (a reactivated row has not rewritten its
      // sticky or posted its threads until it publishes). Without them the
      // same false convergence stays reachable, just later.
      //
      // Asserted as the RELATIONSHIP between the service's documented timings,
      // never as a number: an equality against 3600 would restate the sum a
      // reader has to trust, and an inequality against the threshold alone is
      // exactly the too-weak assertion a threshold-only floor would pass.
      // Retuning any
      // component stays free; dropping a term from the sum fails here.
      expect(STALLED_MIN_AGE_SEC).toBeGreaterThanOrEqual(
        RECONCILIATION_REACTIVATION_SEC +
          RECONCILIATION_INTERVAL_SEC +
          REVIEW_PUBLICATION_MARGIN_SEC,
      );
      // Each term contributes — a probe that passed with any of them zeroed
      // would not be testing the sum.
      expect(RECONCILIATION_REACTIVATION_SEC).toBeGreaterThan(0);
      expect(RECONCILIATION_INTERVAL_SEC).toBeGreaterThan(0);
      expect(REVIEW_PUBLICATION_MARGIN_SEC).toBeGreaterThan(0);
    });

    it("an UNDATABLE sticky does NOT bypass — fail closed rather than read absence as freshness", async () => {
      // `updated_at` absent or unparseable must not be treated as "now" (nor
      // as epoch, which would clear the floor while failing condition 5).
      const { dir, stateDir } = writeFixture({
        threads: [],
        checkRuns: [
          {
            ...REVIEWER_RUN,
            status: "in_progress",
            conclusion: null,
            started: OLD_ENOUGH_STARTED,
          },
        ],
        stickyUpdatedAt: "not-a-timestamp",
      });
      seedRounds(stateDir, 0);
      const r = await probeIn(dir, stateDir);
      expect(r.state).toBe("AWAITING_REVIEWER");
    });
  });

  it("mode 3: PR-head replication lag is not judged at all", async () => {
    const { dir, stateDir } = writeFixture({ threads: [], head: PREV });
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive-status.ts"),
        "999",
        "--json",
        "--once",
        "--head",
        HEAD,
      ),
      {
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const json = JSON.parse(out);
    expect(json.state).toBe("HEAD_LAG");
    expect(exitCode).toBe(4);
  });

  it("mode 5: a stale ai-reviewed-sha marker blocks convergence", async () => {
    const r = await probe({ threads: [], reviewedSha: PREV });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain(PREV);
  });

  it("mode 5b: an ABBREVIATED marker naming a DIFFERENT commit is still stale", async () => {
    // The marker grammar admits 7–40 hex, and a prefix comparison accepts any
    // commit sharing the head's first N characters — so a stale review of a
    // different commit passes as fresh, which is mode 5 wearing a disguise.
    // `PREV` is a fabricated SHA; `makeOrphanCommit` gives the marker a real,
    // resolvable commit — created fresh in THIS repository's object store on
    // every run, so the probe holds on any checkout, CI included —
    // whose first PREFIX_LEN characters name a different object entirely.
    //
    // Old behaviour on exactly this input: `${api_head:0:PREFIX_LEN}` == the
    // marker, so CONVERGED. New behaviour: resolve first, then compare in
    // full. `PREV` alone as `head` would not exercise that: its prefix has no
    // reason to match `real`'s, so even the broken prefix-comparison
    // implementation would report STALE_REVIEW here for an unrelated reason,
    // making the probe pass regardless of which implementation is under test.
    // The fabricated head below shares `real`'s prefix — the collision the
    // old comparison would have accepted — while its full SHA still differs.
    //
    // PREFIX_LEN is 16 hex (64 bits), not the 8 (32 bits) a real ABBREVIATED
    // marker could use: at 8, `git rev-parse` can hit an existing object in
    // this repository's own object store sharing those first 32 bits and reject
    // the abbreviation as ambiguous, sending the probe down the cannot-resolve
    // path instead and making it flaky. 64 bits keeps that collision
    // astronomically unlikely while the marker is still well under the 40-hex
    // full length, so it still exercises the ABBREVIATED-marker path this probe
    // is named for.
    const PREFIX_LEN = 16;
    const real = makeOrphanCommit("drive-pr-probe-mode-5b");
    const collidingPrefixHead = `${real.slice(0, PREFIX_LEN)}${PREV.slice(PREFIX_LEN)}`;
    const r = await probe({
      threads: [],
      head: collidingPrefixHead,
      reviewedSha: real.slice(0, PREFIX_LEN),
    });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    // Names the object it actually resolved to, not just the abbreviation.
    expect(r.stderr).toContain(real);
  });

  it("refuses an abbreviated marker it cannot resolve AT ALL", async () => {
    // A shallow clone, a fetch that never brought the object, or no git: the
    // marker witnesses nothing, and the honest report is that this head cannot
    // be confirmed reviewed. It is a prefix of the head, so the old comparison
    // accepted it outright.
    const unresolvable = `ffffff0${"a".repeat(33)}`;
    const r = await probe({
      threads: [],
      head: unresolvable,
      reviewedSha: unresolvable.slice(0, 7),
    });
    expect(r.state).toBe("STALE_REVIEW");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("cannot be resolved");
  });

  it("still converges on an abbreviation that resolves TO the head", async () => {
    // Failing closed must not mean refusing every abbreviation: one that
    // resolves to this exact commit is a genuine witness. Needs a head git can
    // actually resolve, so it uses `realHead()` rather than the opaque `HEAD`
    // token — same reasoning as mode 5b above.
    const head = await realHead();
    const r = await probe({ threads: [], head, reviewedSha: head.slice(0, 8) });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(head);
  });

  it("still accepts a full-length reviewed-SHA equal to the head", async () => {
    // The stamp the reviewer actually emits today is the full 40 characters,
    // and it must not need git at all.
    const r = await probe({ threads: [], reviewedSha: HEAD });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedShaSource).toBe(
      "comment-marker",
    );
  });

  // The probes below were found by running drive-status.ts against its OWN pull
  // request. GitHub returns check-runs newest-FIRST, and one SHA
  // routinely carries several runs under the same name — there, a `cancelled`
  // `Parse ops-followups block` sat alongside the `success` that superseded it.
  it("a superseded (cancelled) check-run does not mark CI failing forever", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [
        // Newest first, exactly as the API orders them.
        {
          name: "Parse ops-followups block",
          status: "completed",
          conclusion: "success",
          app: "github-actions",
          started: "2026-08-03T13:05:00Z",
        },
        {
          name: "Parse ops-followups block",
          status: "completed",
          conclusion: "cancelled",
          app: "github-actions",
          started: "2026-08-03T13:00:00Z",
        },
        REVIEWER_RUN,
      ],
    });
    expect(r.json.ci).toBe("green");
    expect(r.state).toBe("CONVERGED");
  });

  // The `ci` verdict is what announce-merge-ready.ts trusts before telling a
  // human the branch is safe. Every way it can read green while it is not:
  it("a PENDING legacy commit status is not green", async () => {
    const r = await probe({
      threads: [],
      statuses: [
        { context: "CodeRabbit", state: "pending", description: "reviewing" },
      ],
    });
    expect(String(r.json.ci)).toStartWith("pending:");
    expect(String(r.json.ci)).toContain("CodeRabbit");
  });

  it("mode 12: a head that moves MID-EVALUATION is not convergence", async () => {
    // `api_head` is read at the top of evaluate(); the thread query, the
    // summary enumerator and the check-run reads all follow it, each with a
    // 120s deadline. A push anywhere in that window leaves every witness
    // describing a head the PR no longer has, and CONVERGED would name a SHA
    // nobody reviewed.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
      headMovesTo: PREV,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
    expect(r.json.reason).toContain(PREV);
  });
});
