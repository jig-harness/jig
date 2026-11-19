import { describe, expect, test } from "bun:test";
import {
  recoverCancelled,
  REPLACEMENT_WINDOW_MS,
  type RecoveryDeps,
  type RecoveryRecord,
} from "../scripts/lib/cancelled-recovery.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";
import { isoFromMs, parseMs } from "../../../shared/time.ts";

const run = (id: number, workflowId = 10): WorkflowRun => ({
  id,
  workflowId,
  checkSuiteId: id,
  status: "completed",
  conclusion: "cancelled",
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:00Z",
  attempt: 1,
});
function fixture(start = 0) {
  let clock = start;
  let record: RecoveryRecord | null = null;
  const calls: number[] = [];
  const parks: string[] = [];
  const deps: RecoveryDeps = {
    now: () => clock,
    observe: async () => (record ??= { firstSeen: clock, requestedAt: null }),
    claim: async (_pr, _head, workflowIds, requestedRuns) => {
      if (record?.requestedAt !== null) return false;
      record = {
        ...record,
        firstSeen: record?.firstSeen ?? clock,
        requestedAt: clock,
        workflowIds,
        requestedRuns,
      };
      return true;
    },
    extend: async (_pr, _head, earlier, requestedRuns) => {
      if (record === null || record.requestedRuns !== earlier) return false;
      record = { ...record, requestedRuns };
      return true;
    },
    confirm: async () => true,
    rerunnable: async (_pr, runs) => runs.map((r) => r.id),
    rerun: async (id) => {
      calls.push(id);
      return { code: 0, stderr: "" };
    },
    withdrawClaim: async (_pr, _head, claimed, kept, release) => {
      if (record === null || record.requestedRuns !== claimed) return;
      record = {
        ...record,
        requestedRuns: kept,
        ...(release ? { requestedAt: null } : {}),
      };
    },
    withdrawLabelRerun: async () => undefined,
    park: async (_pr, reason) => {
      parks.push(reason);
    },
    releaseGrant: async () => {
      if (record?.grantPending !== true) return false;
      record = { ...record, requestedAt: null, grantPending: false };
      return true;
    },
  };
  return {
    deps,
    calls,
    parks,
    advance: (ms: number) => {
      clock += ms;
    },
    /** A person's answer: the spent claim released and one more re-run counted. */
    grant: (pending = false) => {
      if (record === null) throw new Error("no record to grant");
      record = pending
        ? { ...record, grants: (record.grants ?? 0) + 1, grantPending: true }
        : { ...record, requestedAt: null, grants: (record.grants ?? 0) + 1 };
    },
    record: () => record,
  };
}
const job = {
  name: "gate",
  status: "completed",
  conclusion: "cancelled",
  suiteId: 1,
};

