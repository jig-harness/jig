/**
 * The claim marker as the claim's token across hosts
 * (`do_item.claim_marker`). The claim lock (`claim-lock.ts`) serializes the
 * claims of one machine; two hosts serving one person, or picking from one
 * pool, claim the same item with the same identity, so their tracker writes
 * are identical and the claim's re-read cannot tell them apart. The marker
 * can: each claim posts its own, and of the markers on one item the earliest
 * that still holds wins.
 *
 * A claim posts its marker before it writes the item's assignee or state,
 * and reads the item's markers back. When an earlier holding marker is there
 * it withdraws its own and refuses, with nothing written to the item; when
 * its own post or read-back fails it refuses the same way. After the claim
 * writes, it reads the markers again.
 *
 * Every attempt records how it ended in an outcome record beside its marker
 * (`claim-marker.ts`): `claimed` once it holds the item, `released` before it
 * withdraws its marker on a refusal or a stand-down, `unresolved` when it
 * stood down without knowing who holds the item. A marker whose attempt
 * recorded `released` or `unresolved` holds nothing, even while a lagging
 * listing still shows it.
 *
 * Recovery after the write. A claim whose re-read after the write shows an
 * earlier holding marker, or no longer shows its own, has already assigned
 * and started the item, with writes no other attempt of the same identity
 * can tell from its own. It never undoes them: they may be a successful
 * worker's, and a person's or another actor's later change to the item is
 * never touched. Instead it settles which attempt owns the item, from the
 * outcome records alone, reading again for a bounded time:
 *
 * - an earlier attempt recorded `claimed`: that attempt is the worker, and
 *   this one releases its marker and stands down (`held`);
 * - its own marker still lists, and every earlier attempt it saw recorded
 *   `released` or `unresolved`: none holds the item, so this attempt does,
 *   and records `claimed` (`reclaimed`);
 * - otherwise, when the reads run out, or one fails: the evidence cannot
 *   establish ownership, so it stands down `unresolved`, records that, and
 *   leaves the item as it is for a person.
 *
 * Ownership is never inferred from a marker's absence: a marker that
 * vanished without an outcome may be a crashed attempt's or one a person
 * removed, so it keeps the question open until the reads run out. The same
 * holds for this attempt's own marker: a listing that no longer shows it may
 * miss an earlier one too, so it never reclaims until its own lists again.
 * An attempt's first recorded outcome is the one that counts.
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
  type ClaimOutcome,
  claimMarkerBody,
  claimOutcomeBody,
  readClaimMarker,
  readClaimOutcome,
} from "./claim-marker.ts";
import type { Tracker } from "./tracker/port.ts";
import { isoFromMs, parseMs } from "../../../../shared/time.ts";

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
/**
 * How often, and how long apart, a claim that stood down after its write
 * reads the outcome records again before it calls its ownership unresolved:
 * long enough for an earlier attempt, which takes seconds, to record how it
 * ended.
 */
export const RECOVERY_READS = 20;
const RECOVERY_DELAY_MS = 3_000;

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
export type MarkerReport =
  | { posted: true; confirmed: true }
  | {
      posted: true;
      /** The read after the write failed: the read before it, which this claim won, stands. */
      confirmed: false;
      reason: string;
    };

/**
 * How a claim that met an earlier marker, or lost its own, after its write
 * settled who owns the item: `reclaimed`, this attempt (it is claimed);
 * `held`, an earlier attempt that recorded `claimed`; `unresolved`, nobody
 * the evidence names, left for a person.
 */
export type Recovery = "reclaimed" | "held" | "unresolved";

export type TokenResult = ClaimResult & {
  marker?: MarkerReport;
  recovery?: Recovery;
};

interface Marker {
  id: string | undefined;
  /** The attempt it stands for; for a marker that names none, its comment id, which no outcome ever names. */
  attempt: string;
  createdAt: number;
}

/** One listing of the item's trusted claim markers and outcome records. */
interface View {
  markers: Marker[];
  outcomes: Map<string, ClaimOutcome>;
}

/** The trusted claim markers on the item, in the tracker's order, and each attempt's first outcome. */
async function view(tracker: TokenTracker, key: string): Promise<View> {
  const { comments } = await tracker.issueComments(key);
  const markers: Marker[] = [];
  const outcomes = new Map<string, ClaimOutcome>();
  for (const c of comments) {
    if (!c.trusted) continue;
    const outcome = readClaimOutcome(c.body);
    if (outcome !== null) {
      if (!outcomes.has(outcome.attempt))
        outcomes.set(outcome.attempt, outcome.outcome);
      continue;
    }
    const read = readClaimMarker(c.body);
    if (read !== null)
      markers.push({
        id: c.id,
        attempt: read.attempt ?? `comment:${c.id ?? markers.length}`,
        createdAt: parseMs(c.createdAt),
      });
  }
  return { markers, outcomes };
}

/** An attempt that recorded it holds nothing. */
const released = (v: View, attempt: string) => {
  const o = v.outcomes.get(attempt);
  return o === "released" || o === "unresolved";
};

/** The live markers before `attempt`'s own that still hold; empty when it is the earliest. */
function earlier(v: View, attempt: string): Marker[] | "missing" {
  const at = v.markers.findIndex((m) => m.attempt === attempt);
  if (at < 0) return "missing";
  const since = (v.markers[at] as Marker).createdAt - CLAIM_LAPSE_MS;
  return v.markers
    .slice(0, at)
    .filter((m) => m.createdAt >= since && !released(v, m.attempt));
}

/**
 * With `attempt`'s own marker gone from the listing, the live markers that
 * still hold and may have been posted before it, by the time its marker
 * carried when it was last seen; one of the same time may be earlier.
 */
