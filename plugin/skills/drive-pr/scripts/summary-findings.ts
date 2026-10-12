#!/usr/bin/env bun
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
 *               stable fingerprints.
 *   body        a finding bullet in the summary whose path never received an
 *               inline review comment from the reviewer. Fingerprinted from
 *               its content so the key is stable while the finding is.
 *   unaccounted the reviewer declares "N finding(s) without a diff-anchorable
 *               line"; if fewer than N were classified above, the shortfall is
 *               reported rather than rounded down. Fail closed — an
 *               unexplained gap must block convergence, not vanish into it.
 *
 * "Answered" is mechanical, never inferred from prose: a top-level comment
 * carrying `<!-- drive-pr-addressed: <fingerprint> -->`. `answer-summary-finding.ts`
 * writes that marker alongside an outcome token, so the harvesting contract
 * holds for summary findings exactly as it does for threads. A FIX-DEPENDENT
 * answer carries `<fingerprint>@<sha>#<round>` instead, and is scoped to where
 * the reviewer's own review sits relative to that head: honoured while the
 * review is BEHIND it, for one further head where the review sits exactly AT it
 * and the fingerprint is in the reviewer's backlog blob, and — for the
 * `winddown-deferred` subset of that blob — `WINDDOWN_EXEMPTION_ROUNDS` rounds
 * past the one it names. See `collectAddressed`.
 *
 * Usage:
 *   bun summary-findings.ts [PR] [--json]
 *
 * Exits 0 with the report on stdout; 1 if the PR's comments cannot be read.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cachedRepoView } from "./lib/gh-conditional.ts";
import {
  isReviewerLogin,
  reviewedShaMarker,
  stickyMarker,
} from "./lib/overlay.ts";
import { ghCall } from "./lib/proc.ts";

// ── Pure parsing (unit-tested directly; no network) ─────────────────────────

export interface BacklogEntry {
  fingerprint: string;
  path: string;
  line: number | null;
  severity: string;
  dimension: string;
  /** A `categories` token from `.config/review-triage.yaml`, or `unknown` — see `categoryOf`. */
  category: string;
  confidence?: string;
  scope?: string;
  comment: string;
  firstRound?: number;
  reason?: string;
}

export interface SummaryFinding {
  fingerprint: string;
  source: "backlog" | "body" | "unaccounted";
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
export const STICKY_MARKER = stickyMarker();

/**
 * The marker the reviewer stamps its reviewed SHA into. Same override, same
 * reason: the reviewed SHA scopes the unaccounted-slot keys, so failing to read
 * it silently degrades every slot to the shared `nohead` scope, where an answer
 * given on one head marks a *different* finding addressed on the next.
 */
export const SHA_MARKER = reviewedShaMarker();

/** Extract the reviewed SHA the reviewer stamped, under whatever marker name. */
export function reviewedShaFrom(body: string): string | undefined {
  const re = new RegExp(
    `<!--\\s*${SHA_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
  );
  return body.match(re)?.[1];
}

/**
 * Marker a driver writes to record that a summary finding has been answered.
 *
 * A FIX-DEPENDENT answer carries the SHA its fix landed on, and the reviewer
 * round it was posted in (`<fingerprint>@<sha>#<round>`); a durable one carries
 * the bare fingerprint. See `collectAddressed` for why the two are not
 * interchangeable, and for what the round bounds.
 */
export const ADDRESSED_MARKER = "drive-pr-addressed";

/**
 * How many further reviewer rounds a `winddown-deferred` marker keeps
 * suppressing its finding after the round that posted it, before the finding is
 * re-asked once.
 *
 * The exemption in `collectAddressed` exists because the reviewer's
 * carry-forward of these entries carries no falsification signal — but that
 * cuts both ways: a later round that REVERTS the fix re-emits the identical
 * fingerprint under the identical reason, so an unbounded exemption suppresses
 * the reintroduced defect forever. The bound is the whole answer
 * available on this side: nothing here can prove the fix still holds, so the
 * marker is trusted for a known number of rounds and then re-asked.
 *
 * 3 is chosen against the two measured costs it sits between. Every-round
 * re-asking is the loop the exemption was introduced to stop (three
 * consecutive rounds each re-answered the same verified-fixed finding);
 * never re-asking suppresses a reverted fix forever. At 3 a still-valid fix
 * costs one re-answer per four rounds — on a reviewer that stops after ~14
 * rounds, three re-answers across a whole PR — while a reverted fix
 * resurfaces within four rounds of the answer that suppressed it.
 */
export const WINDDOWN_EXEMPTION_ROUNDS = 3;

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
export const MARKER_SAFE_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Stable key for a finding the reviewer did not fingerprint itself. Content-
 * derived on purpose: keying on the sticky comment id would be *too* stable
 * (the comment is upserted, so slot N stays "answered" after its finding
 * changed), and keying on the reviewed SHA would be too volatile (every push
 * would re-ask a standing wont-fix).
 *
 * Hashes the WHOLE text, never a prefix. The reviewer opens findings with
 * repeated severity/rationale boilerplate, so two distinct findings on one path
 * can share their first N characters; on a truncating hash they collide, `push()`
 * drops the second silently, and one answer marker then clears both — convergence
 * over live work. A prefix bounds nothing worth bounding here: the input is
 * already in memory and the digest is fixed-width either way.
 *
 * The LINE is in the key for the same reason, one axis over. Text alone is not
 * an identity: a finding class the reviewer emits per occurrence — a
 * hand-maintained tally, a missing guard, an unbounded call — reads identically
 * on every line it fires at, and this very PR has produced such a pair. Two live
 * occurrences would then collapse into one item that `push()` dedupes, and
 * answering it drives the count to zero while the sibling stays live. `path` and
 * `line` are separated by their own delimiter so `a.ts|4` + `0|text` cannot hash
 * as `a.ts|40` + `text`.
 */
export function fingerprintOf(
  path: string,
  line: number | null,
  text: string,
): string {
  return createHash("sha256")
    .update(`${path}|${line ?? ""}|${text}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * A PRESENT marker must decode to a well-formed array of well-formed entries or
 * this throws. There is no partial-credit path: an absent marker is a real zero,
 * but a marker we cannot fully understand means the reviewer's format moved
 * under us, and the only safe reading of "I no longer understand the held
 * findings" is INDETERMINATE. Returning `[]` for a non-array payload, or
 * silently dropping entries that merely lack a `fingerprint`, would turn a
 * reviewer-side format change into a clean convergence with live findings held
 * behind it.
 */
export function decodeBacklog(body: string): BacklogEntry[] {
  const m = body.match(/<!--\s*ai-review-backlog:\s*([A-Za-z0-9+/=]+)\s*-->/);
  if (!m) return [];
  const fail = (why: string): never => {
    throw new Error(`ai-review-backlog present but ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(m[1] ?? "", "base64").toString("utf8"));
  } catch {
    return fail("not decodable");
  }
  if (!Array.isArray(parsed)) return fail("not a JSON array");
  // A fingerprint is the backlog's identity for a finding, and downstream it is
  // the key everything else is decided on: `push()` drops a repeat, and one
  // answer marker clears whatever the key names. Two entries sharing one — a
  // reviewer-side collision or a truncating hash on its side — therefore silently
  // becomes one finding, and answering it retires a second one nobody ever read.
  // Malformed, like every other shape violation here, rather than deduplicated:
  // the entries are distinct by construction, so a repeat means the identity we
  // are keying on is not an identity.
  const seen = new Set<string>();
  return parsed.map((e, i): BacklogEntry => {
    if (typeof e !== "object" || e === null) {
      return fail(`entry ${i} is not an object`);
    }
    const entry = e as Record<string, unknown>;
    for (const key of ["fingerprint", "path", "comment"] as const) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        return fail(`entry ${i} has no usable \`${key}\``);
      }
    }
    if (entry.line != null && typeof entry.line !== "number") {
      return fail(`entry ${i} has a non-numeric \`line\``);
    }
    if (!MARKER_SAFE_FINGERPRINT.test(entry.fingerprint as string)) {
      return fail(
        `entry ${i} has a fingerprint \`${entry.fingerprint}\` that cannot round-trip through a ${ADDRESSED_MARKER} marker — it could never be answered`,
      );
    }
    if (seen.has(entry.fingerprint as string)) {
      return fail(
        `entry ${i} repeats fingerprint \`${entry.fingerprint}\` — two findings under one key would silently become one`,
      );
    }
    seen.add(entry.fingerprint as string);
    return {
      fingerprint: entry.fingerprint as string,
      path: entry.path as string,
      line: (entry.line as number | null) ?? null,
      severity: typeof entry.severity === "string" ? entry.severity : "unknown",
      dimension:
        typeof entry.dimension === "string" ? entry.dimension : "unknown",
      // Same wrong-type-degrades-to-absent contract as `severity`/`dimension`
      // above: a malformed `category` costs the one field, never the blob.
      category: typeof entry.category === "string" ? entry.category : "unknown",
      comment: entry.comment as string,
      // The reviewer's own provenance for the entry: which round first raised
      // it, and why it is being held out of inline review. `firstRound` is
      // provenance only, nothing branches on it. `reason` IS load-bearing:
      // `reason === 'winddown-deferred'` still selects the round-bounded
      // exemption, alongside the position rule keyed on backlog
      // MEMBERSHIP — both in `collectAddressed`. A wrong-typed
      // value on either degrades to absent rather than failing the blob, which
      // for `reason` means losing an exemption (the fail-closed direction,
      // costing a re-answer) rather than blocking the whole report.
      firstRound:
        typeof entry.firstRound === "number" ? entry.firstRound : undefined,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
    };
  });
}

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
 * the `reason: "winddown-deferred"` subset (the round-bounded expiry
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
      .filter((e) => e.reason === "winddown-deferred")
      .map((e) => e.fingerprint)
      .filter((fp) => !body.has(fp)),
  );
}

