import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessRow } from "../plugin/shared/process-table.ts";
import {
  captureProcessTree,
  identityTargetsGone,
  signalIdentityTargets,
} from "../plugin/shared/process-tree.ts";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "./test-helpers/windows-skip.ts";
import {
  captureDescendants,
  identityOf,
  reapIdentities,
  reapOwnedIdentities,
  recordDescendants,
  reapSurvivingDescendants,
} from "./test-reap-children.ts";

/**
 * Bun spawns its children on Windows inside a job object that ends them when
 * their parent exits, so a grandchild dies with its leader and none is ever
 * orphaned for the reap to find.
 */
const orphanTest = test.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "a Bun child's children end with it on Windows, so no grandchild is orphaned",
  ),
);

function row(pid: number, ppid: number, start = `start-${pid}`): ProcessRow {
  return { pid, ppid, pgid: pid, start, stat: "S", args: `p${pid}` };
}

/** A process table a SIGKILL takes the process out of, as the kernel does. */
function killable(rows: ProcessRow[]) {
  const killed: [number, string][] = [];
  return {
    killed,
    deps: {
      table: async () => rows.map((r) => ({ ...r })),
      kill: (pid: number, signal: NodeJS.Signals) => {
        killed.push([pid, signal]);
        rows.splice(
          rows.findIndex((r) => r.pid === pid),
          1,
        );
      },
    },
  };
}

test("kills every descendant of the process, deepest first, and nothing beside them", async () => {
  const { killed, deps } = killable([
    row(1, 0),
    row(100, 1),
    row(101, 100),
    row(102, 101),
    row(200, 1),
    row(201, 200),
  ]);
  const report = await reapSurvivingDescendants(100, deps);
  expect(report).toEqual({
    signalled: [102, 101],
    unreadable: [],
    survived: [],
  });
  expect(killed).toEqual([
    [102, "SIGKILL"],
    [101, "SIGKILL"],
  ]);
});

test("an unreadable process table reaps nothing and says so", async () => {
  let killed = false;
  expect(
    await reapSurvivingDescendants(100, {
      table: async () => null,
      kill: () => {
        killed = true;
      },
    }),
  ).toBeNull();
  expect(killed).toBe(false);
});

test("a descendant whose identity cannot be read is left alone, with its own descendants, and reported", async () => {
  const { killed, deps } = killable([
    row(100, 1),
    row(101, 100, ""),
    row(102, 101),
    row(103, 100),
  ]);
  const report = await reapSurvivingDescendants(100, deps);
  expect(report).toEqual({
    signalled: [103],
    unreadable: [101, 102],
    survived: [],
  });
  expect(killed.map(([pid]) => pid)).toEqual([103]);
});

test("a captured descendant init adopted is killed with its own descendants; a reused pid is not", async () => {
  const { killed, deps } = killable([
    row(1, 0),
    row(100, 1),
    row(300, 1),
    row(301, 300),
    row(400, 1, "start-reused"),
  ]);
  const report = await reapSurvivingDescendants(100, deps, [
    { pid: 300, start: "start-300" },
    { pid: 400, start: "start-400" },
    { pid: 500, start: "start-500" },
  ]);
  expect(report).toEqual({
    signalled: [301, 300],
    unreadable: [],
    survived: [],
  });
  expect(killed.map(([pid]) => pid)).toEqual([301, 300]);
});

test("a reap of named identities kills each live one with its descendants, and no process it was not named", async () => {
  const { killed, deps } = killable([
    row(1, 0),
    row(300, 1),
    row(301, 300),
    row(400, 1, "start-reused"),
    row(500, 1),
  ]);
  const report = await reapIdentities(
    [
      { pid: 300, start: "start-300" },
      { pid: 400, start: "start-400" },
    ],
    deps,
  );
  expect(report).toEqual({
    signalled: [301, 300],
    unreadable: [],
    survived: [],
  });
  expect(killed.map(([pid]) => pid)).toEqual([301, 300]);
});

