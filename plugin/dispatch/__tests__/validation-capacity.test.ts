import { describe, expect, test } from "bun:test";
import {
  forecastValidation,
  measureValidation,
  validationDemand,
  type ValidationPass,
  type ValidationSample,
} from "../lib/validation-capacity.ts";
import { validationHold, type ValidationLoad } from "../lib/validation-load.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function sample(
  requestedAtMs: number,
  waitMs: number,
  holdMs: number,
  workspace: string | null = null,
): ValidationSample {
  return { requestedAtMs, waitMs, holdMs, workspace };
}

function pickup(workspace: string, launchedAtMs = 0): ValidationPass {
  return { workspace, launchedAtMs, kind: "pickup" };
}

describe("validation estimates", () => {
  test("uses positive, named defaults before the lock has samples", () => {
    const measured = measureValidation([], []);
    expect(measured.runMs).toBe(15 * MINUTE);
    expect(measured.concurrency).toBe(1);
    expect(measured.kinds).toEqual({
      pickup: { runsPerPass: 1, timeToValidationMs: HOUR },
      drive: { runsPerPass: 1, timeToValidationMs: HOUR },
    });
    expect(measured.defaults).toEqual([
      "run time",
      "runs at once",
      "pickup runs per pass",
      "pickup time to validation",
      "drive runs per pass",
      "drive time to validation",
    ]);
  });

  test("uses peak overlap without waiters and median overlap under contention", () => {
    const uncontended = [sample(0, 0, 50), sample(0, 0, 50), sample(0, 0, 50)];
    expect(measureValidation(uncontended, []).concurrency).toBe(3);
    const contested = [sample(100, 0, 20), sample(100, 20, 10)];
    const measured = measureValidation([...uncontended, ...contested], []);
    expect(measured.concurrency).toBe(1);
    expect(measured.runMs).toBe(50);
    expect(measured.defaults).not.toContain("run time");
    expect(measured.defaults).not.toContain("runs at once");
  });

  test("averages the two holder counts when the midpoint separates equal wait periods", () => {
    const samples = [sample(0, 0, 20), sample(0, 0, 10), sample(0, 20, 10)];
    expect(measureValidation(samples, []).concurrency).toBe(1.5);
  });

  test("matches reused workspaces within each pass lifetime", () => {
    const passes: ValidationPass[] = [
      { ...pickup("reused"), endedAtMs: 100 },
      { ...pickup("reused", 200), endedAtMs: 300 },
      { ...pickup("reused", 400), kind: "drive", endedAtMs: 500 },
      pickup("active", 600),
    ];
    const samples = [
      sample(10, 0, 10, "reused"),
      sample(40, 0, 10, "reused"),
      sample(150, 0, 10, "reused"), // Between passes.
      sample(230, 0, 10, "reused"),
      sample(460, 0, 10, "reused"),
      sample(620, 0, 10, "active"),
    ];
    const measured = measureValidation(samples, passes);
    expect(measured.kinds.pickup).toEqual({
      runsPerPass: 1.5,
      timeToValidationMs: 20,
    });
    expect(measured.kinds.drive).toEqual({
      runsPerPass: 1,
      timeToValidationMs: 60,
    });
  });
});

