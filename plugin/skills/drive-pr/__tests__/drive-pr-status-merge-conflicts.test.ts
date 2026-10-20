/**
 * drive-pr suite: drive-status.ts: terminal states, drafts, conflicts and the measured false-convergence modes.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import { join, delimiter } from "node:path";

import { claimWasTakenOver, roundFingerprint } from "../scripts/drive";

import {
  SCRIPTS,
  HEAD,
  PREV,
  BASE_MOVED,
  REVIEWER_RUN,
  DORMANT_ARM,
  binDir,
  gitCleanEnv,
  writeFixture,
  probeIn,
  probe,
  park,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

useDrivePrSuite();

// Mode 14: a conflicting PR runs no `pull_request` CI, so the posting
// reviewer never creates a check-run and the mode-4 guard — correctly, on its
// own evidence — reports AWAITING_REVIEWER and polls to `--timeout`. Exit 4
// means "becomes something else with time", which a conflict never does.
describe("drive-status.ts merge conflicts", () => {
  /** Exactly the observed check-run set on the conflicting head. */
  const CONFLICTED_CHECKS = [DORMANT_ARM];

  it("PR_CONFLICTING — reported instead of AWAITING_REVIEWER, when nothing is workable", async () => {
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(r.json.merge).toEqual({
      mergeable: "CONFLICTING",
      stateStatus: "DIRTY",
    });
    // The message has to name the fix, not the symptom — and the base branch
    // by name, since it is read from the snapshot rather than assumed.
    expect(r.stderr).toContain("Merge develop into this one");
  });

  it("does not poll to --timeout, the way exit 4 does", async () => {
    // The distinguishing property, asserted on the WAITING path: `--once`
    // returns every state promptly, so a probe that keeps it cannot tell a
    // terminal conflict from the 30-minute wait this replaces. The control
    // below is the same fixture with the conflict removed.
    const started = Date.now();
    const r = await probe(
      {
        threads: [],
        checkRuns: CONFLICTED_CHECKS,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      },
      ["--timeout", "20", "--interval", "5"],
      { once: false },
    );
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(Date.now() - started).toBeLessThan(15_000);

    // One 1s poll is enough to show the control waits out its budget.
    const control = await probe(
      { threads: [], checkRuns: CONFLICTED_CHECKS },
      ["--timeout", "2", "--interval", "1"],
      { once: false, env: { DRIVE_PR_STATUS_MIN_INTERVAL: "1" } },
    );
    expect(control.state).toBe("AWAITING_REVIEWER");
    expect(control.exitCode).toBe(4);
    expect(control.stderr).toContain("gave up after");
  });

  it("does NOT preempt a round that has live work", async () => {
    // The first cut short-circuited here, on the premise that a conflicting
    // head has no findings "because GitHub runs no pull_request CI on it".
    // That premise is false: the live reviewer is a self-hosted POLLER, whose
    // eligibility predicate (non-draft, base develop, same-repo head, head not
    // yet reviewed) contains no mergeability term at all — and the only
    // pull_request_target arm in this repo is dormant. A poller is not stopped
    // by a conflict, so findings CAN sit on a conflicting head, and
    // short-circuiting discarded them unread.
    const r = await probe({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    });
    expect(r.state).toBe("ROUND_READY");
    expect(r.exitCode).toBe(0);
    // ...but the pass has to be told, or it will push into a branch no CI runs on.
    expect(r.json.reason).toContain("conflicts with its base");
  });

  // The same gap shows from both directions: skipping the reviewer
  // GATES on a conflicting head also skipped READING the reviewed-SHA marker,
  // so the round said nothing about whether its findings were current. The
  // answer is to report it, never to gate on it — gating is the stall
  // under another name, and an unresolved thread is open work on any head.
  describe("reviewer evidence on a conflicting head", () => {
    const CONFLICT_WORK = {
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    };

    it("names a STALE marker in the reason, and still hands the round out", async () => {
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: PREV });
      // Reported, NOT gated: the state is unchanged by the staleness.
      expect(r.state).toBe("ROUND_READY");
      expect(r.exitCode).toBe(0);
      expect(r.json.reason).toContain("predate");
      // The evidence itself is published, so a caller need not parse prose.
      const reviewer = r.json.reviewer as Record<string, unknown>;
      expect(reviewer.reviewedSha).toBe(PREV);
      expect(reviewer.reviewedShaSource).toBe("comment-marker");
    });

    it("says so when the marker DOES name this head", async () => {
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: HEAD });
      expect(r.state).toBe("ROUND_READY");
      expect(r.json.reason).toContain("did review this exact head");
      expect((r.json.reviewer as Record<string, unknown>).reviewedSha).toBe(
        HEAD,
      );
    });

    it("never substitutes the check-run fallback when there is no marker", async () => {
      // `reviewedShaSource: check-run` means "queried BY SHA, so it always
      // matches" — on a path where no reviewer gate ran, publishing it would
      // assert a review this script has no evidence of. Absent stays absent.
      const r = await probe({ ...CONFLICT_WORK, reviewedSha: null });
      expect(r.state).toBe("ROUND_READY");
      const reviewer = r.json.reviewer as Record<string, unknown>;
      expect(reviewer.reviewedShaSource).not.toBe("check-run");
      expect(reviewer.reviewedSha).toBe("");
      expect(r.json.reason).toContain("cannot be dated");
    });
  });

  it("a conflict beats HITL_PARKED when nothing is workable, naming the parked items", async () => {
    // Both are terminal and both are true. An operator handed a merge and a
    // question should get the mechanical one first — but the parked counts
    // stay in the reason so the precedence hides nothing.
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
    });
    await park(stateDir, "PRRT_parked", "thread");
    const r = await probeIn(dir, stateDir);
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect(r.json.reason).toContain("1 parked thread(s)");
  });

  it("liveness still wins — a merged PR stops the loop first", async () => {
    const r = await probe({
      prState: "MERGED",
      threads: [],
      mergeable: "CONFLICTING",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("head sync still wins — mergeability is a property OF a head", async () => {
    // The false terminal this ordering prevents: a driver that pushes the base
    // merge and re-polls inside GitHub's replication window would otherwise
    // read the PRE-push CONFLICTING verdict and report a terminal state for the
    // conflict it had just fixed.
    // The API is one push behind, exactly as in mode 3: the fixture's head is
    // PREV while the local tree is already at HEAD. The later `--head` wins.
    const r = await probe(
      { threads: [], head: PREV, mergeable: "CONFLICTING" },
      ["--head", HEAD],
    );
    expect(r.state).toBe("HEAD_LAG");
    expect(r.exitCode).toBe(4);
  });

  it("a head that moves mid-evaluation is HEAD_MOVED, not a terminal conflict", async () => {
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      headMovesTo: PREV,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });

  it("UNKNOWN is not settled either way — not judged, not converged", async () => {
    // The FIRST cut of this guard let UNKNOWN proceed straight to the
    // reviewer/work checks below, which could report CONVERGED over a
    // mergeability verdict GitHub itself had not finished computing — the
    // false-CONVERGED sibling of the false-CONFLICTING case this whole guard
    // exists to prevent.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(r.state).toBe("MERGEABILITY_UNKNOWN");
    expect(r.exitCode).toBe(4);
    expect((r.json.merge as Record<string, unknown>).mergeable).toBe("UNKNOWN");
  });

  it("a gh missing a required field is a PREREQUISITE error, not a degraded mode", async () => {
    // An earlier version built a three-tier CLI-version fallback ladder plus a
    // second REST parser here, and every tier then needed its own binding and
    // validation guards — each of which produced the next round's findings.
    // A backward-compatibility ladder of that shape is exactly what to avoid,
    // and the premise was thin anyway: the fields have all been in `gh`
    // for years. Requiring them deletes the whole surface. Exit 2 is the usage
    // /configuration code, and the message has to name the fix.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeabilityUnreadable: true,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("upgrade the GitHub CLI");
    expect(r.stderr).toContain("mergeable");
    // Never a terminal verdict, and never a quiet degrade.
    expect(r.state).not.toBe("CONVERGED");
    expect(r.state).not.toBe("PR_CONFLICTING");
    // ...and it goes through the REPORTER. The first cut called `exit 2` from
    // inside evaluate(), which skips report() entirely: `--json` emitted stderr
    // and no object at all, so a caller parsing the documented contract got an
    // empty string and could not tell this from a crash. `probe` parses stdout,
    // so an empty state here IS that bug.
    expect(r.state).toBe("UNSUPPORTED_CLI");
    expect(r.json.exit).toBe(2);
    expect(r.json.pr).toBe(999);
    expect(String(r.json.reason)).toContain("upgrade the GitHub CLI");
  });

  it("an unreadable check-runs API does not block PR_CONFLICTING", async () => {
    // On a conflicting head every consumer of `runs` is already skipped, so
    // hard-failing on that query let a timeout or a 403 on evidence this path
    // does not use block the new state from ever being reported.
    const r = await probe({
      threads: [],
      mergeable: "CONFLICTING",
      checkRunsUnreadable: true,
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    // ...but the empty stand-in must never read as a clean CI verdict.
    expect(r.json.ci).toContain("unknown");
  });

  it("an unreadable check-runs API is still INDETERMINATE on a MERGEABLE head", async () => {
    // The control: where the evidence IS used, an unreadable query is exactly
    // what it was before — never an empty (therefore clean) set.
    const r = await probe({ threads: [], checkRunsUnreadable: true });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
  });

  it("liveness is still checked FIRST, even on an unsupported gh", async () => {
    // Folding liveness into the combined required-field read broke the
    // "a merged or closed PR stops the loop before anything else" contract:
    // on an old `gh` a finished PR reported a configuration error, so a caller
    // could not tell a PR that is simply done from a CLI it cannot use. The
    // `state` field alone is supported by every `gh` that has the subcommand.
    const r = await probe({
      prState: "MERGED",
      threads: [],
      mergeabilityUnreadable: true,
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
    expect(r.exitCode).not.toBe(2);
  });

  it("a malformed snapshot is INDETERMINATE, not silently mergeable", async () => {
    // A nominally SUCCESSFUL read carrying a null/absent/unhandled `mergeable`
    // collapsed to "" and fell through the case exactly as though the PR were
    // mergeable.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      mergeable: "SOMETHING_NEW",
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no handled 'mergeable' value");
  });

  it("a missing mergeStateStatus does NOT block the state it annotates", async () => {
    // The counterpart to the test above, and the other half of the contract
    // review read as self-contradictory. Validation is scoped to the fields a
    // state is DECIDED from — `mergeable` picks the branch, `baseRefOid` arms
    // the base-race guard. `mergeStateStatus` and `baseRefName` are reported
    // and nothing branches on them, so requiring them would block
    // PR_CONFLICTING over evidence this path never consumes — exactly the
    // regression the check-runs read once had to undo. It degrades to an
    // omitted parenthetical instead.
    const r = await probe({
      threads: [],
      checkRuns: CONFLICTED_CHECKS,
      mergeable: "CONFLICTING",
      mergeStateStatusMissing: true,
    });
    expect(r.state).toBe("PR_CONFLICTING");
    expect(r.exitCode).toBe(9);
    expect((r.json.merge as Record<string, unknown>).stateStatus).toBe("");
    // Reported as absent, never invented — and the fix is still named.
    expect(r.json.reason).not.toContain("mergeStateStatus=");
    expect(r.stderr).toContain("Merge develop into this one");
  });

  it("a snapshot missing baseRefOid is INDETERMINATE, not a silent guard-off", async () => {
    // The base-race guard is unconditional now, so an absent baseRefOid is
    // always a malformed response — there is no tier that opted out of it.
    const r = await probe({ threads: [], reviewedSha: HEAD, base: "" });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no 'baseRefOid'");
  });

  it("a TRANSIENT failure is INDETERMINATE, never a silent degrade", async () => {
    // An earlier fallback conflated ANY failure of the full read with "this
    // token cannot access mergeability". A transient blip (network, rate
    // limit, timeout) that happens to clear before the narrower retry would
    // then silently disable the merge-conflict guard for that evaluation —
    // and that evaluation can be the one reporting CONVERGED. Distinguished
    // now by the `gh` error text itself: only "Unknown JSON field" — a
    // deterministic, client-side, version-based failure — degrades. Anything
    // else, including this fixture's simulated network failure, must report
    // INDETERMINATE so the caller's existing MAX_QUERY_ERRORS retry handles it.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      transientMergeabilityFailure: true,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("transient failure");
    // Specifically NOT mistaken for the unmet-prerequisite exit.
    expect(r.exitCode).not.toBe(2);
    expect(r.stderr).not.toContain("upgrade the GitHub CLI");
  });
});

// Mode 15: mergeability is a function of (head, base), not head alone.
// `still_on_head` must recheck the base tip too, or a base that advances
// mid-evaluation — measured to be the STANDING lag pattern for `baseRefOid`,
// not a rare race — lets a stale mergeability verdict survive into a terminal
// claim.
describe("drive-status.ts base-race guard", () => {
  it("a base that moves mid-evaluation is HEAD_MOVED, not a terminal CONVERGED", async () => {
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      baseMovesTo: BASE_MOVED,
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("base");
  });

  it("a base that moves mid-evaluation also preempts a terminal PR_CONFLICTING", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [DORMANT_ARM],
      mergeable: "CONFLICTING",
      baseMovesTo: BASE_MOVED,
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });

  it('an empty baseRefOid on the recheck is INDETERMINATE, not "unchanged"', async () => {
    // An earlier still_on_head treated an empty base_now as "the base didn't
    // move" (the whole `-n "$base_now" && ...` condition is false when empty),
    // which is the SAME failure mode the head check next to it already
    // refuses: an unreadable recheck is not evidence of anything, and letting
    // it fall through to `return 0` would let CONVERGED or PR_CONFLICTING
    // stand on a base half of the (head, base) pair that was never
    // re-verified. Modelled here by moving the base to an EMPTY string on the
    // recheck read — `??` only substitutes for null/undefined, so an explicit
    // `''` survives into the served fixture unchanged.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      baseMovesTo: "",
      baseMovesAfter: 1,
    });
    expect(r.state).toBe("INDETERMINATE");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot re-read #999's base");
  });

  // There is deliberately no "base tracking is off" case left to probe: the
  // base fields are required, so the guard is unconditional. The whole class
  // of bug it used to invite — a recheck asking for a field the opening
  // snapshot had degraded past, turning an announced degradation into an
  // INDETERMINATE on every terminal return — was deleted with the tier ladder
  // rather than guarded.
});

describe("drive-status.ts terminal witness — the PR merges mid-evaluation", () => {
  // `still_on_head` re-reads before every terminal return so no terminal claim
  // outlives the evidence behind it. Reading `headRefOid` ALONE left it blind to
  // the one transition that moves no ref: a merge. The head compares equal, the
  // guard passes, and the drive is handed CONVERGED / HITL_PARKED /
  // REVIEWER_FAILED about a pull request that is no longer open — where the
  // required answer is PR_NOT_OPEN (5), the state that stops the loop without a
  // push. Every probe below returned its original terminal state before `state`
  // joined the re-read.
  //
  // `stateChangesAfter: 1` lets evaluate()'s opening liveness read answer OPEN
  // truthfully, so what is pinned here is the TERMINAL witness, not the gate at
  // the top that already worked.

  it("CONVERGED becomes PR_NOT_OPEN", async () => {
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      stateChangesTo: "MERGED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("REVIEWER_FAILED becomes PR_NOT_OPEN", async () => {
    const r = await probe({
      threads: [],
      checkRuns: [{ ...REVIEWER_RUN, conclusion: "failure" }, DORMANT_ARM],
      stateChangesTo: "CLOSED",
    });
    expect(r.state).toBe("PR_NOT_OPEN");
    expect(r.exitCode).toBe(5);
  });

  it("HITL_PARKED becomes PR_NOT_OPEN", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }],
      stateChangesTo: "MERGED",
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
    expect(JSON.parse(out).state).toBe("PR_NOT_OPEN");
    expect(exitCode).toBe(5);
  });

  it("a head that moves is still HEAD_MOVED, not PR_NOT_OPEN", async () => {
    // The other half: widening the witness must not collapse the two failures
    // it now distinguishes. A push mid-evaluation is recoverable (re-gather and
    // judge the new head); a merge is not.
    const r = await probe({
      threads: [],
      reviewedSha: HEAD,
      headMovesTo: PREV,
      headMovesAfter: 1,
    });
    expect(r.state).toBe("HEAD_MOVED");
    expect(r.exitCode).toBe(4);
  });
});

