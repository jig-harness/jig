/**
 * `drive-state.ts unpark <PR> --key K [--parked-at ISO] [--key K …] [--every]`:
 * one state mutation, under the state lock, that removes every named park or
 * none. A key that is not parked refuses the whole set, so a re-arm unparking
 * the items a person answered never leaves some unparked and others parked.
 *
 * With `--parked-at`, one per `--key` in the same order, each park must
 * still carry that timestamp: a park replaced under the same key since its
 * answers were read is a different question, and refuses the whole set too.
 * With `--every`, the named keys must be every park there is: a park added
 * since the answers were read has none, and refuses the whole set.
 * With `--stdin`, the verdicts the re-arm consumed are read on stdin, and
 * each park removed gets its resolution receipt in the same mutation
 * (`resolution-receipt.ts`).
 */
import { fail, readStdinAll } from "../cli.ts";
import type { DriveState, ParkedItem } from "./schema.ts";
import type { StateStore } from "./store.ts";
import {
  type ConsumedVerdict,
  keptReceipts,
  parseConsumed,
  receiptsFor,
} from "./resolution-receipt.ts";

/** What is wrong with the flags themselves; `null` when nothing is. */
function usageError(
  keys: readonly string[],
  parkedAts: readonly string[],
): string | null {
  if (keys.length === 0) return "unpark requires --key";
  return parkedAts.length > 0 && parkedAts.length !== keys.length
    ? "unpark: give one --parked-at per --key, or none"
    : null;
}

/** Why the set cannot be unparked as named; `null` when it can. */
export function refusal(
  parked: readonly ParkedItem[],
  keys: readonly string[],
  parkedAts: readonly string[],
  every: boolean,
  consumed: readonly ConsumedVerdict[] | null,
): string | null {
  const byKey = new Map(parked.map((p) => [p.key, p]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) return `not parked: ${missing.join(", ")}`;
  const changed = keys.filter(
    (k, i) => parkedAts[i] !== undefined && byKey.get(k)?.at !== parkedAts[i],
  );
  if (changed.length > 0)
    return `parked again since its answers were read: ${changed.join(", ")}`;
  if (consumed !== null) {
    const counts = new Map<string, number>();
    for (const v of consumed) counts.set(v.key, (counts.get(v.key) ?? 0) + 1);
    const uncovered = keys.filter((k) => counts.get(k) !== 1);
    if (uncovered.length > 0)
      return `--stdin must carry exactly one verdict for each key; missing or repeated: ${uncovered.join(", ")}`;
  }
  const unnamed = every ? parked.filter((p) => !keys.includes(p.key)) : [];
  return unnamed.length > 0
    ? `parked since the answers were read: ${unnamed.map((p) => p.key).join(", ")}`
    : null;
}

/** The state with the named parks removed, and a receipt for each the re-arm consumed a verdict for. */
function withoutParks(
  s: DriveState,
  keys: readonly string[],
  consumed: readonly ConsumedVerdict[],
): DriveState {
  const removed = s.parked.filter((p) => keys.includes(p.key));
  const fresh = receiptsFor(removed, consumed, new Date().toISOString());
  const kept =
    fresh.length === 0
      ? (s.resolvedParks ?? [])
      : keptReceipts(s.resolvedParks, fresh);
  const evicted = (s.resolvedParks?.length ?? 0) + fresh.length > kept.length;
  return {
    ...s,
    parked: s.parked.filter((p) => !keys.includes(p.key)),
    ...(fresh.length === 0 ? {} : { resolvedParks: kept }),
    ...(evicted ? { resolvedParksLost: true } : {}),
  };
}

export async function unpark(
  store: StateStore,
  keys: readonly string[],
  parkedAts: readonly string[] = [],
  every = false,
  consumedText: string | null = null,
): Promise<number> {
  const misuse = usageError(keys, parkedAts);
  if (misuse !== null) return fail(2, misuse);
  const consumed = consumedText === null ? [] : parseConsumed(consumedText);
  if (typeof consumed === "string") return fail(2, consumed);
  // Set inside the locked update; the annotation keeps it from narrowing to `null`.
  let why = null as string | null;
  await store.update((s) => {
    why = refusal(
      s.parked,
      keys,
      parkedAts,
      every,
      consumedText === null ? null : consumed,
    );
    return why === null ? withoutParks(s, keys, consumed) : s;
  });
  if (why === null) return 0;
  return fail(
    1,
    `unpark: PR #${String(store.read().state.pr)}: ${why}; nothing was unparked.`,
  );
}

/** `unpark` as `drive-state.ts` parsed it, with `--stdin`'s verdicts read. */
export async function unparkCommand(
  store: StateStore,
  a: { keys: string[]; parkedAts: string[]; every: boolean; stdin: boolean },
): Promise<number> {
  const consumed = a.stdin ? await readStdinAll() : null;
  return unpark(store, a.keys, a.parkedAts, a.every, consumed);
}
