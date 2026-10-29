/**
 * `drive-state.ts unpark <PR> --key K [--key K …]`: one state mutation, under
 * the state lock, that removes every named park or none. A key that is not
 * parked refuses the whole set, so a re-arm unparking the items a person
 * answered never leaves some unparked and others parked.
 */
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

export async function unpark(
  store: StateStore,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return fail(2, "unpark requires --key");
  let missing: string[] = [];
  await store.update((s) => {
    const parked = new Set(s.parked.map((p) => p.key));
    missing = keys.filter((k) => !parked.has(k));
    if (missing.length > 0) return s;
    return { ...s, parked: s.parked.filter((p) => !keys.includes(p.key)) };
  });
  if (missing.length > 0)
    return fail(
      1,
      `unpark: not parked on PR #${String(store.read().state.pr)}: ${missing.join(", ")}; nothing was unparked.`,
    );
  return 0;
}