describe("drive-status.ts reports counts it never measured as null", () => {
  // `evaluate()` returns from the liveness, head-sync and reviewer gates long
  // before it enumerates threads or summary findings. Initialised to 0, those
  // gates published `work.unresolvedThreads: 0` — "not counted" rendered
  // identically to "none open". Observed while driving a PR: the reviewer gate
  // reported zero while nine threads were live.
  it("AWAITING_REVIEWER carries null work counts, not zeroes", async () => {
    const r = await probe({ threads: [], checkRuns: [DORMANT_ARM] });
    expect(r.state).toBe("AWAITING_REVIEWER");
    expect(r.json.work).toEqual({
      unresolvedThreads: null,
      parkedThreads: null,
      summaryFindings: null,
      summaryUnaddressed: null,
      parkedSummaryFindings: null,
      // The key arrays carry the same distinction as the counts beside them:
      // null is "not measured", and an EMPTY array would be the positive claim
      // "enumerated, and nothing is open" — which this gate never established.
      unresolvedThreadKeys: null,
      summaryUnaddressedKeys: null,
      parkedKeys: null,
      // The anchor PATHS the same way — `[]` here would be the
      // positive claim "no file drew a finding this round", which is exactly
      // what a same-file recurrence check must never be told on a gate that
      // returned before enumerating.
      unresolvedThreadPaths: null,
    });
  });

  it("a measured zero is still a zero", async () => {
    // The distinction is only worth anything if the real count survives it.
    const r = await probe({ threads: [], reviewedSha: HEAD });
    expect(r.state).toBe("CONVERGED");
    const work = r.json.work as Record<string, unknown>;
    expect(work.unresolvedThreads).toBe(0);
    expect(work.parkedThreads).toBe(0);
    expect(work.summaryUnaddressed).toBe(0);
    expect(work.parkedSummaryFindings).toBe(0);
    // A measured EMPTY set, which is what the counts above are counting.
    expect(work.unresolvedThreadKeys).toEqual([]);
    expect(work.summaryUnaddressedKeys).toEqual([]);
    expect(work.parkedKeys).toEqual([]);
    // Exact, not merely numeric: the fixture carries no summary findings, so
    // a regression to any other count is the false positive this asserts against.
    expect(work.summaryFindings).toBe(0);
  });

  it("publishes the key sets SORTED, which is what makes the consumer’s equality set equality", async () => {
    // `roundFingerprint` serializes what it is given, so the sort has to happen
    // HERE or the stall stop compares order rather than membership. Parked keys
    // are the one set a probe can plant in a chosen order — they come from the
    // durable state, not from a fixture the enumerators normalise — so this is
    // where the producer's `.sort()` is pinned. Deleting it from evaluate.ts
    // turns this red; an assertion in the consumer's own unit probe would not.
    const { dir, stateDir } = writeFixture({ threads: [], reviewedSha: HEAD });
    for (const key of ["zzz-parked-last", "aaa-parked-first"]) {
      const parked = Bun.spawn(
        scriptArgv(
          join(SCRIPTS, "drive-state.ts"),
          "park",
          "999",
          "--key",
          key,
          "--kind",
          "finding",
          "--reason",
          "planted out of order",
        ),
        {
          env: { ...gitCleanEnv(), DRIVE_PR_STATE_DIR: stateDir },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await expectSpawnExited(parked, 0);
    }
    const r = await probeIn(dir, stateDir);
    const work = r.json.work as Record<string, unknown>;
    expect(work.parkedKeys).toEqual(["aaa-parked-first", "zzz-parked-last"]);
  });
});

describe("roundFingerprint — what counts as evidence of sameness", () => {
  /** A gate report that WOULD fingerprint, so each probe varies one field. */
  const gate = (
    head: Record<string, unknown>,
    work: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    head: { api: "a".repeat(40), ...head },
    work: {
      unresolvedThreadKeys: ["PRRT_a"],
      summaryUnaddressedKeys: [],
      parkedKeys: [],
      summaryFindings: 0,
      ...work,
    },
  });

  it("refuses a caller-supplied --head, which asserts one instant rather than measuring", () => {
    // Forward one frozen `--head` to every gate and the local head never moves
    // however much the pass pushes — sameness the gate never witnessed. The
    // measured shape is the same report with a `git` source.
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "flag" })),
    ).toBeNull();
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "git" })),
    ).not.toBeNull();
  });

  it("accepts only a provenance known to re-measure, so an unknown source fails CLOSED", () => {
    for (const source of ["disabled", "unavailable", "something-new", ""]) {
      expect(roundFingerprint(gate({ local: "", localSource: source }))).toBe(
        null,
      );
    }
    // And with a real SHA attached, which is the case a denylist got wrong: a
    // future `cache` source carrying a frozen SHA would read as a continuing
    // measurement and stop a productive drive at 13. Refusing it only loses the
    // early stop and falls back to --max-rounds, so this is the safe direction.
    for (const source of ["flag", "cache", "future", ""]) {
      expect(
        roundFingerprint(gate({ local: "b".repeat(40), localSource: source })),
      ).toBeNull();
    }
    expect(
      roundFingerprint(gate({ local: "b".repeat(40), localSource: "git" })),
    ).not.toBeNull();
  });

  it("refuses counts without identities, rather than falling back to the weaker evidence", () => {
    const measured = { local: "b".repeat(40), localSource: "git" };
    expect(
      roundFingerprint(
        gate(measured, {
          unresolvedThreadKeys: undefined,
          unresolvedThreads: 1,
        }),
      ),
    ).toBeNull();
    expect(
      roundFingerprint(
        gate(measured, {
          summaryUnaddressedKeys: undefined,
          summaryUnaddressed: 0,
        }),
      ),
    ).toBeNull();
  });

  it("distinguishes a SUBSTITUTION from a no-op at equal cardinality", () => {
    const measured = { local: "b".repeat(40), localSource: "git" };
    const before = roundFingerprint(gate(measured));
    const after = roundFingerprint(
      gate(measured, { unresolvedThreadKeys: ["PRRT_b"] }),
    );
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
    // The fingerprint serializes what it is GIVEN — order-sensitive, by
    // design — so set equality rests entirely on the PRODUCER sorting. That is
    // asserted where it is produced (drive-status.ts, the probe below);
    // asserting it here against arrays this test sorted itself would stay green
    // with `.sort()` deleted from evaluate.ts (exactly that vacuous shape).
    expect(
      roundFingerprint(gate(measured, { parkedKeys: ["b", "a"] })),
    ).not.toBe(roundFingerprint(gate(measured, { parkedKeys: ["a", "b"] })));
  });
});