for (const order of [
  [301, 300],
  [300, 301],
]) {
  test(`overlapping named identities are killed deepest first, named in the order ${order.join(", ")}`, async () => {
    const { killed, deps } = killable([
      row(1, 0),
      row(300, 1),
      row(301, 300),
      row(302, 301),
    ]);
    const report = await reapIdentities(
      order.map((pid) => ({ pid, start: `start-${pid}` })),
      deps,
    );
    expect(report).toEqual({
      signalled: [302, 301, 300],
      unreadable: [],
      survived: [],
    });
    expect(killed.map(([pid]) => pid)).toEqual([302, 301, 300]);
  });
}

test("a named identity below an unreadable named ancestor is still killed, with its descendants", async () => {
  const { killed, deps } = killable([
    row(1, 0),
    row(300, 1, ""),
    row(301, 300),
    row(302, 301),
  ]);
  const report = await reapIdentities(
    [
      { pid: 300, start: "start-300" },
      { pid: 301, start: "start-301" },
    ],
    deps,
  );
  expect(report).toEqual({
    signalled: [302, 301],
    unreadable: [300],
    survived: [],
  });
  expect(killed.map(([pid]) => pid)).toEqual([302, 301]);
});

test("an identity is read from a live row; no live row is null, and an unreadable one throws", async () => {
  const table = async () => [
    row(100, 1),
    { ...row(101, 1), stat: "Z" },
    row(102, 1, ""),
  ];
  expect(await identityOf(100, table)).toEqual({
    pid: 100,
    start: "start-100",
  });
  expect(await identityOf(101, table)).toBeNull();
  expect(await identityOf(103, table)).toBeNull();
  await expect(identityOf(102, table)).rejects.toThrow(
    "creation identity of pid 102",
  );
  await expect(identityOf(100, async () => null)).rejects.toThrow(
    "process table could not be read",
  );
});

test("a reap of owned identities fails unless every process is witnessed gone", async () => {
  const { deps } = killable([row(1, 0), row(300, 1), row(301, 300)]);
  expect(
    await reapOwnedIdentities([{ pid: 300, start: "start-300" }], deps),
  ).toEqual({ signalled: [301, 300], unreadable: [], survived: [] });
  await expect(
    reapOwnedIdentities([{ pid: 300, start: "start-300" }], {
      table: async () => null,
    }),
  ).rejects.toThrow("process table could not be read");
  const unreadable = killable([row(1, 0), row(300, 1), row(301, 300, "")]);
  await expect(
    reapOwnedIdentities([{ pid: 300, start: "start-300" }], unreadable.deps),
  ).rejects.toThrow("unreadable [301]");
  const rows = [row(1, 0), row(300, 1)];
  await expect(
    reapOwnedIdentities([{ pid: 300, start: "start-300" }], {
      table: async () => rows,
      kill: () => undefined,
      timeoutMs: 50,
      pause: async () => undefined,
    }),
  ).rejects.toThrow("survived [300]");
});

test("a captured identity whose row has become unreadable is reported, not dropped, and not signalled", async () => {
  const { killed, deps } = killable([
    row(1, 0),
    row(100, 1),
    row(300, 1, ""),
    row(301, 300),
  ]);
  const report = await reapSurvivingDescendants(100, deps, [
    { pid: 300, start: "start-300" },
  ]);
  expect(report).toEqual({
    signalled: [],
    unreadable: [300, 301],
    survived: [],
  });
  expect(killed).toEqual([]);
});

test("every process-table read is bounded by what is left of the deadline, and none starts after it", async () => {
  let clock = 0;
  const realNow = Date.now;
  const timeouts: (number | undefined)[] = [];
  const rows = [row(100, 1), row(101, 100)];
  Date.now = () => clock;
  try {
    const report = await reapSurvivingDescendants(100, {
      table: async (timeoutSec) => {
        timeouts.push(timeoutSec);
        clock += 1_500;
        return rows;
      },
      kill: () => undefined,
      timeoutMs: 4_000,
      pause: async () => undefined,
    });
    expect(report?.survived).toEqual([101]);
  } finally {
    Date.now = realNow;
  }
  expect(clock).toBeLessThanOrEqual(4_000 + 1_500);
  expect(timeouts[0]).toBe(4);
  for (const [i, timeout] of timeouts.entries())
    expect(timeout).toBeLessThanOrEqual(Math.max(0, 4 - i * 1.5));
  for (const timeout of timeouts) expect(timeout).toBeGreaterThan(0);
});

