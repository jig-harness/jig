/**
 * A fixed batch: the members a dispatcher launch names, proposed with
 * `--fixed`. Nobody is there to rule on a member's size, so the size rules
 * itself: a member of a verdict size, or one whose size no longer fits a
 * batch (too large, cleared, or two at once), is left for its own pickup.
 * So is a member whose priority was cleared, which the dispatcher holds
 * until it has one, rather than a question about the priority.
 *
 * With fewer than two members kept, the pass works one alone (`aloneChoice`).
 * Whether a member with no priority may be that one is the dispatcher's
 * `dispatch.missing_priority`, as the launch carried it from the default
 * branch (`--missing-priority`): the workspace's own configuration, which
 * nobody reviewed, never decides it.
 */
import type {
  PoolIssue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  batchableSizeOf,
  describeReason,
  type EligibilityOptions,
  type Excluded,
  type ExclusionReason,
  otherExclusion,
  partition,
  sanitizeForDisplay,
} from "./eligibility.ts";
import { Refusal } from "./errors.ts";
import { type BatchPolicy, verdictSizes } from "./policy.ts";

export interface LeftOut {
  identifier: string;
  title: string;
  /** `null` when the member has no one size, or is left out for its missing priority. */
  size: string | null;
  /** Why its size or missing priority keeps it out of the batch, as a person reads it. */
  why: string;
  /** Whether its missing priority, not its size, keeps it out. */
  noPriority: boolean;
  /** Whether another guard (repository, type, state, ...) also bars it, so it may not be the member worked alone. */
  blocked: boolean;
}

/** `dispatch.missing_priority`'s values, as a fixed batch's launch carries them. */
export type MissingPriority = "hold" | "start";

/**
 * `--missing-priority`: the value the launch carried, `hold` when it named
 * none. Only a fixed batch takes it; it never falls back to the workspace's
 * own `dispatch.missing_priority`.
 */
export function missingPriorityFlag(
  raw: string | undefined,
  fixed: ReadonlySet<string> | undefined,
): MissingPriority {
  if (raw !== undefined && fixed === undefined)
    throw new Refusal("--missing-priority needs --fixed");
  if (raw === undefined || raw === "hold" || raw === "start")
    return raw ?? "hold";
  throw new Refusal(`--missing-priority must be hold or start, got "${raw}"`);
}

/** With fewer than two members kept: the one member to claim alone, or none, with the members held for their missing priority. */
export interface AloneChoice {
  /** The launch's `dispatch.missing_priority`, `hold` when it named none. */
  missingPriority: MissingPriority;
  /** The member to claim and work alone; `null` when none may start. */
  claim: string | null;
  /** When none may start: the members left out for their missing priority, each held by the dispatcher until it has one. */
  heldForPriority: string[];
}

interface Parts {
  eligible: PoolIssue[];
  excluded: Excluded[];
}

/** Whether `reason` is about the size or the missing priority, which take a fixed batch's member out of it. */
export function leavesFixedBatch(reason: ExclusionReason): boolean {
  return (
    reason.kind === "not-batchable-size" ||
    reason.kind === "conflicting-size-labels" ||
    reason.kind === "no-priority"
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

/**
 * `issues` partitioned, and under `fixed` narrowed to the named members, with
 * those their size or missing priority takes out set apart, in the named
 * order. A member left out for its size that also lost its priority is
 * marked `noPriority` too, since one reason is all its exclusion shows.
 */
export function splitFixed(
  issues: readonly PoolIssue[],
  policy: BatchPolicy,
  opts: EligibilityOptions & { fixed?: ReadonlySet<string> },
): Parts & { leftOut: LeftOut[] } {
  const parts = partition(issues, policy, opts);
  const fixed = opts.fixed;
  if (fixed === undefined) return { ...parts, leftOut: [] };
  const unranked = new Set(
    issues
      .filter(
        (i) => i.priority === 0 && !i.unmappedFacets?.includes("priority"),
      )
      .map((i) => i.identifier),
  );
  const byKey = new Map(issues.map((i) => [i.identifier, i]));
  const blockedBy = (key: string) => {
    const issue = byKey.get(key);
    return issue !== undefined && otherExclusion(issue, policy, opts) !== null;
  };
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
      noPriority: unranked.has(i.identifier),
      blocked: false,
    });
    return false;
  });
  const excluded = parts.excluded.filter((e) => {
    if (!fixed.has(e.identifier)) return false;
    if (!leavesFixedBatch(e.reason)) return true;
    leftOut.push({
      identifier: e.identifier,
      title: e.title,
      size: e.reason.kind === "not-batchable-size" ? e.reason.size : null,
      why: describeReason(e.reason, policy),
      noPriority: unranked.has(e.identifier),
      blocked: blockedBy(e.identifier),
    });
    return false;
  });
  const order = [...fixed];
  leftOut.sort(
    (a, b) => order.indexOf(a.identifier) - order.indexOf(b.identifier),
  );
  return { eligible, excluded, leftOut };
}

/**
 * The member a fixed batch with fewer than two kept works alone: the one
 * kept, else the first left out that no other guard bars and whose priority is
 * set, else, under `start`, the first such left out. `null` for a proposal that is no fixed batch, or a
 * batch that keeps two or more.
 */
export function aloneChoice(
  kept: readonly { identifier: string }[],
  leftOut: readonly LeftOut[],
  opts: { fixed?: ReadonlySet<string>; missingPriority?: MissingPriority },
): AloneChoice | null {
  if (opts.fixed === undefined || kept.length >= 2) return null;
  const missingPriority = opts.missingPriority ?? "hold";
  const startable = leftOut.filter(
    (l) => !l.blocked && (missingPriority === "start" || !l.noPriority),
  );
  const claim = kept[0]?.identifier ?? startable[0]?.identifier ?? null;
  return {
    missingPriority,
    claim,
    heldForPriority:
      claim === null
        ? leftOut.filter((l) => l.noPriority).map((l) => l.identifier)
        : [],
  };
}

/** The table's line for the member worked alone, or for the members none of whom may start. */
function aloneLines(choice: AloneChoice | null | undefined): string[] {
  if (choice === null || choice === undefined) return [];
  if (choice.claim !== null)
    return [
      "",
      `Fewer than two kept: work ${sanitizeForDisplay(choice.claim)} alone.`,
    ];
  const held = choice.heldForPriority.map(sanitizeForDisplay).join(", ");
  if (held === "")
    return [
      "",
      "Fewer than two kept, and none may start: another guard bars every left-out member.",
    ];
  return [
    "",
    `Fewer than two kept, and none may start (dispatch.missing_priority: ${choice.missingPriority}): ${held} lost ${choice.heldForPriority.length === 1 ? "its" : "their"} priority.`,
  ];
}

export function leftOutLines(
  leftOut: readonly LeftOut[],
  alone?: AloneChoice,
): string[] {
  if (leftOut.length === 0) return aloneLines(alone);
  return [
    "",
    "Left for their own pickups:",
    ...leftOut.map(
      (l) =>
        `  ${sanitizeForDisplay(l.identifier)}  ${sanitizeForDisplay(l.why)}`,
    ),
    ...aloneLines(alone),
  ];
}
