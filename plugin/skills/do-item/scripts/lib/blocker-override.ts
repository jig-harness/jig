/**
 * Open blockers on a plain claim, and a person's recorded decision to start
 * ahead of them.
 *
 * An item with an open `blocked_by` relation waits on that blocker: one
 * whose state is not completed, canceled or duplicate, or one that cannot be
 * read, since an unreadable blocker is not known to be finished. A plain
 * claim (`tracker.ts claim` without a served or factory claim's options)
 * refuses such an item with nothing written (`"why": "blockers"`), as a
 * served claim withholds it (`served-claim.ts`).
 *
 * A person who knowingly decides to start the work anyway passes
 * `--override-blockers "<reason>"` (`claim-options.ts` refuses it outside an
 * interactive session). It clears that refusal and a preflight refusal its
 * command tagged `kind: blockers` (`preflight.ts`), nothing else: every other
 * refusal of the claim still stands. Before the claim writes, the open
 * blockers and the consequence statement are printed on stderr; once the
 * claim lands, one comment on the item records the override, the label
 * `do_item.override_label` names is added where the repository sets one
 * (never removed by Jig), and with `do_item.claim_marker` the claim marker
 * carries the same facts (`claim-marker.ts`).
 */
import { oneLine } from "../../../../shared/repo-command.ts";
import type { ClaimResult } from "./claim.ts";
import type { MarkerOverride } from "./claim-marker.ts";
import type { PoolIssue, Tracker } from "./tracker/port.ts";

/** The state types in which a blocker no longer holds an item back. */
const FINISHED = ["completed", "canceled", "duplicate"];

/** Whether a blocker still holds its item back: open, or unreadable. */
export function blockerHolds(issue: PoolIssue | null): boolean {
  return issue === null || !FINISHED.includes(issue.state.type);
}

/** One open blocker as the claim read it; an unreadable one has only its key. */
export interface OpenBlocker {
  key: string;
  title: string | null;
  /** The tracker's name for its state; `null` when it could not be read. */
  state: string | null;
  assignee: string | null;
}

/** What an override records: who started the item, why, and what it was started ahead of. */
export interface BlockerOverride {
  reason: string;
  /** The tracker identity the claim acts as: in an interactive session, the person's. */
  person: string;
  blockers: OpenBlocker[];
  /** The preflight command's blocker refusal the override cleared, when it refused. */
  preflight?: string;
}

/** What the claim's JSON says of an override, once the claim landed. */
export interface OverrideReport extends BlockerOverride {
  comment: { posted: true } | { posted: false; reason: string };
  label?:
    | { name: string; added: true }
    | { name: string; added: false; reason: string };
}

/** The one statement of what starting ahead of open blockers risks. */
export const OVERRIDE_CONSEQUENCE =
  "Starting ahead of open blockers: the work may depend on changes that do not exist yet or may still change, may need rework when they land, and may not be safe to merge before them.";

type BlockerTracker = Pick<Tracker, "listRelations" | "poolIssue">;

/** The item's open and unreadable blockers, in the order its relations list them. */
export async function openBlockers(
  tracker: BlockerTracker,
  key: string,
): Promise<OpenBlocker[]> {
  const out: OpenBlocker[] = [];
  for (const relation of await tracker.listRelations(key)) {
    if (relation.type !== "blocked_by") continue;
    const blocker = await tracker.poolIssue(relation.issue);
    if (!blockerHolds(blocker)) continue;
    out.push({
      key: relation.issue,
      title: blocker?.title ?? null,
      state: blocker?.state.name ?? null,
      assignee: blocker?.assignee?.name ?? null,
    });
  }
  return out;
}

const named = (b: OpenBlocker) =>
  b.state === null ? `${b.key} (unreadable)` : `${b.key} (${b.state})`;

/** The refusal of a plain claim of an item with open blockers: nothing was written. */
export function blockersRefusal(
  key: string,
  blockers: OpenBlocker[],
): ClaimResult {
  return {
    outcome: "refused",
    issue: key,
    why: "blockers",
    overridable: true,
    reason: `${key} waits on ${blockers.map(named).join(", ")}: a person may start it ahead of them with --override-blockers "<reason>"`,
  };
}

/** One line describing a blocker, for stderr and the comment. */
function blockerLine(b: OpenBlocker): string {
  if (b.state === null) return `${b.key}: could not be read`;
  const title = b.title === null ? "" : ` "${oneLine(b.title)}"`;
  const who = b.assignee === null ? "unassigned" : `assigned to ${b.assignee}`;
  return `${b.key}${title}: ${b.state}, ${who}`;
}

