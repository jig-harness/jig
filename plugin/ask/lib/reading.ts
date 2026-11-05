/**
 * What one answer's reads share: the answer's deadline, each source's, the
 * forge and tracker calls counted, and the list of sources it consulted.
 * A read that fails or runs out of time is a value recorded here
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)): the field
 * it would have filled says nothing, and `sources` says why.
 */
import type { SourceRead, Sources } from "./answer.ts";

/** How long the whole answer may take; past it, no source starts and the answer prints with what it has. */
const ANSWER_DEADLINE_MS = 45_000;
/** How long one source may take: one forge call, the tracker's read, the drive's own listing. */
const SOURCE_DEADLINE_SEC = 15;

export interface Reading {
  /** Whole seconds a source may take now: its own deadline, or what is left of the answer's; `0` once that is spent. */
  sourceSec(): number;
  /** Count one forge call. */
  forgeCall(): void;
  /** Count one tracker call. */
  trackerCall(): void;
  /** Record a source read, or why it was not. A second note on one record replaces the first. */
  note(source: SourceRead): void;
  sources(): Sources;
}

export function reading(
  deadlineMs = ANSWER_DEADLINE_MS,
  now: () => number = Date.now,
): Reading {
  const until = now() + deadlineMs;
  const records = new Map<string, SourceRead>();
  let forge = 0;
  let tracker = 0;
  return {
    sourceSec: () =>
      Math.max(
        0,
        Math.min(SOURCE_DEADLINE_SEC, Math.floor((until - now()) / 1000)),
      ),
    forgeCall: () => {
      forge += 1;
    },
    trackerCall: () => {
      tracker += 1;
    },
    note: (source) => {
      records.set(source.record, source);
    },
    sources: () => ({
      records: [...records.values()],
      forgeCalls: forge,
      trackerCalls: tracker,
    }),
  };
}

/** Why a source was not read because the answer's deadline passed. */
export const PAST_DEADLINE = `the answer's deadline (${ANSWER_DEADLINE_MS / 1000} s) passed before it was read`;

/**
 * `work`, or `null` when it does not settle within `sec` seconds: for a read
 * whose own interface takes no deadline (a tracker adapter's).
 */
export async function within<T>(
  sec: number,
  work: () => Promise<T>,
): Promise<{ value: T } | null> {
  if (sec <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), sec * 1000);
  });
  try {
    return await Promise.race([work().then((value) => ({ value })), late]);
  } finally {
    clearTimeout(timer);
  }
}
