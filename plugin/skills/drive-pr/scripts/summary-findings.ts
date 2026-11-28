#!/usr/bin/env bun
import { MARKER_SAFE_FINGERPRINT } from "./lib/summary-answer.ts";
export { MARKER_SAFE_FINGERPRINT } from "./lib/summary-answer.ts";
import { summaryAnswerBlocks } from "../../../shared/summary-answer-blocks.ts";
import { definedFields } from "../../../shared/defined-fields.ts";
import { swallow } from "../../../shared/errors.ts";
import { TRUSTED_ASSOCIATIONS } from "../../../shared/trusted-authors.ts";
/**
 * Enumerate the review findings that exist ONLY in the reviewer's summary
 * comment — the ones that create no diff-anchorable thread — and say which of
 * them have been answered.
 *
 * This closes false-convergence mode 1. `list-unresolved-threads.ts` counts
 * review THREADS; a finding the reviewer could not anchor to a diff line never
 * becomes one. Measured: that produced a thread count of zero while a real
 * medium finding sat live in the summary, and the loop reported converged.
 * There is also no `threadId`, so `reply-to-thread.ts` / `resolve-thread.ts`
 * cannot be used at all — the answer has to be a top-level comment, which is
 * what `answer-summary-finding.ts` posts.
 *
 * The reviewer surfaces unanchored findings through these sources:
 *
 *   backlog     the `ai-review-backlog` base64 blob — findings deliberately
 *               held out of the inline threads ("Beyond this PR", wind-down
 *               deferrals). Authoritative: it carries the reviewer's OWN
 *               stable fingerprints. Explicitly non-blocking entries are
 *               reported separately and require no answer.
 *   body        a finding bullet in the summary whose path never received an
 *               inline review comment from the reviewer. Fingerprinted from
 *               its content so the key is stable while the finding is.
 *   unaccounted the reviewer declares "N finding(s) without a diff-anchorable
 *               line"; if fewer than N were classified above, the shortfall is
 *               reported rather than rounded down. Fail closed — an
 *               unexplained gap must block convergence, not vanish into it.
 *   review-body a review-object reviewer writes no sticky: its findings are
 *               the entries in every one of its reviews' bodies
 *               (`lib/review-body.ts`), with an `unaccounted` slot for each
 *               entry the parser cannot read.
 *
 * "Answered" is mechanical, never inferred from prose: a top-level comment
 * carrying `<!-- drive-pr-addressed: <fingerprint> -->`. `answer-summary-finding.ts`
 * writes that marker alongside an outcome token, so the harvesting contract
 * holds for summary findings exactly as it does for threads. A FIX-DEPENDENT
 * answer carries `<fingerprint>@<sha>#<round>` instead, and is scoped to where
 * the reviewer's own review sits relative to that head: honoured while the
 * review is BEHIND it, for one further head where the review sits exactly AT it
 * and the fingerprint is carried only in the reviewer's backlog blob. See
 * `collectAddressed` for the marker rules.
 *
 * Usage:
 *   bun summary-findings.ts [PR] [--json] [--configured-reviewer-only]
 *
 * `--configured-reviewer-only` reads no sticky unless the repository names an
 * AI reviewer (`reviewerExpected`), and without one reports no findings before
 * reading the PR's comments at all; drive-pr's gate and its round enumeration
 * (SKILL.md § 2) pass it.
 *
 * Exits 0 with the report on stdout; 1 if the PR's comments cannot be read.
 */

import { fingerprintOf } from "./lib/finding-fingerprint.ts";
import { cachedRepoView } from "./lib/gh-conditional.ts";
import {
  DEFAULT_REVIEWED_SHA_MARKER,
  DEFAULT_STICKY_MARKER,
  isReviewerLogin,
  reviewedShaMarker,
  reviewerApp,
  reviewerEvidence,
  reviewerExpected,
  stickyMarker,
} from "./lib/overlay.ts";
import { ghCall } from "./lib/proc.ts";
import { type PagedRead, slurpPages } from "./lib/paged-read.ts";
import {
  type BacklogEntry,
  type BodyFinding,
  decodeBacklog,
  parseBodyFindings,
  partitionBacklog,
} from "./lib/backlog.ts";
import { reviewBodyReport } from "./lib/review-body.ts";
import {
  type ReviewerPosition,
  reviewerPosition,
} from "./lib/reviewer-position.ts";
import {
  type ReviewBodyFormat,
  reviewerProfile,
} from "./lib/reviewer-profiles.ts";
import { reviewsBy } from "./lib/status/review-object.ts";
import {
  parseReviewRound,
  reviewerStickyBody,
  reviewedShaIn,
} from "./lib/status/reviewer-sticky.ts";
import {
  parseDeclaredUnanchored,
  selectReviewerSticky,
} from "./lib/status/summary-sticky.ts";

export { parseDeclaredUnanchored };
import {
  headerOf,
  SEVERITY_FIELD,
  severityOf,
  stickySeverityOf,
} from "./lib/severity-formats.ts";

export { fingerprintOf, type ReviewerPosition, reviewerPosition, severityOf };

export {
  type BacklogEntry,
  type BodyFinding,
  decodeBacklog,
  parseBodyFindings,
};

// ── Pure parsing (unit-tested directly; no network) ─────────────────────────

export interface SummaryFinding {
  fingerprint: string;
  source: "backlog" | "body" | "review-body" | "unaccounted";
  path: string;
  line: number | null;
  severity: string;
  /** A `categories` token from `.config/review-triage.yaml`, or `unknown` — see `categoryOf`. */
  category: string;
  text: string;
  addressed: boolean;
}

export interface SummaryReport {
  pr: number;
  stickyCommentId: number | null;
  declaredUnanchored: number;
  total: number;
  findings: SummaryFinding[];
  unaddressed: SummaryFinding[];
  ignoredBacklog: BacklogEntry[];
  /**
   * Fingerprints of the backlog entries still counted as open work that the
   * reviewer renders in its not-blocking section (`renderedNotBlocking` in `lib/backlog.ts`). The
   * divergence stop leaves them out of its count; convergence still counts
   * them.
   */
  notBlockingBacklog: string[];
}

/**
 * The reviewer's sticky comment is marked; every other bot comment is not.
 *
 * Read from the SAME setting `drive-status.ts` uses (`review.sticky_marker`
 * or `DRIVE_PR_STICKY_MARKER`), because this parser and that script have to
 * be looking at the same comment. Hard-coding the default here means a
 * configured marker sends `drive-status.ts` to a custom sticky while this
 * parser finds no sticky at all — and "no sticky" is read as zero summary
 * findings, so a custom-marker repo converges over every unanchored finding
 * the reviewer ever posted.
 */
// Configuration can be malformed while the auditor imports this parser to
// validate it. Read its override only while parsing a review response.
export const STICKY_MARKER = DEFAULT_STICKY_MARKER;

/**
 * The marker the reviewer stamps its reviewed SHA into. Same override, same
 * reason: the reviewed SHA scopes the unaccounted-slot keys, so failing to read
 * it silently degrades every slot to the shared `nohead` scope, where an answer
 * given on one head marks a *different* finding addressed on the next.
 */
export const SHA_MARKER = DEFAULT_REVIEWED_SHA_MARKER;

/** Extract the reviewed SHA the reviewer stamped, under whatever marker name. */
export function reviewedShaFrom(body: string): string | undefined {
  return reviewedShaIn(body, reviewedShaMarker()) || undefined;
}

/**
 * Marker a driver writes to record that a summary finding has been answered.
 *
 * A FIX-DEPENDENT answer carries the SHA its fix landed on, and the reviewer
 * round it was posted in (`<fingerprint>@<sha>#<round>`); a durable one carries
 * the bare fingerprint. See `collectAddressed` for why the two are not
 * interchangeable. The round records when the answer was posted; no rule
 * reads it to decide whether the answer still stands.
 */