describe("a head read that fails after the re-run is claimed", () => {
  /** Past the grace period, with the head's confirmations answered in turn, then `true`. */
  async function pastGrace(runs: WorkflowRun[], jobs = [job]) {
    const f = fixture();
    await recoverCancelled("5", "head", jobs, runs, f.deps);
    f.advance(30_000);
    return f;
  }
  function confirmsInTurn(
    f: ReturnType<typeof fixture>,
    answers: (boolean | "unread")[],
  ) {
    let at = 0;
    f.deps.confirm = async () => answers[at++] ?? true;
  }

  test("gives the claim back, so a re-armed drive requests the re-run", async () => {
    const f = await pastGrace([run(1)]);
    // Before the claim the head confirms; the request's own check cannot read.
    confirmsInTurn(f, [true, "unread"]);
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "unknown",
    );
    expect(f.calls).toEqual([]);
    expect(f.parks).toEqual([]);
    expect(f.record()?.requestedAt).toBeNull();
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1]);
  });

  test("the last check before the re-run neither parks nor spends the claim", async () => {
    const f = await pastGrace([run(1)]);
    f.deps.rerun = async () => ({ code: 1, stderr: "HTTP 502", unread: true });
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "unknown",
    );
    expect(f.parks).toEqual([]);
    expect(f.record()?.requestedAt).toBeNull();
  });

  test("keeps the claim for a run already requested, naming only that run", async () => {
    const other = { ...job, name: "other", suiteId: 2 };
    const runs = [run(1), run(2, 11)];
    const f = await pastGrace(runs, [job, other]);
    // Before the claim, before the first request, then before the second.
    confirmsInTurn(f, [true, true, "unread"]);
    expect(
      await recoverCancelled("5", "head", [job, other], runs, f.deps),
    ).toBe("unknown");
    expect(f.calls).toEqual([1]);
    expect(f.record()?.requestedAt).not.toBeNull();
    expect(f.record()?.requestedRuns?.map((r) => r.id)).toEqual([1]);
  });

  test("a run left unrequested is requested while the retained request is still pending", async () => {
    const other = { ...job, name: "other", suiteId: 2 };
    const settled = (r: WorkflowRun): WorkflowRun => ({
      ...r,
      updatedAt: "2026-01-01T00:00:30Z",
    });
    const [first, second] = [settled(run(1)), settled(run(2, 11))];
    const runs = [first, second];
    const f = fixture(parseMs("2026-01-01T00:10:00Z"));
    await recoverCancelled("5", "head", [job, other], runs, f.deps);
    f.advance(30_000);
    confirmsInTurn(f, [true, true, "unread"]);
    await recoverCancelled("5", "head", [job, other], runs, f.deps);
    expect(f.calls).toEqual([1]);
    // The first run's re-run is still pending: its attempt has not finished.
    const pending: WorkflowRun[] = [
      { ...first, attempt: 2, status: "in_progress", conclusion: null },
      second,
    ];
    expect(
      await recoverCancelled("5", "head", [job, other], pending, f.deps),
    ).toBe("wait");
    expect(f.calls).toEqual([1, 2]);
    expect(f.parks).toEqual([]);
  });

  test("a released claim still names the runs it named before", async () => {
    const f = await pastGrace([run(1)]);
    await recoverCancelled("5", "head", [job], [run(1)], f.deps);
    const before = f.record()?.requestedRuns;
    expect(before?.map((r) => r.id)).toEqual([1]);
    f.grant();
    f.advance(REPLACEMENT_WINDOW_MS);
    confirmsInTurn(f, [true, "unread"]);
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "unknown",
    );
    expect(f.calls).toEqual([1]);
    expect(f.record()?.requestedAt).toBeNull();
    expect(f.record()?.requestedRuns).toEqual(before);
  });
});

describe("orphaned cancelled workflow recovery", () => {
  test("requests only the newest orphaned run per workflow", async () => {
    const f = fixture();
    const jobs = [job, { ...job, name: "matrix-template", suiteId: 2 }];
    await recoverCancelled("5", "head", jobs, [run(1), run(2)], f.deps);
    f.advance(30_000);
    await recoverCancelled("5", "head", jobs, [run(1), run(2)], f.deps);
    expect(f.calls).toEqual([2]);
  });
  test("waits a grace period, requests once, then parks across another invocation", async () => {
    const f = fixture();
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([]);
    f.advance(30_000);
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1]);
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "parked",
    );
    expect(f.calls).toEqual([1]);
    expect(f.parks[0]).toContain("gh run rerun 1");
  });
  test("an active replacement waits, but an unrelated active workflow does not", async () => {
    const f = fixture();
    const active = { ...run(2), status: "queued", conclusion: null };
    expect(
      await recoverCancelled("5", "head", [job], [run(1), active], f.deps),
    ).toBe("wait");
    const unrelated = { ...active, workflowId: 11 };
    await recoverCancelled("5", "head", [job], [run(1), unrelated], f.deps);
    f.advance(30_000);
    await recoverCancelled("5", "head", [job], [run(1), unrelated], f.deps);
    expect(f.calls).toEqual([1]);
  });
  test("a skipped successor does not replace a cancellation", async () => {
    const f = fixture();
    const skipped = { ...run(2), conclusion: "skipped" };
    await recoverCancelled("5", "head", [job], [run(1), skipped], f.deps);
    f.advance(30_000);
    await recoverCancelled("5", "head", [job], [run(1), skipped], f.deps);
    expect(f.calls).toEqual([1]);
  });
  test("unreadable provenance, moved heads and a lost claim cannot rerun", async () => {
    const f = fixture();
    expect(await recoverCancelled("5", "head", [job], null, f.deps)).toBe(
      "unknown",
    );
    await recoverCancelled("5", "head", [job], [run(1)], f.deps);
    f.advance(30_000);
    f.deps.confirm = async () => false;
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "unknown",
    );
    f.deps.confirm = async () => true;
    f.deps.claim = async () => false;
    expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([]);
  });
  test("a held event or rerun refusal parks with the run named", async () => {
    for (const held of [true, false]) {
      const f = fixture();
      f.deps.rerunnable = async () => (held ? [] : [1]);
      f.deps.rerun = async () => ({ code: 1, stderr: "HTTP 403" });
      await recoverCancelled("5", "head", [job], [run(1)], f.deps);
      f.advance(30_000);
      expect(await recoverCancelled("5", "head", [job], [run(1)], f.deps)).toBe(
        "parked",
      );
      expect(f.parks[0]).toContain("run 1");
    }
  });
});

