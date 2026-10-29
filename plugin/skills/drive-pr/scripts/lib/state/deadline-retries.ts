/**
 * `deadlineRetries`: how many passes killed at their deadline this drive has
 * restarted from, kept in the drive state so the budget
 * (`drive.pass_deadline_retries`) spans every process that drives the PR. An
 * in-memory count would hand each re-arm or takeover a fresh budget, and a
 * pull request whose passes always reach the deadline would loop forever.
 *
 * Counted by `drive-state.ts deadline-retries <PR> --set bump`, which prints
 * the new count; cleared by `--set clear` only when the drive ends (converged,
 * or the pull request closed). Optional in a stored state, like
 * `drivenBranch`: a file written before the field existed reads as zero.
 */
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

/** Absent, or a whole number: what a stored state may hold. */
export function isOptionalRetryCount(v: unknown): boolean {
  return v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0);
}

/** `deadline-retries <PR> --set bump|clear`. */
export async function deadlineRetries(
  store: StateStore,
  action: string,
): Promise<number> {
  if (action !== "bump" && action !== "clear")
    return fail(2, "deadline-retries requires --set bump|clear");
  let count = 0;
  await store.update((s) => {
    count = action === "bump" ? (s.deadlineRetries ?? 0) + 1 : 0;
    return { ...s, deadlineRetries: count };
  });
  console.log(count);
  return 0;
}