import { ADDRESSED_MARKER } from "../../../shared/summary-answer-blocks.ts";
export { ADDRESSED_MARKER };

export interface MarkerPayload {
  fingerprint: string;
  /** `''` for a durable marker, which names no head. */
  sha: string;
  /** The reviewer round the marker was posted in; null when it carries none. */
  round: number | null;
}

/**
 * Split a marker's payload into its parts — the ONE parser, shared by
 * `collectAddressed` and `findExactMarkers`.
 *
 * Shared rather than duplicated because the two ask different questions of the
 * same bytes ("is this finding still open" vs "would posting this duplicate an
 * existing comment"), and a grammar that drifts between them means a driver
 * writes markers one of them can no longer read — the finding then either never
 * retires or gets answered twice.
 *
 * Suffixes are stripped OUTSIDE-IN — round, then SHA — because that is the
 * order they were added in and the only order that keeps an older, roundless
 * marker parsing identically. A payload whose `#` suffix is not all digits is
 * NOT a round, so it stays part of the SHA and the marker simply fails to match
 * any real head: fail-closed, in the direction that costs a re-answer rather
 * than a suppressed live finding.
 *
 * A round suffix is only ever stamped on the fix-dependent `@sha` shape
 * (`answer-summary-finding.ts`'s `roundSuffix` rides along on `suffix`, which
 * is empty for a durable marker) — so an all-digit `#` suffix with no `@`
 * anywhere before it is not a round either, for the same reason a non-digit
 * one isn't: nothing produces that shape, and treating it as one would strip
 * a real trailing `#7` off a durable marker's fingerprint before the SHA check
 * ever sees it, silently mis-keying the marker.
 *
 * That `@` must also have a NONEMPTY sha after it, not merely be present
 * somewhere earlier in the payload: `abc@#7` has an `@`, but nothing between
 * it and the `#`, so stripping `#7` as a round would leave `abc@` — an EMPTY
 * sha — which the fingerprint/sha split below reads back as sha `''`, the
 * exact shape `collectAddressed` treats as a bare, DURABLE marker. That
 * silently coerces a malformed fix-dependent attempt into a permanent answer
 * for `abc`, the same mis-keying this round-suffix guard exists to prevent
 *. Requiring the last `@` before the `#`
 * to be followed by at least one character closes this the same way: the
 * round is not stripped, so `abc@#7` falls through to the ordinary fingerprint
 * fingerprint/sha split — a NONEMPTY sha `'#7'` that matches no real head,
 * fail-closed in the same direction as the non-digit case above.
 */
export function parseMarkerPayload(raw: string): MarkerPayload {
  const hash = raw.lastIndexOf("#");
  const roundPart = hash === -1 ? "" : raw.slice(hash + 1);
  const beforeHash = hash === -1 ? "" : raw.slice(0, hash);
  const at = beforeHash.lastIndexOf("@");
  const round =
    at !== -1 && at < beforeHash.length - 1 && /^\d+$/.test(roundPart)
      ? Number.parseInt(roundPart, 10)
      : null;
  const rest = round === null ? raw : beforeHash;
  const restAt = rest.lastIndexOf("@");
  return {
    fingerprint: restAt === -1 ? rest : rest.slice(0, restAt),
    sha: restAt === -1 ? "" : rest.slice(restAt + 1),
    round,
  };
}

/**
 * The identifier grammar a fingerprint MUST obey, because the marker is the
 * only channel it ever travels through and that channel is lossy:
 *
 *   whitespace  the marker regex captures `[^\s>]+`, so a fingerprint with a
 *               space (or tab, or any other `\s` character) is truncated at it;
 *   `>`         the same capture stops there too, ending the HTML comment
 *               early and truncating the fingerprint identically;
 *   `@`         `parseMarkerPayload` splits the captured value at its LAST `@`
 *               and reads the suffix as a landed SHA, so `abc@def` is written
 *               whole and read back as `abc`.
 *
 * Any of those keys the answer to a fingerprint that is not the finding's,
 * so the finding stays unaddressed on every later head and the drive can never
 * converge. That is a LIVENESS failure, and the only place to catch it is where
 * the identifier enters — a consumer-side special case for `@` would just move
 * the ambiguity, since a real SHA suffix and a fingerprint containing `@` are
 * indistinguishable once written.
 *
 * `#` is EXCLUDED here too, but no longer for a round-trip ambiguity: since
 * `parseMarkerPayload` only reads a trailing `#<digits>` as a round when an
 * `@` precedes it (the shape `answer-summary-finding.ts` actually stamps), a
 * `#` with no preceding `@` — durable or embedded inside a fix-dependent
 * fingerprint before its own `@sha` — now round-trips exactly (see
 * `parseMarkerPayload`'s test cases). It stays out of the allowlist anyway:
 * no current producer (the reviewer's hex digests, `fingerprintOf`'s, or
 * `unaccounted-<sha12>-<n>`) ever emits one, and admitting it buys nothing
 * while adding one more character whose safety depends on this parser's
 * exact splitting order rather than being unconditionally safe on its own.
 *
 * Deliberately an allowlist, not a denylist of the specific characters known
 * to hurt the marker channel today: it is the format every producer already
 * emits, so anything outside it means the identifier we key everything on
 * moved under us.
 */

/**
 * Every fingerprint the sticky's own BODY bullets carry — the findings the
 * reviewer judged freshly on this head, as opposed to carrying forward.
 *
 * Computed over ALL bullets, not just the ones `classify` reports as
 * summary-only: a bullet that found an inline anchor is a fresh judgment too,
 * and this set is only ever SUBTRACTED from an exemption, so the wider read is
 * the fail-closed one.
 */
function bodyFingerprintsOf(stickyBody: string): Set<string> {
  return new Set(
    parseBodyFindings(stickyBody).map((f) =>
      fingerprintOf(f.path, f.line, f.text),
    ),
  );
}

/**
 * Both exemption sets `collectAddressed` keys on, read off the same sticky
 * `classify()` parses — the whole backlog blob (the one-head `at` grace) and
 * the non-blocking `reason: "winddown-deferred"` subset (the expiry
 * exemption).
 *
 * Named functions rather than inlined expressions, because the CLI and the
 * probes that cover them would otherwise be hand-copies — and a hand-copy
 * agrees with itself. Narrowing `backlogFingerprintsOf` back to the winddown
 * subset passed the entire suite while the test re-implemented it inline, which
 * is exactly the regression that reproduces the measured non-convergence for a
 * plain "Beyond this PR" carry-forward.
 *
 * BOTH subtract `bodyFingerprintsOf`, and that is what makes them agree with
 * the rule they exist to implement rather than merely with the reviewer's
 * blob. Each exemption's premise is that a re-emission FALSIFIES NOTHING: a
 * backlog entry is carried forward by its original `firstRound` rather than
 * re-derived from the diff, and a winddown-deferred one is forwarded without
 * being re-verified at all. A fingerprint the sticky ALSO emits as a body
 * bullet has that premise fail — the reviewer did judge it, on this head — so
 * honouring a fix-dependent marker for it would clear a live finding on the
 * strength of an exemption whose reason does not apply. The fingerprint is a
 * single global key, so there is no "clear the backlog copy but keep the body
 * one" to fall back to; the only honest answer is to expire the marker and
 * re-ask, which costs one round.
 *
 * Subtracting rather than refusing the sticky outright: dual emission is
 * anomalous reviewer output, but unlike a duplicate fingerprint WITHIN the
 * backlog (which `decodeBacklog` rejects, because it collapses two findings
 * into one key) it loses nothing — the finding stays enumerated and stays open
 * work. Refusing would block the whole report on it instead.
 *
 * `decodeBacklog` throws on a malformed blob either way (`classify` would too),
 * so calling it here first moves the INDETERMINATE exit earlier, not wider.
 */
