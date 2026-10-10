/**
 * doctor.test.ts — `lib/doctor.ts`'s pure classifier.
 *
 * WHAT THIS SUITE IS FOR. `classifyDrive` exists because `drives.ts` alone
 * cannot answer "is this drive actually stuck" — a claim heartbeat proves the
 * PROCESS is alive, never that the drive is making PROGRESS. The acceptance
 * bar this file exists to satisfy: a WEDGED drive and a HEALTHY long round
 * must go through the SAME function and come out different, asserted side by
 * side in one test (below), and every precedence guard must be provably
 * load-bearing — verified by actually reverting each one in `doctor.ts` and
 * confirming the corresponding test here reddens (recorded in the PR
 * description / final report per an earlier change's own instructions, not restated
 * here as a comment nothing checks).
 *
 * FIXTURES, NOT REAL PROCESSES OR A REAL FILESYSTEM. `classifyDrive` takes a
 * plain `DoctorInput` record and a `now`, and does no I/O of its own — that is
 * the whole design (`lib/doctor.ts`'s own header). Every case here builds one
 * by hand from `baseInput`, so a case is exactly the combination of fields
 * it says it is, nothing inferred from a spawned process or a temp directory.
 */

import { describe, expect, it } from "bun:test";
import {
  classifyDrive,
  type DoctorInput,
  formatStopCommand,
  STALL_THRESHOLD_MIN_DEFAULT,
  stallThresholdMs,
} from "../scripts/lib/doctor.ts";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const THRESHOLD_MS = STALL_THRESHOLD_MIN_DEFAULT * 60_000;

/**
 * A drive that has established NOTHING alarming: live lock, progress stamped
 * a minute ago, a confirmed live pass, no park, nothing parked, a clean
 * worktree. Every test below starts here and overrides exactly the fields
 * its own scenario is about — so a test failure names the field that
 * mattered, not a pile of unrelated ones.
 */
function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    lockState: "live",
    progressAgeMs: 60_000,
    stateReadable: true,
    passChild: true,
    quotaPark: null,
    parkedCount: 0,
    leftovers: { uncommitted: false, unpushed: false, unconcludedOp: null },
    stallThresholdMs: THRESHOLD_MS,
    pr: "4242",
    worktreePath: "/tmp/some-worktree",
    selfPath: "/abs/path/to/drives.ts",
    hostIsLocal: true,
    ...overrides,
  };
}

describe("classifyDrive — the core acceptance case", () => {
  it("a WEDGED drive and a HEALTHY long round go through the SAME classifier and come out different", () => {
    // Wedged: live lock, progress stamped long before the threshold, and NO
    // pass process running under the driver — the positive absence WEDGED
    // requires, not merely "we don't know".
    const wedged = baseInput({
      progressAgeMs: THRESHOLD_MS + 60_000,
      passChild: false,
    });
    // Healthy: SAME stale progress age, but a pass IS currently running — a
    // legitimately long round (merge a base, run the full validation plan,
    // wait on the machine-wide test mutex) can go this long between stamps
    // without anything being wrong.
    const healthyLongRound = baseInput({
      progressAgeMs: THRESHOLD_MS + 60_000,
      passChild: true,
    });

    const wedgedRow = classifyDrive(wedged, NOW);
    const healthyRow = classifyDrive(healthyLongRound, NOW);

    expect(wedgedRow.verdict).toBe("WEDGED");
    expect(healthyRow.verdict).toBe("HEALTHY");
    expect(wedgedRow.verdict).not.toBe(healthyRow.verdict);
    // WEDGED carries an actionable recovery command; HEALTHY carries none.
    expect(wedgedRow.recovery).toBe(
      formatStopCommand("/abs/path/to/drives.ts", "4242"),
    );
    expect(healthyRow.recovery).toBeNull();
  });

  it("HEALTHY: recent progress alone is sufficient even with an unprobeable pass child", () => {
    const row = classifyDrive(
      baseInput({ progressAgeMs: 1_000, passChild: null }),
      NOW,
    );
    expect(row.verdict).toBe("HEALTHY");
  });
});

