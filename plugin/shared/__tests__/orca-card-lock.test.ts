import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

  test("takes a lock left empty by an interrupted writer only once it is stale", async () => {
    // An acquisition publishes the owner record whole, so a lock file is
    // never seen empty by this implementation; a file left empty by an
    // older writer names no owner and is not reclaimed on a guess.
    const root = scratchRoot();
    writeFileSync(cardLockPath(WORKSPACE, root), "");
    expect(
      await withCardLock(WORKSPACE, async () => "taken", { root, waitMs: 100 }),
    ).toBeNull();
  });

  test("leaves no staged file behind after acquiring and releasing", async () => {
    const root = scratchRoot();
    await withCardLock(WORKSPACE, async () => "x", { root });
    expect(readdirSync(root)).toEqual([]);
  });

  test("two reclaimers of one stale lock never both hold the card", async () => {
    const root = scratchRoot();
    writeFileSync(cardLockPath(WORKSPACE, root), `${deadPid()}\nleft\n`);
    let inside = 0;
    let overlap = false;
    const writer = () =>
      withCardLock(
        WORKSPACE,
        async () => {
          inside += 1;
          if (inside > 1) overlap = true;
          await new Promise((done) => setTimeout(done, 40));
          inside -= 1;
        },
        { root, waitMs: 5000 },
      );
    const results = await Promise.all([writer(), writer(), writer(), writer()]);
    expect(results.every((r) => r !== null)).toBe(true);
    expect(overlap).toBe(false);
  });

  test("does not break the reclaim mutex of a reclaimer that is still running, however old", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    writeFileSync(lock, `${deadPid()}\nleft\n`);
    const mutex = `${lock}.reclaim`;
    writeFileSync(mutex, `${process.pid}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(mutex, old, old);
    expect(
      await withCardLock(WORKSPACE, async () => "taken", { root, waitMs: 300 }),
    ).toBeNull();
    expect(existsSync(mutex)).toBe(true);
  });

  test("breaks the reclaim mutex of a reclaimer that exited", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    writeFileSync(lock, `${deadPid()}\nleft\n`);
    writeFileSync(`${lock}.reclaim`, `${deadPid()}\n`);
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
