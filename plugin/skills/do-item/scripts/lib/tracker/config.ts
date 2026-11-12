/**
 * The consumer's tracker settings, read from `issue_tracker` in
 * `.config/jig.yaml`:
 *
 *   issue_tracker:
 *     adapter: github          # which adapter answers; default `github`
 *     team: ENG                # Linear and Jira: the key issue identifiers carry
 *     states:                  # canonical state → the tracker's own name
 *       in_progress: In Progress
 *     labels:                  # label role → the tracker's own label
 *       epic: epic
 *     github:                  # GitHub Issues only (`github.ts`)
 *       repository: owner/name # default: the git remote's repository
 *       states_from: labels    # or `project`, a Projects board's Status field
 *       project: https://github.com/orgs/owner/projects/1
 *       status_field: Status
 *       priority_labels: { urgent: …, high: …, medium: …, low: … }
 *     facets:                  # where type, priority and size are kept (`facets/config.ts`)
 *       size: { store: field, field: Effort }
 *     jira:                    # Jira Cloud only (`jira/settings.ts`)
 *       site: https://example.atlassian.net
 *       issue_type: Task
 *       subtask_type: Sub-task
 *       priorities: { urgent: [Blocker, Highest], high: High, medium: Medium, low: Low }
 *       resolutions: { done: Done, canceled: [Won't Do, Won't Fix], duplicate: Duplicate }
 *       link_types: { blocks: [Blocks, { name: Depends, inverted: true }], related: Relates }
 *       field_labels: { Size: "size:" }
 *       pool_issue_types: [Task, Bug]
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
import {
  CANONICAL_STATES,
  type CanonicalState,
  OPTIONAL_STATES,
  type OptionalState,
  type RequiredState,
  type StateNames,
  type StateMap,
} from "./port.ts";
import { TrackerConfigError } from "./config-error.ts";
import { type GitHubSettings, parseGitHubSettings } from "./github/settings.ts";
import { gitHubModel } from "./github/model.ts";
import { type JiraSettings, parseJiraSettings } from "./jira/settings.ts";
import { jiraStateMaps } from "./jira/state-maps.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import {
  entryLabels,
  type FacetEntries,
  type FacetInputs,
  type Facets,
  parseFacetEntries,
  readTaxonomyValues,
  resolveFacets,
} from "./facets/config.ts";
import { fold, namesIn, PRIORITY_NAMES } from "./facets/values.ts";
import { firstRepeat, refuseSharedNames } from "./settings-fields.ts";
import { DEFAULT_TAXONOMY } from "../../../../file-issue/scripts/lib/config.ts";

export interface TrackerConfig {
  adapter: string;
  /** `null` when the consumer declares no team. */
  team: string | null;
  /** canonical state → tracker state name, defaults filled in; an optional state left unset is `null`. */
  states: StateNames;
  /** The labels the skills act on, by role, defaults filled in. */
  labels: TrackerLabels;
  /** The GitHub adapter's settings, defaults filled in. */
  github: GitHubSettings;
  /** The Jira adapter's settings, defaults filled in. */
  jira: JiraSettings;
  /** `issue_tracker.facets`, checked against the adapter; a facet left out keeps its default. */
  facets: FacetEntries;
  /** `issue_tracker.types`: work type → the labels that mark it; `null` when unset. */
  types: Record<string, string[]> | null;
  /** `issue_tracker.taxonomy` as written, or the default `label-taxonomy.yaml`. */
  taxonomy: string;
}

export const DEFAULT_ADAPTER = "github";