export function backlogFingerprintsOf(stickyBody: string): Set<string> {
  const body = bodyFingerprintsOf(stickyBody);
  return new Set(
    decodeBacklog(stickyBody)
      .map((e) => e.fingerprint)
      .filter((fp) => !body.has(fp)),
  );
}

export function winddownFingerprintsOf(stickyBody: string): Set<string> {
  const body = bodyFingerprintsOf(stickyBody);
  return new Set(
    decodeBacklog(stickyBody)
      .filter((e) => e.reason === "winddown-deferred" && e.blocking !== true)
      .map((e) => e.fingerprint)
      .filter((fp) => !body.has(fp)),
  );
}

/**
 * The `🏷️ category: <token>` field the reviewer renders next to severity on
 * both an inline finding's tag line and a backlog/body bullet's header — per
 * the reviewer's own contract, "A consumer reads it with `/🏷️ category:
 * ([a-z-]+)/` — as simple as severity's."
 *
 * Scoped to `headerOf`'s block, same as `severityOf`, for the same reason: an
 * unscoped search would misread the token if a finding's own body prose ever
 * quoted the tag as an example, the exact decoy class documented on
 * `severityOf`. But `headerOf`'s block can itself span SEVERAL lines before
 * the first blank line — a title line, then the real tag line — and
 * `severityOf` closed that exact gap only after three fixes by anchoring
 * `SEVERITY_FIELD` to line 0 with `^` and deliberately no `m` flag.
 * `CATEGORY_FIELD` cannot reuse that trick verbatim — the tag sits AFTER the
 * severity token on its line, never at column 0 — so the match target here is
 * narrowed to the header's OWN line 0 instead: a decoy on a later header line
 * (before the first blank line) is therefore invisible to this search,
 * matching `severityOf`'s guarantee by a different mechanism aimed at the
 * same property.
 *
 * No taxonomy check here: `.config/review-triage.yaml`'s `categories:` list is
 * the vocabulary, and it is loaded dynamically (may gain entries; a value is
 * "added but never renamed"). Validating against it is
 * `triage-ladder.ts`'s job at the point a value is actually acted on — this
 * function only extracts what the reviewer wrote, matching the upstream
 * contract's own stated simplicity.
 *
 * Line-0 scoping alone still leaves the token unanchored WITHIN line 0, and
 * two more decoys on this exact function each defeated a
 * punctuation-proximity patch: requiring "some `·` (or line start) precedes
 * the tag" accepted `Fix parsing of · 🏷️ category: security` (a coincidental
 * `·` in prose, not a field separator) and `🏷️ category: security is valid
 * syntax` (nothing genuine precedes it at all) equally as a real field —
 * because neither decoy was ever checked against what the OTHER side of that
 * separator actually is.
 * The permissive token class `[a-z][a-z-]*` had the same shape of bug on the
 * right: `security_critical` and `security-` both truncated to a
 * plausible-looking `security` instead of failing to parse.
 *
 * Both close under one invariant instead of two more patches: a genuine
 * `🏷️ category:` field is never the header's only or leading `·`-joined
 * segment — severity always leads — so this parses line 0 as actual
 * `·`-delimited fields rather than searching for the tag as a substring.
 * Field 0 must end in a real severity token (bold word; the badge form never
 * co-occurs with a category tag in the observed emissions, so it is not
 * matched here) before the one field right after it is trusted as the
 * category — never a later one: the tag's own contract renders it "next to
 * severity", and every observed emission (including the nested-`·`
 * `compliance (correctness · beyond-pr)` nesting above) puts it there, so a
 * match is only ever legitimate at that position. Scanning every later field
 * instead let a prose field between severity and the real tag — or a
 * fabricated tag quoted further along the line — be read as the category (`🟡
 * **medium** · confidence: high — Explain separator · 🏷️ category: security`
 * has no genuine category at all, yet the old loop reached field 2 and accepted
 * it). A standalone `🏷️ category: X` has no leading field at all and fails
 * immediately; `Fix parsing of · 🏷️ category: X` has a field 0 of `Fix parsing
 * of`, which does not end in a severity token, so it fails the same way — the
 * coincidental `·` bought it nothing. The token itself is bounded with
 * `(?=\s|$)` rather than left open on the right, so `security_critical` fails
 * to match at all (falling through to `unknown`) instead of matching a
 * truncated prefix.
 *
 * The right boundary itself needs the same anchoring: `(?=\s|$)` only
 * checked the character immediately after the token, not that nothing else
 * followed it on this (already `·`-split) field — so `🏷️ category: security
 * is valid syntax` matched `security` and stopped there, silently discarding
 * `is valid syntax` as if that trailing prose were a separate field.
 * `(?=\s*(?:$|·|\)` requires the token be followed only by the true end of
 * the field, a (mid-parenthetical) `·`, or an opening paren — the shape the
 * accepted `category: compliance (correctness · beyond-pr)` case above
 * actually needs, since the nested `·` inside that annotation splits the
 * field again and leaves `(correctness` dangling after `compliance`. A bare
 * `$` anchor (available only because the call site already trims each field)
 * would have closed the decoy but broken that accepted case.
 */
/**
 * Field 0 must be a genuine severity field END TO END, not merely a field
 * that ENDS WITH a bold severity token: `\*\*(?:blocker|...)\*\*\s*$` alone
 * matched `Fix the **medium**` — a title, not a severity field, since
 * `severityOf()` requires nothing but permitted decoration (whitespace,
 * emoji, VS16, ZWJ) before the token, and `Fix the ` fails that. Reading this
 * lead field more loosely than `severityOf` itself fabricated a category on a
 * header `severityOf` classifies `unknown`, contaminating category metrics and
 * able to wrongly admit a finding through a late-round `categories` clause.
 *
 * Derived from `SEVERITY_FIELD` itself (its source plus an end anchor) rather
 * than a hand-written duplicate, so a future change to what counts as
 * permitted decoration there cannot silently leave this one lagging behind —
 * the exact way this field ended up wrong the first time.
 */
