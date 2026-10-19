import { expect, test } from "bun:test";
import {
  captureProcessTree,
  identityTargetsGone,
  signalIdentityTargets,
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
