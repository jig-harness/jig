/**
 * The pool a proposal reads, and its labelling gaps: the issues matching the
 * anchor that lack a priority or a size, so no batch takes them until a
 * person sets what they lack.
 *
 * Where the policy reads facets (`policy.facets`), the pool is read by the
 * size facet's batchable values and the gaps by the facets an issue lacks,
 * wherever the tracker keeps them. Otherwise the pool is read by the
 * batchable size labels, and the gaps by the absence of every size label,
 * which only `work_batch.sizes` can tell from a size too large to batch.
 * Either way, an issue in the pool with no priority is unranked: it is left
 * out (the `no-priority` reason) and listed here, never batched as the
 * least urgent.
 */

import type {
  PoolIssue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  areaShapedLabels,
  batchableSizeOf,
  type Excluded,
  isKnownAreaLabel,
  sanitizeForDisplay,
  soloFlagOf,
} from "./eligibility.ts";
import type { BatchPolicy } from "./policy.ts";

/** A facet a labelling gap lacks. */
export type GapFacet = "priority" | "size";

/**
 * An issue matching the anchor that lacks a priority or a size. Kept apart
 * from `excluded`: an issue with no size was never in the pool to be held
 * back out of, and one with no priority is held back only until it gets one,
 * so an identifier that moved between the two lists would read as a change
 * in the batch.
 */
export interface LabellingGap {
  identifier: string;
  title: string;
  url: string | null;
  labels: string[];
  /** What it lacks. */
  missing: GapFacet[];
  /** It is an epic (`PoolIssue.isEpic`), which a batch never takes. */
  isEpic: boolean;
}

/** Whether an issue carries no size; an epic needs none. */
function lacksSize(issue: PoolIssue, policy: BatchPolicy): boolean {
  if (issue.isEpic) return false;
  return policy.facets
    ? issue.size === null
    : !issue.labels.some((l) => policy.knownSizes.includes(l));
}

/** The facets an issue lacks, and only when setting them could batch it. */
function missingOf(issue: PoolIssue, policy: BatchPolicy): GapFacet[] {
  const missing: GapFacet[] = [];
  if (issue.priority === 0) missing.push("priority");
  if (lacksSize(issue, policy)) missing.push("size");
  // A priority alone cannot bring an issue too large to batch into the pool.
  if (!missing.includes("size") && batchableSizeOf(issue, policy) === null)
    return [];
  return missing;
}

/** Whether an issue labelled for another repository is that repository's gap. */
function otherRepository(issue: PoolIssue, policy: BatchPolicy): boolean {
  if (policy.repoLabel === null) return false;
  const repos = issue.labels.filter((l) => policy.repoLabels.includes(l));
  return !(
    repos.length === 0 ||
    (repos.length === 1 && repos[0] === policy.repoLabel)
  );
}

/**
 * Turn the gap read, and the pool's issues held back for no priority, into
 * reportable rows. What each lacks is re-checked here rather than trusted to
 * the tracker's filter, and an issue whose labels came back truncated cannot
 * be said to lack anything: it is counted, for a warning, since no other list
 * can report it. An issue labelled for another repository is that
 * repository's gap, not this one's.
 */
export function toLabellingGaps(
  read: readonly PoolIssue[],
  unranked: readonly PoolIssue[],
  policy: BatchPolicy,
): { gaps: LabellingGap[]; unreadable: number } {
  const readable = read.filter((i) => i.truncated.length === 0);
  const seen = new Set<string>();
  const gaps: LabellingGap[] = [];
  for (const i of [...readable, ...unranked]) {
    if (seen.has(i.identifier) || otherRepository(i, policy)) continue;
    const missing = missingOf(i, policy);
    if (missing.length === 0) continue;
    seen.add(i.identifier);
    gaps.push({
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      labels: [...i.labels],
      missing,
      isEpic: i.isEpic,
    });
  }
  gaps.sort((a, b) =>
    a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
  );
  return { gaps, unreadable: read.length - readable.length };
}

/** The pool's issues held back only for having no priority. */
export function unrankedOf(
  pool: readonly PoolIssue[],
  excluded: readonly Excluded[],
): PoolIssue[] {
  const keys = new Set(
    excluded
      .filter((e) => e.reason.kind === "no-priority")
      .map((e) => e.identifier),
  );
  return pool.filter((i) => keys.has(i.identifier));
}

/**
 * Read the pool and the issues it cannot hold. The gap read is diagnostic:
 * its failure degrades the run with a warning, never discards a pool that
 * was already read.
 */
export async function readPool(
  tracker: Tracker,
  poolLabels: string[],
  policy: BatchPolicy,
  warnings: string[],
): Promise<{ issues: PoolIssue[]; sizeGaps: PoolIssue[] }> {
  const issues = await tracker.openIssues(
    policy.facets
      ? {
          withSomeOf: [poolLabels],
          facets: { oneOf: { size: policy.batchSizes } },
        }
      : { withSomeOf: [poolLabels, policy.batchSizes] },
  );
  if (!policy.facets && policy.sizes === null) {
    warnings.push(
      "labelling gaps with no size are not reported: without work_batch.sizes an issue with no size label cannot be told from one too large to batch",
    );
    return { issues, sizeGaps: [] };
  }
  try {
    const sizeGaps = await tracker.openIssues(
      policy.facets
        ? {
            withSomeOf: [poolLabels],
            facets: { missing: ["priority", "size"] },
          }
        : { withSomeOf: [poolLabels], withNoneOf: policy.sizes ?? [] },
    );
    return { issues, sizeGaps };
  } catch (err) {
    warnings.push(
      `the labelling-gap read failed (${err instanceof Error ? err.message : String(err)}); gaps are not reported, so an area that looks drained may still hold issues with no ${policy.facets ? "priority or no " : ""}size`,
    );
    return { issues, sizeGaps: [] };
  }
}

const show = (labels: readonly string[]) =>
  labels.map(sanitizeForDisplay).join(", ");

/**
 * What a gap's labels already say will hold it back once it has what it
 * lacks. Only label-visible blockers: an unlabelled epic shows as a bare
 * row, so a bare row means "no known blocker", not "batchable".
 */
function gapBlockers(gap: LabellingGap, policy: BatchPolicy): string[] {
  const { labels } = gap;
  return [
    ...new Set([
      ...labels.filter((l) => soloFlagOf([l], policy) !== null),
      ...(gap.isEpic &&
      !labels.some(
        (l) => l.trim().toLowerCase() === policy.epicLabel.trim().toLowerCase(),
      )
        ? ["an epic by issue type"]
        : []),
      ...areaShapedLabels(labels, policy).filter(
        (l) => !isKnownAreaLabel(l, policy),
      ),
    ]),
  ];
}

/** The table's labelling-gap lines. */
export function gapLines(
  gaps: readonly LabellingGap[],
  policy: BatchPolicy,
): string[] {
  if (gaps.length === 0) return [];
  return [
    "",
    "Labelling gaps (no priority or no size, so never batched; set what each lacks and re-run, which decides whether it is batchable):",
    ...gaps.map((g) => {
      const blockers = gapBlockers(g, policy);
      const suffix = blockers.length > 0 ? `  [also: ${show(blockers)}]` : "";
      return `  ${sanitizeForDisplay(g.identifier)}  ${sanitizeForDisplay(g.title)}  (no ${g.missing.join(", no ")})${suffix}`;
    }),
  ];
}
