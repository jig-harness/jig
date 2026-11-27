import { describe, expect, test } from "bun:test";
import type { HostLoad } from "../../shared/host-load.ts";
import {
  forecastValidation,
  measurementsFor,
  measureValidation,
  runMsFor,
  validationDemand,
  type ValidationMeasurements,
  type ValidationPass,
  type ValidationSample,
} from "../lib/validation-capacity.ts";
import {
  readValidationLoad,
  type ValidationLoad,
  validationGauge,
  validationHold,
} from "../lib/validation-load.ts";
import { lockSlots } from "../lib/validation-slots.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GIB = 1024 ** 3;

function sample(
  requestedAtMs: number,
  holdMs: number,
  workspace: string | null,
): ValidationSample {
  return { requestedAtMs, waitMs: 0, holdMs, workspace };
}

/** One ended pickup in `repo` whose runs held the lock for each of `holds`. */
function endedPass(
  repo: string,
  workspace: string,
  launchedAtMs: number,
  holds: readonly number[],
): { pass: ValidationPass; samples: ValidationSample[] } {
  return {
    pass: {
      kind: "pickup",
      workspace,
      repo,
      launchedAtMs,
      endedAtMs: launchedAtMs + HOUR,
    },
    samples: holds.map((hold, i) =>
      sample(launchedAtMs + (i + 1) * MINUTE, hold, workspace),
    ),
  };
}

function measuredOf(
  entries: ReturnType<typeof endedPass>[],
  extra: ValidationSample[] = [],
  slots?: number | null,
): ValidationMeasurements {
  return measureValidation(
    [...entries.flatMap(({ samples }) => samples), ...extra],
    entries.map(({ pass }) => pass),
    slots,
  );
}

