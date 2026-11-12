/**
 * The issue-tracker labels the skills act on, by role: the consumer's
 * `issue_tracker.labels` in `.config/jig.yaml`, with a default
 * for every role.
 *
 * The skills read a handful of labels as process signals rather than as
 * categories: an epic, a human-in-the-loop flag and its facets, a manual
 * operations step, a review follow-up, a bug, a recurring pattern, the sizes
 * that may be batched. A repository whose tracker spells them differently
 * names its own labels here once, and every skill reads the same map.
 *
 * Two roles predate this map as `review.taxonomy.epic_label` and
 * `review.taxonomy.provenance_label`. Those fields still work and fill the
 * role when `issue_tracker.labels` leaves it unset; setting both to different
 * names is an error, since the skills would then disagree about which issues
 * are epics or follow-ups.
 *
 * An epic is also recognized by the tracker's own issue type:
 * `issue_tracker.labels.epic_types` lists the native types (Jira's Epic, a
 * GitHub issue type) whose issues read as epics beside those carrying the
 * label. `isEpic` is the one test for it; nothing else compares an issue's
 * labels or type with the epic role.
 *
 * Lives beside the review skill's configuration reader because every skill
 * that reads labels already depends on this directory, and it on none of
 * them.
 */
import { isRecord } from "./guards.ts";

const LABEL_ROLES = [
  "epic",
  "hitl",
  "manual_ops",
  "followup",
  "bug",
  "pattern_prefix",
  "batch_sizes",
  "extractable_tails",
] as const;
export type LabelRole = (typeof LABEL_ROLES)[number];

/** The key beside the roles that names the native types of an epic. */
const EPIC_TYPES = "epic_types";

/** Every key `issue_tracker.labels` takes: the roles and `epic_types`. */
export const LABEL_KEYS: readonly string[] = [...LABEL_ROLES, EPIC_TYPES];

export interface TrackerLabels {
  /** Marks an issue as an epic whose sub-issues are worked one at a time. */
  epic: string;
  /** Native issue types whose issues read as epics; empty when unset. */
  epicTypes: string[];
  /** The human-in-the-loop flag; its facets are `<hitl>:<stakeholder>`. */
  hitl: string;
  /** A step a person must perform outside the code (deploy, provisioning). */
  manualOps: string;
  /** Marks an issue filed from a review finding. */
  followup: string;
  /** Any of these marks a bug. */
  bug: string[];
  /** A recurring pattern's label is `<prefix><slug>`. */
  patternPrefix: string;
  /** Size labels whose issues the batch check may group into one pull request. */
  batchSizes: string[];
  /** Labels whose open sub-issues an epic may hand off instead of finishing. */
  extractableTails: string[];
  /** The roles the consumer named, here or through `review.taxonomy`. */
  declared: Set<LabelRole>;
}

const DEFAULT_LABELS = {
  epic: "epic",
  hitl: "hitl",
  manual_ops: "manual-ops",
  followup: "pr-followup",
  bug: ["bug", "type:bug"],
  pattern_prefix: "pattern:",
  batch_sizes: ["xs", "small", "medium"],
} as const;

/** The facets of the human-in-the-loop flag that an epic may hand off. */
const EXTRACTABLE_HITL_FACETS = ["legal", "tactical"] as const;

const fold = (s: string) => s.trim().toLowerCase();

/** How an epic is recognized: its label, or one of its native issue types. */
export interface EpicRecognition {
  epic: string;
  epicTypes: ReadonlyArray<string>;
}

/**
 * Whether an issue is an epic: it carries the epic label, or its tracker's
 * own issue type is one of `epicTypes`, each matched ignoring case. The one
 * test every skill asks, through an issue's `isEpic` where the tracker
 * interface sets it, so a type-derived epic is never written the label.
 */
export function isEpic(
  issue: { labels: ReadonlyArray<string>; nativeType?: string | null },
  by: EpicRecognition,
): boolean {
  const label = fold(by.epic);
  if (issue.labels.some((l) => fold(l) === label)) return true;
  const type = issue.nativeType;
  return (
    typeof type === "string" && by.epicTypes.some((t) => fold(t) === fold(type))
  );
}

/**
 * The issue types a read by `label` also takes: the epic's types when
 * `label` is the epic label, else none.
 */
export function epicTypesOfLabel(
  label: string,
  by: EpicRecognition,
): ReadonlyArray<string> {
  return fold(label) === fold(by.epic) ? by.epicTypes : [];
}

/** `issue_tracker.labels.epic_types`, none when absent. */
function epicTypesOf(raw: Record<string, unknown>): string[] {
  const at = `issue_tracker.labels.${EPIC_TYPES}`;
  return raw[EPIC_TYPES] === undefined
    ? []
    : labelList(raw[EPIC_TYPES], at, "issue type").map((t) => t.trim());
}

function oneLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a nonempty label name`);
  return value;
}

function labelList(value: unknown, field: string, what = "label"): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((l) => typeof l !== "string" || l.trim() === "") ||
    new Set(value).size !== value.length
  )
    throw new Error(
      `${field} must be a list of distinct nonempty ${what} names`,
    );
  return value as string[];
}

/**
 * The label vocabulary of a parsed overlay. Throws, naming the field, on an
 * unknown role, a wrong type, or a role named differently here and in
 * `review.taxonomy`. A role set to null is a wrong type, not an omitted
 * role: it would otherwise quietly restore the default it was written to
 * change; the same holds for a null `review.taxonomy` legacy label. An empty
 * `issue_tracker` or `labels` key (YAML's null) reads as absent, as
 * `issue_tracker.states` does.
 */
export function parseTrackerLabels(
  overlay: Record<string, unknown>,
): TrackerLabels {
  const tracker = overlay.issue_tracker;
  if (tracker !== undefined && tracker !== null && !isRecord(tracker))
    throw new Error("issue_tracker must be a mapping");
  const rawLabels = isRecord(tracker) ? tracker.labels : undefined;
  if (rawLabels !== undefined && rawLabels !== null && !isRecord(rawLabels))
    throw new Error(
      "issue_tracker.labels must be a mapping from role to label",
    );
  const raw = (rawLabels ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!LABEL_KEYS.includes(key))
      throw new Error(
        `issue_tracker.labels.${key} is not a label role (${LABEL_ROLES.join(", ")}) or ${EPIC_TYPES}`,
      );

  // The legacy fields are read under reviewConfig()'s own shape rules, so
  // that the two readers never disagree about whether an overlay is valid:
  // a present `review`, `review.taxonomy` or legacy label that reviewConfig()
  // refuses — null included — is refused here too.
  const review = overlay.review === undefined ? {} : overlay.review;
  if (!isRecord(review)) throw new Error("review must be an object");
  const taxonomy = review.taxonomy === undefined ? {} : review.taxonomy;
  if (!isRecord(taxonomy)) throw new Error("review.taxonomy must be an object");
  const declared = new Set<LabelRole>();
  const single = (
    role: "epic" | "hitl" | "manual_ops" | "followup" | "pattern_prefix",
    legacyField?: "epic_label" | "provenance_label",
  ): string => {
    const own =
      raw[role] === undefined
        ? undefined
        : oneLabel(raw[role], `issue_tracker.labels.${role}`);
    const legacy =
      legacyField === undefined || taxonomy[legacyField] === undefined
        ? undefined
        : oneLabel(taxonomy[legacyField], `review.taxonomy.${legacyField}`);
    if (own !== undefined && legacy !== undefined && own !== legacy)
      throw new Error(
        `issue_tracker.labels.${role} (${own}) and review.taxonomy.${legacyField} (${legacy}) name different labels; keep one, or make them agree`,
      );
    const value = own ?? legacy;
    if (value !== undefined) declared.add(role);
    return value ?? DEFAULT_LABELS[role];
  };
  const list = (role: "bug" | "batch_sizes"): string[] => {
    if (raw[role] === undefined) return [...DEFAULT_LABELS[role]];
    declared.add(role);
    return labelList(raw[role], `issue_tracker.labels.${role}`);
  };

  const epic = single("epic", "epic_label");
  const epicTypes = epicTypesOf(raw);
  const hitl = single("hitl");
  const manualOps = single("manual_ops");
  const followup = single("followup", "provenance_label");
  const patternPrefix = single("pattern_prefix");
  const bug = list("bug");
  const batchSizes = list("batch_sizes");
  let extractableTails: string[];
  if (raw.extractable_tails === undefined) {
    extractableTails = [
      ...EXTRACTABLE_HITL_FACETS.map((f) => `${hitl}:${f}`),
      manualOps,
      followup,
    ];
  } else {
    declared.add("extractable_tails");
    extractableTails = labelList(
      raw.extractable_tails,
      "issue_tracker.labels.extractable_tails",
    );
  }
  return {
    epic,
    epicTypes,
    hitl,
    manualOps,
    followup,
    bug,
    patternPrefix,
    batchSizes,
    extractableTails,
    declared,
  };
}

/** The labels with every role at its default. */
export const DEFAULT_TRACKER_LABELS: TrackerLabels = parseTrackerLabels({});

/**
 * The vocabulary as JSON-ready role → label, the shape `issue_tracker.labels`
 * takes, with `epic_types` when the epic is also read from issue types.
 */
export function labelsAsConfig(
  labels: TrackerLabels,
): Record<LabelRole, string | string[]> & { epic_types?: string[] } {
  return {
    epic: labels.epic,
    ...(labels.epicTypes.length === 0 ? {} : { epic_types: labels.epicTypes }),
    hitl: labels.hitl,
    manual_ops: labels.manualOps,
    followup: labels.followup,
    bug: labels.bug,
    pattern_prefix: labels.patternPrefix,
    batch_sizes: labels.batchSizes,
    extractable_tails: labels.extractableTails,
  };
}
