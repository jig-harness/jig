/**
 * A wanted item with no priority, assigned or from the ready pool, is
 * unranked, not the least urgent: the
 * queue would place it after every low-priority item, an order nobody chose.
 * Under `dispatch.missing_priority: hold`, the default, it is not started:
 * the line lists it with what it lacks until a person sets its priority, or
 * the steward's `facet` record fills it (the steward's queue still holds the
 * item, where it is assigned), and the next tick ranks it. A blocker pulled
 * forward starts for the item it blocks, which carries the rank. An item
 * whose priority was not read, or whose tracker holds a priority the
 * configuration maps to none of Jig's (`unmappedFacets`), is not held for it:
 * someone did rank it.
 */
import type { DispatchSection, Unplaced, WantedItem } from "./types.ts";

/** What a person does about an item held for its missing priority. */
export const NEEDS_PRIORITY =
  "no priority, so it has no place in the queue and is not started: set its priority on the item, and the next tick ranks it (dispatch.missing_priority)";

/** The labelling gap that holds the item back, or `null` when it may start. */
export function unrankedHold(
  item: WantedItem,
  section: Pick<DispatchSection, "missingPriority">,
): Unplaced | null {
  if ((section.missingPriority ?? "hold") !== "hold") return null;
  const issue = item.queueIssue;
  if (
    item.blockingFor !== undefined ||
    issue?.priority !== 0 ||
    issue.unmappedFacets?.includes("priority")
  )
    return null;
  return {
    target: item.key,
    record: "tracker",
    reason: NEEDS_PRIORITY,
    title: item.title,
    url: item.url,
  };
}
