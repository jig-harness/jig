import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { spendFirstSpawn } from "./first-spawn.ts";

// A fake child, because whether the runtime loses a real child's events is
// what this helper absorbs, not something a test can choose.
function fakeChild(): ChildProcess & { unrefs: number } {
  const child = Object.assign(new EventEmitter(), {
    unrefs: 0,
    unref() {
      child.unrefs++;
    },
  });
  return child as unknown as ChildProcess & { unrefs: number };
}

describe("spendFirstSpawn", () => {
  test("starts this runtime once and resolves when the child closes", async () => {
    const child = fakeChild();
    const started: string[][] = [];
    const outcome = spendFirstSpawn(60_000, (command, args) => {
      started.push([command, ...args]);
      return child;
    });
    child.emit("close", 0);
    expect(await outcome).toBe("closed");
    expect(started).toEqual([[process.execPath, "--version"]]);
    expect(child.unrefs).toBe(0);
  });

  test("a child that fails to start settles it too", async () => {
    const child = fakeChild();
    const outcome = spendFirstSpawn(60_000, () => child);
    child.emit("error", new Error("spawn failed"));
    expect(await outcome).toBe("closed");
  });

  test("a lost close ends the wait at the bound and releases the child", async () => {
    const child = fakeChild();
    expect(await spendFirstSpawn(1, () => child)).toBe("lost");
    expect(child.unrefs).toBe(1);
  });
});
