/** The repository's configuration is not one the skill can run on (exit 1). */
export class WorkBatchConfigError extends Error {
  override name = "WorkBatchConfigError";
}

/**
 * An anchor that cannot be batched, a command line the script cannot act on,
 * or eligibility input it cannot read: the message says why and what to do
 * instead (exit 2).
 */
export class Refusal extends Error {
  override name = "Refusal";
  readonly code = 2;
}
