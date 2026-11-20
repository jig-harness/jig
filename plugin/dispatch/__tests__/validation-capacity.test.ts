import { describe, expect, test } from "bun:test";
import {
  forecastValidation,
  measureValidation,
  validationDemand,
  type ValidationPass,
  type ValidationSample,
} from "../lib/validation-capacity.ts";
import {
  PASS_LOCK_WAIT_SECONDS,
  passLockWait,
  validationGauge,
  validationHold,
  type ValidationLoad,
} from "../lib/validation-load.ts";

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

  test("does not count a pass's own sequential runs as lock waits for each other", () => {
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
    expect(forecast.ownRuns).toBe(2);
    expect(forecast.required).toBe(0);
    expect(forecast.fill).toBe(0);
  });

  test("keeps the fill under the line on an idle lock for any runs per pass", () => {
    const base = measureValidation([], []);
    for (const concurrency of [1, 1.5, 2, 4])
      for (const runsPerPass of [1, 1.5, 2, 10, 40, 1000]) {
        const measured = {
          ...base,
          runMs: 2 * MINUTE,
          concurrency,
          kinds: {
            pickup: { runsPerPass, timeToValidationMs: 0 },
            drive: { runsPerPass, timeToValidationMs: 0 },
          },
        };
        // A window shorter than one run, or none, still admits a pass to an
        // idle lock.
        for (const wait of [0, MINUTE, HOUR]) {
          const forecast = forecastValidation(
            measured,
            "pickup",
            { atLock: 0, toArrive: 0 },
            wait,
            3 * HOUR,
          );
          expect(forecast.fill).toBe(0);
        }
      }
  });

  test("the 10:30 figures admit a pickup behind three runs still to arrive", () => {
    // One run at a time, runs of 2 minutes, about ten runs per pass, and
    // three runs still to arrive from passes in flight, nothing at the lock.
    const measured = {
      ...measureValidation([], []),
      runMs: 2 * MINUTE,
      concurrency: 1,
      kinds: {
        pickup: { runsPerPass: 10, timeToValidationMs: HOUR },
        drive: { runsPerPass: 10, timeToValidationMs: HOUR },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 0, toArrive: 3 },
      HOUR,
      3 * HOUR,
    );
    // The three runs ahead are still counted ahead: the first own run waits
    // 6 minutes, 3 runs of the 30 an hour holds.
    expect(forecast.ahead).toBe(3);
    expect(forecast.required).toBe(3);
    expect(forecast.fill).toBe(0.1);
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

  test("keeps queued lock runs ahead of a later candidate", () => {
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
      { atLock: 4, toArrive: 0 },
      16 * MINUTE,
      HOUR,
    );
    // The queued runs take both slots when the two holders release, so the
    // candidate cannot acquire until their wave finishes at minute 20.
    expect(forecast.required).toBeCloseTo(8 / 3);
    expect(forecast.fill).toBeGreaterThan(1);
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
      waitSource: "LOCK_TIMEOUT",
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
      waitSource: "LOCK_TIMEOUT",
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
      demand: { atLock: 1, toArrive: 0 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 1,
    };
    expect(validationHold(state, 0.5, "pickup", 90 * MINUTE)).toContain(
      "keep room for a drive",
    );
  });

  test("does not credit admitted runs with service before they reach the lock", () => {
    const state: ValidationLoad = {
      measured: {
        runMs: 15 * MINUTE,
        concurrency: 1,
        kinds: {
          pickup: { runsPerPass: 1, timeToValidationMs: HOUR },
          drive: { runsPerPass: 1, timeToValidationMs: HOUR },
        },
        defaults: [],
      },
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 4,
    };
    expect(validationHold(state, 1, "pickup", 3 * HOUR)).toContain(
      "keep room for a drive",
    );
  });

  test("keeps a fractional concurrency estimate out of the slot simulation", () => {
    const measured = {
      ...measureValidation([], []),
      concurrency: 1.5,
      kinds: {
        pickup: { runsPerPass: 1.5, timeToValidationMs: 0 },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 0, toArrive: 0 },
      MINUTE,
      HOUR,
    );
    expect(forecast.required).toBe(0);
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
      demand: { atLock: 0, toArrive: 2 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    // The pickup fits its 30-minute window (two runs ahead of its first),
    // and the drive fits its own hour; only the reserve, behind the
    // pickup's run too, overflows the pickup's window.
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

describe("the wait window a pass's validation has", () => {
  const tenRunPasses = {
    runMs: 2 * MINUTE,
    concurrency: 1,
    kinds: {
      pickup: { runsPerPass: 10, timeToValidationMs: HOUR },
      drive: { runsPerPass: 10, timeToValidationMs: HOUR },
    },
    defaults: [],
  };

  test("takes LOCK_TIMEOUT from the environment passes inherit, else the test stage's hour", () => {
    expect(passLockWait({ LOCK_TIMEOUT: "900" })).toEqual({
      waitLimitMs: 15 * MINUTE,
      waitSource: "LOCK_TIMEOUT",
    });
    expect(passLockWait({})).toEqual({
      waitLimitMs: PASS_LOCK_WAIT_SECONDS * 1000,
      waitSource: "default: the test stage's hour, LOCK_TIMEOUT unset",
    });
    expect(passLockWait({ LOCK_TIMEOUT: "" }).waitLimitMs).toBe(HOUR);
    const refused = passLockWait({ LOCK_TIMEOUT: "soon" });
    expect(refused.waitLimitMs).toBe(0);
    expect(refused.waitInvalid).toContain("LOCK_TIMEOUT=soon");
    expect(passLockWait({ LOCK_TIMEOUT: "604801" }).waitInvalid).toBeDefined();
  });

  test("holds a pass on a LOCK_TIMEOUT the lock refuses, and on later runs past the pass deadline", () => {
    const state: ValidationLoad = {
      measured: tenRunPasses,
      demand: { atLock: 0, toArrive: 0 },
      ...passLockWait({ LOCK_TIMEOUT: "-1" }),
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(validationHold(state, 1, "pickup", 3 * HOUR)).toContain(
      "LOCK_TIMEOUT=-1",
    );
    // The refusal does not wait for an occupancy reading, and the gauge's
    // fill shows it.
    const unread = { ...state, demand: { unread: "lock unreadable" } };
    expect(validationHold(unread, 1, "pickup", 3 * HOUR)).toContain(
      "LOCK_TIMEOUT=-1",
    );
    expect(validationGauge(state, 0.5).fill).toBe(1);
    const base = measureValidation([], []);
    const measured = {
      ...base,
      runMs: 2 * MINUTE,
      concurrency: 1,
      kinds: {
        pickup: { runsPerPass: 10, timeToValidationMs: 60 * MINUTE },
        drive: { runsPerPass: 10, timeToValidationMs: 60 * MINUTE },
      },
    };
    const forecast = forecastValidation(
      measured,
      "pickup",
      { atLock: 0, toArrive: 3 },
      HOUR,
      61 * MINUTE + 10 * MINUTE,
    );
    expect(forecast.fill).toBeNull();
  });

  test("admits a pickup on an idle lock without LOCK_TIMEOUT in the dispatcher's environment", () => {
    const state: ValidationLoad = {
      measured: tenRunPasses,
      demand: { atLock: 0, toArrive: 0 },
      ...passLockWait({}),
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(state.waitLimitMs).toBe(HOUR);
    expect(validationHold(state, 1, "pickup", 3 * HOUR)).toBeNull();
    expect(validationGauge(state, 1).fill).toBe(0);
  });

  test("the reason names the wait window and its source", () => {
    const state: ValidationLoad = {
      measured: tenRunPasses,
      demand: { atLock: 0, toArrive: 0 },
      ...passLockWait({}),
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(validationGauge(state, 1).reads).toBe(
      "0 runs ahead, about 0 min at 1 concurrent runs of 2 min, capacity 30 in a 60 min wait window (default: the test stage's hour, LOCK_TIMEOUT unset)",
    );
  });

  test("a window shorter than one run says a pass needs a slot free for its first run", () => {
    const state: ValidationLoad = {
      measured: tenRunPasses,
      demand: { atLock: 0, toArrive: 1 },
      ...passLockWait({ LOCK_TIMEOUT: "60" }),
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(validationHold(state, 1, "pickup", 3 * HOUR)).toBe(
      "waits on validation capacity: 1 runs ahead, about 2 min at 1 concurrent runs of 2 min, capacity 0.5 in a 1 min wait window (LOCK_TIMEOUT); the wait window is shorter than one run, so a pass is admitted only while a slot is free, or about to be, for its first run (10 runs per pass)",
    );
  });

  test("the reason says when the pass deadline cut the window", () => {
    const state: ValidationLoad = {
      measured: tenRunPasses,
      demand: { atLock: 0, toArrive: 0 },
      ...passLockWait({}),
      driveDeadlineMs: 90 * MINUTE,
      admittedRuns: 0,
    };
    expect(
      validationGauge({ ...state, driveDeadlineMs: 0 }, 1).reads,
    ).toContain("(default: the test stage's hour, LOCK_TIMEOUT unset)");
    const held = validationHold(
      { ...state, demand: { atLock: 0, toArrive: 20 } },
      1,
      "drive",
      3 * HOUR,
    );
    expect(held).toContain(
      "30 min wait window (default: the test stage's hour, LOCK_TIMEOUT unset, limited by the pass deadline)",
    );
  });
});
