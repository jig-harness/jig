/**
 * The shape checks the review-triage file's readers share (`ladder.ts`,
 * `severity-mapping.ts`): each throws `ConfigError` naming the field.
 */
import { isRecord } from "../../../../shared/guards.ts";

/** A review-triage file that does not have the shape its readers need. */
export class ConfigError extends Error {}

export function mappingAt(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ConfigError(`${what} must be a mapping`);
  return v;
}

/**
 * Reject a mapping key this loader does not know about. A silently-ignored
 * key (a typo'd `min_severty`, say) is dropped without error whenever another
 * clause still admits — indistinguishable from the typo never having been
 * written — which is exactly the "read nothing, report all clear" shape a
 * gate must never take.
 */
export function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${what} has unknown key(s): ${unknown.join(", ")} — allowed: ${allowed.join(", ")}`,
    );
  }
}
