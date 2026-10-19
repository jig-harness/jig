/**
 * The batch policy: everything that decides whether an issue may join a
 * batch, what it costs and how it ranks, read from the consumer's
 * configuration and its change-area catalog.
 *
 * The skill's own section of `.config/jig.yaml`:
 *
 *   work_batch:
 *     point_budget: 16                         # the main limit
 *     size_points: { xs: 1, small: 2, medium: 6 }  # keys: exactly the batchable sizes
 *     max_items: 6                             # the item limit
 *     solo_flags: [privacy-review]             # added to the derived solo-only flags
 *     sizes: [xs, small, medium, large, xl]    # every size label, batchable or not
 *     ranking:
 *       sizes: { xs: 2, small: 1, medium: 0 }  # score of each batchable size
 *       provenance: 3                          # score of the follow-up label
 *       shared_area_label: 1                   # score of each shared area label
 *
 * The rest comes from fields other skills read too: the batchable sizes and
 * the label roles (`issue_tracker.labels`), the repository, type and context
 * labels (`review`), the labels that name an area
 * (`do_item.agents.codearea_areas`) and the catalog
 * (`drive.change_areas_catalog`).
 *
 * The solo-only flags are derived, and configuration can only add to them:
 * the human-in-the-loop label and its facets, the manual-operations label,
 * every flag any catalog area carries, then `work_batch.solo_flags`. No
 * setting removes a derived one: a safety rule a setting can switch off is a
 * suggestion.
 */

import { isAbsolute, join } from "node:path";
import { WorkBatchConfigError } from "./errors.ts";
import {
  consumerRoot,
  parseReviewConfig,
  withSource,
} from "../../../../shared/consumer.ts";
import { formatField } from "../../../../shared/config-layers.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { parseTrackerLabels } from "../../../../shared/tracker-labels.ts";
import {
  catalogPathFromOverlay,
  parseAgentRouting,
} from "../../../do-item/scripts/determine_agent.ts";
import { doItemSection } from "../../../do-item/scripts/lib/overlay.ts";
import { parseTrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import type { CanonicalState } from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  type ChangeAreaCatalog,
  loadCatalogFile,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";

export const DEFAULT_POINT_BUDGET = 16;
export const DEFAULT_MAX_ITEMS = 6;
export const DEFAULT_SIZE_POINTS: Readonly<Record<string, number>> = {
  xs: 1,
  small: 2,
  medium: 6,
};
export const DEFAULT_RANKING: Readonly<Ranking> = {
  sizes: { xs: 2, small: 1, medium: 0 },
  provenance: 3,
  sharedAreaLabel: 1,
};

/** The fields of `work_batch`, and of `work_batch.ranking`. */
export const WORK_BATCH_FIELDS = [
  "point_budget",
  "size_points",
  "max_items",
  "solo_flags",
  "sizes",
  "ranking",
] as const;
export const RANKING_FIELDS = [
  "sizes",
  "provenance",
  "shared_area_label",
] as const;

export interface Ranking {
  /** Score of each batchable size; a size not listed scores 0. */
  sizes: Record<string, number>;
  /** Score of the follow-up label (`issue_tracker.labels.followup`). */
  provenance: number;
  /** Score of each shared area label the issue carries. */
  sharedAreaLabel: number;
}

/** The `work_batch` section, validated, defaults filled in. */
export interface WorkBatchSettings {
  pointBudget: number;
  sizePoints: Record<string, number>;
  maxItems: number;
  soloFlags: string[];
  /** Every size label; `null` when the repository lists none. */
  sizes: string[] | null;
  ranking: Ranking;
}

export interface BatchPolicy extends WorkBatchSettings {
  /** Sizes an issue may carry and join a batch (`issue_tracker.labels.batch_sizes`). */
  batchSizes: string[];
  /**
   * Every size label the repository names: `work_batch.sizes`, else the
   * batchable sizes and `review.taxonomy.sizes`. Without `work_batch.sizes`
   * a size label named nowhere (a `large` the repository never lists) cannot
   * be recognised as a size.
   */
  knownSizes: string[];
  /** The solo-only flags: derived, then `work_batch.solo_flags`; sorted. */
  soloFlags: string[];
  /** A label starting with one of these is solo-only too (the `<hitl>:` facets). */
  soloFlagPrefixes: string[];
  epicLabel: string;
  followupLabel: string;
  /** The repository label a batch item must carry; `null` = not checked. */
  repoLabel: string | null;
  /** Every repository label; an issue may carry only one. */
  repoLabels: string[];
  /** The type labels, one of which an issue must carry; `null` = not checked. */
  typeLabels: string[] | null;
  /** The prefixes of context labels, one of which an issue must carry; `null` = not checked. */
  contextPrefixes: string[] | null;
  /** Area-naming label (lower case) → the area it names (`do_item.agents.codearea_areas`). */
  areaNaming: Record<string, string>;
  /**
   * Area-naming label (lower case) → the label as the configuration spells
   * it. The tracker matches label names exactly, so a label the proposal
   * queries by goes out in this spelling, never the lower-case key.
   */
  areaNamingSpelling: Record<string, string>;
  /**
   * Catalog area → the flags every change there carries (`tracker.flags`),
   * sorted; only areas that carry one. An issue labelled for such an area is
   * solo-only even when the flag itself is missing from its labels.
   */
  areaFlags: Record<string, string[]>;
  /**
   * The tracker's state name (lower case, trimmed) → its canonical state
   * (`issue_tracker.states`), for a state the tracker reports with no
   * category it is known by.
   */
  stateNames: Record<string, CanonicalState>;
  /** Every label known to name or belong to an area, lower case. */
  knownAreaLabels: string[];
  /**
   * Every label the configuration already names, lower case: the
   * area-naming labels, the labels `do_item.agents.labels` routes, and every
   * catalog area's `labels` and `tracker.labels`. A context label outside it
   * names nothing the repository knows.
   */
  knownContextLabels: string[];
  /** The `<prefix>:` of the area-naming labels, lower case: what an area label looks like. */
  areaLabelPrefixes: string[];
}

function wholeNumber(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
    throw new WorkBatchConfigError(`${field} must be a whole number ≥ ${min}`);
  return value;
}

function labelList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((l) => typeof l !== "string" || l.trim() === "") ||
    new Set(value).size !== value.length
  )
    throw new WorkBatchConfigError(
      `${field} must be a list of distinct nonempty label names`,
    );
  return value as string[];
}

