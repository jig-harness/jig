/**
 * `roundsGranted`: the rounds a re-arm added to the drive's round budget,
 * kept in the drive state so the extension spans every process that drives
 * the PR. The budget a drive enforces is `--max-rounds` (or
 * `drive.max_rounds`) plus this grant, on both durable counters: the
 * distinct reviewed heads (`rounds`) and the passes on the current head
 * (`attempts`).
 *
 * A drive started with `--rearm-budget` whose counters have already spent
 * that budget (it stopped on `MAX_ROUNDS`) grants one more budget: the
 * rounds it spent plus `--max-rounds`. Kept durably rather than per process,
 * so a re-armed drive that later restarts for another reason (a pass
 * deadline, a quota wall) is not refused on the base budget it has already
 * passed; and granted only by a launch that asks, so a restart without the
 * flag never extends the budget on its own.
 *
 * Written by `drive-state.ts grant-rounds <PR> --set N`, which never lowers
 * the stored grant and prints the grant it leaves. Optional in a stored
 * state, like `deadlineRetries`: a file written before the field existed
 * reads as no grant.
 */
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

/** `grant-rounds <PR> --set N`: raise the stored grant to N, never lower it. */
export async function grantRounds(
  store: StateStore,
  value: string,
): Promise<number> {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return fail(2, "grant-rounds requires --set N, a whole number");
  const asked = Number(value);
  let granted = 0;
  await store.update((s) => {
    granted = Math.max(s.roundsGranted ?? 0, asked);
    return { ...s, roundsGranted: granted };
  });
  console.log(granted);
  return 0;
}

/** What a drive's durable counters stand at, for {@link rearmGrant}. */
export interface SpentRounds {
  /** Distinct reviewed heads (`drive-state.ts rounds`), which counts the head the budget refused. */
  rounds: number;
  /** Passes made on the stored head. */
  attempts: number;
  /** The grant already stored. */
  granted: number;
}

/**
 * The grant a re-arm leaves for `base`, the drive's own budget: unchanged
 * when the counters still fit the budget, else the rounds the drive spent,
 * so that it may run `base` more. The head the budget refused is counted in
 * `rounds` before the refusal, so it is not one the drive spent.
 */
export function rearmGrant(spent: SpentRounds, base: number): number {
  const budget = base + spent.granted;
  const exhausted = spent.rounds > budget || spent.attempts >= budget;
  if (!exhausted) return spent.granted;
  return Math.max(spent.granted, spent.rounds - 1, spent.attempts);
}
