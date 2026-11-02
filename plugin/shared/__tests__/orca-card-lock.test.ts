import { describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

  test("separate processes contending for a stale lock lose no read-modify-write", async () => {
    const root = scratchRoot();
    const counter = join(root, "counter");
    writeFileSync(counter, "0");
    writeFileSync(cardLockPath(WORKSPACE, root), `${deadPid()}\nleft\n`);
    const script = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { withCardLock } from ${JSON.stringify(join(import.meta.dir, "../orca-card-lock.ts"))};
      for (let i = 0; i < 15; i++) {
        const got = await withCardLock(${JSON.stringify(WORKSPACE)}, async () => {
          const n = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
          await new Promise((done) => setTimeout(done, 2));
          writeFileSync(${JSON.stringify(counter)}, String(n + 1));
        }, { root: ${JSON.stringify(root)}, waitMs: 30000 });
        if (got === null) process.exit(3);
      }
    `;
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (const child of children) {
      const exitCode = await child.exited;
      expectSpawnExit(
        {
          exitCode,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        },
        0,
      );
    }
    expect(readFileSync(counter, "utf8")).toBe("60");
  });

  test("a reclaim mutex held by a live reclaimer is left alone, one whose reclaimer is gone is superseded by the next generation", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    const stale = `${deadPid()}\nleft\n`;
    writeFileSync(lock, stale);
    const id = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    const mutex = `${lock}.reclaim-${id}-1`;
    writeFileSync(mutex, `${process.pid}\nrival\n`);
    expect(
      await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 150 }),
    ).toBeNull();
    expect(readFileSync(mutex, "utf8")).toBe(`${process.pid}\nrival\n`);
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(mutex, old, old);
    expect(
      await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 150 }),
    ).toBeNull();
    writeFileSync(mutex, `${deadPid()}\nrival\n`);
    expect(
      await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 2000 }),
    ).toEqual({ value: "x" });
    expect(readdirSync(root)).toEqual([]);
  });

  test("recovery over a long chain of abandoned mutexes stops at the caller's deadline", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    const stale = `${deadPid()}\nleft\n`;
    writeFileSync(lock, stale);
    const id = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    const dead = deadPid();
    for (let generation = 1; generation <= 300; generation++)
      writeFileSync(`${lock}.reclaim-${id}-${generation}`, `${dead}\nx\n`);
    const before = readdirSync(root).sort();
    expect(
      await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 0 }),
    ).toBeNull();
    expect(readdirSync(root).sort()).toEqual(before);
  });

  test("recovery whose budget runs out part-way through the chain stops walking and removes nothing", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    const stale = `${deadPid()}\nleft\n`;
    writeFileSync(lock, stale);
    const id = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    const dead = deadPid();
    for (let generation = 1; generation <= 300; generation++)
      writeFileSync(`${lock}.reclaim-${id}-${generation}`, `${dead}\nx\n`);
    const before = readdirSync(root).sort();
    const real = performance.now.bind(performance);
    const start = real();
    // The budget is open for the deadline and the first generations, then spent.
    let reads = 0;
    const clock = spyOn(performance, "now").mockImplementation(() =>
      ++reads <= 6 ? start : start + 10_000,
    );
    try {
      expect(
        await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 1000 }),
      ).toBeNull();
    } finally {
      clock.mockRestore();
    }
    expect(readdirSync(root).sort()).toEqual(before);
  });

  test("the sweep after a reclaim leaves a live publisher's staging file alone and removes a dead one's", async () => {
    const root = scratchRoot();
    const lock = cardLockPath(WORKSPACE, root);
    const stale = `${deadPid()}\nleft\n`;
    writeFileSync(lock, stale);
    const id = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    const live = `${lock}.reclaim-${id}-2.init-${process.pid}-abc`;
    writeFileSync(live, "staging");
    writeFileSync(`${lock}.reclaim-${id}-2.init-${deadPid()}-def`, "staging");
    await withCardLock(WORKSPACE, async () => "x", { root, waitMs: 1000 });
    expect(readdirSync(root)).toEqual([live.slice(root.length + 1)]);
  });

  test("reclaiming a dead owner's lock leaves nothing behind", async () => {
    const root = scratchRoot();
    writeFileSync(cardLockPath(WORKSPACE, root), `${deadPid()}\nleft\n`);
    await withCardLock(WORKSPACE, async () => "taken", { root, waitMs: 1000 });
    expect(readdirSync(root)).toEqual([]);
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
