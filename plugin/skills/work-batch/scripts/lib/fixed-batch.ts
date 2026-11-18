/**
 * A fixed batch: the members a dispatcher launch names, proposed with
 * `--fixed`. Nobody is there to rule on a member's size, so the size rules
 * itself: a member of a verdict size, or one whose size no longer fits a
 * batch (too large, cleared, or two at once), is left for its own pickup.
 */
import type {
  PoolIssue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  batchableSizeOf,
  describeReason,
  type Excluded,
  type ExclusionReason,
  sanitizeForDisplay,
} from "./eligibility.ts";
import { type BatchPolicy, verdictSizes } from "./policy.ts";

export interface LeftOut {
  identifier: string;
  title: string;
  /** `null` when the member has no one size. */
  size: string | null;
  /** Why the size keeps it out of the batch, as a person reads it. */
  why: string;
}

interface Parts {
  eligible: PoolIssue[];
  excluded: Excluded[];
}

/** Whether `reason` is about the size, which takes a fixed batch's member out of it. */
export function sizeLeavesBatch(reason: ExclusionReason): boolean {
  return (
    reason.kind === "not-batchable-size" ||
    reason.kind === "conflicting-size-labels"
  );
}

/** The named members other than `seed`, each read from the tracker. */
export async function readFixedMembers(
  tracker: Tracker,
  fixed: ReadonlySet<string>,
  seed: string,
  warnings: string[],
): Promise<PoolIssue[]> {
  const members: PoolIssue[] = [];
  for (const key of fixed) {
    if (key === seed) continue;
    const member = await tracker.poolIssue(key);
    if (member === null) warnings.push(`fixed member ${key} was not found`);
    else if (member.identifier !== key)
      warnings.push(`fixed member ${key} came back as ${member.identifier}`);
    else members.push(member);
  }
  return members;
}

/** `parts` narrowed to the named members, with those their size takes out set apart, in the named order. */
export function splitFixed(
  parts: Parts,
  policy: BatchPolicy,
  fixed: ReadonlySet<string> | undefined,
): Parts & { leftOut: LeftOut[] } {
  if (fixed === undefined) return { ...parts, leftOut: [] };
  const verdict = verdictSizes(policy);
  const sizeOf = (i: PoolIssue) => batchableSizeOf(i, policy) ?? "";
  const leftOut: LeftOut[] = [];
  const eligible = parts.eligible.filter((i) => {
    if (!fixed.has(i.identifier)) return false;
    const size = sizeOf(i);
    if (!verdict.includes(size)) return true;
    leftOut.push({
      identifier: i.identifier,
      title: i.title,
      size,
      why: `${size} is the most expensive batchable size, which a fixed batch leaves to its own pull request`,
    });
    return false;
  });
  const excluded = parts.excluded.filter((e) => {
    if (!fixed.has(e.identifier)) return false;
    if (!sizeLeavesBatch(e.reason)) return true;
    leftOut.push({
      identifier: e.identifier,
      title: e.title,
      size: e.reason.kind === "not-batchable-size" ? e.reason.size : null,
      why: describeReason(e.reason, policy),
    });
    return false;
  });
  const order = [...fixed];
  leftOut.sort(
    (a, b) => order.indexOf(a.identifier) - order.indexOf(b.identifier),
  );
  return { eligible, excluded, leftOut };
}

export function leftOutLines(leftOut: readonly LeftOut[]): string[] {
  if (leftOut.length === 0) return [];
  return [
    "",
    "Left for their own pickups:",
    ...leftOut.map(
      (l) =>
        `  ${sanitizeForDisplay(l.identifier)}  ${sanitizeForDisplay(l.why)}`,
    ),
  ];
}
