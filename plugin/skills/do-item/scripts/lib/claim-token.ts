/**
 * The claim marker as the claim's token across hosts
 * (`do_item.claim_marker`). The claim lock (`claim-lock.ts`) serializes the
 * claims of one machine; two hosts serving one person, or picking from one
 * pool, claim the same item with the same identity, so their tracker writes
 * are identical and the claim's re-read cannot tell them apart. The marker
 * can: each claim posts its own, and of the markers on one item the earliest
 * wins.
 *
 * A claim posts its marker before it writes the item's assignee or state,
 * and reads the item's markers back. When an earlier live marker is there it
 * withdraws its own and refuses, with nothing written to the item; when its
 * own post or read-back fails it refuses the same way. After the claim
 * writes, it reads the markers again and stands down when an earlier one has
 * appeared since. A claim that refuses or stands down for any reason
 * withdraws its marker, so a later claim does not meet it.
 *
 * "Earliest" is the tracker's own order of an item's comments
 * (`issueComments`), which every reader lists alike; only trusted comments
 * count, as for every marker the tracker holds. A marker is live while it was
 * posted within `CLAIM_LAPSE_MS` before this claim's own, by the tracker's
 * clock, so the marker of a claim made long ago, or one a crashed claim never
 * withdrew, holds the item for that long at most.
 *
 * What this cannot close: the tracker offers no conditional create for a
 * comment, and a listing can lag behind a post. Two claims whose read-backs
 * each lag past the other's marker both read themselves the earliest; the
 * re-read after the write narrows that window to the claims' own length,
 * and the earlier marker still wins at the first read that lists both.
 */
import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../../../../shared/clock.ts";
import type { ClaimResult } from "./claim.ts";
import {
  type ClaimMarkerFacts,
  claimMarkerBody,
  readClaimMarker,
} from "./claim-marker.ts";
import type { Tracker } from "./tracker/port.ts";

/**
 * How long a marker holds the item against a later claim. A claim takes
 * seconds, so a marker older than this is a claim long settled (its item is
 * then in progress, which the claim refuses on its own) or one a crashed
 * claim never withdrew, which should not hold the item for longer.
 */
export const CLAIM_LAPSE_MS = 10 * 60_000;
/** How often, and how long apart, a read-back reads again while it does not show the claim's own marker. */
const READ_BACKS = 3;
const READ_BACK_DELAY_MS = 2_000;

export type TokenTracker = Pick<
  Tracker,
  "issueComments" | "postComment" | "deleteComment"
>;

/** What the marker names, beside the time and the attempt this module fills in. */
export type MarkerFacts = Pick<
  ClaimMarkerFacts,
  "session" | "branch" | "claimant"
>;

/** What the claim's JSON says of the marker. */
export type MarkerReport = { posted: true; confirmed: true } | {
  posted: true;
  /** The read after the write failed: the read before it, which this claim won, stands. */
  confirmed: false;
  reason: string;
};

interface Marker {
  id: string | undefined;
  attempt: string | undefined;
  createdAt: number;
}

/** The trusted claim markers on the item, in the tracker's order. */
async function markers(tracker: TokenTracker, key: string): Promise<Marker[]> {
  const { comments } = await tracker.issueComments(key);
  return comments.flatMap((c) => {
    if (!c.trusted) return [];
    const read = readClaimMarker(c.body);
    return read === null
      ? []
      : [
          {
            id: c.id,
            attempt: read.attempt,
            createdAt: Date.parse(c.createdAt),
          },
        ];
  });
}

/** The earliest live marker before `attempt`'s own; `null` when it is the earliest. */
function earlier(list: Marker[], attempt: string): Marker | null | "missing" {
  const at = list.findIndex((m) => m.attempt === attempt);
  if (at < 0) return "missing";
  const since = (list[at] as Marker).createdAt - CLAIM_LAPSE_MS;
  return list.slice(0, at).find((m) => m.createdAt >= since) ?? null;
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Take the item's token, run `claim`, and confirm the token afterwards. The
 * claim's own result passes through, beside the marker's report, unless the
 * token refuses it first or stands it down after.
 */
export async function claimWithMarker(
  tracker: TokenTracker,
  key: string,
  facts: MarkerFacts,
  claim: () => Promise<ClaimResult>,
  clock: Clock = systemClock,
): Promise<ClaimResult & { marker?: MarkerReport }> {
  const attempt = randomUUID();
  const refused = (reason: string): ClaimResult => ({
    outcome: "refused",
    issue: key,
    why: "marker",
    reason,
  });
  /** Delete this attempt's own marker, if it is there; a failure leaves it to lapse. */
  const withdraw = async (seen?: Marker[]) => {
    try {
      const own = (seen ?? (await markers(tracker, key))).find(
        (m) => m.attempt === attempt,
      );
      if (own?.id !== undefined) await tracker.deleteComment(key, own.id);
    } catch (error) {
      console.error(
        `the claim marker on ${key} was not withdrawn, and lapses in ${CLAIM_LAPSE_MS / 60_000} minutes: ${reasonOf(error)}`,
      );
    }
  };

  try {
    await tracker.postComment(
      key,
      claimMarkerBody({
        ...facts,
        attempt,
        at: new Date(clock.now()).toISOString(),
      }),
    );
  } catch (error) {
    // The post may have landed although its answer was lost.
    await withdraw();
    return refused(
      `the claim marker could not be posted on ${key}, so the claim was not made: ${reasonOf(error)}`,
    );
  }

  let first: Marker[] = [];
  let found: Marker | null | "missing" = "missing";
  try {
    for (let read = 1; ; read++) {
      first = await markers(tracker, key);
      found = earlier(first, attempt);
      if (found !== "missing" || read >= READ_BACKS) break;
      await clock.sleep(READ_BACK_DELAY_MS);
    }
  } catch (error) {
    await withdraw();
    return refused(
      `the claim marker on ${key} could not be read back, so the claim was not made: ${reasonOf(error)}`,
    );
  }
  if (found === "missing")
    return refused(
      `the claim marker posted on ${key} did not show among its trusted comments when it was read back, so the claim was not made`,
    );
  if (found !== null) {
    await withdraw(first);
    return refused(
      `another claim's marker on ${key} is earlier: another session holds it`,
    );
  }

  const result = await claim();
  if (result.outcome !== "claimed") {
    await withdraw();
    return result;
  }

  let after: Marker[];
  try {
    after = await markers(tracker, key);
  } catch (error) {
    return {
      ...result,
      marker: { posted: true, confirmed: false, reason: reasonOf(error) },
    };
  }
  const now = earlier(after, attempt);
  if (now !== null) {
    await withdraw(after);
    return {
      outcome: "stood_down",
      issue: key,
      reason:
        now === "missing"
          ? `this claim's marker on ${key} is gone: another session may hold it; queue must refresh`
          : `another claim's marker on ${key} is earlier: another session holds it; queue must refresh`,
    };
  }
  return { ...result, marker: { posted: true, confirmed: true } };
}
