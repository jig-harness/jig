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
  const state: Selection<T> = {
    selected: undefined,
    round: null,
    reviewedSha: null,
    carriesFindings: false,
    highestRound: null,
    malformed: [],
  };
  for (const comment of comments)
    considerComment(state, comment, carriesFindings);
  if (state.malformed.length > 0)
    throw new SummaryProtocolError(
      "reviewer summary protocol evidence is unreadable",
    );
  return state.selected;
}

interface Selection<T> {
  selected: T | undefined;
  round: number | null;
  reviewedSha: string | null;
  carriesFindings: boolean;
  highestRound: number | null;
  // Every malformed finding-bearing summary is kept. A later malformed comment
  // must not overwrite a stronger ordering constraint from an earlier one.
  malformed: { round: number | null; sha: string }[];
}

function hasInvalidProtocol(body: string): boolean {
  return (
    hasInvalidReviewRound(body) ||
    hasInvalidReviewedSha(body, reviewedShaMarker())
  );
}

/**
 * A malformed finding-bearing summary remains unreadable until a later clean
 * summary proves it supersedes that summary by its explicit round. A different
 * SHA alone cannot establish ordering.
 */
function selectionAdvances<T>(
  state: Selection<T>,
  round: number | null,
  replaces: boolean,
): boolean {
  return (
    state.selected === undefined ||
    // An unstamped, finding-free selection reviewed nothing: any later
    // comment that passed the filters above supersedes it.
    (!state.carriesFindings && state.reviewedSha === "") ||
    (round !== null && (state.round === null || round > state.round)) ||
    (replaces &&
      (round === null || state.round === null || round === state.round))
  );
}

function isBelowHighest<T>(state: Selection<T>, round: number | null) {
  return (
    round !== null && state.highestRound !== null && round < state.highestRound
  );
}

type Candidate = {
  round: number | null;
  reviewedSha: string;
  carries: boolean;
};

function considerComment<T extends { body?: string | null | undefined }>(
  state: Selection<T>,
  comment: T,
  carriesFindings: (body: string) => boolean,
): void {
  const body = reviewerStickyBody(comment, isReviewerLogin, stickyMarker());
  if (body === null) return;
  const round = parseReviewRound(body);
  const reviewedSha = reviewedShaIn(body, reviewedShaMarker());
  if (hasInvalidProtocol(body)) {
    // A malformed replacement may still carry live work. Skipping the
    // comment would make an older clean summary look current and could
    // converge over findings that were never safely ordered.
    if (carriesFindings(body))
      state.malformed.push({ round, sha: reviewedSha });
    return;
  }
  // A lower-round candidate cannot affect the selected summary, including
  // by failing to parse.  Ignore it before consuming untrusted payload.
  if (isBelowHighest(state, round)) return;
  // Decode rather than merely spotting an opener: malformed protocol
  // evidence is unreadable, never a clean replacement summary.
  const candidate = { round, reviewedSha, carries: carriesFindings(body) };
  if (!candidate.carries && considerFindingFree(state, comment, candidate))
    return;
  advanceSelection(state, comment, candidate);
}

// A finding-free comment is never a replacement without a stamp. Returns
// whether it was settled here.
function considerFindingFree<T extends { body?: string | null | undefined }>(
  state: Selection<T>,
  comment: T,
  candidate: Candidate,
): boolean {
  // A skip notice never describes a review summary. In particular it must
  // not establish the initial selection or an ordering watermark that hides
  // a later affirmative review with findings.
  if (isSkipOnly(comment)) return true;
  if (candidate.reviewedSha !== "") return false;
  // An unstamped, finding-free comment after a selection is auxiliary: it
  // reviewed nothing, so it neither replaces the selection nor raises the
  // ordering watermark that would hide a later finding-bearing summary.
  if (state.selected === undefined) select(state, comment, candidate);
  return true;
}

function advanceSelection<T>(
  state: Selection<T>,
  comment: T,
  candidate: Candidate,
): void {
  const { round, reviewedSha, carries } = candidate;
  // A stamp identifies a reviewed head, not a replacement boundary. Without
  // an affirmative review round it may be an auxiliary acknowledgement on
  // that same head, which must not erase an earlier finding-bearing summary.
  // A clean stamp for a different head is a fresh review, however, even when
  // the reviewer reuses or omits its round marker.
  const replaces =
    carries || isCleanReplacement(carries, reviewedSha, state.reviewedSha);
  const advances = selectionAdvances(state, round, replaces);
  // An explicit newer round is the only evidence that can supersede a
  // malformed finding-bearing summary. An unorderable malformed comment
  // remains a stopper until the reviewer repairs its protocol evidence.
  if (advances && round !== null && reviewedSha !== "")
    retireOrderedMalformed(state, round);
  // A newer declared round is the reviewer's explicit replacement boundary.
  if (round !== null)
    state.highestRound = Math.max(state.highestRound ?? round, round);
  if (advances) select(state, comment, candidate);
}

function retireOrderedMalformed<T>(state: Selection<T>, round: number): void {
  state.malformed = state.malformed.filter(
    (malformed) => malformed.round === null || round <= malformed.round,
  );
}

function select<T>(state: Selection<T>, comment: T, chosen: Candidate): void {
  state.selected = comment;
  state.round = chosen.round;
  state.reviewedSha = chosen.reviewedSha;
  state.carriesFindings = chosen.carries;
}

function isSkipOnly(comment: { body?: string | null | undefined }): boolean {
  return (
    skipNoticeIn(
      structuralSkipNotices(String(comment.body ?? ""), skipNoticeMarker()),
      skipNoticeMarker(),
    ) !== null
  );
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
    .split(/(\r?\n[ \t]*\r?\n)/)
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
