/**
 * The load factor: each gauge's fill against its line, the fullest gauge
 * as the factor, each kind's reservation, and admission with the pickup's
 * reserve, held under enforcement and reported without it.
 */
import { describe, expect, it } from "bun:test";
import type { LoadKind } from "../lib/dashboard-contract.ts";
import { LOAD_DEFAULTS, type LoadSettings } from "../lib/load-config.ts";
import type { LoadReading } from "../lib/load-read.ts";
import {
  factorText,
  judge,
  loadReport,
  loadState,
  type LoadState,
} from "../lib/load.ts";

const GIB = 1024 ** 3;
/** 16 GiB of memory: 15% of it, 2.4 GiB, is kept free. */
const TOTAL = 16 * GIB;
const FLOOR = TOTAL * 0.15;

function reading(fields: Partial<LoadReading> = {}): LoadReading {
  return {
    host: { load1: 2, cores: 8, availableBytes: 10 * GIB },
    totalBytes: TOTAL,
    platform: "linux",
    disk: { freeBytes: 500 * GIB, totalBytes: 1000 * GIB, path: "/ws" },
    lock: { holders: 1, waiters: 0 },
    forge: { remaining: 4000, limit: 5000 },
    sessions: new Map(),
    ...fields,
  };
}

function state(
  fields: Partial<LoadReading> = {},
  settings: Partial<LoadSettings> = {},
  samples: Map<LoadKind, number[]> = new Map(),
  accounts = { held: 0, capacity: 8 },
): LoadState {
  return loadState(
    { ...LOAD_DEFAULTS, ...settings },
    reading(fields),
    accounts,
    samples,
  );
}

/** Memory with `left` bytes available above the floor. */
const headroom = (left: number) => ({
  host: { load1: 2, cores: 8, availableBytes: FLOOR + left },
});

describe("the load factor", () => {
  it("is the fullest gauge's fill against its line, naming the gauge that binds", () => {
    // 3 GiB used of 13.6 usable is 22%; a load of 5.9 on 8 cores against 0.9 per core is 82%.
    const report = loadReport(
      state({ host: { load1: 5.904, cores: 8, availableBytes: 13 * GIB } }),
    );
    expect(report.gauges.map((g) => g.gauge)).toEqual([
      "memory",
      "processors",
      "test-lock",
      "disk",
      "forge",
      "accounts",
    ]);
    expect(report.binds).toBe("processors");
    expect(factorText(report)).toBe("82% · processors binds");
  });

  it("leaves out a gauge the host cannot read, and says why", () => {
    const report = loadReport(
      state({
        platform: "win32",
        host: { load1: null, cores: 8, availableBytes: 10 * GIB },
      }),
    );
    const processors = report.gauges.find((g) => g.gauge === "processors");
    expect(processors).toMatchObject({ fill: null });
    expect(processors?.reads).toBe(
      "processors not read on Windows, which has no load average",
    );
    expect(report.binds).not.toBe("processors");
  });
});

describe("admission by the host's load", () => {
  it("with one drive's headroom left, admits the re-arm and holds the pickup, which keeps room for a drive", () => {
    const load = state(headroom(1.6 * GIB), { enforce: true });
    expect(judge(load, "drive", "o/r", "PR #7")).toBeNull();
    const held = judge(load, "pickup", "o/r", "#12");
    expect(held).toContain("the host's load holds it: memory binds");
    expect(held).toContain(
      "the pickup reserves 2.0 GiB and keeps 1.5 GiB for a drive or follow-up",
    );
    expect(load.holds).toMatchObject([
      { target: "#12", kind: "pickup", gauge: "memory", held: true },
    ]);
  });

  it("holds a pickup that would fit alone but leave no drive's reservation", () => {
    // 2 GiB fits the pickup, not the pickup and the 1.5 GiB it keeps.
    const load = state(headroom(3 * GIB), { enforce: true });
    expect(judge(load, "pickup", "o/r", "#12")).toContain("memory binds");
    expect(judge(load, "followup", "o/r", "PR #9")).toBeNull();
  });

  it("counts each launch it admits, so the tick never spends the same headroom twice", () => {
    const load = state(headroom(2 * GIB), { enforce: true });
    expect(judge(load, "drive", "o/r", "PR #7")).toBeNull();
    expect(judge(load, "drive", "o/r", "PR #8")).toContain("memory binds");
  });

  it("without enforcement starts what a gauge refuses and reports it as one it would hold", () => {
    const load = state(headroom(0.5 * GIB));
    expect(judge(load, "drive", "o/r", "PR #7")).toBeNull();
    expect(load.holds).toMatchObject([
      { target: "PR #7", kind: "drive", gauge: "memory", held: false },
    ]);
    // What enforcement would have held reserves nothing: the next launch is judged as enforcement would judge it.
    expect(load.spentBytes).toBe(0);
  });

  it("holds pickups and drive passes while two runs wait on the test lock, never a follow-up", () => {
    const load = state({ lock: { holders: 3, waiters: 2 } }, { enforce: true });
    expect(judge(load, "drive", "o/r", "PR #7")).toContain(
      "test-lock binds: 3 holding, 2 waiting",
    );
    expect(judge(load, "pickup", "o/r", "#12")).toContain("test-lock binds");
    expect(judge(load, "followup", "o/r", "PR #9")).toBeNull();
  });

  it("keeps an account slot free after a pickup", () => {
    const load = state({}, { enforce: true }, new Map(), {
      held: 3,
      capacity: 4,
    });
    expect(judge(load, "pickup", "o/r", "#12")).toContain(
      "accounts bind: the pickup would take the last free slot",
    );
    expect(judge(load, "drive", "o/r", "PR #7")).toBeNull();
  });

  it("holds every kind while the disk or the forge budget is past its line", () => {
    const disk = state(
      { disk: { freeBytes: 9 * GIB, totalBytes: 100 * GIB, path: "/ws" } },
      { enforce: true },
    );
    expect(judge(disk, "followup", "o/r", "PR #9")).toContain("disk binds");
    const forge = state(
      { forge: { remaining: 400, limit: 5000 } },
      { enforce: true },
    );
    expect(judge(forge, "drive", "o/r", "PR #7")).toContain("forge binds");
  });
});

describe("each kind's reservation", () => {
  it("is its default until it has five samples, then their 90th percentile", () => {
    const four = [3, 3, 3, 3].map((g) => g * GIB);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((g) => g * 0.5 * GIB);
    const report = loadReport(
      state(
        {},
        {},
        new Map([
          ["pickup", four],
          ["drive", ten],
        ]),
      ),
    );
    expect(report.reservations).toEqual([
      { kind: "pickup", bytes: 2 * GIB, samples: 4, measured: false },
      { kind: "drive", bytes: 4.5 * GIB, samples: 10, measured: true },
      { kind: "followup", bytes: 1 * GIB, samples: 0, measured: false },
      { kind: "steward", bytes: 1 * GIB, samples: 0, measured: false },
    ]);
  });
});