/** What the claim prints on stderr before an overridden claim writes. */
export function overrideStatement(
  key: string,
  override: BlockerOverride,
): string {
  return [
    `${key} is claimed ahead of its blockers on ${override.person}'s decision: ${override.reason}`,
    ...override.blockers.map((b) => `  blocked by ${blockerLine(b)}`),
    ...(override.preflight === undefined
      ? []
      : [`  the repository's preflight check: ${override.preflight}`]),
    OVERRIDE_CONSEQUENCE,
  ].join("\n");
}

/** The comment that records the override on the item. */
export function overrideComment(
  key: string,
  override: BlockerOverride,
): string {
  return [
    "## Blocker override",
    "",
    `${override.person} started ${key} ahead of its open blockers: ${oneLine(override.reason)}`,
    "",
    ...override.blockers.map((b) => `- ${blockerLine(b)}`),
    ...(override.preflight === undefined
      ? []
      : [`- the repository's preflight check: ${oneLine(override.preflight)}`]),
    "",
    OVERRIDE_CONSEQUENCE,
    "",
  ].join("\n");
}

/** The claim marker's payload fields for an override: none without one. */
export function markerOverride(override: BlockerOverride | null): {
  override?: MarkerOverride;
} {
  if (override === null) return {};
  return {
    override: {
      reason: override.reason,
      person: override.person,
      blockers: override.blockers.map((b) => ({ key: b.key, state: b.state })),
      ...(override.preflight === undefined
        ? {}
        : { preflight: override.preflight }),
    },
  };
}

export type BlockerGate =
  | { refusal: ClaimResult }
  | { override: BlockerOverride | null };

export interface GateInput {
  /** A plain claim: no served or factory claim's options. */
  plain: boolean;
  /** `--override-blockers`' reason, when the person gave one. */
  reason: string | undefined;
  /** The preflight command's blocker refusal the reason clears, when it refused. */
  preflight: string | null;
  /** The identity the override is recorded under, read only for an override. */
  person: () => Promise<string>;
  say?: (line: string) => void;
}

/**
 * Before the claim lock and any write: refuse a plain claim of an item with
 * open blockers, unless the person overrides them, in which case the
 * blockers and the consequence are printed and the override returned for
 * the claim to record. A served or factory claim reads no blockers here: it
 * checks its own.
 */
export async function blockerGate(
  tracker: BlockerTracker,
  key: string,
  input: GateInput,
): Promise<BlockerGate> {
  if (!input.plain) return { override: null };
  const blockers = await openBlockers(tracker, key);
  if (input.reason === undefined)
    return blockers.length === 0
      ? { override: null }
      : { refusal: blockersRefusal(key, blockers) };
  if (blockers.length === 0 && input.preflight === null) {
    (input.say ?? console.error)(
      `${key} has no open blockers: --override-blockers overrides nothing, and the claim goes on as any other`,
    );
    return { override: null };
  }
  const override: BlockerOverride = {
    reason: input.reason.trim(),
    person: await input.person(),
    blockers,
    ...(input.preflight === null ? {} : { preflight: input.preflight }),
  };
  (input.say ?? console.error)(overrideStatement(key, override));
  return { override };
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Record a landed claim's override on the item: one comment, then the
 * repository's override label where it sets one. Neither undoes the claim
 * when it fails; the report says what was not recorded.
 */
export async function recordOverride(
  tracker: Pick<Tracker, "postComment" | "updateIssue">,
  key: string,
  override: BlockerOverride,
  label: string | null,
): Promise<OverrideReport> {
  let comment: OverrideReport["comment"] = { posted: true };
  try {
    await tracker.postComment(key, overrideComment(key, override));
  } catch (error) {
    comment = { posted: false, reason: reasonOf(error) };
  }
  if (label === null) return { ...override, comment };
  try {
    await tracker.updateIssue(key, { addLabels: [label] });
    return { ...override, comment, label: { name: label, added: true } };
  } catch (error) {
    return {
      ...override,
      comment,
      label: { name: label, added: false, reason: reasonOf(error) },
    };
  }
}

/** The claim's result with what it recorded of an override; unchanged without one. */
export async function withOverrideRecorded<R extends ClaimResult>(
  tracker: Pick<Tracker, "postComment" | "updateIssue">,
  result: R,
  override: BlockerOverride | null,
  label: string | null,
  say: (line: string) => void = console.error,
): Promise<R | (R & { override: OverrideReport })> {
  if (override === null || result.outcome !== "claimed") return result;
  const report = await recordOverride(tracker, result.issue, override, label);
  if (!report.comment.posted)
    say(
      `the override of ${result.issue}'s blockers was not recorded in a comment: ${report.comment.reason}`,
    );
  if (report.label !== undefined && !report.label.added)
    say(
      `the label ${report.label.name} was not added to ${result.issue}: ${report.label.reason}`,
    );
  return { ...result, override: report };
}
