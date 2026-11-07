/**
 * The wake's rule, on a clock the test holds: requests made before a run
 * starts are taken by that one run; a request made while it runs starts one
 * trailing run a minute after it started; a run is spaced a minute from the
 * last start; a refused run keeps its requests and is retried after the
 * minute, up to the bound; one waiter holds a wake at a time, and one whose
 * process is gone is replaced.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import { encodeIdentity, lockIdentity } from "../liveness.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import {
  lastStart,
  pendingRequests,
  requestReasons,
  requestWake,
  WAKE_ATTEMPTS,
  WAKE_SPACING_MS,
  waitAndRun,
  wakeDir,
} from "../wake.ts";

const BUSY = 3;
const T0 = Date.parse("2026-11-06T10:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function wake(): string {
  const root = mkdtempSync(join(tmpdir(), "jig-wake-"));
  roots.push(root);
  return wakeDir(root, "/home/me/dev/web");
}

/** A clock whose waits pass at once and move its time on. */
function fakeClock(start = T0): Clock & { at: number } {
  const clock = {
    at: start,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
    },
  };
  return clock;
}

/** A run that answers `codes` in turn (then 0), records when each started, and does `during` while it runs. */
function runs(
  clock: Clock,
  codes: number[] = [],
  during: (index: number) => void = () => {
    // Nothing happens while it runs.
  },
): { starts: number[]; run(): Promise<Outcome<number, "unstarted">> } {
  const starts: number[] = [];
  return {
    starts,
    run: async () => {
      const index = starts.length;
      starts.push(clock.now());
      during(index);
      return ok(codes[index] ?? 0);
    },
  };
}

describe("a wake's spacing", () => {
  it("takes requests arriving during preparation in the same run", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const r = runs(clock);
    let preparations = 0;
    const end = await waitAndRun(dir, {
      clock,
      busy: BUSY,
      run: r.run,
      prepare: async () => {
        if (preparations++ === 0) requestWake(dir, clock);
        return ok(undefined);
      },
    });
    expect(end).toEqual({ end: "idle", runs: 1 });
    expect(r.starts).toEqual([T0]);
    expect(pendingRequests(dir)).toEqual([]);
  });

  it("spaces actual starts after slow command preparation", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const r = runs(clock, [], (index) => {
      if (index === 0) requestWake(dir, clock);
    });
    let prepared = 0;
    await waitAndRun(dir, {
      clock,
      busy: BUSY,
      prepare: async () => {
        if (prepared++ === 0) clock.at += 30_000;
        return ok(undefined);
      },
      run: r.run,
    });
    expect(r.starts).toEqual([T0 + 30_000, T0 + 90_000]);
    expect(lastStart(dir)).toBe(T0 + 90_000);
  });

  it("runs once for several requests made before the run starts", async () => {
    const dir = wake();
    const clock = fakeClock();
    const first = requestWake(dir, clock);
    requestWake(dir, clock);
    requestWake(dir, clock);
    expect(first).toEqual({ startWaiter: true, when: "now" });
    const r = runs(clock);
    const end = await waitAndRun(dir, { clock, busy: BUSY, run: r.run });
    expect(end).toEqual({ end: "idle", runs: 1 });
    expect(r.starts).toEqual([T0]);
    expect(pendingRequests(dir)).toEqual([]);
    expect(lastStart(dir)).toBe(T0);
  });

  it("keeps who asked and why with each request, and names them in the note of the run that takes them", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock, "send: hold drive@acme/web#12");
    clock.at += 1;
    requestWake(
      dir,
      clock,
      "probe: acme/web #12 updated\n2026-11-07T10:00:00Z",
    );
    requestWake(dir, clock);
    expect(requestReasons(dir, pendingRequests(dir))).toEqual([
      "send: hold drive@acme/web#12",
      "probe: acme/web #12 updated 2026-11-07T10:00:00Z",
    ]);
    const notes: string[] = [];
    const r = runs(clock);
    await waitAndRun(dir, {
      clock,
      busy: BUSY,
      run: r.run,
      note: (line) => notes.push(line),
    });
    expect(notes).toEqual([
      "the run exited 0, taking 3 requests (send: hold drive@acme/web#12; probe: acme/web #12 updated 2026-11-07T10:00:00Z)",
    ]);
  });

  it("starts one trailing run a minute after the last start for requests made while it ran", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const asked: ReturnType<typeof requestWake>[] = [];
    const r = runs(clock, [], (index) => {
      if (index > 0) return;
      clock.at += 10_000;
      asked.push(requestWake(dir, clock), requestWake(dir, clock));
    });
    const end = await waitAndRun(dir, { clock, busy: BUSY, run: r.run });
    expect(asked).toEqual([
      { startWaiter: false, when: "soon" },
      { startWaiter: false, when: "soon" },
    ]);
    expect(end).toEqual({ end: "idle", runs: 2 });
    expect(r.starts).toEqual([T0, T0 + WAKE_SPACING_MS]);
    expect(pendingRequests(dir)).toEqual([]);
  });

  it("starts no sooner than a minute after the last run started", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    await waitAndRun(dir, { clock, busy: BUSY, run: runs(clock).run });
    clock.at = T0 + 20_000;
    expect(requestWake(dir, clock)).toEqual({
      startWaiter: true,
      when: "soon",
    });
    const r = runs(clock);
    await waitAndRun(dir, { clock, busy: BUSY, run: r.run });
    expect(r.starts).toEqual([T0 + WAKE_SPACING_MS]);
  });
});

