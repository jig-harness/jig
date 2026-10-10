/**
 * The consumer's tracker settings, read from `issue_tracker` in
 * `.config/groundwork-overlay.yaml`:
 *
 *   issue_tracker:
 *     adapter: linear          # which adapter answers; default `linear`
 *     team: ENG                # the key issue identifiers carry
 *     states:                  # canonical state → the tracker's own name
 *       in_progress: In Progress
 *
 * Every field is optional here; an operation that needs one it lacks fails
 * with a message naming the field.
 */

import { existsSync } from "node:fs";
import {
  overlayPath,
  readOverlay,
} from "../../../../resolve-review-comments/scripts/lib/consumer.ts";
import { CANONICAL_STATES, type CanonicalState } from "./port.ts";

export interface TrackerConfig {
  adapter: string;
  /** `null` when the consumer declares no team. */
  team: string | null;
  /** canonical state → tracker state name, defaults filled in. */
  states: Record<CanonicalState, string>;
}

export const DEFAULT_ADAPTER = "linear";

/** A canonical key as a display name: `in_progress` → `In Progress`. */
export function defaultStateName(state: CanonicalState): string {
  return state
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A team key as issue identifiers carry it. */
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the `issue_tracker` section of a parsed overlay. */
export function parseTrackerConfig(
  overlay: Record<string, unknown>,
): TrackerConfig {
  const raw = overlay.issue_tracker;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new Error("issue_tracker must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;

  const adapter = section.adapter ?? DEFAULT_ADAPTER;
  if (typeof adapter !== "string" || adapter.trim() === "")
    throw new Error("issue_tracker.adapter must be a nonempty string");

  const team = section.team ?? null;
  if (
    team !== null &&
    (typeof team !== "string" || !TEAM_KEY_PATTERN.test(team))
  )
    throw new Error(
      `issue_tracker.team must be an issue key prefix such as ENG (got ${JSON.stringify(team)})`,
    );

  const states = Object.fromEntries(
    CANONICAL_STATES.map((s) => [s, defaultStateName(s)]),
  ) as Record<CanonicalState, string>;
  const rawStates = section.states;
  if (rawStates !== undefined && rawStates !== null) {
    if (!isRecord(rawStates))
      throw new Error("issue_tracker.states must be a mapping");
    for (const [key, name] of Object.entries(rawStates)) {
      if (!(CANONICAL_STATES as readonly string[]).includes(key))
        throw new Error(
          `issue_tracker.states.${key} is not a canonical state (${CANONICAL_STATES.join(", ")})`,
        );
      if (typeof name !== "string" || name.trim() === "")
        throw new Error(
          `issue_tracker.states.${key} must be a nonempty string`,
        );
      states[key as CanonicalState] = name;
    }
  }
  return { adapter, team, states };
}

/** The consumer's tracker settings; throws when the overlay is missing or invalid. */
export function trackerConfig(): TrackerConfig {
  return parseTrackerConfig(readOverlay());
}

/**
 * The consumer's team key, or `null` when the repository has no overlay or
 * declares no team. For callers that only recognise issue keys in text and
 * can do without them.
 */
export function teamKeyOrNull(): string | null {
  if (!existsSync(overlayPath())) return null;
  return trackerConfig().team;
}

/** The consumer's team key; throws naming the field when it is not set. */
export function requireTeamKey(
  config: TrackerConfig = trackerConfig(),
): string {
  if (config.team === null)
    throw new Error(
      "issue_tracker.team is not set in the consumer overlay; it names the key issue identifiers carry (e.g. ENG for ENG-123)",
    );
  return config.team;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The source of a pattern matching one issue key of `team` (no anchors, no flags). */
export function issueKeySource(team: string): string {
  return `${escapeRe(team)}-\\d+`;
}
