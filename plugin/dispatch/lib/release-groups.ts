/**
 * Untagged releases of one repository that share a remedy reach a person as
 * one need. The remedy is what is left to try: a release whose failed gates
 * can still be re-run once groups with the others that can, and one whose
 * re-run was requested groups with the others whose re-run was. A lone release
 * keeps a decision of its own.
 *
 * A group is answered on the tracker item of its newest version, and lists
 * every version it covers, so its decision changes when the list does.
 *
 * A release a person took keeps the decision they answered, whatever happens
 * to the other versions: the tick goes on reading that answer, which holds the
 * need off the line. When the answer no longer holds it (another answer
 * replaced it, or it is gone), the release returns to the groups above.
 */
import { isRecord, isString } from "../../shared/guards.ts";
import { attempt } from "../../shared/outcome.ts";
import type { Action, Evidence } from "./types.ts";

/** A release that waits on a person, as grouping reads it. */
export interface OwedRelease {
  tag: string;
  item: string;
  rerun_claimed: number;
  /** The decision a person took it under (`takenDecision`); `null` when none did. */
  taken_as: string | null;
}

/** What identifies the decision a release was taken under. */
interface TakenDecision {
  target: string;
  evidence: Evidence;
}

function byVersion(left: OwedRelease, right: OwedRelease): number {
  return left.tag.localeCompare(right.tag, "en", { numeric: true });
}

function words(evidence: Evidence, field: string): string[] {
  const value = evidence[field];
  return typeof value === "string" && value !== "" ? value.split(" ") : [];
}

/** The versions a group's decision lists; none for a lone release's. */
export function groupTags(evidence: Evidence): string[] {
  return words(evidence, "tags");
}

/** The tracker items of the versions a group's decision lists; none for a lone release's. */
export function groupItems(evidence: Evidence): string[] {
  return words(evidence, "items");
}

/** The versions an answer to this need acts on: those still owed of the ones its decision lists. */
export function owedTags(evidence: Evidence): string[] {
  const open = words(evidence, "open");
  if (open.length > 0) return open;
  const { tag } = evidence;
  return typeof tag === "string" && tag !== "" ? [tag] : groupTags(evidence);
}

function owedReason(tags: readonly string[], rerunSpent: boolean): string {
  const [only] = tags;
  const owed =
    tags.length === 1 && only !== undefined
      ? `Release ${only} is owed its tag.`
      : `${tags.length} releases are owed their tags: ${tags.join(", ")}.`;
  return rerunSpent
    ? `${owed} The one re-run of the failed gates was already requested.`
    : owed;
}

function owedTitle(count: number): string {
  return count === 1
    ? "1 release owes its tag"
    : `${count} releases owe their tags`;
}

function needAction(
  target: string,
  reason: string,
  evidence: Evidence,
): Action {
  return {
    stage: "notify",
    cause: "release-owed",
    target,
    record: "tracker",
    reason,
    evidence,
  };
}

function loneAction({ tag, item, rerun_claimed }: OwedRelease): Action {
  const rerunSpent = rerun_claimed !== 0;
  return needAction(item, owedReason([tag], rerunSpent), {
    tag,
    ...(rerunSpent ? { rerunSpent } : {}),
  });
}

function groupAction(
  group: readonly OwedRelease[],
  newest: OwedRelease,
): Action {
  const tags = group.map(({ tag }) => tag);
  const rerunSpent = newest.rerun_claimed !== 0;
  return needAction(newest.item, owedReason(tags, rerunSpent), {
    tags: tags.join(" "),
    items: group.map(({ item }) => item).join(" "),
    rerunSpent,
    title: owedTitle(tags.length),
  });
}

/** Whether the need is of releases a person took, held off the line by their answer. */
export function isTakenNeed(evidence: Evidence): boolean {
  return words(evidence, "open").length > 0;
}

/** How `action`'s decision is kept on the releases a person takes under it. */
export function takenDecision(action: Action): string {
  const { tag, tags, items, rerunSpent } = action.evidence;
  const evidence: Evidence =
    typeof tag === "string"
      ? { tag, ...(rerunSpent === true ? { rerunSpent } : {}) }
      : {
          tags: tags ?? null,
          items: items ?? null,
          rerunSpent: rerunSpent ?? false,
        };
  return JSON.stringify({ target: action.target, evidence });
}

function isEvidence(value: unknown): value is Evidence {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (field) =>
        field === null ||
        ["string", "number", "boolean"].includes(typeof field),
    )
  );
}

function readTaken(kept: string): TakenDecision | null {
  const read = attempt("unreadable", "unreadable", (): unknown =>
    JSON.parse(kept),
  );
  if (!read.ok || !isRecord(read.value)) return null;
  const { target, evidence } = read.value;
  return isString(target) && isEvidence(evidence) ? { target, evidence } : null;
}

/** The need of the releases a person took under one decision, which that person's answer holds off the line. */
function takenAction(
  decision: TakenDecision,
  releases: readonly OwedRelease[],
): Action {
  const tags = releases.map(({ tag }) => tag);
  const { target, evidence } = decision;
  const grouped = groupTags(evidence).length > 0;
  return needAction(target, owedReason(tags, evidence.rerunSpent === true), {
    ...evidence,
    open: tags.join(" "),
    ...(grouped ? { title: owedTitle(tags.length) } : {}),
  });
}

/** The needs of the releases a person took, one per decision they were taken under; those whose record does not read are left with the rest. */
function takenActions(sorted: readonly OwedRelease[]): {
  actions: Action[];
  unread: OwedRelease[];
} {
  const byDecision = new Map<string, OwedRelease[]>();
  const unread: OwedRelease[] = [];
  for (const release of sorted) {
    const kept = release.taken_as;
    if (kept === null) continue;
    if (readTaken(kept) === null) unread.push(release);
    else byDecision.set(kept, [...(byDecision.get(kept) ?? []), release]);
  }
  const actions = [...byDecision].flatMap(([kept, releases]) => {
    const decision = readTaken(kept);
    return decision === null ? [] : [takenAction(decision, releases)];
  });
  return { actions, unread };
}

/** The needs of `owed`: one for each remedy its open releases share, and one for each decision a person took some under. */
export function releaseActions(owed: readonly OwedRelease[]): Action[] {
  const sorted = [...owed].sort(byVersion);
  const { actions, unread } = takenActions(sorted);
  const open = sorted.filter(
    (release) => release.taken_as === null || unread.includes(release),
  );
  const grouped = [false, true].flatMap((spent) => {
    const group = open.filter((r) => (r.rerun_claimed !== 0) === spent);
    const newest = group.at(-1);
    if (newest === undefined) return [];
    return [
      group.length === 1 ? loneAction(newest) : groupAction(group, newest),
    ];
  });
  return [...grouped, ...actions];
}
