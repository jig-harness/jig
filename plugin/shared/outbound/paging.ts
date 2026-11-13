/**
 * A paged read whose page shrinks when the system it reads runs out of time.
 *
 * A forge or a tracker ends a request it has worked on for too long: GitHub
 * ends a GraphQL query after about ten seconds and answers HTTP 502 or 504.
 * What a page costs the system depends on what its items carry (a pull
 * request's hundred check results, say), which the reader cannot know
 * before it asks. A fixed page size that reads one repository whole
 * therefore times out on another, and a read with no smaller page to fall
 * back to fails for as long as the items stay heavy.
 *
 * `readShrinking` asks for a page and, on a failure the caller names as the
 * system running out of time, asks again for half as many items, down to
 * one. A reader that runs again and again keeps the size it ended at
 * (`sizeToKeep`) and starts the next read from it (`startSize`), so it does
 * not time out once on every run before it shrinks. The kept size halves
 * after a page that came close to the limit, and doubles back toward the
 * most once pages answer quickly, but not within `GROW_AFTER_MS` of the
 * last time it shrank: a size that fails is then tried once in that time,
 * not on every other run.
 */
import type { Failure, Outcome } from "../outcome.ts";

/** A page answered in less than this may double: twice the items stay well under `SLOW_MS`. */
export const QUICK_MS = 2_500;

/** A page that took this long came close to the system's limit: the next read starts from half. */
export const SLOW_MS = 6_000;

/** How long after a page shrank the kept size stays as it is, however quickly pages answer. */
export const GROW_AFTER_MS = 3_600_000;

/** One page as `readShrinking` read it. */
export interface ShrunkRead<T, Code extends string> {
  /** The page, or the failure at the last size asked. */
  outcome: Outcome<T, Code>;
  /** The size last asked: the one that read, or the one the failure is of. */
  size: number;
  /** How long the last request took. */
  tookMs: number;
}

/**
 * `read` at `start` items, and at half as many each time it fails with a
 * failure `outOfTime` names, down to one item. Any other failure, and a
 * failure at one item, is returned as it is.
 */
export async function readShrinking<T, Code extends string>(
  start: number,
  read: (size: number) => Promise<Outcome<T, Code>>,
  outOfTime: (failure: Failure<Code>) => boolean,
  clock: () => number = Date.now,
): Promise<ShrunkRead<T, Code>> {
  let size = Math.max(1, Math.floor(start));
  for (;;) {
    const began = clock();
    const outcome = await read(size);
    const tookMs = clock() - began;
    if (outcome.ok || size === 1 || !outOfTime(outcome.failure))
      return { outcome, size, tookMs };
    size = Math.max(1, Math.floor(size / 2));
  }
}

/** The page size a reader keeps between runs. */
export interface KeptSize {
  size: number;
  /** When the size last shrank, epoch milliseconds. */
  shrankAt: number;
}

/** What was kept, where it reads as a size from one to `most`; else `null`. */
export function keptSize(value: unknown, most: number): KeptSize | null {
  if (typeof value !== "object" || value === null) return null;
  const { size, shrankAt } = value as Record<string, unknown>;
  return typeof size === "number" &&
    Number.isInteger(size) &&
    size >= 1 &&
    size <= most &&
    typeof shrankAt === "number" &&
    Number.isFinite(shrankAt)
    ? { size, shrankAt }
    : null;
}

/** The size a read starts from: the kept one, else `most`. */
export function startSize(kept: KeptSize | null, most: number): number {
  return kept?.size ?? most;
}

/** How one run's pages went. */
export interface PagedRun {
  /** The size its first page was first asked at. */
  started: number;
  /** The size its pages were asked at when it ended. */
  size: number;
  /** How many pages read. */
  pages: number;
  /** How long the slowest page that read took. */
  slowestMs: number;
  /** Whether every page read. */
  whole: boolean;
}

/**
 * What to keep after `run`, or `null` to leave what is kept as it is. A run
 * that shrank keeps the size it ended at. A run that read whole keeps half
 * its size when its slowest page took `SLOW_MS` or longer, and twice its
 * size, up to `most`, when every page took less than `QUICK_MS` and nothing
 * shrank in the last `GROW_AFTER_MS`.
 */
export function sizeToKeep(
  kept: KeptSize | null,
  run: PagedRun,
  most: number,
  now: number,
): KeptSize | null {
  if (run.size < run.started) return { size: run.size, shrankAt: now };
  if (!run.whole || run.pages === 0) return null;
  if (run.slowestMs >= SLOW_MS)
    return run.size === 1
      ? null
      : { size: Math.floor(run.size / 2), shrankAt: now };
  const settled = kept === null || now - kept.shrankAt >= GROW_AFTER_MS;
  if (run.slowestMs < QUICK_MS && run.size < most && settled)
    return {
      size: Math.min(most, run.size * 2),
      shrankAt: kept?.shrankAt ?? 0,
    };
  return null;
}
