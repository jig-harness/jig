import { describe, expect, test } from "bun:test";
import { arrivalQueue } from "../lib/validation-arrivals.ts";
import {
  forecastValidation,
  measureValidation,
  validationDemand,
  type ValidationDemand,
  type ValidationMeasurements,
  type ValidationPass,
  type ValidationSample,
} from "../lib/validation-capacity.ts";
import {
  passLockWait,
  validationGauge,
  validationHold,
  type ValidationLoad,
} from "../lib/validation-load.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-20T13:22:00Z");

function pass(
  kind: ValidationPass["kind"],
  minutesAgo: number,
  workspace: string,
): ValidationPass {
  return {
    kind,
    workspace,
    repo: "example/jig",
    launchedAtMs: NOW - minutesAgo * MINUTE,
  };
}

function sample(
  requestedAtMs: number,
  waitMs: number,
  holdMs: number,
  workspace: string,
): ValidationSample {
  return { requestedAtMs, waitMs, holdMs, workspace };
}

/** Measured figures: no estimate is a default. */
function measured(
  runMs: number,
  concurrency: number,
  pickupMs: number,
  driveMs: number,
): ValidationMeasurements {
  return {
    runMs,
    concurrency,
    kinds: {
      pickup: { runsPerPass: 1, timeToValidationMs: pickupMs },
      drive: { runsPerPass: 1, timeToValidationMs: driveMs },
    },
    defaults: [],
  };
}