/** A canonical key as a display name: `in_progress` → `In Progress`. */
export function defaultStateName(state: CanonicalState): string {
  return state
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isOptionalState(state: CanonicalState): state is OptionalState {
  return (OPTIONAL_STATES as readonly string[]).includes(state);
}

/** Every state at its default: each required key title-cased, each optional one unset. */
export function defaultStateNames(): StateNames {
  return Object.fromEntries(
    CANONICAL_STATES.map((s) => [
      s,
      isOptionalState(s) ? null : defaultStateName(s as RequiredState),
    ]),
  ) as StateNames;
}

/** A team key as issue identifiers carry it. */
export const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;

/**
 * States that may share one tracker name: each group reads the same way
 * wherever a name is mapped back to a state (all not started; merged and
 * parked; waiting for a person's review; all abandoned), so a tracker without
 * a separate triage, operations or duplicate state loses nothing by aliasing
 * them. Naming `ops_pending` like `in_review` is how a tracker with no
 * operations state holds a merged issue in review, the fallback do-item
 * documents. Naming `pr_open` like `in_review` (and `ops_pending` with it)
 * is a tracker with one review status, used while the pull request is open
 * and after the merge; that shared name reads back as `pr_open`, active
 * work, since the tracker cannot say whether the pull request merged. The
 * parent roll-up tells the two apart by the child's linked pull request.
 * `pr_open` shares a name only together with `in_review`.
 */
const ALIASABLE_STATES: ReadonlyArray<ReadonlyArray<CanonicalState>> = [
  ["triage", "backlog", "todo"],
  ["in_review", "ops_pending"],
  ["pr_open", "in_review", "ops_pending"],
  ["canceled", "duplicate"],
];

/**
 * On Jira, one `Done` status with a resolution per outcome is the common
 * shape, and the resolution tells the closed states apart, so `done` may
 * share their name too when the resolutions differ.
 */
const JIRA_CLOSED: ReadonlyArray<CanonicalState> = [
  "done",
  "canceled",
  "duplicate",
];

/**
 * Refuse two states named alike outside one aliasable group. The skills map a
 * tracker's state name back to its canonical state (a child "in review" caps
 * its parent there); an `in_review` named like `in_progress` would read every
 * active child as parked.
 */
function refuseAmbiguousStates(
  states: StateMap,
  adapter: string,
  jira: JiraSettings,
  at = "issue_tracker.states",
): void {
  const r = jira.resolutions;
  const resolved =
    adapter === "jira" &&
    firstRepeat([...r.done, ...r.canceled, ...r.duplicate]) === undefined;
  const groups = resolved
    ? [...ALIASABLE_STATES.filter((g) => !g.includes("canceled")), JIRA_CLOSED]
    : ALIASABLE_STATES;
  const seen = new Map<string, CanonicalState[]>();
  for (const s of CANONICAL_STATES) {
    const name = states[s];
    if (name === null) continue;
    const key = name.trim().toLowerCase();
    const sharing = [...(seen.get(key) ?? []), s];
    if (
      sharing.length > 1 &&
      (!groups.some((g) => sharing.every((t) => g.includes(t))) ||
        (sharing.includes("pr_open") && !sharing.includes("in_review")))
    )
      throw new TrackerConfigError(
        `${at}.${s}`,
        `${at}.${sharing[0]} and ${at}.${s} both name '${name}'; each state needs its own name`,
      );
    seen.set(key, sharing);
  }
}

/** Validate the repository map and each Jira type's effective workflow. */
function refuseWorkflowAmbiguity(
  states: StateMap,
  adapter: string,
  jira: JiraSettings,
): void {
  refuseAmbiguousStates(states, adapter, jira);
  if (adapter !== "jira") return;
  for (const [type, map] of Object.entries(jiraStateMaps(states, jira)))
    refuseAmbiguousStates(
      map,
      adapter,
      jira,
      `issue_tracker.jira.states_by_type.${type}`,
    );
}

/**
 * Refuse a GitHub priority label that is also a state label. In labels mode
 * both are labels, so one label would set a state and a priority together,
 * and changing either would drop the other.
 */
function refuseSharedLabels(
  adapter: string,
  states: StateNames,
  github: GitHubSettings,
): void {
  if (adapter !== "github") return;
  const { stateLabels } = gitHubModel(states, github);
  for (const [priority, labels] of Object.entries(github.priorityLabels))
    for (const label of labels) {
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

/**
 * `team` is Linear's key. Under the default GitHub adapter it would be
 * ignored without a word, so a file that predates the default's change is
 * refused until it names its adapter. An empty `adapter:` (null) falls back
 * to the default like an omitted one, so it is refused the same way.
 */
function refuseTeamWithoutAdapter(adapter: unknown, team: unknown): void {
  if ((adapter === undefined || adapter === null) && team !== null)
    throw new TrackerConfigError(
      "issue_tracker.adapter",
      `issue_tracker.team is set but issue_tracker.adapter is not, and the default adapter is ${DEFAULT_ADAPTER}, which has no team; set issue_tracker.adapter: linear (or jira) to keep ${team} issue keys`,
    );
}

/** `issue_tracker.types` as work type → labels, its shape checked; `null` when unset. */
function typeLabelsOf(raw: unknown): Record<string, string[]> | null {
  if (raw === undefined || raw === null) return null;
  const bad = (field: string, what: string) =>
    new TrackerConfigError(field, `${field} must be ${what}`);
  if (!isRecord(raw) || Object.keys(raw).length === 0)
    throw bad(
      "issue_tracker.types",
      "a mapping from at least one type to the labels that mark it",
    );
  const out: Record<string, string[]> = {};
  for (const [type, list] of Object.entries(raw)) {
    const field = `issue_tracker.types.${type}`;
    if (
      !Array.isArray(list) ||
      !list.every((l) => typeof l === "string" && l.trim() !== "") ||
      new Set(list).size !== list.length
    )
      throw bad(field, "a list of distinct nonempty label names");
    out[type] = [...list];
  }
  return out;
}

/** `issue_tracker.taxonomy` as written, or the default. */
function taxonomyOf(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_TAXONOMY;
  if (typeof raw !== "string" || raw.trim() === "")
    throw new TrackerConfigError(
      "issue_tracker.taxonomy",
      "issue_tracker.taxonomy must be a path to the label taxonomy, relative to the repository root",
    );
  return raw;
}

/**
 * On GitHub, the priority labels a facet entry names become the adapter's;
 * `priority_labels` set too must name the same ones.
 */
function withFacetPriorityLabels(
  github: GitHubSettings,
  adapter: string,
  facets: FacetEntries,
  raw: unknown,
): GitHubSettings {
  const entry = facets.priority;
  if (
    adapter !== "github" ||
    entry?.store !== "label" ||
    (entry.labels === undefined && entry.prefix === undefined)
  )
    return github;
  const labels = { ...github.priorityLabels };
  for (const p of PRIORITY_NAMES)
    labels[p] = entryLabels(entry, p, () => labels[p]);
  const declared = isRecord(raw) && raw.priority_labels !== undefined;
  const differs = PRIORITY_NAMES.find(
    (p) => !sameNames(labels[p], github.priorityLabels[p]),
  );
  if (declared && differs !== undefined)
    throw new TrackerConfigError(
      "issue_tracker.facets.priority",
      `issue_tracker.facets.priority keeps ${differs} in '${labels[differs].join("', '")}', but issue_tracker.github.priority_labels.${differs} names '${github.priorityLabels[differs].join("', '")}'; keep one, or make them agree`,
    );
  return { ...github, priorityLabels: labels };
}

/** Whether two lists name the same things in the same order, ignoring case. */
const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((n, i) => fold(n) === fold(b[i] as string));

/**
 * On Jira, a native priority's `values` are the Jira priorities;
 * `issue_tracker.jira.priorities` set too must name the same ones.
 */
function withFacetPriorities(
  jira: JiraSettings,
  adapter: string,
  facets: FacetEntries,
  raw: unknown,
): JiraSettings {
  const values = facets.priority?.values;
  if (adapter !== "jira" || values === undefined) return jira;
  const declared =
    isRecord(raw) && isRecord(raw.priorities) ? raw.priorities : {};
  const priorities = { ...jira.priorities };
  for (const [key, listed] of Object.entries(values)) {
    const p = PRIORITY_NAMES.find((n) => fold(n) === fold(key));
    if (p === undefined) continue;
    const names = [...namesIn(listed)];
    if (declared[p] !== undefined && !sameNames(jira.priorities[p], names))
      throw new TrackerConfigError(
        `issue_tracker.facets.priority.values.${key}`,
        `issue_tracker.facets.priority.values.${key} names '${names.join("', '")}', but issue_tracker.jira.priorities.${p} names '${jira.priorities[p].join("', '")}'; keep one, or make them agree`,
      );
    priorities[p] = names;
  }
  refuseSharedNames(
    "issue_tracker.facets.priority.values",
    PRIORITY_NAMES.map((p) => [p, priorities[p]] as const),
    "priority",
    new Set([...Object.keys(values).map(fold), ...Object.keys(declared)]),
  );
  return { ...jira, priorities };
}

/** What resolving the facets reads from the tracker configuration. */
export function facetInputs(config: TrackerConfig): FacetInputs {
  return {
    adapter: config.adapter,
    entries: config.facets,
    types: config.types,
    bugLabels: config.labels.bug,
    epic: config.labels.epic,
    epicTypes: config.labels.epicTypes,
    priorityLabels:
      config.adapter === "github" ? config.github.priorityLabels : null,
    priorityLabelsDeclared: config.github.priorityLabelsDeclared,
    jiraPriorities: config.adapter === "jira" ? config.jira.priorities : null,
    jiraFieldLabels: config.adapter === "jira" ? config.jira.fieldLabels : null,
    stateLabels:
      config.adapter === "github"
        ? gitHubModel(config.states, config.github).stateLabels
        : [],
  };
}

/**
 * The repository's facets: the configuration, with the type and size values
 * of the label taxonomy of the repository at `root`, or with none when
 * `root` is `null`.
 */
export function facetsOf(config: TrackerConfig, root: string | null): Facets {
  return resolveFacets(
    facetInputs(config),
    root === null ? null : readTaxonomyValues(root, config.taxonomy),
  );
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

  refuseTeamWithoutAdapter(section.adapter, team);

  const states = defaultStateNames();
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
  const facets = parseFacetEntries(section.facets, adapter);
  const github = withFacetPriorityLabels(
    parseGitHubSettings(section.github),
    adapter,
    facets,
    section.github,
  );
  const jira = withFacetPriorities(
    parseJiraSettings(section.jira),
    adapter,
    facets,
    section.jira,
  );
  refuseWorkflowAmbiguity(states, adapter, jira);
  refuseSharedLabels(adapter, states, github);
  return {
    adapter,
    team,
    states,
    labels: parseTrackerLabels(overlay),
    github,
    jira,
    facets,
    types: typeLabelsOf(section.types),
    taxonomy: taxonomyOf(section.taxonomy),
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
