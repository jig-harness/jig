import { isRecord } from "../../../../../shared/guards.ts";
import { type SkipNotice, skipNoticeIn } from "./skip-notice.ts";

/** `<!-- ai-review-round: N -->` from a sticky or inline reviewer comment. */
export function parseReviewRound(body: string): number | null {
  const markers = [
    ...body.matchAll(/<!--\s*ai-review-round:\s*([\s\S]*?)-->/g),
  ];
  if (markers.length !== 1) return null;
  const value = markers[0]?.[1]?.trim() ?? "";
  if (!/^\d+$/.test(value)) return null;
  const round = Number(value);
  return Number.isSafeInteger(round) ? round : null;
}

/** A malformed or out-of-range round is not equivalent to an absent round. */
export function hasInvalidReviewRound(body: string): boolean {
  const openers = [...body.matchAll(/<!--\s*ai-review-round:/g)];
  if (openers.length === 0) return false;
  const markers = [
    ...body.matchAll(/<!--\s*ai-review-round:\s*([\s\S]*?)-->/g),
  ];
  // A protocol comment has one unambiguous ordering claim. Do not recover
  // from an unterminated or competing marker by trusting one fragment.
  return (
    openers.length !== 1 ||
    markers.length !== 1 ||
    parseReviewRound(body) === null
  );
}

