/**
 * The checks every adapter runs on a filing or planning request before it
 * sends anything, so each refuses the same input with the same message.
 */

import {
  type IssuePatch,
  RELATION_TYPES,
  type RelationType,
  TrackerRequestError,
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
