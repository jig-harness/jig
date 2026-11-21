/**
 * An absence is an answer ([design/outbound-calls.md](../../../design/outbound-calls.md),
 * "What a reader does without an answer"): kept apart from the failure policy
 * so a repository's report can say it without reaching the state it is kept in.
 */
import type { ReadFailure } from "./types.ts";

/**
 * Whether an item's row is a read of one item the forge answered with an
 * absence (`not-found`): what was asked for does not exist or is not visible
 * to the credential, as a parked drive's review thread may not be. The row
 * keeps the class on the receipt; the read fails neither the turn nor the
 * tick, and nobody is told. Another item's `not-found` (the head of a base
 * branch that is gone) says the repository is not as the tick needs it: it
 * stays a failed read.
 */
export function answeredByAbsence(row: {
  readFailed?: true;
  failure?: ReadFailure;
}): boolean {
  return (
    row.readFailed === true &&
    row.failure?.class === "not-found" &&
    row.failure.absence === true
  );
}
