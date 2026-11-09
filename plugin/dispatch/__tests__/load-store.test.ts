/**
 * What the load factor reads and keeps: the `load:` section of the machine
 * file with its defaults, the reservation samples in the state database,
 * and the memory of the processes in a workspace on Linux.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb } from "../lib/state.ts";
import { LOAD_DEFAULTS } from "../lib/load-config.ts";
import { residentBytes, workspaceMemory } from "../lib/load-read.ts";
import {
  KEPT,
  percentile90,
  readSamples,
  recordSamples,
} from "../lib/load-samples.ts";
import { readMachineConfig } from "../lib/machine-config.ts";

const GIB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function config(body: string) {
  const file = join(scratch("jig-load-config-"), "dispatch.yaml");
  writeFileSync(file, body);
  return readMachineConfig(file);
}

describe("the machine file's load section", () => {
  it("reads every line at its default, enforcement off, when the file names none", () => {
    const read = config("repositories: []\naccounts: []\n");
    expect(read.ok && read.value?.load).toEqual(LOAD_DEFAULTS);
    expect(LOAD_DEFAULTS).toMatchObject({
      enforce: false,
      memoryFree: 0.15,
      loadPerCore: 0.9,
      lockWaiters: 2,
      diskFreeBytes: 10 * GIB,
      forgeFloor: 0.1,
      reservations: {
        pickup: 2 * GIB,
        drive: 1.5 * GIB,
        followup: 1 * GIB,
        steward: 1 * GIB,
      },
    });
  });

  it("reads the lines and reservations it names, keeping the defaults of the rest", () => {
    const read = config(
      "load:\n  enforce: true\n  memory_free: 0.2\n  disk_free_gb: 20\n  reservations_gb:\n    pickup: 3\n",
    );
    expect(read.ok && read.value?.load).toMatchObject({
      enforce: true,
      memoryFree: 0.2,
      diskFreeBytes: 20 * GIB,
      reservations: { pickup: 3 * GIB, drive: 1.5 * GIB },
    });
  });

  it("refuses an unknown key, a share out of range and an unknown kind", () => {
    for (const [body, reason] of [
      ["load:\n  enforced: true\n", "load has an unknown key: enforced"],
      [
        "load:\n  memory_free: 1.5\n",
        "load.memory_free must be a number above 0 and below 1",
      ],
      [
        "load:\n  reservations_gb:\n    review: 1\n",
        "load.reservations_gb has an unknown kind: review",
      ],
      ["load:\n  enforce: yes please\n", "load.enforce must be true or false"],
    ]) {
      const read = config(body as string);
      expect(read).toMatchObject({
        ok: false,
        failure: {
          code: "invalid",
          reason: expect.stringContaining(reason as string),
        },
      });
    }
  });
});

describe("the reservation samples", () => {
  it("keeps each kind's newest twenty, and their 90th percentile is the reservation", () => {
    const root = scratch("jig-load-samples-");
    try {
      for (let i = 1; i <= 25; i++)
        recordSamples(
          [
            { kind: "drive", record: `r${i}`, bytes: i * GIB },
            ...(i <= 3
              ? [{ kind: "pickup" as const, record: `p${i}`, bytes: GIB }]
              : []),
          ],
          i,
          root,
        );
      const samples = readSamples(root);
      const drive = samples.get("drive") ?? [];
      expect(drive).toHaveLength(KEPT);
      expect(Math.min(...drive)).toBe(6 * GIB);
      expect(percentile90(drive)).toBe(23 * GIB);
      expect(samples.get("pickup")).toHaveLength(3);
      expect(samples.get("steward")).toEqual([]);
    } finally {
      closeStateDb(root);
    }
  });
});

describe("a workspace's memory", () => {
  it("reads VmRSS from a process's status", () => {
    expect(residentBytes("Name:\tbun\nVmRSS:\t   2048 kB\n")).toBe(2048 * 1024);
    expect(residentBytes("Name:\tkthreadd\n")).toBeNull();
  });

  it.if(process.platform === "linux")(
    "sums the memory of the processes working in it, and nothing for another",
    async () => {
      const busy = scratch("jig-load-busy-");
      const idle = scratch("jig-load-idle-");
      const child = Bun.spawn(["sleep", "30"], { cwd: busy });
      try {
        const deadline = Date.now() + 10_000;
        let seen = workspaceMemory([busy, idle]);
        while ((seen.get(busy) ?? 0) === 0 && Date.now() < deadline) {
          await Bun.sleep(50);
          seen = workspaceMemory([busy, idle]);
        }
        expect(seen.get(busy)).toBeGreaterThan(0);
        expect(seen.get(idle)).toBe(0);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );
});