describe("a successor that skipped the cancelled run's jobs", () => {
  const later = (
    id: number,
    jobs: Array<[string, string]>,
  ): { run: WorkflowRun; jobs: (typeof job)[] } => ({
    run: { ...run(id), conclusion: "success" },
    jobs: jobs.map(([name, conclusion]) => ({
      name,
      status: "completed",
      conclusion,
      suiteId: id,
    })),
  });
  const selected = async (successor: ReturnType<typeof later>) => {
    const f = fixture();
    const jobs = [job, ...successor.jobs];
    const runs = [run(1), successor.run];
    await recoverCancelled("5", "head", jobs, runs, f.deps);
    f.advance(30_000);
    await recoverCancelled("5", "head", jobs, runs, f.deps);
    return f.calls;
  };
  test("does not replace it when it skipped all of them", async () => {
    expect(await selected(later(2, [["gate", "skipped"]]))).toEqual([1]);
  });
  test("does not replace it when it skipped only some of them", async () => {
    expect(
      await selected(
        later(2, [
          ["gate", "skipped"],
          ["lint", "success"],
        ]),
      ),
    ).toEqual([1]);
  });
  test("does not replace it when it skipped the job under its matrix names", async () => {
    expect(
      await selected(
        later(2, [
          ["gate (linux)", "skipped"],
          ["gate (macos)", "skipped"],
          ["lint", "success"],
        ]),
      ),
    ).toEqual([1]);
    expect(
      await selected(
        later(2, [
          ["gate (linux)", "success"],
          ["gate (macos)", "skipped"],
        ]),
      ),
    ).toEqual([1]);
  });
  test("still replaces it when it ran the job to a result", async () => {
    expect(await selected(later(2, [["gate", "success"]]))).toEqual([]);
    expect(
      await selected(
        later(2, [
          ["gate (linux)", "success"],
          ["gate (macos)", "failure"],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("a requested re-run is judged by the runs it re-ran", () => {
  const T0 = parseMs("2026-01-01T00:00:00Z");
  const at = (ms: number) => isoFromMs(T0 + ms);
  /** A run of `workflowId` started `start` ms after T0, as attempt `attempt`. */
  const wf = (
    id: number,
    workflowId: number,
    start: number,
    status = "completed",
    conclusion: string | null = "cancelled",
    attempt = 1,
  ): WorkflowRun => ({
    id,
    workflowId,
    checkSuiteId: id,
    status,
    conclusion,
    createdAt: at(0),
    startedAt: at(start),
    updatedAt: at(start + 1_000),
    attempt,
  });
  const check = (suiteId: number, start: number, conclusion = "cancelled") => ({
    id: suiteId * 100 + Math.floor(start / 1000),
    name: `gate-${suiteId}`,
    status: "completed",
    conclusion,
    suiteId,
    startedAt: at(start),
  });
  // A and B are the cancelled runs the grant re-runs.
  const A = (
    start = 0,
    status = "completed",
    conclusion: string | null = "cancelled",
    attempt = 1,
  ) => wf(1, 10, start, status, conclusion, attempt);
  const B = (
    start = 0,
    status = "completed",
    conclusion: string | null = "cancelled",
    attempt = 1,
  ) => wf(2, 11, start, status, conclusion, attempt);
  const firstChecks = [check(1, 0), check(2, 0)];
  /** When the person's answer was granted, and when the drive then requested the re-run. */
  const granted = 30_000 + REPLACEMENT_WINDOW_MS;
  const requested = granted + 5_000;
  // C and D: runs of the same workflows that the re-arm's label event started
  // after the grant, and the workflows' concurrency group cancelled.
  const labelRuns = [wf(3, 10, granted + 2_000), wf(4, 11, granted + 2_000)];
  const labelChecks = [check(3, granted + 2_000), check(4, granted + 2_000)];

  /** The automatic re-run spent and parked, then a person's answer granted and its re-run requested. */
  async function grantedRequest() {
    const f = fixture(T0);
    const runs = [A(), B()];
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "wait",
    );
    f.advance(30_000);
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "wait",
    );
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "parked",
    );
    f.grant();
    f.advance(requested - granted);
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1, 2, 1, 2]);
    expect(f.record()?.requestedRuns?.map((r) => r.id)).toEqual([1, 2]);
    f.parks.length = 0;
    return f;
  }
  const succeeded = (start: number) => ({
    runs: [
      A(start, "completed", "success", 2),
      B(start, "completed", "success", 2),
    ],
    checks: [
      ...firstChecks,
      check(1, start, "success"),
      check(2, start, "success"),
    ],
  });

  test("label-started cancellations wait while the re-run's attempts are queued or running", async () => {
    const f = await grantedRequest();
    const start = requested + 60_000;
    const runs = [
      A(start, "queued", null, 2),
      B(start, "in_progress", null, 2),
      ...labelRuns,
    ];
    f.advance(2 * REPLACEMENT_WINDOW_MS);
    expect(
      await recoverCancelled(
        "5",
        "head",
        [...firstChecks, ...labelChecks],
        runs,
        f.deps,
      ),
    ).toBe("wait");
    expect(f.parks).toEqual([]);
    expect(f.calls).toEqual([1, 2, 1, 2]);
  });

  test("the re-run's results clear the park; its runs, not the label-started ones, are named when they never ran", async () => {
    const f = await grantedRequest();
    // The status layer still holds C's and D's cancellation, which predates
    // the attempts; A's and B's results answer it.
    // The successful attempts skip C's and D's jobs while another job gives
    // each workflow its result, so the cancellations survive normalization.
    const done = succeeded(requested + 60_000);
    const skipped = [
      { ...check(1, requested + 60_000, "skipped"), name: "gate-3" },
      { ...check(2, requested + 60_000, "skipped"), name: "gate-4" },
    ];
    f.advance(120_000);
    expect(
      await recoverCancelled(
        "5",
        "head",
        [...done.checks, ...skipped, ...labelChecks],
        [...done.runs, ...labelRuns],
        f.deps,
      ),
    ).toBe("none");
    expect(f.calls).toEqual([1, 2, 1, 2]);
    expect(f.parks).toEqual([]);

    for (const outcome of ["cancelled", "never"] as const) {
      const g = await grantedRequest();
      const runs =
        outcome === "never"
          ? [A(), B(), ...labelRuns]
          : [
              A(requested + 5_000, "completed", "cancelled", 2),
              B(requested + 5_000, "completed", "cancelled", 2),
              ...labelRuns,
            ];
      const jobs = [...firstChecks, ...labelChecks];
      expect(await recoverCancelled("5", "head", jobs, runs, g.deps)).toBe(
        "wait",
      );
      g.advance(REPLACEMENT_WINDOW_MS);
      expect(await recoverCancelled("5", "head", jobs, runs, g.deps)).toBe(
        "parked",
      );
      expect(g.parks[0]).toContain("Cancelled CI on head head: run 1, 2:");
      expect(g.parks[0]).toContain(
        "the re-run a person's answer granted was requested",
      );
      expect(g.parks[0]).toContain(
        outcome === "never"
          ? "run 1 got no new attempt"
          : "run 1 got attempt 2, which ended cancelled",
      );
      expect(g.parks[0]).toContain("gh run rerun 1; gh run rerun 2");
      expect(g.parks[0]).not.toContain("gh run rerun 3");
      expect(g.calls).toEqual([1, 2, 1, 2]);
    }
  });

  test("a later grant re-runs the runs the park named, not newer cancelled runs", async () => {
    const f = await grantedRequest();
    const jobs = [...firstChecks, ...labelChecks];
    const runs = [A(), B(), ...labelRuns];
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "parked",
    );
    f.grant();
    f.advance(30_000);
    await recoverCancelled("5", "head", jobs, runs, f.deps);
    expect(f.calls).toEqual([1, 2, 1, 2, 1, 2]);
  });

  test("a run in flight at the request and cancelled afterward is not answered by its result", async () => {
    const f = await grantedRequest();
    const start = requested + 60_000;
    const done = succeeded(start);
    // E started before the request but was cancelled after it.
    const late = { ...wf(5, 10, requested - 4_000), updatedAt: at(start) };
    // The successful attempt skips E's job, so the cancellation is retained.
    const skip = { ...check(1, start, "skipped"), name: "gate-5" };
    const jobs = [...done.checks, skip, check(5, requested - 4_000)];
    f.advance(120_000);
    await recoverCancelled("5", "head", jobs, [...done.runs, late], f.deps);
    expect(f.calls).toEqual([1, 2, 1, 2, 5]);
  });

  test("a re-run whose results supersede every cancellation clears it", async () => {
    const f = await grantedRequest();
    const done = succeeded(requested + 60_000);
    f.advance(120_000);
    expect(
      await recoverCancelled("5", "head", done.checks, done.runs, f.deps),
    ).toBe("none");
    expect(f.parks).toEqual([]);
  });

  test("only the re-run runs without a result are named, and a later grant re-runs only those", async () => {
    const f = await grantedRequest();
    const start = requested + 60_000;
    const runs = [A(start, "completed", "success", 2), B()];
    const jobs = [...firstChecks, check(1, start, "success")];
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.parks[0]).toContain("Cancelled CI on head head: run 2:");
    expect(f.parks[0]).toContain("run 2 got no new attempt");
    f.grant();
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1, 2, 1, 2, 2]);
  });

  test("a run past its window parks while a sibling's attempt is still queued", async () => {
    const f = await grantedRequest();
    const runs = [A(requested + 60_000, "queued", null, 2), B()];
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.parks[0]).toContain("Cancelled CI on head head: run 2:");
  });

  test("the wait outlasts a re-run that takes minutes to start, and still parks when no attempt appears", async () => {
    const f = await grantedRequest();
    const idle = [A(), B()];
    f.advance(5 * 60_000);
    expect(await recoverCancelled("5", "head", firstChecks, idle, f.deps)).toBe(
      "wait",
    );
    f.advance(2 * 60_000);
    const start = requested + 7 * 60_000;
    expect(
      await recoverCancelled(
        "5",
        "head",
        firstChecks,
        [A(start, "queued", null, 2), B(start, "queued", null, 2)],
        f.deps,
      ),
    ).toBe("wait");
    f.advance(4 * 60_000);
    const done = succeeded(start);
    expect(
      await recoverCancelled("5", "head", done.checks, done.runs, f.deps),
    ).toBe("none");
    expect(f.parks).toEqual([]);

    const g = await grantedRequest();
    g.advance(REPLACEMENT_WINDOW_MS - 1_000);
    expect(await recoverCancelled("5", "head", firstChecks, idle, g.deps)).toBe(
      "wait",
    );
    g.advance(1_000);
    expect(await recoverCancelled("5", "head", firstChecks, idle, g.deps)).toBe(
      "parked",
    );
    expect(g.calls).toEqual([1, 2, 1, 2]);
  });

  test("two Re-run safely answers on a head whose granted re-run succeeds park only once", async () => {
    const f = await grantedRequest();
    const done = succeeded(requested + 60_000);
    const checks = [...done.checks, ...labelChecks];
    const runs = [...done.runs, ...labelRuns];
    f.advance(120_000);
    expect(await recoverCancelled("5", "head", checks, runs, f.deps)).not.toBe(
      "parked",
    );
    // The second answer, read on a later re-arm.
    f.grant();
    for (let i = 0; i < 3; i++) {
      f.advance(REPLACEMENT_WINDOW_MS);
      expect(
        await recoverCancelled("5", "head", checks, runs, f.deps),
      ).not.toBe("parked");
    }
    expect(f.parks).toEqual([]);
    expect(f.calls).toEqual([1, 2, 1, 2]);
  });

  test("an extension gives back only what it added", async () => {
    const f = await grantedRequest();
    const done = succeeded(requested + 60_000);
    const later = wf(5, 10, requested + 120_000);
    const jobs = [...done.checks, check(5, requested + 120_000)];
    const before = f.record();
    f.advance(180_000);
    let confirms = 0;
    // Before the extension the head confirms; the request's own check cannot read.
    f.deps.confirm = async () => (++confirms === 2 ? "unread" : true);
    expect(
      await recoverCancelled("5", "head", jobs, [...done.runs, later], f.deps),
    ).toBe("unknown");
    expect(f.calls).toEqual([1, 2, 1, 2]);
    expect(f.record()?.requestedAt).toBe(before?.requestedAt ?? -1);
    expect(f.record()?.requestedRuns).toEqual(before?.requestedRuns);
  });

  test("a run cancelled after the request is requested once, then judged on its own", async () => {
    const f = await grantedRequest();
    const done = succeeded(requested + 60_000);
    const later = wf(5, 10, requested + 120_000);
    const other = wf(6, 12, requested + 120_000);
    const jobs = [
      ...done.checks,
      check(5, requested + 120_000),
      check(6, requested + 120_000),
    ];
    const runs = [...done.runs, later, other];
    f.advance(180_000);
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1, 2, 1, 2, 5, 6]);
    f.advance(60_000);
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1, 2, 1, 2, 5, 6]);
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(await recoverCancelled("5", "head", jobs, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.parks[0]).toContain("Cancelled CI on head head: run 5, 6:");
    expect(f.calls).toEqual([1, 2, 1, 2, 5, 6]);
  });

  test("a grant that arrived while the re-run was in flight pays for the next request instead of a park", async () => {
    const f = await grantedRequest();
    f.grant(true);
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(
      await recoverCancelled("5", "head", firstChecks, [A(), B()], f.deps),
    ).toBe("wait");
    expect(f.parks).toEqual([]);
    expect(f.calls).toEqual([1, 2, 1, 2, 1, 2]);
  });

  test("a grant read while the re-run is inside its window waits for it", async () => {
    const f = await grantedRequest();
    f.advance(60_000);
    f.grant();
    expect(
      await recoverCancelled("5", "head", firstChecks, [A(), B()], f.deps),
    ).toBe("wait");
    expect(f.calls).toEqual([1, 2, 1, 2]);
  });
});

