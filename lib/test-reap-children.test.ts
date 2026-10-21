import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  processTable,
  type ProcessRow,
} from "../plugin/shared/process-table.ts";
import { swallow } from "../plugin/shared/errors.ts";
import { identityTargetsGone } from "../plugin/shared/process-tree.ts";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import {
  captureDescendants,
  reapSurvivingDescendants,
} from "./test-reap-children.ts";

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
const tableModule = fileURLToPath(
  new URL("../plugin/shared/process-table.ts", import.meta.url),
);
const idle = "setInterval(() => {}, 1000)";

/**
 * In a child process of its own, so the reap can take that child's whole tree
 * without touching anything else this test process has running: a fixture
 * child that starts a grandchild, both idling. With `orphan`, the fixture
 * child is killed first, so init adopts the grandchild and only the capture
 * taken while the tree was whole still names it. The fixture's own cleanup
 * runs after the report is printed, so a broken reap fails the assertions
 * rather than leaving the tree behind.
 */
async function reapRealTree(orphan: boolean) {
  const childSource = `Bun.spawn([process.execPath, '-e', '${idle}'], { stdout: 'ignore', stderr: 'ignore' }); ${idle}`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      import { captureDescendants, reapSurvivingDescendants } from ${JSON.stringify(module)};
      import { processTable } from ${JSON.stringify(tableModule)};
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
        console.log(JSON.stringify({ child: child.pid, tree, report }));
      } finally {
        for (const { pid } of tree) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
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
  };
}

async function expectGone(tree: { pid: number; start: string }[]) {
  const deadline = Date.now() + 15_000;
  let gone = false;
  while (!gone && Date.now() < deadline) {
    gone = await identityTargetsGone(tree);
    if (!gone) await Bun.sleep(50);
  }
  expect(gone).toBe(true);
}

test("a real tree a test left behind is gone after the reap", async () => {
  const { child, tree, report } = await reapRealTree(false);
  expect(tree.length).toBe(2);
  expect(report.signalled).toContain(child);
  expect(report.signalled.length).toBe(2);
  expect(report.survived).toEqual([]);
  await expectGone(tree);
});

test("a real grandchild init adopted after its leader died is reaped through the capture", async () => {
  const { child, tree, report } = await reapRealTree(true);
  expect(tree.length).toBe(2);
  const grandchild = tree.find((identity) => identity.pid !== child);
  expect(report.signalled).toEqual([grandchild?.pid ?? -1]);
  expect(report.survived).toEqual([]);
  await expectGone(tree);
});

// Through `bun test` and the repository's bunfig.toml, so the preload's
// registration is what is tested, not the function it calls.
test("a test process run with the repository's preloads reaps the child its test leaked", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "jig-test-reap-"));
  const pidFile = join(dir, "pid");
  const probe = join(dir, "leak-probe.test.ts");
  writeFileSync(
    probe,
    `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("leaks an idle child", () => {
  const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(idle)}], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
});
`,
  );
  let pid = 0;
  try {
    const result = Bun.spawnSync([process.execPath, "test", probe], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    pid = Number(readFileSync(pidFile, "utf8"));
    expectSpawnExit(result, 0);
    expect(result.stderr.toString()).toContain(
      `test-reap: killed 1 process(es) a test left running (pid ${pid})`,
    );
    const deadline = Date.now() + 15_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      const rows = await processTable();
      alive =
        rows === null ||
        rows.some((r) => r.pid === pid && !r.stat.startsWith("Z"));
      if (alive) await Bun.sleep(50);
    }
    expect(alive).toBe(false);
  } finally {
    if (pid > 0)
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        swallow(error, "the leaked probe child is already gone");
      }
    rmSync(dir, { recursive: true, force: true });
  }
});