/** A map from batchable size to a whole number, keys checked against `batchSizes`. */
function sizeMap(
  value: unknown,
  field: string,
  min: number,
): Record<string, number> {
  if (!isRecord(value))
    throw new WorkBatchConfigError(`${field} must be a mapping`);
  const out: Record<string, number> = Object.create(null);
  for (const [size, n] of Object.entries(value))
    out[size] = wholeNumber(n, `${field}.${formatField([size])}`, min);
  return out;
}

function refuseUnknownKeys(
  section: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(section))
    if (!known.includes(key))
      throw new WorkBatchConfigError(
        `${where}.${formatField([key])} is not a field of ${where} (${known.join(", ")})`,
      );
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

function parseRanking(raw: unknown, batchSizes: string[]): Ranking {
  // Size names are the repository's own, so a default weight is looked up
  // as an own property only: `constructor` is a size like any other.
  const defaultSizes: Record<string, number> = Object.create(null);
  for (const s of batchSizes)
    defaultSizes[s] = Object.hasOwn(DEFAULT_RANKING.sizes, s)
      ? (DEFAULT_RANKING.sizes[s] ?? 0)
      : 0;
  if (raw === undefined || raw === null)
    return { ...DEFAULT_RANKING, sizes: defaultSizes };
  if (!isRecord(raw))
    throw new WorkBatchConfigError("work_batch.ranking must be a mapping");
  refuseUnknownKeys(raw, RANKING_FIELDS, "work_batch.ranking");
  let sizes = defaultSizes;
  if (raw.sizes !== undefined) {
    sizes = sizeMap(raw.sizes, "work_batch.ranking.sizes", 0);
    for (const size of Object.keys(sizes))
      if (!batchSizes.includes(size))
        throw new WorkBatchConfigError(
          `work_batch.ranking.sizes.${formatField([size])} is not a batchable size (issue_tracker.labels.batch_sizes: ${batchSizes.join(", ")})`,
        );
  }
  return {
    sizes,
    provenance:
      raw.provenance === undefined
        ? DEFAULT_RANKING.provenance
        : wholeNumber(raw.provenance, "work_batch.ranking.provenance", 0),
    sharedAreaLabel:
      raw.shared_area_label === undefined
        ? DEFAULT_RANKING.sharedAreaLabel
        : wholeNumber(
            raw.shared_area_label,
            "work_batch.ranking.shared_area_label",
            0,
          ),
  };
}

/**
 * Why the size points do not price exactly the batchable sizes, or `null`
 * when they do. `keys` are the keys of `work_batch.size_points`, `null` when
 * it is not set (the defaults then price `xs`, `small`, `medium`). The audit's
 * configuration check asks the same question.
 */
