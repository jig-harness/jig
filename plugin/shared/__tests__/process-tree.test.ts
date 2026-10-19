import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureProcessTree,
  reapRegisteredProcessTrees,
  type WindowsTreeState,
  identityTargetsGone,
  signalIdentityTargets,
  stopWindowsTree,
} from "../process-tree.ts";
import type { ProcessRow } from "../process-table.ts";
const row = (pid: number, ppid = 0, start = "old"): ProcessRow => ({
  pid,
  ppid,
  start,
  pgid: pid,
  stat: "S",
  args: "bun",
});
test("captures descendants before a leader disappears", async () => {
  expect(
    await captureProcessTree(1, async () => [
      row(3, 2),
      row(2, 1),
      row(1),
      row(4),
    ]),
  ).toEqual([row(1), row(2, 1), row(3, 2)]);
});
test("revalidates creation identity before every forced kill", async () => {
  const killed: number[] = [];
  let reads = 0;
  await signalIdentityTargets([row(1), row(2, 1)], "SIGKILL", {
    table: async () =>
      ++reads === 1 ? [row(1), row(2, 1)] : [row(1, 0, "reused")],
    kill: (pid) => {
      killed.push(pid);
    },
  });
  expect(killed).toEqual([2]);
  expect(reads).toBe(2);
});
test("termination requires a readable absence, never a killer success", async () => {
  expect(await identityTargetsGone([row(1)], async () => [row(1)])).toBe(false);
  expect(await identityTargetsGone([row(1)], async () => null)).toBe(false);
  expect(
    await identityTargetsGone([row(1)], async () => [row(1, 0, "reused")]),
  ).toBe(true);
});

test("a missing root cannot certify an already reparented tree", async () => {
  expect(await captureProcessTree(1, async () => [row(2)])).toBeNull();
});

test("Bun signal zero probes a live pid without terminating it, then detects its exit", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
  expect(() => process.kill(child.pid, 0)).toThrow();
});

test("missing creation identities cannot authorize kills or prove disappearance", async () => {
  let killed = false;
  expect(
    await signalIdentityTargets([row(1, 0, "")], "SIGKILL", {
      table: async () => [row(1, 0, "")],
      kill: () => {
        killed = true;
      },
    }),
  ).toBe(false);
  expect(killed).toBe(false);
  expect(await identityTargetsGone([row(1)], async () => [row(1, 0, "")])).toBe(
    false,
  );
});

test("a zombie identity can no longer act and counts as gone", async () => {
  expect(
    await identityTargetsGone([row(1)], async () => [
      { ...row(1), stat: "Z+" },
    ]),
  ).toBe(true);
});

test("an exited leader does not prevent stopping registered identities, but remains unconfirmed", async () => {
  let rows = [row(2), row(3, 2)];
  const killed: number[] = [];
  const result = await stopWindowsTree(1, 0, "scope", () => false, {
    table: async () => rows,
    registryRoots: () => [{ pid: 2, start: "old" }],
    kill: (pid) => {
      killed.push(pid);
      rows = rows.filter((value) => value.pid !== pid);
    },
  });
  expect(result).toBe(false);
  expect(killed).toEqual([3, 2]);
});

test("per-identity verification stops when its aggregate budget is spent", async () => {
  let now = 0,
    reads = 0;
  const confirmed = await signalIdentityTargets(
    Array.from({ length: 100 }, (_, index) => row(index + 1)),
    "SIGKILL",
    {
      now: () => now,
      deadline: 10_000,
      table: async () => {
        reads++;
        now += 5000;
        return null;
      },
      kill: () => {
        throw new Error("unknown identity cannot authorize a kill");
      },
    },
  );
  expect(confirmed).toBe(false);
  expect(reads).toBe(2);
});

test("a first snapshot after leader exit cannot adopt a recycled pid", async () => {
  let owned = true;
  const killed: number[] = [];
  expect(
    await stopWindowsTree(1, 0, undefined, () => owned, {
      table: async () => {
        owned = false;
        return [row(1, 0, "stranger"), row(2, 1)];
      },
      kill: (pid) => {
        killed.push(pid);
      },
    }),
  ).toBe(false);
  expect(killed).toEqual([]);
});

test("established descendants remain actionable after their leader exits", async () => {
  const state = {
    root: { pid: 1, start: "old" },
    targets: [row(1), row(2, 1)],
  };
  let rows = [row(2)];
  const killed: number[] = [];
  expect(
    await stopWindowsTree(1, 0, undefined, () => false, {
      state,
      table: async () => rows,
      kill: (pid) => {
        killed.push(pid);
        rows = [];
      },
    }),
  ).toBe(true);
  expect(killed).toEqual([2]);
});

test("an unknown registry does not prevent killing the known tree within its deadline", async () => {
  let now = 0;
  let rows = [row(1), row(2, 1)];
  const killed: number[] = [];
  const result = await stopWindowsTree(
    1,
    0,
    "scope",
    () => rows.some((value) => value.pid === 1),
    {
      now: () => now,
      timeoutMs: 1000,
      pause: async (ms) => {
        now += ms;
      },
      table: async () => rows,
      registryRoots: () => null,
      kill: (pid) => {
        killed.push(pid);
        rows = rows.filter((value) => value.pid !== pid);
      },
    },
  );
  expect(result).toBe(false);
  expect(killed).toEqual([2, 1]);
  expect(now).toBe(1000);
});