export function parseDeclaredUnanchored(body: string): number {
  const m = body.match(
    /(\d+)\s+finding\(s\)\s+without\s+a\s+diff-anchorable\s+line/i,
  );
  return m ? Number.parseInt(m[1] ?? "", 10) : 0;
}

export interface BodyFinding {
  path: string;
  line: number | null;
  text: string;
}

/**
 * Finding bullets from the summary body, EXCLUDING the `<details>` block — that
 * block renders the backlog, which is already parsed from its own blob and
 * would otherwise be counted twice.
 */
export function parseBodyFindings(body: string): BodyFinding[] {
  const head = body.split("<details")[0] ?? "";
  const out: BodyFinding[] = [];
  for (const line of head.split("\n")) {
    const m = line.match(/^[-*]\s+`([^`]+)`\s+[—–-]\s+(.*)$/);
    if (!m) continue;
    const loc = m[1] ?? "";
    const lineMatch = loc.match(/^(.*):(\d+)$/);
    out.push({
      path: lineMatch ? (lineMatch[1] ?? "") : loc,
      line: lineMatch ? Number.parseInt(lineMatch[2] ?? "", 10) : null,
      text: (m[2] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Some inline reviewers emit a shields.io priority
 * badge instead of a bold canonical token — `![P1 Badge](https://img.shields
 * .io/badge/P1-orange?...)`. Mapped onto the same canonical tokens this
 * function produces elsewhere, never a vocabulary of its own:
 * `severity_order` (`review-triage.yaml`) is validated as an exact
 * permutation of `CANONICAL_SEVERITIES` (`ladder.ts`), so a badge-derived
 * value outside that set would fail the ladder's own config validation
 * rather than merely being ignored.
 */
const BADGE_SEVERITY: Record<string, string> = {
  p0: "blocker",
  p1: "high",
  p2: "medium",
  p3: "low",
};

/**
 * A REAL leading severity field, on line 0 of the header: optional horizontal
 * whitespace and coloured-circle decoration, then the bold token. Nothing
 * else.
 *
 * The prefix used to be `[^\p{L}\n]*` — "any run of non-letters" — which is
 * far wider than the shape it was documented to describe, and two decoys
 * show the gap: a title beginning `` `**low**` is a supported token `` (a
 * backtick is not a letter) and `3 **low**-level branches are skipped` (a
 * digit is not a letter) were both classified `low`. Both are severity-LESS
 * findings, so the consequence is the fail-open contract inverted at its
 * load-bearing input: `severityOf` feeds `fail_open.inert_when_unknown`, and
 * a finding that should have read `unknown` — leaving the ladder inert —
 * instead armed it and could decline work that was supposed to fail open.
 *
 * So the prefix ENUMERATES what actually appears there rather than
 * subtracting what must not: a space or tab, and one of the COLOURED CIRCLES
 * this reviewer emits. A badge-format finding never reaches here — the
 * `BADGE_SEVERITY` matcher runs first.
 *
 * The variation-selector (VS16) branch exists to cover a reviewer that
 * starts decorating a circle it does not decorate today — every circle in
 * the class is `Emoji_Presentation=Yes`, so none needs VS16 to render, but a
 * future emitter might pair one anyway. It is bound to a PRECEDING circle in
 * the same alternative, never a free-standing branch of the top-level
 * alternation: a modifier is decoration only when it modifies something, and
 * one with no base character before it is not a circle a reviewer
 * decorated, it is an arbitrary invisible code point sitting in front of a
 * quoted token — exactly the "unforeseen decoration" the enumeration below
 * exists to reject, not admit.
 *
 * A ZWJ branch used to sit alongside VS16 here and is now gone entirely — see
 * the last decoy below for why re-binding it was not the fix.
 *
 * The first attempt at that enumeration was still two steps too wide, and a
 * decoy defeated each step:
 *
 * - `\p{Extended_Pictographic}` admits EVERY emoji, not the circles the
 *   sentence above claims, so `⚠️ **blocker** behavior is unsupported` — a
 *   severity-less title that merely opens with a warning sign — classified
 *   `blocker`. The branch is now the coloured
 *   circle block itself (U+1F534/U+1F535, U+1F7E0–U+1F7E4, U+26AA/U+26AB): a
 *   closed set that cannot grow under it, unlike a Unicode property whose
 *   membership is Unicode's to widen.
 * - `\s` matches `\n`, so dropping the `m` flag never actually confined the
 *   match to line 0 — the PREFIX walked to line 1 on its own and `⚠️\n**low**
 *   is only an example token` classified `low`. The whitespace branch is now
 *   `[ \t]`, which cannot leave the line it starts on, so the line-0 guarantee
 *   below is true of the whole pattern rather than of `^` alone.
 * - A later cut still listed VS16 and ZWJ as their own top-level branches
 *   under `*`, so each was reachable standalone — with no circle anywhere
 *   before it — and a title opening with a bare ZWJ or VS16 right before the
 *   bold token classified as a real severity. Binding each modifier to a
 *   circle in the same alternative closed that: the loop can still skip a
 *   RUN of decoration across several circles, but never a modifier with
 *   nothing behind it.
 * - Binding closed the standalone case but not the shape a ZWJ actually has:
 *   a ZWJ joins its base to WHATEVER FOLLOWS it, so a circle immediately
 *   followed by a ZWJ and then `**` — nothing after the ZWJ to join with —
 *   is an incomplete, dangling sequence, and it still classified as a real
 *   severity (`severityOf('🟡<ZWJ>**high** hidden ZWJ')` returned `high`).
 *   Closing that properly means requiring a second emoji after the ZWJ,
 *   which none of these circles has ever needed — none participates in a
 *   real ZWJ sequence today, so the branch was speculative from the start.
 *   Removed rather than patched a third time: a modifier admitted for a
 *   future emitter that does not exist has now cost two bypasses and bought
 *   no coverage of anything real.
 *
 * Every decoy above is a severity-LESS finding, so each had the same
 * consequence as the first: `unknown` (ladder inert) read as a real
 * severity, arming a ladder that should have failed open.
 *
 * Enumerating rather than subtracting also fixes the bias direction: an
 * unforeseen decoration — a nbsp, an emoji outside the circle block — now
 * yields `unknown` and leaves the ladder inert, instead of admitting a
 * severity nobody wrote.
 *
 * Written as an ALTERNATION rather than one character class: a class mixing a
 * base character with a combining one (VS16) can never match the combined
 * grapheme as a unit, which biome's `noMisleadingCharacterClass` rejects. The
 * behaviour actually wanted here is "skip a RUN of decoration code points,
 * where a modifier only ever follows the circle it decorates" — a circle
 * optionally followed by VS16 is one alternative, plain whitespace is the
 * other, and the `*` repeats across either. (The circles are a class among
 * themselves — they are all base characters.)
 *
 * Deliberately no `m` flag: `^` must mean start-of-header, not start-of-line.
 * A line-0 anchor was once added with `m` carried along, which defeated it
 * for any header whose SECOND line began with a quoted token, so the flag was
 * removed. Do not add it back — and do not widen the whitespace branch back to
 * `\s` either, which reopens the same hole from the other end.
 */
const SEVERITY_FIELD =
  /^(?:[ \t]|[\u{1F534}\u{1F535}\u{1F7E0}-\u{1F7E4}\u{26AA}\u{26AB}](?:\uFE0F)?)*\*\*(blocker|high|medium|low)\*\*/iu;

/**
 * `🟡 **medium**` / `🔵 **low**` → `medium` / `low`; a `[P1]`-style badge (see
 * `BADGE_SEVERITY`) → its mapped token; unknown shapes → `unknown`.
 *
 * Without the badge fallback, every finding from a reviewer using this format
 * reads `unknown`, and because `severity` is listed in
 * `fail_open.inert_when_unknown` (`review-triage.yaml`), the decline ladder is
 * inert for ALL of that reviewer's findings — every round, not just the
 * unrecognized ones.
 *
 * Both the bold-token and badge matchers are scoped to the leading HEADER
 * paragraph, never the finding's prose body — leading `<!-- ai-review-* -->`
 * HTML comments (the configured reviewer app's own format) are stripped
 * first, then the header is everything up to the first blank line. A
 * badge-format finding carries no bold canonical token in its header, so an
 * unscoped search falls through to the body and misreads any bold token
 * quoted there as an example — e.g. a low-severity finding's own explanation
 * quoting `**blocker**` — as the real severity (the same class the badge
 * fallback was already scoped against).
 *
 * The stripped comments are scoped to the `ai-review-*` marker shape and no
 * other — a leading HTML comment from an unrelated source, if stripped
 * unconditionally, would expose whatever paragraph follows it as the header,
 * even when that paragraph is body prose quoting a bold token as an example
 * rather than a real severity bullet.
 *
 * The badge matcher runs BEFORE the bold-token matcher, and is anchored to the
 * structurally leading position — line 0 of the header, not merely its start —
 * rather than searched for anywhere in the header. A badge-format finding's own
 * title can itself quote a bold canonical token as a decoy (e.g.
 * `![P2 Badge](...) Handle the **blocker** token`) — an unanchored bold-token
 * search run first would match that decoy before the badge matcher ever runs,
 * misreading the badge's `medium` as `blocker`.
 *
 * The leading (and every internal) whitespace run in the badge pattern is
 * `[ \t]`, never `\s` — `\s` matches `\n`, so `^\s*` would let the prefix walk
 * past line 0 exactly the way `SEVERITY_FIELD`'s own prefix once did:
 * `severityOf('\n![P1 Badge](...)')` matched the badge on line 1 and armed the
 * ladder from a header whose real line 0 carries no severity at all. The two
 * matchers share the same line-0 contract; they must share the same whitespace
 * class that makes it true, not merely the same intent stated in prose.
 *
 * The bold-token matcher is anchored the same way, on the same line 0-of-header
 * position — not merely "somewhere in the (narrower) header blob", which every
 * earlier fix narrowed without ever anchoring the token search itself. A
 * severity-less finding whose own TITLE quotes a canonical word in bold (e.g.
 * `Handle the **blocker** token safely`) has no letters before that token, so
 * requiring the run of characters before `**` to contain no letters — only
 * emoji, punctuation or whitespace, the shape every real leading severity
 * field actually has — rejects it; a real field like `🟡 **medium** · …`
 * still matches.
 *
 * That anchor is only real WITHOUT the `m` flag, and the fix that added it
 * once carried one — so `^` restarted at every line inside the header and
 * the anchor it claimed to add was defeated by any header whose SECOND line
 * began with a quoted token (`` `**low**` is a supported token ``), which is
 * ordinary prose in a finding that is itself about severity parsing. A
 * severity-less late-round finding was then classified `low` instead of
 * `unknown`, bypassing `fail_open.inert_when_unknown` entirely (the third
 * failure from this one root cause, and the reason the flag is now called
 * out here rather than left as a detail of the literal). Do not add `m`: the
 * header is a single logical field, and line 0 of it is the whole claim.
 */
/**
 * Leading `ai-review-*` HTML comments stripped, then everything up to the
 * first blank line — the block both `severityOf` and `categoryOf` read their
 * field out of. Shared rather than copied so a future fix to this scoping
 * (the comment-strip pattern, the blank-line split) cannot silently apply to
 * one and not the other — which is exactly how `categoryOf` first shipped
 * without the line-0 restriction `severityOf` had already paid three fixes
 * to earn.
 */
function headerOf(text: string): string {
  const withoutLeadingComments = text.replace(
    /^(?:\s*<!--\s*ai-review-[\s\S]*?-->\s*)+/,
    "",
  );
  return withoutLeadingComments.split(/\n\s*\n/, 1)[0] ?? "";
}

/**
 * CodeRabbit's inline-finding header: three emphasized, pipe-delimited fields
 * on line 0 of the header — category, severity, effort — e.g.
 * `**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**` (current) or
 * `_🩺 Stability & Availability_ | _🔴 Critical_ | _⚡ Quick win_`
 * (until 2026-10-09). Verified against 12/12 lifetime CodeRabbit inline
 * findings across three independent PRs in its italic form, and all 7 inline
 * threads on one PR in its bold form, each with an identical 100% unreadable
 * rate under the matchers above — this is CodeRabbit's whole format, not a
 * one-off variant.
 *
 * Neither existing matcher recognizes it, on two independent axes (a third,
 * the emphasis marker, is covered below):
 *   - vocabulary: CodeRabbit's tokens are `Critical`/`Major`/`Minor`/`Trivial`
 *     (`Trivial` first observed 2026-10, where its absence left the
 *     ladder inert for that finding), none of which is a member of
 *     `blocker|high|medium|low` — a vocabulary mapping is required, not just
 *     a case fold.
 *   - position: severity is the SECOND `|`-delimited field, preceded by a
 *     category field (`**🩺 Stability & Availability** | `) that
 *     `SEVERITY_FIELD`'s leading-decoration prefix does not admit. Widening
 *     that prefix to walk past an entire leading field would reopen exactly
 *     the decoy class its enumeration above was hardened against, so this is
 *     parsed structurally instead — split line 0 on `|`, then match field 1
 *     — the same field-position discipline
 *     `categoryOf`/`CATEGORY_LEAD_FIELD` already uses against the identical
 *     class of positional decoy.
 *
 * Each field must be wrapped END TO END (`^...$`) and the severity field's
 * unwrapped content must be the token (optionally preceded by one emoji) and
 * nothing else — a body sentence quoting `Critical` as an example inside a
 * longer field cannot satisfy this, and the LEAD and TRAILING fields must
 * themselves look like genuine emphasized fields, not merely be present —
 * mirroring `severityOf`'s own refusal to admit a bold token merely because
 * it appears somewhere in the header, and `CATEGORY_LEAD_FIELD`'s refusal to
 * trust a lead field that only ends with the right shape.
 *
 * The emphasis marker is NOT part of the contract and has already moved once:
 * `_italic_` fields became `**bold**` fields on 2026-10-09, reading every
 * CodeRabbit finding as `unknown` and leaving the decline ladder inert until
 * it was recognized again. So each field is unwrapped from EITHER marker,
 * field by field, and the vocabulary/arity/position checks run on the
 * unwrapped content — a pinned marker would be one more exact visual shape for
 * the next format change to break. Accepting both markers does not reopen the
 * decoy class: authorship (`CODERABBIT_LOGIN` in `severityOf`) is what closes
 * it, and the shape check stays a narrowing, not the guard.
 *
 * A bold field's content may not itself contain `**`, so `**a** and **b**`
 * (two bold spans in prose) is not read as a single wrapped field. (The
 * italic branch keeps its original `.+` content: it never mattered, since the
 * lead and trailing fields' content is never read.)
 */
const CODERABBIT_FIELD = /^(?:_(.+)_|\*\*((?:(?!\*\*).)+)\*\*)$/u;
const CODERABBIT_SEVERITY_FIELD =
  /^(?:[\u{1F534}\u{1F535}\u{1F7E0}-\u{1F7E4}\u{26AA}\u{26AB}][ \t]*)?(Critical|Major|Minor|Trivial)$/iu;

/** The content of a `_italic_` or `**bold**` field, or `null` if it is neither. */
function coderabbitFieldContent(field: string | undefined): string | null {
  const m = (field ?? "").match(CODERABBIT_FIELD);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * CodeRabbit's GraphQL `author.login` — verified live against 12+ inline
 * findings across four PRs: plain `coderabbitai`, no `[bot]` suffix (that
 * suffix is a REST-API convention some other call sites use for the same
 * account; GraphQL's `author{ login }` never carries it). Any shape-based
 * CodeRabbit matcher, however many fields it requires, stays defeatable by a
 * decoy an ordinary reviewer comment can produce by coincidence —
 * `_Expected_ | _Critical_ | _Actual_` is exactly three italic
 * pipe-delimited fields with a real severity token in the middle, and reads
 * nothing like a bug unless you already know CodeRabbit did not write it
 * (the third decoy on this one function). Identity is the only signal that
 * closes the class rather than narrowing it one counterexample at a time.
 */
const CODERABBIT_LOGIN = "coderabbitai";

/**
 * Mapped onto the canonical `severity_order` vocabulary the same way
 * `BADGE_SEVERITY` maps `chatgpt-codex-connector`'s badge tiers. CodeRabbit's
 * vocabulary has no `medium` counterpart, and `severity_order` has
 * nothing weaker than `low`, so both `Minor` and `Trivial` take the weakest
 * canonical slot rather than widening `CANONICAL_SEVERITIES` for one reviewer.
 */
const CODERABBIT_SEVERITY: Record<string, string> = {
  critical: "blocker",
  major: "high",
  minor: "low",
  trivial: "low",
};

/**
 * `**🩺 Stability & Availability** | **🔴 Critical** | **⚡ Quick win**` (or
 * the same fields in `_italic_`) → `blocker`; anything not shaped like CodeRabbit's pipe-delimited header → `null`, so
 * `severityOf` falls through to `unknown` rather than risking a false
 * positive on an unrelated pipe character in another reviewer's prose.
 *
 * The header is defined as exactly three fields (category | severity |
 * effort) — arity is checked with `!== 3`, not `< 2`, so a two-field decoy
 * (`**anything** | **Critical**`) or a four-plus-field one
 * (`**anything** | **Critical** | extra | extra`) reads `null` instead of
 * being accepted on the strength of its first two fields alone. The trailing
 * effort field is itself required to look like a genuine emphasized field
 * (the same wrapped-field shape, `coderabbitFieldContent`, the category field
 * is held to) — otherwise the whole thing is more likely a decoy that merely
 * happens to contain two pipe-delimited emphasized-looking segments than a real CodeRabbit
 * header, and an unrecognized severity leaving the decline ladder inert is
 * the safe failure mode, not this one.
 *
 * Shape alone is NOT the whole guard — see `severityOf`, which gates every
 * call to this function on the raising comment's own author. A three-field
 * shape check narrows the decoy surface; it cannot close it, because English
 * prose can produce the exact shape by coincidence (`**Expected** | **Critical**
 * | **Actual**` — a bug report's own before/after fields — misread as
 * `blocker` under this function alone).
 */
function coderabbitSeverityOf(header: string): string | null {
  const line0 = header.split("\n", 1)[0] ?? "";
  const fields = line0.split("|").map((f) => f.trim());
  if (
    fields.length !== 3 ||
    coderabbitFieldContent(fields[0]) === null ||
    coderabbitFieldContent(fields[2]) === null
  ) {
    return null;
  }
  const m = coderabbitFieldContent(fields[1])?.match(CODERABBIT_SEVERITY_FIELD);
  if (!m) return null;
  return CODERABBIT_SEVERITY[(m[1] ?? "").toLowerCase()] ?? null;
}

/**
 * `authorLogin` is the raising comment's own GitHub login, threaded in by the
 * caller — `undefined`/`null` for a caller with no identity to offer (e.g.
 * `classify()`'s own sticky-body bullets below, which are always the
 * configured reviewer app's text, never CodeRabbit's, so skipping the
 * CodeRabbit-shaped path there is already correct without one). Gating
 * `coderabbitSeverityOf` on `CODERABBIT_LOGIN` — rather than trusting its
 * shape check alone — is what actually closes the decoy class three
 * consecutive fixes to this function kept narrowing instead of closing; see
 * that function's own doc for the counterexample that forced this.
 */
export function severityOf(text: string, authorLogin?: string | null): string {
  const header = headerOf(text);
  const badge = header.match(
    /^[ \t]*\*{0,2}(?:<sub>[ \t]*){0,2}!\[[ \t]*(P[0-3])[ \t]*Badge\]/i,
  );
  if (badge) return BADGE_SEVERITY[(badge[1] ?? "").toLowerCase()] ?? "unknown";
  const bold = header.match(SEVERITY_FIELD);
  if (bold) return (bold[1] ?? "").toLowerCase();
  if (authorLogin === CODERABBIT_LOGIN) {
    const coderabbit = coderabbitSeverityOf(header);
    if (coderabbit) return coderabbit;
  }
  return "unknown";
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
 * category — never a later one: an earlier change's own contract renders the tag
 * "next to severity", and every observed emission (including the nested-`·`
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
 * backward-compatible shape an earlier change emits for an uncategorized finding, and
 * every finding from before an earlier change shipped — → `unknown`. Never a parse
 * error: an absent category changes nothing downstream (`review-triage.yaml`'s
 * `categories` clause can only ever ADMIT a finding, never decline one on the
 * strength of `unknown`).
 *
 * CodeRabbit's header (see `coderabbitSeverityOf` above)
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

/** `<!-- ai-review-round: N -->` from a sticky or inline reviewer comment. */
export function parseReviewRound(body: string): number | null {
  const m = body.match(/<!--\s*ai-review-round:\s*(\d+)\s*-->/);
  return m ? Number.parseInt(m[1] ?? "", 10) : null;
}

export interface ClassifyInput {
  pr: number;
  stickyCommentId: number | null;
  stickyBody: string;
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

  for (const e of decodeBacklog(stickyBody)) {
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
  const bullets = parseBodyFindings(stickyBody);
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
      // No author threaded here: every body bullet is a line inside THIS
      // sticky, always authored by the configured reviewer app, never by
      // CodeRabbit — so `severityOf`'s CodeRabbit path is correctly skipped
      // by the same default a caller with no identity gets.
      severity: severityOf(f.text),
      category: categoryOf(f.text),
      text: f.text,
    });
  }

  const declared = parseDeclaredUnanchored(stickyBody);
  // Measured against EVERY unanchored finding already classified — backlog
  // entries included — not just the body bullets. Backlog entries are
  // unanchored by construction, so if the reviewer's declared count covers them
  // too, subtracting only the bullets manufactures a synthetic slot for a
  // finding that was already enumerated. That phantom cannot be cleared by
  // answering real findings, and it reappears on every new head — turning
  // "fail closed" into "never converges", which is a liveness bug rather than
  // the safety property it looks like.
  // `findings` already holds the deduplicated backlog + body set at this point.
  const classified = findings.length;
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
 * `announce-merge-ready.ts` and `reconcile-replied-threads.ts` apply the same
 * gate to their own announcement/reply sweeps, and import this constant
 * directly rather than keeping their own copy — every consumer decides the
 * same question about the same world-writable comment stream off this one
 * set, and a second copy would only drift. `--trusted-associations` below
 * stays as a read-only CLI surface for callers outside this module graph
 * (shell/jq tooling, ad-hoc inspection) that cannot `import` a TypeScript
 * constant.
 */
export const TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

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
   * `reason: "winddown-deferred"`. A fix-dependent marker for one of these is
   * exempt from the `reviewerSaw` expiry for `WINDDOWN_EXEMPTION_ROUNDS`
   * rounds — never from the dating requirement, which `collectAddressed`
   * enforces by refusing the exemption outright at position `unknown` (a
   * marker SHA git cannot resolve to a commit). Build it with
   * `winddownFingerprintsOf`, which applies the same body-bullet exclusion as
   * `backlogFingerprintsOf`. See `collectAddressed` for why re-emission
   * carries no falsification signal for exactly this set, and why the
   * exemption is nonetheless bounded.
   */
  winddownDeferred?: Set<string>;
  /**
   * The round the sticky under evaluation describes (`ai-review-round`), or
   * null when it stamps none. Only the winddown exemption reads it, and ABSENT
   * MEANS NO EXEMPTION: with no round to measure against, the bound cannot be
   * evaluated, and an unbounded exemption is the failure this option exists to
   * close.
   */
  currentRound?: number | null;
}

/**
 * Does a marker the reviewer has already read past still hold?
 *
 * Every clause fails CLOSED — not in the backlog's winddown set, no round on
 * the marker, no round on the sticky, an unparseable/negative/future round, or
 * too many rounds elapsed all yield false, which puts the finding back on the
 * unaddressed list. The cost of a false there is one re-answer; the cost of a
 * false the other way is a live finding suppressed with nothing left to
 * surface it. See `collectAddressed` below for why this set is exempt at all,
 * and why the exemption is bounded.
 *
 * The round is untrusted input — a marker's `#<round>` is hand-writable, and
 * `parseMarkerPayload` only checks it is all-digit, not that it fits a safe
 * integer or precedes `currentRound`. Without the extra checks, a future round
 * (`#999999` against a small `currentRound`) makes `currentRound - round`
 * negative — always `<= WINDDOWN_EXEMPTION_ROUNDS` — so the marker stays
 * exempt until `currentRound` catches up past `round + WINDDOWN_EXEMPTION_ROUNDS`,
 * and a long enough digit run parses past `Number.MAX_SAFE_INTEGER`, making
 * that gap effectively permanent — restoring the unbounded-suppression failure
 * an earlier change exists to close.
 */
function exemptFromExpiry(
  fingerprint: string,
  round: number | null,
  opts: AddressedOptions,
): boolean {
  if (!opts.winddownDeferred?.has(fingerprint)) return false;
  if (round === null || opts.currentRound == null) return false;
  if (!Number.isSafeInteger(round) || round < 0 || round > opts.currentRound) {
    return false;
  }
  return opts.currentRound - round <= WINDDOWN_EXEMPTION_ROUNDS;
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
 * either exemption sees them, so a dual-emitted finding gets neither grace nor
 * round budget. It has to be settled at the set rather than here: a fingerprint
 * is one global key, `collectAddressed` returns keys, and `classify`'s own
 * dedup reports the pair as a single finding — so honouring the marker for
 * "the backlog copy" clears the freshly-judged one with it.
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
 * Past that one head, a THIRD clause keeps a narrower set alive, and it is not
 * a variant of the same question. The position rule above once read as though
 * a single bounded rule replaced the older `reason: "winddown-deferred"`
 * exemption outright. It does not, because the two are bounded along DIFFERENT
 * axes: the position rule expires at the first later PUSH, which is precisely
 * the carry-forward loop that survives one — measured: three consecutive
 * rounds each re-answering the same verified-fixed finding, and a second
 * drive's carry-forward. So the winddown clause below stands alongside it,
 * bounded in ROUNDS rather than heads.
 *
 * That clause covers `winddown-deferred` backlog entries, where the
 * theory is empirically false. The reviewer carries those forward
 * UNCONDITIONALLY by their original firstRound — it does not re-verify them
 * against the current diff — so re-emission at the fix's head says nothing
 * about the fix, and expiring the marker turns a correctly-fixed,
 * correctly-answered finding into a loop the driver cannot win (measured, as
 * above). A fix-dependent marker whose fingerprint is in
 * `opts.winddownDeferred` therefore survives a `past` position — but NOT an
 * `unknown` one. The SHA is still required, and "required" means datable, not
 * merely present: `past` and `unknown` are both non-answers about the reviewer,
 * yet only `unknown` says the marker names no commit this repository has, so
 * ignoring position (which is this clause's whole point) must not extend to
 * ignoring that. Folding the two together let a hand-written `@deadbeef…`
 * marker ride the exemption for its whole round budget, contradicting the
 * "never exempt from the dating requirement" contract one field up
 *. Every non-winddown finding keeps the
 * full expiry — the reviewer DOES re-verify those, so there re-emission still
 * falsifies.
 *
 * That exemption is BOUNDED, and the bound is the whole of an earlier change. Unbounded,
 * it was unfalsifiable in the other direction too: a later round that REVERTS
 * or regresses the fix reproduces the finding under the same fingerprint and
 * the same `winddown-deferred` reason — indistinguishable from a routine
 * carry-forward — and the marker suppressed it forever, so `drive-status.ts`
 * could reach CONVERGED over a live finding. The distinction is erased at the
 * SOURCE: the reviewer's carry-forward does not record whether an entry was
 * re-detected on this head or merely forwarded, and the reviewer is a
 * self-hosted app, not this repository, so nothing here can recover what was
 * never emitted. What IS available is elapsed rounds. The marker carries the
 * round it was posted in (`<fingerprint>@<sha>#<round>`), and the exemption
 * holds for `WINDDOWN_EXEMPTION_ROUNDS` further rounds; past that the finding is
 * re-asked once, and a still-valid fix re-answers under a fresh round. A marker
 * with no round, or a sticky with no round to measure it against, gets NO
 * exemption — the pre-exemption behaviour, which costs a re-answer rather than
 * an unbounded suppression, and which a re-answer then repairs by stamping one.
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
  for (const s of sources) {
    if (!TRUSTED_ASSOCIATIONS.has(s.authorAssociation)) continue;
    const outcome = outcomeOf(s.body);
    if (outcome === null) continue;
    for (const m of s.body.matchAll(re)) {
      const { fingerprint, sha, round } = parseMarkerPayload(m[1] ?? "");
      if (!sha) {
        if (FIX_DEPENDENT_OUTCOMES.has(outcome)) continue;
        out.add(fingerprint);
        continue;
      }
      // A marker survives under the clauses below, and they are cumulative
      // rather than alternatives to each other — an earlier change (the position rule)
      // and an earlier change (the winddown round budget) answer overlapping but
      // different questions, and neither subsumes the other:
      //
      //   behind          the review predates the fix, so it cannot have judged
      //                   it. Every finding, always.
      //   at + backlog    one head of grace for the whole backlog blob, because
      //                   a marker is ALWAYS posted at the reviewed head (§ 6's
      //                   push → stamp-held → status → answer ordering) and
      //                   would otherwise be inert on arrival.
      //   winddown budget `WINDDOWN_EXEMPTION_ROUNDS` rounds PAST that, for the
      //                   narrower `reason: "winddown-deferred"` subset the
      //                   reviewer forwards without re-verifying — but only
      //                   for a marker whose SHA git can actually resolve
      //                   (`unknown`). That clause ignores POSITION by design;
      //                   it was never meant to excuse a marker naming nothing
      //                   datable, which is the one thing `past` used to hide
      //                   from it.
      //
      // The one-head rule's rationale once read as though it replaced the
      // winddown exemption outright. It does not: the position rule expires
      // at the FIRST later push, which is exactly the measured carry-forward
      // loop (three consecutive rounds re-answering one verified-fixed
      // finding). Dropping either clause here restores a measured failure,
      // so both stay.
      const where = position(sha);
      const honour =
        where === "behind" ||
        (where === "at" &&
          opts.backlogFingerprints?.has(fingerprint) === true) ||
        (where !== "unknown" && exemptFromExpiry(fingerprint, round, opts));
      if (!honour) continue;
      out.add(fingerprint);
    }
  }
  return out;
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
 * The marker's ROUND is deliberately not compared for an ordinary fix-dependent
 * marker. It records WHEN the answer was posted, not what the answer claims,
 * so comparing it would make a reclaiming pass whose sticky has since advanced
 * a round miss its own predecessor's marker at the same SHA and post a
 * duplicate — the same bug again, reached through the field an earlier change added.
 *
 * A `winddown-deferred` fingerprint is the one exception, because it is the
 * one case where a LATER round legitimately re-answers at the exact SAME SHA:
 * the reviewer forwards that backlog entry without re-verifying it, so
 * nothing about the fix changes between rounds, only the round-bounded
 * exemption's remaining budget (`exemptFromExpiry`, `WINDDOWN_EXEMPTION_ROUNDS`).
 * Once `collectAddressed` expires the old marker, `answer-summary-finding.ts`
 * needs to repost at the SAME `sha` with a FRESH `#<round>` to renew it — and
 * if this function still reported the stale marker as an exact match, that
 * repost would be silently skipped as "already posted", leaving the finding
 * `unaddressed` forever. So for a
 * winddown fingerprint, an existing same-SHA marker only counts as a match
 * while it is still within its own exemption window; once elapsed, it is
 * stale rather than a duplicate, and a fresh post is allowed through. A
 * marker still inside the window is exactly the crash-recovery case above —
 * same reasoning applies unchanged.
 *
 * That refresh path requires an actual `opts.currentRound` to measure
 * staleness against — a roundless sticky (no `ai-review-round`) makes
 * `exemptFromExpiry` fail closed to "not exempt" unconditionally, which would
 * make EVERY same-SHA winddown marker read as stale, including one this same
 * pass posted moments ago. `answer-summary-finding.ts` also stamps no round
 * on a roundless sticky (`roundSuffix` is empty), so the "fresh" repost would
 * be textually identical to the marker just posted, and the next
 * reconciliation would see it as stale too — an infinite loop of duplicate
 * comments instead of the intended one-time refresh. With no round to measure
 * by, retain the ordinary unconditional same-SHA match instead — the
 * crash-recovery guarantee — until a later sticky supplies one.
 */
export function findExactMarkers(
  sources: AddressedSource[],
  fingerprints: Set<string>,
  markerSha: string | undefined,
  opts: AddressedOptions = {},
): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `<!--\\s*${ADDRESSED_MARKER}:\\s*([^\\s>]+)\\s*-->`,
    "g",
  );
  for (const s of sources) {
    if (!TRUSTED_ASSOCIATIONS.has(s.authorAssociation)) continue;
    if (outcomeOf(s.body) === null) continue;
    for (const m of s.body.matchAll(re)) {
      const { fingerprint, sha, round } = parseMarkerPayload(m[1] ?? "");
      if (!fingerprints.has(fingerprint)) continue;
      if (markerSha ? sha === markerSha : sha === "") {
        if (
          markerSha &&
          opts.winddownDeferred?.has(fingerprint) &&
          opts.currentRound != null &&
          !exemptFromExpiry(fingerprint, round, opts)
        ) {
          continue;
        }
        out.add(fingerprint);
      }
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
async function gh(args: string[]): Promise<string> {
  const r = await ghCall(args);
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

/**
 * Where the reviewer's own reviewed head sits relative to `sha`, the head a
 * fix-dependent marker names.
 *
 * A position rather than a boolean, because `collectAddressed` has to tell a
 * reviewer STRICTLY BEHIND the fix (its review predates the commit, so it
 * cannot have judged it — the marker stands for any finding) from one sitting
 * exactly ON it (it has read that head, which falsifies the answer for a fresh
 * finding but not for a carried-forward backlog entry) — and both from
 * everything else.
 *
 * `unknown` is the one value that is NOT a statement about the reviewer at all:
 * it says the MARKER's own SHA resolves to no commit here, so there is nothing
 * to be behind or at. It is separate from `past` only because the winddown
 * exemption ignores position by design, and had to be stopped from ignoring an
 * undated marker with it (`collectAddressed`). Everywhere else the two behave
 * identically — neither is `behind` or `at`, so neither honours a marker on its
 * own.
 *
 * The question is NOT "is `sha` an ancestor of the reviewed head". Asking it
 * that way has only one safe answer and three unsafe ones, because a PR branch
 * can be rebased or force-pushed: the reviewed head then need not descend from
 * the marker's commit at all, `--is-ancestor` says "no", and the marker is read
 * as "the reviewer has not seen this fix yet" — so it keeps suppressing a
 * finding the reviewer is re-emitting on the rewritten branch, which is false
 * convergence by the exact route the expiry exists to close. Ahead, divergent,
 * or unanswerable are therefore one position — `past` — and re-ask the finding.
 * Re-asking costs one round; the alternative costs a live finding.
 *
 * BOTH revisions are resolved through git before anything is compared, and that
 * is a correctness requirement rather than hygiene. `reviewedShaFrom` accepts
 * `[0-9a-f]{7,40}`, so the reviewer may stamp an ABBREVIATED SHA; deciding the
 * equal case by raw string comparison (as this did while it was a boolean) then
 * misses it and falls through to `--is-ancestor`, which exits 0 for two equal
 * commits — reporting the reviewer as strictly behind a fix it is sitting
 * exactly on. Under the `at` grace that would silently extend a backlog-only
 * exemption to every finding, so equality is git's answer, not the string's.
 *
 * `git merge-base --is-ancestor` needs no network, and its exit status carries
 * more than the pass/fail a caller tends to assume:
 *
 *   0     the reviewed head is an ancestor of `sha`, and the two are already
 *         known to differ, so strictly behind. `behind`.
 *   1     it is not: ahead, or divergent after a rewrite. `past`.
 *   ≥2    git could not answer: an unknown SHA, a shallow clone, not a repo.
 *         `past`.
 *
 * Reading a non-zero as `behind` would let every error case retire the finding
 * on the strength of a check that did not run — a shallow CI checkout would
 * silently restore the content-keyed suppression this exists to remove. So an
 * error is `past`, as are a missing reviewed SHA, a reviewed SHA git cannot
 * resolve, and a git that will not spawn; a MARKER SHA git cannot resolve is
 * `unknown`, which is stricter still. Every one of them withholds the marker
 * and blocks convergence.
 */
export type ReviewerPosition = "behind" | "at" | "past" | "unknown";

export function reviewerPosition(
  sha: string,
  reviewedSha?: string,
): ReviewerPosition {
  if (!reviewedSha) return "past";
  try {
    // `^{commit}` so a revision that resolves to some other object type is a
    // non-answer rather than an id that can never equal a commit's.
    const commitId = (rev: string): string | null => {
      const r = spawnSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      // A signalled or unspawnable child reports a null status, not a number.
      if (r.status !== 0) return null;
      return r.stdout.trim() || null;
    };
    const to = commitId(sha);
    // The MARKER's own SHA not resolving is a different failure from every
    // other one here, and the only one that has to be told apart: the others
    // say "the reviewer's position relative to this fix is unknown", which
    // `past` answers correctly, while this one says the marker names nothing
    // datable AT ALL. The winddown exemption deliberately ignores position —
    // that is its whole point — so folding this case into `past` handed it an
    // undated marker to honour, contradicting the "never exempt from the
    // dating requirement" contract in `AddressedOptions.winddownDeferred`
    //. Distinct value, checked there.
    if (!to) return "unknown";
    const from = commitId(reviewedSha);
    if (!from) return "past";
    if (from === to) return "at";
    const { status } = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", from, to],
      { stdio: "ignore" },
    );
    // Same null-status reasoning: an answer git did not give must land in
    // `past` like every other unknown here, never be read as the ancestor case.
    return status === 0 ? "behind" : "past";
  } catch {
    return "past";
  }
}

async function main(): Promise<number> {
  const rawArgv = process.argv.slice(2).filter((a) => a !== "--json");

  // Printing mode, deliberately before anything that touches the network: a
  // read-only surface for the ONE definition of "an author GitHub vouches
  // for" for callers that cannot `import` this module's TRUSTED_ASSOCIATIONS
  // constant directly (shell/jq tooling, ad-hoc inspection) — every in-tree
  // TypeScript caller imports the constant instead.
  if (rawArgv.includes("--trusted-associations")) {
    for (const a of TRUSTED_ASSOCIATIONS) console.log(a);
    return 0;
  }

  // `--check-addressed fp1,fp2,... [--marker-sha SHA]` — used by
  // `answer-summary-finding.ts` to reconcile against the PR's ACTUAL comments
  // before posting a new one, so a driver reclaiming an abandoned held-batch
  // claim after its owner's post already succeeded (but crashed before
  // `release-held`) does not post a SECOND, duplicate comment.
  //
  // This is deliberately NOT a query over `collectAddressed`/`reviewerPosition`,
  // even though that pairing is what the main report below uses and it looks
  // like the obvious thing to reuse. `reviewerPosition` answers "how far has
  // the reviewer read relative to this fix, so should the finding stay
  // suppressed" — a question scoped to the CURRENT sticky's reviewed SHA.
  // Routing this reconciliation through it reintroduced the exact bug it exists
  // to fix: once the reviewer has read the
  // SHA a fix-dependent marker names — reaching it, for a finding outside the
  // backlog blob, or moving past it for any finding — `collectAddressed` treats
  // that marker as EXPIRED, so a driver reconciling right after a legitimate
  // post sees its own just-posted marker as "unaddressed" and posts a second
  // one. This question is different in kind: "did a specific comment
  // I am about to post already get posted" is a fact about the PAST, and
  // whether the reviewer has since reviewed it is irrelevant to whether
  // posting it again would duplicate it. So this matches markers EXACTLY —
  // same fingerprint, same `@sha` suffix (or same bare fingerprint for a
  // durable outcome, which never carries one) — with no expiry test at all.
  // A LATER round asking about the same fingerprint passes a DIFFERENT
  // `--marker-sha` (the new commit it is answering for), so a marker that
  // legitimately expired and is being re-answered under a new SHA is never
  // mistaken for the one this call is about to post.
  //
  // Every flag value and the PR number are stripped out of `argv` before the
  // PR-number scan below, so a wholly-numeric fingerprint (legal under
  // MARKER_SAFE_FINGERPRINT) or a from-digits-only SHA prefix can never be
  // mistaken for the PR.
  const checkIdx = rawArgv.indexOf("--check-addressed");
  const checkFingerprintsArg =
    checkIdx === -1 ? undefined : rawArgv[checkIdx + 1];
  const markerShaIdx = rawArgv.indexOf("--marker-sha");
  const markerShaArg =
    markerShaIdx === -1 ? undefined : rawArgv[markerShaIdx + 1];
  const stripIdx = new Set(
    [
      checkIdx,
      checkIdx === -1 ? -1 : checkIdx + 1,
      markerShaIdx,
      markerShaIdx === -1 ? -1 : markerShaIdx + 1,
    ].filter((i) => i !== -1),
  );
  const argv = rawArgv.filter((_, i) => !stripIdx.has(i));

  let pr = argv.find((a) => /^\d+$/.test(a));
  if (!pr)
    pr = (await gh(["pr", "view", "--json", "number", "-q", ".number"])).trim();
  const prNumber = Number.parseInt(pr, 10);
  if (!Number.isFinite(prNumber)) {
    console.error("summary-findings: could not resolve a PR number");
    return 1;
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

  const issueComments: IssueComment[] = JSON.parse(
    await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    ]),
  ).flat();

  const sticky = issueComments
    .filter(
      (c) =>
        isReviewerLogin(c.user?.login ?? "") && c.body?.includes(STICKY_MARKER),
    )
    .pop();
  // The round the sticky describes. Read here — above the `--check-addressed`
  // branch — so the PRODUCER of a marker's `#<round>` suffix and the CONSUMER
  // that measures the winddown exemption against it read the same field off the
  // same comment. A second source for "which round is this" is a second thing
  // to drift, and a marker stamped with a round the consumer never compares
  // against is a suppression nobody can bound.
  const stickyRound = sticky ? parseReviewRound(sticky.body) : null;
  // Read here — above the `--check-addressed` branch — so that mode's
  // stale-vs-duplicate distinction (`findExactMarkers`) and the main report's
  // exemption (`collectAddressed`, below) key off the exact same backlog
  // snapshot. `decodeBacklog` throws on a malformed blob, which now surfaces
  // as an INDETERMINATE exit for `--check-addressed` too — the same
  // fail-closed direction the main report already took this from.
  const winddownDeferred = sticky
    ? winddownFingerprintsOf(sticky.body)
    : new Set<string>();

  if (checkFingerprintsArg !== undefined) {
    const requested = checkFingerprintsArg.split(",").filter(Boolean);
    for (const fp of requested) {
      if (!MARKER_SAFE_FINGERPRINT.test(fp)) {
        console.error(
          `summary-findings: --check-addressed fingerprint '${fp}' is not MARKER_SAFE_FINGERPRINT-shaped`,
        );
        return 1;
      }
    }
    const markerSources = issueComments
      .filter((c) => !isReviewerLogin(c.user?.login ?? ""))
      .map((c) => ({
        body: c.body ?? "",
        authorAssociation: c.author_association ?? "",
      }));
    const found = findExactMarkers(
      markerSources,
      new Set(requested),
      markerShaArg,
      { winddownDeferred, currentRound: stickyRound },
    );
    console.log(
      JSON.stringify({
        pr: prNumber,
        unaddressed: requested.filter((fp) => !found.has(fp)),
        // `answer-summary-finding.ts` stamps this into the fix-dependent
        // markers it is about to post. Null when the sticky stamps no round (or
        // there is no sticky at all): the marker then carries none, and
        // `collectAddressed` withholds the winddown exemption from it — the
        // fail-closed direction, costing a re-answer rather than an unbounded
        // suppression.
        round: stickyRound,
      }),
    );
    return 0;
  }

  // No sticky comment means the reviewer has posted no summary — there are no
  // summary-only findings to answer. That is a real zero, not an unknown: the
  // caller has separately verified the reviewer's check-run completed on head.
  if (!sticky) {
    const empty: SummaryReport = {
      pr: prNumber,
      stickyCommentId: null,
      declaredUnanchored: 0,
      total: 0,
      findings: [],
      unaddressed: [],
    };
    console.log(JSON.stringify(empty));
    return 0;
  }

  const reviewComments: ReviewComment[] = JSON.parse(
    await gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
    ]),
  ).flat();
  // Scope anchoring to the round this sticky describes. The reviewer stamps
  // `ai-review-round` into its inline comments too, so "did THIS finding get a
  // thread" is answerable without falling back to "has this path ever had one",
  // which hides every later summary-only finding on a path that was anchored
  // once.
  //
  // A sticky carrying NO round marker leaves nothing to scope by, and the
  // historical set is not an acceptable substitute: an anchor SUPPRESSES a
  // bullet, so admitting every inline comment the reviewer ever posted lets a
  // long-resolved comment at the same `path:line` consume a current bullet, and
  // the live finding disappears from `unaddressed` while thread count reads
  // zero — the header's zero-thread false convergence, reached through the one
  // input nobody controls. Fail closed instead: with no round to scope by,
  // nothing anchors, so every bullet stays open work. That costs an answer on a
  // finding that may already have a thread; the other direction costs a live
  // finding, silently.
  // (`stickyRound` itself is read above, where the `--check-addressed` mode also
  // needs it.)
  //
  // NOT a Set: duplicates are the signal. Two inline comments on one line means
  // two bullets there are anchored; one comment means one is.
  const anchoredKeys =
    stickyRound === null
      ? []
      : reviewComments
          .filter((c) => isReviewerLogin(c.user?.login ?? ""))
          .filter((c) => parseReviewRound(c.body ?? "") === stickyRound)
          .map((c) => anchorKey(c.path, c.line ?? null));

  const reviewedSha = reviewedShaFrom(sticky.body);
  // `winddownDeferred` is computed above, before the `--check-addressed`
  // branch, and reused here as-is.
  const addressed = collectAddressed(
    issueComments
      .filter((c) => !isReviewerLogin(c.user?.login ?? ""))
      .map((c) => ({
        body: c.body ?? "",
        authorAssociation: c.author_association ?? "",
      })),
    {
      reviewerPosition: (sha) => reviewerPosition(sha, reviewedSha),
      backlogFingerprints: backlogFingerprintsOf(sticky.body),
      winddownDeferred,
      currentRound: stickyRound,
    },
  );

  console.log(
    JSON.stringify(
      classify({
        pr: prNumber,
        stickyCommentId: sticky.id,
        stickyBody: sticky.body,
        anchoredKeys,
        addressedFingerprints: addressed,
        reviewedSha,
      }),
    ),
  );
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
