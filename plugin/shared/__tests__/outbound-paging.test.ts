/**
 * shared/outbound: a paged read whose page shrinks when the system it reads
 * runs out of time, and the size the next read starts from.
 */
import { describe, expect, it } from "bun:test";
import { failed, ok, type Outcome } from "../outcome.ts";
import {
  FIRST_HOLD_MS,
  type KeptSize,
  keptSize,
  LONGEST_HOLD_MS,
  type PagedRun,
  QUICK_MS,
  readShrinking,
  SLOW_MS,
  sizeToKeep,
  startSize,
} from "../outbound/paging.ts";

type Code = "too-costly" | "unreadable";

/** A system that runs out of time on a page of more than `most` items. */
function system(most: number) {
  const asked: number[] = [];
  const read = async (size: number): Promise<Outcome<number, Code>> => {
    asked.push(size);
    return size > most
      ? failed("too-costly", `no answer at ${size}`)
      : ok(size);
  };
  return { asked, read };
}

const outOfTime = (failure: { code: Code }) => failure.code === "too-costly";

describe("a page the system runs out of time on", () => {
  it("is asked again at half the size until it reads", async () => {
    const { asked, read } = system(10);
    const page = await readShrinking(50, read, outOfTime);
    expect(asked).toEqual([50, 25, 12, 6]);
    expect(page.outcome).toEqual(ok(6));
    expect(page.size).toBe(6);
  });

  it("is asked once when it reads at the size it starts from", async () => {
    const { asked, read } = system(10);
    const page = await readShrinking(8, read, outOfTime);
    expect(asked).toEqual([8]);
    expect(page.size).toBe(8);
  });

  it("stops at one item, with the failure of that request", async () => {
    const { asked, read } = system(0);
    const page = await readShrinking(5, read, outOfTime);
    expect(asked).toEqual([5, 2, 1]);
    expect(page.outcome).toEqual(failed("too-costly", "no answer at 1"));
    expect(page.size).toBe(1);
  });

  it("rejects a non-finite starting size", async () => {
    const { read } = system(10);
    await expect(readShrinking(Number.NaN, read, outOfTime)).rejects.toThrow(
      "the starting page size must be finite",
    );
    await expect(readShrinking(Infinity, read, outOfTime)).rejects.toThrow(
      "the starting page size must be finite",
    );
  });

  it("is not asked again after any other failure", async () => {
    const asked: number[] = [];
    const page = await readShrinking<number, Code>(
      50,
      async (size) => {
        asked.push(size);
        return failed("unreadable", "the answer is not JSON");
      },
      outOfTime,
    );
    expect(asked).toEqual([50]);
    expect(page.outcome.ok).toBe(false);
    expect(page.size).toBe(50);
  });

  it("reports how long the request that settled it took", async () => {
    const times = [0, 11_000, 11_000, 14_000];
    const { read } = system(25);
    const page = await readShrinking(50, read, outOfTime, () => {
      const at = times.shift();
      if (at === undefined) throw new Error("the clock was read too often");
      return at;
    });
    expect(page.size).toBe(25);
    expect(page.tookMs).toBe(3_000);
  });
});

