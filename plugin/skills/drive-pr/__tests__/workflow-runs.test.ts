/**
 * drive-pr suite: how a head's check runs read once the workflow runs behind
 * them are known. A cancelled check is an absence of evidence: never a failure
 * to repair and never a pass. No test here looks at a check's name for meaning.
 */

import { describe, expect, it } from "bun:test";
import {
  createdUnderHold,
  type LabelTransition,
} from "../scripts/lib/ci-hold.ts";
import {
  failedRunsField,
  runsOutsideHold,
} from "../scripts/lib/driver/failed-runs.ts";
import {
  type CheckRun,
  ciVerdictOf,
  failingCheckRunNames,
  failingNames,
  failingRunsOf,
} from "../scripts/lib/status/evidence.ts";
import {
  type WorkflowRun,
  rerunAwaitsResult,
  withoutRerunning,
  withoutSuperseded,
} from "../scripts/lib/status/workflow-runs.ts";

const HEAD = "a".repeat(40);
const T0 = "2026-09-10T10:00:00Z";
const T1 = "2026-09-10T10:01:00Z";
const T2 = "2026-09-10T10:02:00Z";
const T3 = "2026-09-10T10:03:00Z";
const T4 = "2026-09-10T10:04:00Z";

const workflowRun = (
  id: number,
  conclusion: string | null,
  startedAt = T1,
  opts: Partial<WorkflowRun> = {},
): WorkflowRun => ({
  id,
  workflowId: 7,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  checkSuiteId: id,
  createdAt: startedAt,
  startedAt,
  attempt: 1,
  ...opts,
});

let nextId = 1000;
const job = (
  name: string,
  conclusion: string | null,
  suiteId: number | null,
  opts: Partial<CheckRun> = {},
): CheckRun => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  app: "github-actions",
  title: "",
  id: nextId++,
  started: T1,
  completed: conclusion === null ? null : T2,
  suiteId,
  ...opts,
});

const verdict = (runs: CheckRun[], workflowRuns: WorkflowRun[] | null) =>
  ciVerdictOf(runs, [], false, HEAD, workflowRuns);

