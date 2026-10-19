#!/usr/bin/env bun
/**
 * Propose a batch: turn an anchor (a change-area name, a repository path, an
 * epic or one issue) into a ranked batch of open small issues that one pull
 * request can close together, and into the list of issues held back and why.
 *
 * What the script mechanizes, because neither survives being left to an
 * agent's memory across a large pool:
 *
 *  1. **The solo-only exclusion.** An issue carrying a solo-only flag starts
 *     a review gate or a human step that applies to the whole pull request;
 *     batching one drags every other item through that gate, or parks all of
 *     them behind the one human. The check runs on the labels the tracker
 *     returned, fail-closed (`lib/eligibility.ts`).
 *  2. **Ownership.** An issue already assigned to someone else is spoken for,
 *     whether or not it has left the backlog.
 *  3. **The budget.** Points per size against a point budget, and an item
 *     limit, filled in rank order in one pass.
 *
 * Whether the proposed issues really are one coherent change, whether the
 * implemented diff stayed in budget and how to write the pull request is
 * judgment, and stays in SKILL.md.
 *
 * Usage:
 *     bun candidates.ts <anchor> [--limit N] [--budget N] [--claimed K1,K2]
 *                       [--catalog <path>] [--format table|json]
 *     bun candidates.ts --eligibility [--claimed K1,K2] [--catalog <path>] < issues.json
 *
 * The eligibility mode reads issues on stdin, reads no tracker, and prints
 * one versioned JSON document: the effective policy and a verdict for each
 * issue, decided by the same `excludeReason` the proposal uses (SKILL.md §
 * The eligibility mode documents the format).
 *
 * Exit codes: 0 proposal or verdicts printed (a proposal may be empty);
 * 2 usage, an unusable anchor, or unreadable eligibility input;
 * 1 configuration, catalog or tracker error.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { runMain } from "../../../shared/cli.ts";
import { Defect } from "../../../shared/errors.ts";
import { consumerRoot, readOverlay } from "../../../shared/consumer.ts";
import { isRecord } from "../../../shared/guards.ts";
import { parseArgs } from "../../do-item/scripts/lib/cli.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import type {
  PoolIssue,
  Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import {
  areasOf,
  type ChangeAreaCatalog,
  matchesGlob,
} from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  areaShapedLabels,
  batchableSizeOf,
  describeReason,
  type Excluded,
  type ExclusionReason,
  excludeReason,
  isKnownAreaLabel,
  partition,
  sanitizeForDisplay,
  soloFlagOf,
  stateStanding,
} from "./lib/eligibility.ts";
import { Refusal } from "./lib/errors.ts";
import {
  type BatchPolicy,
  catalogPath,
  policyFrom,
  readCatalog,
} from "./lib/policy.ts";

/**
 * The version of both JSON documents (the proposal and the eligibility
 * report). It changes when a field is removed or changes meaning; adding a
 * field keeps it. A reader refuses a version it does not know.
 */
export const OUTPUT_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Candidate {
  identifier: string;
  title: string;
  url: string | null;
  size: string;
  /** What this issue costs against the point budget. */
  points: number;
  /** 0 = none, then 1 (urgent) to 4 (low). */
  priority: number;
  createdAt: string;
  /** At proposal time, the baseline the claim re-check compares ids against. */
  assignee: { id: string; name: string } | null;
  state: { id: string; name: string; type: string };
  labels: string[];
  score: number;
  /** The score's parts, in the order they were added. */
  reasons: string[];
}

export type AnchorKind = "area" | "path" | "epic" | "issue";

export interface Anchor {
  kind: AnchorKind;
  /** The anchor as given (a path normalized to the repository root). */
  input: string;
  /** Catalog areas the anchor resolved to; empty for an epic or an issue. */
  areas: string[];
  /** Area-naming labels: an issue must carry one to be in the pool. Empty for an epic. */
  poolLabels: string[];
  /** Shared area labels: each one an issue carries adds to its rank. */
  sharedLabels: string[];
}

/**
 * An issue matching the anchor that carries no size label at all, so the
 * pool read (which requires a batchable size) never returned it. Kept apart
 * from `excluded`: it was never in the pool to be held back out of, and an
 * identifier that moved between the two lists as its size label is added
 * would read as a change in the batch.
 */
export interface LabellingGap {
  identifier: string;
  title: string;
  url: string | null;
  labels: string[];
}

export interface Proposal {
  version: number;
  anchor: Anchor;
  /** The item limit. */
  limit: number;
  /** The point budget. */
  budget: number;
  /** The proposed issues' points; above `budget` only for a seed that alone costs more. */
  points: number;
  candidates: Candidate[];
  excluded: Excluded[];
  labellingGaps: LabellingGap[];
  /** Eligible issues left out by the item limit or the point budget. */
  overflow: number;
  warnings: string[];
}

export interface BuildOptions {
  limit: number;
  budget: number;
  claimed: ReadonlySet<string>;
}

