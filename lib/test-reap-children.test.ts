import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ProcessRow } from "../plugin/shared/process-table.ts";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import { reapSurvivingDescendants } from "./test-reap-children.ts";

function row(pid: number, ppid: number, start = `start-${pid}`): ProcessRow {
  return { pid, ppid, pgid: pid, start, stat: "S", args: `p${pid}` };
}

test("kills every descendant of the process, deepest first, and nothing beside them", async () => {
  const rows = [
    row(1, 0),
    row(100, 1),
    row(101, 100),
    row(102, 101),
    row(200, 1),
    row(201, 200),
  ];
  const killed: [number, string][] = [];
  const report = await reapSurvivingDescendants(100, {
    table: async () => rows,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
    },
  });
  expect(report).toEqual({ signalled: [102, 101], unreadable: [] });
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
  const rows = [row(100, 1), row(101, 100, ""), row(102, 101), row(103, 100)];
  const killed: number[] = [];
  const report = await reapSurvivingDescendants(100, {
    table: async () => rows,
    kill: (pid) => {
      killed.push(pid);
    },
  });
  expect(report).toEqual({ signalled: [103], unreadable: [101, 102] });
  expect(killed).toEqual([103]);
});

// In a child process of its own, so the reap can take the child's whole tree
// without touching anything else this test process has running.
test("a real tree a test left behind is gone after the reap", async () => {
  const module = fileURLToPath(
    new URL("./test-reap-children.ts", import.meta.url),
  );
  const table = fileURLToPath(
    new URL("../plugin/shared/process-table.ts", import.meta.url),
  );
  const partition = fileURLToPath(
    new URL("../plugin/shared/process-uncertainty.ts", import.meta.url),
  );
  const idle = "setInterval(() => {}, 1000)";
  // A child that spawns a grandchild, both idling: the tree a fixture leaves.
  const childSource = `Bun.spawn([process.execPath, '-e', '${idle}'], { stdout: 'ignore', stderr: 'ignore' }); ${idle}`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
      import { reapSurvivingDescendants } from ${JSON.stringify(module)};
      import { processTable } from ${JSON.stringify(table)};
      import { partitionProcessTree } from ${JSON.stringify(partition)};
      const child = Bun.spawn(
        [process.execPath, "-e", ${JSON.stringify(childSource)}],
        { stdout: "ignore", stderr: "ignore" },
      );
      const deadline = Date.now() + 15_000;
      let tree = [];
      while (tree.length < 3 && Date.now() < deadline) {
        const rows = await processTable();
        tree = rows ? partitionProcessTree(process.pid, rows).targets : [];
        if (tree.length < 3) await Bun.sleep(50);
      }
      const report = await reapSurvivingDescendants(process.pid);
      console.log(JSON.stringify({ child: child.pid, seen: tree.length, report }));
      await child.exited;
    `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  const lines = result.stdout.toString().trim().split("\n");
  const { child, seen, report } = JSON.parse(lines.at(-1) ?? "") as {
    child: number;
    seen: number;
    report: { signalled: number[]; unreadable: number[] };
  };
  expect(seen).toBe(3);
  expect(report.signalled).toContain(child);
  expect(report.signalled.length).toBe(2);
  const deadline = Date.now() + 15_000;
  for (const pid of report.signalled) {
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }
});