export function sizePointsMismatch(
  keys: readonly string[] | null,
  batchSizes: readonly string[],
): string | null {
  if (keys === null)
    return sameKeys(Object.keys(DEFAULT_SIZE_POINTS), batchSizes)
      ? null
      : `work_batch.size_points must be set: issue_tracker.labels.batch_sizes is ${batchSizes.join(", ")}, and the default points price ${Object.keys(DEFAULT_SIZE_POINTS).join(", ")}`;
  return sameKeys(keys, batchSizes)
    ? null
    : `work_batch.size_points must price exactly issue_tracker.labels.batch_sizes (${batchSizes.join(", ")}), not ${keys.join(", ")}`;
}

/**
 * Validate the `work_batch` section of a parsed overlay against the
 * repository's batchable sizes. Throws, naming the field, on a wrong type, an
 * unknown field, or size points whose keys are not exactly the batchable
 * sizes: a size without points could not be priced, and points for a size
 * that may not be batched price nothing.
 */
export function parseWorkBatchSection(
  overlay: Record<string, unknown>,
  batchSizes: string[],
): WorkBatchSettings {
  const raw = overlay.work_batch;
  if (raw !== undefined && raw !== null && !isRecord(raw))
    throw new WorkBatchConfigError("work_batch must be a mapping");
  const section = (raw ?? {}) as Record<string, unknown>;
  refuseUnknownKeys(section, WORK_BATCH_FIELDS, "work_batch");

  const sizePoints =
    section.size_points === undefined
      ? { ...DEFAULT_SIZE_POINTS }
      : sizeMap(section.size_points, "work_batch.size_points", 1);
  const mismatch = sizePointsMismatch(
    section.size_points === undefined ? null : Object.keys(sizePoints),
    batchSizes,
  );
  if (mismatch !== null) throw new WorkBatchConfigError(mismatch);

  let sizes: string[] | null = null;
  if (section.sizes !== undefined && section.sizes !== null) {
    sizes = labelList(section.sizes, "work_batch.sizes");
    const missing = batchSizes.filter((s) => !sizes?.includes(s));
    if (missing.length > 0)
      throw new WorkBatchConfigError(
        `work_batch.sizes must list every batchable size too; it lacks ${missing.join(", ")}`,
      );
  }

  return {
    pointBudget:
      section.point_budget === undefined
        ? DEFAULT_POINT_BUDGET
        : wholeNumber(section.point_budget, "work_batch.point_budget", 1),
    sizePoints,
    maxItems:
      section.max_items === undefined
        ? DEFAULT_MAX_ITEMS
        : wholeNumber(section.max_items, "work_batch.max_items", 1),
    soloFlags:
      section.solo_flags === undefined || section.solo_flags === null
        ? []
        : labelList(section.solo_flags, "work_batch.solo_flags"),
    sizes,
    ranking: parseRanking(section.ranking, batchSizes),
  };
}

/** The `<prefix>:` a label starts with, lower case; `null` when it has none. */
export function labelPrefix(label: string): string | null {
  const colon = label.indexOf(":");
  return colon <= 0 ? null : label.slice(0, colon + 1).toLowerCase();
}

// The repository label a pool must carry, checked against the taxonomy it
// must belong to; `null` when the repository declares none.
function repoLabelOf(
  review: ReturnType<typeof parseReviewConfig>,
): string | null {
  const repoLabel = review.repo_label?.trim() ? review.repo_label : null;
  const repos = review.taxonomy?.repos ?? [];
  if (repoLabel !== null && repos.length > 0 && !repos.includes(repoLabel))
    throw new WorkBatchConfigError(
      `review.repo_label ${repoLabel} is not one of review.taxonomy.repos`,
    );
  return repoLabel;
}

// The labels that name an area (the routing's area-naming labels and every
// catalog area's tracker labels) and, wider, every label the configuration
// knows as context: those, the routing's other labels and each area's own.
function knownLabels(
  routing: ReturnType<typeof parseAgentRouting>,
  catalog: ChangeAreaCatalog | null,
): { area: string[]; context: string[] } {
  const areas = [...(catalog?.values() ?? [])];
  const area = new Set([
    ...Object.keys(routing.codeareaAreas),
    ...areas.flatMap((a) => a.trackerLabels.map((l) => l.toLowerCase())),
  ]);
  const context = new Set([
    ...area,
    ...Object.keys(routing.labels),
    ...areas.flatMap((a) => a.labels.map((l) => l.toLowerCase())),
  ]);
  return { area: [...area].sort(), context: [...context].sort() };
}

