/**
 * The issue-tracker labels the skills act on, by role: the consumer's
 * `issue_tracker.labels` in `.config/groundwork-overlay.yaml`, with a default
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
 * Lives beside the review skill's configuration reader because every skill
 * that reads labels already depends on this directory, and it on none of
 * them.
 */

export const LABEL_ROLES = [
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

export interface TrackerLabels {
  /** Marks an issue as an epic whose sub-issues are worked one at a time. */
  epic: string;
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

export const DEFAULT_LABELS = {
  epic: "epic",
  hitl: "hitl",
  manual_ops: "manual-ops",
  followup: "pr-followup",
  bug: ["bug", "type:bug"],
  pattern_prefix: "pattern:",
  batch_sizes: ["xs", "small", "medium"],
} as const;

/** The facets of the human-in-the-loop flag that an epic may hand off. */
export const EXTRACTABLE_HITL_FACETS = ["legal", "tactical"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneLabel(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a nonempty label name`);
  return value;
}

function labelList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((l) => typeof l !== "string" || l.trim() === "") ||
    new Set(value).size !== value.length
  )
    throw new Error(`${field} must be a list of distinct nonempty label names`);
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
    if (!(LABEL_ROLES as readonly string[]).includes(key))
      throw new Error(
        `issue_tracker.labels.${key} is not a label role (${LABEL_ROLES.join(", ")})`,
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

/** The vocabulary as JSON-ready role → label, the shape `issue_tracker.labels` takes. */
export function labelsAsConfig(
  labels: TrackerLabels,
): Record<LabelRole, string | string[]> {
  return {
    epic: labels.epic,
    hitl: labels.hitl,
    manual_ops: labels.manualOps,
    followup: labels.followup,
    bug: labels.bug,
    pattern_prefix: labels.patternPrefix,
    batch_sizes: labels.batchSizes,
    extractable_tails: labels.extractableTails,
  };
}
