/** A tracker setting that cannot be used; `field` is its dotted path. */
export class TrackerConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * The tracker's name for `state`, refusing an optional state the repository
 * left unset: an item is never moved to a state with no name.
 */
export function namedState(name: string | null, state: string): string {
  if (name === null)
    throw new TrackerConfigError(
      `issue_tracker.states.${state}`,
      `issue_tracker.states.${state} is not set, so no item moves to ${state}`,
    );
  return name;
}