test("a transient first snapshot retries before resorting to an owned handle", async () => {
  let now = 0,
    reads = 0,
    fallback = 0;
  let rows = [row(1)];
  expect(
    await stopWindowsTree(1, 0, undefined, () => true, {
      now: () => now,
      timeoutMs: 1000,
      pause: async (ms) => {
        now += ms;
      },
      table: async () => (++reads === 1 ? null : rows),
      kill: () => {
        rows = [];
      },
      killOwned: () => {
        fallback++;
      },
    }),
  ).toBe(true);
  expect(reads).toBeGreaterThan(1);
  expect(fallback).toBe(0);
});

test("a reachable unknown child blocks confirmation while known identities are killed", async () => {
  let rows = [row(1), row(2, 1, "")];
  const killed: number[] = [];
  expect(
    await stopWindowsTree(
      1,
      0,
      undefined,
      () => rows.some((value) => value.pid === 1),
      {
        table: async () => rows,
        kill: (pid) => {
          killed.push(pid);
          rows = rows.filter((value) => value.pid !== pid);
        },
      },
    ),
  ).toBe(false);
  expect(killed).toEqual([1]);
});

test("known registered roots remain actionable beside an unresolved registration", async () => {
  let rows = [row(2)];
  const killed: number[] = [];
  let now = 0;
  expect(
    await stopWindowsTree(1, 0, "scope", () => false, {
      now: () => now,
      timeoutMs: 100,
      pause: async (ms) => {
        now += ms;
      },
      registrySnapshot: () => ({
        roots: [{ pid: 2, start: "old" }],
        complete: false,
      }),
      table: async () => rows,
      kill: (pid) => {
        killed.push(pid);
        rows = [];
      },
    }),
  ).toBe(false);
  expect(killed).toEqual([2]);
});

test("a partial registered tree remains unconfirmed after its runner exits", async () => {
  const state = { root: { pid: 1, start: "old" }, targets: [row(1)] };
  let rows = [row(2), row(3, 2, "")];
  let now = 0;
  const killed: number[] = [];
  expect(
    await stopWindowsTree(1, 0, "scope", () => false, {
      state,
      now: () => now,
      timeoutMs: 100,
      pause: async (ms) => {
        now += ms;
      },
      registryRoots: () => [{ pid: 2, start: "old" }],
      table: async () => rows,
      kill: (pid) => {
        killed.push(pid);
        rows = rows.filter((value) => value.pid !== pid);
      },
    }),
  ).toBe(false);
  expect(killed).toEqual([2]);
  now = 0;
  expect(
    await stopWindowsTree(1, 0, "scope", () => false, {
      state,
      now: () => now,
      timeoutMs: 100,
      pause: async (ms) => {
        now += ms;
      },
      registryRoots: () => [{ pid: 2, start: "old" }],
      table: async () => rows,
      kill: () => {
        throw new Error("no captured live identity remains");
      },
    }),
  ).toBe(false);
});

test("enumeration, per-target checks and witnessing share one cancellation deadline", async () => {
  let now = 0;
  let rows = Array.from({ length: 101 }, (_, index) =>
    row(index + 1, index === 0 ? 0 : 1),
  );
  const budgets: number[] = [];
  const killed: number[] = [];
  expect(
    await stopWindowsTree(1, 0, undefined, () => true, {
      now: () => now,
      timeoutMs: 12000,
      pause: async (ms) => {
        now += ms;
      },
      table: async (seconds) => {
        budgets.push(seconds ?? 0);
        now += Math.min(5000, (seconds ?? 0) * 1000);
        return rows;
      },
      kill: (pid) => {
        killed.push(pid);
        rows = rows.filter((value) => value.pid !== pid);
      },
    }),
  ).toBe(false);
  expect(budgets).toEqual([5, 5, 2]);
  expect(now).toBe(12000);
  expect(killed).toEqual([101]);
});

for (const registered of [false, true]) {
  test(`an unknown ${registered ? "registered" : "owned"} descendant stays uncertain after reparenting`, async () => {
    const leader = registered ? 2 : 1;
    let rows = [row(leader), row(3, leader), row(4, 3, "")];
    let now = 0;
    const killed: number[] = [];
    expect(
      await stopWindowsTree(
        1,
        1,
        registered ? "scope" : undefined,
        () => !registered && rows.some((value) => value.pid === 1),
        {
          state: {
            root: registered ? { pid: 1, start: "old" } : null,
            targets: registered ? [row(1)] : [],
          },
          now: () => now,
          timeoutMs: 200,
          pause: async (ms) => {
            now += ms;
            if (now === 1) rows = [row(leader), row(4, 0, "")];
          },
          registryRoots: () => [{ pid: leader, start: "old" }],
          table: async () => rows,
          kill: (pid) => {
            killed.push(pid);
            rows = rows.filter((value) => value.pid !== pid);
          },
        },
      ),
    ).toBe(false);
    expect(killed).toEqual([leader]);
    expect(rows.some((value) => value.pid === 4)).toBe(true);
  });
}