describe("a cancelled run and the run that replaced it", () => {
  it("reads the sibling's result once it has one, whatever the order of the ids", () => {
    // Measured on one head, both orders: the concurrency group cancelled the
    // higher run id in favour of a lower one started in the same second, and
    // the cancelled run's check runs can carry the higher ids too.
    const workflowRuns = [
      workflowRun(50, "cancelled"),
      workflowRun(40, "success"),
    ];
    const runs = [
      job("gates", "success", 40),
      job("gates", "cancelled", 50),
      job("tests", "cancelled", 50),
      job("tests", "success", 40),
    ];
    expect(verdict(runs, workflowRuns)).toBe("green");
    expect(failingCheckRunNames(runs, false, workflowRuns)).toEqual([]);
  });

  it("waits while the sibling has no result yet, and never reads green", () => {
    const cancelled = job("gates", "cancelled", 40);
    // The replacing run exists and has no check runs at all yet.
    expect(
      verdict(
        [cancelled],
        [workflowRun(40, "cancelled"), workflowRun(41, null)],
      ),
    ).toBe("cancelled: gates");
    // Its check runs exist and are still going.
    expect(
      verdict(
        [cancelled, job("tests", null, 41)],
        [workflowRun(40, "cancelled"), workflowRun(41, null)],
      ),
    ).toBe("pending: tests");
  });

  it("lets a live job speak through a cancelled one with a higher id", () => {
    const runs = [job("gates", null, 41), job("gates", "cancelled", 40)];
    expect(
      verdict(runs, [workflowRun(40, "cancelled"), workflowRun(41, null)]),
    ).toBe("pending: gates");
  });

  it("drops a check no later run reports under that name", () => {
    // A run cancelled before its matrix expanded leaves a check named after
    // the template. Nothing about the text decides this: a plain name reads
    // the same.
    for (const name of [
      `suite (linux, \${{ matrix.shard }}/3)`,
      "a job only that run had",
    ]) {
      const workflowRuns = [
        workflowRun(40, "cancelled"),
        workflowRun(41, "success"),
      ];
      const runs = [
        job(name, "cancelled", 40),
        job("suite (linux, 1/3)", "success", 41),
      ];
      expect(verdict(runs, workflowRuns)).toBe("green");
      // Nothing replaced it: the same check is unknown.
      expect(
        verdict([runs[0] as CheckRun], [workflowRun(40, "cancelled")]),
      ).toBe(`cancelled: ${name}`);
    }
  });

  it("does not depend on the event that started either run", () => {
    // A released CI hold can leave a `pull_request` run beside a
    // `workflow_dispatch` one. The event is not an input: both are one
    // workflow's runs on the head.
    const parsed = [
      workflowRun(40, "cancelled"),
      { ...workflowRun(41, "success"), event: "workflow_dispatch" },
    ];
    const runs = [job("gates", "cancelled", 40), job("gates", "success", 41)];
    expect(verdict(runs, parsed)).toBe("green");
  });

  it("is a real failure when the replacing run failed", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled"),
      workflowRun(41, "failure"),
    ];
    const runs = [job("gates", "cancelled", 40), job("gates", "failure", 41)];
    expect(verdict(runs, workflowRuns)).toBe("failing: gates");
    expect(failingRunsOf(runs, workflowRuns)?.map((r) => r.id)).toEqual([41]);
  });

  it("takes a re-run of an earlier run as a replacement, by its latest start", () => {
    const workflowRuns = [
      workflowRun(40, "success", T3, { createdAt: T0 }),
      workflowRun(41, "cancelled", T1),
    ];
    const runs = [job("gates", "cancelled", 41), job("gates", "success", 40)];
    expect(verdict(runs, workflowRuns)).toBe("green");
  });

  it("does not take a run of another workflow as a replacement", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled"),
      workflowRun(41, "success", T2, { workflowId: 8 }),
    ];
    const runs = [job("gates", "cancelled", 40), job("lint", "success", 41)];
    expect(verdict(runs, workflowRuns)).toBe("cancelled: gates");
  });
});

describe("a cancelled check never reads as passing", () => {
  it("stays unknown beside an older green run: the shape of a held run", () => {
    // The CI hold's held run cancels itself so that a required check blocks
    // the merge, beside the green the opening run left on the same head.
    const workflowRuns = [
      workflowRun(30, "success", T0),
      workflowRun(40, "cancelled", T2),
    ];
    const runs = [job("gates", "success", 30), job("gates", "cancelled", 40)];
    expect(verdict(runs, workflowRuns)).toBe("cancelled: gates");
    // The required-check proof keeps seeing the cancelled check as the newest.
    expect(withoutSuperseded(runs, workflowRuns)).toEqual(runs);
  });

  it("is not replaced by a run that looked at nothing", () => {
    const opened = job("gates", "cancelled", 40);
    for (const successor of [
      // Skipped outright.
      { run: workflowRun(41, "skipped"), jobs: [job("gates", "skipped", 41)] },
      // Concluded success with every job skipped.
      { run: workflowRun(41, "success"), jobs: [job("gates", "skipped", 41)] },
      // Concluded failure without a job ever starting.
      { run: workflowRun(41, "failure"), jobs: [] },
      { run: workflowRun(41, "startup_failure"), jobs: [] },
      { run: workflowRun(41, "action_required"), jobs: [] },
      // Cancelled too.
      {
        run: workflowRun(41, "cancelled"),
        jobs: [job("gates", "cancelled", 41)],
      },
    ]) {
      expect(
        verdict(
          [opened, ...successor.jobs],
          [workflowRun(40, "cancelled"), successor.run],
        ),
      ).toBe("cancelled: gates");
    }
  });

  it("stays unknown when the replacing run skipped the cancelled job", () => {
    const runs = [
      job("tests", "cancelled", 40),
      job("lint", "success", 41),
      job("tests", "skipped", 41),
    ];
    expect(
      verdict(runs, [
        workflowRun(40, "cancelled"),
        workflowRun(41, "success", T4),
      ]),
    ).toBe("cancelled: tests");
  });

  it("stays unknown when the workflow runs cannot be read, or there is none", () => {
    const runs = [job("gates", "cancelled", 40), job("gates", "success", 41)];
    // Unreadable: nothing is dropped, and the check runs read on their own.
    expect(verdict([job("gates", "cancelled", 40)], null)).toBe(
      "cancelled: gates",
    );
    expect(verdict(runs, null)).toBe("green");
    // A check no workflow run stands behind, from another app.
    expect(verdict([job("scan", "cancelled", null)], [])).toBe(
      "cancelled: scan",
    );
  });
});