const CATEGORY_LEAD_FIELD = new RegExp(
  `${SEVERITY_FIELD.source}$`,
  SEVERITY_FIELD.flags,
);
const CATEGORY_FIELD =
  /^🏷️\s*category:\s*([a-z]+(?:-[a-z]+)*)(?=\s*(?:$|·|\())/u;

/**
 * `🏷️ category: data-integrity` → `data-integrity`; no token at all — the
 * backward-compatible shape the reviewer emits for an uncategorized finding,
 * and every finding that predates the category tag — → `unknown`. Never a parse
 * error: an absent category changes nothing downstream (`review-triage.yaml`'s
 * `categories` clause can only ever ADMIT a finding, never decline one on the
 * strength of `unknown`).
 *
 * CodeRabbit's header (the `pipe-fields` shape in `lib/severity-formats.ts`)
 * also carries a category-shaped field — `**🩺 Stability & Availability**`, the
 * lead field ahead of its severity — but it is deliberately left unmapped
 * here: it is freeform prose, not the closed `categories:` vocabulary in
 * `review-triage.yaml`, and no confirmed table from CodeRabbit's freeform
 * phrasing onto that fixed taxonomy exists yet. It reads `unknown`, which is
 * safe by the same contract as the older shape above — `category` is
 * deliberately absent from `fail_open.inert_when_unknown`, so an unreadable
 * category never disarms the ladder the way an unreadable severity does; it
 * only forgoes the admission a correct mapping might have granted.
 */
export function categoryOf(text: string): string {
  const line0 = headerOf(text).split("\n", 1)[0] ?? "";
  const fields = line0.split("·");
  if (fields.length < 2 || !CATEGORY_LEAD_FIELD.test(fields[0]?.trim() ?? "")) {
    return "unknown";
  }
  const m = fields[1]?.trim().match(CATEGORY_FIELD);
  return m ? (m[1] ?? "").toLowerCase() : "unknown";
}

export interface ClassifyInput {
  pr: number;
  stickyCommentId: number | null;
  stickyBody: string;
  /**
   * The sticky's author login. Its bullets are read with that reviewer's
   * severity formats plus Jig's own; absent, with Jig's own alone.
   */
  stickyAuthor?: string | null;
  /**
   * Keys of findings that DID receive an inline reviewer comment in the round
   * this sticky describes — `path:line`, or bare `path` for a comment whose
   * anchor has gone outdated.
   *
   * Every property of this key was learned the hard way. It is scoped to the
   * ROUND, so a thread on `a.ts` in round 1 does not hide every later
   * summary-only finding on `a.ts` forever. And it is keyed per FINDING, not
   * per path, so when two findings target `a.ts` and only one gets a thread,
   * the other still counts as open work instead of being suppressed by its
   * neighbour.
   */
  /**
   * One entry per inline comment the reviewer anchored THIS round, duplicates
   * preserved. A Set here would be the bug: `path:line` is a position, not an
   * identity, so deduplicating it makes one comment stand for any number of
   * findings sharing that position.
   */
  anchoredKeys: string[];
  addressedFingerprints: Set<string>;
  /**
   * The head the sticky says it reviewed. Scopes the `unaccounted` slot keys —
   * see below.
   */
  reviewedSha?: string;
}

/** `path:line`, or bare `path` when the finding carries no line. */
export function anchorKey(path: string, line: number | null): string {
  return line == null ? path : `${path}:${line}`;
}

export function classify(input: ClassifyInput): SummaryReport {
  const { stickyBody, anchoredKeys, addressedFingerprints } = input;
  const findings: SummaryFinding[] = [];
  const seen = new Set<string>();

  const push = (f: Omit<SummaryFinding, "addressed">) => {
    if (seen.has(f.fingerprint)) return;
    seen.add(f.fingerprint);
    findings.push({
      ...f,
      addressed: addressedFingerprints.has(f.fingerprint),
    });
  };

  const bullets = parseBodyFindings(stickyBody);
  const { blockingBacklog, ignoredBacklog, notBlockingBacklog } =
    partitionBacklog(stickyBody, bullets);
  for (const e of blockingBacklog) {
    push({
      fingerprint: e.fingerprint,
      source: "backlog",
      path: e.path,
      line: e.line ?? null,
      severity: e.severity ?? "unknown",
      category: e.category ?? "unknown",
      text: e.comment ?? "",
    });
  }

  // A bullet with no matching inline comment IN THIS ROUND had nowhere to
  // anchor. `path:line` is a POSITION, not an identity, so the reviewer's
  // inline comments cannot be matched to bullets one-for-one: two bullets can
  // share a position, and an inline comment whose anchor went OUTDATED reports
  // no line at all, leaving only the bare path.
  //
  // The comments therefore anchor a GROUP of bullets or none of it — never a
  // subset chosen by document order. Order-based consumption looks like the
  // careful answer and is the worse one: with two bullets on `a.ts:40` and a
  // single inline comment there, it declares the FIRST bullet anchored and
  // reports the second as summary-only. If the comment was in fact the second
  // one's, the genuinely unthreaded first bullet has vanished, while the
  // already-threaded second is duplicated as summary work — and resolving that
  // thread plus answering the duplicate drives both counts to zero without
  // anyone ever dispositioning the finding that had no thread.
  //
  // Nothing available distinguishes the two: the sticky's bullet text is a
  // condensed restatement of the inline comment's, not a copy, and the bullets
  // carry no fingerprint of their own. So an incomplete cover is treated as
  // what it is — unresolved ambiguity — and every bullet in the group stays
  // open work. That is the fail-closed direction: at worst it asks for an
  // answer that already has a thread, which costs one comment; the other
  // direction costs a live finding, silently.
  const slots = new Map<string, number>();
  for (const k of anchoredKeys) slots.set(k, (slots.get(k) ?? 0) + 1);
  const byExactKey = new Map<string, BodyFinding[]>();
  for (const f of bullets) {
    const key = anchorKey(f.path, f.line);
    const group = byExactKey.get(key);
    if (group) group.push(f);
    else byExactKey.set(key, [f]);
  }
  // The pools below differ in which bullets may draw from them, and that is
  // what decides the shape:
  //
  //   EXACT (`path:line`)  usable only by bullets at that position, so spending
  //                        it is never a choice between candidates;
  //   BARE (`path`)        left by an inline comment whose anchor went OUTDATED,
  //                        so it names a file and nothing finer — ANY bullet on
  //                        that file could be the one it belongs to.
  //
  // Exact slots are therefore spent first, per group. Whatever a group cannot
  // cover that way becomes the FILE's leftover demand, and the bare pool clears
  // that demand only if it covers ALL of it. A partial bare cover cannot say
  // which bullet it belongs to, and picking one hides a genuinely unthreaded
  // finding while duplicating a threaded one as summary work — the failure
  // order-based consumption produced. So it stays ambiguous and every leftover
  // bullet on the file stays open.
  //
  // Counting the pools together per group (rather than exact-then-bare-per-file)
  // is what makes the MIXED case work: two bullets on `a.ts:40`, one with an
  // exact comment and one whose anchor went outdated, are two real inline
  // comments, and asking each pool to cover the group alone rejects them both —
  // leaving the driver demanding answers for findings that already have threads,
  // which it can never converge past.
  const open = new Set<BodyFinding>();
  /** Per file: how many bare slots the short groups need, and who is at stake. */
  const leftoverByPath = new Map<
    string,
    { demand: number; bullets: BodyFinding[] }
  >();
  for (const [key, group] of byExactKey) {
    const first = group[0];
    if (first === undefined) continue;
    const path = first.path;
    // A bullet with no line keys on the bare path already (`anchorKey`), so its
    // "exact" pool IS the bare pool; it has no unambiguous slots of its own.
    const exact = key === path ? 0 : (slots.get(key) ?? 0);
    const fromExact = Math.min(exact, group.length);
    if (fromExact > 0) slots.set(key, exact - fromExact);
    const short = group.length - fromExact;
    if (short === 0) continue;
    const pending = leftoverByPath.get(path) ?? { demand: 0, bullets: [] };
    pending.demand += short;
    // Only the SHORTFALL is demanded, but the whole group is at stake: if the
    // file's bare pool cannot meet the demand, there is no telling which
    // bullets the exact slots already spoke for either.
    pending.bullets.push(...group);
    leftoverByPath.set(path, pending);
  }
  for (const [path, { demand, bullets }] of leftoverByPath) {
    // Demand is summed across the whole FILE, because one bare slot cannot
    // stand for a bullet on line 40 and another on line 99 at once.
    const bare = slots.get(path) ?? 0;
    if (bare >= demand) {
      slots.set(path, bare - demand);
      continue;
    }
    for (const f of bullets) open.add(f);
  }
  // Reported in the sticky's own bullet order, so an operator reading the
  // report can follow it down the comment.
  const bodyOnly = bullets.filter((f) => open.has(f));
  for (const f of bodyOnly) {
    push({
      fingerprint: fingerprintOf(f.path, f.line, f.text),
      source: "body",
      path: f.path,
      line: f.line,
      // Every body bullet is a line of the sticky, found by its author's
      // login (`reviewerSticky`), so it is read in that author's formats.
      severity: stickySeverityOf(f.text, input.stickyAuthor),
      category: categoryOf(f.text),
      text: f.text,
    });
  }

  const declared = parseDeclaredUnanchored(stickyBody);
  // The declaration describes findings in the summary above the backlog.
  // Blocking backlog entries can account for slots as well. Informational
  // carry-forwards belong to a separate cohort and cannot explain a shortfall.
  // The declaration is about unanchored summary bullets, not separately
  // carried backlog entries. A backlog finding must not consume its slot.
  const classified = new Set(
    bodyOnly.map((f) => fingerprintOf(f.path, f.line, f.text)),
  ).size;
  const shortfall = Math.max(0, declared - classified);
  // Scoped to the reviewed HEAD, not to the sticky comment id. The sticky is
  // upserted, so its id is stable across every round — keying a slot on it means
  // slot 2 of round 5 inherits the answer given to a completely different,
  // unidentifiable finding that occupied slot 2 in round 2. These slots exist
  // precisely because we could NOT identify their content, so they get the most
  // volatile key available and are re-asked whenever the head moves. Content-
  // fingerprinted findings keep their stable keys: re-asking a standing
  // wont-fix every push is churn, but re-asking an unidentifiable finding is
  // the only honest option.
  const slotScope = (input.reviewedSha ?? "").slice(0, 12) || "nohead";
  for (let i = 0; i < shortfall; i++) {
    push({
      fingerprint: `unaccounted-${slotScope}-${i + 1}`,
      source: "unaccounted",
      path: "(unknown)",
      line: null,
      severity: "unknown",
      category: "unknown",
      // Report the count the shortfall was actually computed from — captured
      // BEFORE this loop, since `findings` grows as slots are pushed. `bodyOnly`
      // is only one of the sources feeding it, so quoting that could claim zero
      // were classified while several backlog findings sit right above, and the
      // operator inspecting the unexplained slot is misdirected by the one line
      // that exists to direct them.
      text: `The reviewer declared ${declared} unanchored finding(s) but only ${classified} could be classified. Read the summary comment and answer this slot explicitly.`,
    });
  }

  return {
    pr: input.pr,
    stickyCommentId: input.stickyCommentId,
    declaredUnanchored: declared,
    total: findings.length,
    findings,
    unaddressed: findings.filter((f) => !f.addressed),
    ignoredBacklog,
    notBlockingBacklog,
  };
}

/**
 * A PR comment is world-writable. Anyone who can read the sticky comment can
 * read a finding's fingerprint and post the marker themselves, which would make
 * `drive-status.ts` treat the finding as answered and let the drive converge
 * over live work. So only comments from an author GitHub itself vouches for as
 * having write access to the repository count.
 *
 * `author_association` is the API's own answer to "who is this relative to the
 * repo", computed server-side; it cannot be spoofed by comment content.
 *
 * The set lives in `shared/trusted-authors.ts`, which every consumer reads
 * (this module re-exports it for drive-pr's own scripts), so every script
 * decides the same question about the same world-writable comment stream off
 * one set. `--trusted-associations` below stays as a read-only CLI surface
 * for callers outside this module graph (shell/jq tooling, ad-hoc
 * inspection) that cannot `import` a TypeScript constant.
 */
export { TRUSTED_ASSOCIATIONS };

/**
 * The closed outcome vocabulary, as `answer-summary-finding.ts` composes it and
 * `reply-to-thread.ts` enforces it: bold, lowercase, the body's literal opening.
 *
 * Anchored with no leading whitespace and with the `—` separator required,
 * because that is the exact prefix the sanctioned producer emits
 * (`**${outcome}** — ${reason}`) and the exact prefix `reply-to-thread.ts`
 * enforces on a thread reply. Tolerating indentation admitted a comment that
 * merely SHOWS the grammar — a trusted collaborator pasting an indented worked
 * example carrying both a token and a fingerprint marker — as a real answer,
 * retiring the finding from `unaddressed` with nobody having dispositioned it.
 *
 * A hand-written answer in a near-miss shape fails to match and the finding
 * stays open, which is the correct direction: it costs a re-answer through the
 * script, not a silently suppressed live finding.
 */
const OUTCOME_OPENER = /^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\* —/;

/**
 * The outcome a comment opens with, or null if it is not an answer at all.
 *
 * Trust is necessary but not sufficient: the comment must also BE an answer.
 * A trusted collaborator who merely quotes or documents a marker — pasting a
 * worked example into a design note, say — would otherwise retire the finding
 * from `unaddressed` without anyone having dispositioned it, and the drive
 * converges over live work.
 *
 * Requiring the outcome opener makes the marker meaningful rather than merely
 * present, and reuses the vocabulary the replies are already scored on, so an
 * answer that counts here is exactly an answer that counts in the sample. The
 * token itself is then load-bearing a second time, in `collectAddressed`.
 */
export function outcomeOf(body: string): string | null {
  return body.match(OUTCOME_OPENER)?.[1] ?? null;
}

export interface AddressedSource {
  body: string;
  authorAssociation: string;
}

/**
 * Outcomes that assert something about a COMMIT rather than about the finding's
 * merit, so an answer carrying one is only as good as the head it names.
 * `answer-summary-finding.ts` refuses to post either without `--pushed-sha`;
 * this set is the consumer half of the same contract, rejecting an undated one
 * that reached the PR by hand.
 */
export const FIX_DEPENDENT_OUTCOMES = new Set(["accepted", "moot"]);

export interface AddressedOptions {
  /**
   * Where the reviewer's own review sits relative to `sha`. Supplied by the CLI
   * from git ancestry against the sticky's reviewed SHA. ABSENT MEANS `past`:
   * an accepted marker we cannot date is one we cannot trust, and blocking
   * convergence is the safe direction.
   */
  reviewerPosition?: (sha: string) => ReviewerPosition;
  /**
   * Every fingerprint in the reviewer's own `ai-review-backlog` blob — the set
   * whose re-emission is a carry-forward rather than a judgment, so a marker
   * naming the head the reviewer is sitting ON is still honoured for it. Absent
   * means empty, i.e. no grace at all: fail closed. Build it with
   * `backlogFingerprintsOf`, which excludes any fingerprint the same sticky
   * also emits as a body bullet — that is a fresh judgment and the
   * carry-forward premise fails for it. See `collectAddressed`.
   */
  backlogFingerprints?: Set<string>;
  /**
   * Fingerprints the reviewer's own backlog carries with
   * `reason: "winddown-deferred"` and without `blocking: true`. A
   * fix-dependent marker for one of these is exempt from the position expiry
   * for as long as the reviewer keeps carrying the entry — never from the
   * dating requirement, which `collectAddressed` enforces by refusing the
   * exemption outright at position `unknown` (a marker SHA git cannot resolve
   * to a commit). Absent means empty: no exemption. Build it with
   * `winddownFingerprintsOf`, which applies the same body-bullet exclusion as
   * `backlogFingerprintsOf`. See `collectAddressed` for why re-emission
   * carries no falsification signal for exactly this set.
   */
  winddownDeferred?: Set<string>;
}

/**
 * An answer is durable or FIX-DEPENDENT, and the marker itself says which: a
 * bare `<fingerprint>` claims something about the finding that stays true on
 * every later head, while `<fingerprint>@<sha>` claims only "answered as of the
 * head I named".
 *
 * A fix-dependent answer stops counting once the reviewer's own review has
 * caught up to that head, because the reviewer re-emitting the same finding
 * there FALSIFIES it. An incomplete fix, a revert, or a regression from a later
 * round's own edit all reproduce the finding verbatim, so its content
 * fingerprint is unchanged and a durable marker would suppress the live
 * occurrence forever — false convergence by the same mechanism as the
 * zero-thread case in this file's header, one layer down.
 *
 * "Caught up" is a POSITION, not a boolean (`reviewerPosition`), because that
 * falsification premise holds for one of the two ways a review can be caught up
 * and not the other. A marker naming `sha` is honoured only here:
 *
 *   behind  the reviewed head is a strict ancestor of `sha`, so the review
 *           predates the fix and cannot have judged it. Every finding.
 *   at      the reviewer reviewed `sha` itself — and only for a fingerprint in
 *           `opts.backlogFingerprints`.
 *
 * The `at` grace is scoped to the backlog because that blob is, per the
 * reviewer's own contract, the set it deliberately holds OUT of inline review
 * ("Beyond this PR" entries, wind-down deferrals), carried forward by the
 * entry's original `firstRound` rather than re-derived from the current diff. An
 * entry's presence at head X is therefore not a judgment about X, and expiring
 * on it retires nothing. A FRESH judgment arrives as an inline thread or as an
 * unanchored body bullet (`source: 'body'`), and those self-clear when the
 * reviewer stops emitting them — there re-emission genuinely does falsify, so
 * the strict rule stays.
 *
 * A fingerprint the sticky emits BOTH ways is the case that decides which of
 * those two sentences wins, and the fresh judgment does. `backlogFingerprintsOf`
 * (and `winddownFingerprintsOf`) subtract the body bullets' fingerprints before
 * either exemption sees them, so a dual-emitted finding gets neither the
 * one-head grace nor the winddown exemption. It has to be settled at the set
 * rather than here: a fingerprint is one global key, `collectAddressed`
 * returns keys, and `classify`'s own dedup reports the pair as a single
 * finding — so honouring the marker for "the backlog copy" clears the
 * freshly-judged one with it.
 *
 * Without that grace a fix-dependent marker was inert on arrival. SKILL.md § 6
 * mandates push → `stamp-held` → `drive-status.ts --no-count` → answer, so by
 * the time the marker is posted the reviewer has already reviewed that exact
 * head: the position is `at` at answer time, every time. Measured across five
 * drives — up to six re-answers of one verified-fixed finding, with one drive
 * terminating `HITL_PARKED` instead of `CONVERGED` solely because of it.
 *
 * The grace is exactly ONE HEAD wide, and that bound is what makes it safe. Any
 * later push — a revert, a regression, a rebase — moves the reviewed SHA off the
 * marked one, the position becomes `past`, and the finding is re-asked.
 *
 * Past that one head, a THIRD clause keeps a narrower set alive, bounded along
 * a different axis. The position rule expires at the first later PUSH, and a
 * carry-forward survives pushes — measured: three consecutive rounds each
 * re-answering the same verified-fixed finding, and a second drive's
 * carry-forward. So the winddown clause below stands alongside it, bounded by
 * the reviewer's own disposition of the entry rather than by heads or rounds.
 *
 * That clause covers non-blocking `winddown-deferred` backlog entries. The
 * reviewer carries those forward UNCONDITIONALLY by their original firstRound —
 * it does not re-verify them against the current diff — so re-emission at a
 * later head says nothing about the fix, and expiring the marker turns a
 * correctly-fixed, correctly-answered finding into a loop the driver cannot
 * win (measured, as above). A fix-dependent marker whose fingerprint is in
 * `opts.winddownDeferred` therefore survives a `past` position on every later
 * round: answered once, it stays answered. It does NOT survive an `unknown`
 * one. The SHA is still required, and "required" means datable, not merely
 * present: `past` and `unknown` are both non-answers about the reviewer, yet
 * only `unknown` says the marker names no commit this repository has, so
 * ignoring position (which is this clause's whole point) must not extend to
 * ignoring that — a hand-written `@deadbeef…` marker earns nothing. Every
 * non-winddown finding keeps the full expiry — the reviewer DOES re-verify
 * those, so there re-emission still falsifies.
 *
 * Standing indefinitely suppresses nothing that holds the PR. The reviewer
 * itself declares these entries non-blocking, and `classify` reports them as
 * `ignoredBacklog`, work that needs no answer. A regression the reviewer
 * judges to block arrives as `blocking: true`, as a body bullet or as an inline
 * thread, and each of those is outside `winddownFingerprintsOf`'s set, so the
 * finding is asked again however long ago it was answered. The marker's
 * `#<round>` is not read here: it records when the answer was posted, and a
 * roundless marker is honoured on the same terms.
 *
 * Which outcomes are fix-dependent is NOT decided here, because it is not a
 * property of the word. `accepted` always is. `moot` usually is — a finding is
 * moot because the code it describes is gone, and this round is usually what
 * removed it, so a later round that reintroduces the code reintroduces the
 * finding. `rejected` / `wont-fix` / `deferred` are claims about the finding's
 * merit, which no later commit changes. `answer-summary-finding.ts` decides at
 * the point of answering, where the reason is known, and encodes the decision
 * in the marker; reading it back off the marker keeps one rule here instead of
 * a second copy of that taxonomy to drift.
 *
 * The outcome NAME is read only to reject the degenerate case: an `accepted` or
 * `moot` marker with no SHA cannot be dated, so it cannot be checked, and a
 * marker that cannot be checked must not retire a finding. Those are the two
 * outcomes that cannot be durable — one claims a fix landed, the other claims
 * code was removed, and both are assertions about a commit. A marker in that
 * shape is hand-written (the script always stamps them), so refusing it costs a
 * re-answer and buys back the suppression it would otherwise make permanent.
 *
 * Re-answering a finding the reviewer keeps re-emitting costs one round and can
 * land on a durable outcome. Failing the other way costs a live finding,
 * silently.
 */
export function collectAddressed(
  sources: AddressedSource[],
  opts: AddressedOptions = {},
): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `<!--\\s*${ADDRESSED_MARKER}:\\s*([^\\s>]+)\\s*-->`,
    "g",
  );
  const resolvePosition =
    opts.reviewerPosition ?? ((): ReviewerPosition => "past");
  // `resolvePosition` shells out to git (`reviewerPosition`, below) against a
  // SHA that only ever names one of a small handful of past heads, while this
  // loop revisits it once per marker across every trusted comment — memoizing
  // per call turns N marker occurrences of the same SHA into one subprocess
  // pair rather than N.
  const positionCache = new Map<string, ReviewerPosition>();
  const position = (sha: string): ReviewerPosition => {
    const cached = positionCache.get(sha);
    if (cached !== undefined) return cached;
    const computed = resolvePosition(sha);
    positionCache.set(sha, computed);
    return computed;
  };
  for (const body of trustedAnswerBlocks(sources)) {
    const outcome = outcomeOf(body);
    if (outcome === null) continue;
    for (const m of body.matchAll(re)) {
      const { fingerprint, sha } = parseMarkerPayload(m[1] ?? "");
      if (!sha) {
        if (FIX_DEPENDENT_OUTCOMES.has(outcome)) continue;
        out.add(fingerprint);
        continue;
      }
      // A marker survives under the clauses below, and they are cumulative
      // rather than alternatives to each other — neither subsumes the other:
      //
      //   behind          the review predates the fix, so it cannot have judged
      //                   it. Every finding, always.
      //   at + backlog    one head of grace for the whole backlog blob, because
      //                   a marker is ALWAYS posted at the reviewed head (§ 6's
      //                   push → stamp-held → status → answer ordering) and
      //                   would otherwise be inert on arrival.
      //   winddown        every head PAST that, for the narrower non-blocking
      //                   `reason: "winddown-deferred"` subset the reviewer
      //                   forwards without re-verifying — but only for a marker
      //                   whose SHA git can actually resolve (not `unknown`).
      //                   That clause ignores POSITION by design, never the
      //                   dating requirement.
      const where = position(sha);
      const honour =
        where === "behind" ||
        (where === "at" &&
          opts.backlogFingerprints?.has(fingerprint) === true) ||
        (where !== "unknown" &&
          opts.winddownDeferred?.has(fingerprint) === true);
      if (!honour) continue;
      out.add(fingerprint);
    }
  }
  return out;
}

