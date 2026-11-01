/**
 * What every adapter's settings parser does alike: read its section of
 * `issue_tracker` as a mapping of known fields, and a field as a nonempty
 * string, each refusal naming the field.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import { TrackerConfigError } from "./config-error.ts";

export function nonEmpty(v: unknown, at: string): string {
  if (typeof v !== "string" || v.trim() === "")
    throw new TrackerConfigError(at, `${at} must be a nonempty string`);
  return v;
}

/**
 * The `issue_tracker.<name>` mapping, empty when absent; a field outside
 * `fields` is refused.
 */
export function settingsSection(
  raw: unknown,
  name: string,
  fields: ReadonlyArray<string>,
): Record<string, unknown> {
  const at = `issue_tracker.${name}`;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new TrackerConfigError(at, `${at} must be a mapping`);
  const section = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(section).find((k) => !fields.includes(k));
  if (unknown !== undefined)
    throw new TrackerConfigError(
      `${at}.${unknown}`,
      `${at}.${unknown} is not a field (${fields.join(", ")})`,
    );
  return section;
}
