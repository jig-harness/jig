/**
 * A repository's `dispatch` section, read from the configuration file its
 * default branch holds on the forge. A tick never reads it from a checkout:
 * the tick works beside pull requests' head branches, and a section read
 * there would let an unreviewed change choose what a timer starts.
 */
import { parseConfigText } from "../../shared/config-layers.ts";
import { isRecord } from "../../shared/guards.ts";
import { CANONICAL_STATES } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { DispatchSection } from "./types.ts";

export const DEFAULT_STATES = ["todo"];

export class SectionError extends Error {}

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
  return value as string[];
}

/** The `dispatch` section of parsed configuration values, with defaults. */
export function dispatchSection(
  values: Record<string, unknown>,
): DispatchSection {
  const raw = values.dispatch;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new SectionError("dispatch must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;
  return {
    identity: text(section.identity, "identity"),
    states: states(section.states),
    followupCommand: text(section.followup_command, "followup_command"),
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
