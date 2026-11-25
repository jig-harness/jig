/**
 * Selecting the reviewer's sticky summary comment from a pull request's
 * comments, split out of `summary-findings.ts`.
 */

import { withoutFencedExamples } from "../markdown-examples.ts";
import { JigError } from "../../../../../shared/outcome.ts";
import {
  isReviewerLogin,
  reviewedShaMarker,
  skipNoticeMarker,
  stickyMarker,
} from "../overlay.ts";
import {
  differentReviewedHead,
  hasInvalidReviewedSha,
  hasInvalidReviewRound,
  parseReviewRound,
  reviewedShaIn,
  reviewerStickyBody,
  structuralSkipNotices,
} from "./reviewer-sticky.ts";
import { skipNoticeIn } from "./skip-notice.ts";

/** The reviewer's summary protocol evidence cannot be read safely. */
export class SummaryProtocolError extends JigError<"invalid-protocol"> {
  override name = "SummaryProtocolError";
  constructor(reason: string) {
    super("invalid-protocol", reason);
  }
}

/**
 * The reviewer's sticky summary comment, if any: the last comment from the
 * reviewer's login carrying the sticky marker. With `configuredOnly` (the
 * drive's gate, `--configured-reviewer-only`), a repository that names no AI
 * reviewer (`reviewerExpected`) has none to read: a summary comment from a bot
 * in `review.bots` is not reviewer protocol evidence for the drive, so its
 * backlog and reviewed-SHA stamp are never decoded. Without it, a `review.bots`
 * login's sticky is read, which is what the standalone resolver relies on.
 */
export function selectReviewerSticky<
  T extends { body?: string | null | undefined },
>(comments: T[], carriesFindings: (body: string) => boolean): T | undefined {
  // Summary discovery deliberately differs from status evidence: a genuine
  // unstamped sticky can carry findings while status uses its check-run
  // fallback. A marker-prefixed acknowledgement must not erase a preceding
  // finding-bearing summary merely because it is newer.
  let selected: T | undefined;
  let selectedRound: number | null = null;
  let selectedReviewedSha: string | null = null;
  let highestExplicitRound: number | null = null;
  // Keep every malformed finding-bearing summary. A later malformed comment
  // must not overwrite a stronger ordering constraint from an earlier one.
  const malformedFindingEvidence: { round: number | null; sha: string }[] = [];
  for (const comment of comments) {
    const body = reviewerStickyBody(comment, isReviewerLogin, stickyMarker());
    if (body === null) continue;
    if (
      hasInvalidReviewRound(body) ||
      hasInvalidReviewedSha(body, reviewedShaMarker())
    ) {
      // A malformed replacement may still carry live work. Skipping the
      // comment would make an older clean summary look current and could
      // converge over findings that were never safely ordered.
      if (carriesFindings(body))
        malformedFindingEvidence.push({
          round: parseReviewRound(body),
          sha: reviewedShaIn(body, reviewedShaMarker()),
        });
      continue;
    }
    const round = parseReviewRound(body);
    const reviewedSha = reviewedShaIn(body, reviewedShaMarker());
    // A lower-round candidate cannot affect the selected summary, including
    // by failing to parse.  Ignore it before consuming untrusted payload.
    if (
      round !== null &&
      highestExplicitRound !== null &&
      round < highestExplicitRound
    )
      continue;
    // A stamp says which head was reviewed, not that this comment supersedes
    // a preceding account of its findings. In particular, a skip notice may
    // deliberately retain the last reviewed SHA.
    // Decode rather than merely spotting an opener: malformed protocol
    // evidence is unreadable, never a clean replacement summary.
    const carriesFindingEvidence = carriesFindings(body);
    // A stamp identifies a reviewed head, not a replacement boundary. Without
    // an affirmative review round it may be an auxiliary acknowledgement on
    // that same head, which must not erase an earlier finding-bearing summary.
    // A clean stamp for a different head is a fresh review, however, even when
    // the reviewer reuses or omits its round marker.
    const cleanReplacement = isCleanReplacement(
      carriesFindingEvidence,
      reviewedSha,
      selectedReviewedSha,
    );
    const replacesSelection = carriesFindingEvidence || cleanReplacement;
    const skipOnly =
      !carriesFindingEvidence &&
      skipNoticeIn(
        structuralSkipNotices(String(comment.body ?? ""), skipNoticeMarker()),
        skipNoticeMarker(),
      ) !== null;
    // A skip notice never describes a review summary. In particular it must
    // not establish the initial selection or an ordering watermark that hides
    // a later affirmative review with findings.
    if (skipOnly) continue;
    // A malformed finding-bearing summary remains unreadable until a later
    // clean summary proves it supersedes that summary by its explicit round.
    // A different SHA alone cannot establish ordering, and a skip-only
    // acknowledgement is not a replacement summary at all.
    const advancesSelection =
      selected === undefined ||
      (round !== null && (selectedRound === null || round > selectedRound)) ||
      (replacesSelection &&
        (round === null || selectedRound === null || round === selectedRound));
    if (advancesSelection && round !== null) {
      // An explicit newer round is the only evidence that can supersede a
      // malformed finding-bearing summary. An unorderable malformed comment
      // remains a stopper until the reviewer repairs its protocol evidence.
      for (
        let index = malformedFindingEvidence.length - 1;
        index >= 0;
        index--
      ) {
        const malformed = malformedFindingEvidence[index];
        if (
          malformed !== undefined &&
          malformed.round !== null &&
          round > malformed.round
        )
          malformedFindingEvidence.splice(index, 1);
      }
    }
    // An auxiliary response never supersedes a finding-bearing summary just
    // because it happens to mention a protocol marker. A newer declared round
    // is also evidence: it is the reviewer's explicit replacement boundary.
    if (round !== null)
      highestExplicitRound = Math.max(highestExplicitRound ?? round, round);
    if (
      selected === undefined ||
      (round !== null && (selectedRound === null || round > selectedRound)) ||
      (replacesSelection &&
        (round === null || selectedRound === null || round === selectedRound))
    ) {
      selected = comment;
      selectedRound = round;
      selectedReviewedSha = reviewedSha;
    }
  }
  if (malformedFindingEvidence.length > 0)
    throw new SummaryProtocolError(
      "reviewer summary protocol evidence is unreadable",
    );
  return selected;
}