describe("the lock's queue when a pass arrives", () => {
  test("serves a pass's runs one after another, not on two slots at once", () => {
    const queue = arrivalQueue({
      concurrency: 2,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: [{ atMs: 0, runs: 3 }],
      unknownRuns: 0,
      arriveMs: 15 * MINUTE,
      candidateRuns: 1,
    });
    // Its first run is served by minute 10; its second holds one slot until
    // minute 20 and leaves the other free for the candidate at once.
    expect(queue).toEqual({
      waitMs: 0,
      lastStartMs: 15 * MINUTE,
      ahead: 1,
      served: 1,
      later: 0,
    });
  });

  test("queues a run asking after the candidate's first run behind it", () => {
    const queue = arrivalQueue({
      concurrency: 1,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: [{ atMs: 20 * MINUTE, runs: 1 }],
      unknownRuns: 0,
      arriveMs: 15 * MINUTE,
      candidateRuns: 1,
    });
    expect(queue).toEqual({
      waitMs: 0,
      lastStartMs: 15 * MINUTE,
      ahead: 0,
      served: 0,
      later: 0,
    });
  });

  test("puts a run arriving between the candidate's runs ahead of its next one", () => {
    const queue = arrivalQueue({
      concurrency: 1,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: [{ atMs: 20 * MINUTE, runs: 1 }],
      unknownRuns: 0,
      arriveMs: 15 * MINUTE,
      candidateRuns: 2,
    });
    // The candidate holds minutes 15 to 25; the run arriving at minute 20
    // takes the slot next, so the candidate's second run waits 10 minutes
    // and starts at minute 35.
    expect(queue).toEqual({
      waitMs: 10 * MINUTE,
      lastStartMs: 35 * MINUTE,
      ahead: 0,
      served: 0,
      later: 1,
    });
  });

  test("counts later arrivals that jointly occupy the slots", () => {
    const queue = arrivalQueue({
      concurrency: 2,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: [
        { atMs: 5 * MINUTE, runs: 1 },
        { atMs: 6 * MINUTE, runs: 1 },
      ],
      unknownRuns: 0,
      arriveMs: 0,
      candidateRuns: 2,
    });
    // The candidate's second run starts at minute 15; without either arrival
    // it starts at minute 10, so both count.
    expect(queue.lastStartMs).toBe(15 * MINUTE);
    expect(queue.later).toBe(2);
  });

  test("counts each of several arrivals that jointly block a wait", () => {
    const queue = arrivalQueue({
      concurrency: 3,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: Array.from({ length: 4 }, () => ({
        atMs: 5 * MINUTE,
        runs: 1,
      })),
      unknownRuns: 0,
      arriveMs: 0,
      candidateRuns: 2,
    });
    expect(queue.lastStartMs).toBe(15 * MINUTE);
    expect(queue.later).toBeGreaterThan(0);
  });

  test("forecasts a large queue in one bounded pass", () => {
    const started = performance.now();
    arrivalQueue({
      concurrency: 2,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: Array.from({ length: 40 }, () => ({ atMs: MINUTE, runs: 40 })),
      unknownRuns: 0,
      arriveMs: 0,
      candidateRuns: 40,
    });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("the validation forecast's arrival model", () => {
  test("the November 20 replay admits the pickups held to keep room for a drive", () => {
    // The figures of the 13:22 UTC tick of 2026-11-20 as the gauge reported
    // them: a capacity of about 30 runs for a pickup and half that for a
    // drive, about 18 runs in flight, the lock idle and the host at about 0.5
    // load per core, while seven pickups were held to keep room for a drive.
    // Runs of 4 minutes, two at once, 25 minutes from launch to validation
    // for a pickup and an hour for a drive. The passes in flight were
    // launched over the last hour and have yet to reach the lock: they reach
    // it, and leave it, before a drive launched now arrives. This replay
    // checks compatibility with the earlier forecast; the direct queue tests
    // above are the ones that fail when arrival estimates or later-run
    // simulation are switched off.
    const figures = measured(4 * MINUTE, 2, 25 * MINUTE, HOUR);
    const inFlight = [
      ...[1, 3, 5, 8, 11, 14, 17, 20, 22, 24].map((ago, i) =>
        pass("pickup", ago, `pickup-${i}`),
      ),
      ...[12, 20, 28, 35, 42, 48, 53, 58].map((ago, i) =>
        pass("drive", ago, `drive-${i}`),
      ),
    ];
    const load = (nowMs?: number): ValidationLoad => ({
      measured: figures,
      demand: validationDemand(figures, [], inFlight, [], nowMs),
      ...passLockWait({}),
      driveDeadlineMs: 90 * MINUTE,
      admittedRuns: 0,
    });
    const admitHeld = (state: ValidationLoad) => {
      let admitted = 0;
      for (let pickup = 0; pickup < 7; pickup++) {
        const hold = validationHold(
          { ...state, admittedRuns: admitted },
          1,
          "pickup",
          3 * HOUR,
          "example/jig",
        );
        if (hold === null) admitted++;
        else expect(hold).toContain("keep room for a drive");
      }
      return admitted;
    };
    const conservative = load();
    expect(conservative.demand).toMatchObject({ atLock: 0, toArrive: 18 });
    expect(
      forecastValidation(
        figures,
        "pickup",
        { atLock: 0, toArrive: 18 },
        HOUR,
        3 * HOUR,
      ).capacity,
    ).toBe(30);
    expect(admitHeld(conservative)).toBe(0);
    expect(admitHeld(load(NOW))).toBe(7);
  });

  test("passes launched in the same tick queue behind each other", () => {
    // Fifteen pickups launched together 15 minutes ago all reach the lock in
    // 5 minutes. One at a time, runs of 2 minutes: by the time a new pickup
    // arrives, at minute 20, seven have been served and eight still hold or
    // wait, though each alone would have finished at minute 7.
    const figures = measured(2 * MINUTE, 1, 20 * MINUTE, HOUR);
    const together = Array.from({ length: 15 }, (_, i) =>
      pass("pickup", 15, `same-tick-${i}`),
    );
    const demand = validationDemand(figures, [], together, [], NOW);
    const forecast = forecastValidation(
      figures,
      "pickup",
      demand,
      HOUR,
      3 * HOUR,
    );
    expect(forecast.served).toBe(7);
    expect(forecast.ahead).toBe(8);
    // The candidate's first run waits until minute 35: 7.5 runs of service.
    expect(forecast.required).toBe(7.5);
    // Passes this tick admits reach validation with the candidate: ahead too.
    const admitted = forecastValidation(
      figures,
      "pickup",
      demand,
      HOUR,
      3 * HOUR,
      3,
    );
    expect(admitted.ahead).toBe(11);
    expect(admitted.served).toBe(7);
  });

  test("counts a run with no arrival estimate ahead", () => {
    const figures = measured(5 * MINUTE, 1, 30 * MINUTE, 30 * MINUTE);
    const forecast = (demand: ValidationDemand, of = figures) =>
      forecastValidation(of, "pickup", demand, HOUR, 3 * HOUR);
    // Due at minute 5, served by minute 10, before the candidate at 30.
    const due = pass("pickup", 25, "due");
    const estimated = validationDemand(figures, [], [due], [], NOW);
    expect(estimated.arrivals).toEqual([{ atMs: 5 * MINUTE, runs: 1 }]);
    expect(forecast(estimated)).toMatchObject({
      ahead: 0,
      served: 1,
      required: 0,
    });
    const unseen = (demand: ValidationDemand, of = figures) => {
      expect(demand.arrivals).toEqual([]);
      expect(forecast(demand, of)).toMatchObject({ ahead: 1, served: 0 });
    };
    // A launch that does not read.
    const unread = { ...due, launchedAtMs: Number.NaN };
    unseen(validationDemand(figures, [], [unread], [], NOW));
    // A kind with no measured time to validation.
    const unmeasured = { ...figures, defaults: ["pickup time to validation"] };
    unseen(validationDemand(unmeasured, [], [due], [], NOW), unmeasured);
    // A pass past its kind's time to validation without a run.
    unseen(
      validationDemand(figures, [], [pass("pickup", 45, "late")], [], NOW),
    );
    // A pass between its runs: nothing measures the gap.
    const twice = {
      ...figures,
      kinds: {
        ...figures.kinds,
        pickup: { runsPerPass: 2, timeToValidationMs: 30 * MINUTE },
      },
    };
    const between = pass("pickup", 25, "between");
    const madeOne = [sample(NOW - 2 * MINUTE, 0, MINUTE, "between")];
    unseen(validationDemand(twice, [], [between], madeOne, NOW), twice);
  });

  test("holds a pass whose later run waits behind passes arriving after its first", () => {
    // One run at a time, runs of 10 minutes. A pickup of three runs reaches
    // the lock at minute 25; eight drives reach it at minute 30, while its
    // first run holds the lock, so its second run waits 80 minutes, past
    // its hour.
    const figures: ValidationMeasurements = {
      ...measured(10 * MINUTE, 1, 25 * MINUTE, HOUR),
      kinds: {
        pickup: { runsPerPass: 3, timeToValidationMs: 25 * MINUTE },
        drive: { runsPerPass: 1, timeToValidationMs: HOUR },
      },
    };
    const drives = Array.from({ length: 8 }, (_, i) =>
      pass("drive", 30, `drive-${i}`),
    );
    const demand = validationDemand(figures, [], drives, [], NOW);
    const forecast = forecastValidation(
      figures,
      "pickup",
      demand,
      HOUR,
      3 * HOUR,
    );
    expect(forecast.ahead).toBe(0);
    expect(forecast.required).toBe(8);
    expect(forecast.fill).toBeGreaterThan(1);
  });

  test("holds a relaunch arriving at once when its later runs meet arrivals", () => {
    // A drive relaunched to push reaches the lock now; nine pickups reach it
    // in 5 minutes, during the drive's first run.
    const figures: ValidationMeasurements = {
      ...measured(10 * MINUTE, 1, 30 * MINUTE, 30 * MINUTE),
      kinds: {
        pickup: { runsPerPass: 1, timeToValidationMs: 30 * MINUTE },
        drive: { runsPerPass: 3, timeToValidationMs: 30 * MINUTE },
      },
    };
    const pickups = Array.from({ length: 9 }, (_, i) =>
      pass("pickup", 25, `pickup-${i}`),
    );
    const state: ValidationLoad = {
      measured: figures,
      demand: validationDemand(figures, [], pickups, [], NOW),
      ...passLockWait({}),
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(
      validationHold(state, 1, "drive", 3 * HOUR, "example/jig", true),
    ).toStartWith(
      "waits on validation capacity: 0 runs ahead, and 9 arriving after its first run ahead of a later one, about 90 min",
    );
  });

  test("the November 14 replay still holds pickups with the arrival model on", () => {
    // The replay in validation-capacity.test.ts, with launch times and
    // measured times to validation. Every open pass in those receipts holds
    // or waits for a run at the lock, so it has none left to arrive: the
    // arrival model credits only what the lock serves before the pickup.
    const replay = [
      { holding: 4, waiting: 4, pickups: 3, drives: 1, launches: 4 },
      { holding: 5, waiting: 13, pickups: 7, drives: 3, launches: 6 },
    ];
    const cold = measureValidation([], []);
    const figures = { ...cold, defaults: [] };
    let held = 0;
    for (const tick of replay) {
      const passes = Array.from(
        { length: tick.pickups + tick.drives },
        (_, i) =>
          pass(i < tick.pickups ? "pickup" : "drive", 10 * i, String(i)),
      );
      const lockRuns = Array.from(
        { length: tick.holding + tick.waiting },
        (_, i) => ({ workspace: passes[i]?.workspace ?? null }),
      );
      const demand = validationDemand(figures, lockRuns, passes, [], NOW);
      let admitted = 0;
      for (let i = 0; i < tick.launches; i++) {
        const forecast = forecastValidation(
          figures,
          "pickup",
          demand,
          HOUR,
          3 * HOUR,
          admitted,
        );
        if (forecast.fill !== null && forecast.fill <= 1)
          admitted += forecast.ownRuns;
        else held++;
      }
    }
    expect(held).toBeGreaterThanOrEqual(6);
  });

  test("the gauge names the runs served before arrival beside the runs ahead", () => {
    const figures = measured(2 * MINUTE, 1, 20 * MINUTE, HOUR);
    const together = Array.from({ length: 15 }, (_, i) =>
      pass("pickup", 15, `same-tick-${i}`),
    );
    const state: ValidationLoad = {
      measured: figures,
      demand: validationDemand(figures, [], together, [], NOW),
      ...passLockWait({}),
      driveDeadlineMs: 90 * MINUTE,
      admittedRuns: 0,
    };
    expect(validationGauge(state, 1).reads).toStartWith(
      "8 runs ahead (7 in flight served before it reaches the lock), about 15 min",
    );
  });
});
