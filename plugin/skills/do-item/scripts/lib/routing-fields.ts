/**
 * The closed lists a `routing` section names, and the field readers its
 * loaders share (`routing.ts`, `routing-models.ts`). Every refusal is a
 * `RoutingError` whose message opens with the field at fault.
 */

import { formatField, isMapping } from "../../../../shared/config-layers.ts";

/** The complexity tiers a route may name, lightest first. */
export const TIERS = ["simple", "standard", "complex"] as const;
export type Tier = (typeof TIERS)[number];

/** The tier names of earlier releases, read as the tier each became. */
export const LEGACY_TIERS: Readonly<Record<string, Tier>> = {
  execution: "standard",
  strategic: "complex",
};

/** The efforts a route may name, lowest first. */
export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * A routing setting the loading rules refuse. The message opens with the
 * field at fault, so a caller can name the file or variable that set it.
 */
export class RoutingError extends Error {
  readonly code = "routing_config";
}

/** The tier `value` names, a legacy name included, or `undefined`. */
export function tierNamed(value: unknown): Tier | undefined {
  if (typeof value !== "string") return undefined;
  const tier = TIERS.find((t) => t === value);
  return (
    tier ??
    (Object.hasOwn(LEGACY_TIERS, value) ? LEGACY_TIERS[value] : undefined)
  );
}

/** A runtime name, as `routing.models` and `routing.efforts` key it. */
const RUNTIME_NAME = /^[a-z][a-z0-9_-]*$/;
/** A name a runtime takes: one token, so the route record needs no escaping. */
const TOKEN = /^[^\s,;=]+$/;

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined)
    throw new RoutingError(`${field} must be one of ${allowed.join(", ")}`);
  return found;
}

export function refuseUnknownKeys(
  section: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(section))
    if (!allowed.includes(key))
      throw new RoutingError(
        `${where}.${formatField([key])} is not a field of ${where} (${allowed.join(", ")})`,
      );
}

export function token(value: unknown, field: string, what: string): string {
  if (typeof value !== "string" || !TOKEN.test(value))
    throw new RoutingError(
      `${field} must be ${what}: one word, with no space, comma, semicolon or equals sign`,
    );
  return value;
}

export function mapping(
  value: unknown,
  field: string,
  what: string,
): Record<string, unknown> {
  if (!isMapping(value)) throw new RoutingError(`${field} must ${what}`);
  return value;
}

export function runtimeKey(runtime: string, field: string): void {
  if (!RUNTIME_NAME.test(runtime))
    throw new RoutingError(
      `${field}.${formatField([runtime])}: a runtime name is lowercase letters, digits, - and _, starting with a letter (claude-code, codex)`,
    );
}