function isCleanReplacement(
  carriesFindingEvidence: boolean,
  reviewedSha: string,
  selectedReviewedSha: string | null,
): boolean {
  return (
    !carriesFindingEvidence &&
    reviewedSha !== "" &&
    (selectedReviewedSha === null ||
      (selectedReviewedSha !== "" &&
        differentReviewedHead(reviewedSha, selectedReviewedSha)))
  );
}

export function parseDeclaredUnanchored(body: string): number {
  // Declarations are protocol prose, not examples. Mask complete inline code
  // spans without changing line structure so a quoted sample cannot affect the
  // synthetic-work count.
  const prose = withoutFencedExamples(body)
    .split(/(\r?\n\r?\n)/)
    .map((block) =>
      block.replace(/(`+)(?:[^`]|`(?!\1))*\1/g, (span) =>
        span.replace(/[^\r\n]/g, " "),
      ),
    )
    .join("");
  const declarations = [
    ...prose.matchAll(
      /^[ \t]*>[ \t]*([^\s]+)\s+findings?(?:\(s\))?\s+without\s+a\s+diff-anchorable\s+line\b/gim,
    ),
  ];
  if (declarations.length === 0) return 0;
  const values = declarations.map((match) => {
    const token = match[1] ?? "";
    if (!/^-?\d+$/.test(token))
      throw new SummaryProtocolError(
        "declared unanchored finding count is invalid",
      );
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1000)
      throw new SummaryProtocolError(
        "declared unanchored finding count is invalid",
      );
    return value;
  });
  if (new Set(values).size !== 1)
    throw new SummaryProtocolError(
      "declared unanchored finding counts conflict",
    );
  return values[0] ?? 0;
}