for (const naturallyExited of [true, false]) {
  test(`registered runner ${naturallyExited ? "natural disappearance requires completion proof" : "forced exit accepts captured identity witness"}`, async () => {
    let now = 0,
      reads = 0;
    let rows = [row(2)];
    const killed: number[] = [];
    expect(
      await stopWindowsTree(1, 0, "scope", () => false, {
        state: { root: { pid: 1, start: "old" }, targets: [row(1)] },
        now: () => now,
        timeoutMs: 100,
        pause: async (ms) => {
          now += ms;
        },
        registryRoots: () => [{ pid: 2, start: "old" }],
        table: async () => {
          if (naturallyExited && ++reads > 1) rows = [];
          return rows;
        },
        kill: (pid) => {
          killed.push(pid);
          rows = [];
        },
      }),
    ).toBe(!naturallyExited);
    expect(killed).toEqual(naturallyExited ? [] : [2]);
  });
}

test("an explicitly unwitnessed result blocks confirmation while known registered targets are killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unwitnessed-tree-"));
  const resultFile = join(dir, "result.json");
  writeFileSync(
    resultFile,
    JSON.stringify({ exitCode: 1, treeWitnessed: false }),
  );
  let rows = [row(2)],
    now = 0;
  const killed: number[] = [];
  try {
    expect(
      await stopWindowsTree(1, 0, "scope", () => false, {
        state: { root: { pid: 1, start: "old" }, targets: [row(1)] },
        now: () => now,
        timeoutMs: 100,
        pause: async (ms) => {
          now += ms;
        },
        registryRoots: () => [{ pid: 2, start: "old", resultFile }],
        table: async () => rows,
        kill: (pid) => {
          killed.push(pid);
          rows = [];
        },
      }),
    ).toBe(false);
    expect(killed).toEqual([2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const registered of [false, true]) {
  test(`an unknown ${registered ? "registered" : "owned"} ancestor never authorizes its readable grandchild`, async () => {
    const leader = registered ? 2 : 1;
    let rows = [row(leader), row(3, leader, ""), row(4, 3), row(5, leader)];
    let now = 0;
    const killed: number[] = [];
    expect(
      await stopWindowsTree(
        1,
        1,
        registered ? "scope" : undefined,
        () => !registered && rows.some((value) => value.pid === 1),
        {
          state: {
            root: registered ? { pid: 1, start: "old" } : null,
            targets: [],
          },
          now: () => now,
          timeoutMs: 200,
          pause: async (ms) => {
            now += ms;
            if (now === 1) rows = [row(leader), row(4, 0), row(5, leader)];
          },
          registryRoots: () => [{ pid: leader, start: "old" }],
          table: async () => rows,
          kill: (pid) => {
            killed.push(pid);
            rows = rows.filter((value) => value.pid !== pid);
          },
        },
      ),
    ).toBe(false);
    expect(killed).toEqual([5, leader]);
    expect(rows).toEqual([row(4, 0)]);
  });
}

for (const forced of [true, false]) {
  test(`successive registry drains retain ${forced ? "validated force proof" : "natural disappearance uncertainty"}`, async () => {
    const state: WindowsTreeState = { root: null, targets: [] };
    let rows = [row(2)];
    let now = 0;
    const control = {
      state,
      now: () => now,
      timeoutMs: 100,
      pause: async (ms: number) => {
        now += ms;
      },
      registryRoots: () => [{ pid: 2, start: "old" }],
      table: async () => rows,
      kill: () => {
        rows = [];
      },
    };
    if (!forced) {
      const { captureRegisteredTreeSnapshot } = await import(
        "../process-tree.ts"
      );
      await captureRegisteredTreeSnapshot("scope", control);
      rows = [];
    }
    const first = await reapRegisteredProcessTrees("scope", control);
    const second = await reapRegisteredProcessTrees("scope", control);
    expect(first.confirmed).toBe(forced);
    expect(second.confirmed).toBe(forced);
    expect(second.survived).toBe(!forced);
  });
}

test("a registration arriving during the final drain snapshot is forced before confirmation", async () => {
  let rows = [row(2)];
  let registryReads = 0;
  const killed: number[] = [];
  const state: WindowsTreeState = { root: null, targets: [] };
  const result = await reapRegisteredProcessTrees("scope", {
    state,
    registryRoots: () => {
      if (++registryReads === 2) rows = [row(3)];
      return rows.map((value) => ({ pid: value.pid, start: value.start }));
    },
    table: async () => {
      // The first root was forced and witnessed gone. New work becomes visible
      // during the final registry capture, before acquisition release.
      return rows;
    },
    kill: (pid) => {
      killed.push(pid);
      rows = rows.filter((value) => value.pid !== pid);
    },
  });
  expect(result.confirmed).toBe(true);
  expect(killed).toEqual([2, 3]);
  expect(rows).toEqual([]);
});