function postedBefore(v: View, attempt: string, ownAt: number): Marker[] {
  return v.markers.filter(
    (m) =>
      m.attempt !== attempt &&
      m.createdAt <= ownAt &&
      m.createdAt >= ownAt - CLAIM_LAPSE_MS &&
      !released(v, m.attempt),
  );
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
): Promise<TokenResult> {
  const attempt = randomUUID();
  const refused = (reason: string): ClaimResult => ({
    outcome: "refused",
    issue: key,
    why: "marker",
    reason,
  });
  /** Record how this attempt ended; a failure is reported, and the claim's result stands. */
  const record = async (outcome: ClaimOutcome, reason?: string) => {
    try {
      await tracker.postComment(
        key,
        claimOutcomeBody({
          attempt,
          outcome,
          ...(reason === undefined ? {} : { reason }),
          at: isoFromMs(clock.now()),
        }),
      );
    } catch (error) {
      console.error(
        `the claim outcome (${outcome}) on ${key} was not recorded: ${reasonOf(error)}`,
      );
    }
  };
  /** Record how this attempt ended, then delete its own marker, if it is there; a failure leaves it to lapse. */
  const withdraw = async (
    reason: string,
    seen?: View,
    outcome: ClaimOutcome = "released",
  ) => {
    await record(outcome, reason);
    try {
      const own = (seen ?? (await view(tracker, key))).markers.find(
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
        at: isoFromMs(clock.now()),
      }),
    );
  } catch (error) {
    // The post may have landed although its answer was lost.
    const reason = `the claim marker could not be posted on ${key}, so the claim was not made: ${reasonOf(error)}`;
    await withdraw(reason);
    return refused(reason);
  }

  let first: View = { markers: [], outcomes: new Map() };
  let found: Marker[] | "missing" = "missing";
  try {
    for (let read = 1; ; read++) {
      first = await view(tracker, key);
      found = earlier(first, attempt);
      if (found !== "missing" || read >= READ_BACKS) break;
      await clock.sleep(READ_BACK_DELAY_MS);
    }
  } catch (error) {
    const reason = `the claim marker on ${key} could not be read back, so the claim was not made: ${reasonOf(error)}`;
    await withdraw(reason);
    return refused(reason);
  }
  if (found === "missing") {
    const reason = `the claim marker posted on ${key} did not show among its trusted comments when it was read back, so the claim was not made`;
    await withdraw(reason);
    return refused(reason);
  }
  if (found.length > 0) {
    const reason = `another claim's marker on ${key} is earlier: another session holds it`;
    await withdraw(reason, first);
    return refused(reason);
  }

  let result: ClaimResult;
  try {
    result = await claim();
  } catch (error) {
    await withdraw(`the claim failed: ${reasonOf(error)}`);
    throw error;
  }
  if (result.outcome !== "claimed") {
    await withdraw(result.reason);
    return result;
  }

  let after: View;
  try {
    after = await view(tracker, key);
  } catch (error) {
    await record("claimed");
    return {
      ...result,
      marker: { posted: true, confirmed: false, reason: reasonOf(error) },
    };
  }
  const now = earlier(after, attempt);
  if (now !== "missing" && now.length === 0) {
    await record("claimed");
    return { ...result, marker: { posted: true, confirmed: true } };
  }
  // The read before the write listed this attempt's own marker, or it refused.
  const ownAt = (first.markers.find((m) => m.attempt === attempt) as Marker)
    .createdAt;
  return recover(now === "missing" ? [] : now.map((m) => m.attempt));

  /**
   * Settle who owns the item this attempt has written, from the outcome
   * records of the earlier attempts it saw (`open`); never by writing the
   * item.
   */
  async function recover(seen: string[]): Promise<TokenResult> {
    const open = new Set(seen);
    let failure: string | null = null;
    let last: View | undefined;
    for (let read = 1; read <= RECOVERY_READS; read++) {
      if (read > 1) await clock.sleep(RECOVERY_DELAY_MS);
      try {
        last = await view(tracker, key);
      } catch (error) {
        failure = reasonOf(error);
        break;
      }
      const settled = settle(last, attempt, ownAt, open);
      if (settled === "held") {
        const reason = `another claim's marker on ${key} is earlier and that claim holds it; this one stands down`;
        await withdraw(reason, last);
        return { outcome: "stood_down", issue: key, reason, recovery: "held" };
      }
      if (settled === "reclaimed") {
        await record("claimed");
        return {
          ...result,
          marker: { posted: true, confirmed: true },
          recovery: "reclaimed",
        };
      }
    }
    const why =
      failure !== null
        ? `its claim markers could not be read again (${failure})`
        : "an earlier claim's marker on it recorded no outcome, or this claim's own marker is gone";
    const reason = `${key} was assigned and started, but who holds it cannot be established: ${why}; a person must check it`;
    await withdraw(reason, last, "unresolved");
    return {
      outcome: "stood_down",
      issue: key,
      reason,
      recovery: "unresolved",
    };
  }
}

/**
 * One recovery read: add the earlier holding attempts `v` lists to `open`,
 * drop those that recorded a release, and say whether one recorded its
 * claim (`held`), none is left while this attempt's own marker lists
 * (`reclaimed`), or the question stays `open`.
 */
function settle(
  v: View,
  attempt: string,
  ownAt: number,
  open: Set<string>,
): "held" | "reclaimed" | "open" {
  const listed = earlier(v, attempt);
  const lostOwn = listed === "missing";
  for (const m of lostOwn ? postedBefore(v, attempt, ownAt) : listed)
    open.add(m.attempt);
  if ([...open].some((a) => v.outcomes.get(a) === "claimed")) return "held";
  for (const a of [...open]) if (released(v, a)) open.delete(a);
  return open.size === 0 && !lostOwn ? "reclaimed" : "open";
}
