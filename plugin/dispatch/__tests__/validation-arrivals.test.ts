import { describe, expect, test } from "bun:test";
import { arrivalQueue } from "../lib/validation-arrivals.ts";
import {
  forecastValidation,
  measureValidation,
  validationDemand,
  type ValidationMeasurements,
  type ValidationPass,
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
      candidate: true,
    });
    // Its first run is served by minute 10; its second holds one slot until
    // minute 20 and leaves the other free for the candidate at once.
    expect(queue).toEqual({ acquireMs: 15 * MINUTE, ahead: 1, served: 1 });
  });

  test("queues a run asking after the candidate behind it", () => {
    const queue = arrivalQueue({
      concurrency: 1,
      runMs: 10 * MINUTE,
      atLock: 0,
      arrivals: [{ atMs: 20 * MINUTE, runs: 1 }],
      unknownRuns: 0,
      arriveMs: 15 * MINUTE,
      candidate: true,
    });
    expect(queue).toEqual({ acquireMs: 15 * MINUTE, ahead: 0, served: 0 });
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
    // launched over the last 80 minutes, so most reach the lock, and leave
    // it, well before a drive launched now arrives.
    const figures = measured(4 * MINUTE, 2, 25 * MINUTE, HOUR);
    const inFlight = [
      ...[2, 6, 9, 13, 17, 21, 24, 28, 32, 40].map((ago, i) =>
        pass("pickup", ago, `pickup-${i}`),
      ),
      ...[15, 22, 30, 38, 45, 52, 61, 75].map((ago, i) =>
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
    const early = pass("pickup", 60, "early");
    const estimated = validationDemand(figures, [], [early], [], NOW);
    expect(
      forecastValidation(figures, "pickup", estimated, HOUR, 3 * HOUR),
    ).toMatchObject({ ahead: 0, served: 1, required: 0 });
    // A launch that does not read gives no estimate.
    const unread = { ...early, launchedAtMs: Number.NaN };
    const noLaunch = validationDemand(figures, [], [unread], [], NOW);
    expect(noLaunch.arrivals).toEqual([]);
    expect(
      forecastValidation(figures, "pickup", noLaunch, HOUR, 3 * HOUR),
    ).toMatchObject({ ahead: 1, served: 0, required: 1 });
    // Neither does a kind with no measured time to validation.
    const unmeasured = { ...figures, defaults: ["pickup time to validation"] };
    const noHistory = validationDemand(unmeasured, [], [early], [], NOW);
    expect(noHistory.arrivals).toEqual([]);
    expect(
      forecastValidation(unmeasured, "pickup", noHistory, HOUR, 3 * HOUR),
    ).toMatchObject({ ahead: 1, served: 0 });
  });

  test("the November 14 replay still holds pickups with the arrival model on", () => {
    // The replay in validation-capacity.test.ts, with launch times and
    // measured times to validation, so every pass has an estimate.
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
      "8 runs ahead (7 in flight served before it reaches the lock), about 16 min",
    );
  });
});
