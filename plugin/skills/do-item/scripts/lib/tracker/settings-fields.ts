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

/**
 * A map entry that names one thing or several: a nonempty string, or a
 * nonempty list of them, each trimmed. `what` names the thing in the
 * refusal ("priority", "label").
 */
export function nameList(v: unknown, at: string, what: string): string[] {
  if (!Array.isArray(v)) return [nonEmpty(v, at).trim()];
  if (v.length === 0)
    throw new TrackerConfigError(at, `${at} names no ${what}`);
  return v.map((n, i) => nonEmpty(n, `${at}[${i}]`).trim());
}

const folded = (s: string) => s.trim().toLowerCase();

/** The first name that an earlier entry already has, compared trimmed and without case. */
export function firstRepeat(names: ReadonlyArray<string>): string | undefined {
  return names.find(
    (n, i) => names.findIndex((m) => folded(m) === folded(n)) !== i,
  );
}

/**
 * Refuse a name one key lists twice, or two keys share, compared trimmed
 * and without case, so a name read back names one key. A clash with a key
 * the configuration did not set (one outside `configured`) names that
 * key's default as the other side.
 */
export function refuseSharedNames(
  at: string,
  entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
  what: string,
  configured: ReadonlySet<string>,
): void {
  const owner = new Map<string, string>();
  for (const [key, names] of entries) {
    const twice = firstRepeat(names);
    if (twice !== undefined)
      throw new TrackerConfigError(
        `${at}.${key}`,
        `${at}.${key} names '${twice}' twice`,
      );
    for (const name of names) {
      const other = owner.get(folded(name));
      if (other !== undefined) {
        const fallback = [other, key].find((k) => !configured.has(k));
        throw new TrackerConfigError(
          at,
          `${at} gives ${other} and ${key} the one ${what} '${name}'${fallback === undefined ? "" : ` (${fallback}'s default)`}; each needs its own, so a ${what} read back names one`,
        );
      }
      owner.set(folded(name), key);
    }
  }
}
