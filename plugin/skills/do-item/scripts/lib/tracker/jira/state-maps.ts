/** Per-native-type workflow names, overlaid on the repository's state map. */
import { isRecord } from "../../../../../../shared/guards.ts";
import { TrackerConfigError } from "../config-error.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  type StateContext,
  type StateMap,
} from "../port.ts";

export type StatesByType = Record<string, Partial<StateMap>>;
const AT = "issue_tracker.jira.states_by_type";
const fold = (name: string) => name.trim().toLowerCase();

export function parseStatesByType(raw: unknown): StatesByType {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw))
    throw new TrackerConfigError(AT, `${AT} must be a mapping`);
  const result: StatesByType = Object.create(null);
  for (const [type, entry] of Object.entries(raw)) {
    const at = `${AT}.${type}`;
    if (
      type.trim() === "" ||
      Object.keys(result).some((t) => fold(t) === fold(type))
    )
      throw new TrackerConfigError(
        at,
        `${AT} needs distinct nonempty issue type names`,
      );
    result[type.trim()] = parseStateMap(entry, at);
  }
  return result;
}

/** One type's overrides, with every key and nullable name checked. */
function parseStateMap(entry: unknown, at: string): Partial<StateMap> {
  if (!isRecord(entry))
    throw new TrackerConfigError(at, `${at} must be a state mapping`);
  const map: Partial<StateMap> = {};
  for (const [state, name] of Object.entries(entry)) {
    if (!(CANONICAL_STATES as readonly string[]).includes(state))
      throw new TrackerConfigError(
        `${at}.${state}`,
        `${at}.${state} is not a canonical state`,
      );
    if (name !== null && (typeof name !== "string" || name.trim() === ""))
      throw new TrackerConfigError(
        `${at}.${state}`,
        `${at}.${state} must be a nonempty state name or null`,
      );
    map[state as CanonicalState] =
      typeof name === "string" ? name.trim() : null;
  }
  return map;
}

/** Missing native types use the repository map; names match ignoring case. */
export function statesForType(
  base: StateMap,
  settings: { statesByType: StatesByType },
  context: StateContext,
): StateMap {
  const type = typeof context === "string" ? context : context?.nativeType;
  const entry =
    type == null
      ? undefined
      : Object.entries(settings.statesByType).find(
          ([name]) => fold(name) === fold(type),
        )?.[1];
  return { ...base, ...entry };
}

/** Every configured type's effective map, without a tracker request. */
export function jiraStateMaps(
  base: StateMap,
  settings: { statesByType: StatesByType },
): Record<string, StateMap> {
  return Object.fromEntries(
    Object.keys(settings.statesByType).map((type) => [
      type,
      statesForType(base, settings, type),
    ]),
  );
}