describe("an aggregator that fails on cancelled needs", () => {
  const cancelledRun = workflowRun(40, "cancelled");
  const need = () =>
    job("suite", "cancelled", 40, { started: T1, completed: T2 });
  const aggregator = (started = T3) =>
    job("gates", "failure", 40, { started, completed: T4 });

  it("is the same absence of evidence when its run was cancelled", () => {
    const runs = [need(), aggregator()];
    expect(verdict(runs, [cancelledRun])).toBe("cancelled: gates, suite");
    expect(failingNames(runs, [], false, [cancelledRun])).toEqual([]);
    expect(failingRunsOf(runs, [cancelledRun])).toEqual([]);
  });

  it("goes with the run once another run replaced it", () => {
    const runs = [need(), aggregator(), job("gates", "success", 41)];
    expect(verdict(runs, [cancelledRun, workflowRun(41, "success", T4)])).toBe(
      "green",
    );
  });

  it("stays a failure in a run that was not cancelled", () => {
    const runs = [
      job("suite", "cancelled", 40, { completed: T2 }),
      job("gates", "failure", 40, { started: T3 }),
    ];
    const failedRun = [workflowRun(40, "failure")];
    expect(verdict(runs, failedRun)).toBe("failing: gates");
    expect(failingRunsOf(runs, failedRun)?.map((r) => r.id)).toEqual([40]);
  });

  it("stays a failure beside a need that truly failed before the cancellation", () => {
    const runs = [
      job("unit", "failure", 40, { started: T0, completed: T1 }),
      need(),
      aggregator(),
    ];
    expect(verdict(runs, [cancelledRun])).toBe("failing: gates, unit");
    expect(failingRunsOf(runs, [cancelledRun])?.map((r) => r.id)).toEqual([40]);
  });

  it("stays a failure when no job of the run was cancelled", () => {
    expect(verdict([aggregator()], [cancelledRun])).toBe("failing: gates");
  });

  it("stays a failure when the runs cannot be read", () => {
    expect(verdict([need(), aggregator()], null)).toBe("failing: gates");
  });

  it("stays a failure when it could have run beside a cancelled job", () => {
    // Same-second starts and completions cannot be ordered.
    expect(verdict([need(), aggregator(T2)], [cancelledRun])).toBe(
      "failing: gates",
    );
  });

  it("stays a failure when another job of the run completed after it started", () => {
    const late = job("cleanup", "success", 40, { started: T1, completed: T4 });
    expect(verdict([need(), late, aggregator()], [cancelledRun])).toBe(
      "failing: gates",
    );
  });

  it("does not explain a timed-out job", () => {
    const runs = [need(), job("slow", "timed_out", 40, { started: T3 })];
    expect(verdict(runs, [cancelledRun])).toBe("failing: slow");
  });
});

