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

/** Markdown indentation, with tabs advancing to their next four-column stop. */
function markdownIndentation(line: string): { columns: number; end: number } {
  let columns = 0;
  let end = 0;
  while (end < line.length) {
    const character = line[end];
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
    end += 1;
  }
  return { columns, end };
}

/**
 * Remove inline-code examples of protocol markers without losing ordinary
 * Markdown data such as the backticked file anchors in a finding. Operate on
 * the complete block: a code span may cross a physical line.
 */
function withoutProtocolInlineCode(body: string): string {
  let result = "";
  let offset = 0;
  while (offset < body.length) {
    if (body[offset] !== "`") {
      result += body[offset++] ?? "";
      continue;
    }
    let end = offset;
    while (body[end] === "`") end += 1;
    const delimiter = body.slice(offset, end);
    const close = body.indexOf(delimiter, end);
    if (close === -1) {
      result += delimiter;
      offset = end;
      continue;
    }
    const span = body.slice(offset, close + delimiter.length);
    result += span.includes("<!--") ? "" : span;
    offset = close + delimiter.length;
  }
  return result;
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
  for (const line of body.split(/\r?\n/)) {
    // Fenced blocks are structural only at Markdown's permitted indentation.
    // Remember their delimiter length: three backticks inside a four-backtick
    // block are content, not its closing fence.
    const indentation = markdownIndentation(line);
    const token =
      indentation.columns <= 3
        ? (/^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? "")
        : "";
    if (fence === null && token !== "") {
      // An opening fence may have an info string immediately after it.  A
      // closing fence, on the other hand, admits whitespace only.
      const rest = line.slice(line.indexOf(token) + token.length);
      if (token[0] === "~" || !rest.includes("`"))
        fence = { character: token[0] as "`" | "~", length: token.length };
      continue;
    }
    if (
      fence !== null &&
      token !== "" &&
      token[0] === fence.character &&
      token.length >= fence.length &&
      /^[ \t]*$/.test(line.slice(line.indexOf(token) + token.length))
    ) {
      fence = null;
      continue;
    }
    if (fence !== null || indentation.columns >= 4) continue;
    if (/^ {0,3}>/.test(line)) continue;
    structural.push(line);
  }
  // Every evidence parser consumes this structural view. Returning the raw
  // comment after finding a genuine marker let examples later in that same
  // comment contribute a stamp, backlog, or finding.
  const structuralBody = withoutProtocolInlineCode(structural.join("\n"));
  return reviewerLogin(login) &&
    structuralBody
      .split(/\r?\n/)
      .some((line) => line.trimStart().startsWith(summaryMarker))
    ? structuralBody
    : null;
}

/**
 * Complete skip-notice blocks whose delimiters are structural Markdown, while
 * retaining their deliberately blockquoted payload for the skip decoder.
 */
function structuralSkipNotices(body: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`^ {0,3}<!--\\s*${escaped}\\s*-->\\s*$`);
  const closer = new RegExp(`^ {0,3}<!--\\s*/\\s*${escaped}\\s*-->\\s*$`);
  let fence: { character: "`" | "~"; length: number } | null = null;
  let open = false;
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const indentation = markdownIndentation(line);
    const token =
      indentation.columns <= 3
        ? (/^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? "")
        : "";
    if (fence === null && token !== "") {
      const rest = line.slice(line.indexOf(token) + token.length);
      if (token[0] === "~" || !rest.includes("`"))
        fence = { character: token[0] as "`" | "~", length: token.length };
    } else if (
      fence !== null &&
      token !== "" &&
      token[0] === fence.character &&
      token.length >= fence.length &&
      /^[ \t]*$/.test(line.slice(line.indexOf(token) + token.length))
    ) {
      fence = null;
    }
    if (fence !== null || indentation.columns >= 4 || /^ {0,3}>/.test(line)) {
      if (open) kept.push(line);
      continue;
    }
    if (!open && opener.test(line)) {
      open = true;
      kept.push(line);
    } else if (open) {
      kept.push(line);
      if (closer.test(line)) open = false;
    }
  }
  return kept.join("\n");
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
    const rawBody = String((raw as Record<string, unknown>).body ?? "");
    const skip = skipNoticeIn(
      structuralSkipNotices(rawBody, skipNoticeMarker),
      skipNoticeMarker,
    );
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
