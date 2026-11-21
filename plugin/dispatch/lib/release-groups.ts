/**
 * Untagged releases of one repository that share a remedy reach a person as
 * one need. The remedy is what is left to try: a release whose failed gates
 * can still be re-run once groups with the others that can, one whose re-run
 * was requested groups with the others whose re-run was, and one with no
 * failed gate to re-run groups with the others that have none. A lone release
 * keeps a decision of its own.
 *
 * A release has no failed gate to re-run when the repository's configuration
 * makes the tag a person's step (`changelog.release.tagged_by: person`),
 * allows no re-run (`changelog.release.rerun_failed_gates: 0`), or its
 * follow-up recorded a tag-plan state other than `failed`: every required
 * check passed (`ready`), or the version is outside automatic tagging
 * (`manual`, `imported`). A release recorded without a state keeps the re-run.
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
import { shapeOfKey } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { Action, Evidence } from "./types.ts";

/** A release that waits on a person, as grouping reads it. */
export interface OwedRelease {
  tag: string;
  item: string;
  rerun_claimed: number;
  /** Its state in the tag plan when its follow-up recorded it owed; `null` or absent when none said. */
  plan_state?: string | null;
  /** The decision a person took it under (`takenDecision`); `null` when none did. */
  taken_as: string | null;
}

/** What the repository's configuration says of its releases' tags (`releasePolicyOf`). */
export interface ReleasePolicy {
  /** `changelog.release.tagged_by: person`: a person creates every tag. */
  personTags: boolean;
  /** `changelog.release.rerun_failed_gates: 0`: no failed gate is run again. */
  noReruns: boolean;
}

const DEFAULT_RELEASE_POLICY: ReleasePolicy = {
  personTags: false,
  noReruns: false,
};

/** What is left to try for a release: a re-run, a re-run already requested, or a person's tag. */
type Remedy = "gates" | "spent" | "tag";

/** Why each plan state leaves no failed gate to re-run, for the versions in it. */
const NO_FAILED_GATE: Readonly<Record<string, (tags: string) => string>> = {
  ready: (tags) =>
    `Every required check passed on the releasing commit of ${tags}, so no failed gate is left to re-run.`,
  manual: (tags) =>
    `The tag plan leaves ${tags} to a person: older than the newest tag, outside automatic tagging.`,
  imported: (tags) =>
    `The tag plan leaves ${tags} to a person: its heading arrived with others, so no commit released it.`,
};

function remedyOf(release: OwedRelease, policy: ReleasePolicy): Remedy {
  if (policy.personTags || policy.noReruns) return "tag";
  const state = release.plan_state;
  if (state != null && state in NO_FAILED_GATE) return "tag";
  return release.rerun_claimed !== 0 ? "spent" : "gates";
}

/** Why `releases`, of one remedy `tag`, have no failed gate to re-run: what the repository's procedure says. */
function noRerunWhy(
  releases: readonly OwedRelease[],
  policy: ReleasePolicy,
): string {
  if (policy.personTags)
    return "The repository's configuration makes the tag a person's step (changelog.release.tagged_by: person).";
  if (policy.noReruns)
    return "The repository runs no failed gate again (changelog.release.rerun_failed_gates: 0).";
  return Object.entries(NO_FAILED_GATE)
    .flatMap(([state, why]) => {
      const tags = releases
        .filter((r) => r.plan_state === state)
        .map(({ tag }) => tag);
      return tags.length === 0 ? [] : [why(tags.join(", "))];
    })
    .join(" ");
}

/** What identifies the decision a release was taken under. */
interface TakenDecision {
  target: string;
  evidence: Evidence;
}

/** The version a tag names: what follows the repository's configured tag prefix (`changelog.tag_prefix`); `null` when the tag does not carry it. */
function versionOf(tag: string, prefix: string): string | null {
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : null;
}

