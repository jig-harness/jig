/**
 * A repository's `dispatch` section, read from the configuration file its
 * default branch holds on the forge. A tick never reads it from a checkout:
 * the tick works beside pull requests' head branches, and a section read
 * there would let an unreviewed change choose what a timer starts.
 */
import { isMapping, parseConfigText } from "../../shared/config-layers.ts";
import { CANONICAL_STATES } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { duration } from "./machine-config.ts";
import type { DispatchSection } from "./types.ts";

const DEFAULT_STATES = ["todo"];
/** `stalled_after` and `blocked_after`'s default. */
const DEFAULT_WAIT_MS = 30 * 60_000;
/** The expectations' defaults: `drive_rounds_flat`, `pickup_within`, `followup_within`. */
const DEFAULT_ROUNDS_FLAT = 3;
const DEFAULT_PICKUP_WITHIN_MS = 2 * 3_600_000;
const DEFAULT_FOLLOWUP_WITHIN_MS = 3_600_000;
const KEYS = [
  "identity",
  "states",
  "followup_command",
  "stalled_after",
  "blocked_after",
  "drive_rounds_flat",
  "pickup_within",
  "followup_within",
];

class SectionError extends Error {}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "")
    throw new SectionError(`dispatch.${field} must be a nonempty string`);
  return value.trim();
}

function states(value: unknown): string[] {
  if (value === undefined || value === null) return DEFAULT_STATES;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((s) => !(CANONICAL_STATES as readonly unknown[]).includes(s))
  )
    throw new SectionError(
      `dispatch.states must be a nonempty list of canonical states (${CANONICAL_STATES.join(", ")})`,
    );
  if (new Set(value).size !== value.length)
    throw new SectionError("dispatch.states lists a state twice");
  // `do-item`'s claim moves an item there: a claimed item is never a pickup.
  if (value.includes("in_progress"))
    throw new SectionError(
      "dispatch.states cannot list in_progress, the state do-item's claim moves an item to",
    );
  return value as string[];
}

function rounds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_ROUNDS_FLAT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new SectionError(
      "dispatch.drive_rounds_flat must be a positive whole number",
    );
  return value;
}

function wait(
  value: unknown,
  field: string,
  fallback = DEFAULT_WAIT_MS,
): number {
  if (value === undefined || value === null) return fallback;
  try {
    return duration(value, `dispatch.${field}`);
  } catch (error) {
    throw new SectionError((error as Error).message);
  }
}

/** The `dispatch` section of parsed configuration values, with defaults. */
export function dispatchSection(
  values: Record<string, unknown>,
): DispatchSection {
  const raw = values.dispatch;
  if (raw !== undefined && raw !== null && !isMapping(raw))
    throw new SectionError("dispatch must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(section).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0)
    throw new SectionError(
      `dispatch has unknown key(s): ${unknown.join(", ")} (known: ${KEYS.join(", ")})`,
    );
  return {
    identity: text(section.identity, "identity"),
    states: states(section.states),
    followupCommand: text(section.followup_command, "followup_command"),
    stalledAfterMs: wait(section.stalled_after, "stalled_after"),
    blockedAfterMs: wait(section.blocked_after, "blocked_after"),
    driveRoundsFlat: rounds(section.drive_rounds_flat),
    pickupWithinMs: wait(
      section.pickup_within,
      "pickup_within",
      DEFAULT_PICKUP_WITHIN_MS,
    ),
    followupWithinMs: wait(
      section.followup_within,
      "followup_within",
      DEFAULT_FOLLOWUP_WITHIN_MS,
    ),
  };
}

/** The configuration file's values, and its `dispatch` section. */
export function readSection(
  file: string | null,
  where: string,
): { values: Record<string, unknown>; section: DispatchSection } {
  const values = file === null ? {} : parseConfigText(file, where);
  return { values, section: dispatchSection(values) };
}
