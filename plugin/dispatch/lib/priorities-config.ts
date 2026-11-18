/**
 * The machine file's `priorities:` section: whether the dispatcher takes its
 * pickup starts in the order the declared-priorities ranking gives
 * (`priorities-order.ts`), or only reports that ranking beside its own
 * selection. Off unless the file says `enforce: true`.
 *
 * ```yaml
 * priorities:
 *   enforce: false
 * ```
 */
import { isMapping } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

export interface PrioritiesSettings {
  /** Whether pickups start in the ranking's order, and a lane out of rotation starts nothing. */
  enforce: boolean;
}

const KEYS = ["enforce"];

export function prioritiesSettings(
  value: unknown,
): Outcome<PrioritiesSettings, "invalid"> {
  if (value === undefined || value === null) return ok({ enforce: false });
  if (!isMapping(value))
    return failed("invalid", "priorities must be a mapping");
  const unknown = Object.keys(value).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0)
    return failed(
      "invalid",
      `priorities has unknown key(s): ${unknown.join(", ")} (known: ${KEYS.join(", ")})`,
    );
  const enforce = value.enforce ?? false;
  if (typeof enforce !== "boolean")
    return failed("invalid", "priorities.enforce must be true or false");
  return ok({ enforce });
}