function refuse(message: string): never {
  throw new Refusal(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking and the budget
// ─────────────────────────────────────────────────────────────────────────────

const lower = (labels: readonly string[]) => labels.map((l) => l.toLowerCase());

/**
 * An eligible issue's score; higher is batched sooner. The weights say what
 * makes an issue cheap to land beside the others: it is small, it is work
 * already owed from a review, and it shares the anchor's wider area, so one
 * review pass covers it.
 */
export function score(
  issue: PoolIssue,
  policy: BatchPolicy,
  sharedLabels: readonly string[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let total = 0;
  const size = batchableSizeOf(issue.labels, policy);
  if (size === null)
    throw new Defect(
      `${issue.identifier} has no batchable size; only issues excludeReason admitted may be ranked`,
    );
  const sizeScore = policy.ranking.sizes[size] ?? 0;
  total += sizeScore;
  reasons.push(`${size} (+${sizeScore})`);

  if (issue.labels.includes(policy.followupLabel)) {
    total += policy.ranking.provenance;
    reasons.push(`review follow-up (+${policy.ranking.provenance})`);
  }

  const own = lower(issue.labels);
  const shared = sharedLabels.filter((l) => own.includes(l.toLowerCase()));
  if (shared.length > 0) {
    const boost = shared.length * policy.ranking.sharedAreaLabel;
    total += boost;
    reasons.push(`shares ${shared.join(", ")} (+${boost})`);
  }
  return { score: total, reasons };
}

/** Urgent first, no priority last. */
const priorityOrder = (p: number) => (p === 0 ? 5 : p);

/**
 * Higher score first; ties to the tracker's priority, then the older issue,
 * then the key in text order, so the input order never decides which issue
 * fits the budget.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.score - a.score ||
    priorityOrder(a.priority) - priorityOrder(b.priority) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)
  );
}

export function rank(
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
  sharedLabels: readonly string[],
): Candidate[] {
  return issues
    .map((issue) => {
      const { score: s, reasons } = score(issue, policy, sharedLabels);
      const size = batchableSizeOf(issue.labels, policy) as string;
      return {
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        size,
        points: policy.sizePoints[size] ?? 0,
        priority: issue.priority,
        createdAt: issue.createdAt,
        assignee: issue.assignee,
        state: issue.state,
        labels: [...issue.labels].sort(),
        score: s,
        reasons,
      };
    })
    .sort(compareCandidates);
}

/**
 * Fill a ranked list up to both limits in one pass: take each item that
 * still fits the point budget and the item limit, and skip (not stop at) one
 * that does not, so an expensive issue that no longer fits leaves room for
 * cheaper ones below it. `pinned` items are taken first and unconditionally,
 * charged against both limits. The result keeps the rank order.
 */
export function fillBudget<T>(
  ranked: readonly T[],
  pointsOf: (item: T) => number,
  opts: { limit: number; budget: number; pinned?: (item: T) => boolean },
): T[] {
  const pinned = opts.pinned ?? (() => false);
  // By position, not by value: two equal items are two slots.
  const chosen = new Set<number>();
  let used = 0;
  ranked.forEach((item, i) => {
    if (!pinned(item)) return;
    chosen.add(i);
    used += pointsOf(item);
  });
  ranked.forEach((item, i) => {
    if (chosen.size >= opts.limit || chosen.has(i)) return;
    const cost = pointsOf(item);
    if (used + cost > opts.budget) return;
    chosen.add(i);
    used += cost;
  });
  return ranked.filter((_, i) => chosen.has(i));
}

/**
 * Fill the budget, never letting an issue anchor's own seed fall out: the
 * seed is the issue the run was invoked to complete. It is pinned, charged
 * against both limits and listed first.
 */
export function capCandidates(
  ranked: Candidate[],
  opts: { limit: number; budget: number },
  seed: string | null,
): Candidate[] {
  const kept = fillBudget(ranked, (c) => c.points, {
    ...opts,
    pinned: (c) => c.identifier === seed,
  });
  return [
    ...kept.filter((c) => c.identifier === seed),
    ...kept.filter((c) => c.identifier !== seed),
  ];
}

/**
 * The sizes whose issues need an explicit verdict before they stay in a
 * batch: the most expensive batchable size (`medium` by default), the size
 * whose label is least reliable in both directions. None when every
 * batchable size costs the same.
 */
export function verdictSizes(policy: BatchPolicy): string[] {
  const points = policy.batchSizes.map((s) => policy.sizePoints[s] ?? 0);
  const max = Math.max(...points);
  if (points.every((p) => p === max)) return [];
  return policy.batchSizes.filter((s) => policy.sizePoints[s] === max);
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchors
// ─────────────────────────────────────────────────────────────────────────────

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Labels that name one of `areas` (`do_item.agents.codearea_areas`): as the
 * catalog spells them where an area lists the label under `tracker.labels`,
 * else as the configuration does.
 */
export function areaNamingLabels(
  areas: readonly string[],
  catalog: ChangeAreaCatalog,
  policy: BatchPolicy,
): string[] {
  const spelled = new Map<string, string>();
  for (const area of areas)
    for (const label of catalog.get(area)?.trackerLabels ?? [])
      spelled.set(label.toLowerCase(), label);
  const out = new Set<string>();
  for (const [label, named] of Object.entries(policy.areaNaming))
    if (areas.includes(named))
      out.add(spelled.get(label) ?? policy.areaNamingSpelling[label] ?? label);
  return [...out].sort();
}

/** The areas' other tracker labels: shared with other areas, they only add rank. */
export function sharedAreaLabels(
  areas: readonly string[],
  catalog: ChangeAreaCatalog,
  naming: readonly string[],
): string[] {
  const named = lower(naming);
  const out = new Set<string>();
  for (const area of areas)
    for (const label of catalog.get(area)?.trackerLabels ?? [])
      if (!named.includes(label.toLowerCase())) out.add(label);
  return [...out].sort();
}

/**
 * A path as the catalog's globs see it: relative to the repository root,
 * forward slashes, no leading `./`. An absolute path outside the repository
 * is left as given, so it matches nothing rather than another path.
 */
export function normalizeRepoPath(input: string, root: string): string {
  let path = input.replace(/\\/g, "/");
  if (isAbsolute(input)) {
    const rel = relative(root, input).replace(/\\/g, "/");
    path = rel.startsWith("..") || isAbsolute(rel) ? path : rel;
  }
  return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The areas a path anchor belongs to: those whose own globs match it,
 * directly. A directory matches no `dir/**` glob by itself, so a directory on
 * disk (or a path that matched nothing) is also tried as the parent of a
 * file, which also finds a narrower area that holds only its descendants.
 */
export function pathAreas(
  path: string,
  catalog: ChangeAreaCatalog,
  root: string,
): string[] {
  const areas = new Set(areasOf(path, catalog));
  let isDirectory = false;
  try {
    isDirectory = statSync(resolve(root, path)).isDirectory();
  } catch {
    // Not on disk: only the literal match and the probe below apply.
  }
  if (isDirectory || areas.size === 0)
    for (const [key, area] of catalog)
      if (area.globs.some((g) => globMayMatchUnder(path, g))) areas.add(key);
  return [...areas].sort();
}

/**
 * Whether `glob` could match a path strictly below the directory `dir`:
 * each of the directory's segments must match the glob's segment at that
 * depth, a `**` segment matches whatever follows, and the glob must reach
 * deeper than the directory. A glob whose braces span a `/` cannot be split
 * into segments, so it is taken to match: an area wrongly counted in only
 * widens the flag refusal, while one wrongly left out could admit a flagged
 * area's issues.
 */
export function globMayMatchUnder(dir: string, glob: string): boolean {
  if (/\{[^}]*\/[^}]*\}/.test(glob)) return true;
  const dirSegments = dir === "" ? [] : dir.split("/");
  const globSegments = glob.split("/");
  for (const [i, segment] of dirSegments.entries()) {
    const g = globSegments[i];
    if (g === undefined) return false;
    if (g === "**") return true;
    if (!matchesGlob(segment, g)) return false;
  }
  return globSegments.length > dirSegments.length;
}

/**
 * Resolve an area name or a repository path against the catalog. Refuses an
 * anchor whose areas carry a solo-only flag themselves (every change there
 * carries it, so no batch is possible) and one with no label naming the
 * area (its shared labels alone would select issues from unrelated areas).
 */
export function resolveStaticAnchor(
  input: string,
  catalog: ChangeAreaCatalog,
  policy: BatchPolicy,
  root: string,
): Anchor {
  const direct = catalog.has(input);
  const path = direct ? input : normalizeRepoPath(input, root);
  const areas = direct ? [input] : pathAreas(path, catalog, root);
  if (areas.length === 0)
    refuse(
      `anchor "${input}" is neither a catalog area, a path in any area, nor an issue key.\n  known areas: ${[...catalog.keys()].sort().join(", ")}`,
    );
  const flags = [
    ...new Set(
      areas.flatMap((a) =>
        (catalog.get(a)?.flags ?? []).filter(
          (f) => soloFlagOf([f], policy) !== null,
        ),
      ),
    ),
  ].sort();
  if (flags.length > 0)
    refuse(
      `anchor "${input}" resolves to ${areas.join(", ")}, which the catalog flags ${flags.join(", ")}: every change there carries the flag, so no batch is possible. Work these issues one at a time with /jig:do-item.`,
    );
  const poolLabels = areaNamingLabels(areas, catalog, policy);
  if (poolLabels.length === 0)
    refuse(
      `no label names ${areas.join(", ")}: their tracker labels (${areas.flatMap((a) => catalog.get(a)?.trackerLabels ?? []).join(", ") || "none"}) are shared with other areas, so a pool of them would hold unrelated issues. Map an area-naming label to the area in do_item.agents.codearea_areas, or anchor on an issue or an epic.`,
    );
  return {
    kind: direct ? "area" : "path",
    input: path,
    areas,
    poolLabels,
    sharedLabels: sharedAreaLabels(areas, catalog, poolLabels),
  };
}

/** The message for a seed issue that may not join a batch itself. */
function seedRefusal(
  key: string,
  reason: ExclusionReason,
  policy: BatchPolicy,
): string {
  const alone = `Work ${key} alone with /jig:do-item, or anchor on its area or path to see its siblings.`;
  switch (reason.kind) {
    case "already-assigned":
      return `${key} is ${describeReason(reason, policy)}. Pass --claimed ${key} if it is already yours, or anchor on its area or path to see its siblings.`;
    case "urgent":
      return `${key} is urgent: a batch shares its slowest issue's fate, so urgent work is not batched, as an item or as an anchor. Work it alone with /jig:do-item.`;
    case "already-started":
      return `${key} is ${describeReason(reason, policy)}. Pass --claimed ${key} if you are already working it, or anchor on its area or path to see its siblings.`;
    default:
      return `${key} cannot join a batch itself (${describeReason(reason, policy)}), so a batch built around it would drop it. ${alone}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool reads and assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn the gap read into reportable rows. "Carries no size label" is
 * re-checked here rather than trusted to the tracker's filter, and an issue
 * whose labels came back truncated cannot be said to carry none: it is
 * counted, for a warning, since no other list can report it. An issue
 * labelled for another repository is that repository's gap, not this one's.
 */
export function toLabellingGaps(
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
): { gaps: LabellingGap[]; unreadable: number } {
  const readable = issues.filter((i) => i.truncated.length === 0);
  const sizes = policy.knownSizes;
  const gaps = readable
    .filter((i) => !i.labels.some((l) => sizes.includes(l)))
    .filter((i) => {
      if (policy.repoLabel === null) return true;
      const repos = i.labels.filter((l) => policy.repoLabels.includes(l));
      return (
        repos.length === 0 ||
        (repos.length === 1 && repos[0] === policy.repoLabel)
      );
    })
    .map((i) => ({
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      labels: [...i.labels],
    }))
    .sort((a, b) =>
      a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
    );
  return { gaps, unreadable: issues.length - readable.length };
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
  const issues = await tracker.openIssues({
    withSomeOf: [poolLabels, policy.batchSizes],
  });
  if (policy.sizes === null) {
    warnings.push(
      "labelling gaps are not reported: without work_batch.sizes an issue with no size label cannot be told from one too large to batch",
    );
    return { issues, sizeGaps: [] };
  }
  try {
    const sizeGaps = await tracker.openIssues({
      withSomeOf: [poolLabels],
      withNoneOf: policy.sizes,
    });
    return { issues, sizeGaps };
  } catch (err) {
    warnings.push(
      `the labelling-gap read failed (${err instanceof Error ? err.message : String(err)}); gaps are not reported, so an area that looks drained may still hold issues with no size`,
    );
    return { issues, sizeGaps: [] };
  }
}

export function buildProposal(
  anchor: Anchor,
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
  opts: BuildOptions,
  warnings: string[],
  sizeGaps: readonly PoolIssue[],
): Proposal {
  const { eligible, excluded } = partition(issues, policy, opts);
  const ranked = rank(eligible, policy, anchor.sharedLabels);
  const { gaps, unreadable } = toLabellingGaps(sizeGaps, policy);
  if (unreadable > 0)
    warnings.push(
      `${unreadable} issue(s) matching the anchor came back with truncated labels: whether they carry a size label is unknown, and they appear in no list below`,
    );
  const seed = anchor.kind === "issue" ? anchor.input : null;
  const candidates = capCandidates(ranked, opts, seed);
  const points = candidates.reduce((sum, c) => sum + c.points, 0);
  if (points > opts.budget)
    warnings.push(
      `the anchor issue ${anchor.input} alone costs more than the ${opts.budget}-point budget; it is proposed anyway, since it is the issue this run was invoked for`,
    );
  return {
    version: OUTPUT_VERSION,
    anchor,
    limit: opts.limit,
    budget: opts.budget,
    points,
    candidates,
    excluded,
    labellingGaps: gaps,
    overflow: ranked.length - candidates.length,
    warnings,
  };
}

/** Keep the first of each identifier: a pool read twice can return an issue twice. */
function unique(issues: readonly PoolIssue[]): PoolIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.identifier)) return false;
    seen.add(i.identifier);
    return true;
  });
}

/**
 * Refuse a seed whose own labels, priority or state already rule out a
 * batch around it, whether it is an epic or a single issue.
 */
function refuseUnusableSeed(
  key: string,
  seed: PoolIssue,
  policy: BatchPolicy,
): void {
  if (seed.truncated.length > 0)
    refuse(
      `${key}'s labels did not come back in full, so its own flags and area cannot be trusted. Work it alone with /jig:do-item.`,
    );
  const flag = soloFlagOf(seed.labels, policy);
  if (flag !== null)
    refuse(
      `${key} carries the solo-only flag ${flag}: it never joins a batch, as an anchor or as an item. Work it alone with /jig:do-item.`,
    );
  if (seed.priority === 1) refuse(seedRefusal(key, { kind: "urgent" }, policy));
  if (stateStanding(seed.state, policy) === "closed")
    refuse(
      `${key} is already ${seed.state.name}: nothing to batch. Anchor on an open issue.`,
    );
}

/**
 * The area-naming labels a single-issue seed's pool is read by, after
 * refusing a seed that cannot join its own batch.
 */
function seedPoolLabels(
  key: string,
  seed: PoolIssue,
  policy: BatchPolicy,
  opts: BuildOptions,
): string[] {
  if (seed.hasOpenChildren)
    refuse(
      `${key} has open children but no ${policy.epicLabel} label: a batch would resolve only its children and leave ${key} itself open. Label it ${policy.epicLabel} if it is a container, or close its children first.`,
    );
  const poolLabels = seed.labels
    .filter((l) => policy.areaNaming[l.toLowerCase()] !== undefined)
    .sort();
  if (poolLabels.length === 0)
    refuse(
      `${key} carries no area-naming label (do_item.agents.codearea_areas), so there is no area to batch it in. Label it, or anchor on an area, a path or its epic.`,
    );
  // The seed must pass the check every pool member passes, with the same
  // claimed set: the pool partition must agree on it, or a seed that passed
  // here could still be held back there and silently vanish.
  const reason = excludeReason(seed, policy, opts);
  if (reason !== null) refuse(seedRefusal(key, reason, policy));
  return poolLabels;
}

async function runIssueAnchor(
  tracker: Tracker,
  catalog: ChangeAreaCatalog | null,
  policy: BatchPolicy,
  requested: string,
  opts: BuildOptions,
): Promise<Proposal> {
  const warnings: string[] = [];
  const seed = await tracker.poolIssue(requested);
  if (seed === null) refuse(`issue ${requested} not found`);
  // The tracker's own spelling of the key, so a key typed in lower case
  // still pins the seed and names it in the proposal.
  const key = seed.identifier;
  refuseUnusableSeed(key, seed, policy);

  if (seed.labels.includes(policy.epicLabel)) {
    const anchor: Anchor = {
      kind: "epic",
      input: key,
      areas: [],
      poolLabels: [],
      sharedLabels: seed.labels
        .filter((l) => isKnownAreaLabel(l, policy))
        .sort(),
    };
    // No gap read: the children are read whatever their size, so one with
    // no size label is held back in `excluded`, naming the label to add.
    const children = await tracker.openChildren(key);
    return buildProposal(anchor, children, policy, opts, warnings, []);
  }

  const poolLabels = seedPoolLabels(key, seed, policy, opts);
  const areas = [
    ...new Set(poolLabels.map((l) => policy.areaNaming[l.toLowerCase()])),
  ].filter((a): a is string => a !== undefined);
  const anchor: Anchor = {
    kind: "issue",
    input: key,
    areas: [],
    poolLabels,
    sharedLabels:
      catalog === null ? [] : sharedAreaLabels(areas, catalog, poolLabels),
  };
  const { issues, sizeGaps } = await readPool(
    tracker,
    poolLabels,
    policy,
    warnings,
  );
  // The seed is kept whether or not the pool read returned it.
  const pool = unique([seed, ...issues.filter((i) => i.identifier !== key)]);
  return buildProposal(anchor, pool, policy, opts, warnings, sizeGaps);
}

/** Resolve the anchor, read its pool through the tracker, and propose a batch. */
export async function run(
  tracker: Tracker,
  catalog: ChangeAreaCatalog | null,
  policy: BatchPolicy,
  anchorInput: string,
  opts: BuildOptions,
  root: string = consumerRoot(),
): Promise<Proposal> {
  if (ISSUE_KEY.test(anchorInput) && !catalog?.has(anchorInput))
    return runIssueAnchor(tracker, catalog, policy, anchorInput, opts);
  if (catalog === null)
    refuse(
      "drive.change_areas_catalog is not set: an area or path anchor needs the change-area catalog. Anchor on an issue or an epic, or declare the catalog.",
    );
  const anchor = resolveStaticAnchor(anchorInput, catalog, policy, root);
  const warnings: string[] = [];
  const { issues, sizeGaps } = await readPool(
    tracker,
    anchor.poolLabels,
    policy,
    warnings,
  );
  return buildProposal(
    anchor,
    unique(issues),
    policy,
    opts,
    warnings,
    sizeGaps,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The eligibility mode
// ─────────────────────────────────────────────────────────────────────────────

export interface Verdict {
  identifier: string;
  eligible: boolean;
  /** The batchable size and its points; `null` when the issue is not eligible. */
  size: string | null;
  points: number | null;
  /** Why the issue is held back; `null` when it is eligible. */
  reason: ExclusionReason | null;
  /** The reason as a person reads it; `null` when eligible. */
  message: string | null;
}

export interface EligibilityReport {
  version: number;
  policy: {
    batchSizes: string[];
    sizes: string[] | null;
    sizePoints: Record<string, number>;
    pointBudget: number;
    maxItems: number;
    soloFlags: string[];
    soloFlagPrefixes: string[];
    epicLabel: string;
    followupLabel: string;
    repoLabel: string | null;
    repoLabels: string[];
    typeLabels: string[] | null;
    contextPrefixes: string[] | null;
    areaLabelPrefixes: string[];
    areaFlags: Record<string, string[]>;
    stateNames: Record<string, string>;
    knownAreaLabels: string[];
    knownContextLabels: string[];
    knownSizes: string[];
    ranking: {
      sizes: Record<string, number>;
      provenance: number;
      sharedAreaLabel: number;
    };
  };
  verdicts: Verdict[];
}

/** The verdict for each issue, in input order, with the policy it was decided under. */
export function eligibilityReport(
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
  claimed: ReadonlySet<string>,
): EligibilityReport {
  return {
    version: OUTPUT_VERSION,
    policy: {
      batchSizes: policy.batchSizes,
      sizes: policy.sizes,
      sizePoints: { ...policy.sizePoints },
      pointBudget: policy.pointBudget,
      maxItems: policy.maxItems,
      soloFlags: policy.soloFlags,
      soloFlagPrefixes: policy.soloFlagPrefixes,
      epicLabel: policy.epicLabel,
      followupLabel: policy.followupLabel,
      repoLabel: policy.repoLabel,
      repoLabels: policy.repoLabels,
      typeLabels: policy.typeLabels,
      contextPrefixes: policy.contextPrefixes,
      areaLabelPrefixes: policy.areaLabelPrefixes,
      areaFlags: Object.fromEntries(
        Object.entries(policy.areaFlags).map(([a, f]) => [a, [...f]]),
      ),
      stateNames: { ...policy.stateNames },
      knownAreaLabels: policy.knownAreaLabels,
      knownContextLabels: policy.knownContextLabels,
      knownSizes: policy.knownSizes,
      ranking: { ...policy.ranking, sizes: { ...policy.ranking.sizes } },
    },
    verdicts: issues.map((issue) => {
      const reason = excludeReason(issue, policy, { claimed });
      const size =
        reason === null ? batchableSizeOf(issue.labels, policy) : null;
      return {
        identifier: issue.identifier,
        eligible: reason === null,
        size,
        points: size === null ? null : (policy.sizePoints[size] ?? 0),
        reason,
        message: reason === null ? null : describeReason(reason, policy),
      };
    }),
  };
}

const isText = (v: unknown): v is string => typeof v === "string";
const isTextList = (v: unknown) => Array.isArray(v) && v.every(isText);
const hasTexts = (v: unknown, keys: readonly string[]) =>
  isRecord(v) && keys.every((k) => isText(v[k]));

/** Each field of the pool form, with what it must be. Every one is required. */
const POOL_FIELDS: ReadonlyArray<
  readonly [field: string, ok: (v: unknown) => boolean, must: string]
> = [
  ["identifier", isText, "a string"],
  ["title", isText, "a string"],
  ["url", (v) => v === null || isText(v), "a string or null"],
  [
    "priority",
    (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4,
    "an integer from 0 to 4",
  ],
  [
    "createdAt",
    (v) => isText(v) && !Number.isNaN(Date.parse(v)),
    "a timestamp",
  ],
  ["state", (v) => hasTexts(v, ["id", "name", "type"]), "{ id, name, type }"],
  [
    "assignee",
    (v) => v === null || hasTexts(v, ["id", "name"]),
    "{ id, name } or null",
  ],
  ["labels", isTextList, "a list of strings"],
  ["hasOpenChildren", (v) => typeof v === "boolean", "true or false"],
  // An omitted list would read as a complete one.
  ["truncated", isTextList, "a list of strings"],
];

/** What the first malformed field of an issue must be, or `null`. */
function fieldProblem(issue: Record<string, unknown>): string | null {
  const bad = POOL_FIELDS.find(([field, ok]) => !ok(issue[field]));
  return bad === undefined ? null : `${bad[0]} must be ${bad[2]}`;
}

/**
 * Issues in the tracker interface's pool form (`PoolIssue`), as a JSON array.
 * Every field is required: a reader that omitted `truncated` or
 * `hasOpenChildren` must not have its issues read as complete and childless.
 */
export function parsePoolIssues(raw: unknown): PoolIssue[] {
  if (!Array.isArray(raw))
    throw new Refusal("input must be a JSON array of issues");
  return raw.map((issue, i) => {
    if (!isRecord(issue)) throw new Refusal(`issue ${i + 1} must be an object`);
    const problem = fieldProblem(issue);
    if (problem !== null)
      throw new Refusal(
        `issue ${i + 1}${typeof issue.identifier === "string" ? ` (${issue.identifier})` : ""}: ${problem}`,
      );
    return {
      identifier: issue.identifier as string,
      title: issue.title as string,
      url: issue.url as string | null,
      priority: issue.priority as number,
      createdAt: issue.createdAt as string,
      state: issue.state as PoolIssue["state"],
      assignee: issue.assignee as PoolIssue["assignee"],
      labels: issue.labels as string[],
      hasOpenChildren: issue.hasOpenChildren as boolean,
      truncated: issue.truncated as string[],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fields the claim re-check compares, in the order the line prints them.
 * Ids sit beside names: a state or a person can be renamed, and two can share
 * a name. Every field prints even when empty, so two runs never differ by
 * layout alone.
 */
const REVALIDATION_FIELDS: ReadonlyArray<{
  key: string;
  render: (c: Candidate, policy: BatchPolicy) => string;
}> = [
  {
    key: "state",
    render: (c) =>
      `state: ${sanitizeForDisplay(c.state.name)} <${sanitizeForDisplay(c.state.id)}>`,
  },
  {
    key: "assignee",
    render: (c) =>
      `assignee: ${
        c.assignee === null
          ? "(unassigned)"
          : `${sanitizeForDisplay(c.assignee.name)} <${sanitizeForDisplay(c.assignee.id)}>`
      }`,
  },
  { key: "priority", render: (c) => `priority: ${priorityName(c.priority)}` },
  { key: "size", render: (c) => `size: ${sanitizeForDisplay(c.size)}` },
  {
    key: "type",
    render: (c, p) =>
      `type: ${listed(c.labels.filter((l) => p.typeLabels?.includes(l)))}`,
  },
  {
    key: "repo",
    render: (c, p) =>
      `repo: ${listed(c.labels.filter((l) => p.repoLabels.includes(l)))}`,
  },
  {
    key: "context",
    render: (c, p) => `context: ${listed(contextLabels(c.labels, p))}`,
  },
];

/** The tracker's priority scale: 0 none, then 1 (urgent) to 4 (low). */
const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"];

function priorityName(priority: number): string {
  return `${priority} (${PRIORITY_NAMES[priority] ?? "unknown"})`;
}

export const REVALIDATION_FIELD_KEYS: readonly string[] =
  REVALIDATION_FIELDS.map((f) => f.key);

function listed(labels: readonly string[]): string {
  return [...labels].map(sanitizeForDisplay).sort().join(", ") || "(none)";
}

/** The context labels (`review.taxonomy.context_prefixes`), else the known area labels. */
function contextLabels(
  labels: readonly string[],
  policy: BatchPolicy,
): string[] {
  return labels.filter((l) =>
    policy.contextPrefixes === null
      ? isKnownAreaLabel(l, policy)
      : policy.contextPrefixes.some((p) => l.startsWith(p)),
  );
}

export function revalidationLine(c: Candidate, policy: BatchPolicy): string {
  return REVALIDATION_FIELDS.map((f) => f.render(c, policy)).join(" | ");
}

/** Printed under each issue of a verdict size; SKILL.md step 2 owns the verdict. */
export function verdictPrompt(size: string): string {
  return `${size}: step 2 verdict required: re-size it (fix the label) | keep it in the batch | leave it for its own pull request`;
}

const show = (labels: readonly string[]) =>
  labels.map(sanitizeForDisplay).join(", ");

function anchorLines(p: Proposal): string[] {
  const areas =
    p.anchor.areas.length > 0 ? ` → areas: ${p.anchor.areas.join(", ")}` : "";
  return [
    `Anchor: ${sanitizeForDisplay(p.anchor.input)} (${p.anchor.kind})${areas}`,
    `Pool labels: ${show(p.anchor.poolLabels) || "(the epic's open children)"}`,
    ...(p.anchor.sharedLabels.length > 0
      ? [`Rank boosts: ${show(p.anchor.sharedLabels)}`]
      : []),
    "",
  ];
}

function candidateLines(c: Candidate, policy: BatchPolicy): string[] {
  // Area labels on the row itself, so the step 2 check sees a batch that
  // spans several areas without the JSON form.
  const area = c.labels.filter((l) => isKnownAreaLabel(l, policy));
  return [
    `  ${sanitizeForDisplay(c.identifier)}  [${sanitizeForDisplay(c.size)}, ${c.points} pt] ${sanitizeForDisplay(c.title)}  (${show(area) || "no area label"})`,
    `      score ${c.score}: ${c.reasons.map(sanitizeForDisplay).join("; ")}`,
    `      ${revalidationLine(c, policy)}`,
    ...(verdictSizes(policy).includes(c.size)
      ? [`      ${verdictPrompt(c.size)}`]
      : []),
  ];
}

function batchLines(p: Proposal, policy: BatchPolicy): string[] {
  const out =
    p.candidates.length === 0
      ? ["No batchable candidates."]
      : [
          `Proposed batch (${p.points}/${p.budget} points, ${p.candidates.length}/${p.limit} items):`,
          ...p.candidates.flatMap((c) => candidateLines(c, policy)),
        ];
  if (p.overflow > 0)
    out.push(
      "",
      `${p.overflow} further eligible issue(s) beyond the item limit or the point budget.`,
    );
  return out;
}

function heldBackLines(p: Proposal, policy: BatchPolicy): string[] {
  if (p.excluded.length === 0) return [];
  return [
    "",
    "Held back:",
    ...p.excluded.map(
      (e) =>
        `  ${sanitizeForDisplay(e.identifier)}  ${describeReason(e.reason, policy)}`,
    ),
  ];
}

/**
 * What a gap's labels already say will hold it back once it has a size.
 * Only label-visible blockers: an unlabelled epic shows as a bare row, so a
 * bare row means "no known blocker", not "batchable".
 */
function gapBlockers(labels: readonly string[], policy: BatchPolicy): string[] {
  return [
    ...new Set([
      ...labels.filter((l) => soloFlagOf([l], policy) !== null),
      ...labels.filter((l) => l === policy.epicLabel),
      ...areaShapedLabels(labels, policy).filter(
        (l) => !isKnownAreaLabel(l, policy),
      ),
    ]),
  ];
}

function gapLines(p: Proposal, policy: BatchPolicy): string[] {
  if (p.labellingGaps.length === 0) return [];
  return [
    "",
    "Labelling gaps (no size label, so never in the pool; size them and re-run, which decides whether they are batchable):",
    ...p.labellingGaps.map((g) => {
      const blockers = gapBlockers(g.labels, policy);
      const suffix = blockers.length > 0 ? `  [also: ${show(blockers)}]` : "";
      return `  ${sanitizeForDisplay(g.identifier)}  ${sanitizeForDisplay(g.title)}${suffix}`;
    }),
  ];
}

export function renderTable(p: Proposal, policy: BatchPolicy): string {
  return [
    ...anchorLines(p),
    ...batchLines(p, policy),
    ...heldBackLines(p, policy),
    ...gapLines(p, policy),
    ...p.warnings.flatMap((w) => ["", `WARNING: ${sanitizeForDisplay(w)}`]),
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `usage: candidates.ts <anchor> [--limit N] [--budget N] [--claimed K1,K2] [--catalog <path>] [--format table|json]
       candidates.ts --eligibility [--claimed K1,K2] [--catalog <path>]   (issues as a JSON array on stdin)

  <anchor>  a change-area name, a repository path, an epic's key or one issue's key`;

function positiveInteger(
  raw: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new Refusal(
      `--${flag} must be a positive whole number, got "${raw}"\n${USAGE}`,
    );
  return n;
}

function claimedSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** Print the verdicts for the issues on stdin. */
async function eligibilityCommand(
  policy: BatchPolicy,
  claimed: ReadonlySet<string>,
): Promise<number> {
  let issues: PoolIssue[];
  try {
    issues = parsePoolIssues(JSON.parse(await readStdin()));
  } catch (err) {
    throw new Refusal(
      `unreadable eligibility input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(
    JSON.stringify(eligibilityReport(issues, policy, claimed), null, 2),
  );
  return 0;
}

/** Read the anchor's pool through the tracker and print the proposal. */
async function proposalCommand(
  values: ReadonlyMap<string, string>,
  anchor: string,
  catalog: ChangeAreaCatalog | null,
  policy: BatchPolicy,
  claimed: ReadonlySet<string>,
): Promise<number> {
  const format = values.get("format") ?? "table";
  if (format !== "table" && format !== "json")
    throw new Refusal(`--format must be table or json, got "${format}"`);
  const limits = {
    limit: positiveInteger(values.get("limit"), "limit", policy.maxItems),
    budget: positiveInteger(values.get("budget"), "budget", policy.pointBudget),
    claimed,
  };
  const proposal = await run(openTracker(), catalog, policy, anchor, limits);
  console.log(
    format === "json"
      ? JSON.stringify(proposal, null, 2)
      : renderTable(proposal, policy),
  );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const eligibility = argv.includes("--eligibility");
  const parsed = parseArgs(argv, {
    flags: ["eligibility"],
    values: eligibility
      ? ["claimed", "catalog"]
      : ["limit", "budget", "claimed", "catalog", "format"],
    usage: USAGE,
    noPositional: eligibility,
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { values, positional } = parsed.args;
  try {
    const overlay = readOverlay();
    const catalog = readCatalog(catalogPath(overlay, values.get("catalog")));
    const policy = policyFrom(overlay, catalog);
    const claimed = claimedSet(values.get("claimed"));
    return eligibility
      ? await eligibilityCommand(policy, claimed)
      : await proposalCommand(values, positional, catalog, policy, claimed);
  } catch (err) {
    console.error(
      `work-batch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return err instanceof Refusal ? err.code : 1;
  }
}

if (import.meta.main) runMain("work-batch", () => main(process.argv.slice(2)));
