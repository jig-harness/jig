/**
 * The announcement sweep for announce-merge-ready.ts: which comments on the
 * PR are genuine merge-ready announcements, from whom, for which head.
 *
 * A comment counts as an announcement only if EVERY test below holds.
 *
 * SHAPE — it opens with the announcement's own first line and ENDS with a
 * head marker. The marker alone is not enough: it is predictable, so anyone
 * quoting it while discussing this script (or pasting a worked example) would
 * otherwise be read as the existing announcement, suppressing a real one, and
 * during a race such a comment could become the lowest id and make a driver
 * delete its own genuine announcement.
 *
 * AUTHORITY — `author_association` must be one GitHub itself vouches for as
 * having write access. Shape alone is a body predicate, and a PR comment is
 * world-writable: both strings are public and fixed, so any commenter at all
 * can reproduce an exact announcement and reach the same two outcomes
 * deliberately rather than by accident. `author_association` is computed
 * server-side from repository permissions and cannot be set by comment
 * content, which is what makes it the half shape cannot supply.
 *
 * It is an ASSOCIATION, never a login. Two drivers on one PR may authenticate
 * as different accounts, and filtering to one login blinds each to the
 * other's announcement — re-opening the duplicate the reconciliation exists
 * to settle. The set is read from `summary-findings.ts`, which gates the
 * addressed markers on the same question about the same comment stream; a
 * local copy would be a second answer to drift.
 */

import { ghCall } from "./proc.ts";

/** The announcement's literal opening line. Load-bearing, not decoration. */
export const OPENER = "**Safe to merge from the driver's perspective.**";

export interface Announcement {
  id: number;
  head: string;
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
  trusted: Set<string>,
): Promise<Announcement[] | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  let pages: unknown;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const pageList = Array.isArray(pages) ? pages : [pages];
  const out: Announcement[] = [];
  const markerRe = /<!-- drive-pr-merge-ready: ([0-9a-f]{7,40}) -->$/;
  for (const page of pageList) {
    const comments = Array.isArray(page) ? page : [];
    for (const c of comments as Array<Record<string, unknown>>) {
      const association = String(c.author_association ?? "");
      if (!trusted.has(association)) continue;
      const body = String(c.body ?? "")
        .replaceAll("\r", "")
        .replace(/\s+$/, "");
      if (!body.startsWith(OPENER)) continue;
      const m = body.match(markerRe);
      if (!m) continue;
      out.push({ id: Number(c.id ?? 0), head: m[1] ?? "" });
    }
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** Just the ids announcing THIS head — the idempotence question. */
export function announcedIds(all: Announcement[], head: string): number[] {
  return all.filter((a) => a.head === head).map((a) => a.id);
}
