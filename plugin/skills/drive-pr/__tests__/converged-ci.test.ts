/**
 * drive-pr: the watch a converged stop runs after its label write
 * (`lib/driver/converged-ci.ts`). The write can start CI on the verified head:
 * a cancellation goes to the cancelled-run recovery, a failure in a run a
 * label write started is re-run once, and anything that stays unsettled parks.
 */
import { describe, expect, it } from "bun:test";
import {
  type CiRead,
  type ConvergedCiDeps,
  watchConvergedCi,
} from "../scripts/lib/driver/converged-ci.ts";
import type { Ownership } from "../scripts/lib/driver/converged-ci.ts";
import type { LiveRecovery } from "../scripts/lib/cancelled-recovery-reads.ts";
import { convergedStopExit } from "../scripts/lib/driver/converged-ci-live.ts";
import { DRIVE_EXIT } from "../scripts/lib/status/terminal-states.ts";
import type { WorkflowRun } from "../scripts/lib/status/workflow-runs.ts";
import { isoFromMs, parseMs } from "../../../shared/time.ts";

const HEAD = "a".repeat(40);
const WRITTEN = parseMs("2026-11-17T10:00:00.000Z");
const iso = isoFromMs;

/** A workflow run on the head, created `after` ms past the label write. */
function workflowRun(
  id: number,
  after: number,
  over: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    workflowId: 7,
    status: "completed",
    conclusion: "failure",
    checkSuiteId: id * 10,
    createdAt: iso(WRITTEN + after),
    startedAt: iso(WRITTEN + after),
    attempt: 1,
    updatedAt: iso(WRITTEN + after + 60_000),
    ...over,
  };
}

const failing = (id: number, conclusion = "failure"): CiRead => ({
  verdict: "failing: tests",
  failingRuns: [
    { id, createdAt: iso(WRITTEN + 2_000), conclusion, jobNames: ["tests"] },
  ],
  failingStatusNames: [],
});
const GREEN: CiRead = {
  verdict: "green",
  failingRuns: [],
  failingStatusNames: [],
};

interface Script {
  ci: Array<CiRead | null>;
  runs?: Array<WorkflowRun[] | null>;
  recovery?: LiveRecovery[];
  head?: string;
  open?: boolean;
  writes?: number[] | null;
  rerunnable?: number[];
  rerunOk?: boolean;
  rerunIndeterminate?: boolean;
  /** Each ownership read in turn, the last repeating; `true` and `false` read ours and lost. */
  owned?: boolean | Ownership[] | { afterMs: number; becomes: Ownership };
}

/** Fake dependencies over a scripted sequence of readings, on a clock the sleeps move. */
function fake(script: Script) {
  let now = WRITTEN;
  const reruns = new Map<string, number>();
  const asked: number[] = [];
  const recovered: string[] = [];
  let ciAt = 0;
  let runsAt = 0;
  let recoveryAt = 0;
  let ownedAt = 0;
  const last = <T>(list: T[], at: number): T =>
    list[Math.min(at, list.length - 1)] as T;
  const deps: ConvergedCiDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    pollMs: 10_000,
    settleMs: 31_000,
    windowMs: 5 * 60_000,
    pullRequest: async () => ({
      open: script.open ?? true,
      head: script.head ?? HEAD,
    }),
    ci: async () => last(script.ci, ciAt++),
    workflowRuns: async () => last(script.runs ?? [[]], runsAt++),
    labelWrites: async () =>
      script.writes === undefined ? [WRITTEN] : script.writes,
    labelReruns: async () => reruns,
    rerunnable: async (_pr, runs) => script.rerunnable ?? runs.map((r) => r.id),
    claimRerun: async (_pr, run) => {
      const key = `${run.id}:${run.attempt}`;
      if (reruns.has(key)) return false;
      reruns.set(key, now);
      return true;
    },
    rerunFailed: async (_pr, _head, run, mayMutate) => {
      if (!(await mayMutate()))
        return {
          ok: false,
          indeterminate: true,
          detail: "the drive no longer owns the pull request",
        };
      asked.push(run);
      if (script.rerunIndeterminate === true)
        return { ok: false, indeterminate: true, detail: "timed out" };
      return script.rerunOk === false
        ? { ok: false, detail: "HTTP 403: the run cannot be re-run" }
        : { ok: true, detail: "" };
    },
    recoverCancelled: async (_pr, head, mayMutate) => {
      if (!(await mayMutate())) return "unknown";
      recovered.push(head);
      return last(script.recovery ?? ["none"], recoveryAt++);
    },
    ...(script.owned === undefined
      ? {}
      : {
          owned: async (): Promise<Ownership> => {
            const o = script.owned;
            if (o === undefined) return "ours";
            if (typeof o === "boolean") return o ? "ours" : "lost";
            if (!Array.isArray(o))
              return now - WRITTEN >= o.afterMs ? o.becomes : "ours";
            return last(o, ownedAt++);
          },
        }),
  };
  return { deps, asked, recovered, clock: () => now };
}

