import { isRecord } from "../../../../../shared/guards.ts";
import { parseReviewRound } from "../../summary-findings.ts";
import { type SkipNotice, skipNoticeIn } from "./skip-notice.ts";

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

/** The review stamp and its companion markers from the newest qualifying sticky. */
export function reviewerStickyIn(
  comments: readonly unknown[],
  reviewerLogin: (login: string) => boolean,
  summaryMarker: string,
  shaMarker: string,
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
    if (!isRecord(raw)) continue;
    const c = raw;
    const login = String(
      ((c.user as Record<string, unknown> | null)?.login ?? "") || "",
    );
    const body = String(c.body ?? "");
    if (!reviewerLogin(login)) continue;
    if (!body.includes(summaryMarker)) continue;
    let bodySha = "";
    for (const m of body.matchAll(markerRe)) bodySha = m[1] ?? "";
    if (bodySha === "") continue;
    sticky = {
      sha: bodySha,
      round: parseReviewRound(body),
      // Absent/malformed reads as `''`, never as "now" — a caller flooring
      // on this must fail closed on an undatable sticky rather than treat it
      // as freshly written.
      updatedAt: String(c.updated_at ?? ""),
      skip: skipNoticeIn(body),
    };
  }
  return sticky;
}
