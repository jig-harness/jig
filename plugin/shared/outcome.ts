/**
 * Failures are values; a throw is a defect ([ADR-0012](../../docs/adr/ADR-0012-failures-as-values.md)).
 * Code that can fail in a way its caller should handle returns an `Outcome`.
 * An I/O edge catches what the platform throws into one with `attempt`. Anything
 * that still throws is a bug, caught once at a defect boundary and reported
 * with its stack.
 *
 * A failure's `code` is stable, for tests and for code that branches on it; its
 * `reason` is plain language, for a person. Neither is parsed from the other.
 */
/** Why something could not be done. */
export interface Failure<Code extends string = string> {
  code: Code;
  reason: string;
  /** What the platform threw, for a log; a person reads `reason`. */
  cause?: unknown;
}

export type Outcome<T, Code extends string = string> =
  | { ok: true; value: T }
  | { ok: false; failure: Failure<Code> };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function failed<Code extends string>(
  code: Code,
  reason: string,
  cause?: unknown,
): { ok: false; failure: Failure<Code> } {
  return {
    ok: false,
    failure: cause === undefined ? { code, reason } : { code, reason, cause },
  };
}

/**
 * `read` at an I/O edge: what it returns, or what it throws as a failure
 * under `code`, its reason `what` followed by the thrown message.
 */
export function attempt<T, Code extends string>(
  code: Code,
  what: string,
  read: () => T,
): Outcome<T, Code> {
  try {
    return ok(read());
  } catch (error) {
    const thrown = error instanceof Error ? error.message : String(error);
    return failed(code, `${what}: ${thrown}`, error);
  }
}