/**
 * The keys of `do_item.agents.codearea_areas` as written. The routing reader
 * lower-cases them for matching; it has already validated their shape.
 */
function configuredLabelKeys(overlay: Record<string, unknown>): string[] {
  const section = doItemSection(overlay);
  const agents = isRecord(section) ? section.agents : undefined;
  const areas = isRecord(agents) ? agents.codearea_areas : undefined;
  return isRecord(areas) ? Object.keys(areas) : [];
}

/**
 * The policy from a parsed overlay and the catalog (`null` when the
 * repository declares none). Throws, naming the field, when the overlay is
 * not valid for any skill that reads it.
 */
export function batchPolicy(
  overlay: Record<string, unknown>,
  catalog: ChangeAreaCatalog | null,
): BatchPolicy {
  const labels = parseTrackerLabels(overlay);
  const review = parseReviewConfig(overlay.review);
  const routing = parseAgentRouting(overlay);
  const settings = parseWorkBatchSection(overlay, labels.batchSizes);

  const catalogFlags = [...(catalog?.values() ?? [])].flatMap((a) => a.flags);
  // The lookups below are keyed by names a repository chooses (labels, area
  // keys, state names), so none inherits `Object.prototype`: `constructor`
  // and `__proto__` are names like any other.
  const areaNaming: Record<string, string> = Object.assign(
    Object.create(null),
    routing.codeareaAreas,
  );
  const areaNamingSpelling: Record<string, string> = Object.create(null);
  // The last spelling wins, as it does for the area the label routes to.
  for (const label of configuredLabelKeys(overlay))
    areaNamingSpelling[label.toLowerCase()] = label;
  const areaFlags: Record<string, string[]> = Object.create(null);
  for (const [key, area] of catalog ?? [])
    if (area.flags.length > 0) areaFlags[key] = [...new Set(area.flags)].sort();
  const stateNames: Record<string, CanonicalState> = Object.create(null);
  for (const [state, name] of Object.entries(
    parseTrackerConfig(overlay).states,
  ))
    stateNames[name.trim().toLowerCase()] ??= state as CanonicalState;
  const soloFlags = [
    ...new Set([
      labels.hitl,
      labels.manualOps,
      ...catalogFlags,
      ...settings.soloFlags,
    ]),
  ].sort();

  const repoLabel = repoLabelOf(review);
  const repos = review.taxonomy?.repos ?? [];
  const known = knownLabels(routing, catalog);
  const prefixes = Object.keys(routing.codeareaAreas)
    .map(labelPrefix)
    .filter((p): p is string => p !== null);

  return {
    ...settings,
    batchSizes: labels.batchSizes,
    knownSizes: [
      ...new Set([
        ...(settings.sizes ?? labels.batchSizes),
        ...(review.taxonomy?.sizes ?? []),
      ]),
    ],
    soloFlags,
    soloFlagPrefixes: [`${labels.hitl}:`],
    epicLabel: labels.epic,
    followupLabel: labels.followup,
    repoLabel,
    repoLabels: [...new Set([...repos, ...(repoLabel ? [repoLabel] : [])])],
    typeLabels: review.taxonomy?.types ?? null,
    contextPrefixes: review.taxonomy?.context_prefixes ?? null,
    areaNaming,
    areaNamingSpelling,
    areaFlags,
    stateNames,
    knownAreaLabels: known.area,
    knownContextLabels: known.context,
    areaLabelPrefixes: [...new Set(prefixes)].sort(),
  };
}

/** The catalog path the overlay declares, or `override`; `null` when neither. */
export function catalogPath(
  overlay: Record<string, unknown>,
  override?: string,
): string | null {
  if (override !== undefined)
    return isAbsolute(override) ? override : join(consumerRoot(), override);
  return catalogPathFromOverlay(overlay);
}

/**
 * The catalog, read in full. A declared catalog that cannot be read is an
 * error, not an empty catalog: its areas' flags are solo-only flags, and
 * reading none would admit what they hold back.
 */
export function readCatalog(path: string | null): ChangeAreaCatalog | null {
  return path === null ? null : loadCatalogFile(path);
}

/** `batchPolicy` with its errors naming the file or variable at fault. */
export function policyFrom(
  overlay: Record<string, unknown>,
  catalog: ChangeAreaCatalog | null,
): BatchPolicy {
  try {
    return batchPolicy(overlay, catalog);
  } catch (err) {
    throw withSource(
      overlay,
      ["work_batch", "issue_tracker", "review", "do_item", "drive"],
      err,
    );
  }
}
