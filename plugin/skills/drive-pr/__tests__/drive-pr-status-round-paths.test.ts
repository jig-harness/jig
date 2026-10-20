/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  LEAVE_OPEN_MARKER,
  NO_OUTCOME_MARKER,
} from "../scripts/lib/outcome.ts";

// Imported, never restated: every fixture age below is derived from the
// production floor, so raising it cannot silently leave a probe sitting
// underneath it and passing vacuously.
import { isLeftOpenThread } from "../scripts/lib/status/evaluate";

import {
  HEAD,
  PREV,
  writeFixture,
  probeIn,
  park,
  hold,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { createStatusEscalationFixtures } from "./drive-pr-status-escalation-fixtures.ts";

useDrivePrSuite();
describe("drive-status.ts structuralEscalationDue", () => {
  const statusEscalationFixtures = createStatusEscalationFixtures();
  const { driveState } = statusEscalationFixtures;

  it("files this round’s anchor paths and publishes them in the report", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
        { id: "PRRT_c", path: "b.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    // A SET, not a list: three findings on two files is two files.
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts", "b.ts"]);
    expect(r.json.structuralEscalationDue).toBe(false);
    expect(
      JSON.parse((await driveState(stateDir, ["round-paths", "999"])).stdout),
    ).toEqual([{ round: 1, paths: ["a.ts", "b.ts"] }]);
  });

  // Regression: `a.ts` and ` a.ts` are two
  // distinct, legitimate repository paths — trimming both before storing them
  // as the recurrence identity would alias them to the same key, arming
  // `structuralEscalationDue` on findings from two different files. `.trim()`
  // is used only to detect a whitespace-only path, never to transform it.
  it("a path’s own leading/trailing whitespace is preserved, not aliased away", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [
        { id: "PRRT_a", path: " a.ts", bot: true },
        { id: "PRRT_b", path: "a.ts", bot: true },
      ],
    });
    const r = await probeIn(dir, stateDir, HEAD, ["--bump-attempt"]);
    expect(r.exitCode).toBe(0);
    expect(
      (r.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual([" a.ts", "a.ts"]);
  });

  it("arms on the same file two consecutive rounds — in the SAME report", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    expect(
      (await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]))
        .json.structuralEscalationDue,
    ).toBe(false);

    // A new head is a new ROUND. The state dir is the first round's, because
    // the durable record is per-PR-per-clone, not per-fixture.
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.exitCode).toBe(0);
    // The field is computed AFTER this round's anchors are filed, so the round
    // that completes the pair says so itself rather than a round later — the
    // off-by-one `--bump-attempt` had to close for `reflectDue`.
    expect(r.json.structuralEscalationDue).toBe(true);
  });

  it("does NOT arm when the rounds land on disjoint files", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "z.ts", bot: true }],
    });
    const r = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r.json.structuralEscalationDue).toBe(false);
  });

  // `set-escalated --invariant` persists what a round believed it
  // closed, and the NEXT arming of the same file echoes it back — so the
  // round investigating a recurrence sees the prior claim directly instead of
  // re-deriving it from the GitHub thread and diff by hand.
  it("echoes the last set-escalated invariant back on the next arming of the same file", async () => {
    const HEAD3 = "c9e3a2b006333333333333333333333333333333";
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(r2.json.structuralEscalationDue).toBe(true);
    // Armed, but nothing has been acknowledged yet — nothing to echo.
    expect(r2.json.structuralEscalationInvariant).toBeNull();

    await driveState(round1.stateDir, [
      "set-escalated",
      "999",
      "--invariant",
      "the recovery guard wraps every step past the reset boundary",
    ]);

    const round3 = writeFixture({
      head: HEAD3,
      threads: [{ id: "PRRT_c", path: "a.ts", bot: true }],
    });
    const r3 = await probeIn(round3.dir, round1.stateDir, HEAD3, [
      "--bump-attempt",
    ]);
    expect(r3.json.structuralEscalationDue).toBe(true);
    expect(r3.json.structuralEscalationInvariant).toBe(
      "the recovery guard wraps every step past the reset boundary",
    );
  });

  // The mirror case: while the duty is discharged (not armed), the field is
  // `null` even though a prior invariant was recorded — a live claim is only
  // worth surfacing while something is actively re-litigating it.
  it("does not echo the invariant while the escalation is discharged", async () => {
    const round1 = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    await probeIn(round1.dir, round1.stateDir, HEAD, ["--bump-attempt"]);
    const round2 = writeFixture({
      head: PREV,
      threads: [{ id: "PRRT_b", path: "a.ts", bot: true }],
    });
    await probeIn(round2.dir, round1.stateDir, PREV, ["--bump-attempt"]);

    await driveState(round1.stateDir, [
      "set-escalated",
      "999",
      "--invariant",
      "a claim that should not resurface once discharged",
    ]);
    expect(
      (await driveState(round1.stateDir, ["escalation-due", "999"])).stdout,
    ).toBe("false");

    const round3 = writeFixture({
      head: "c9e3a2b006333333333333333333333333333333",
      threads: [{ id: "PRRT_c", path: "z.ts", bot: true }],
    });
    const r3 = await probeIn(
      round3.dir,
      round1.stateDir,
      "c9e3a2b006333333333333333333333333333333",
      ["--bump-attempt"],
    );
    expect(r3.json.structuralEscalationDue).toBe(false);
    expect(r3.json.structuralEscalationInvariant).toBeNull();
  });

  // A parked thread is a human decision already made, not a recurring root
  // cause the fix keeps missing — counting it would arm the signal for as
  // long as it stays parked, on a file nothing new landed on.
  // The SAME thread id anchors `a.ts` in both
  // rounds here, unresolved and parked throughout; each round also carries a
  // genuinely live thread on a DIFFERENT file so the round stays ROUND_READY
  // (case 0, which records anchors, never runs on HITL_PARKED) without that
  // live thread itself supplying a false intersection.
  it("a parked thread’s path never feeds the recurrence signal, even unchanged across rounds", async () => {
    const round1 = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    await park(round1.stateDir, "PRRT_a", "thread");
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // A thread left open on purpose (`triage-thread.ts --leave-open`, usually a
  // human thread per `/jig:resolve-review-comments` § Human threads) is a settled
  // decision, not a recurring root cause — it stays unresolved on GitHub
  // forever by design, so without this exclusion it would arm the signal for
  // as long as the PR stays open, on a file nothing new landed on.
  // Same shape as the parked-thread probe
  // above: the SAME thread id anchors `a.ts` in both rounds, with its
  // qualifying reply and leave-open marker unchanged throughout, and each
  // round also carries a genuinely live thread on a different file so the
  // round stays ROUND_READY.
  it("a left-open thread’s path never feeds the recurrence signal, even unchanged across rounds", async () => {
    const leftOpenThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: `**wont-fix** — deliberately left open.\n\n${LEAVE_OPEN_MARKER}`,
        },
      ],
    };
    const round1 = writeFixture({
      threads: [leftOpenThread, { id: "PRRT_live1", path: "b.ts", bot: true }],
    });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [leftOpenThread, { id: "PRRT_live2", path: "c.ts", bot: true }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // A HELD thread (`**accepted**`, awaiting `resolve-held-thread.ts` after
  // this round's own push) is triaged work awaiting its own external
  // mutation, not a finding that landed again — the same argument the parked
  // and left-open probes above make, extended to the third way a thread stays
  // open with nothing new for the next pass to have caused. Reachable from a
  // single transient sweep failure inside `finish-round.ts`'s drain.
  // Unlike a park, holding does NOT
  // remove the thread from `work.unresolvedThreads` — a held item is still
  // live work for ITS round, only its recurrence evidence is stale — so that
  // count is pinned unchanged alongside the path exclusion.
  it("a held thread’s path never feeds the recurrence signal, but still counts as open work", async () => {
    const round1 = writeFixture({
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    // The default single-comment thread's own url — `threadCommentNodes`
    // (no per-thread `comments` override) — is what the hold's `commentUrl`
    // must match for the exclusion to hold: `evaluate.ts` now compares the
    // hold against the thread's OWN most recent comment, not the threadId
    // alone (see the dedicated superseded-hold probe below for the case this
    // replaced).
    await hold(
      round1.stateDir,
      "PRRT_a",
      "thread",
      "https://example.invalid/PRRT_a",
    );
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);
    expect((r1.json.work as Record<string, unknown>).unresolvedThreads).toBe(2);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        { id: "PRRT_a", path: "a.ts", bot: true },
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);
  });

  // Regression for the fix itself: a hold
  // recorded against ONE comment must not go on vouching for the thread once
  // a LATER comment lands on it — the reviewer's own example is a plain new
  // finding, not a re-triage, so the comparison must key on the thread's
  // literal most recent comment, not merely its most recent QUALIFYING one.
  it("a held thread SUPERSEDED by a later comment is no longer excluded from recurrence evidence", async () => {
    const round1 = writeFixture({
      threads: [
        {
          id: "PRRT_a",
          path: "a.ts",
          bot: false,
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            {
              author: "example-user-2",
              authorAssociation: "OWNER",
              body: "**accepted** — fixed already; posting once pushed.",
            },
            // Landed AFTER the hold below was recorded — an ordinary new
            // bot finding on the same still-open thread, exactly the
            // reviewer's own example, never itself a "qualifying" reply.
            { authorAssociation: "NONE", body: "a fresh finding", bot: true },
          ],
        },
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    // Recorded against the SECOND comment (index 1) — the accepted reply —
    // which is no longer the thread's last comment once the third one lands.
    await hold(
      round1.stateDir,
      "PRRT_a",
      "thread",
      "https://example.invalid/PRRT_a/comment-1",
    );
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts", "b.ts"]);
  });

  // Same argument, for a held SUMMARY finding — no thread, so the exclusion
  // has to key on the fingerprint `answer-summary-finding.ts` will eventually
  // post against, not a thread id. The fixture's two backlog findings both
  // anchor `AGENTS.md` (see `backlogJson` above), so both are held here —
  // otherwise the sibling, still-unaddressed finding on the same path would
  // keep it in the list and the assertion would prove nothing about the fix.
  it("a held summary finding’s path never feeds the recurrence signal", async () => {
    const round1 = writeFixture({ backlog: true });
    await hold(round1.stateDir, "b9a7a18089043564", "finding");
    await hold(round1.stateDir, "c773d9fdb7974e6d", "finding");
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual([]);
    // Held, not answered — summaryUnaddressed still counts both; only the
    // path list, fed to structuralEscalationDue, excludes them.
    expect((r1.json.work as Record<string, unknown>).summaryUnaddressed).toBe(
      2,
    );
  });

  // A trusted `--no-outcome` clarification reply is a settled ask-and-wait, not
  // a live finding still open: `reply-to-thread.ts` appends `NO_OUTCOME_MARKER`
  // itself whenever `--no-outcome` is passed, and `isLeftOpenThread` now
  // requires that durable marker rather than inferring the clarification path
  // from a bare absence of an outcome token — the marker is what tells this
  // case apart from a trusted author's own outcome-less prose posted straight
  // on GitHub, which can never carry it. As long as the marked reply stays the
  // thread's most recent comment, this path must not feed the recurrence signal
  // — same shape as the left-open probe above.
  it("a trusted no-outcome clarification’s path never feeds the recurrence signal, until answered", async () => {
    const clarificationThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: `Can you clarify which caller you mean?\n\n${NO_OUTCOME_MARKER}`,
        },
      ],
    };
    const round1 = writeFixture({
      threads: [
        clarificationThread,
        { id: "PRRT_live1", path: "b.ts", bot: true },
      ],
    });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["b.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [
        clarificationThread,
        { id: "PRRT_live2", path: "c.ts", bot: true },
      ],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["c.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(false);

    // Once the reviewer answers, the thread is live again and must count.
    const answeredThread = {
      ...clarificationThread,
      comments: [
        ...clarificationThread.comments,
        { authorAssociation: "NONE", body: "The caller in foo.ts:12." },
      ],
    };
    const round3 = writeFixture({
      head: HEAD,
      threads: [answeredThread, { id: "PRRT_live3", path: "a.ts", bot: true }],
    });
    const r3 = await probeIn(round3.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r3.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
  });

  // The bug this marker requirement fixes: a trusted author can reply directly
  // on GitHub with ordinary prose ("I agree; please fix this") that never
  // passes through `reply-to-thread.ts` and so never carries
  // `NO_OUTCOME_MARKER`. Before the marker was required,
  // `qualifyingOutcome(body) === null` alone treated this identically to a
  // genuine `--no-outcome` clarification, silently dropping a live finding
  // recurrence from the signal. It must instead be read as live, unresolved
  // work.
  it("a trusted author’s unmarked outcome-less reply is never mistaken for a clarification", async () => {
    const unmarkedReplyThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "I agree; please fix this.",
        },
      ],
    };
    const round1 = writeFixture({ threads: [unmarkedReplyThread] });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ ...unmarkedReplyThread, id: "PRRT_b" }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(true);
  });

  // A thread's FIRST comment is the finding that OPENED it, never a reply —
  // the outcome-token grammar applies to replies posted after triage, not to
  // opening comments. On an interactive/non-`--bots-only` run, a human
  // OWNER/MEMBER/COLLABORATOR can open a brand-new thread directly, and its
  // opening comment naturally carries no outcome token — the identical shape
  // the left-open and clarification probes above use for their SECOND
  // comment. Reading a single trusted, outcome-less comment as a left-open
  // marker candidate would misclassify this fresh, live finding as an
  // already-settled clarification and permanently blind
  // `structuralEscalationDue` to every fresh human finding on that file
  // — so, unlike those two probes, this
  // one MUST feed the recurrence signal and arm on the second round.
  it("a fresh single-comment thread from a trusted author is never mistaken for left-open", async () => {
    const freshHumanThread = {
      id: "PRRT_a",
      path: "a.ts",
      bot: false,
      comments: [
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "This new fetch does not verify origin before dereferencing it.",
        },
      ],
    };
    const round1 = writeFixture({ threads: [freshHumanThread] });
    const r1 = await probeIn(round1.dir, round1.stateDir, HEAD, [
      "--bump-attempt",
    ]);
    expect(
      (r1.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);

    const round2 = writeFixture({
      head: PREV,
      threads: [{ ...freshHumanThread, id: "PRRT_b" }],
    });
    const r2 = await probeIn(round2.dir, round1.stateDir, PREV, [
      "--bump-attempt",
    ]);
    expect(
      (r2.json.work as Record<string, unknown>).unresolvedThreadPaths,
    ).toEqual(["a.ts"]);
    expect(r2.json.structuralEscalationDue).toBe(true);
  });

  // A comment array element is untrusted input off an external enumerator: a
  // `null`/non-object element must not crash the scan reading
  // `.authorAssociation` off it. Unreachable through the full CLI pipeline
  // above — the real thread producer sanitizes/crashes on a malformed
  // GraphQL comment node before evaluate.ts would ever see one — so this
  // calls the exported pure function directly.
  describe("isLeftOpenThread — a malformed comment element never throws", () => {
    const trustedNoOutcome = {
      authorAssociation: "OWNER",
      body: "Any update on this?",
    };

    it("a null last comment is treated as absent, not as a crash", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, null],
        }),
      ).not.toThrow();
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, null],
        }),
      ).toBe(false);
    });

    it("a null earlier comment in the backward scan is skipped, not thrown on", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            null,
            trustedNoOutcome,
          ],
        }),
      ).not.toThrow();
    });

    it("a non-object comment element (string/number) is treated the same as null", () => {
      expect(() =>
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [{ authorAssociation: "NONE", body: "a finding" }, 5],
        }),
      ).not.toThrow();
    });
  });

  // The leave-open marker is human-thread-only by design — a bot-started
  // thread must always eventually resolve. `isLeftOpenThread` must not grant
  // the exemption on `confirmedHumanStarted` alone being absent/malformed
  // either (fail closed: count the thread as live, never silently exempt
  // it) — the field's PRODUCER (list-unresolved-threads.ts) is
  // fixture-tested where that field is actually computed, not here; this
  // describe block fixture-tests only this function's own consumption of
  // whatever the field says.
  describe("isLeftOpenThread — the leave-open marker is human-thread-only", () => {
    const leaveOpenReply = {
      author: "example-user-2",
      authorAssociation: "OWNER",
      body: `**wont-fix** — pre-existing, not part of this diff.\n\n${LEAVE_OPEN_MARKER}`,
    };

    it("grants the exemption when confirmedHumanStarted is explicitly true", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: true,
          comments: [
            { authorAssociation: "NONE", body: "a human finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(true);
    });

    it("refuses the exemption when confirmedHumanStarted is false", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: false,
          comments: [
            { authorAssociation: "NONE", body: "a bot finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the exemption when confirmedHumanStarted is missing (fail closed)", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });

    it("refuses the exemption when confirmedHumanStarted is a malformed non-boolean", () => {
      expect(
        isLeftOpenThread({
          threadId: "PRRT_a",
          confirmedHumanStarted: "yes" as unknown,
          comments: [
            { authorAssociation: "NONE", body: "a finding" },
            leaveOpenReply,
          ],
        }),
      ).toBe(false);
    });
  });
});
