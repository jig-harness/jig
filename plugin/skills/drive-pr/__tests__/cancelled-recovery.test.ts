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
  // A and B are the cancelled runs the grant re-runs; C and D are runs of the
  // same workflows that a label event started after the grant, cancelled.
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
  const labelRuns = [wf(3, 10, 40_000), wf(4, 11, 40_000)];
  const labelChecks = [check(3, 40_000), check(4, 40_000)];
  const firstChecks = [check(1, 0), check(2, 0)];

  /** The automatic re-run spent and parked, then a person's answer granted, at T0 + 11 minutes. */
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
    expect(await recoverCancelled("5", "head", firstChecks, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([1, 2, 1, 2]);
    expect(f.record()?.requestedRuns?.map((r) => r.id)).toEqual([1, 2]);
    f.parks.length = 0;
    return f;
  }
  const granted = 30_000 + REPLACEMENT_WINDOW_MS;

  test("label-started cancellations wait while the re-run's attempts are queued or running", async () => {
    const f = await grantedRequest();
    const after = granted + 60_000;
    const runs = [
      A(after, "queued", null, 2),
      B(after, "in_progress", null, 2),
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
    const late = granted + 120_000;
    const ran = [
      A(granted + 60_000, "completed", "success", 2),
      B(granted + 60_000, "completed", "success", 2),
      wf(3, 10, late),
      wf(4, 11, late),
    ];
    const checks = [
      ...firstChecks,
      check(1, granted + 60_000, "success"),
      check(2, granted + 60_000, "success"),
      check(3, late),
      check(4, late),
    ];
    f.advance(120_000);
    expect(await recoverCancelled("5", "head", checks, ran, f.deps)).toBe(
      "none",
    );
    expect(f.parks).toEqual([]);

    for (const outcome of ["cancelled", "never"] as const) {
      const g = await grantedRequest();
      const runs =
        outcome === "never"
          ? [A(), B(), ...labelRuns]
          : [
              A(granted + 5_000, "completed", "cancelled", 2),
              B(granted + 5_000, "completed", "cancelled", 2),
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

  test("the wait outlasts a re-run that takes minutes to start, and still parks when no attempt appears", async () => {
    const f = await grantedRequest();
    const idle = [A(), B()];
    f.advance(5 * 60_000);
    expect(await recoverCancelled("5", "head", firstChecks, idle, f.deps)).toBe(
      "wait",
    );
    f.advance(2 * 60_000);
    const start = granted + 7 * 60_000;
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
    const done = [
      A(start, "completed", "success", 2),
      B(start, "completed", "success", 2),
    ];
    const results = [
      ...firstChecks,
      check(1, start, "success"),
      check(2, start, "success"),
    ];
    expect(await recoverCancelled("5", "head", results, done, f.deps)).toBe(
      "none",
    );
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
    const start = granted + 60_000;
    const done = [
      A(start, "completed", "success", 2),
      B(start, "completed", "success", 2),
      wf(3, 10, start + 30_000),
      wf(4, 11, start + 30_000),
    ];
    const checks = [
      ...firstChecks,
      check(1, start, "success"),
      check(2, start, "success"),
      check(3, start + 30_000),
      check(4, start + 30_000),
    ];
    f.advance(120_000);
    expect(await recoverCancelled("5", "head", checks, done, f.deps)).toBe(
      "none",
    );
    // The second answer, read on a later re-arm.
    f.grant();
    for (let i = 0; i < 3; i++) {
      f.advance(REPLACEMENT_WINDOW_MS);
      expect(
        await recoverCancelled("5", "head", checks, done, f.deps),
      ).not.toBe("parked");
    }
    expect(f.parks).toEqual([]);
  });

  test("a workflow the request did not cover is requested once, then judged on its own", async () => {
    const f = await grantedRequest();
    const start = granted + 60_000;
    const done = [
      A(start, "completed", "success", 2),
      B(start, "completed", "success", 2),
    ];
    const results = [
      ...firstChecks,
      check(1, start, "success"),
      check(2, start, "success"),
    ];
    const other = wf(5, 12, granted);
    const jobs = [...results, check(5, start)];
    f.advance(60_000);
    expect(
      await recoverCancelled("5", "head", jobs, [...done, other], f.deps),
    ).toBe("wait");
    expect(f.calls).toEqual([1, 2, 1, 2, 5]);
    f.advance(60_000);
    expect(
      await recoverCancelled("5", "head", jobs, [...done, other], f.deps),
    ).toBe("wait");
    expect(f.calls).toEqual([1, 2, 1, 2, 5]);
    f.advance(REPLACEMENT_WINDOW_MS);
    expect(
      await recoverCancelled("5", "head", jobs, [...done, other], f.deps),
    ).toBe("parked");
    expect(f.parks[0]).toContain("Cancelled CI on head head: run 5:");
    expect(f.calls).toEqual([1, 2, 1, 2, 5]);
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
});
