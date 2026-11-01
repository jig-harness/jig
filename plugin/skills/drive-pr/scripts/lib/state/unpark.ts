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
 */
import { fail } from "../cli.ts";
import type { ParkedItem } from "./schema.ts";
import type { StateStore } from "./store.ts";

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
function refusal(
  parked: readonly ParkedItem[],
  keys: readonly string[],
  parkedAts: readonly string[],
  every: boolean,
): string | null {
  const byKey = new Map(parked.map((p) => [p.key, p]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) return `not parked: ${missing.join(", ")}`;
  const changed = keys.filter(
    (k, i) => parkedAts[i] !== undefined && byKey.get(k)?.at !== parkedAts[i],
  );
  if (changed.length > 0)
    return `parked again since its answers were read: ${changed.join(", ")}`;
  const unnamed = every ? parked.filter((p) => !keys.includes(p.key)) : [];
  return unnamed.length > 0
    ? `parked since the answers were read: ${unnamed.map((p) => p.key).join(", ")}`
    : null;
}

export async function unpark(
  store: StateStore,
  keys: readonly string[],
  parkedAts: readonly string[] = [],
  every = false,
): Promise<number> {
  const misuse = usageError(keys, parkedAts);
  if (misuse !== null) return fail(2, misuse);
  // Set inside the locked update; the annotation keeps it from narrowing to `null`.
  let why = null as string | null;
  await store.update((s) => {
    why = refusal(s.parked, keys, parkedAts, every);
    return why === null
      ? { ...s, parked: s.parked.filter((p) => !keys.includes(p.key)) }
      : s;
  });
  if (why === null) return 0;
  return fail(
    1,
    `unpark: PR #${String(store.read().state.pr)}: ${why}; nothing was unparked.`,
  );
}
