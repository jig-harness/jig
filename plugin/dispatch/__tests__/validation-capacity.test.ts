import { describe, expect, test } from "bun:test";
import type { ReadRecord } from "../lib/launches.ts";
import {
  forecastValidation,
  measureValidation,
  runsPerPassFor,
  validationDemand,
  type ValidationPass,
  type ValidationSample,
} from "../lib/validation-capacity.ts";
import {
  PASS_LOCK_WAIT_SECONDS,
  passLockWait,
  validationGauge,
  validationHold,
  validationPassesOf,
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
      pickup: {
        runsPerPass: 1,
        runsPerRepository: new Map(),
        timeToValidationMs: HOUR,
      },
      drive: {
        runsPerPass: 1,
        runsPerRepository: new Map(),
        timeToValidationMs: HOUR,
      },
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

  test("measures runs at once as the peak overlap, even when a run later waited behind one holder", () => {
    const overlapping = [sample(0, 0, 50), sample(0, 0, 50), sample(0, 0, 50)];
    expect(measureValidation(overlapping, []).concurrency).toBe(3);
    const contested = [sample(100, 0, 20), sample(100, 20, 10)];
    const measured = measureValidation([...overlapping, ...contested], []);
    expect(measured.concurrency).toBe(3);
    expect(measured.runMs).toBe(50);
    expect(measured.defaults).not.toContain("run time");
    expect(measured.defaults).not.toContain("runs at once");
  });

  test("counts runs that hold the lock together, not runs that wait for it", () => {
    const samples = [sample(0, 0, 20), sample(0, 0, 10), sample(0, 20, 10)];
    expect(measureValidation(samples, []).concurrency).toBe(2);
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
      runsPerRepository: new Map(),
      timeToValidationMs: 20,
    });
    expect(measured.kinds.drive).toEqual({
      runsPerPass: 1,
      runsPerRepository: new Map(),
      timeToValidationMs: 60,
    });
  });

  /** Ended pickups in `repo`, one per entry of `runs`, each making that many runs. */
  function endedPickups(
    repo: string,
    runs: readonly number[],
  ): { passes: ValidationPass[]; samples: ValidationSample[] } {
    const passes: ValidationPass[] = [];
    const samples: ValidationSample[] = [];
    runs.forEach((count, index) => {
      const workspace = `${repo}-${index}`;
      const launchedAtMs = index * HOUR;
      passes.push({
        ...pickup(workspace, launchedAtMs),
        repo,
        endedAtMs: launchedAtMs + HOUR / 2,
      });
      for (let run = 0; run < count; run++)
        samples.push(sample(launchedAtMs + run * MINUTE, 0, 30_000, workspace));
    });
    return { passes, samples };
  }

  test("counts passes that made no run and takes the median, not the mean", () => {
    const { passes, samples } = endedPickups("one/repo", [21, 2, 1, 0, 0]);
    const measured = measureValidation(samples, passes);
    expect(measured.kinds.pickup.runsPerPass).toBe(1);
    expect(measured.defaults).not.toContain("pickup runs per pass");
  });

  test("charges at least one run per pass when most passes made none", () => {
    const { passes, samples } = endedPickups("one/repo", [3, 0, 0]);
    expect(measureValidation(samples, passes).kinds.pickup.runsPerPass).toBe(1);
  });

  test("leaves out passes that ended before the oldest sample still kept", () => {
    const { passes, samples } = endedPickups("one/repo", [0, 0, 0, 4, 4, 0]);
    // The first three passes ended before the retained samples begin; the
    // last made no run while the lock was recording.
    const measured = measureValidation(samples, passes);
    expect(measured.kinds.pickup.runsPerPass).toBe(4);
  });

  test("measures runs per pass per repository and charges a repository whose lock records nothing the others' median", () => {
    const heavy = endedPickups("heavy/repo", [3, 3, 3, 3]);
    const light = endedPickups("light/repo", [1, 1, 1]);
    // Too few passes for a measure of its own.
    const young = endedPickups("young/repo", [21]);
    // A repository whose lock wrapper records no samples: its passes would
    // read as making no runs and pull every repository's median to zero.
    const silent = endedPickups("silent/repo", Array(9).fill(0));
    const measured = measureValidation(
      [...heavy.samples, ...light.samples, ...young.samples, ...silent.samples],
      [...heavy.passes, ...light.passes, ...young.passes, ...silent.passes],
    );
    expect(measured.kinds.pickup.runsPerPass).toBe(3);
    expect(measured.kinds.pickup.runsPerRepository).toEqual(
      new Map([
        ["heavy/repo", 3],
        ["light/repo", 1],
      ]),
    );
    expect(runsPerPassFor(measured, "pickup", "light/repo")).toBe(1);
    expect(runsPerPassFor(measured, "pickup", "silent/repo")).toBe(3);
    expect(runsPerPassFor(measured, "pickup", "young/repo")).toBe(3);
    expect(runsPerPassFor(measured, "pickup")).toBe(3);
  });

  test("charges each pass in flight its own repository's runs per pass", () => {
    const heavy = endedPickups("heavy/repo", [5, 5, 5, 5]);
    const light = endedPickups("light/repo", [1, 1, 1]);
    const measured = measureValidation(
      [...heavy.samples, ...light.samples],
      [...heavy.passes, ...light.passes],
    );
    const inFlight: ValidationPass[] = [
      { ...pickup("new-heavy", 10 * HOUR), repo: "heavy/repo" },
      { ...pickup("new-light", 10 * HOUR), repo: "light/repo" },
    ];
    expect(validationDemand(measured, [], inFlight, [])).toEqual({
      atLock: 0,
      toArrive: 6,
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
      served: 2,
      later: 0,
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
    // The 10:30:25 UTC tick of 2026-11-20, measured from that host's launch
    // records and lock samples as they stood then: two runs at once, runs of
    // 2 minutes, one run per pass, 25 minutes to validation, nothing at the
    // lock and three runs still to arrive from passes in flight.
    const measured = {
      ...measureValidation([], []),
      runMs: 2 * MINUTE,
      concurrency: 2,
      kinds: {
        pickup: { runsPerPass: 1, timeToValidationMs: 25 * MINUTE },
        drive: { runsPerPass: 1, timeToValidationMs: HOUR },
      },
    };
    const forecast = (wait: number) =>
      forecastValidation(
        measured,
        "pickup",
        { atLock: 0, toArrive: 3 },
        wait,
        3 * HOUR,
      );
    // The three runs ahead are still counted ahead: they take both slots and
    // the first release, so the pickup's first run waits 2 minutes, 2 runs
    // of service of the 60 its hour holds.
    const hour = forecast(passLockWait({}).waitLimitMs);
    expect(hour.ahead).toBe(3);
    expect(hour.required).toBe(2);
    expect(hour.fill).toBeCloseTo(2 / 60);
    // The bare lock's minute, the window the tick read, holds one run of
    // service, and held the pickup at twice its line.
    expect(forecast(MINUTE).fill).toBe(2);
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
    // Both holders still hold the lock when the candidate arrives.
    expect(forecast.ahead).toBe(2);
    expect(forecast.served).toBe(0);
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

  test("judges a pickup by its own repository's runs per pass", () => {
    const state: ValidationLoad = {
      measured: {
        runMs: 15 * MINUTE,
        concurrency: 1,
        kinds: {
          pickup: {
            runsPerPass: 1,
            runsPerRepository: new Map([["heavy/repo", 10]]),
            timeToValidationMs: 0,
          },
          drive: { runsPerPass: 1, timeToValidationMs: 0 },
        },
        defaults: [],
      },
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(
      validationHold(state, 1, "pickup", 3 * HOUR, "light/repo"),
    ).toBeNull();
    expect(
      validationHold(state, 1, "pickup", 3 * HOUR, "heavy/repo"),
    ).toContain("waits on validation capacity");
  });

  test("the November 20 receipt replay admits a pickup on an idle host", () => {
    // From the 15:32:21 UTC tick receipt of 2026-11-20, its launch records
    // and the lock's samples: the gauge read 13.39 runs ahead at one run at
    // a time, and held every pickup with two in flight, on a host at about
    // 0.15 load per core.
    const at = (hours: number, minutes: number, seconds = 0) =>
      (hours * 60 + minutes) * MINUTE + seconds * 1000;
    const repo = "example/jig";
    const passes: ValidationPass[] = [];
    const samples: ValidationSample[] = [];
    const ended = (
      workspace: string,
      kind: ValidationPass["kind"],
      launchedAtMs: number,
      runs: readonly number[],
    ) => {
      passes.push({
        workspace,
        kind,
        repo,
        launchedAtMs,
        endedAtMs: launchedAtMs + HOUR,
      });
      for (const [index, holdMs] of runs.entries())
        samples.push(
          sample(launchedAtMs + (7 + index) * MINUTE, 0, holdMs, workspace),
        );
    };
    // Pickups that made runs: 21 short targeted runs, 2 full runs, 1.
    ended("many", "pickup", at(8, 0), Array(21).fill(30_000));
    ended("two", "pickup", at(10, 30), [10 * MINUTE, 10 * MINUTE]);
    ended("one", "pickup", at(12, 30), [11 * MINUTE]);
    // Pickups and drives that ended without a run while the lock recorded.
    for (let i = 0; i < 19; i++) ended(`idle-${i}`, "pickup", at(9, i), []);
    for (let i = 0; i < 10; i++) ended(`drive-${i}`, "drive", at(9, i), []);
    ended("drive-run", "drive", at(13, 0), [10 * MINUTE]);
    // A consumer repository whose lock wrapper records no samples.
    for (let i = 0; i < 50; i++)
      passes.push({
        workspace: `consumer-${i}`,
        kind: "pickup",
        repo: "example/consumer",
        launchedAtMs: at(9, i),
        endedAtMs: at(10, i),
      });
    // The only wait that day with a holder: one run at a time.
    samples.push(sample(at(13, 50), 0, 26.2 * MINUTE, "gate-a"));
    samples.push(sample(at(14, 5, 43), 10.5 * MINUTE, 11 * MINUTE, "gate-b"));
    // The two pickups in flight: one has made three runs, one none. Its
    // first run is one of three full gate runs that held the lock together.
    const inFlight: ValidationPass[] = [
      { ...pickup("flight-a", at(14, 57)), repo },
      { ...pickup("flight-b", at(15, 11)), repo },
    ];
    samples.push(sample(at(14, 52, 44), 0, 24.8 * MINUTE, "gate-c"));
    samples.push(sample(at(14, 59, 31), 0, 11.57 * MINUTE, "gate-d"));
    samples.push(sample(at(15, 4, 9), 0, 12.18 * MINUTE, "flight-a"));
    for (const minute of [20, 25])
      samples.push(sample(at(15, minute), 0, MINUTE, "flight-a"));
    const measured = measureValidation(samples, [...passes, ...inFlight]);
    const state: ValidationLoad = {
      measured,
      demand: validationDemand(
        measured,
        [{ workspace: null }],
        inFlight,
        samples,
      ),
      ...passLockWait({}),
      driveDeadlineMs: 90 * MINUTE,
      admittedRuns: 0,
    };
    expect(measured.concurrency).toBe(3);
    expect(runsPerPassFor(measured, "pickup", repo)).toBe(1);
    const gauge = validationGauge(state, 1);
    expect(gauge.fill).not.toBeNull();
    expect(gauge.fill ?? Infinity).toBeLessThan(1);
    expect(validationHold(state, 1, "pickup", 3 * HOUR, repo)).toBeNull();
  });
});

describe("validation passes read from launch records", () => {
  const record = (repo: string, path: string): ReadRecord =>
    ({
      record: {
        action: "pickup",
        repo,
        createdAt: "2026-11-20T08:00:00.000Z",
        workspace: { id: path, path: `/work/${path}` },
      },
      state: {
        kind: "ended",
        exit: { at: "2026-11-20T09:00:00.000Z" },
      },
    }) as unknown as ReadRecord;

  test("carry the repository, so its own measure and admission follow", () => {
    const records = ["a", "b", "c"].map((n) => record("example/repo", n));
    const passes = validationPassesOf(records);
    expect(passes.map(({ repo }) => repo)).toEqual(
      Array(3).fill("example/repo"),
    );
    const samples: ValidationSample[] = ["a", "b", "c"].flatMap((n) =>
      Array.from({ length: 5 }, (_, i) =>
        sample(
          Date.parse("2026-11-20T08:10:00Z") + i * MINUTE,
          0,
          MINUTE,
          `/work/${n}`,
        ),
      ),
    );
    const measured = measureValidation(samples, passes);
    expect(runsPerPassFor(measured, "pickup", "example/repo")).toBe(5);
  });

  test("a repository's observable window starts at its own first sample", () => {
    const old = Date.parse("2026-11-13T08:00:00Z");
    const records = ["a", "b", "c"].map((n) => record("example/new", n));
    const passes: ValidationPass[] = [
      ...validationPassesOf(records),
      {
        workspace: "/work/other",
        kind: "pickup",
        repo: "example/old",
        launchedAtMs: old,
        endedAtMs: old + HOUR,
      },
    ];
    const samples = [
      sample(old + 5 * MINUTE, 0, MINUTE, "/work/other"),
      ...["a", "b", "c"].flatMap((n) =>
        Array.from({ length: 5 }, (_, i) =>
          sample(
            Date.parse("2026-11-20T08:10:00Z") + i * MINUTE,
            0,
            MINUTE,
            `/work/${n}`,
          ),
        ),
      ),
    ];
    // Earlier passes of example/new, from before it recorded, are not zero-run.
    const early: ValidationPass[] = Array.from({ length: 6 }, (_, i) => ({
      workspace: `/work/early-${i}`,
      kind: "pickup",
      repo: "example/new",
      launchedAtMs: old + 2 * HOUR,
      endedAtMs: old + 3 * HOUR,
    }));
    const measured = measureValidation(samples, [...passes, ...early]);
    expect(runsPerPassFor(measured, "pickup", "example/new")).toBe(5);
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
