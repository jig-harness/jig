/**
 * A pickup the repository's start rules refused (`do_item.preflight_command`):
 * the reason its claim printed and the item's `updatedAt` the rules saw,
 * kept in the launch record's `refusal` column beside its `failed` result.
 * The tick holds the item until its `updatedAt` moves past that time
 * (`actions/pickup-hold.ts`).
 */
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";

export interface PickupRefusal {
  reason: string;
  updatedAt: string;
}

/** A row's refusal; `null` when none, or when it does not read. */
export function readRefusal(
  value: string | null | undefined,
): PickupRefusal | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    swallow(error, "a pickup's refusal that does not read is left unknown");
    return null;
  }
  if (
    !isMapping(parsed) ||
    typeof parsed.reason !== "string" ||
    typeof parsed.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.updatedAt))
  )
    return null;
  return { reason: parsed.reason, updatedAt: parsed.updatedAt };
}
