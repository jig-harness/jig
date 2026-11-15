/**
 * The claim markers on the identity's claimed items, for the stall watch's
 * `dispatch.stalled_scope: claimed`: an item a `do-item` claim took carries
 * one (`do_item.claim_marker`), so the watch reads it as a pickup even with
 * no launch record of this host. Each item's answer is kept by its update
 * time, since a new comment changes that time: an unchanged item is not read
 * again.
 */
import { readClaimMarker } from "../../../skills/do-item/scripts/lib/claim-marker.ts";
import { isRateLimited } from "../../../shared/outbound/budget.ts";
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { failureText } from "../text.ts";
import {
  CUT_AT_BOUND,
  ended,
  passedBefore,
  type TickBound,
  within,
} from "./bounded.ts";
import { readFailureOfError } from "../read-failures.ts";
import type { ClaimedItem, ReadFailure, Unplaced } from "../types.ts";
import { trackerScope } from "./served-reads.ts";

/** Whether a trusted claim marker naming `identity` is on `key`. */
async function marked(
  tracker: Pick<Tracker, "issueComments">,
  key: string,
  identity: string,
): Promise<boolean> {
  const { comments } = await tracker.issueComments(key);
  return comments.some(
    (c) => c.trusted && readClaimMarker(c.body)?.claimant === identity,
  );
}

/** One item's mark from the cache, kept by its update time; `undefined` when the cache has no answer for that time. */
function keptMark(
  cache: PickupReads,
  key: string,
  item: ClaimedItem,
): boolean | undefined {
  if (item.updatedAt === undefined) return undefined;
  const kept = cache.get<{ updatedAt: string; marked: boolean }>(key);
  return kept?.updatedAt === item.updatedAt ? kept.marked : undefined;
}

/** One claimed item's marker read, kept under `key` when it succeeds; the error when it fails. */
async function readMark(
  tracker: Tracker,
  identity: string,
  item: ClaimedItem,
  key: string,
  cache: PickupReads,
  tick?: TickBound,
): Promise<{ found: boolean } | { error: unknown }> {
  try {
    const asked = marked(tracker, item.key, identity);
    const found = await (tick === undefined ? asked : within(asked, tick));
    if (item.updatedAt !== undefined)
      cache.set(key, { updatedAt: item.updatedAt, marked: found });
    return { found };
  } catch (error) {
    return { error };
  }
}

/**
 * The claimed items, each one a trusted claim marker naming `identity` is on marked `found`,
 * and each whose comments could not be read marked `unread` with a row
 * saying so. After the tracker's rate limit, the rest are not read and are
 * `unread` too, as are those `tick`, the tick's bound, ended before.
 */
export async function markClaims(
  tracker: Tracker,
  identity: string,
  items: ClaimedItem[],
  cache: PickupReads,
  tick?: TickBound,
): Promise<{ claimed: ClaimedItem[]; unplaced: Unplaced[] }> {
  const unplaced: Unplaced[] = [];
  const claimed: ClaimedItem[] = [];
  const mark = (item: ClaimedItem, found: boolean) =>
    claimed.push(found ? { ...item, claimMarker: "found" } : item);
  // A request that failed, or that the tick's bound ended before, is a
  // failed read, with the failed call's class where it has one; the
  // tracker's rate limit is a deferral.
  const unread = (
    item: ClaimedItem,
    why: string,
    failed: boolean,
    cause?: ReadFailure,
  ) => {
    claimed.push({ ...item, claimMarker: "unread" });
    unplaced.push({
      target: item.key,
      record: "tracker",
      reason: `whether a claim marker took it could not be read, so its stall watch waits for a read: ${why}`,
      ...(failed
        ? {
            readFailed: true as const,
            ...(cause === undefined ? {} : { failure: cause }),
          }
        : {}),
    });
  };
  let limited = false;
  for (const item of items) {
    const key = `${trackerScope(tracker)}:claim-marker:${identity}:${item.key}`;
    const kept = keptMark(cache, key, item);
    if (kept !== undefined) mark(item, kept);
    else if (limited)
      unread(item, "the tracker's rate limit stopped an earlier read", false);
    else if (ended(tick))
      unread(item, passedBefore("its comments were read"), true, CUT_AT_BOUND);
    else {
      const read = await readMark(tracker, identity, item, key, cache, tick);
      if ("found" in read) mark(item, read.found);
      else {
        limited = isRateLimited(read.error);
        unread(
          item,
          failureText(read.error),
          !limited,
          readFailureOfError(read.error) ??
            (ended(tick) ? CUT_AT_BOUND : undefined),
        );
      }
    }
  }
  return { claimed, unplaced };
}
