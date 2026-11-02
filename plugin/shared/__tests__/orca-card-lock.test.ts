import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { cardLockPath, withCardLock } from "../orca-card-lock.ts";

const WORKSPACE = "/ws/app/feat-x";

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "orca-card-lock-"));
}

/** A pid that has exited: a child run to completion. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return child.pid;
}

describe("the card's comment lock", () => {
  test("holds one writer at a time on a card, and releases on the way out", async () => {
    const root = scratchRoot();
    const order: string[] = [];
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: holding, resolve: taken } = Promise.withResolvers<void>();
    const first = withCardLock(
      WORKSPACE,
      async () => {
        taken();
        await held;
        order.push("first");
      },
      { root },
    );
    await holding;
    const second = withCardLock(
      WORKSPACE,
      async () => {
        order.push("second");
      },
      { root, waitMs: 5000 },
    );
    release();
    expect(await first).toEqual({ value: undefined });
    expect(await second).toEqual({ value: undefined });
    expect(order).toEqual(["first", "second"]);
    expect(existsSync(cardLockPath(WORKSPACE, root))).toBe(false);
  });

  test("never makes writers on two cards wait for each other", async () => {
    const root = scratchRoot();
    const inner = await withCardLock(
      WORKSPACE,
      () => withCardLock("/ws/app/other", async () => "both", { root }),
      { root, waitMs: 100 },
    );
    expect(inner).toEqual({ value: { value: "both" } });
  });

  test("gives up after its deadline while a live writer holds the card", async () => {
    const root = scratchRoot();
    writeFileSync(cardLockPath(WORKSPACE, root), `${process.pid}\nrival\n`);
    let ran = false;
    const result = await withCardLock(
      WORKSPACE,
      async () => {
        ran = true;
      },
      { root, waitMs: 150 },
    );
    expect(result).toBeNull();
    expect(ran).toBe(false);
    expect(existsSync(cardLockPath(WORKSPACE, root))).toBe(true);
  });

  test("reclaims a lock its owner left behind when it exited", async () => {
    const root = scratchRoot();
    writeFileSync(cardLockPath(WORKSPACE, root), `${deadPid()}\nleft\n`);
    expect(
      await withCardLock(WORKSPACE, async () => "taken", {
        root,
        waitMs: 1000,
      }),
    ).toEqual({ value: "taken" });
  });

  test("keys a card by its resolved path", () => {
    expect(cardLockPath("/ws/app/feat-x/", "/r")).toBe(
      cardLockPath("/ws/app/feat-x", "/r"),
    );
    expect(cardLockPath("/ws/app/a", "/r")).not.toBe(
      cardLockPath("/ws/app/b", "/r"),
    );
  });
});