function trustedAnswerBlocks(sources: AddressedSource[]): string[] {
  return sources
    .filter(
      (source) =>
        TRUSTED_ASSOCIATIONS.has(source.authorAssociation) &&
        outcomeOf(source.body) !== null,
    )
    .flatMap((source) => summaryAnswerBlocks(source.body));
}

/**
 * Was a SPECIFIC marker — this exact fingerprint, with this exact `@sha`
 * suffix (or no suffix at all, for a durable outcome) — already posted?
 *
 * Deliberately NOT `collectAddressed` + `reviewerPosition`: that pairing
 * answers a different question ("is this finding still open, given how far the
 * reviewer has read"), which expires a marker once the reviewer's review has
 * caught up to its SHA. Reusing it here — as an earlier version of the
 * `--check-addressed` CLI mode did — reintroduced the exact duplicate-post
 * bug this function exists to close: a
 * driver reconciling moments after its OWN successful post, once the
 * reviewer has simply caught up to that same SHA, would see its own marker
 * as expired and post a second one. Whether the reviewer has read a marker
 * is irrelevant to whether posting it again would duplicate it — that is a
 * fact about whether the exact comment already exists, full stop.
 *
 * The marker's ROUND is deliberately not compared. It records WHEN the answer
 * was posted, not what the answer claims, so comparing it would make a
 * reclaiming pass whose sticky has since advanced a round miss its own
 * predecessor's marker at the same SHA and post a duplicate — the same bug
 * again, reached through the round field. That holds for a winddown-deferred
 * fingerprint too: its answer stands on every later round (`collectAddressed`),
 * so a same-SHA marker from any earlier round is the answer already given, and
 * posting again would only duplicate it.
 */
