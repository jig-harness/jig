/**
 * Whether one issue may join a batch, and when it may not, the one reason to
 * report. The proposal and the eligibility mode both decide through
 * `excludeReason`, so a dashboard or a planning tool that asks the
 * eligibility mode gets the verdict the proposal would give.
 *
 * Every read that cannot be completed holds the issue back rather than
 * admitting it: a label list that came back truncated could hide a solo-only
 * flag, and an issue missing a mandatory label carries no reliable
 * classification. Each such reason names the label to add, so the issue is
 * never dropped without a word.
 */

import {
  CLOSED_STATE_TYPES,
  type CanonicalState,
  type IssueState,
  type PoolIssue,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import { type BatchPolicy, labelPrefix } from "./policy.ts";

export type ExclusionReason =
  | { kind: "truncated"; lists: string[] }
  | { kind: "solo-flag"; flag: string }
  | { kind: "solo-area"; area: string; flags: string[] }
  | { kind: "urgent" }
  | { kind: "conflicting-size-labels"; sizes: string[] }
  | { kind: "not-batchable-size"; size: string | null }
  | { kind: "conflicting-repo-labels"; repos: string[] }
  | { kind: "wrong-repo"; repo: string | null }
  | { kind: "conflicting-type-labels"; types: string[] }
  | { kind: "no-type-label" }
  | { kind: "no-context-label" }
  | { kind: "unknown-context-label"; labels: string[] }
  | { kind: "unknown-area-label"; labels: string[] }
  | { kind: "has-open-children" }
  | { kind: "unknown-state"; state: string }
  | { kind: "already-closed"; state: string }
  | { kind: "already-assigned"; assignee: string }
  | { kind: "already-started"; state: string };

export interface EligibilityOptions {
  /**
   * Issues whose own assignee and started state do not hold them back: the
   * caller's earlier claim on this batch. Named one by one, never blanket.
   */
  claimed: ReadonlySet<string>;
}

/** The solo-only flag an issue carries, or `null`. */
export function soloFlagOf(
  labels: readonly string[],
  policy: BatchPolicy,
): string | null {
  return (
    policy.soloFlags.find((f) => labels.includes(f)) ??
    labels.find((l) => policy.soloFlagPrefixes.some((p) => l.startsWith(p))) ??
    null
  );
}

/**
 * The first area an issue's area-naming labels name whose catalog entry
 * carries a solo-only flag: every change there carries the flag, so the
 * issue is solo-only whether or not the flag is on it yet.
 */
export function soloAreaOf(
  labels: readonly string[],
  policy: BatchPolicy,
): { area: string; flags: string[] } | null {
  for (const label of [...labels].sort()) {
    const area = policy.areaNaming[label.toLowerCase()];
    const flags = area === undefined ? [] : (policy.areaFlags[area] ?? []);
    if (area !== undefined && flags.length > 0) return { area, flags };
  }
  return null;
}

/** Where a state stands for a batch: not started, started, finished, or unknown. */
export type StateStanding = "open" | "started" | "closed" | null;

const OPEN_STATE_TYPES = ["triage", "backlog", "unstarted"];

const CANONICAL_STANDING: Record<CanonicalState, StateStanding> = {
  triage: "open",
  backlog: "open",
  todo: "open",
  in_progress: "started",
  in_review: "started",
  ops_pending: "started",
  done: "closed",
  canceled: "closed",
  duplicate: "closed",
};

/**
 * A state's standing from its category, or, when the tracker reported none
 * it is known by (an empty `type` included), from its name through
 * `issue_tracker.states`. `null` when neither says: such an issue is held
 * back, never read as backlog work.
 */
export function stateStanding(
  state: IssueState,
  policy: BatchPolicy,
): StateStanding {
  if ((CLOSED_STATE_TYPES as readonly string[]).includes(state.type))
    return "closed";
  if (state.type === "started") return "started";
  if (OPEN_STATE_TYPES.includes(state.type)) return "open";
  const canonical = policy.stateNames[state.name.trim().toLowerCase()];
  return canonical === undefined ? null : CANONICAL_STANDING[canonical];
}

/** The issue's single batchable size; `null` when it has none. */
export function batchableSizeOf(
  labels: readonly string[],
  policy: BatchPolicy,
): string | null {
  return policy.batchSizes.find((s) => labels.includes(s)) ?? null;
}

/** Whether a label is one of the context labels the policy names. */
function isContextLabel(label: string, policy: BatchPolicy): boolean {
  return (policy.contextPrefixes ?? []).some((p) => label.startsWith(p));
}

/** Labels shaped like an area-naming label (`<prefix>:...`). */
export function areaShapedLabels(
  labels: readonly string[],
  policy: BatchPolicy,
): string[] {
  return labels.filter((l) => {
    const prefix = labelPrefix(l);
    return prefix !== null && policy.areaLabelPrefixes.includes(prefix);
  });
}

export function isKnownAreaLabel(label: string, policy: BatchPolicy): boolean {
  return policy.knownAreaLabels.includes(label.toLowerCase());
}

type Check = (
  issue: PoolIssue,
  policy: BatchPolicy,
  opts: EligibilityOptions,
) => ExclusionReason | null;

// Before any verdict read from the labels: a partial list makes every one of
// them unsound, "no solo-only flag" included.
const truncatedReason: Check = (issue) =>
  issue.truncated.length > 0
    ? { kind: "truncated", lists: [...issue.truncated].sort() }
    : null;

const soloReason: Check = (issue, policy) => {
  const flag = soloFlagOf(issue.labels, policy);
  return flag === null ? null : { kind: "solo-flag", flag };
};

const soloAreaReason: Check = (issue, policy) => {
  const solo = soloAreaOf(issue.labels, policy);
  return solo === null ? null : { kind: "solo-area", ...solo };
};

// A batch shares its slowest issue's fate, so an urgent issue goes alone.
const urgentReason: Check = (issue) =>
  issue.priority === 1 ? { kind: "urgent" } : null;

// Size is a pick-one group: two size labels are a labelling error, not a
// size to pick by order, which could batch an issue its own labels also call
// too large.
const sizeReason: Check = (issue, policy) => {
  const sizeLabels = issue.labels.filter((l) => policy.knownSizes.includes(l));
  if (sizeLabels.length > 1)
    return { kind: "conflicting-size-labels", sizes: [...sizeLabels].sort() };
  if (batchableSizeOf(issue.labels, policy) === null)
    return { kind: "not-batchable-size", size: sizeLabels[0] ?? null };
  return null;
};

// One repository per batch, since a pull request lands in one. An issue
// carrying two repository labels would be closed by a batch that does only
// one repository's half of the work.
const repoReason: Check = (issue, policy) => {
  if (policy.repoLabel === null) return null;
  const repos = issue.labels.filter((l) => policy.repoLabels.includes(l));
  if (repos.length > 1)
    return { kind: "conflicting-repo-labels", repos: [...repos].sort() };
  if (!issue.labels.includes(policy.repoLabel))
    return { kind: "wrong-repo", repo: repos[0] ?? null };
  return null;
};

const typeReason: Check = (issue, policy) => {
  const typeLabels = policy.typeLabels;
  if (typeLabels === null) return null;
  const types = issue.labels.filter((l) => typeLabels.includes(l));
  if (types.length > 1)
    return { kind: "conflicting-type-labels", types: [...types].sort() };
  return types.length === 0 ? { kind: "no-type-label" } : null;
};

// The context group is not pick-one, so one known context label is enough,
// a typo beside it is someone else's cleanup. An issue whose every context
// label names nothing the configuration knows has no usable context, and a
// batch ranks on the context its items share.
const contextReason: Check = (issue, policy) => {
  if (policy.contextPrefixes === null) return null;
  const context = issue.labels.filter((l) => isContextLabel(l, policy));
  if (context.length === 0) return { kind: "no-context-label" };
  return context.some((l) =>
    policy.knownContextLabels.includes(l.toLowerCase()),
  )
    ? null
    : { kind: "unknown-context-label", labels: [...context].sort() };
};

// An area label nothing knows (a typo, a retired area) names no area, and the
// batch ranks on the areas its items share. One known area label beside it
// is enough: the typo is someone else's cleanup.
const areaReason: Check = (issue, policy) => {
  const areaShaped = areaShapedLabels(issue.labels, policy);
  return areaShaped.length > 0 &&
    !areaShaped.some((l) => isKnownAreaLabel(l, policy))
    ? { kind: "unknown-area-label", labels: [...areaShaped].sort() }
    : null;
};

// An epic is a container: closing it needs its children closed, which a
// batch does not do. The label is the declared marker; the open children
// catch an unlabelled one.
const containerReason: Check = (issue, policy) =>
  issue.labels.includes(policy.epicLabel) || issue.hasOpenChildren
    ? { kind: "has-open-children" }
    : null;

const stateReason: Check = (issue, policy) => {
  const standing = stateStanding(issue.state, policy);
  if (standing === null)
    return { kind: "unknown-state", state: issue.state.name };
  return standing === "closed"
    ? { kind: "already-closed", state: issue.state.name }
    : null;
};

// Assigned without being started is still spoken for: the claim would
// reassign it away from its owner.
const ownershipReason: Check = (issue, policy, opts) => {
  if (opts.claimed.has(issue.identifier)) return null;
  if (issue.assignee !== null)
    return { kind: "already-assigned", assignee: issue.assignee.name };
  if (stateStanding(issue.state, policy) === "started")
    return { kind: "already-started", state: issue.state.name };
  return null;
};

/**
 * The checks, in the order their reasons are reported. They are
 * independent; the order decides only which reason an issue shows, so the
 * unreadable-label guard and the solo-only flags come first: they are the
 * reasons a person most needs to see.
 */
const CHECKS: readonly Check[] = [
  truncatedReason,
  soloReason,
  soloAreaReason,
  urgentReason,
  sizeReason,
  repoReason,
  typeReason,
  contextReason,
  areaReason,
  containerReason,
  stateReason,
  ownershipReason,
];

/** Whether one issue may ride in a batch: `null`, or the one reason it may not. */
export function excludeReason(
  issue: PoolIssue,
  policy: BatchPolicy,
  opts: EligibilityOptions,
): ExclusionReason | null {
  for (const check of CHECKS) {
    const reason = check(issue, policy, opts);
    if (reason !== null) return reason;
  }
  return null;
}

export interface Excluded {
  identifier: string;
  title: string;
  reason: ExclusionReason;
}

/** Every issue exactly once: eligible, or excluded with its reason. */
export function partition(
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
  opts: EligibilityOptions,
): { eligible: PoolIssue[]; excluded: Excluded[] } {
  const eligible: PoolIssue[] = [];
  const excluded: Excluded[] = [];
  for (const issue of issues) {
    const reason = excludeReason(issue, policy, opts);
    if (reason === null) eligible.push(issue);
    else
      excluded.push({
        identifier: issue.identifier,
        title: issue.title,
        reason,
      });
  }
  return { eligible, excluded };
}

// C0 and C1 control characters and DEL: tracker text is untrusted, and an
// escape sequence in a title could rewrite the proposal on screen.
const char = String.fromCharCode;
const CONTROL = new RegExp(
  `[${char(0)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}]`,
  "g",
);

/** `text` without control characters, for terminal output. JSON escapes them itself. */
export function sanitizeForDisplay(text: string): string {
  return text.replace(CONTROL, "");
}

const code = (s: string) => `\`${sanitizeForDisplay(s)}\``;

const codes = (labels: readonly string[]) => labels.map(code).join(", ");

type Describers = {
  [K in ExclusionReason["kind"]]: (
    reason: Extract<ExclusionReason, { kind: K }>,
    policy: BatchPolicy,
  ) => string;
};

// Without work_batch.sizes only the batchable sizes and the taxonomy's are
// known, so "no size label" may hide a larger size nobody listed.
function noSizeLabel(policy: BatchPolicy): string {
  const unlisted = policy.sizes === null;
  return `no ${unlisted ? "batchable " : ""}size label; add one of ${codes(policy.batchSizes)} if it fits, and re-run${unlisted ? " (without work_batch.sizes a larger size label is not recognised)" : ""}`;
}

const DESCRIBE: Describers = {
  truncated: (r) =>
    `its ${r.lists.join(", ")} did not come back in full; a solo-only flag could be on the part not read`,
  "solo-flag": (r) => `solo-only: carries ${code(r.flag)}`,
  "solo-area": (r) =>
    `solo-only: its area ${code(r.area)} carries ${codes(r.flags)} in the catalog, so every change there does`,
  urgent: () =>
    "urgent: a batch shares its slowest issue's fate, so it goes alone with /jig:do-item",
  "conflicting-size-labels": (r) =>
    `conflicting size labels (${codes(r.sizes)}); keep one and re-run`,
  "not-batchable-size": (r, policy) =>
    r.size === null
      ? noSizeLabel(policy)
      : `size ${code(r.size)} is too large to batch`,
  "conflicting-repo-labels": (r) =>
    `conflicting repository labels (${codes(r.repos)}); keep one and re-run`,
  "wrong-repo": (r, policy) =>
    r.repo === null
      ? `no repository label; add ${code(policy.repoLabel ?? "")} if it belongs here, and re-run`
      : `repository ${code(r.repo)}`,
  "conflicting-type-labels": (r) =>
    `conflicting type labels (${codes(r.types)}); keep one and re-run`,
  "no-type-label": (_r, policy) =>
    `no type label; add one of ${codes(policy.typeLabels ?? [])} and re-run`,
  "no-context-label": (_r, policy) =>
    `no context label; add one starting with ${codes(policy.contextPrefixes ?? [])} and re-run`,
  "unknown-context-label": (r) =>
    `context label(s) ${codes(r.labels)} name nothing the configuration knows; fix the label (or add it to the catalog, do_item.agents.codearea_areas or do_item.agents.labels) and re-run`,
  "unknown-area-label": (r) =>
    `area label(s) ${codes(r.labels)} name no known area; fix the label (or add it to the catalog or do_item.agents.codearea_areas) and re-run`,
  "has-open-children": () => "an epic, or has open children",
  "unknown-state": (r) =>
    `state ${code(r.state)} has no category the tracker reported and names no state in issue_tracker.states; map it there and re-run`,
  "already-closed": (r) => `already ${code(r.state)}`,
  "already-assigned": (r) => `already assigned to ${code(r.assignee)}`,
  "already-started": (r) => `already ${code(r.state)}`,
};

/** A reason as a person reads it, naming what to fix where there is a fix. */
export function describeReason(
  reason: ExclusionReason,
  policy: BatchPolicy,
): string {
  const describe = DESCRIBE[reason.kind] as (
    r: ExclusionReason,
    p: BatchPolicy,
  ) => string;
  return describe(reason, policy);
}