describe("run time per repository", () => {
  test("each repository with enough runs is charged its own run time", () => {
    const measured = measuredOf([
      endedPass("short/repo", "s", 0, Array(5).fill(MINUTE)),
      endedPass("long/repo", "l", 2 * HOUR, Array(5).fill(30 * MINUTE)),
    ]);
    expect(runMsFor(measured, "short/repo")).toBe(MINUTE);
    expect(runMsFor(measured, "long/repo")).toBe(30 * MINUTE);
    // Every repository's figure is the 90th percentile of every run.
    expect(measured.runMs).toBe(30 * MINUTE);
  });

  test("a repository with too few runs, none, or no name takes every repository's run time", () => {
    const measured = measuredOf([
      endedPass("short/repo", "s", 0, Array(4).fill(MINUTE)),
      endedPass("long/repo", "l", 2 * HOUR, Array(6).fill(30 * MINUTE)),
    ]);
    expect(runMsFor(measured, "short/repo")).toBe(measured.runMs);
    expect(runMsFor(measured, "unrecorded/repo")).toBe(measured.runMs);
    expect(runMsFor(measured, null)).toBe(measured.runMs);
    expect(runMsFor(measured)).toBe(measured.runMs);
  });

  test("a run outside any pass counts only in every repository's figure", () => {
    const measured = measuredOf(
      [endedPass("short/repo", "s", 0, Array(5).fill(MINUTE))],
      [sample(5 * HOUR, 40 * MINUTE, "a person's checkout")],
    );
    expect(runMsFor(measured, "short/repo")).toBe(MINUTE);
    expect(measured.runMs).toBe(40 * MINUTE);
  });

  test("the runs still to arrive are charged their own repository's run time", () => {
    // Every repository's run time is 30 minutes, set by one long repository;
    // three passes in flight of a repository whose runs take a minute still
    // make three runs each.
    const base = measuredOf([
      endedPass("long/repo", "l", 0, Array(5).fill(30 * MINUTE)),
      endedPass("short/repo", "s", 2 * HOUR, Array(5).fill(MINUTE)),
    ]);
    const measured: ValidationMeasurements = {
      ...base,
      concurrency: 1,
      kinds: {
        pickup: {
          runsPerPass: 3,
          runsPerRepository: new Map([["short/repo", 3]]),
          timeToValidationMs: 0,
        },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    const inFlight: ValidationPass[] = [0, 1, 2].map((i) => ({
      kind: "pickup",
      workspace: `flight-${i}`,
      repo: "short/repo",
      launchedAtMs: 10 * HOUR,
    }));
    // With an arrival estimate each pass carries its run time; without
    // one its runs are counted ahead at it.
    const estimated = validationDemand(measured, [], inFlight, [], 10 * HOUR);
    expect(estimated.arrivals).toEqual(
      Array(3).fill({ atMs: 0, runs: 3, runMs: MINUTE }),
    );
    const demand = validationDemand(measured, [], inFlight, []);
    expect(demand.toArrive).toBe(9);
    expect(demand.unestimated).toEqual(
      Array(3).fill({ runs: 3, runMs: MINUTE }),
    );
    // Nine one-minute runs ahead are a nine-minute wait, under a quarter of
    // the hour; at every repository's 30 minutes they would be 4.5 hours.
    const forecast = forecastValidation(
      measurementsFor(measured, "long/repo"),
      "pickup",
      demand,
      HOUR,
      3 * HOUR,
    );
    expect(forecast.fill).toBeCloseTo(9 / 60);
    const hostWide = forecastValidation(
      measured,
      "pickup",
      { atLock: 0, toArrive: 9 },
      HOUR,
      3 * HOUR,
    );
    expect(hostWide.fill === null || hostWide.fill > 1).toBe(true);
  });

  test("a pass's own later runs follow one another at its repository's run time", () => {
    const base = measuredOf([
      endedPass("long/repo", "l", 0, Array(5).fill(30 * MINUTE)),
      endedPass("short/repo", "s", 2 * HOUR, Array(5).fill(MINUTE)),
    ]);
    const measured: ValidationMeasurements = {
      ...base,
      concurrency: 1,
      kinds: {
        pickup: {
          runsPerPass: 1,
          runsPerRepository: new Map([["short/repo", 10]]),
          timeToValidationMs: 0,
        },
        drive: { runsPerPass: 1, timeToValidationMs: 0 },
      },
    };
    // One run holds the lock now; the pass makes ten runs. At its own
    // minute each, its last run starts well within a 30-minute deadline.
    const demand = { atLock: 1, toArrive: 0 };
    const own = forecastValidation(
      measurementsFor(measured, "short/repo"),
      "pickup",
      demand,
      HOUR,
      45 * MINUTE,
    );
    expect(own.fill).not.toBeNull();
    // Charged every repository's 30 minutes for its own runs, the last one
    // would ask after the deadline.
    const hostWide = forecastValidation(
      { ...measured, kinds: measurementsFor(measured, "short/repo").kinds },
      "pickup",
      demand,
      HOUR,
      45 * MINUTE,
    );
    expect(hostWide.fill).toBeNull();
  });
});

describe("run time per repository at the lock and in the drive reserve", () => {
  const measured: ValidationMeasurements = {
    ...measureValidation([], []),
    runMs: 30 * MINUTE,
    runMsPerRepository: new Map([["short/repo", MINUTE]]),
    concurrency: 1,
    kinds: {
      pickup: {
        runsPerPass: 1,
        runsPerRepository: new Map([["short/repo", 10]]),
        timeToValidationMs: 0,
      },
      drive: { runsPerPass: 1, timeToValidationMs: 0 },
    },
    defaults: [],
  };

  test("a pickup of many short runs keeps room for a drive at its own run time", () => {
    const state: ValidationLoad = {
      measured,
      demand: { atLock: 0, toArrive: 0 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    expect(
      validationHold(state, 1, "pickup", 3 * HOUR, "short/repo"),
    ).toBeNull();
    // The same ten runs at every repository's 30 minutes leave no room.
    expect(
      validationHold(
        { ...state, measured: { ...measured, runMsPerRepository: new Map() } },
        1,
        "pickup",
        3 * HOUR,
        "short/repo",
      ),
    ).toContain("keep room for a drive");
  });

  test("a run at the lock holds its slot for its own pass's repository's run time", () => {
    // A drive making its one run, so it owes none still to arrive.
    const flight: ValidationPass = {
      kind: "drive",
      workspace: "flight",
      repo: "short/repo",
      launchedAtMs: 0,
    };
    const demand = validationDemand(
      measured,
      [{ workspace: "flight" }, { workspace: null }],
      [flight],
      [],
    );
    expect(demand.atLockRunMs).toEqual([MINUTE]);
    // Two runs at one slot: the unknown one is taken to hold (the longer),
    // the short one waits behind it, so the candidate waits 31 minutes.
    const forecast = forecastValidation(
      measured,
      "drive",
      demand,
      HOUR,
      3 * HOUR,
    );
    expect(forecast.fill).toBeCloseTo(31 / 60);
  });
});

function host(
  load1: number | null,
  cores: number,
  availableGiB = 32,
): HostLoad {
  return { load1, cores, availableBytes: availableGiB * GIB };
}

describe("the lock's load-derived slot count", () => {
  test("an idle host admits the runs whose cost fits under its cores times the target", () => {
    // 16 cores × 0.85 = 13.6: three runs of 4 fit, a fourth would not.
    expect(lockSlots(host(0, 16), 0, {})).toEqual({ ok: true, value: 3 });
  });

  test("a host loaded by other work admits one run at a time, however many hold the lock now", () => {
    expect(lockSlots(host(30, 16), 0, {})).toEqual({ ok: true, value: 1 });
    expect(lockSlots(host(30, 16), 2, {})).toEqual({ ok: true, value: 1 });
  });

  test("the runs holding the lock are not counted as load other work puts on the host", () => {
    // A load of 8 is two runs of 4: the rest of the host is idle.
    expect(lockSlots(host(8, 16), 2, {})).toEqual({ ok: true, value: 3 });
    expect(lockSlots(host(8, 16), 0, {})).toEqual({ ok: true, value: 1 });
  });

  test("below the memory floor the lock admits one run at a time", () => {
    expect(lockSlots(host(0, 64, 4), 0, {})).toEqual({ ok: true, value: 1 });
    expect(lockSlots(host(0, 64, 4), 3, {})).toEqual({ ok: true, value: 1 });
  });

  test("a platform with no load average decides by memory up to the ceiling", () => {
    expect(lockSlots(host(null, 4), 0, { LOCK_SLOTS: "6" })).toEqual({
      ok: true,
      value: 6,
    });
  });

  test("LOCK_SLOTS is the ceiling, and a static count admits every slot", () => {
    expect(lockSlots(host(0, 64), 0, { LOCK_SLOTS: "2" })).toEqual({
      ok: true,
      value: 2,
    });
    expect(lockSlots(host(99, 4), 0, { LOCK_STATIC_SLOTS: "1" })).toEqual({
      ok: true,
      value: 8,
    });
    expect(lockSlots(host(36, 64), 9, { LOCK_SLOTS: "4" })).toEqual({
      ok: true,
      value: 4,
    });
  });

  test("the lock's own settings decide, so a cost it reads changes the count", () => {
    expect(lockSlots(host(0, 16), 0, { LOCK_RUN_COST: "2" })).toEqual({
      ok: true,
      value: 6,
    });
  });

  test("a setting the lock refuses leaves the count unread", () => {
    const slots = lockSlots(host(0, 16), 0, { LOCK_SLOTS: "0" });
    expect(slots.ok).toBe(false);
    if (!slots.ok) expect(slots.failure.reason).toContain("LOCK_SLOTS");
  });

  test("runs at once is at least the slot count, and the peak the samples saw where it is higher", () => {
    const overlap = [0, 1, 2].map((i) => sample(0, 10 * MINUTE, `w${i}`));
    expect(measureValidation(overlap, [], 1).concurrency).toBe(3);
    expect(measureValidation(overlap, [], 5).concurrency).toBe(5);
    const fresh = measureValidation([], [], 4);
    expect(fresh.concurrency).toBe(4);
    expect(fresh.lockSlots).toBe(4);
    expect(fresh.defaults).not.toContain("runs at once");
    expect(measureValidation([], [], null).defaults).toContain("runs at once");
  });

  test("the reader takes the slot count from the host and names it in the gauge", () => {
    const reading = readValidationLoad(
      [],
      { holders: 0, waiters: 0, runs: [] },
      0,
      90 * MINUTE,
      {},
      host(0, 16),
    );
    expect(reading.measured.concurrency).toBe(3);
    expect(validationGauge(reading, 1).reads).toContain(
      "the lock's load check admits 3",
    );
  });

  test("only the holders the load average shows are taken out of the load", () => {
    const read = (settled?: number) =>
      readValidationLoad(
        [],
        {
          holders: 64,
          waiters: 0,
          ...(settled === undefined ? {} : { settled }),
          runs: [{ workspace: null }],
        },
        0,
        90 * MINUTE,
        {},
        host(4, 16),
      ).measured.lockSlots;
    // One settled holder, an exclusive one across every slot, is the whole
    // load of 4: the rest of the host is idle.
    expect(read(1)).toBe(3);
    // A holder too fresh to show, or a reading that does not say, leaves the
    // load as it reads.
    expect(read(0)).toBe(2);
    expect(read()).toBe(2);
  });

  test("with the slot count unread, runs at once is the peak and the gauge says why", () => {
    const refused = readValidationLoad(
      [],
      { holders: 0, waiters: 0, runs: [] },
      0,
      90 * MINUTE,
      { LOCK_SLOTS: "99" },
      host(0, 16),
    );
    expect(refused.measured.concurrency).toBe(1);
    expect(refused.slotsUnread).toContain("LOCK_SLOTS");
    expect(validationGauge(refused, 1).reads).toContain(
      "the lock's slot count unread",
    );
    const noHost = readValidationLoad(
      [],
      { holders: 0, waiters: 0, runs: [] },
      0,
      90 * MINUTE,
      {},
    );
    expect(noHost.slotsUnread).toBe("no host reading");
    const lockUnread = readValidationLoad(
      [],
      { unread: "the test lock not read: denied" },
      0,
      90 * MINUTE,
      {},
      host(0, 16),
    );
    expect(lockUnread.slotsUnread).toBe("the test lock not read: denied");
    expect(validationGauge(lockUnread, 1).fill).toBeNull();
  });
});

describe("the replays with the slot count read", () => {
  test("November 14: a host the passes loaded still holds launches before the deadline wave", () => {
    // The ticks of the November 14 replay (validation-capacity.test.ts),
    // with the slot count read from a host other work has loaded past its
    // cores. The receipts carry no load figure, so this reading is chosen so
    // that the lock admits one run at a time once a holder releases. On a
    // host with room for more, the count reads higher and the forecast
    // admits more, as a peak in the samples would.
    const replay = [
      { holding: 4, waiting: 4, openPickups: 3, openDrives: 1, launches: 4 },
      { holding: 5, waiting: 13, openPickups: 7, openDrives: 3, launches: 6 },
    ];
    let held = 0;
    for (const tick of replay) {
      const slots = lockSlots(host(40, 16), tick.holding, {});
      expect(slots).toEqual({ ok: true, value: 1 });
      const measured = measureValidation([], [], slots.ok ? slots.value : null);
      const passes: ValidationPass[] = Array.from(
        { length: tick.openPickups + tick.openDrives },
        (_, i) => ({
          kind: i < tick.openPickups ? "pickup" : "drive",
          workspace: String(i),
          launchedAtMs: 0,
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
        else held++;
      }
    }
    expect(held).toBeGreaterThanOrEqual(6);
  });
});