describe("a drive that loses the pull request between the claim and a request", () => {
  test("gives the claim back for the runs it never sent", async () => {
    const f = fixture();
    let owned = true;
    const deps: RecoveryDeps = { ...f.deps, mayMutate: async () => owned };
    await recoverCancelled("5", "head", [job], [run(1)], deps);
    f.advance(30_000);
    // Lost once the claim is spent and the first request is about to leave.
    owned = false;
    expect(await recoverCancelled("5", "head", [job], [run(1)], deps)).toBe(
      "unknown",
    );
    expect(f.calls).toEqual([]);
    expect(f.parks).toEqual([]);
    expect(f.record()?.requestedAt).toBeNull();
  });
});

describe("a drive that lost the pull request mid-recovery", () => {
  test("neither re-runs nor parks once the ownership check refuses", async () => {
    const f = fixture();
    let owned = true;
    const deps: RecoveryDeps = { ...f.deps, mayMutate: async () => owned };
    await recoverCancelled("5", "head", [job], [run(1)], deps);
    f.advance(30_000);
    owned = false;
    expect(await recoverCancelled("5", "head", [job], [run(1)], deps)).toBe(
      "unknown",
    );
    expect(f.calls).toEqual([]);
    expect(f.parks).toEqual([]);
  });
  test("a refused re-run answer is not parked by a drive that no longer owns it", async () => {
    const f = fixture();
    let owned = true;
    const deps: RecoveryDeps = {
      ...f.deps,
      mayMutate: async () => owned,
      rerun: async () => {
        owned = false;
        return { code: 1, stderr: "refused" };
      },
    };
    await recoverCancelled("5", "head", [job], [run(1)], deps);
    f.advance(30_000);
    await recoverCancelled("5", "head", [job], [run(1)], deps);
    expect(f.parks).toEqual([]);
  });
});