describe("a true failure beside a cancelled sibling", () => {
  it("names the run that failed, not the cancelled one, when the cancelled is older", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled"),
      workflowRun(41, "failure"),
    ];
    const runs = [
      job("unit", "cancelled", 40),
      job("unit", "failure", 41),
      job("gates", "failure", 41),
    ];
    expect(verdict(runs, workflowRuns)).toBe("failing: gates, unit");
    expect(failingRunsOf(runs, workflowRuns)).toEqual([
      { id: 41, createdAt: T1 },
    ]);
  });

  it("names the run that failed when the cancelled one has the newer ids", () => {
    // Nothing replaced the cancelled run, but an absence of evidence must not
    // hide the evidence under the same name.
    const workflowRuns = [
      workflowRun(41, "failure", T1),
      workflowRun(42, "cancelled", T2),
    ];
    const runs = [job("unit", "failure", 41), job("unit", "cancelled", 42)];
    expect(verdict(runs, workflowRuns)).toBe("failing: unit");
    expect(failingRunsOf(runs, workflowRuns)?.map((r) => r.id)).toEqual([41]);
  });

  it("repairs the failure and leaves the cancelled name out of it", () => {
    const workflowRuns = [
      workflowRun(41, "failure", T1),
      workflowRun(42, "cancelled", T2),
    ];
    const runs = [job("unit", "failure", 41), job("lint", "cancelled", 42)];
    expect(verdict(runs, workflowRuns)).toBe("failing: unit");
    expect(failingCheckRunNames(runs, false, workflowRuns)).toEqual(["unit"]);
  });

  it("waits for a failed run a repair pass has just re-run", () => {
    // The first attempt's failed job is still on the list while the second is
    // queued. Read as failing, it would spend the next repair on the same run.
    const rerun = workflowRun(41, null, T2, { attempt: 2 });
    const runs = [job("unit", "failure", 41), job("lint", "success", 41)];
    expect(verdict(runs, [rerun])).toBe("pending: unit");
    expect(failingCheckRunNames(runs, false, [rerun])).toEqual([]);
    // Its first attempt still running, a job that failed has failed.
    expect(verdict(runs, [workflowRun(41, null, T2)])).toBe("failing: unit");
  });

  it("has no run to name for a check from outside the workflow runs", () => {
    const runs = [job("scan", "failure", null)];
    expect(failingRunsOf(runs, [])).toEqual([]);
    expect(failingRunsOf(runs, null)).toBeNull();
  });
});

describe("createdUnderHold", () => {
  const event = (
    kind: "labeled" | "unlabeled",
    createdAt: string,
  ): LabelTransition => ({
    id: createdAt,
    event: kind,
    actor: "drive-user",
    createdAt,
  });
  const window = [event("labeled", T1), event("unlabeled", T3)];

  it("is true from the label's application up to its removal", () => {
    expect(createdUnderHold(T0, window)).toBe(false);
    expect(createdUnderHold(T1, window)).toBe(true);
    expect(createdUnderHold(T2, window)).toBe(true);
    expect(createdUnderHold(T3, window)).toBe(false);
    expect(createdUnderHold(T4, window)).toBe(false);
  });

  it("is true for a label still on", () => {
    expect(createdUnderHold(T4, [event("labeled", T1)])).toBe(true);
  });

  it("is false without a transition, and true for an unreadable time", () => {
    expect(createdUnderHold(T1, [])).toBe(false);
    expect(createdUnderHold("not a time", window)).toBe(true);
  });

  it("leaves a run under the hold out of what a repair pass may re-run", () => {
    const failed = [
      { id: 1, createdAt: T0 },
      { id: 2, createdAt: T2 },
      { id: 3, createdAt: T4 },
    ];
    expect(runsOutsideHold(failed, window)).toEqual([1, 3]);
    expect(runsOutsideHold(failed, [])).toEqual([1, 2, 3]);
    // Unreadable label history: no run is named at all.
    expect(runsOutsideHold(failed, null)).toEqual([]);
  });

  it("reads failingRuns off a report defensively", () => {
    expect(failedRunsField(null)).toEqual([]);
    expect(failedRunsField("41")).toEqual([]);
    expect(
      failedRunsField([{ id: 41, createdAt: T0 }, { id: "42" }, null]),
    ).toEqual([{ id: 41, createdAt: T0 }]);
  });
});

describe("a run being re-run", () => {
  it("witnesses nothing through its failed jobs, and keeps its passing ones", () => {
    const rerun = workflowRun(41, null, T2, { attempt: 2 });
    const runs = [job("tests", "failure", 41), job("lint", "success", 41)];
    expect(withoutRerunning(runs, [rerun]).map((r) => r.name)).toEqual([
      "lint",
    ]);
    expect(withoutRerunning(runs, null)).toEqual(runs);
  });
});