describe("validation forecast", () => {
  test("counts active work once and credits early service only to runs already at the lock", () => {
    const measured = measureValidation([], []);
    const passes = [
      pickup("queued"),
      pickup("released"),
      pickup("implementing"),
    ];
    const lockRuns = [{ workspace: "queued" }, { workspace: null }];
    const completed = [sample(90, 0, MINUTE, "released")];
    const forecast = forecastValidation(
      measured,
      "pickup",
      validationDemand(measured, lockRuns, passes, completed),
      HOUR,
      3 * HOUR,
      1,
    );
    expect(forecast).toEqual({
      ahead: 2,
      capacity: 4,
      ownRuns: 1,
      required: 2,
      atLock: 2,
      toArrive: 2,
      waitWindowMs: HOUR,
      fill: 0.5,
    });
  });

  test("bounds the wait by the remaining pass deadline and represents no wait window", () => {
    const measured = measureValidation([], []);
    const forecast = (deadline: number) =>
      forecastValidation(
        measured,
        "drive",
        { atLock: 0, toArrive: 0 },
        HOUR,
        deadline,
      );
    expect(forecast(90 * MINUTE).waitWindowMs).toBe(30 * MINUTE);
    // The wait window governs acquisition, not how long this new run may
    // execute after it acquires an idle lock.
    expect(forecast(90 * MINUTE).fill).toBe(0);
    expect(forecast(HOUR).waitWindowMs).toBe(0);
    expect(forecast(HOUR).fill).toBeNull();
  });

  test("charges only candidate runs that cannot acquire an idle slot immediately", () => {
    const measured = measureValidation([], []);
    const forecast = forecastValidation(
      {
        ...measured,
        concurrency: 1,
        kinds: {
          ...measured.kinds,
          pickup: { runsPerPass: 2, timeToValidationMs: HOUR },
        },
      },
      "pickup",
      { atLock: 0, toArrive: 0 },
      HOUR,
      3 * HOUR,
    );
    expect(forecast.required).toBe(1);
    expect(forecast.fill).toBe(0.25);
  });

  test("credits a lock slot predicted to be free when the candidate arrives", () => {
    const measured = measureValidation([], []);
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 1, toArrive: 0 },
      MINUTE,
      3 * HOUR,
    );
    expect(forecast.ahead).toBe(0);
    expect(forecast.required).toBe(0);
  });

  test("does not charge a candidate's execution after its last acquisition", () => {
    const measured = measureValidation([], []);
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 0, toArrive: 1 },
      20 * MINUTE,
      3 * HOUR,
    );
    expect(forecast.required).toBe(1);
    expect(forecast.fill).toBe(0.75);
  });

  test("models acquisition at whole service-wave boundaries", () => {
    const measured = {
      ...measureValidation([], []),
      concurrency: 2,
      kinds: {
        pickup: { runsPerPass: 1, timeToValidationMs: 0 },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 2, toArrive: 0 },
      10 * MINUTE,
      HOUR,
    );
    expect(forecast.required).toBe(2);
    expect(forecast.fill).toBe(1.5);
  });

  test("does not credit a partial service wave before its slots release", () => {
    const measured = {
      ...measureValidation([], []),
      concurrency: 2,
      kinds: {
        pickup: { runsPerPass: 1, timeToValidationMs: 10 * MINUTE },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 2, toArrive: 0 },
      MINUTE,
      HOUR,
    );
    expect(forecast.ahead).toBeCloseTo(2 / 3);
    expect(forecast.required).toBeCloseTo(2 / 3);
    expect(forecast.fill).toBeCloseTo(5);
  });

  test("preserves different release times for occupied and newly filled slots", () => {
    const measured = {
      ...measureValidation([], []),
      concurrency: 2,
      kinds: {
        pickup: { runsPerPass: 1, timeToValidationMs: 10 * MINUTE },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 1, toArrive: 2 },
      10 * MINUTE,
      HOUR,
    );
    // One predecessor uses the idle slot until minute 25, so the candidate
    // cannot acquire at the occupied holder's release at minute 15.
    expect(forecast.required).toBe(2);
    expect(forecast.fill).toBe(1.5);
  });

  test("reserves an immediately admitted pickup before admitting its drive", () => {
    const state: ValidationLoad = {
      measured: {
        runMs: 15 * MINUTE,
        concurrency: 1,
        kinds: {
          pickup: { runsPerPass: 1, timeToValidationMs: 0 },
          drive: { runsPerPass: 1, timeToValidationMs: 0 },
        },
        defaults: [],
      },
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: HOUR,
      driveDeadlineMs: HOUR,
      admittedRuns: 0,
    };
    expect(validationHold(state, 0.2, "pickup", HOUR)).toContain(
      "keep room for a drive",
    );
  });

  test("does not reserve a completed pickup against a downstream drive", () => {
    const state: ValidationLoad = {
      measured: measureValidation([], []),
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: MINUTE,
      driveDeadlineMs: 90 * MINUTE,
      admittedRuns: 0,
    };
    expect(validationHold(state, 1, "pickup", 3 * HOUR)).toBeNull();
  });

  test("reserves a pickup behind work already forecast before a drive", () => {
    const state: ValidationLoad = {
      measured: {
        runMs: 15 * MINUTE,
        concurrency: 1,
        kinds: {
          pickup: { runsPerPass: 1, timeToValidationMs: 45 * MINUTE },
          drive: { runsPerPass: 1, timeToValidationMs: 0 },
        },
        defaults: [],
      },
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: HOUR,
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(validationHold(state, 0.3, "pickup", 90 * MINUTE)).toContain(
      "keep room for a drive",
    );
  });

  test("bounds a drive reserve by the pickup wait window", () => {
    const state: ValidationLoad = {
      measured: {
        runMs: 15 * MINUTE,
        concurrency: 1,
        kinds: {
          pickup: { runsPerPass: 1, timeToValidationMs: HOUR },
          drive: { runsPerPass: 3, timeToValidationMs: 0 },
        },
        defaults: [],
      },
      demand: { atLock: 0, toArrive: 1 },
      waitLimitMs: HOUR,
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(validationHold(state, 1, "pickup", 90 * MINUTE)).toContain(
      "keep room for a drive",
    );
  });

  test("counts every active run attributed to a pass before forecasting arrivals", () => {
    const measured = measureValidation([], []);
    const demand = validationDemand(
      measured,
      [{ workspace: "busy" }, { workspace: "busy" }],
      [pickup("busy")],
      [],
    );
    expect(demand).toEqual({ atLock: 2, toArrive: 0 });
  });

  test("the November 14 receipt and launch replay holds pickups before the deadline wave", () => {
    // From the 17:29:52 and 18:24:47 UTC tick receipts and the launch
    // records open at each observation. The original receipts lack lock
    // workspace attribution and release samples, so give every open pass
    // the benefit of matching a current lock run and use the cold defaults.
    // The first three-hour pickup exit in this wave was at 19:32:58 UTC.
    const replay = [
      {
        minute: 17 * 60 + 29,
        holding: 4,
        waiting: 4,
        openPickups: 3,
        openDrives: 1,
        launches: 4,
      },
      {
        minute: 18 * 60 + 24,
        holding: 5,
        waiting: 13,
        openPickups: 7,
        openDrives: 3,
        launches: 6,
      },
    ];
    const firstDeadline = 19 * 60 + 32;
    const measured = measureValidation([], []);
    let heldBeforeDeadline = 0;
    for (const tick of replay) {
      const passes: ValidationPass[] = Array.from(
        { length: tick.openPickups + tick.openDrives },
        (_, i) => ({
          ...pickup(String(i)),
          kind: i < tick.openPickups ? "pickup" : "drive",
        }),
      );
      const lockRuns = Array.from(
        { length: tick.holding + tick.waiting },
        (_, i) => ({ workspace: passes[i]?.workspace ?? null }),
      );
      const demand = validationDemand(measured, lockRuns, passes, []);
      let admitted = 0;
      for (let i = 0; i < tick.launches; i++) {
        const forecast = forecastValidation(
          measured,
          "pickup",
          demand,
          HOUR,
          3 * HOUR,
          admitted,
        );
        if (forecast.fill !== null && forecast.fill <= 1)
          admitted += forecast.ownRuns;
        else if (tick.minute < firstDeadline) heldBeforeDeadline++;
      }
    }
    expect(heldBeforeDeadline).toBeGreaterThanOrEqual(6);
  });
});
