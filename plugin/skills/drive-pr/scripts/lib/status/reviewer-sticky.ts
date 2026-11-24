import { isRecord } from "../../../../../shared/guards.ts";
import { type SkipNotice, skipNoticeIn } from "./skip-notice.ts";

/** `<!-- ai-review-round: N -->` from a sticky or inline reviewer comment. */
export function parseReviewRound(body: string): number | null {
  const m = body.match(/<!--\s*ai-review-round:\s*(\d+)\s*-->/);
  return m ? Number.parseInt(m[1] ?? "", 10) : null;
}

export interface ReviewerSticky {
  /** The `ai-reviewed-sha` marker from the newest STICKY comment, or `''`
   * when the reviewer has posted no sticky. */
  sha: string;
  /** The `ai-review-round` marker from that SAME comment, or `null` when the
   * sticky carries no round marker. */
  round: number | null;
  /**
   * That SAME comment's own `updated_at`, or `''` when there is no sticky.
   *
   * The reviewer edits its one sticky in place each round rather than posting a
   * new one, so this is when the marker content above was last written — the
   * only readable proxy for "when did this evidence come into being". The
   * stranded-check-run bypass needs precisely that: the check-run's own
   * `started_at` says when the RUN began, which is a different quantity and
   * cannot distinguish a sticky written moments ago mid-run from one written by
   * an earlier, already-completed run on the same head.
   */
  updatedAt: string;
  /** The skip notice in that SAME comment (`skip-notice.ts`), or `null`. */
  skip: SkipNotice | null;
}

/** The last review stamp in a comment's body, or `''` when it carries none. */
function lastStamp(body: string, markerRe: RegExp): string {
  let sha = "";
  for (const m of body.matchAll(markerRe)) sha = m[1] ?? "";
  return sha;
}

/** The last reviewed-SHA stamp in one sticky body under the configured marker. */
export function reviewedShaIn(body: string, shaMarker: string): string {
  const markerRe = new RegExp(
    `<!--\\s*${shaMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
    "g",
  );
  return lastStamp(body, markerRe);
}

/** A comment's body when the reviewer wrote it as its sticky summary, else `null`. */
export function reviewerStickyBody(
  raw: unknown,
  reviewerLogin: (login: string) => boolean,
  summaryMarker: string,
): string | null {
  if (!isRecord(raw)) return null;
  const login = String(
    ((raw.user as Record<string, unknown> | null)?.login ?? "") || "",
  );
  const body = String(raw.body ?? "");
  // A structural marker may follow a heading, but a quoted example is never
  // reviewer evidence.  Requiring it at byte zero rejected valid configured
  // summaries while accepting neither more evidence nor a safer protocol.
  const structuralMarker = body
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith(summaryMarker));
  return reviewerLogin(login) && structuralMarker ? body : null;
}

/** The review stamp and its companion markers from the newest qualifying sticky. */
export function reviewerStickyIn(
  comments: readonly unknown[],
  reviewerLogin: (login: string) => boolean,
  summaryMarker: string,
  shaMarker: string,
  skipNoticeMarker = "ai-review-skip-notice",
): ReviewerSticky {
  const markerRe = new RegExp(
    `<!--\\s*${shaMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
    "g",
  );
  let sticky: ReviewerSticky = {
    sha: "",
    round: null,
    updatedAt: "",
    skip: null,
  };
  for (const raw of comments) {
    const body = reviewerStickyBody(raw, reviewerLogin, summaryMarker);
    if (body === null) continue;
    const bodySha = lastStamp(body, markerRe);
    const skip = skipNoticeIn(body, skipNoticeMarker);
    // Only a stamp can replace a stamped sticky. An unstamped comment
    // qualifies as evidence only when it carries a skip notice.
    if (bodySha === "" && (sticky.sha !== "" || skip === null)) continue;
    sticky = {
      sha: bodySha,
      round: parseReviewRound(body),
      // Absent/malformed reads as `''`, never as "now" — a caller flooring
      // on this must fail closed on an undatable sticky rather than treat it
      // as freshly written.
      updatedAt: String((raw as Record<string, unknown>).updated_at ?? ""),
      skip,
    };
  }
  return sticky;
}
