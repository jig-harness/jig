/**
 * The consumer's tracker settings, read from `issue_tracker` in
 * `.config/jig.yaml`:
 *
 *   issue_tracker:
 *     adapter: linear          # which adapter answers; default `linear`
 *     team: ENG                # Linear: the key issue identifiers carry
 *     states:                  # canonical state → the tracker's own name
 *       in_progress: In Progress
 *     labels:                  # label role → the tracker's own label
 *       epic: epic
 *     github:                  # GitHub Issues only (`github.ts`)
 *       repository: owner/name # default: the `origin` remote's repository
 *       states_from: labels    # or `project`, a Projects board's Status field
 *       project: https://github.com/orgs/owner/projects/1
 *       status_field: Status
 *       priority_labels: { urgent: …, high: …, medium: …, low: … }
 *
 * Every field is optional here; an operation that needs one it lacks fails
 * with a message naming the field.
 */

import { readOverlay, withSource } from "../../../../../shared/consumer.ts";
import {
  parseTrackerLabels,
  type TrackerLabels,
} from "../../../../../shared/tracker-labels.ts";
import { refuseRenamedSection } from "../overlay.ts";
import { CANONICAL_STATES, type CanonicalState } from "./port.ts";
import { TrackerConfigError } from "./config-error.ts";
import { type GitHubSettings, parseGitHubSettings } from "./github/settings.ts";
import { gitHubModel } from "./github/model.ts";
import { isRecord } from "../../../../../shared/guards.ts";

export interface TrackerConfig {
  adapter: string;
  /** `null` when the consumer declares no team. */
  team: string | null;
  /** canonical state → tracker state name, defaults filled in. */
  states: Record<CanonicalState, string>;
  /** The labels the skills act on, by role, defaults filled in. */
  labels: TrackerLabels;
  /** The GitHub adapter's settings, defaults filled in. */
  github: GitHubSettings;
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

/**
 * States that may share one tracker name: each group reads the same way
 * wherever a name is mapped back to a state (all not started; merged and
 * parked; all abandoned), so a tracker without a separate triage, operations
 * or duplicate state loses nothing by aliasing them. Naming `ops_pending`
 * like `in_review` is how a tracker with no operations state holds a merged
 * issue in review, the fallback do-item documents.
 */
const ALIASABLE_STATES: ReadonlyArray<ReadonlyArray<CanonicalState>> = [
  ["triage", "backlog", "todo"],
  ["in_review", "ops_pending"],
  ["canceled", "duplicate"],
];

/**
 * Refuse two states named alike outside one aliasable group. The skills map a
 * tracker's state name back to its canonical state (a child "in review" caps
 * its parent there); an `in_review` named like `in_progress` would read every
 * active child as parked.
 */
function refuseAmbiguousStates(states: Record<CanonicalState, string>): void {
  const group = (s: CanonicalState) =>
    ALIASABLE_STATES.findIndex((g) => g.includes(s));
  const seen = new Map<string, CanonicalState>();
  for (const s of CANONICAL_STATES) {
    const key = states[s].trim().toLowerCase();
    const other = seen.get(key);
    if (
      other !== undefined &&
      (group(other) === -1 || group(other) !== group(s))
    )
      throw new TrackerConfigError(
        `issue_tracker.states.${s}`,
        `issue_tracker.states.${other} and issue_tracker.states.${s} both name '${states[s]}'; each state needs its own name`,
      );
    seen.set(key, s);
  }
}

/**
 * Refuse a GitHub priority label that is also a state label. In labels mode
 * both are labels, so one label would set a state and a priority together,
 * and changing either would drop the other.
 */
function refuseSharedLabels(
  adapter: string,
  states: Record<CanonicalState, string>,
  github: GitHubSettings,
): void {
  if (adapter !== "github") return;
  const { stateLabels } = gitHubModel(states, github);
  for (const [priority, label] of Object.entries(github.priorityLabels)) {
    const state = stateLabels.find(
      (l) => l.trim().toLowerCase() === label.trim().toLowerCase(),
    );
    if (state !== undefined)
      throw new TrackerConfigError(
        `issue_tracker.github.priority_labels.${priority}`,
        `issue_tracker.github.priority_labels.${priority} names '${label}', which is also the label of a state in issue_tracker.states; a priority needs a label of its own`,
      );
  }
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
  refuseAmbiguousStates(states);
  const github = parseGitHubSettings(section.github);
  refuseSharedLabels(adapter, states, github);
  return {
    adapter,
    team,
    states,
    labels: parseTrackerLabels(overlay),
    github,
  };
}

/**
 * `parseTrackerConfig` over merged configuration values (`readConfig`,
 * `readOverlay`, `layeredConfig`), its errors naming the file or variable
 * that set the field at fault. The labels also read legacy `review` fields.
 */
export function trackerConfigFrom(
  values: Record<string, unknown>,
): TrackerConfig {
  try {
    return parseTrackerConfig(values);
  } catch (err) {
    throw withSource(values, ["issue_tracker", "review"], err);
  }
}

/** The consumer's tracker settings; throws when the overlay is missing or invalid. */
export function trackerConfig(): TrackerConfig {
  return trackerConfigFrom(readOverlay());
}

/**
 * The tracker settings as this skill's own scripts read them: like
 * `trackerConfig`, but refusing an overlay that predates the rename, so no
 * do-item script accepts a configuration another one refuses. Other skills
 * read `trackerConfig`; the `do_issue` section is not theirs to police.
 */
export function ownTrackerConfig(): TrackerConfig {
  const overlay = readOverlay();
  refuseRenamedSection(overlay);
  return trackerConfigFrom(overlay);
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
