/** The walk's native facts are shared; interpreted child facets stay local to the repository. */
import { cacheByVersion } from "../../../shared/outbound/cache.ts";
import type {
  Assigner,
  IssueRelation,
  PoolIssue,
  QueueRelation,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { trackerStateMaps } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { AssignerUnknown } from "../../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { failureText } from "../text.ts";
import { trackerScope, type ServedView } from "./served-reads.ts";
import { closed } from "./served-pull.ts";

export interface Metadata {
  updatedAt: string;
  by: Assigner | null;
  /** Why no user made the assignment, as the history read in full answered: kept like the rest until the item changes. */
  noAssigner?: string;
  relations: IssueRelation[];
  children: PoolIssue[];
  description: string | null;
}
/** Who made the assignment, or the history's definite answer that no user did; a failed read throws. */
async function assigner(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  view: ServedView,
): Promise<Pick<Metadata, "by" | "noAssigner">> {
  if (issue.assignee === null) return { by: null };
  try {
    return {
      by: await view.once(
        `assignment ${issue.identifier} ${identity} ${issue.updatedAt ?? ""}`,
        () => tracker.assignedBy(issue.identifier, identity),
      ),
    };
  } catch (error) {
    if (!(error instanceof AssignerUnknown)) throw error;
    return { by: null, noAssigner: failureText(error) };
  }
}

/** Child native rows are read once; each repository interprets them itself. */
async function childrenOf(
  tracker: Tracker,
  issue: PoolIssue,
  view: ServedView,
  assigned: Pick<Metadata, "by" | "noAssigner">,
): Promise<PoolIssue[]> {
  if (
    assigned.noAssigner !== undefined ||
    !issue.isEpic ||
    !issue.hasOpenChildren
  )
    return [];
  const source = tracker.dispatchSource;
  if (source === undefined)
    return view.once(`children ${issue.identifier}`, () =>
      tracker.openChildren(issue.identifier),
    );
  const rows = await view.once(`native children ${issue.identifier}`, (bound) =>
    source.children(issue.identifier, bound),
  );
  return (
    await Promise.all(rows.map((raw) => source.project(raw, view.bound)))
  ).filter((child) => !closed(child));
}

/** Relations already carried by a queue supersede the kept metadata. */
const relationsOf = (carried: QueueRelation[]) =>
  carried.map(({ type, issue }) => ({ type, issue }));

async function issueRelations(
  tracker: Tracker,
  issue: PoolIssue,
  view: ServedView,
): Promise<IssueRelation[]> {
  const source = tracker.dispatchSource;
  if (source?.projectRelations !== undefined && view.raw !== undefined) {
    const row = await view.raw(issue.identifier);
    if (row !== null) return source.projectRelations(row, view.bound);
  }
  return view.once(
    `relations ${issue.identifier} ${tracker.readinessKey ?? ""}`,
    () => tracker.listRelations(issue.identifier),
  );
}

/** Membership has a separate version: a moved child need not update its former parent. */
async function membership(
  tracker: Tracker,
  issue: PoolIssue,
  view: ServedView,
  assigned: Pick<Metadata, "by" | "noAssigner">,
): Promise<Pick<Metadata, "children" | "description">> {
  const children = await childrenOf(tracker, issue, view, assigned);
  const description =
    children.length > 0
      ? await view.once(
          `description ${issue.identifier}`,
          async () =>
            (await tracker.getIssue(issue.identifier))?.description ?? null,
        )
      : "";
  return { children, description };
}

/** Cache entries without a timestamp are never reused. */
export async function metadata(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string,
  cache: PickupReads,
  carried: QueueRelation[] | null,
  view: ServedView,
): Promise<Metadata> {
  const credential = (await tracker.dispatchSource?.credential()) ?? "";
  const interpretation = JSON.stringify([
    tracker.configKey ?? "",
    tracker.readinessKey ?? "",
    trackerStateMaps(tracker),
  ]);
  const key = `${trackerScope(tracker)}:${credential}:${interpretation}:item:${issue.identifier}:${identity}:${issue.isEpic ? "epic" : ""}`;
  const nativeGitHub =
    tracker.adapter === "github" && tracker.dispatchSource !== undefined;
  const kept = await cacheByVersion<Metadata>(
    cache,
    `versioned:${key}`,
    // GitHub does not timestamp every relation or membership edit. Changed
    // keys and scheduled full readings also invalidate these facts.
    issue.updatedAt && nativeGitHub
      ? `${issue.updatedAt}:${view.metadataEpoch?.(issue.identifier) ?? view.readAt}`
      : issue.updatedAt,
    async () => {
      const assigned = await assigner(tracker, issue, identity, view);
      // An item no user assigned is not placed, so its relations are not read.
      const relations =
        carried !== null
          ? relationsOf(carried)
          : assigned.noAssigner === undefined
            ? await issueRelations(tracker, issue, view)
            : [];
      const value = {
        updatedAt: issue.updatedAt ?? "",
        ...assigned,
        relations,
        ...(nativeGitHub
          ? { children: [], description: "" }
          : await membership(tracker, issue, view, assigned)),
      };
      return value;
    },
    (value) => value.description !== null,
  );
  const value = nativeGitHub
    ? {
        ...kept,
        ...(await cacheByVersion(
          cache,
          `membership:${key}`,
          issue.updatedAt
            ? `${issue.updatedAt}:${view.membershipEpoch?.() ?? view.readAt}`
            : undefined,
          () => membership(tracker, issue, view, kept),
          (value) => value.description !== null,
        )),
      }
    : kept;
  return carried === null
    ? value
    : { ...value, relations: relationsOf(carried) };
}
