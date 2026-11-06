/**
 * A real `jig send` whose reader is the dispatcher's tick wakes that
 * repository's tick when this machine dispatches it with the stage the tick
 * acts under: a detached waiter runs `dispatch --apply --repo <path>` (here
 * a stand-in that records its arguments, named by `JIG_WAKE_COMMAND`) and
 * exits, and sends made while that tick runs start no second one before the
 * minute is up. A mailbox directive, a dry run and a repository whose stage
 * this machine does not enable wake nothing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { waitFor } from "../../dispatch/__tests__/launch-fixtures.ts";
import { tickWakeDir } from "../../dispatch/lib/wake-tick.ts";
import {
  ledgerOn,
  pullRequest,
  REPO,
  runningLedger,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

interface WakeWorld extends SendWorld {
  /** The wake of the test repository's checkout. */
  wake: string;
  /** While this file exists the stand-in tick does not exit. */
  hold: string;
  /** The arguments of each tick the stand-in ran. */
  ticks(): string[][];
}

let current: WakeWorld | null = null;
afterEach(async () => {
  const w = current;
  current = null;
  if (w === null) return;
  rmSync(w.hold, { force: true });
  // A waiter still waiting for a trailing tick is stopped, so nothing outlives the world.
  const pid = waiterPid(w);
  if (pid !== null) {
    try {
      process.kill(pid);
    } catch {
      // It has exited already.
    }
    await waitFor("the waiter to exit", () => !answers(pid));
  }
  w.close();
});

function answers(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waiterPid(w: WakeWorld): number | null {
  const file = join(w.wake, "waiter");
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
}

const ADDRESS = `drive@${REPO}#12`;

function world(stages = "[rearm]"): WakeWorld {
  const w = sendWorld();
  const log = join(w.root, "ticks.jsonl");
  const hold = join(w.root, "hold-tick");
  const stub = join(w.root, "fake-tick.ts");
  writeFileSync(log, "");
  writeFileSync(
    stub,
    [
      `const fs = require("node:fs");`,
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `const until = Date.now() + 30_000;`,
      `while (fs.existsSync(${JSON.stringify(hold)}) && Date.now() < until) Bun.sleepSync(50);`,
      "",
    ].join("\n"),
  );
  w.env.JIG_WAKE_COMMAND = JSON.stringify([process.execPath, stub]);
  mkdirSync(join(w.home, ".jig"), { recursive: true });
  writeFileSync(
    join(w.home, ".jig", "dispatch.yaml"),
    `repositories:\n  - path: ${w.repo}\n    stages: ${stages}\n`,
  );
  pullRequest(w, 12, [], []);
  current = {
    ...w,
    wake: tickWakeDir(w.repo, w.state),
    hold,
    ticks: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string[]),
  };
  return current;
}

const runLog = (w: WakeWorld) => {
  const file = join(w.wake, "last-run.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const pending = (w: WakeWorld) => {
  const dir = join(w.wake, "pending");
  return existsSync(dir) ? readdirSync(dir).length : 0;
};

describe("jig send wakes the tick that reads its record", () => {
  it("follows a drive with a single-repository tick, then the waiter exits", async () => {
    const w = world();
    const r = await w.send([ADDRESS, "drive"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      `next       the dispatcher's tick for ${REPO}, woken now, which arms a drive on it`,
    );
    await waitFor("the woken tick", () => w.ticks().length === 1);
    expect(w.ticks()).toEqual([["dispatch", "--apply", "--repo", w.repo]]);
    await waitFor("the waiter to exit", () => waiterPid(w) === null);
    expect(pending(w)).toBe(0);
  });

  it("starts one tick for several sends within the minute", async () => {
    const w = world();
    writeFileSync(w.hold, "");
    const first = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(first, 0);
    expect(first.stdout).toContain("woken now");
    await waitFor("the woken tick", () => w.ticks().length === 1);
    const waiter = waiterPid(w);
    for (let i = 0; i < 2; i++) {
      const again = await w.send([ADDRESS, "hold"]);
      expectSpawnExit(again, 0);
      expect(again.stdout).toContain(
        `the dispatcher's tick for ${REPO}, woken to start when idle, at least a minute after the last start`,
      );
    }
    // One waiter holds all three; the running tick took the first and removes it when it ends.
    expect(pending(w)).toBe(3);
    expect(waiterPid(w)).toBe(waiter);
    expect(w.ticks()).toHaveLength(1);
    // Bring the next due time close while retaining a real detached sleep.
    writeFileSync(join(w.wake, "started"), String(Date.now() - 59_000));
    rmSync(w.hold);
    await waitFor("the first tick to end", () =>
      runLog(w).includes("exited 0"),
    );
    // The requests sent while it ran are consumed by one trailing tick.
    await waitFor("the trailing tick", () => w.ticks().length === 2, 5000);
    expect(w.ticks()).toEqual([
      ["dispatch", "--apply", "--repo", w.repo],
      ["dispatch", "--apply", "--repo", w.repo],
    ]);
    await waitFor("the waiter to exit", () => waiterPid(w) === null);
    expect(pending(w)).toBe(0);
    expect(w.ticks()).toHaveLength(2);
    expect(waiter).not.toBeNull();
    await waitFor(
      "the detached waiter process to exit",
      () => !answers(waiter as number),
    );
  }, 15_000);
});

describe("jig send wakes no tick", () => {
  it("wakes nothing for a mailbox directive or a dry run", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, runningLedger(12))]);
    w.liveDriver(12, 3);
    const directive = await w.send([ADDRESS, "stop"]);
    expectSpawnExit(directive, 0);
    expect(directive.stdout).not.toContain("woken");
    const dry = await w.send([ADDRESS, "hold", "--dry-run"]);
    expectSpawnExit(dry, 0);
    expect(existsSync(w.wake)).toBe(false);
    expect(w.ticks()).toEqual([]);
  });

  it("wakes nothing where this machine does not enable the stage the tick acts under", async () => {
    const w = world("[pickup]");
    const label = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(label, 0);
    expect(label.stdout).toContain(
      "next       the dispatcher's next tick, which keeps",
    );
    expect(existsSync(w.wake)).toBe(false);
    expect(w.ticks()).toEqual([]);
  });
});
