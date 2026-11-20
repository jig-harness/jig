import { ready, closed } from "./served-pull.ts";
/** Queue facts expanded into the next nodes a served or factory walk visits. */
import type { PoolIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { sharedView, type ServedView } from "./served-reads.ts";
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import type { ServedOptions } from "./served.ts";
import type { pullBlockers } from "./served-pull.ts";

/** A served item in progress, as the claim dispatch monitors. */
export function servedClaim(i: PoolIssue) {
  return {
    key: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state.name,
    ...(i.nativeType === undefined ? {} : { nativeType: i.nativeType }),
    served: true as const,
  };
}

/** Assigned work and active epics are roots even when the epic itself has not started. */
export function personRoots(
  view: ServedView,
  identity: string,
  factory: { identity: string; roots: PoolIssue[] } | undefined,
  progress: PoolIssue[],
): PoolIssue[] {
  const assigned =
    factory?.identity === identity
      ? factory.roots
      : view.open().map((held) => held.issue);
  return [
    ...assigned,
    ...progress.filter((issue) => issue.isEpic && issue.hasOpenChildren),
  ];
}

/** A queue's already-read relations are reused by the metadata and blocker reads. */
export function carriedRelations(view: ServedView, key: string) {
  return view.held(key)?.relations ?? null;
}

/** A blocker already visited contributes no second node to the next generation. */
export function pulledNodes(
  pull: ReturnType<typeof pullBlockers>,
  seen: ReadonlySet<string>,
  by: string,
) {
  return pull.pulled
    .filter((issue) => !seen.has(issue.identifier))
    .map((issue) => ({
      issue,
      ancestor: pull.origin.rootAncestor,
      ancestors: pull.origin.rootAncestors,
      by,
      epicOrder: undefined,
      planHold: undefined,
      pull: pull.origin,
    }));
}

/** Factory roots carry the bounded reading already made before the walk. */
export function personView(
  tracker: Tracker,
  identity: string,
  options: ServedOptions,
  cache: PickupReads,
): Promise<ServedView> {
  const factory = options.factory;
  if (factory?.identity === identity && factory.view !== undefined)
    return Promise.resolve(factory.view);
  return sharedView(options.views, tracker, identity, options, cache);
}

/** Direct factory roots retain the states the bounded assignment read admitted. */
export function readyForWalk(
  issue: PoolIssue,
  tracker: Pick<Tracker, "stateName">,
  options: ServedOptions,
): boolean {
  const blocked = tracker.stateName("blocked", issue.nativeType ?? null);
  if (ready(issue, blocked)) return true;
  if (closed(issue) || isBlocked(issue, blocked)) return false;
  return options.factory?.eligible?.has(issue.identifier) === true;
}

function isBlocked(issue: PoolIssue, blocked: string | null): boolean {
  return (
    blocked !== null &&
    issue.state.name.trim().toLowerCase() === blocked.trim().toLowerCase()
  );
}
