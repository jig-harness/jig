/**
 * The merge-ready announcement as a claim on the forge, for
 * announce-merge-ready.ts: a claim of the shared forge-claims module
 * (`shared/records/forge-claims.ts`) per pull request and head, keyed
 * `merge-ready:<head>`. Of the trusted announcements of one head the earliest
 * comment wins, so a second driver never announces over an earlier one, and
 * an announcement is withdrawn through that module.
 *
 * A comment counts as an announcement only if EVERY test below holds.
 *
 * SHAPE — it opens with the announcement's own first line, and holds its
 * record in the claim's data marker (or, in the form written before the
 * record, ENDS with a head marker). The marker alone is not enough: it is
 * predictable, so anyone quoting it while discussing this script (or pasting
 * a worked example) would otherwise be read as the existing announcement,
 * suppressing a real one, and during a race such a comment could become the
 * lowest id and make a driver delete its own genuine announcement. Every
 * announcement still ends with the head marker, so a driver of the release
 * before claims reads it too.
 *
 * AUTHORITY — `author_association` must be one GitHub itself vouches for as
 * having write access (`shared/trusted-authors.ts`, the one rule every claim
 * is read by). Shape alone is a body predicate, and a PR comment is
 * world-writable: both strings are public and fixed, so any commenter at all
 * can reproduce an exact announcement and reach the same two outcomes
 * deliberately rather than by accident. `author_association` is computed
 * server-side from repository permissions and cannot be set by comment
 * content, which is what makes it the half shape cannot supply.
 *
 * It is an ASSOCIATION, never a login: the announcement passes the rule no
 * login of its own. Two drivers on one PR may authenticate as different
 * accounts, and filtering to one login blinds each to the other's
 * announcement — re-opening the duplicate the claim exists to settle.
 */

import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import {
  type ClaimKind,
  type ClaimRecord,
  type ClaimTarget,
  list,
  type Posted,
  publish,
  type PostCode,
  type Published,
  readBack,
  type Standing,
  withdraw,
} from "../../../../shared/records/forge-claims.ts";
import { localWriter } from "../../../../shared/records/writer.ts";

/** The announcement's literal opening line. Load-bearing, not decoration. */
export const OPENER = "**Safe to merge from the driver's perspective.**";

export interface Announcement {
  id: number;
  /** The head it vouches for; `""` when `unreadable` is set. */
  head: string;
  /**
   * Set on a trusted announcement whose record does not read or does not name
   * the head its text ends with: why. It is visible but names no head, so
   * cleanup never guesses which head is authoritative and a caller that
   * would announce refuses instead.
   */
  unreadable?: string;
}

/** What an announcement claims: the head it vouches for. */
function headKey(head: string): string {
  return `merge-ready:${head}`;
}

/** The marker every announcement ends with, naming its head. */
export function headMarker(head: string): string {
  return `<!-- drive-pr-merge-ready: ${head} -->`;
}

const HEAD_MARKER = /<!-- drive-pr-merge-ready: ([0-9a-f]{7,40}) -->$/;

/** An announcement written before it carried a record: its head, from the marker it ends with. */
function legacyAnnouncement(
  body: string,
): Outcome<ClaimRecord, "unreadable"> | null {
  const m = body.replace(/\s+$/, "").match(HEAD_MARKER);
  return m === null
    ? failed("unreadable", "it ends with no head marker")
    : ok({ key: headKey(m[1] ?? ""), at: "", payload: {}, legacy: true });
}

/** Why a record that reads is not an announcement of the head its text ends with, or `null`. */
function announcementFault(record: ClaimRecord, _: unknown, body: string) {
  if (record.legacy) return null;
  const marked = body.replace(/\s+$/, "").match(HEAD_MARKER)?.[1];
  return marked !== undefined && record.key === headKey(marked)
    ? null
    : "its record and its head marker do not name the same head";
}

/** The merge-ready announcement as a kind of forge claim. */
export const MERGE_READY: ClaimKind = {
  name: "drive-merge-ready",
  opens: OPENER,
  data: "<!-- drive-pr-merge-ready-data",
  shape: announcementFault,
  legacy: legacyAnnouncement,
};

/** The pull request, in the checkout's own repository. */
function onPr(pr: string): ClaimTarget {
  return { repo: "{owner}/{repo}", number: Number(pr) };
}

/**
 * `{id, head}` for every announcement on this PR, ascending by id — for ANY
 * head, not only the live one. Callers narrow it themselves.
 *
 * Matching any head is what makes stale announcements findable at all. Scoped
 * to one head, the sweep answers "have I announced THIS head", and an
 * announcement left behind for an OLDER head is invisible to every later
 * invocation forever: the process that posted it is gone, and the next one is
 * looking for a different marker. That is the residue of an interrupted run —
 * killed between the POST and the post-write re-read, or a withdrawal whose
 * DELETE failed — and it is exactly the artefact a human acts on without
 * re-deriving it, still vouching for a head nobody reviewed.
 *
 * The comments are materialised (`--slurp`) BEFORE searching them: a
 * stream-and-quit search has more than one way to answer "not announced yet"
 * when it does not know (an early match closing the pipe mid-pagination, a
 * transient read failure) — and both post a duplicate announcement on a PR
 * that already had one, the one artefact a human acts on without re-deriving
 * it. `null` on any failure, never an empty list.
 */
export async function announcements(
  pr: string,
): Promise<Announcement[] | null> {
  const listing = await list(onPr(pr), MERGE_READY);
  if (!listing.ok) return null;
  return listing.value.flatMap((c): Announcement[] => {
    if (!c.trusted) return [];
    if (!c.record.ok) {
      return [{ id: c.id, head: "", unreadable: c.record.failure.reason }];
    }
    const key = c.record.value.key;
    return key.startsWith("merge-ready:")
      ? [{ id: c.id, head: key.slice("merge-ready:".length) }]
      : [];
  });
}

/** The trusted announcements that name no head, as one sentence; `null` when there are none. */
export function unreadableNote(all: Announcement[]): string | null {
  const bad = all.filter((a) => a.unreadable !== undefined);
  return bad.length === 0
    ? null
    : bad.map((a) => `comment ${a.id} (${a.unreadable})`).join("; ");
}

/** Just the ids announcing THIS head — the idempotence question. */
export function announcedIds(all: Announcement[], head: string): number[] {
  return all.filter((a) => a.head === head).map((a) => a.id);
}

/**
 * Post the announcement of `head` on the pull request, its claim's record
 * between the opening line and `text` (which ends with the head marker). It
 * is not read back here: the caller re-checks the PR and the tree first, then
 * reads the claim back with `readAnnouncement`.
 */
export function postAnnouncement(
  pr: string,
  head: string,
  text: string,
): Promise<Outcome<Published, PostCode>> {
  return publish(onPr(pr), MERGE_READY, {
    key: headKey(head),
    writer: localWriter("forge"),
    payload: {},
    text,
  });
}

/** How the posted announcement stands among the announcements of its head, read back. */
export function readAnnouncement(
  pr: string,
  posted: Posted,
): Promise<Outcome<Standing, "unreadable">> {
  return readBack(onPr(pr), MERGE_READY, posted);
}

/** Withdraw an announcement; `true` once it is gone. */
export async function withdrawAnnouncement(
  pr: string,
  id: number,
): Promise<boolean> {
  return (await withdraw(onPr(pr), id)).ok;
}
