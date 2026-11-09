import { describe, expect, test } from "bun:test";
import {
  recoverCancelled,
  type RecoveryDeps,
} from "../scripts/lib/cancelled-recovery.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";

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
function fixture() {
  let clock = 0;
  let record: { firstSeen: number; requestedAt: number | null } | null = null;
  const calls: number[] = [];
  const parks: string[] = [];
  const deps: RecoveryDeps = {
    now: () => clock,
    observe: async () => (record ??= { firstSeen: clock, requestedAt: null }),
    claim: async () => {
      if (record?.requestedAt !== null) return false;
      record = { firstSeen: record?.firstSeen ?? clock, requestedAt: clock };
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
  };
  return {
    deps,
    calls,
    parks,
    advance: (ms: number) => {
      clock += ms;
    },
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
    f.advance(60_000);
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
