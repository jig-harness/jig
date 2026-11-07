/**
 * The follow-up marker as the dispatcher reads it: the follow-up stage's
 * shared record (`shared/records/shared.ts`), a claim comment on a merged
 * pull request whose kind is defined with the launch claim's
 * (`shared/records/launch-claims.ts`) and which the forge-claims module posts,
 * reads back and decides. The tick posts one naming its launch record and its
 * host before it starts the follow-up's session, and writes the follow-up's
 * answer onto it once its launch record ends (`shared-launches.ts`); a
 * follow-up a person runs posts one saying so (`run: manual`) and marks it
 * done through `jig dispatch marker done` once its last act succeeded.
 *
 * A marker counts only when written by the dispatcher's own login or by an
 * owner, member or collaborator, as the drive trusts a ledger; of two
 * trusted markers the earlier comment (the lower id) wins, by the
 * forge-claims rule. A pull request has one follow-up, so a trusted marker
 * whose record does not read still claims it and holds against every later
 * one, until a person settles it.
 */
import { failed } from "../../shared/outcome.ts";
import { claimBody, readClaim } from "../../shared/records/forge-claims.ts";
import {
  FOLLOWUP_CLAIM,
  type MarkerPost,
  manualClaim,
  saysOf,
  tickClaim,
} from "../../shared/records/launch-claims.ts";
import type {
  ClaimSays,
  SharedClaim,
  SharedRecords,
} from "../../shared/records/shared.ts";
import type { FollowupMarker } from "./types.ts";

export {
  FOLLOWUP_CLAIM,
  FOLLOWUP_KIND,
  FOLLOWUP_MARKER as MARKER,
  FOLLOWUP_VERSION,
  type MarkerPost,
} from "../../shared/records/launch-claims.ts";

/** A tick's marker body. */
export function tickMarker(record: string, post: MarkerPost): string {
  return claimBody(FOLLOWUP_CLAIM, tickClaim(record, post));
}

/** A manual run's marker body. */
export function manualMarker(done: boolean, post: MarkerPost): string {
  return claimBody(FOLLOWUP_CLAIM, manualClaim(done, post));
}

/** What a marker's shared record says about its run, or why it does not read. */
function runOf(says: SharedClaim["says"]): FollowupMarker["run"] {
  if (!says.ok) return { kind: "unreadable", reason: says.failure.reason };
  return runOfSays(says.value);
}

function runOfSays(s: ClaimSays): FollowupMarker["run"] {
  if (s.run === "manual")
    return { kind: "manual", done: s.end?.state === "ended" };
  const outcome = s.end?.state === "ended" ? s.end.outcome : null;
  return {
    kind: "tick",
    record: String(s.record),
    ...(s.host === null ? {} : { host: s.host }),
    ...(s.owner === null ? {} : { owner: s.owner }),
    ...(outcome === null ? {} : { outcome }),
  };
}

/** What a marker on pull request `pr` says, or why it does not read. */
export function markerRun(body: string, pr: number): FollowupMarker["run"] {
  const read = readClaim(FOLLOWUP_CLAIM, body, { repo: "", number: pr });
  if (read === null)
    return runOf(
      failed("unreadable", "its body does not open with the marker"),
    );
  return read.ok ? runOfSays(saysOf("followup", read.value, pr)) : runOf(read);
}

/** A listed shared claim as the dispatcher reads a marker. */
function markerOf(c: SharedClaim): FollowupMarker {
  return {
    id: c.id,
    login: c.login,
    trusted: c.trusted,
    createdAt: c.createdAt,
    run: runOf(c.says),
  };
}

/** Every follow-up marker on the pull request, earliest first, or why they could not be read. */
export async function readMarkers(
  shared: SharedRecords,
  slug: string,
  pr: number,
): Promise<FollowupMarker[] | { unreadable: string }> {
  const listing = await shared.list({ repo: slug, pr }, "followup");
  return listing.ok
    ? listing.value.map(markerOf)
    : { unreadable: listing.failure.reason };
}

/** The trusted markers, earliest first. */
export function trustedMarkers(
  markers: readonly FollowupMarker[],
): FollowupMarker[] {
  return markers.filter((m) => m.trusted);
}