describe("classifyDrive — fail-closed guards (rule 1 and friends)", () => {
  // Every case below asserts BOTH `verdict` and a fragment of `reason` — the
  // verdict alone is not enough to prove the INTENDED guard fired, because
  // `UNKNOWN` is also this function's trailing DEFAULT (rule 7). A guard
  // that is deleted outright still lands on `UNKNOWN` via that fallthrough,
  // with a DIFFERENT, generic reason string ("insufficient evidence...") —
  // verdict-only assertions passed vacuously against that mutation in this
  // file's own history and were strengthened here specifically because of
  // it (mutation-tested: reverting rule 1's lock-state guard to `if (false)`
  // left `verdict` alone unchanged but reddened the `reason` assertion).

  it("an unreadable lock is UNKNOWN, never HEALTHY, via the lock-state guard specifically", () => {
    const row = classifyDrive(baseInput({ lockState: "unreadable" }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("lock is unreadable");
  });

  it("a contested lock is UNKNOWN via the same lock-state guard", () => {
    const row = classifyDrive(baseInput({ lockState: "contested" }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("lock is contested");
  });

  it("an unreadable state file is UNKNOWN, even on a live lock, via the stateReadable guard specifically", () => {
    const row = classifyDrive(baseInput({ stateReadable: false }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("state file could not be read");
  });

  it("an unreadable state file does NOT preempt DEAD_WITH_LEFTOVERS when the leftovers probe independently confirms stranded work (review finding)", () => {
    // `gatherDoctorInput` runs the leftovers probe off the WORKTREE, not the
    // state file, so it answers this question regardless of whether the
    // state snapshot parsed — an old/malformed state file (reachable right
    // after a rollout that rejects every pre-existing shape, like this PR's
    // own) must not discard evidence already established independently.
    const row = classifyDrive(
      baseInput({
        stateReadable: false,
        lockState: "stale",
        leftovers: { uncommitted: true, unpushed: false, unconcludedOp: null },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD_WITH_LEFTOVERS");
  });

  it("an unreadable state file with no live driver and a CLEAN or uninspectable worktree is still UNKNOWN via the stateReadable guard", () => {
    // Pins the narrow scope of the carve-out above: only a POSITIVE,
    // independently-confirmed leftovers finding may fall through it. Neither
    // a clean worktree nor an uninspectable one may.
    const clean = classifyDrive(
      baseInput({
        stateReadable: false,
        lockState: "stale",
        leftovers: { uncommitted: false, unpushed: false, unconcludedOp: null },
      }),
      NOW,
    );
    expect(clean.verdict).toBe("UNKNOWN");
    expect(clean.reason).toContain("state file could not be read");

    const uninspectable = classifyDrive(
      baseInput({ stateReadable: false, lockState: "stale", leftovers: null }),
      NOW,
    );
    expect(uninspectable.verdict).toBe("UNKNOWN");
    expect(uninspectable.reason).toContain("state file could not be read");
  });

  it("an unprobeable pass child (null) with stale progress is UNKNOWN, never WEDGED", () => {
    const row = classifyDrive(
      baseInput({ progressAgeMs: THRESHOLD_MS + 1, passChild: null }),
      NOW,
    );
    expect(row.verdict).toBe("UNKNOWN");
    // Distinguishes this from the "never stamped" UNKNOWN below: progress
    // WAS stamped (and IS stale) here, so the generic fallback reason,
    // rather than the never-stamped one, is what must be showing.
    expect(row.reason).not.toContain("never recorded a progress stamp");
  });

  it("an uninspectable worktree (leftovers null) with no live driver is UNKNOWN via that guard specifically", () => {
    const row = classifyDrive(
      baseInput({ lockState: "stale", leftovers: null }),
      NOW,
    );
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("could not be inspected for leftovers");
  });

  it("progressAgeMs === null on a live lock (never stamped) is UNKNOWN via the trailing default, named as such", () => {
    const row = classifyDrive(
      baseInput({ progressAgeMs: null, passChild: true }),
      NOW,
    );
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toContain("never recorded a progress stamp");
  });

  it("no live driver + a clean worktree is UNKNOWN — never manufactures a false HEALTHY", () => {
    // Nothing here is alarming, but nothing positively establishes health
    // either: `classifyDrive`'s own header states HEALTHY is reached from
    // exactly one branch, never a default. Distinguished from the
    // never-stamped case above by NOT carrying that reason (lockState here
    // is 'empty', not 'live', so it falls to the OTHER half of the trailing
    // default's ternary).
    const row = classifyDrive(baseInput({ lockState: "empty" }), NOW);
    expect(row.verdict).toBe("UNKNOWN");
    expect(row.reason).toBe("insufficient evidence to classify this drive");
  });
});

describe("classifyDrive — precedence order", () => {
  it("DEAD_WITH_LEFTOVERS outranks QUOTA_PARKED: a park recorded, but the driver died with stranded work", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "stale",
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T13:00:00.000Z",
          at: "2026-09-12T11:00:00.000Z",
        },
        leftovers: { uncommitted: true, unpushed: false, unconcludedOp: null },
      }),
      NOW,
    ).verdict;
    expect(row).toBe("DEAD_WITH_LEFTOVERS");
  });

  it("QUOTA_PARKED outranks NEEDS_HUMAN", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "stale",
        quotaPark: {
          vendor: "codex",
          window: "weekly",
          resetAt: null,
          at: "2026-09-12T11:00:00.000Z",
        },
        parkedCount: 2,
      }),
      NOW,
    );
    expect(row.verdict).toBe("QUOTA_PARKED");
    expect(row.reason).toContain("codex");
    expect(row.reason).toContain("unresolved");
  });

  it("QUOTA_PARKED outranks WEDGED: a driver SLEEPING out a short quota window is not stuck", () => {
    // The single most likely false alarm this classifier could produce, and
    // the reason `drive.ts` records the park on its SLEEP path and not only
    // on the exiting one. A short-window sleep holds the locks and keeps
    // refreshing them for up to `maxSleepMs()` — six hours by default — with
    // no pass running and nothing to stamp, so every one of WEDGED's own
    // conditions is met: live lock, progress far past the threshold, and a
    // CONFIRMED absence of a pass child. Only the recorded park separates it
    // from a genuine wedge, which is exactly why it must outrank one.
    const sleeping = baseInput({
      lockState: "live",
      progressAgeMs: THRESHOLD_MS + 60_000,
      passChild: false,
      quotaPark: {
        vendor: "claude",
        window: "short",
        resetAt: "2026-09-12T15:00:00.000Z",
        at: "2026-09-12T11:00:00.000Z",
      },
    });
    expect(classifyDrive(sleeping, NOW).verdict).toBe("QUOTA_PARKED");
    // The SAME input with no park recorded is the genuine wedge — proving
    // the park is the sole decider here, not some other field of the fixture
    // (document-scanning-gates § 5: the clause under test must be what
    // decides).
    expect(classifyDrive({ ...sleeping, quotaPark: null }, NOW).verdict).toBe(
      "WEDGED",
    );
  });

  it("QUOTA_PARKED fires even while the lock still reads live (park just recorded, claim not yet stale)", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "live",
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T13:00:00.000Z",
          at: "2026-09-12T11:55:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("QUOTA_PARKED");
  });

  it("NEEDS_HUMAN fires with a live driver too — a parked item does not resolve itself", () => {
    const row = classifyDrive(baseInput({ parkedCount: 1 }), NOW);
    expect(row.verdict).toBe("NEEDS_HUMAN");
    expect(row.reason).toContain("1 item");
  });

  it("DEAD_WITH_LEFTOVERS reports the git recovery command", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "empty",
        leftovers: { uncommitted: false, unpushed: true, unconcludedOp: null },
        worktreePath: "/tmp/some worktree",
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD_WITH_LEFTOVERS");
    expect(row.recovery).toContain("git -C");
    expect(row.recovery).toContain("status --short");
  });

  it("DEAD_WITH_LEFTOVERS with an unconcluded op is named in the reason", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "stale",
        leftovers: {
          uncommitted: false,
          unpushed: false,
          unconcludedOp: "MERGE_HEAD",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("DEAD_WITH_LEFTOVERS");
    expect(row.reason).toContain("MERGE_HEAD");
  });

  it("an uninspectable worktree with NO worktree path at all is worded as a skip, not a failed inspection", () => {
    // an earlier change minor finding: `leftovers === null` is
    // ambiguous between "the probe ran and failed" and "there was never a
    // worktree to probe" — `worktreePath === null` distinguishes them, and
    // the wording must not claim an inspection was attempted when none was.
    const skipped = classifyDrive(
      baseInput({ lockState: "empty", leftovers: null, worktreePath: null }),
      NOW,
    );
    expect(skipped.verdict).toBe("UNKNOWN");
    expect(skipped.reason).toContain("records no worktree to inspect");
    expect(skipped.reason).not.toContain("could not be inspected");

    const failed = classifyDrive(
      baseInput({
        lockState: "empty",
        leftovers: null,
        worktreePath: "/tmp/some-worktree",
      }),
      NOW,
    );
    expect(failed.verdict).toBe("UNKNOWN");
    expect(failed.reason).toContain("could not be inspected");
  });

  it("an uninspectable worktree does NOT preempt a KNOWN quota park — QUOTA_PARKED still wins (found while adding the C1 state-only-row test)", () => {
    // A state-only row (no lock at all — an earlier change C1) always has
    // `worktreePath: null`, so `leftovers` is always `null` too. Branch 2's
    // "could not inspect" answer must be a WEAKER fact than a park this
    // classifier already knows for certain from the state file, not one
    // that pre-empts it — an earlier revision of `classifyDrive` returned
    // UNKNOWN immediately here, before `quotaPark` was ever checked.
    const row = classifyDrive(
      baseInput({
        lockState: "empty",
        leftovers: null,
        worktreePath: null,
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: null,
          at: "2026-09-12T11:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("QUOTA_PARKED");
  });

  it("an uninspectable worktree does NOT preempt a KNOWN parked item either", () => {
    const row = classifyDrive(
      baseInput({
        lockState: "empty",
        leftovers: null,
        worktreePath: null,
        parkedCount: 1,
      }),
      NOW,
    );
    expect(row.verdict).toBe("NEEDS_HUMAN");
  });

  it("WEDGED outranks NEEDS_HUMAN: an old park does not hide a fresh wedge", () => {
    // A drive that parked one thread early and has since wedged must not
    // report the stale park forever — the wedge is the more urgent, more
    // perishable fact.
    const row = classifyDrive(
      baseInput({
        progressAgeMs: THRESHOLD_MS + 60_000,
        passChild: false,
        parkedCount: 1,
      }),
      NOW,
    );
    expect(row.verdict).toBe("WEDGED");
  });

  it("a foreign host never even reaches WEDGED in real usage (drives.ts forces passChild to null there)", () => {
    // `hostIsLocal: false` is how `drives.ts` reports a foreign-host lock —
    // it never even attempts `findPassChild` there (see `gatherDoctorInput`),
    // so `passChild` is `null` in practice, which alone already keeps this
    // out of WEDGED (rule 4 requires `passChild === false` specifically).
    const row = classifyDrive(
      baseInput({
        progressAgeMs: THRESHOLD_MS + 60_000,
        passChild: null,
        hostIsLocal: false,
      }),
      NOW,
    );
    expect(row.verdict).not.toBe("WEDGED");
  });

  it("WEDGED on a foreign host STILL carries no --stop recovery, even if passChild were somehow false", () => {
    // `classifyDrive` is tested directly here with a combination `drives.ts`
    // itself is never supposed to construct (a foreign host with a
    // positively-confirmed `passChild: false`) — the whole point of a
    // defense-in-depth check is that it holds even for an input its one
    // real caller would not produce. Without `hostIsLocal` gating `recovery`
    // independently of `passChild`, this reaches WEDGED and hands the
    // operator a `--stop` command `stop()` itself refuses on sight.
    const row = classifyDrive(
      baseInput({
        progressAgeMs: THRESHOLD_MS + 60_000,
        passChild: false,
        hostIsLocal: false,
      }),
      NOW,
    );
    expect(row.verdict).toBe("WEDGED");
    expect(row.recovery).toBeNull();
  });

  it('HEALTHY names both facts honestly — a live pass with hours-stale progress is not "recent activity" (an earlier change M3(a))', () => {
    const row = classifyDrive(
      baseInput({
        progressAgeMs: 9 * 60 * 60_000, // 9 hours
        passChild: true,
      }),
      NOW,
    );
    expect(row.verdict).toBe("HEALTHY");
    expect(row.reason).toContain("pass is currently running");
    expect(row.reason).toContain("540 minute");
    expect(row.reason).not.toContain("recent activity");
  });

  it("HEALTHY via fresh progress alone names the absence of a pass honestly", () => {
    const row = classifyDrive(
      baseInput({ progressAgeMs: 60_000, passChild: false }),
      NOW,
    );
    expect(row.verdict).toBe("HEALTHY");
    expect(row.reason).toContain("no pass is currently running");
    expect(row.reason).toContain("1 minute");
  });

  it("describeQuotaPark's 'already past' branch — a resetAt in the past reads as not-yet-re-armed, not merely 'resets <date>'", () => {
    // an earlier change minor finding: this branch is the entire
    // justification for `classifyDrive` taking a `now` parameter, and was
    // untested — every other quota-park fixture used a future or null
    // `resetAt`.
    const row = classifyDrive(
      baseInput({
        lockState: "stale",
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T10:00:00.000Z", // 2h before NOW
          at: "2026-09-12T05:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("QUOTA_PARKED");
    expect(row.reason).toContain("already past, not yet re-armed");
  });

  it("WEDGED outranks an EXPIRED quota park: the window reopened and nothing resumed (review finding)", () => {
    // The "self-resolving" premise behind branch 3's precedence has failed
    // here: `resetAt` is 2h in the past, yet the lock is still live, progress
    // is stale past the threshold, and no pass child is running — exactly
    // the facts branch 4 checks, all independently true. A classifier that
    // reported QUOTA_PARKED forever in this shape would never surface the
    // wedge, since no future progress event is coming from a drive that is
    // actually stuck (as opposed to the sleeping-but-healthy drive in the
    // adjacent 'SLEEPING out a short quota window' test, whose `resetAt` is
    // still in the FUTURE — that is the one fact that tells the two apart).
    const row = classifyDrive(
      baseInput({
        lockState: "live",
        progressAgeMs: THRESHOLD_MS + 60_000,
        passChild: false,
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T10:00:00.000Z", // 2h before NOW
          at: "2026-09-12T05:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("WEDGED");
  });

  it("an EXPIRED quota park stays QUOTA_PARKED when any one WEDGED fact is missing", () => {
    // Same expired `resetAt` as the test above, but `passChild` is `true` —
    // a pass IS running, so this is not actually stuck. The expiry alone
    // must never flip the verdict; it only matters in combination with every
    // other WEDGED fact.
    const row = classifyDrive(
      baseInput({
        lockState: "live",
        progressAgeMs: THRESHOLD_MS + 60_000,
        passChild: true,
        quotaPark: {
          vendor: "claude",
          window: "short",
          resetAt: "2026-09-12T10:00:00.000Z", // 2h before NOW
          at: "2026-09-12T05:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(row.verdict).toBe("QUOTA_PARKED");
  });
});

describe("stallThresholdMs", () => {
  const KEY = "DRIVE_PR_STALL_MIN";
  // Each test restores the env itself in a `finally` (below), rather than a
  // shared `afterEach`, so a failing assertion still leaves the override
  // cleaned up for whichever test runs next.
  const saved = process.env[KEY];

  it("defaults to STALL_THRESHOLD_MIN_DEFAULT minutes", () => {
    delete process.env[KEY];
    try {
      expect(stallThresholdMs()).toBe(STALL_THRESHOLD_MIN_DEFAULT * 60_000);
    } finally {
      if (saved !== undefined) process.env[KEY] = saved;
    }
  });

  it("clamps below the default floor up to the default itself", () => {
    process.env[KEY] = "5";
    try {
      expect(stallThresholdMs()).toBe(STALL_THRESHOLD_MIN_DEFAULT * 60_000);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("honors an in-range override", () => {
    // 500, not 240: `STALL_THRESHOLD_MIN_DEFAULT` IS 240, so that value
    // passes whether or not the override is actually honored (review
    // finding) — a non-default value is the only one that can distinguish
    // "read the override" from "ignored it and returned the default".
    process.env[KEY] = "500";
    try {
      expect(stallThresholdMs()).toBe(500 * 60_000);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("clamps an absurd override to the one-week ceiling", () => {
    process.env[KEY] = "999999";
    try {
      expect(stallThresholdMs()).toBe(10_080 * 60_000);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it("an unparsable override falls back to the default", () => {
    process.env[KEY] = "not-a-number";
    try {
      expect(stallThresholdMs()).toBe(STALL_THRESHOLD_MIN_DEFAULT * 60_000);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });
});
