/**
 * The checks every adapter runs on a filing or planning request before it
 * sends anything, so each refuses the same input with the same message.
 */

import {
  type IssuePatch,
  type PoolQuery,
  RELATION_TYPES,
  type RelationType,
  TrackerRequestError,
  type WindowSpec,
} from "./port.ts";

/** Refuse a priority outside the port's scale before any request. */
export function checkPriority(priority: number | undefined): void {
  if (
    priority !== undefined &&
    (!Number.isInteger(priority) || priority < 0 || priority > 4)
  )
    throw new TrackerRequestError(
      "invalid",
      `priority must be an integer from 0 (none) to 4 (low), not ${JSON.stringify(priority)}`,
    );
}

export function requireTitle(title: string | undefined): void {
  if (title !== undefined && title.trim() === "")
    throw new TrackerRequestError(
      "invalid",
      "an issue needs a non-empty title",
    );
}

/** Refuse a patch that changes nothing or both adds and removes a label. */
export function checkPatch(key: string, patch: IssuePatch): void {
  const add = patch.addLabels ?? [];
  const remove = patch.removeLabels ?? [];
  const fields = (
    ["title", "description", "priority", "parent", "project"] as const
  ).filter((f) => patch[f] !== undefined);
  if (fields.length === 0 && add.length === 0 && remove.length === 0)
    throw new TrackerRequestError(
      "invalid",
      `the patch for ${key} changes nothing`,
    );
  requireTitle(patch.title);
  checkPriority(patch.priority);
  const both = add.filter((l) => remove.includes(l));
  if (both.length > 0)
    throw new TrackerRequestError(
      "invalid",
      `the patch for ${key} both adds and removes ${both.map((l) => `'${l}'`).join(", ")}`,
    );
}

/** Refuse an unknown relation type, or an issue related to itself. */
export function checkRelation(
  key: string,
  type: RelationType,
  target: string,
): void {
  if (!(RELATION_TYPES as readonly string[]).includes(type))
    throw new TrackerRequestError(
      "invalid",
      `'${type}' is not a relation type (${RELATION_TYPES.join(", ")})`,
    );
  if (key === target)
    throw new TrackerRequestError(
      "invalid",
      `an issue cannot be related to itself: ${key}`,
    );
}

/** Refuse empty search text, which would read every issue. */
export function checkSearchText(text: string): void {
  if (text.trim() === "")
    throw new TrackerRequestError(
      "invalid",
      "a search needs non-empty text; empty text would read every issue",
    );
}

/** Refuse a pool query with no label list or an empty one. */
export function checkPoolQuery(query: PoolQuery): void {
  if (
    query.withSomeOf.length === 0 ||
    query.withSomeOf.some((l) => l.length === 0)
  )
    throw new TrackerRequestError(
      "invalid",
      "a pool query needs at least one non-empty label list; an empty one would read every open issue",
    );
}

/** Refuse a relation whose two keys name one issue (`key` is `canonical`). */
export function refuseSameIssue(
  ids: [string, string],
  key: string,
  target: string,
  canonical: string,
): void {
  if (ids[0] === ids[1])
    throw new TrackerRequestError(
      "invalid",
      `an issue cannot be related to itself: ${key} and ${target} are ${canonical}`,
    );
}

/** Whether `at` lies in the half-open window; no window holds every time. */
export function inWindow(
  at: string | null,
  w: WindowSpec | undefined,
): boolean {
  if (w === undefined) return true;
  if (at === null) return false;
  const ms = Date.parse(at);
  return ms >= w.sinceMs && ms < w.untilMs;
}