/** A SHA marker was present but did not satisfy the marker grammar. */
export function hasInvalidReviewedSha(body: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Recognise an attempted marker broadly, then require the exact marker
  // grammar below. Otherwise a spaced or case-variant attempt can fall
  // through as if no stamp had been written at all.
  const openers = [
    ...body.matchAll(new RegExp(`<!--\\s*${escaped}\\s*:`, "gi")),
  ];
  if (openers.length === 0) return false;
  const markers = [
    ...body.matchAll(
      new RegExp(`<!--\\s*${escaped}:\\s*([0-9a-f]{7,40})\\s*-->`, "g"),
    ),
  ];
  // The last marker is the witness. Any malformed attempt makes the whole
  // comment unreadable instead of allowing an earlier stamp to win.
  return openers.length !== markers.length;
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
export function withoutProtocolInlineCode(body: string): string {
  // Inline spans cannot cross a blank-line block boundary. Preserve their
  // ordinary contents (notably backticked finding anchors), but hide only the
  // protocol opener from the marker parsers.
  return body
    .split(/(\r?\n\r?\n)/)
    .map((block) => {
      let result = "";
      let offset = 0;
      while (offset < block.length) {
        if (block[offset] !== "`") {
          result += block[offset++] ?? "";
          continue;
        }
        let end = offset;
        while (block[end] === "`") end += 1;
        const delimiter = block.slice(offset, end);
        let close = -1;
        for (let cursor = end; cursor < block.length; cursor += 1) {
          if (block[cursor] !== "`") continue;
          let runEnd = cursor;
          while (block[runEnd] === "`") runEnd += 1;
          if (runEnd - cursor === delimiter.length) {
            close = cursor;
            break;
          }
          cursor = runEnd - 1;
        }
        if (close === -1) {
          result += delimiter;
          offset = end;
          continue;
        }
        const span = block.slice(offset, close + delimiter.length);
        result += span.replaceAll("<!--", "< !--");
        offset = close + delimiter.length;
      }
      return result;
    })
    .join("");
}

/** The last reviewed-SHA stamp in one sticky body under the configured marker. */
export function reviewedShaIn(body: string, shaMarker: string): string {
  const markerRe = new RegExp(
    `<!--\\s*${shaMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
    "g",
  );
  return lastStamp(body, markerRe);
}

/** Whether two supported reviewed-SHA markers identify the same commit. */
export function sameReviewedHead(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return (
    a !== "" && b !== "" && (a === b || a.startsWith(b) || b.startsWith(a))
  );
}

/** Whether two non-empty reviewed-SHA markers identify different commits. */
export function differentReviewedHead(left: string, right: string): boolean {
  return right !== "" && !sameReviewedHead(left, right);
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
  let fence: Fence = null;
  let quotedFence: { character: "`" | "~"; length: number } | null = null;
  const structural: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    // Fenced blocks are structural only at Markdown's permitted indentation.
    // Remember their delimiter length: three backticks inside a four-backtick
    // block are content, not its closing fence.
    const step = fenceStep(line, fence);
    fence = step.fence;
    if (step.delimiter || fence !== null || step.columns >= 4) continue;
    // Finding-count declarations are intentionally rendered as blockquotes by
    // the reviewer. Only the declaration's recognised prefix survives, and
    // only from a quoted prose line outside quoted code: trailing prose,
    // quoted fences and quoted protocol markers are untrusted example text.
    if (/^ {0,3}>/.test(line)) {
      const content = line.replace(/^ {0,3}>[ \t]?/, "");
      const quotedIndent = markdownIndentation(content);
      const quotedToken =
        quotedIndent.columns <= 3
          ? (/^\s*(`{3,}|~{3,})/.exec(content)?.[1] ?? "")
          : "";
      if (quotedFence === null && quotedToken !== "") {
        const rest = content.slice(
          content.indexOf(quotedToken) + quotedToken.length,
        );
        if (quotedToken[0] === "~" || !rest.includes("`"))
          quotedFence = {
            character: quotedToken[0] as "`" | "~",
            length: quotedToken.length,
          };
        continue;
      }
      if (quotedFence !== null) {
        if (
          quotedToken !== "" &&
          quotedToken[0] === quotedFence.character &&
          quotedToken.length >= quotedFence.length &&
          /^[ \t]*$/.test(
            content.slice(content.indexOf(quotedToken) + quotedToken.length),
          )
        )
          quotedFence = null;
        continue;
      }
      if (quotedIndent.columns >= 4) continue;
      const declaration =
        /^\s*(\S+\s+findings?(?:\(s\))?\s+without\s+a\s+diff-anchorable\s+line)\b/i.exec(
          content,
        );
      if (declaration !== null)
        structural.push(`> ${declaration[1] as string}`);
      continue;
    }
    quotedFence = null;
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

type Fence = {
  character: "`" | "~";
  length: number;
  /** Content column of the list item the fence opened in; 0 outside a list. */
  indent: number;
} | null;

/**
 * One line's effect on a Markdown code fence. Fences are structural only at
 * Markdown's permitted indentation, and their delimiter length is remembered:
 * three backticks inside a four-backtick block are content, not its closing
 * fence. An opening fence may carry an info string; a closing one admits
 * whitespace only. A fence may open on the same line as a list marker; it then
 * closes at up to three columns beyond that item's content column.
 */
function fenceStep(
  line: string,
  fence: Fence,
): { fence: Fence; delimiter: boolean; columns: number } {
  const { columns } = markdownIndentation(line);
  let text = line;
  let indent = fence?.indent ?? 0;
  let relative = columns - indent;
  if (fence === null) {
    const item = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/.exec(line);
    if (item !== null) {
      indent = item[0].length;
      text = line.slice(indent);
      relative = 0;
    }
  }
  const token =
    relative >= 0 && relative <= 3
      ? (/^\s*(`{3,}|~{3,})/.exec(text)?.[1] ?? "")
      : "";
  if (token === "") return { fence, delimiter: false, columns };
  const rest = text.slice(text.indexOf(token) + token.length);
  if (fence === null) {
    const opens = token[0] === "~" || !rest.includes("`");
    return {
      fence: opens
        ? { character: token[0] as "`" | "~", length: token.length, indent }
        : null,
      delimiter: true,
      columns,
    };
  }
  const closes =
    token[0] === fence.character &&
    token.length >= fence.length &&
    /^[ \t]*$/.test(rest);
  return closes
    ? { fence: null, delimiter: true, columns }
    : { fence, delimiter: false, columns };
}

/**
 * Complete skip-notice blocks whose delimiters are structural Markdown, while
 * retaining their deliberately blockquoted payload for the skip decoder.
 */
export function structuralSkipNotices(body: string, marker: string): string {
  body = withoutProtocolInlineCode(body);
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opener = new RegExp(`^ {0,3}<!--\\s*${escaped}\\s*-->\\s*$`);
  const closer = new RegExp(`^ {0,3}<!--\\s*/\\s*${escaped}\\s*-->\\s*$`);
  let fence: Fence = null;
  let open = false;
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    // A fence delimiter is never skip-notice payload. Treat opener and
    // closer symmetrically so neither can leak into the decoder.
    const step = fenceStep(line, fence);
    fence = step.fence;
    if (step.delimiter) continue;
    if (fence !== null || step.columns >= 4 || /^ {0,3}>/.test(line)) {
      // The skip notice intentionally retains its blockquoted prose, but a
      // fenced or indented code example inside it is not payload evidence.
      if (open && fence === null && step.columns < 4) kept.push(line);
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
  let highestExplicitRound: number | null = null;
  for (const raw of comments) {
    const body = reviewerStickyBody(raw, reviewerLogin, summaryMarker);
    if (body === null) continue;
    const bodySha = reviewedShaIn(body, shaMarker);
    const round = parseReviewRound(body);
    const rawBody = String((raw as Record<string, unknown>).body ?? "");
    const skip = skipNoticeIn(
      structuralSkipNotices(rawBody, skipNoticeMarker),
      skipNoticeMarker,
    );
    // A malformed explicit ordering claim is untrusted protocol input.  In
    // particular, do not let it fall through as an unstamped skip and alter
    // the witness selected from another comment.
    if (hasInvalidReviewRound(body) || hasInvalidReviewedSha(body, shaMarker))
      continue;
    // A same-head acknowledgement is auxiliary evidence, not proof a rerun
    // published a review. It must not replace the selected sticky's timestamp.
    // A new reviewed head or a newer explicit review round is a replacement.
    const newerRound =
      round !== null &&
      (highestExplicitRound === null || round > highestExplicitRound);
    // A lower declared round cannot replace the selected review just because
    // it names another head: summary selection rejects that candidate too.
    const lowerRound =
      round !== null &&
      highestExplicitRound !== null &&
      round < highestExplicitRound;
    const replacesSticky =
      skip === null &&
      !lowerRound &&
      bodySha !== "" &&
      (sticky.sha === "" ||
        newerRound ||
        (!sameReviewedHead(bodySha, sticky.sha) && !lowerRound));
    // An unstamped comment qualifies only when it carries a skip notice.
    if (!replacesSticky && skip === null) continue;
    // A skip says this comment did not review code. Retain the last affirmative
    // review witness and its timestamp while making the newer skip available
    // to the skipped-head check.
    if (!replacesSticky) {
      // A no-stamp skip can prove its own excluded-path case, but it cannot
      // borrow the reviewed SHA of an earlier comment.
      // A skip without its own review stamp cannot borrow the selected
      // witness's stamp. A lower-round stamped skip cannot update it either:
      // both pieces of evidence must remain from the same comment.
      if (skip !== null && bodySha !== "" && sticky.sha === "" && !lowerRound) {
        // One comment carrying both its own stamp and a skip notice (the
        // reviewer updated its only sticky in place): both witnesses come
        // from that comment, so the identical-diff comparison can run.
        if (round !== null)
          highestExplicitRound = Math.max(highestExplicitRound ?? round, round);
        sticky = {
          sha: bodySha,
          round,
          // The edit that added the skip moved `updated_at`, so it does not
          // date the stamp's publication: leave it undatable, which the
          // stranded-run guard reads as not fresh.
          updatedAt: "",
          skip,
        };
        continue;
      }
      if (
        skip !== null &&
        ((bodySha === "" && sticky.sha === "") ||
          (bodySha !== "" &&
            sameReviewedHead(bodySha, sticky.sha) &&
            !lowerRound)) &&
        !lowerRound
      )
        sticky = { ...sticky, skip };
      // Before any affirmative review witness exists, skip notices order only
      // one another. Once a reviewed head is selected, a skip for another
      // head must not block a later acknowledgement of that selected head.
      if (skip !== null && round !== null && sticky.sha === "")
        highestExplicitRound = Math.max(highestExplicitRound ?? round, round);
      continue;
    }
    if (round !== null)
      highestExplicitRound = Math.max(highestExplicitRound ?? round, round);
    sticky = {
      sha: bodySha,
      round,
      // Absent/malformed reads as `''`, never as "now" — a caller flooring
      // on this must fail closed on an undatable sticky rather than treat it
      // as freshly written.
      updatedAt: String((raw as Record<string, unknown>).updated_at ?? ""),
      skip,
    };
  }
  return sticky;
}