/** Semantic-version order, which puts a final release after its own pre-releases; tags that are not versions fall back to text order. */
function byVersion(prefix: string) {
  return (left: OwedRelease, right: OwedRelease): number => {
    const order = attempt("unreadable", "unreadable", () => {
      const [a, b] = [
        versionOf(left.tag, prefix),
        versionOf(right.tag, prefix),
      ];
      return a === null || b === null ? 0 : Bun.semver.order(a, b);
    });
    const ordered = order.ok ? order.value : 0;
    return ordered !== 0
      ? ordered
      : left.tag.localeCompare(right.tag, "en", { numeric: true });
  };
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

function owedReason(tags: readonly string[], evidence: Evidence): string {
  const [only] = tags;
  const owed =
    tags.length === 1 && only !== undefined
      ? `Release ${only} is owed its tag.`
      : `${tags.length} releases are owed their tags: ${tags.join(", ")}.`;
  const { noRerun } = evidence;
  if (typeof noRerun === "string" && noRerun !== "")
    return `${owed} ${noRerun}`;
  return evidence.rerunSpent === true
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

/** The evidence of `remedy` beyond the versions: whether the re-run was spent, or why none is left. */
function remedyEvidence(
  remedy: Remedy,
  group: readonly OwedRelease[],
  policy: ReleasePolicy,
): Evidence {
  if (remedy === "tag") return { noRerun: noRerunWhy(group, policy) };
  return remedy === "spent" ? { rerunSpent: true } : {};
}

function loneAction(
  release: OwedRelease,
  remedy: Remedy,
  policy: ReleasePolicy,
): Action {
  const { tag, item } = release;
  const evidence = { tag, ...remedyEvidence(remedy, [release], policy) };
  return needAction(item, owedReason([tag], evidence), evidence);
}

function groupAction(
  group: readonly OwedRelease[],
  newest: OwedRelease,
  remedy: Remedy,
  policy: ReleasePolicy,
): Action {
  const tags = group.map(({ tag }) => tag);
  const evidence: Evidence = {
    tags: tags.join(" "),
    items: group.map(({ item }) => item).join(" "),
    rerunSpent: remedy === "spent",
    ...(remedy === "tag" ? remedyEvidence(remedy, group, policy) : {}),
    title: owedTitle(tags.length),
  };
  return needAction(newest.item, owedReason(tags, evidence), evidence);
}

/** Whether the need is of releases a person took, held off the line by their answer. */
export function isTakenNeed(evidence: Evidence): boolean {
  return words(evidence, "open").length > 0;
}

/** How `action`'s decision is kept on the releases a person takes under it. */
export function takenDecision(action: Action): string {
  const { tag, tags, items, rerunSpent, noRerun } = action.evidence;
  const why = typeof noRerun === "string" ? { noRerun } : {};
  const evidence: Evidence =
    typeof tag === "string"
      ? { tag, ...(rerunSpent === true ? { rerunSpent } : {}), ...why }
      : {
          tags: tags ?? null,
          items: items ?? null,
          rerunSpent: rerunSpent ?? false,
          ...why,
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

/** Whether `target` and `evidence` are one `takenDecision` writes: a canonical tracker item, and a lone release's tag or a group's tags and items. */
function isTakenShape(target: unknown, evidence: Evidence): boolean {
  if (!isString(target) || shapeOfKey(target) === null) return false;
  if (typeof evidence.tag === "string") return evidence.tag !== "";
  return (
    groupTags(evidence).length > 0 &&
    groupItems(evidence).length === groupTags(evidence).length &&
    groupItems(evidence).every((item) => shapeOfKey(item) !== null)
  );
}

function readTaken(kept: string): TakenDecision | null {
  const read = attempt("unreadable", "unreadable", (): unknown =>
    JSON.parse(kept),
  );
  if (!read.ok || !isRecord(read.value)) return null;
  const { target, evidence } = read.value;
  return isString(target) &&
    isEvidence(evidence) &&
    isTakenShape(target, evidence)
    ? { target, evidence }
    : null;
}

/** The need of the releases a person took under one decision, which that person's answer holds off the line. */
function takenAction(
  decision: TakenDecision,
  releases: readonly OwedRelease[],
): Action {
  const tags = releases.map(({ tag }) => tag);
  const { target, evidence } = decision;
  const grouped = groupTags(evidence).length > 0;
  return needAction(target, owedReason(tags, evidence), {
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

/** The needs of `owed`, ordered by the version after `tagPrefix`: one for each remedy its open releases share under `policy`, and one for each decision a person took some under. */
export function releaseActions(
  owed: readonly OwedRelease[],
  tagPrefix: string,
  policy: ReleasePolicy = DEFAULT_RELEASE_POLICY,
): Action[] {
  const sorted = [...owed].sort(byVersion(tagPrefix));
  const { actions, unread } = takenActions(sorted);
  const open = sorted.filter(
    (release) => release.taken_as === null || unread.includes(release),
  );
  const remedies: readonly Remedy[] = ["gates", "spent", "tag"];
  const grouped = remedies.flatMap((remedy) => {
    const group = open.filter((r) => remedyOf(r, policy) === remedy);
    const newest = group.at(-1);
    if (newest === undefined) return [];
    return [
      group.length === 1
        ? loneAction(newest, remedy, policy)
        : groupAction(group, newest, remedy, policy),
    ];
  });
  return [...grouped, ...actions];
}