export function findExactMarkers(
  sources: AddressedSource[],
  fingerprints: Set<string>,
  markerSha: string | undefined,
): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `<!--\\s*${ADDRESSED_MARKER}:\\s*([^\\s>]+)\\s*-->`,
    "g",
  );
  for (const body of trustedAnswerBlocks(sources)) {
    if (outcomeOf(body) === null) continue;
    for (const m of body.matchAll(re)) {
      const { fingerprint, sha } = parseMarkerPayload(m[1] ?? "");
      if (!fingerprints.has(fingerprint)) continue;
      if (markerSha ? sha === markerSha : sha === "") out.add(fingerprint);
    }
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
  author_association: string;
}
interface ReviewComment {
  path: string;
  /** Null once the anchor goes outdated; falls back to a bare-path match. */
  line: number | null;
  body: string;
  user: { login: string };
}

/**
 * Every outbound call is bounded. `drive-status.ts`'s poll `--timeout` only
 * measures BETWEEN calls, so an accepted-but-never-completed connection here
 * would hang the unattended driver past every deadline it advertises.
 *
 * The call goes through `lib/proc.ts` like every other `gh` call, so there is
 * one deadline implementation, and the raw-gh sweep covers this file too.
 */
async function gh(args: string[], answer = ghCall(args)): Promise<string> {
  const r = await answer;
  if (r.code !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${
        r.stderr.trim() ||
        (r.timedOut
          ? "killed by the GH_CALL_TIMEOUT deadline"
          : `exit ${r.code}`)
      }`,
    );
  }
  return r.stdout;
}

/** Every page of `path` (`gh api --paginate --slurp`), read as `read` says. */
function slurp(path: string, read: PagedRead): Promise<string> {
  const args = ["api", "--paginate", "--slurp", path];
  return gh(args, slurpPages(path, read));
}

/** A report observes comments; checking a marker before posting a reply reads fresh. */
async function issueCommentsFor(
  repo: string,
  prNumber: number,
  checkFingerprintsArg: string | undefined,
): Promise<IssueComment[]> {
  return JSON.parse(
    await slurp(
      `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
      checkFingerprintsArg === undefined ? "observed" : "fresh",
    ),
  ).flat();
}