describe("a wake's refused runs", () => {
  it("keeps requests and the start timestamp untouched when preparation fails", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const r = runs(clock);
    const end = await waitAndRun(dir, {
      clock,
      busy: BUSY,
      run: r.run,
      prepare: async () => failed("unstarted", "missing launcher"),
    });
    expect(end).toEqual({ end: "failed", runs: 0 });
    expect(r.starts).toEqual([]);
    expect(lastStart(dir)).toBeNull();
    expect(pendingRequests(dir)).toHaveLength(1);
    expect(requestWake(dir, clock).startWaiter).toBe(true);
  });

  it("keeps the requests of a refused run and tries again after the minute", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const r = runs(clock, [BUSY, 0]);
    const end = await waitAndRun(dir, { clock, busy: BUSY, run: r.run });
    expect(end).toEqual({ end: "idle", runs: 1 });
    expect(r.starts).toEqual([T0, T0 + WAKE_SPACING_MS]);
    expect(pendingRequests(dir)).toEqual([]);
  });

  it("gives up after its bound of refused runs and leaves the requests for the next wake", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const r = runs(clock, Array(WAKE_ATTEMPTS + 5).fill(BUSY));
    const end = await waitAndRun(dir, { clock, busy: BUSY, run: r.run });
    expect(end).toEqual({ end: "bounded", runs: 0 });
    expect(r.starts).toHaveLength(WAKE_ATTEMPTS);
    expect(pendingRequests(dir)).toHaveLength(1);
    // The waiter gave the wake up: the next request starts one.
    expect(requestWake(dir, clock).startWaiter).toBe(true);
  });

  it("ends when a run cannot start, and keeps the request", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const notes: string[] = [];
    const end = await waitAndRun(dir, {
      clock,
      busy: BUSY,
      note: (line) => notes.push(line),
      run: async () => failed("unstarted", "no such command"),
    });
    expect(end).toEqual({ end: "failed", runs: 0 });
    expect(notes).toEqual(["the run did not start: no such command"]);
    expect(pendingRequests(dir)).toHaveLength(1);
  });
});

describe("a wake's waiter", () => {
  it("lets one waiter hold it: a second exits while the first runs", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const seconds: Awaited<ReturnType<typeof waitAndRun>>[] = [];
    const r = runs(clock);
    const first = waitAndRun(dir, {
      clock,
      busy: BUSY,
      run: async () => {
        seconds.push(
          await waitAndRun(dir, {
            clock,
            busy: BUSY,
            run: async () => ok(0),
          }),
        );
        return r.run();
      },
    });
    expect(await first).toEqual({ end: "idle", runs: 1 });
    expect(seconds).toEqual([{ end: "elsewhere", runs: 0 }]);
    expect(r.starts).toHaveLength(1);
  });

  it("replaces a waiter whose process is gone", async () => {
    const dir = wake();
    const clock = fakeClock();
    requestWake(dir, clock);
    const gone = Bun.spawnSync([process.execPath, "-e", "0"]).pid;
    writeFileSync(join(dir, "waiter"), encodeIdentity(lockIdentity(gone)));
    expect(requestWake(dir, clock).startWaiter).toBe(true);
    const r = runs(clock);
    expect(await waitAndRun(dir, { clock, busy: BUSY, run: r.run })).toEqual({
      end: "idle",
      runs: 1,
    });
  });
});
