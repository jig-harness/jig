/**
 * `roundsGranted`: the rounds a re-arm added to the drive's round budget,
 * kept in the drive state so the extension spans every process that drives
 * the PR. The budget a drive enforces on the distinct reviewed heads
 * (`rounds`) is `--max-rounds` (or `drive.max_rounds`) plus this grant. The
 * passes on one head (`attempts`) stay bounded by the base budget alone: a
 * re-arm that finds them spent resets that head's count instead
 * (`grant-rounds --reset-attempts`), so neither counter's allowance grows by
 * what the other spent.
 *
 * A drive started with `--rearm-budget` whose counters have already spent
 * the budget (it stopped on `MAX_ROUNDS`) is granted one more budget of
 * `--max-rounds` heads, counting the head it resumes on. Kept durably rather than per process,
 * so a re-armed drive that later restarts for another reason (a pass
 * deadline, a quota wall) is not refused on the base budget it has already
 * passed; and granted only by a launch that asks, so a restart without the
 * flag never extends the budget on its own.
 *
 * Written by `drive-state.ts grant-rounds <PR> --set N [--reset-attempts]`,
 * which never lowers the stored grant and prints the grant it leaves. Optional in a stored
 * state, like `deadlineRetries`: a file written before the field existed
 * reads as no grant.
 */
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

/** `grant-rounds <PR> --set N [--reset-attempts]`: raise the stored grant to N, never lower it; optionally zero the passes counted on the current head. */
export async function grantRounds(
  store: StateStore,
  value: string,
  resetAttempts = false,
): Promise<number> {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return fail(2, "grant-rounds requires --set N, a whole number");
  const asked = Number(value);
  let granted = 0;
  await store.update((s) => {
    granted = Math.max(s.roundsGranted ?? 0, asked);
    return {
      ...s,
      roundsGranted: granted,
      ...(resetAttempts ? { attempts: 0 } : {}),
    };
  });
  console.log(granted);
  return 0;
}

/** What a drive's durable counters stand at, for {@link rearmGrant}. */
export interface SpentRounds {
  /** Distinct reviewed heads (`drive-state.ts rounds`), which counts a head the budget refused. */
  rounds: number;
  /** Passes made on the head being driven (zero when the stored count belongs to another head). */
  attempts: number;
  /** The grant already stored. */
  granted: number;
  /** The head being driven is the one the last counted round belongs to, so resuming does not count a further one. */
  headCounted: boolean;
}

/** What a re-arm leaves: the grant on the distinct heads, and whether the head's pass count restarts. */
export interface RearmGrant {
  granted: number;
  resetAttempts: boolean;
}

/**
 * The grant a re-arm leaves for `base`, the drive's own budget. Heads: once
 * the counted ones have reached the budget (a stop on `MAX_ROUNDS` leaves
 * them at the budget or one past it), the budget is the heads counted
 * before the one the drive resumes on plus `base`, so the resumed head is
 * the first of `base` more. Passes on one head: reset when they reached
 * `base`, never granted past it.
 */
export function rearmGrant(spent: SpentRounds, base: number): RearmGrant {
  const spentHeads = spent.rounds >= base + spent.granted;
  const granted = spentHeads
    ? Math.max(spent.granted, spent.rounds - (spent.headCounted ? 1 : 0))
    : spent.granted;
  return { granted, resetAttempts: spent.attempts >= base };
}