/**
 * The reviewer's sticky summary comment, if any. With `configuredOnly` (the
 * drive's gate, `--configured-reviewer-only`), a repository that names no AI
 * reviewer has none to read; see `selectReviewerSticky` for the selection.
 */
export function reviewerSticky(
  comments: IssueComment[],
  configuredOnly: boolean,
): IssueComment | undefined {
  if (configuredOnly && !reviewerExpected()) return undefined;
  return selectReviewerSticky(
    comments,
    (body) =>
      decodeBacklog(body).length > 0 ||
      parseBodyFindings(body).length > 0 ||
      parseDeclaredUnanchored(body) > 0,
  );
}

function structuralStickyEvidence(sticky: IssueComment | undefined): {
  body: string | null;
  round: number | null;
  winddownDeferred: Set<string>;
} {
  const body = sticky
    ? reviewerStickyBody(sticky, isReviewerLogin, stickyMarker())
    : null;
  return {
    body,
    round: body ? parseReviewRound(body) : null,
    winddownDeferred: body ? winddownFingerprintsOf(body) : new Set<string>(),
  };
}

/** The PR number from `argv`, else the current branch's PR. */
async function resolvePrNumber(argv: string[]): Promise<number | undefined> {
  const pr =
    argv.find((a) => /^\d+$/.test(a)) ??
    (await gh(["pr", "view", "--json", "number", "-q", ".number"])).trim();
  const prNumber = Number.parseInt(pr, 10);
  return Number.isFinite(prNumber) ? prNumber : undefined;
}

/**
 * Whether this run has nothing to read on the PR: the drive's gate
 * (`configuredOnly`) where no AI reviewer is named, outside
 * `--check-addressed`.
 */
function readsNoComments(
  configuredOnly: boolean,
  checkFingerprints: string | undefined,
): boolean {
  return (
    configuredOnly && !reviewerExpected() && checkFingerprints === undefined
  );
}

/** The report for a PR with no reviewer summary to read. */
function emptyReport(pr: number): SummaryReport {
  return {
    pr,
    stickyCommentId: null,
    declaredUnanchored: 0,
    total: 0,
    findings: [],
    unaddressed: [],
    ignoredBacklog: [],
    notBlockingBacklog: [],
  };
}

/** The comments that may carry an answer marker: every non-reviewer comment. */
function markerSourcesOf(
  comments: IssueComment[],
): { body: string; authorAssociation: string }[] {
  return comments
    .filter((c) => !isReviewerLogin(c.user?.login ?? ""))
    .map((c) => ({
      body: c.body ?? "",
      authorAssociation: c.author_association ?? "",
    }));
}

/**
 * The format of the review-object reviewer's review bodies, whose entries are
 * its summary-only findings; none for a reviewer that writes a sticky, or
 * whose profile names no format.
 */
function reviewBodyFormat(): ReviewBodyFormat | undefined {
  if (reviewerEvidence() !== "review_object") return undefined;
  return reviewerProfile(reviewerApp())?.bodyFormat;
}

/**
 * Print the report of a review-object reviewer, which writes no sticky: its
 * summary-only findings are the entries in the bodies of its reviews
 * (`lib/review-body.ts`), each dated against the newest review that carries
 * it. Exits 1 when its reviews cannot be read.
 */
async function reviewBodyReportFor(
  pr: number,
  repo: string,
  comments: IssueComment[],
  format: ReviewBodyFormat,
): Promise<SummaryReport | null> {
  const login = `${reviewerApp()}[bot]`;
  const [owner = "", name = ""] = repo.split("/");
  const reviews = await reviewsBy(owner, name, String(pr), login);
  if (reviews === null) return null;
  const sources = markerSourcesOf(comments);
  const addressedAt = (commit: string) =>
    collectAddressed(sources, {
      reviewerPosition: (sha) => reviewerPosition(sha, commit),
    });
  const report = { pr, login, format, reviews, addressedAt };
  return reviewBodyReport(report);
}

/**
 * Read the normal summary-only finding report in this process. Callers inside
 * a status evaluation share its observed issue-comment and review reads with
 * the other evidence gathered for that evaluation.
 */
