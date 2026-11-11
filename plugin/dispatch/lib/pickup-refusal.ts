/**
 * A pickup the repository's start rules refused (`do_item.preflight_command`):
 * the reason its claim printed and the item's `updatedAt` the rules saw,
 * kept in the launch record's `refusal` column beside its `failed` result.
 * The tick holds the item until its `updatedAt` moves past that time
 * (`actions/pickup-hold.ts`).
 *
 * A batch pickup names the members the rules refused, each with its own
 * `updatedAt` and reason (`members`): only those are held, each until its
 * own `updatedAt` moves, and the rest of the batch stays eligible. A record
 * without `members` holds every item of its pickup on the one time. The
 * top-level `reason` and `updatedAt` are the first member's, so a reader
 * that knows no `members` holds the whole batch on that time.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { swallow } from "../../shared/errors.ts";

/** One batch member the start rules refused. */
export interface RefusedMember {
  key: string;
  reason: string;
  updatedAt: string;
}

export interface PickupRefusal {
  reason: string;
  updatedAt: string;
  /** The members refused, when the pass named them; absent on a record that names none. */
  members?: RefusedMember[];
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A row's refused members; `undefined` when it names none, `null` when the list does not read. */
function readMembers(value: unknown): RefusedMember[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  const members: RefusedMember[] = [];
  for (const m of value) {
    if (
      !isMapping(m) ||
      typeof m.key !== "string" ||
      typeof m.reason !== "string" ||
      !isTime(m.updatedAt)
    )
      return null;
    members.push({ key: m.key, reason: m.reason, updatedAt: m.updatedAt });
  }
  return members;
}

/** A row's refusal; `null` when none, or when it does not read. */
export function readRefusal(
  value: string | null | undefined,
): PickupRefusal | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    swallow(error, "a pickup's refusal that does not read is left unknown");
    return null;
  }
  if (
    !isMapping(parsed) ||
    typeof parsed.reason !== "string" ||
    !isTime(parsed.updatedAt)
  )
    return null;
  const members = readMembers(parsed.members);
  if (members === null) return null;
  return {
    reason: parsed.reason,
    updatedAt: parsed.updatedAt,
    ...(members === undefined ? {} : { members }),
  };
}

/**
 * What the refusal says about `item`: the time and reason it is held on, or
 * `null` when the pass named the members it refused and `item` is not one.
 */
export function refusalOf(
  refusal: PickupRefusal,
  item: string,
): { reason: string; updatedAt: string } | null {
  if (refusal.members === undefined) return refusal;
  return refusal.members.find((m) => m.key === item) ?? null;
}