test("a record drops the identities a table shows gone and keeps unreadable ones", async () => {
  const captured = new Map([
    ["200:start-200", { pid: 200, start: "start-200" }],
    ["201:start-201", { pid: 201, start: "start-201" }],
    ["202:start-202", { pid: 202, start: "start-202" }],
    ["203:start-203", { pid: 203, start: "start-203" }],
    ["204:start-204", { pid: 204, start: "start-204" }],
  ]);
  const rows = [
    row(100, 1),
    row(101, 100),
    row(200, 1),
    row(201, 1, "start-reused"),
    { ...row(202, 1), stat: "Z" },
    row(203, 1, ""),
  ];
  expect(await recordDescendants(100, captured, async () => rows)).toBe(true);
  expect([...captured.keys()].sort()).toEqual([
    "101:start-101",
    "200:start-200",
    "203:start-203",
  ]);
  expect(await recordDescendants(100, captured, async () => null)).toBe(false);
  expect(captured.size).toBe(3);
});

test("a target still alive at the deadline is reported, not passed over", async () => {
  const rows = [row(100, 1), row(101, 100)];
  const report = await reapSurvivingDescendants(100, {
    table: async () => rows,
    kill: () => undefined,
    timeoutMs: 50,
    pause: async () => undefined,
  });
  expect(report).toEqual({ signalled: [101], unreadable: [], survived: [101] });
});

test("a killed target left as a zombie counts as gone", async () => {
  const rows = [row(100, 1), row(101, 100)];
  const report = await reapSurvivingDescendants(100, {
    table: async () => rows.map((r) => ({ ...r })),
    kill: (pid) => {
      const target = rows.find((r) => r.pid === pid);
      if (target) target.stat = "Z";
    },
    timeoutMs: 5_000,
  });
  expect(report).toEqual({ signalled: [101], unreadable: [], survived: [] });
});

test("the capture names readable descendants only, not the process itself", async () => {
  const rows = [row(100, 1), row(101, 100), row(102, 100, ""), row(103, 102)];
  expect(await captureDescendants(100, async () => rows)).toEqual([
    { pid: 101, start: "start-101" },
  ]);
  expect(await captureDescendants(100, async () => null)).toBeNull();
});

const module = fileURLToPath(
  new URL("./test-reap-children.ts", import.meta.url),
);
const treeModule = fileURLToPath(
  new URL("../plugin/shared/process-tree.ts", import.meta.url),
);
const tableModule = fileURLToPath(
  new URL("../plugin/shared/process-table.ts", import.meta.url),
);
const idle = "setInterval(() => {}, 1000)";

/**
 * In a child process of its own, so the reap can take that child's whole tree
 * without touching anything else this test process has running: a fixture
 * child that starts a grandchild, both idling. With `orphan`, the fixture
 * child is killed first, so init adopts the grandchild and only the capture
 * taken while the tree was whole still names it. Whether the tree is gone is
 * observed right after the reap, before the fixture's own cleanup runs, so
 * the cleanup can neither stand in for the reap nor leave the tree behind.
 */
