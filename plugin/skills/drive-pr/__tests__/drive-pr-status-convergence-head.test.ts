/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { writeFileSync } from "node:fs";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  HEAD,
  PREV,
  realHead,
  STICKY_ROUND,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  writeFixture,
  probe,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

useDrivePrSuite();
describe("drive-status.ts refuses to converge — the measured false-convergence modes", () => {
  it("mode 12b: EVERY terminal return re-checks the head, not just CONVERGED", async () => {
    // The first version of this guard covered CONVERGED alone. HITL_PARKED is
    // also terminal, also stops drive.ts, and returns a few lines earlier — so
    // a parked drive could hand back against a head another actor had already
    // replaced, and the newer head would go unreviewed until a human looked.
    // Guarding per-site means remembering it again at the next terminal state
    // anyone adds, which is the class of guard this skill exists to mechanize.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
      headMovesTo: PREV,
    });
    await park(stateDir, "PRRT_parked", "thread");
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
    // Without the guard this is HITL_PARKED / 8 — terminal, on a stale head.
    expect(JSON.parse(out).state).toBe("HEAD_MOVED");
    expect(exitCode).toBe(4);
  });

  it("an unreadable PARKED set is indeterminate, not an empty one", async () => {
    // `|| true` here undid the fail-closed state reader one layer up: state
    // that becomes malformed after startup would report zero parked items, so
    // a thread a human parked reads as live work and the drive re-arms it.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    writeFileSync(join(stateDir, "drive-pr-999.json"), "not json at all");
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
    expect(exitCode).toBe(1);
    const json = JSON.parse(out);
    expect(json.state).toBe("INDETERMINATE");
    // The REASON, not just the state. Malformed state also breaks the round-count
    // persist a few lines later, which reports the same exit and the same state —
    // so asserting only those lets this pass while the parked read still swallows
    // its error, which is precisely the defect.
    expect(json.reason).toContain("parked set");
  });

  it("reads EVERY page of legacy commit statuses before calling CI green", async () => {
    // A commit can carry more than one page of status contexts. Reading only
    // the first drops the rest from the verdict entirely, so a failing context
    // on page 2 leaves `ci_verdict: green` — and announce-merge-ready.ts, which
    // refuses on anything but exactly `green`, then tells a human every
    // non-reviewer check succeeded over one nobody looked at.
    const r = await probe({
      threads: [],
      statuses: [{ context: "page-1/ok", state: "success", description: "" }],
      statusesPage2: [
        { context: "page-2/broken", state: "failure", description: "" },
      ],
    });
    expect(r.json.ci).toContain("failing");
    expect(r.json.ci).toContain("page-2/broken");
  });

  it("an UNREADABLE commit-status API is unknown, not green", async () => {
    // A timeout or 403 must not read as "no legacy statuses exist".
    const r = await probe({ threads: [], statusesUnreadable: true });
    expect(String(r.json.ci)).toStartWith("unknown:");
  });

  it("two apps sharing a check NAME do not mask each other", async () => {
    // Grouping by name alone lets one app's newer success discard the other's
    // failure, and announce-merge-ready.ts then claims everything is green.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          app: "app-a",
          started: "2026-08-03T13:05:00Z",
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "failure",
          app: "app-b",
          started: "2026-08-03T13:00:00Z",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("failing:");
    expect(String(r.json.ci)).toContain("lint");
  });

  it("a completed run with a NULL conclusion is pending, not green", async () => {
    // It matched neither the failing nor the pending predicate and so vanished
    // from the verdict entirely, leaving `green` over an indeterminate run.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "flaky",
          status: "completed",
          conclusion: null,
          app: "github-actions",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("pending:");
    expect(String(r.json.ci)).toContain("flaky");
  });

  it("a QUEUED reviewer rerun is not superseded by the completed run it replaces", async () => {
    // A queued attempt has no `started_at`. Ordering on that timestamp sorted
    // it BEFORE the old completed run, so `last` picked the stale success and
    // declared CONVERGED while a fresh review was pending. Ordering is on the
    // monotonic run id instead — the queued rerun is listed first (newest) and
    // therefore carries the higher id.
    const r = await probe({
      threads: [],
      checkRuns: [
        { ...REVIEWER_RUN, status: "queued", conclusion: null, started: null },
        { ...REVIEWER_RUN, started: "2026-08-03T13:00:00Z" },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("a FAILING sibling check from the reviewer app still counts against CI", async () => {
    // Excluding the whole app from the verdict — rather than just the posting
    // review check — dropped its siblings entirely, so a failing one read green.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "coverage telemetry",
          status: "completed",
          conclusion: "failure",
          app: "example-review",
        },
        REVIEWER_RUN,
      ],
    });
    expect(String(r.json.ci)).toStartWith("failing:");
    expect(String(r.json.ci)).toContain("coverage telemetry");
  });

  it("a sibling check from the reviewer APP does not attest that review completed", async () => {
    // The app slug alone is not an identity: an app may publish several checks
    // on one SHA. Only the named reviewer check counts.
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          name: "coverage telemetry",
          status: "completed",
          conclusion: "success",
          app: "example-review",
        },
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
  });

  it("judges the reviewer on its NEWEST run, not the API’s first-listed one", async () => {
    // A re-run superseding a failed attempt. Taking the array's `last` would
    // read the older FAILURE and report REVIEWER_FAILED on a clean re-review.
    const r = await probe({
      threads: [],
      checkRuns: [
        { ...REVIEWER_RUN, started: "2026-08-03T13:05:00Z" },
        {
          ...REVIEWER_RUN,
          conclusion: "failure",
          started: "2026-08-03T13:00:00Z",
        },
      ],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("still reports REVIEWER_FAILED when the NEWEST reviewer run failed", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [
        {
          ...REVIEWER_RUN,
          conclusion: "failure",
          started: "2026-08-03T13:05:00Z",
        },
        { ...REVIEWER_RUN, started: "2026-08-03T13:00:00Z" },
      ],
    });
    expect(r.state).toBe("REVIEWER_FAILED");
    expect(r.exitCode).toBe(7);
  });

  it("an inline comment from an EARLIER round does not hide a new summary finding", async () => {
    // Anchoring is a per-round property. Matching against every inline comment
    // the PR ever received means one thread on `a.ts` in round 1 hides every
    // later summary-only finding on `a.ts`, permanently.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md"],
      anchoredRound: STICKY_ROUND - 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("a sticky with NO round marker anchors nothing, rather than anchoring everything", async () => {
    // With no round to scope by, admitting every inline comment the reviewer
    // ever posted lets a long-resolved comment at the same `path:line` consume
    // a current bullet — the live finding vanishes from `summaryUnaddressed`
    // while thread count reads zero, which is the false convergence reached
    // through the one input nobody controls. Fail closed: nothing anchors, so
    // the bullet stays open work.
    const r = await probe({
      threads: [],
      backlog: false,
      stickyRound: null,
      // An inline comment anchored EXACTLY to the bullet, which would cover it
      // if the historical set were still trusted.
      anchored: [".claude/agents/review-arbiter.md:31"],
      anchoredRound: 1,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("records the round for a ready head, and refuses to proceed when it cannot", async () => {
    // `|| true` here returned ROUND_READY having recorded nothing. Since the
    // per-process pass counter resets, every restart then granted another full
    // `--max-rounds` on a counter that never advanced.
    const { dir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    // A regular FILE where the state dir belongs: `mkdir -p` cannot create it,
    // which is what an unwritable state dir looks like from here.
    const blocked = join(dir, "unwritable-state");
    writeFileSync(blocked, "not a directory");
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
          DRIVE_PR_STATE_DIR: blocked,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(out).state).toBe("INDETERMINATE");
  });

  it("reads the reviewed-SHA witness only from the STICKY comment", async () => {
    // A non-sticky reviewer comment carrying a marker for an older head must
    // not override the real witness — the contract names the sticky.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      decoyReviewerComments: [`chatter\n<!-- ai-reviewed-sha: ${PREV} -->`],
    });
    expect(r.state).toBe("CONVERGED");
    expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(HEAD);
  });

  it("one anchored finding does not suppress a second finding on the SAME file", async () => {
    // Reducing anchoring to a set of PATHS meant a neighbour's thread hid this
    // finding entirely. The inline comment here is anchored to line 31; the
    // body bullet in the fixture is also line 31, so a line-99 anchor must NOT
    // cover it.
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:99"],
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("an inline comment anchored to the finding DOES cover it", async () => {
    const r = await probe({
      threads: [],
      backlog: false,
      anchored: [".claude/agents/review-arbiter.md:31"],
    });
    expect(r.state).toBe("CONVERGED");
  });

  it("an addressed marker from an untrusted commenter does not permit convergence", async () => {
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      addressed: ["b9a7a18089043564", "c773d9fdb7974e6d"],
      addressedBy: "NONE",
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(2);
  });

  it("CLI wiring: a backlog fix marker at the reviewed head registers end to end", async () => {
    // Unlike the `collectAddressed` unit probes in `summary-findings parsing`
    // above, this drives the REAL chain: `drive-status.ts` spawns
    // `summary-findings.ts` as a subprocess, which reads the sticky's own
    // backlog blob via `backlogFingerprintsOf` and wires it into
    // `collectAddressed` itself — nothing here calls either function
    // directly. A one-line regression to that wiring (`backlogFingerprints:
    // new Set()`, or restoring the retired `reason === 'winddown-deferred'`
    // filter) would leave `c773d9fdb7974e6d` unaddressed here even though
    // every direct-call probe above still passes.
    //
    // Only ONE of the sticky's two backlog entries gets a marker, so the
    // count below is unambiguous evidence THIS fingerprint registered — a
    // wiring bug that drops backlog membership entirely would leave both
    // unaddressed and this would read 2, not 1.
    //
    // The head here must be one `reviewerPosition` can RESOLVE: it decides
    // `at` vs `past` through `git rev-parse`, and an unresolvable revision
    // fails closed to `past`, which drops the marker and makes this read 2 for
    // a reason that has nothing to do with the wiring under test. Hence
    // `realHead()` rather than the opaque `HEAD` token (see its own comment —
    // a literal that resolved only in checkouts carrying one idle branch is
    // what this probe originally had).
    const head = await realHead();
    const r = await probe({
      threads: [],
      backlog: true,
      anchored: [".claude/agents/review-arbiter.md"],
      head,
      reviewedSha: head,
      fixDependentAddressed: [{ fingerprint: "c773d9fdb7974e6d", sha: head }],
    });
    expect((r.json.work as Record<string, unknown>).summaryUnaddressed).toBe(1);
  });

  it("no marker at all falls back to the check-run, and SAYS the witness is weaker", async () => {
    // The fallback survives for a ROUND: evidence of live work is positive
    // there, so a weak SHA witness costs nothing.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      reviewedSha: null,
    });
    expect(r.state).toBe("ROUND_READY");
    expect((r.json.reviewer as Record<string, unknown>).reviewedShaSource).toBe(
      "check-run",
    );
  });

  it("mode 7: a completed reviewer that published NO sticky cannot converge", async () => {
    // Both zeroes convergence rests on are read out of the sticky comment's
    // neighbourhood — summary-findings.ts reads a missing sticky as zero
    // findings, and a review that posted nothing leaves zero threads. So a
    // completed check-run with no published sticky makes "nothing left to say"
    // and "nothing was ever said" the same observation, and the weaker witness
    // cannot tell them apart.
    const r = await probe({ threads: [], reviewedSha: null });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });

  it("mode 8: a reviewer-app sibling whose NAME merely contains the pattern does not attest", async () => {
    // The (app, name) pair only splits siblings if the name half is anchored.
    // Unanchored it is a substring match, so `AI review telemetry` from the
    // reviewer's own app rejoins the set the pair exists to exclude — and the
    // newest-run reduction then lets its success stand in for a posting check
    // that never ran.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      checkRuns: [
        {
          name: "AI review telemetry",
          status: "completed",
          conclusion: "success",
          app: "example-review",
        },
        DORMANT_ARM,
      ],
    });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.exitCode).toBe(4);
  });
});