export async function summaryReport(
  prNumber: number,
  repo: string,
  configuredReviewerOnly: boolean,
  comments?: IssueComment[],
): Promise<SummaryReport | null> {
  try {
    if (readsNoComments(configuredReviewerOnly, undefined))
      return emptyReport(prNumber);

    const issueComments =
      comments ?? (await issueCommentsFor(repo, prNumber, undefined));
    const bodyFormat = reviewBodyFormat();
    if (bodyFormat !== undefined)
      return reviewBodyReportFor(prNumber, repo, issueComments, bodyFormat);
    const sticky = reviewerSticky(issueComments, configuredReviewerOnly);
    // Selection is deliberately based on the structural body. Keep using that
    // exact body below: parsing the raw comment after selection would let a
    // fenced or quoted example alter the selected summary's evidence.
    const { body: stickyBody, round: stickyRound } =
      structuralStickyEvidence(sticky);
    if (!sticky || stickyBody === null) return emptyReport(prNumber);

    const reviewComments: ReviewComment[] = JSON.parse(
      await slurp(
        `repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
        "observed",
      ),
    ).flat();
    const anchoredKeys =
      stickyRound === null
        ? []
        : reviewComments
            .filter((c) => isReviewerLogin(c.user?.login ?? ""))
            .filter((c) => parseReviewRound(c.body ?? "") === stickyRound)
            .map((c) => anchorKey(c.path, c.line ?? null));
    const reviewedSha = reviewedShaFrom(stickyBody);
    const addressed = collectAddressed(markerSourcesOf(issueComments), {
      reviewerPosition: (sha) => reviewerPosition(sha, reviewedSha),
      backlogFingerprints: backlogFingerprintsOf(stickyBody),
    });
    return classify({
      pr: prNumber,
      stickyCommentId: sticky.id,
      stickyBody,
      stickyAuthor: sticky.user.login,
      anchoredKeys,
      addressedFingerprints: addressed,
      ...definedFields({ reviewedSha }),
    });
  } catch (error) {
    // This boundary is evidence only: an unreadable response or reviewer
    // payload must reach evaluate() as INDETERMINATE, not reject its promise.
    swallow(error, "summary finding evidence is indeterminate");
    return null;
  }
}

function separateProbeArgs(rawArgv: string[]) {
  // Strip flag values before scanning for the PR number: a numeric
  // fingerprint or SHA prefix is also a valid value for those flags.
  const stripIdx = new Set<number>();
  const flagValue = (flag: string): string | undefined => {
    const index = rawArgv.indexOf(flag);
    if (index === -1) return undefined;
    stripIdx.add(index);
    stripIdx.add(index + 1);
    return rawArgv[index + 1];
  };
  const checkFingerprintsArg = flagValue("--check-addressed");
  const durableFingerprintsArg = flagValue("--check-durable-addressed");
  const markerShaArg = flagValue("--marker-sha");
  const argv = rawArgv.filter((_, i) => !stripIdx.has(i));

  return { argv, checkFingerprintsArg, durableFingerprintsArg, markerShaArg };
}

function printAddressProbe(
  pr: number,
  issueComments: IssueComment[],
  primaryArg: string,
  durableArg: string | undefined,
  markerSha: string | undefined,
  sticky: IssueComment | undefined,
): number {
  const round = sticky ? parseReviewRound(sticky.body) : null;
  const primary = primaryArg.split(",").filter(Boolean);
  const durable = durableArg?.split(",").filter(Boolean) ?? [];
  const requested = [...primary, ...durable];
  for (const fp of requested) {
    if (!MARKER_SAFE_FINGERPRINT.test(fp)) {
      console.error(
        `summary-findings: --check-addressed fingerprint '${fp}' is not MARKER_SAFE_FINGERPRINT-shaped`,
      );
      return 1;
    }
  }
  const sources = markerSourcesOf(issueComments);
  const found = findExactMarkers(sources, new Set(primary), markerSha);
  if (durable.length > 0) {
    for (const fp of findExactMarkers(sources, new Set(durable), undefined))
      found.add(fp);
  }
  console.log(
    JSON.stringify({
      pr,
      unaddressed: requested.filter((fp) => !found.has(fp)),
      round,
    }),
  );
  return 0;
}

async function main(): Promise<number> {
  const rawArgv = process.argv
    .slice(2)
    .filter((a) => a !== "--json" && a !== "--configured-reviewer-only");
  const configuredReviewerOnly = process.argv.includes(
    "--configured-reviewer-only",
  );

  // Printing mode, deliberately before anything that touches the network: a
  // read-only surface for the ONE definition of "an author GitHub vouches
  // for" for callers that cannot `import` this module's TRUSTED_ASSOCIATIONS
  // constant directly (shell/jq tooling, ad-hoc inspection) — every in-tree
  // TypeScript caller imports the constant instead.
  if (rawArgv.includes("--trusted-associations")) {
    for (const a of TRUSTED_ASSOCIATIONS) console.log(a);
    return 0;
  }

  // `--check-addressed fp1,fp2,... [--marker-sha SHA]` checks whether the
  // exact reply a caller is about to post already exists. Retrying after a
  // held-batch owner posted but stopped before releasing its claim must not
  // post a duplicate.
  //
  // Match the fingerprint and its `@sha` suffix exactly, or the bare
  // fingerprint for a durable outcome. Ignore marker expiry: the reviewer
  // reaching a fix may expire its suppression, but cannot undo its posting.
  // A later round answering a new fix supplies that fix's SHA, so the older
  // reply does not satisfy it. The report's `collectAddressed` and
  // `reviewerPosition` answer whether a finding remains suppressed and
  // therefore cannot serve this duplicate check.
  //
  const { argv, checkFingerprintsArg, durableFingerprintsArg, markerShaArg } =
    separateProbeArgs(rawArgv);
  if (
    durableFingerprintsArg !== undefined &&
    (!checkFingerprintsArg || !markerShaArg)
  ) {
    console.error(
      "summary-findings: --check-durable-addressed needs --check-addressed and --marker-sha",
    );
    return 1;
  }
  const prNumber = await resolvePrNumber(argv);
  if (prNumber === undefined) {
    console.error("summary-findings: could not resolve a PR number");
    return 1;
  }

  // The drive with no AI reviewer named reads no sticky, so it has no reason to
  // read the PR's comments either: a failed read here would hold back a
  // convergence that does not depend on them. `--check-addressed` matches
  // answer markers, which it still has to read.
  if (readsNoComments(configuredReviewerOnly, checkFingerprintsArg)) {
    console.log(JSON.stringify(emptyReport(prNumber)));
    return 0;
  }

  const repoView = await cachedRepoView([
    "--json",
    "owner,name",
    "-q",
    '.owner.login + "/" + .name',
  ]);
  if (repoView.code !== 0) {
    throw new Error(
      `gh repo view failed: ${
        repoView.stderr.trim() ||
        (repoView.timedOut
          ? "killed by the GH_CALL_TIMEOUT deadline"
          : `exit ${repoView.code}`)
      }`,
    );
  }
  const repo = repoView.stdout.trim();

  const issueComments = await issueCommentsFor(
    repo,
    prNumber,
    checkFingerprintsArg,
  );

  // Preserve the legacy round-qualified marker behavior for manual retries.
  if (checkFingerprintsArg !== undefined) {
    return printAddressProbe(
      prNumber,
      issueComments,
      checkFingerprintsArg,
      durableFingerprintsArg,
      markerShaArg,
      reviewerSticky(issueComments, configuredReviewerOnly),
    );
  }

  const report = await summaryReport(
    prNumber,
    repo,
    configuredReviewerOnly,
    issueComments,
  );
  if (report === null) {
    console.error(
      `summary-findings: cannot read ${reviewerApp()}[bot]'s reviews of #${prNumber}`,
    );
    return 1;
  }
  console.log(JSON.stringify(report));
  return 0;
}

// Run only as a script: the tests import this module for its helpers.
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(
      `summary-findings: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}