async function reapRealTree(orphan: boolean) {
  const childSource = `Bun.spawn([process.execPath, '-e', '${idle}'], { stdout: 'ignore', stderr: 'ignore' }); ${idle}`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      import { captureDescendants, reapSurvivingDescendants } from ${JSON.stringify(module)};
      import { identityTargetsGone, signalIdentityTargets } from ${JSON.stringify(treeModule)};
      const child = Bun.spawn(
        [process.execPath, "-e", ${JSON.stringify(childSource)}],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      let tree = [];
      while (tree.length < 2 && Date.now() < deadline) {
        tree = (await captureDescendants(process.pid)) ?? [];
        if (tree.length < 2) await Bun.sleep(50);
      }
      try {
        if (${orphan}) {
          child.kill("SIGKILL");
          await child.exited;
        }
        const report = await reapSurvivingDescendants(process.pid, {}, tree);
        const goneBy = Date.now() + 5_000;
        let gone = await identityTargetsGone(tree);
        while (!gone && Date.now() < goneBy) {
          await Bun.sleep(50);
          gone = await identityTargetsGone(tree);
        }
        console.log(JSON.stringify({ child: child.pid, tree, report, gone }));
      } finally {
        await signalIdentityTargets(tree, "SIGKILL");
      }
    `,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" },
  );
  expectSpawnExit(result, 0);
  const lines = result.stdout.toString().trim().split("\n");
  return JSON.parse(lines.at(-1) ?? "") as {
    child: number;
    tree: { pid: number; start: string }[];
    report: { signalled: number[]; unreadable: number[]; survived: number[] };
    gone: boolean;
  };
}

test("a real tree a test left behind is gone after the reap", async () => {
  const { child, tree, report, gone } = await reapRealTree(false);
  expect(tree.length).toBe(2);
  expect(report.signalled).toContain(child);
  expect(report.signalled.length).toBe(2);
  expect(report.survived).toEqual([]);
  expect(gone).toBe(true);
});

orphanTest(
  "a real grandchild init adopted after its leader died is reaped through the capture",
  async () => {
    const { child, tree, report, gone } = await reapRealTree(true);
    expect(tree.length).toBe(2);
    const grandchild = tree.find((identity) => identity.pid !== child);
    expect(report.signalled).toEqual([grandchild?.pid ?? -1]);
    expect(report.survived).toEqual([]);
    expect(gone).toBe(true);
  },
);

type Identity = { pid: number; start: string };

/**
 * Run `bun test` on one probe file with the repository's bunfig.toml, so the
 * preload's registration is what is tested, not the function it calls. The
 * probe writes the identity of the process it leaves behind to the file it is
 * given. Every process the probe run had is also owned here, whatever the
 * preload under test did: the identities the probe writes to the owned file
 * before it relies on the preload, and those captured from outside while the
 * run lasts. All of them are killed by identity afterwards, never by bare
 * pid, so a pid the system has since reused is left alone.
 */
async function withProbe(
  source: (identityFile: string, dir: string, ownedFile: string) => string,
  check: (stderr: string, identity: Identity) => Promise<void>,
) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "jig-test-reap-"));
  const identityFile = join(dir, "identity.json");
  const ownedFile = join(dir, "owned.json");
  const probe = join(dir, "probe.test.ts");
  writeFileSync(probe, source(identityFile, dir, ownedFile));
  const owned = new Map<string, Identity>();
  let identity: Identity | undefined;
  const run = Bun.spawn([process.execPath, "test", probe], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  const output = Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  try {
    // The run's pid names the run only while its handle is unreaped; a
    // snapshot read later may find a process that reused it. The run's
    // creation identity is bound from a snapshot that finished while the
    // handle was still live, and a snapshot is owned only when its root
    // carries that identity.
    const live = () => run.exitCode === null && run.signalCode === null;
    const done = run.exited;
    let rootStart: string | undefined;
    while (live()) {
      const rows = await captureProcessTree(run.pid);
      const root = rows?.find((row) => row.pid === run.pid);
      if (rootStart === undefined && root?.start && live())
        rootStart = root.start;
      if (rows && root && root.start === rootStart)
        for (const row of rows)
          owned.set(`${row.pid}:${row.start}`, {
            pid: row.pid,
            start: row.start,
          });
      await Promise.race([done, Bun.sleep(100)]);
    }
    await done;
    const [stdout, stderr] = await output;
    if (existsSync(identityFile))
      identity = JSON.parse(readFileSync(identityFile, "utf8")) as Identity;
    expectSpawnExit({ exitCode: run.exitCode, stdout, stderr }, 0);
    if (!identity) throw new Error("the probe recorded no identity");
    await check(stderr, identity);
  } finally {
    run.kill("SIGKILL");
    await run.exited;
    const recorded = existsSync(ownedFile)
      ? (JSON.parse(readFileSync(ownedFile, "utf8")) as Identity[])
      : [];
    for (const target of [...recorded, ...(identity ? [identity] : [])])
      owned.set(`${target.pid}:${target.start}`, target);
    await signalIdentityTargets([...owned.values()], "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a test process run with the repository's preloads reaps the child its test leaked", async () => {
  await withProbe(
    (identityFile) => `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { processTable } from ${JSON.stringify(tableModule)};
test("leaks an idle child", async () => {
  const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(idle)}], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 15_000;
  let start = "";
  while (start === "" && Date.now() < deadline) {
    start = (await processTable())?.find((r) => r.pid === child.pid)?.start ?? "";
    if (start === "") await Bun.sleep(50);
  }
  if (start === "") throw new Error("the leaked child's identity could not be read");
  writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({ pid: child.pid, start }));
}, 30_000);
`,
    async (stderr, identity) => {
      expect(stderr).toContain(
        `test-reap: killed 1 process(es) a test left running (pid ${identity.pid})`,
      );
      const deadline = Date.now() + 15_000;
      let gone = await identityTargetsGone([identity]);
      while (!gone && Date.now() < deadline) {
        await Bun.sleep(50);
        gone = await identityTargetsGone([identity]);
      }
      expect(gone).toBe(true);
    },
  );
}, 90_000);

// A tree that outlives the capture interval inside one test, whose leader the
// test kills before returning: only a capture taken while the test ran still
// names the grandchild init adopted. The probe kills the leader once the
// preload's own record names the grandchild, which its interval capture does
// while the test waits. It records both fixtures' identities from the process
// table first, so they are cleaned up even when the preload is missing.
orphanTest(
  "a test process run with the repository's preloads reaps a grandchild orphaned before its test returned",
  async () => {
    await withProbe(
      (identityFile, dir, ownedFile) => {
        const pidFile = join(dir, "grandchild");
        const childSource = `const g = Bun.spawn([process.execPath, '-e', '${idle}'], { stdout: 'ignore', stderr: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); ${idle}`;
        return `import { test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { processTable } from ${JSON.stringify(tableModule)};
test("orphans a grandchild", async () => {
  const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childSource)}], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 20_000;
  let pid = 0;
  let owned = [];
  while (owned.length < 2 && Date.now() < deadline) {
    pid = existsSync(${JSON.stringify(pidFile)}) ? Number(readFileSync(${JSON.stringify(pidFile)}, "utf8")) : 0;
    owned = ((await processTable()) ?? [])
      .filter((r) => (r.pid === child.pid || (pid > 0 && r.pid === pid)) && r.start !== "")
      .map((r) => ({ pid: r.pid, start: r.start }));
    if (owned.length < 2) await Bun.sleep(50);
  }
  writeFileSync(${JSON.stringify(ownedFile)}, JSON.stringify(owned));
  if (owned.length < 2) throw new Error("the fixtures' identities could not be read");
  const captured = globalThis[Symbol.for("jig.test-reap.captured")];
  let identity;
  while (!identity && Date.now() < deadline) {
    identity = captured().find((captured) => captured.pid === pid);
    if (!identity) await Bun.sleep(50);
  }
  if (!identity) throw new Error("no capture named the grandchild");
  writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify(identity));
  child.kill("SIGKILL");
  await child.exited;
}, 30_000);
`;
      },
      async (stderr, identity) => {
        expect(stderr).toContain(
          `test-reap: killed 1 process(es) a test left running (pid ${identity.pid})`,
        );
      },
    );
  },
  90_000,
);