describe("the converged CI watch", () => {
  it("lets the label stand when the head's CI reads green after the write's runs exist", async () => {
    const f = fake({ ci: [GREEN] });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict).toEqual({
      kind: "stands",
      why: `CI on head ${HEAD} reads green`,
    });
    // It read nothing before the label-run window and its rounding second had passed.
    expect(f.clock()).toBe(WRITTEN + 31_000);
  });

  it("waits through pending CI to green", async () => {
    const f = fake({ ci: [{ ...GREEN, verdict: "pending: tests" }, GREEN] });
    expect((await watchConvergedCi("999", HEAD, WRITTEN, f.deps)).kind).toBe(
      "stands",
    );
    expect(f.asked).toEqual([]);
  });

  it("hands a cancellation to the cancelled-run recovery, and stands once its re-run is green", async () => {
    const cancelled: CiRead = {
      verdict: "cancelled: tests",
      failingRuns: [],
      failingStatusNames: [],
    };
    const f = fake({
      ci: [cancelled, cancelled, GREEN],
      recovery: ["wait", "wait"],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.recovered).toEqual([HEAD, HEAD]);
    expect(f.asked).toEqual([]);
  });

  it("keeps watching when a cancelled-run recovery read kept failing", async () => {
    const cancelled: CiRead = {
      verdict: "cancelled: tests",
      failingRuns: [],
      failingStatusNames: [],
    };
    const f = fake({
      ci: [cancelled, GREEN],
      recovery: [
        { read: "workflow runs", class: "server-fault", reason: "HTTP 502" },
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.recovered).toEqual([HEAD]);
  });

  it("parks a job the runner stopped at its time limit as a failure, never re-running it", async () => {
    const cancelled: CiRead = {
      verdict: "cancelled: tests",
      failingRuns: [],
      failingStatusNames: [],
    };
    const f = fake({
      ci: [cancelled, GREEN],
      recovery: [
        {
          timedOut: [
            {
              name: "tests",
              checkRunId: 9,
              limitMs: 30 * 60_000,
              ranMs: 30 * 60_000 + 4_000,
              run: null,
            },
          ],
          recovery: "none",
        },
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict).toMatchObject({ kind: "park", labelCaused: false });
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "job `tests` ran 30m 4s and stopped at its 30-minute limit (timeout-minutes)",
    );
    expect(f.asked).toEqual([]);
  });

  it("ends parked when the cancelled-run recovery parks cancelled-ci", async () => {
    const f = fake({
      ci: [
        {
          verdict: "cancelled: tests",
          failingRuns: [],
          failingStatusNames: [],
        },
      ],
      recovery: ["parked"],
    });
    expect(await watchConvergedCi("999", HEAD, WRITTEN, f.deps)).toEqual({
      kind: "parked",
    });
  });

  it("parks a cancellation the recovery has nothing to re-run for", async () => {
    const f = fake({
      ci: [
        {
          verdict: "cancelled: tests",
          failingRuns: [],
          failingStatusNames: [],
        },
      ],
      recovery: ["none"],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("park");
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "found nothing it may re-run",
    );
  });

  it("re-runs a failure in a run the label write started once, then stands on its green", async () => {
    const f = fake({
      ci: [failing(41), failing(41), GREEN],
      runs: [
        [workflowRun(41, 2_000)],
        [
          workflowRun(41, 2_000, {
            attempt: 2,
            status: "in_progress",
            conclusion: null,
          }),
        ],
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.asked).toEqual([41]);
  });

  it("parks when the one re-run of a label-started run fails again", async () => {
    const f = fake({
      ci: [failing(41), failing(41)],
      runs: [
        [workflowRun(41, 2_000)],
        [workflowRun(41, 2_000, { attempt: 2 })],
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([41]);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      `run 41 on head ${HEAD} failed again on attempt 2`,
    );
  });

  it("parks, without a re-run, a failure in a run no label write started", async () => {
    // Created two minutes after the write: past the window that attributes a run to it.
    const f = fake({ ci: [failing(42)], runs: [[workflowRun(42, 120_000)]] });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([]);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "no label write started it",
    );
  });

  it("parks, without a re-run, a label-started run created under the CI hold", async () => {
    const f = fake({
      ci: [failing(43)],
      runs: [[workflowRun(43, 2_000)]],
      rerunnable: [],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([]);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "may not be re-run",
    );
  });

  it("parks when the forge does not accept the re-run", async () => {
    const f = fake({
      ci: [failing(44)],
      runs: [[workflowRun(44, 2_000)]],
      rerunOk: false,
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind === "park" && verdict.reason).toContain("HTTP 403");
  });

  it("parks a failing commit status, which has no run to re-run", async () => {
    const f = fake({
      ci: [
        {
          verdict: "failing: ci/legacy",
          failingRuns: [],
          failingStatusNames: ["ci/legacy"],
        },
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "commit status ci/legacy failed",
    );
  });

  it("parks when CI is still unsettled at the end of its window", async () => {
    const f = fake({ ci: [{ ...GREEN, verdict: "pending: tests" }] });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "did not settle within 5 minute(s) of the converged label's write; last read: pending: tests",
    );
    expect(f.clock()).toBeLessThanOrEqual(WRITTEN + 5 * 60_000);
  });

  it("waits while the label history does not read, rather than re-running blind", async () => {
    const f = fake({
      ci: [failing(45), GREEN],
      runs: [[workflowRun(45, 2_000)]],
      writes: null,
    });
    expect((await watchConvergedCi("999", HEAD, WRITTEN, f.deps)).kind).toBe(
      "stands",
    );
    expect(f.asked).toEqual([]);
  });

  it("leaves a head that moved, or a pull request no longer open, to the next drive", async () => {
    const moved = fake({ ci: [failing(46)], head: "b".repeat(40) });
    expect(await watchConvergedCi("999", HEAD, WRITTEN, moved.deps)).toEqual({
      kind: "stands",
      why: `the head moved to ${"b".repeat(40)}`,
    });
    const closed = fake({ ci: [failing(46)], open: false });
    expect(
      (await watchConvergedCi("999", HEAD, WRITTEN, closed.deps)).kind,
    ).toBe("stands");
    expect([...moved.asked, ...closed.asked]).toEqual([]);
  });
  it("lets the label stand when the head's CI never read in the window: nothing was seen to fail", async () => {
    const f = fake({ ci: [null] });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(verdict.kind === "stands" && verdict.why).toContain(
      "nothing was seen to fail",
    );
  });

  it("waits, never parks, when a newer attempt of the failing run succeeded", async () => {
    const f = fake({
      ci: [failing(48), GREEN],
      runs: [[workflowRun(48, 2_000, { attempt: 2, conclusion: "success" })]],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.asked).toEqual([]);
  });

  it("parks on a later run no label write started while an earlier run is still going", async () => {
    const f = fake({
      ci: [
        {
          verdict: "failing: tests, lint",
          failingRuns: [
            { id: 50, createdAt: iso(WRITTEN + 2_000), conclusion: "failure" },
            {
              id: 51,
              createdAt: iso(WRITTEN + 120_000),
              conclusion: "failure",
            },
          ],
          failingStatusNames: [],
        },
      ],
      runs: [
        [
          workflowRun(50, 2_000, { status: "in_progress", conclusion: null }),
          workflowRun(51, 120_000),
        ],
      ],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "no label write started it",
    );
    expect(verdict.kind === "park" && verdict.labelCaused).toBe(false);
  });

  it("re-runs an eligible run while another run is still going", async () => {
    const f = fake({
      ci: [
        {
          verdict: "failing: tests, lint",
          failingRuns: [
            { id: 52, createdAt: iso(WRITTEN + 2_000), conclusion: "failure" },
            { id: 53, createdAt: iso(WRITTEN + 2_000), conclusion: "failure" },
          ],
          failingStatusNames: [],
        },
        GREEN,
      ],
      runs: [
        [
          workflowRun(52, 2_000, { status: "in_progress", conclusion: null }),
          workflowRun(53, 2_000),
        ],
      ],
    });
    await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([53]);
  });

  it("watches for the new attempt when the re-run answer is indeterminate", async () => {
    const f = fake({
      ci: [failing(54)],
      runs: [[workflowRun(54, 2_000)]],
      rerunIndeterminate: true,
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([54]);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "shows no new attempt",
    );
  });

  it("parks when a requested re-run shows no new attempt a minute on", async () => {
    // The re-run was accepted, but the run stays on its first attempt.
    const f = fake({
      ci: [failing(47)],
      runs: [[workflowRun(47, 2_000)]],
    });
    const verdict = await watchConvergedCi("999", HEAD, WRITTEN, f.deps);
    expect(f.asked).toEqual([47]);
    expect(verdict.kind === "park" && verdict.reason).toContain(
      "shows no new attempt",
    );
  });
});

describe("the converged CI watch after another clone takes the drive over", () => {
  it("changes no CI once a successor owns the drive", async () => {
    const f = fake({
      ci: [failing(1)],
      runs: [[workflowRun(1, 2_000)]],
      owned: false,
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.asked).toEqual([]);
    expect(f.recovered).toEqual([]);
  });

  it("changes nothing and settles as unverified when the claims never read, even over a readable failure", async () => {
    const f = fake({
      ci: [failing(1)],
      runs: [[workflowRun(1, 2_000)]],
      owned: ["unreadable"],
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("unverified");
    expect(f.asked).toEqual([]);
    expect(f.recovered).toEqual([]);
  });

  it("keeps watching through a transient unreadable answer and then judges the failure", async () => {
    const f = fake({
      ci: [failing(1)],
      runs: [[workflowRun(1, 2_000)]],
      owned: ["unreadable", "ours"],
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).not.toBe("unverified");
    expect(f.asked).toEqual([1]);
  });

  it("records no park for unsettled CI once a successor owns the drive", async () => {
    const f = fake({
      ci: [
        { verdict: "pending: tests", failingRuns: [], failingStatusNames: [] },
      ],
      owned: { afterMs: 4 * 60_000, becomes: "lost" },
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
  });

  it("does not park an unsettled window when ownership cannot be read at the end", async () => {
    const f = fake({
      ci: [
        { verdict: "pending: tests", failingRuns: [], failingStatusNames: [] },
      ],
      owned: { afterMs: 4 * 60_000, becomes: "unreadable" },
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("unverified");
  });

  it("asks again before each re-run claim: a successor that arrived during the reads gets none", async () => {
    const f = fake({
      ci: [failing(1)],
      runs: [[workflowRun(1, 2_000)]],
      owned: ["ours", "lost"],
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).toBe("stands");
    expect(f.asked).toEqual([]);
  });

  it("asks the failed-job re-run's mutation boundary again: a successor that arrived there parks nothing", async () => {
    const f = fake({
      ci: [failing(1)],
      runs: [[workflowRun(1, 2_000)]],
      owned: ["ours", "ours", "lost"],
    });
    const verdict = await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(verdict.kind).not.toBe("park");
    expect(f.asked).toEqual([]);
  });

  it("recovers a cancelled run while the drive is still its own", async () => {
    const f = fake({
      ci: [
        {
          verdict: "cancelled: tests",
          failingRuns: [],
          failingStatusNames: [],
        },
      ],
      recovery: ["none"],
      owned: true,
    });
    await watchConvergedCi("5", HEAD, WRITTEN, f.deps);
    expect(f.recovered).toEqual([HEAD]);
  });
});

describe("the stop a converged label's watch settles", () => {
  const labelled = (converged: boolean, outcome: "written" | "agrees") => ({
    moment: {
      stopped: 3,
      byPerson: false,
      verifiedSha: HEAD,
    },
    converged,
    write:
      outcome === "written"
        ? { outcome, detail: "+jig:converged -jig:driving" }
        : { outcome },
  });

  it("watches only a converged label this stop wrote", async () => {
    let watched = 0;
    const recheck = async () => {
      watched += 1;
      return { kind: "parked" as const };
    };
    expect(
      await convergedStopExit(
        "999",
        labelled(false, "written"),
        WRITTEN,
        recheck,
      ),
    ).toBeNull();
    expect(
      await convergedStopExit(
        "999",
        labelled(true, "agrees"),
        WRITTEN,
        recheck,
      ),
    ).toBeNull();
    expect(await convergedStopExit("999", null, WRITTEN, recheck)).toBeNull();
    expect(watched).toBe(0);
  });

  it("keeps the stop when the label stands, parks on the recovery's park, and is INDETERMINATE when the watch fails", async () => {
    const write = labelled(true, "written");
    expect(
      await convergedStopExit("999", write, WRITTEN, async () => ({
        kind: "unverified",
        why: "the claims did not read",
      })),
    ).toBe(DRIVE_EXIT.INDETERMINATE);
    expect(
      await convergedStopExit("999", write, WRITTEN, async () => ({
        kind: "stands",
        why: "green",
      })),
    ).toBeNull();
    expect(
      await convergedStopExit("999", write, WRITTEN, async () => ({
        kind: "parked",
      })),
    ).toBe(DRIVE_EXIT.HITL_PARKED);
    expect(
      await convergedStopExit("999", write, WRITTEN, async () => {
        throw new Error("the store did not open");
      }),
    ).toBe(DRIVE_EXIT.INDETERMINATE);
  });
});
