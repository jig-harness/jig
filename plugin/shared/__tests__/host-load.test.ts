import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memAvailable,
  readHostLoad,
  roomForOneMore,
  type AdmissionPolicy,
  type HostLoad,
} from "../host-load.ts";

const GIB = 1024 ** 3;
const policy: AdmissionPolicy = {
  targetUtilization: 0.85,
  runCost: 4,
  minAvailableBytes: 8 * GIB,
};
const host = (over: Partial<HostLoad> = {}): HostLoad => ({
  load1: 10,
  cores: 32,
  availableBytes: 64 * GIB,
  ...over,
});

test("the first run is admitted under any load and any memory", () => {
  expect(
    roomForOneMore(
      host({ load1: 500, availableBytes: 0 }),
      { count: 0, fresh: 0 },
      policy,
    ).admit,
  ).toBe(true);
});

test("one more run fits while the predicted load plus its cost stays under the cores times the target", () => {
  // 32 × 0.85 = 27.2; 10 + 4 × 2 fresh = 18, and 18 + 4 = 22 fits.
  expect(roomForOneMore(host(), { count: 3, fresh: 2 }, policy)).toMatchObject({
    admit: true,
  });
  // 10 + 4 × 4 fresh = 26, and 26 + 4 = 30 does not.
  expect(roomForOneMore(host(), { count: 4, fresh: 4 }, policy)).toMatchObject({
    admit: false,
    binds: "load",
    reason: expect.stringContaining("predicted load 26.0 + 4"),
  });
});

test("runs started long ago count only through the measured load", () => {
  expect(
    roomForOneMore(host({ load1: 22 }), { count: 6, fresh: 0 }, policy).admit,
  ).toBe(true);
  expect(
    roomForOneMore(host({ load1: 24 }), { count: 6, fresh: 0 }, policy).admit,
  ).toBe(false);
});

test("memory below the floor refuses one more run", () => {
  expect(
    roomForOneMore(
      host({ availableBytes: 7 * GIB }),
      { count: 1, fresh: 0 },
      policy,
    ),
  ).toMatchObject({ admit: false, binds: "memory" });
});

test("with no load average, memory alone decides", () => {
  expect(
    roomForOneMore(host({ load1: null }), { count: 9, fresh: 9 }, policy).admit,
  ).toBe(true);
  expect(
    roomForOneMore(
      host({ load1: null, availableBytes: GIB }),
      { count: 1, fresh: 0 },
      policy,
    ).admit,
  ).toBe(false);
});

test("Linux reads MemAvailable; Windows reports no load average", () => {
  expect(memAvailable("MemTotal:  1000 kB\nMemAvailable:    2048 kB\n")).toBe(
    2048 * 1024,
  );
  expect(memAvailable("MemTotal: 1000 kB\n")).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "jig-host-load-"));
  try {
    const meminfo = join(dir, "meminfo");
    writeFileSync(meminfo, "MemAvailable: 4096 kB\n");
    expect(readHostLoad("linux", meminfo).availableBytes).toBe(4096 * 1024);
    const windows = readHostLoad("win32", meminfo);
    expect(windows.load1).toBeNull();
    expect(windows.cores).toBeGreaterThanOrEqual(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
