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
  // A structural marker may follow a heading, but quoted and code examples
  // are not reviewer evidence. Requiring byte zero rejected valid configured
  // summaries; accepting every trimmed line lets an example replace one.
  let fence: { character: "`" | "~"; length: number } | null = null;
  const structural: string[] = [];
  const structuralMarker = body.split(/\r?\n/).some((line) => {
    // Fenced blocks are structural only at Markdown's permitted indentation.
    // Remember their delimiter length: three backticks inside a four-backtick
    // block are content, not its closing fence.
    const token = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? "";
    if (fence === null && token !== "") {
      // An opening fence may have an info string immediately after it.  A
      // closing fence, on the other hand, admits whitespace only.
      const rest = line.slice(line.indexOf(token) + token.length);
      if (!rest.includes(token[0] ?? ""))
        fence = { character: token[0] as "`" | "~", length: token.length };
      return false;
    }
    if (
      fence !== null &&
      token !== "" &&
      token[0] === fence.character &&
      token.length >= fence.length &&
      /^[ \t]*$/.test(line.slice(line.indexOf(token) + token.length))
    ) {
      fence = null;
      return false;
    }
    const trimmed = line.trimStart();
    if (fence !== null || /^ {0,3}>/.test(line) || /^(?: {4}|\t)/.test(line))
      return false;
    structural.push(line);
    return trimmed.startsWith(summaryMarker);
  });
  // Every evidence parser consumes this structural view. Returning the raw
  // comment after finding a genuine marker let examples later in that same
  // comment contribute a stamp, backlog, or finding.
  return reviewerLogin(login) && structuralMarker
    ? structural.join("\n")
    : null;
}

/** The review stamp and its companion markers from the newest qualifying sticky. */
export function reviewerStickyIn(
  comments: readonly unknown[],
  reviewerLogin: (login: string) => boolean,
  summaryMarker: string,
  shaMarker: string,
  skipNoticeMarker = "ai-review-skip-notice",
): ReviewerSticky {
  let sticky: ReviewerSticky = {
    sha: "",
    round: null,
    updatedAt: "",
    skip: null,
  };
  for (const raw of comments) {
    const body = reviewerStickyBody(raw, reviewerLogin, summaryMarker);
    if (body === null) continue;
    const bodySha = reviewedShaIn(body, shaMarker);
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