describe("evidence is dropped only when a successor supplies a result", () => {
  it("keeps a cancellation-explained failure when the successor skips it", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled", T1),
      workflowRun(41, "success", T2),
    ];
    const runs = [
      job("tests", "cancelled", 40, { started: T1, completed: T2 }),
      job("gates", "failure", 40, { started: T3, completed: T4 }),
      job("tests", "success", 41),
      job("gates", "skipped", 41),
    ];
    expect(withoutSuperseded(runs, workflowRuns)).toContain(
      runs.filter(
        (r) => r.name === "gates" && r.conclusion === "failure",
      )[0] as never,
    );
    expect(verdict(runs, workflowRuns)).toBe("cancelled: gates");
  });

  it("lets a successor that ran replace a job another successor skipped", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled", T1),
      workflowRun(41, "success", T2),
      workflowRun(42, "success", T2),
    ];
    const runs = [
      job("tests", "cancelled", 40),
      job("lint", "success", 41),
      job("tests", "skipped", 41),
      job("tests", "success", 42),
    ];
    expect(withoutSuperseded(runs, workflowRuns)).not.toContain(runs[0]);
  });

  it("keeps an independent failure when the successor skips its name", () => {
    const workflowRuns = [
      workflowRun(40, "cancelled", T1),
      workflowRun(41, "success", T2),
    ];
    const runs = [
      job("unit", "failure", 40, { started: T1, completed: T2 }),
      job("other", "cancelled", 40, { started: T1, completed: T2 }),
      job("lint", "success", 41),
      job("unit", "skipped", 41),
    ];
    expect(verdict(runs, workflowRuns)).toBe("failing: unit");
    expect(failingCheckRunNames(runs, false, workflowRuns)).toEqual(["unit"]);
  });

  it("lets a newer skip answer an earlier failure of an uncancelled run", () => {
    const workflowRuns = [
      workflowRun(40, "failure", T1),
      workflowRun(41, "success", T2),
    ];
    const runs = [
      job("unit", "failure", 40, { started: T1, completed: T2 }),
      job("lint", "success", 41),
      job("unit", "skipped", 41),
    ];
    expect(verdict(runs, workflowRuns)).not.toContain("failing");
  });

  it("keeps a rerunning job pending behind a newer skip of its name", () => {
    const rerun = workflowRun(40, null, T1, { attempt: 2 });
    const workflowRuns = [rerun, workflowRun(41, "success", T2)];
    const runs = [
      job("unit", "failure", 40, { started: T1, completed: T2 }),
      job("lint", "success", 41),
      job("unit", "skipped", 41),
    ];
    expect(verdict(runs, workflowRuns)).toBe("pending: unit");
  });

  it("owes the result of a rerunning job that only a newer skip remains behind", () => {
    const rerun = workflowRun(40, null, T1, { attempt: 2 });
    const workflowRuns = [rerun, workflowRun(41, "success", T2)];
    const failed = job("unit", "failure", 40, { started: T1, completed: T2 });
    expect(
      rerunAwaitsResult([failed, job("unit", "skipped", 41)], workflowRuns),
    ).toBe(true);
    expect(
      rerunAwaitsResult([failed, job("unit", "success", 41)], workflowRuns),
    ).toBe(false);
    expect(rerunAwaitsResult([failed], [workflowRun(40, "failure", T1)])).toBe(
      false,
    );
  });

  it("does not explain two failures that started together as aggregators", () => {
    const workflowRuns = [workflowRun(40, "cancelled", T1)];
    const runs = [
      job("tests", "cancelled", 40, { started: T1, completed: T2 }),
      job("a", "failure", 40, { started: T3, completed: T4 }),
      job("b", "failure", 40, { started: T3, completed: T4 }),
    ];
    expect(failingCheckRunNames(runs, false, workflowRuns)).toEqual(["a", "b"]);
  });
});
