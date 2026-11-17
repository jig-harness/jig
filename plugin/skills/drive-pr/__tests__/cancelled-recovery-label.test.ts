import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  recoverCancelled,
  type RecoveryDeps,
  type RecoveryRecord,
} from "../scripts/lib/cancelled-recovery.ts";
import {
  labelRerunKey,
  labelWriteTimes,
} from "../scripts/lib/label-cancelled-runs.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";
import { parseMs } from "../../../shared/time.ts";
import { fakeForge, runIn, SCRIPTS } from "./provisional-fixtures.ts";

const at = (time: string) => parseMs(`2026-01-01T${time}Z`);
const iso = (time: string) => `2026-01-01T${time}Z`;

function run(
  id: number,
  time: string,
  fields: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    workflowId: 10,
    checkSuiteId: id,
    status: "completed",
    conclusion: "cancelled",
    createdAt: iso(time),
    startedAt: iso(time),
    attempt: 1,
    ...fields,
  };
}
const gate = (suiteId: number, conclusion: string) => ({
  name: "gate",
  status: "completed",
  conclusion,
  suiteId,
});

/** A head whose once-per-head re-run was requested at midnight and is spent. */
function fixture(now: string, writes: string[]) {
  let clock = at(now);
  const record: RecoveryRecord = {
    firstSeen: at("00:00:00"),
    requestedAt: at("00:00:00"),
  };
  const reruns = new Map<string, number>();
  const calls: number[] = [];
  const parks: string[] = [];
  const deps: RecoveryDeps = {
    now: () => clock,
    observe: async () => record,
    claim: async () => false,
    confirm: async () => true,
    rerunnable: async (_pr, runs) => runs.map((r) => r.id),
    rerun: async (id) => {
      calls.push(id);
      return { code: 0, stderr: "" };
    },
    park: async (_pr, reason) => {
      parks.push(reason);
    },
    labelWrites: async () => writes.map(at),
    labelReruns: async () => reruns,
    claimLabelRerun: async (_pr, r) => {
      if (reruns.has(labelRerunKey(r))) return false;
      reruns.set(labelRerunKey(r), clock);
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
  };
}

// A person re-ran the parked run (attempt 2, green); the re-arm's two label
// writes then started two runs that the concurrency group cancelled.
const rerunByHand = run(1, "00:00:10", {
  conclusion: "success",
  createdAt: iso("00:00:00"),
  attempt: 2,
});
const labelRuns = [run(2, "00:01:02"), run(3, "00:01:03")];
const labelJobs = [
  gate(1, "success"),
  gate(2, "cancelled"),
  gate(3, "cancelled"),
];
const rearm = ["00:01:00", "00:01:01"];

describe("cancellations a label write caused", () => {
  test("are re-run outside a spent head budget instead of parking", async () => {
    const f = fixture("00:01:40", rearm);
    const runs = [rerunByHand, ...labelRuns];
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([3]);
    expect(f.parks).toEqual([]);
    // The re-run is awaited, never requested again for the same attempt.
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([3]);
  });

  test("a label run's first attempt is recovered however late it started", async () => {
    // Created inside the window, queued until 00:01:40: its creation, not its
    // start, says what started it.
    const late = run(4, "00:01:40", { createdAt: iso("00:01:02") });
    const f = fixture("00:02:20", ["00:01:00"]);
    expect(
      await recoverCancelled(
        "5",
        "head",
        [gate(4, "cancelled")],
        [late],
        f.deps,
      ),
    ).toBe("wait");
    expect(f.calls).toEqual([4]);
    expect(f.parks).toEqual([]);
  });

  test("wait while the label write's runs may still be arriving", async () => {
    const f = fixture("00:01:20", rearm);
    const runs = [rerunByHand, ...labelRuns];
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "wait",
    );
    expect(f.calls).toEqual([]);
  });

  test("a person's re-run a label run cancelled is re-run, not parked on", async () => {
    const f = fixture("00:01:40", ["00:01:00"]);
    const cancelledByLabel = run(1, "00:00:30", {
      createdAt: iso("00:00:00"),
      updatedAt: iso("00:01:04"),
      attempt: 2,
    });
    const skippedLabelRun = run(2, "00:01:02", { conclusion: "success" });
    const jobs = [gate(1, "cancelled"), gate(2, "skipped")];
    expect(
      await recoverCancelled(
        "5",
        "head",
        jobs,
        [cancelledByLabel, skippedLabelRun],
        f.deps,
      ),
    ).toBe("wait");
    expect(f.calls).toEqual([1]);
    expect(f.parks).toEqual([]);
  });

  test("a label run's re-run keeps its provenance for the person's run it cancelled", async () => {
    const f = fixture("00:03:00", ["00:01:00"]);
    // The person's run 1 was in flight when label run 3 arrived; run 3 has
    // since been re-run (attempt 2, started long after the write) and skipped.
    const persons = run(1, "00:00:30", {
      createdAt: iso("00:00:00"),
      updatedAt: iso("00:01:04"),
      attempt: 2,
    });
    const rerunLabel = run(3, "00:01:50", {
      conclusion: "success",
      createdAt: iso("00:01:02"),
      startedAt: iso("00:01:50"),
      attempt: 2,
    });
    const jobs = [gate(1, "cancelled"), gate(3, "skipped")];
    expect(
      await recoverCancelled("5", "head", jobs, [persons, rerunLabel], f.deps),
    ).toBe("wait");
    expect(f.calls).toEqual([1]);
    expect(f.parks).toEqual([]);
  });

  test("a retry's new attempt cancelled quickly keeps the replacement window", async () => {
    const f = fixture("00:01:45", ["00:01:00"]);
    const requested = at("00:01:40");
    f.deps.labelReruns = async () => new Map([["3:1", requested]]);
    const attempt2 = run(3, "00:01:45", {
      createdAt: iso("00:01:02"),
      startedAt: iso("00:01:41"),
      attempt: 2,
    });
    expect(
      await recoverCancelled(
        "5",
        "head",
        [gate(3, "cancelled")],
        [attempt2],
        f.deps,
      ),
    ).toBe("wait");
    expect(f.parks).toEqual([]);
  });

  test("a run cancelled before the label write counts against the budget", async () => {
    const f = fixture("00:01:40", ["00:01:00"]);
    const cancelledEarlier = run(1, "00:00:30", {
      createdAt: iso("00:00:00"),
      updatedAt: iso("00:00:40"),
      attempt: 2,
    });
    const skippedLabelRun = run(2, "00:01:02", { conclusion: "success" });
    const jobs = [gate(1, "cancelled"), gate(2, "skipped")];
    expect(
      await recoverCancelled(
        "5",
        "head",
        jobs,
        [cancelledEarlier, skippedLabelRun],
        f.deps,
      ),
    ).toBe("parked");
    expect(f.calls).toEqual([]);
  });

  test("a label-caused re-run that did not take falls back to the head's budget", async () => {
    const f = fixture("00:01:40", rearm);
    const runs = [rerunByHand, ...labelRuns];
    await recoverCancelled("5", "head", labelJobs, runs, f.deps);
    f.advance(60_000);
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.calls).toEqual([3]);
    expect(f.parks[0]).toContain("run 3");
  });

  test("a run created long after a label write still counts against the budget", async () => {
    const f = fixture("00:01:40", ["00:00:20"]);
    const runs = [rerunByHand, ...labelRuns];
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.calls).toEqual([]);
  });

  test("a run that may not be replayed safely is left to the head's budget", async () => {
    const f = fixture("00:01:40", rearm);
    f.deps.rerunnable = async () => [];
    const runs = [rerunByHand, ...labelRuns];
    expect(await recoverCancelled("5", "head", labelJobs, runs, f.deps)).toBe(
      "parked",
    );
    expect(f.calls).toEqual([]);
  });

  test("the label history leaves out the CI hold's label and other events", () => {
    const events = [
      {
        event: "labeled",
        label: { name: "jig:driving" },
        created_at: iso("00:01:00"),
      },
      {
        event: "unlabeled",
        label: { name: "ci:hold" },
        created_at: iso("00:02:00"),
      },
      { event: "committed", created_at: iso("00:03:00") },
      { event: "unlabeled", label: { name: "jig:parked" } },
      null,
    ];
    expect(labelWriteTimes(events, "ci:hold")).toEqual([at("00:01:00")]);
  });
});

/** Claim a label-caused re-run twice for one attempt and once for the next. */
const CLAIMS = `
import { claimLabelRerun, labelReruns } from ${JSON.stringify(join(SCRIPTS, "lib", "cancelled-recovery-state.ts"))};
const run = { id: 7, workflowId: 10, checkSuiteId: 7, status: "completed", conclusion: "cancelled",
  createdAt: "2026-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z", attempt: 1 };
const claims = [
  await claimLabelRerun("12", run),
  await claimLabelRerun("12", run),
  await claimLabelRerun("12", { ...run, attempt: 2 }),
];
console.log(JSON.stringify({ claims, keys: [...(await labelReruns("12")).keys()].sort() }));
`;

describe("the label-caused re-run claim", () => {
  test("holds once per run attempt across invocations", async () => {
    const forge = fakeForge();
    const file = join(forge.dir, "claims.ts");
    writeFileSync(file, CLAIMS);
    const r = await runIn(forge, file, [], { env: { DRIVE_PR_TARGET: "12" } });
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toEqual({
      claims: [true, false, true],
      keys: ["7:1", "7:2"],
    });
  });
});