describe("the size a reader keeps between runs", () => {
  const NOW = 1_800_000_000_000;
  /** A run that read whole at `size`, its slowest page taking `slowestMs`. */
  const whole = (size: number, slowestMs: number): PagedRun => ({
    started: size,
    size,
    pages: 3,
    slowestMs,
    whole: true,
  });

  it("is the size a run shrank to, whether or not the run then read whole", () => {
    const run = { started: 50, size: 6, pages: 5, slowestMs: 100 };
    const shrunk = { size: 6, shrankAt: NOW, holdMs: FIRST_HOLD_MS };
    expect(sizeToKeep(null, { ...run, whole: true }, 50, NOW)).toEqual(shrunk);
    expect(sizeToKeep(null, { ...run, whole: false }, 50, NOW)).toEqual(shrunk);
  });

  it("is half after a page that came close to the limit", () => {
    expect(sizeToKeep(null, whole(12, SLOW_MS), 50, NOW)).toEqual({
      size: 6,
      shrankAt: NOW,
      holdMs: FIRST_HOLD_MS,
    });
    expect(sizeToKeep(null, whole(1, SLOW_MS + 3_000), 50, NOW)).toBeNull();
  });

  it("is twice the size, up to the most, once pages answer quickly and its hold has passed", () => {
    const long = {
      size: 6,
      shrankAt: NOW - FIRST_HOLD_MS,
      holdMs: FIRST_HOLD_MS,
    };
    expect(sizeToKeep(long, whole(6, QUICK_MS - 1), 50, NOW)).toEqual({
      size: 12,
      shrankAt: long.shrankAt,
      holdMs: FIRST_HOLD_MS,
    });
    expect(
      sizeToKeep({ ...long, size: 30 }, whole(30, 100), 50, NOW)?.size,
    ).toBe(50);
  });

  it("stays as it is during its hold, however quickly pages answer", () => {
    const lately = { size: 6, shrankAt: NOW - FIRST_HOLD_MS + 1 };
    expect(sizeToKeep(lately, whole(6, 10), 50, NOW)).toBeNull();
    expect(
      sizeToKeep(
        {
          ...lately,
          shrankAt: NOW - 2 * FIRST_HOLD_MS + 1,
          holdMs: 2 * FIRST_HOLD_MS,
        },
        whole(6, 10),
        50,
        NOW,
      ),
    ).toBeNull();
  });

  it("grows back well within the hour after one timeout", () => {
    const shrunk = sizeToKeep(
      null,
      { started: 8, size: 4, pages: 2, slowestMs: 100, whole: true },
      50,
      NOW,
    );
    const later = NOW + FIRST_HOLD_MS;
    expect(FIRST_HOLD_MS).toBeLessThan(LONGEST_HOLD_MS);
    expect(sizeToKeep(shrunk, whole(4, 100), 50, later)?.size).toBe(8);
  });

  it("holds twice as long after each timeout that follows soon, up to the longest hold", () => {
    const timedOut = {
      started: 8,
      size: 4,
      pages: 1,
      slowestMs: 100,
      whole: true,
    };
    let kept: KeptSize | null = null;
    let now = NOW;
    const holds: number[] = [];
    for (let i = 0; i < 6; i++) {
      kept = sizeToKeep(kept, timedOut, 50, now);
      holds.push(kept?.holdMs ?? 0);
      // The size it may try again is asked as soon as its hold ends, and times out.
      now += kept?.holdMs ?? 0;
    }
    expect(holds).toEqual([
      FIRST_HOLD_MS,
      2 * FIRST_HOLD_MS,
      4 * FIRST_HOLD_MS,
      8 * FIRST_HOLD_MS,
      LONGEST_HOLD_MS,
      LONGEST_HOLD_MS,
    ]);
    expect(kept?.size).toBe(4);
  });

  it("starts from the first hold again once timeouts have stopped for a while", () => {
    const long = {
      size: 8,
      shrankAt: NOW - 2 * LONGEST_HOLD_MS,
      holdMs: LONGEST_HOLD_MS,
    };
    const run = { started: 8, size: 4, pages: 1, slowestMs: 100, whole: true };
    expect(sizeToKeep(long, run, 50, NOW)?.holdMs).toBe(FIRST_HOLD_MS);
    expect(
      sizeToKeep(
        { ...long, shrankAt: NOW - 2 * LONGEST_HOLD_MS + 1 },
        run,
        50,
        NOW,
      )?.holdMs,
    ).toBe(LONGEST_HOLD_MS);
  });

  it("stays as it is in between, at the most, and after a run that did not read whole or asked nothing", () => {
    const long = { size: 6, shrankAt: 0 };
    expect(sizeToKeep(long, whole(6, QUICK_MS), 50, NOW)).toBeNull();
    expect(sizeToKeep(long, whole(6, SLOW_MS - 1), 50, NOW)).toBeNull();
    expect(sizeToKeep(null, whole(50, 10), 50, NOW)).toBeNull();
    expect(
      sizeToKeep(long, { ...whole(6, 10), whole: false }, 50, NOW),
    ).toBeNull();
    expect(sizeToKeep(long, { ...whole(6, 0), pages: 0 }, 50, NOW)).toBeNull();
  });

  it("is read back only where it is a whole number from one to the most, with when it shrank", () => {
    expect(keptSize({ size: 6, shrankAt: 5 }, 50)).toEqual({
      size: 6,
      shrankAt: 5,
    });
    expect(keptSize({ size: 6, shrankAt: 5, holdMs: 60_000 }, 50)).toEqual({
      size: 6,
      shrankAt: 5,
      holdMs: 60_000,
    });
    for (const holdMs of [0, -1, Number.NaN, "soon"])
      expect(keptSize({ size: 6, shrankAt: 5, holdMs }, 50)).toEqual({
        size: 6,
        shrankAt: 5,
      });
    for (const kept of [
      null,
      undefined,
      6,
      "six",
      { size: 0, shrankAt: 5 },
      { size: 2.5, shrankAt: 5 },
      { size: 51, shrankAt: 5 },
      { size: 6 },
      { size: 6, shrankAt: Number.NaN },
    ])
      expect(keptSize(kept, 50)).toBeNull();
  });

  it("starts a read from the kept size, else from the most", () => {
    expect(startSize({ size: 6, shrankAt: 5 }, 50)).toBe(6);
    expect(startSize(null, 50)).toBe(50);
  });
});
