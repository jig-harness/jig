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
 * most once pages answer quickly, but not during the hold that follows a
 * shrink. The first hold is short (`FIRST_HOLD_MS`), so one timeout does not
 * cost the smaller pages for long; a shrink that follows the last one within
 * `HOLDS_FORGOTTEN_MS` doubles the hold, up to `LONGEST_HOLD_MS`, so a size
 * that keeps failing is tried less and less often.
 */
import { Defect, type Failure, type Outcome } from "../outcome.ts";
import { currentMs } from "../time.ts";

/** A page answered in less than this may double: twice the items stay well under `SLOW_MS`. */
export const QUICK_MS = 2_500;

/** A page that took this long came close to the system's limit: the next read starts from half. */
export const SLOW_MS = 6_000;

/** How long the kept size stays as it is after a first shrink, however quickly pages answer. */
export const FIRST_HOLD_MS = 300_000;

/** The longest a shrink holds the kept size. */
export const LONGEST_HOLD_MS = 3_600_000;

/** A shrink this long after the last one is a first shrink again. */
const HOLDS_FORGOTTEN_MS = 2 * LONGEST_HOLD_MS;

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
  clock: () => number = currentMs,
): Promise<ShrunkRead<T, Code>> {
  if (!Number.isFinite(start))
    throw new Defect("the starting page size must be finite");
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
  /** How long after `shrankAt` the size may not grow; `FIRST_HOLD_MS` when absent. */
  holdMs?: number;
}

/** What was kept, where it reads as a size from one to `most`; else `null`. */
export function keptSize(value: unknown, most: number): KeptSize | null {
  if (typeof value !== "object" || value === null) return null;
  const { size, shrankAt, holdMs } = value as Record<string, unknown>;
  return typeof size === "number" &&
    Number.isInteger(size) &&
    size >= 1 &&
    size <= most &&
    typeof shrankAt === "number" &&
    Number.isFinite(shrankAt)
    ? {
        size,
        shrankAt,
        ...(typeof holdMs === "number" &&
        holdMs > 0 &&
        holdMs <= LONGEST_HOLD_MS
          ? { holdMs }
          : {}),
      }
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

/** What a shrink at `now` keeps: `size`, held twice as long as the last hold when that shrink was recent. */
function shrunkTo(size: number, kept: KeptSize | null, now: number): KeptSize {
  const since = kept === null ? null : now - kept.shrankAt;
  const recent = since !== null && since >= 0 && since < HOLDS_FORGOTTEN_MS;
  return {
    size,
    shrankAt: now,
    holdMs: recent
      ? Math.min(LONGEST_HOLD_MS, 2 * (kept?.holdMs ?? FIRST_HOLD_MS))
      : FIRST_HOLD_MS,
  };
}

/**
 * What to keep after `run`, or `null` to leave what is kept as it is. A run
 * that shrank keeps the size it ended at. A run that read whole keeps half
 * its size when its slowest page took `SLOW_MS` or longer, and twice its
 * size, up to `most`, when every page took less than `QUICK_MS` and the
 * hold after the last shrink has passed.
 */
export function sizeToKeep(
  kept: KeptSize | null,
  run: PagedRun,
  most: number,
  now: number,
): KeptSize | null {
  if (run.size < run.started) return shrunkTo(run.size, kept, now);
  if (!run.whole || run.pages === 0) return null;
  if (run.slowestMs >= SLOW_MS)
    return run.size === 1
      ? null
      : shrunkTo(Math.floor(run.size / 2), kept, now);
  // A shrink dated after now says nothing about now, so it holds nothing back.
  const held = kept === null ? 0 : now - kept.shrankAt;
  const settled =
    kept === null || held < 0 || held >= (kept.holdMs ?? FIRST_HOLD_MS);
  if (run.slowestMs < QUICK_MS && run.size < most && settled)
    return {
      size: Math.min(most, run.size * 2),
      shrankAt: kept?.shrankAt ?? 0,
      ...(kept?.holdMs === undefined ? {} : { holdMs: kept.holdMs }),
    };
  return null;
}