describe("claimWasTakenOver — coexistence, a full successor-only transition, AND a vanished claim set", () => {
  // The real race this decides is a microsecond window between a
  // `renameSync` and the `inspect()` call that follows it — nothing in a
  // single-process test can land inside it (see drive.ts's own comment on
  // this function). Testing the DECISION directly, rather than racing the
  // real filesystem, is what makes this actually mutation-provable: an
  // earlier revision of this fix (`afterRewrite.claimNames.length > 1` alone)
  // passed every existing subprocess-based test because none of them ever
  // reached the sole-foreign-claim shape at all.
  it("is false when the sole claim is ours", () => {
    expect(claimWasTakenOver(["claim.ours"], "claim.ours")).toBe(false);
  });

  it("is true when nothing is there at all — a contender can remove our claim before installing its own successor, and that gap must read as loss too", () => {
    expect(claimWasTakenOver([], "claim.ours")).toBe(true);
  });

  it("is true for coexistence — our claim plus a resurrected/foreign one", () => {
    expect(claimWasTakenOver(["claim.ours", "claim.ghost"], "claim.ours")).toBe(
      true,
    );
  });

  it("is true for a full successor-only transition — exactly one claim, and it is not ours", () => {
    expect(claimWasTakenOver(["claim.successor01"], "claim.ours")).toBe(true);
  });

  it("is order-independent for coexistence", () => {
    expect(claimWasTakenOver(["claim.ghost", "claim.ours"], "claim.ours")).toBe(
      true,
    );
  });
});
