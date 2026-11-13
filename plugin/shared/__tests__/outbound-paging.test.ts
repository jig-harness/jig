/**
 * shared/outbound: a paged read halves its page on a timeout, down to one
 * item, keeps the smaller size for the rest of the read, reports the size
 * that last answered, and fails on any other failure at once.
 */
import { describe, expect, it } from "bun:test";
import { failed, ok, type Outcome } from "../outcome.ts";
import {
  type Page,
  readPaged,
  TIMED_OUT,
  timedOut,
} from "../outbound/paging.ts";

type Code = typeof TIMED_OUT | "unreadable";

/** A system of `total` items that times out on a page above `limit`, recording each page size it was asked for. */
function system(total: number, limit: number) {
  const asked: number[] = [];
  const fetch = async (
    size: number,
    at: number,
  ): Promise<Outcome<Page<number[], number>, Code>> => {
    asked.push(size);
    if (size > limit) return failed(TIMED_OUT, "HTTP 504");
    const items = Array.from(
      { length: Math.min(size, total - at) },
      (_, i) => at + i,
    );
    const next = at + items.length < total ? at + items.length : null;
    return ok({ value: items, items: items.length, next });
  };
  return { asked, fetch };
}

describe("a paged read", () => {
  it("reads every item in pages of the size that answers, halving from the start size", async () => {
    const s = system(25, 10);
    const read = await readPaged({ start: 0, size: 50, fetch: s.fetch });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.pages.flat()).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
    expect(read.value.items).toBe(25);
    expect(read.value.size).toBe(6);
    expect(read.value.shrinks).toBe(3);
    expect(s.asked).toEqual([50, 25, 12, 6, 6, 6, 6, 6]);
  });

  it("does not shrink a page that answers", async () => {
    const s = system(7, 50);
    const read = await readPaged({ start: 0, size: 50, fetch: s.fetch });
    expect(read.ok && read.value.size).toBe(50);
    expect(s.asked).toEqual([50]);
  });

  it("fails only once a page of one times out, saying how far it shrank", async () => {
    const s = system(3, 0);
    const read = await readPaged({ start: 0, size: 4, fetch: s.fetch });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe(TIMED_OUT);
    expect(read.failure.reason).toBe(
      "HTTP 504 (at a page of 1, shrunk from 4)",
    );
    expect(s.asked).toEqual([4, 2, 1]);
  });

  it("ends at the first failure that is not a timeout, without shrinking", async () => {
    const asked: number[] = [];
    const read = await readPaged<number[], number, Code>({
      start: 0,
      size: 50,
      fetch: async (size) => {
        asked.push(size);
        return failed("unreadable", "not JSON");
      },
    });
    expect(read.ok ? null : read.failure.code).toBe("unreadable");
    expect(asked).toEqual([50]);
  });

  it("starts at one page even when asked for a size under one", async () => {
    const s = system(2, 10);
    const read = await readPaged({ start: 0, size: 0, fetch: s.fetch });
    expect(read.ok && read.value.size).toBe(1);
    expect(s.asked).toEqual([1, 1]);
  });
});

describe("a timeout", () => {
  it("is a passed deadline, or a gateway's 502 or 504", () => {
    expect(timedOut("", true)).toBe(true);
    expect(timedOut("gh: HTTP 504: We couldn't respond in time", false)).toBe(
      true,
    );
    expect(timedOut("gh: HTTP 502", false)).toBe(true);
    expect(timedOut("gh: HTTP 500", false)).toBe(false);
    expect(timedOut("gh: HTTP 5040", false)).toBe(false);
    expect(timedOut("gh: Bad credentials (HTTP 401)", false)).toBe(false);
  });
});
