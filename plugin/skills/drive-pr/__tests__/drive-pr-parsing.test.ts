/**
 * drive-pr.test.ts — the driver's refusal-to-converge contract.
 *
 * Two halves:
 *
 *   - Unit tests over `summary-findings.ts`'s pure parsing. Every fixture body
 *     is a real shape the self-hosted reviewer has emitted.
 *   - Scripted probes that run `drive-status.ts` against a STUBBED `gh` and
 *     assert the state it reaches. One probe per false-convergence mode listed
 *     in references/terminal-states.md, each pinned to the PR where it was
 *     observed, plus one per terminal state.
 *
 * The probes are the load-bearing half. Every mode below produced a real
 * "converged" from await-round.ts while findings were live, and the only way to
 * keep them fixed is to assert the driver does NOT say CONVERGED in each state.
 *
 * The probes are subprocess integration tests, not unit tests: each one spawns
 * a shell script that itself spawns `gh` and (via drive-status.ts) `bun`. That
 * comfortably exceeds bun's 5s default per-test budget on a loaded machine, and
 * a blown budget presents as SIGTERM — exit 143 — which reads exactly like a
 * script bug. `drive-pr:test` therefore passes `--timeout 30000`; run this file
 * with that flag if you invoke bun directly. The scripts' own deadlines are
 * raised in `beforeAll` for the same reason and with the same care.
 *
 * ── What a probe costs, and when it should not be one ────────────
 *
 * Measured on this file, an otherwise-quiet 16-core machine, 1-min load 9-16:
 *
 *   ONE `drive.ts` drive of a single round   ~7-10s, and 77 `run` calls,
 *                                            21 of them `drive-state.ts`
 *   ONE `drive-status.ts` gate probe         ~0.5s
 *   ONE `drive-state.ts` call, in isolation  ~27ms
 *   bun's own floor (`bun -e 1`)             ~14ms
 *
 * The last two are the point: a spawn is cheap ALONE and expensive INSIDE a
 * drive's process tree — ~27ms becomes ~220ms once twenty of them contend —
 * so cost is superlinear in spawn count, and so is the false-red window under
 * machine load. The whole-file profile says the same thing from the other end:
 * 60% of its CPU is SYSTEM time, which is process creation, not work.
 *
 * So the rule this file follows is NOT "prefer unit tests". It is:
 *
 *   A probe whose assertion names a spawn boundary — an exit code crossing a
 *   process, argv handling, env inheritance, signal delivery, two REAL
 *   processes contending — stays a spawn, however slow.
 *   `guarded-push.ts`'s deadline probes take 10s each and must.
 *
 *   A probe whose assertion names LOGIC — a total function of its input, a
 *   parse, a fold — calls that function. Reaching it through a whole `drive.ts`
 *   buys nothing the assertion mentions and costs ~10s, and the price silently
 *   caps how much of the claim the probe can afford to check: the exit-code
 *   table below could only afford a sample of codes while each cost a drive,
 *   and now enumerates the whole neighbourhood of the one that propagates.
 *
 *   Every conversion keeps a NAMED spawn probe for the edge only a subprocess
 *   can witness, marked `── Spawn-boundary integration floor ──` at its site.
 *   Today those are: `exports a resolved ALIAS to the pass` (the dial reaches
 *   the pass env at all); `exits 1 for a REAL pass that failed` and `propagates
 *   a pass exit 5 as PR_NOT_OPEN` (both branches of the pass-exit mapping reach
 *   a real drive exit); `stops with the stall exit (14) after two passes that
 *   change nothing` and `does not stall-stop while rounds make observable
 *   progress` (both directions of gate → fingerprint → streak → exit). Deleting
 *   a floor probe is deleting the only evidence that a seam is wired in.
 *
 * Measured effect of the pass, same file, same machine, two runs each
 * because one pair of numbers cannot be told apart from noise here:
 *
 *            wall            user + sys      page reclaims   tests
 *   before   729.0s, 733.6s  215s + 332-340s 25.8M           655
 *   after    676.9s, 614.6s  181-187s + 275-291s  22.9M      656
 *
 * Read the CPU column, not the wall column. Wall clock on this machine swings
 * ±15% run to run — an UNTOUCHED block moved 77.0s → 90.2s between the two
 * runs above — because it depends on how many Conductor worktrees are busy.
 * `user + sys` is far steadier and is what actually fell: ~555s → ~456s, -18%.
 * Page reclaims is the load-independent proxy for spawn COUNT (bun maps ~34MB
 * per start), and it fell -11%, which is the mechanism.
 *
 * The per-block deltas that carried it: `--handoff-at` 51.5s → 29.0s, and the
 * stall family 73s → 19s.
 *
 * NOT YET AT THE TARGET of comfortably under half the lefthook budget, and
 * worth saying so rather than leaving the next reader to re-derive it. What
 * remains is not convertible on the same argument: the
 * bulk of `drive.ts loop control` asserts round-loop ORCHESTRATION — when the
 * draft→Ready transition fires relative to the pass, that it fires once, lock
 * recovery mid-pass — where the drive genuinely IS the thing under test, and
 * `announce-merge-ready.ts`'s block is check-then-act ORDERING for the same
 * reason. Converting those would hollow the suite, which is the one thing a
 * conversion must not do.
 *
 * ── Importing a constant instead of spawning for it, measured ────────────
 *
 * `announce-merge-ready.ts` and `reconcile-replied-threads.ts` no longer spawn
 * `summary-findings.ts --trusted-associations`; both now `import
 * TRUSTED_ASSOCIATIONS` from it directly.
 *
 * A clean whole-file before/after pair was NOT obtainable this pass: this
 * machine was carrying far more concurrent Conductor worktrees than the
 * measurement above did, and two whole-file attempts came back at
 * 2019.8s (21 fail, 14 errors) and 1480.0s (8 fail, 7 errors) — every failure
 * a bare 30000ms timeout on `drive.ts loop control`, nothing this pass
 * touched. That is noise from unrelated worktrees, not signal, so it is
 * recorded here rather than presented as a suite-wall-clock result.
 *
 * What IS a clean signal: the two blocks that own every removed spawn, each
 * measured before/after on the SAME loaded machine, so load hits both sides
 * equally:
 *
 *                                    wall            user + sys   page reclaims
 *   announce-merge-ready.ts  before  171.9s, 148.7s, 130.6s   135.7s,125.1s,116.6s  4.25M
 *                            after   152.7s, 127.1s, 126.4s   106.1s,100.5s,100.3s  3.74M
 *   reconcile-replied-threads before 33.3s, 25.9s            26.5s, 25.1s          658K
 *   (excl. the 1000-PR probe)  after  24.6s, 21.9s            17.6s, 17.5s          508K
 *
 * Both blocks fall on every axis, every rep: `announce-merge-ready.ts` user+sys
 * ~125.8s → ~102.3s avg (-19%), page reclaims -12%; `reconcile-replied-threads.ts`
 * user+sys ~25.8s → ~17.6s avg (-32%), page reclaims -23% — the larger
 * percentage there because its test file is smaller than announce-merge-
 * ready.ts's, so the same removed spawns per test carry proportionally more
 * weight in its own total. Direction and rough magnitude agree with the
 * estimate (~90s of the suite's ~677s, from 2 spawns × ~77 `run`
 * calls/round).
 */

import { describe, expect, it } from "bun:test";
import { threadFrom } from "../scripts/lib/sample.ts";
import {
  backlogFingerprintsOf,
  categoryOf,
  classify,
  collectAddressed,
  decodeBacklog,
  findExactMarkers,
  fingerprintOf,
  outcomeOf,
  parseBodyFindings,
  parseDeclaredUnanchored,
  parseMarkerPayload,
  reviewerPosition,
  severityOf,
  WINDDOWN_EXEMPTION_ROUNDS,
  winddownFingerprintsOf,
} from "../scripts/summary-findings";
import {
  BUILTIN_FORMATS,
  jigFormats,
} from "../scripts/lib/severity-formats.ts";

import {
  HEAD,
  PREV,
  BASE,
  BASE_MOVED,
  realHead,
  stickyBody,
  STICKY_ROUND,
  makeOrphanCommit,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

/** The configured reviewer of these fixtures, which writes Jig's own format. */
const REVIEWER = "example-review";
const FORMATS = [...BUILTIN_FORMATS, ...jigFormats([REVIEWER])];
const sev = (text: string, author?: string | null): string =>
  severityOf(text, author, FORMATS);
const jigSeverity = (text: string) => sev(text, REVIEWER);
const codexSeverity = (text: string) => sev(text, "chatgpt-codex-connector");

// ── Unit tests: the summary-only enumerator ─────────────────────────────────

describe("summary-findings parsing", () => {
  it("decodes the reviewer’s base64 backlog blob", () => {
    const entries = decodeBacklog(stickyBody());
    expect(entries).toHaveLength(2);
    expect(entries[0]?.fingerprint).toBe("b9a7a18089043564");
    expect(entries[1]?.severity).toBe("low");
    // Present on entry 0 (`category: 'drift'` in the fixture),
    // absent on entry 1 — degrades to 'unknown' rather than failing the blob.
    expect(entries[0]?.category).toBe("drift");
    expect(entries[1]?.category).toBe("unknown");
    // The reviewer's own provenance for an entry survives the decode, and an
    // entry carrying neither field decodes just as well — DECODING branches on
    // neither, so an absent one must not degrade the entry (nor, per the
    // shape-violation probes below, fail the whole blob). Downstream they
    // differ: `firstRound` is provenance only, while `reason ===
    // 'winddown-deferred'` selects the round-bounded exemption in
    // `collectAddressed` — so an absent `reason` costs an exemption
    // rather than nothing, which is the fail-closed direction.
    expect(entries[0]?.reason).toBe("winddown-deferred");
    expect(entries[0]?.firstRound).toBe(6);
    expect(entries[1]?.reason).toBeUndefined();
  });

  it("returns no entries when the blob is absent", () => {
    expect(decodeBacklog("no markers here")).toHaveLength(0);
  });

  it("throws rather than silently reporting zero when the blob is corrupt", () => {
    // A reviewer-side format change must surface as INDETERMINATE, not as
    // "no held findings" — that would drop live work into a convergence.
    expect(() =>
      decodeBacklog("<!-- ai-review-backlog: bm90anNvbg== -->"),
    ).toThrow();
  });

  // A PRESENT marker has no partial-credit path. Each of these decodes to valid
  // JSON, so an earlier version returned `[]` or a silently-filtered list —
  // turning a reviewer format change into a clean convergence over held work.
  it.each([
    ["a JSON object rather than an array", '{"fingerprint":"a"}'],
    ["an entry that is not an object", '["nope"]'],
    ["an entry with no fingerprint", '[{"path":"a.md","comment":"x"}]'],
    ["an entry with no path", '[{"fingerprint":"a","comment":"x"}]'],
    [
      "an entry with an empty comment",
      '[{"fingerprint":"a","path":"b","comment":""}]',
    ],
    [
      "an entry with a non-numeric line",
      '[{"fingerprint":"a","path":"b","comment":"c","line":"7"}]',
    ],
    // A fingerprint is the key push() dedups on and the key an answer marker
    // clears, so two entries sharing one silently become one finding and a
    // single answer retires a second nobody read. Malformed, not deduplicated.
    [
      "two entries under one fingerprint",
      '[{"fingerprint":"a","path":"b","comment":"first"},{"fingerprint":"a","path":"c","comment":"second"}]',
    ],
    // The fingerprint reaches summary-findings.ts through the addressed marker
    // and nowhere else, and that channel is lossy: the marker regex captures
    // `[^\s>]+`, and `collectAddressed` splits the captured value at its last
    // `@` to read a landed SHA. A fingerprint carrying either is written whole
    // and read back mangled, so no answer can ever key it — the finding stays
    // unaddressed on every later head and the drive can NEVER converge. That is
    // a liveness failure, so it is caught where the identifier ENTERS.
    [
      "a fingerprint containing @, which the marker reads back as a SHA suffix",
      '[{"fingerprint":"abc@def","path":"b","comment":"c"}]',
    ],
    [
      "a fingerprint containing whitespace, which truncates the marker",
      '[{"fingerprint":"abc def","path":"b","comment":"c"}]',
    ],
    [
      "a fingerprint containing >, which ends the HTML comment early",
      '[{"fingerprint":"abc>def","path":"b","comment":"c"}]',
    ],
    [
      // `#` now round-trips correctly on its own (parseMarkerPayload only
      // reads a round when an `@` precedes it) — this stays excluded from
      // MARKER_SAFE_FINGERPRINT anyway, not because of a live round-trip
      // ambiguity but because no producer emits one. See the docstring above
      // MARKER_SAFE_FINGERPRINT.
      "a fingerprint containing #, which is excluded from the marker fingerprint vocabulary",
      '[{"fingerprint":"abc#7","path":"b","comment":"c"}]',
    ],
  ])(
    "throws on a well-formed-JSON but wrong-shape blob: %s",
    (_label, json) => {
      const marker = `<!-- ai-review-backlog: ${Buffer.from(json).toString("base64")} -->`;
      expect(() => decodeBacklog(marker)).toThrow(
        /ai-review-backlog present but/,
      );
    },
  );

  it("parses body finding bullets but not the <details> backlog rendering", () => {
    const found = parseBodyFindings(stickyBody());
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(".claude/agents/review-arbiter.md");
    expect(found[0]?.line).toBe(31);
    // The `AGENTS.md` bullet lives inside <details>; counting it here would
    // double-count the backlog entry that already carries it.
    expect(found.some((f) => f.path === "AGENTS.md")).toBe(false);
  });

  it("reads the reviewer’s declared unanchored count", () => {
    expect(parseDeclaredUnanchored(stickyBody())).toBe(0);
    expect(parseDeclaredUnanchored(stickyBody({ unanchored: 2 }))).toBe(2);
  });

  it("extracts severity from the bullet", () => {
    expect(jigSeverity("🟡 **medium** (high confidence)")).toBe("medium");
    expect(jigSeverity("no severity here")).toBe("unknown");
  });

  it("maps a shields.io priority badge onto the canonical severity vocabulary", () => {
    expect(
      codexSeverity(
        "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Mechanize severity**",
      ),
    ).toBe("high");
    expect(
      codexSeverity(
        "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Bootstrap the calibration command**",
      ),
    ).toBe("medium");
    // Each reviewer's comments are read in its own format only: a badge
    // that does not lead Codex's line 0 is not a severity, and Jig's format
    // does not read a badge.
    expect(codexSeverity("🟠 **high** · ![P2 Badge](...)")).toBe("unknown");
    expect(jigSeverity("![P1 Badge](...) title")).toBe("unknown");
    expect(codexSeverity("![P9 Badge](...) not a real priority")).toBe(
      "unknown",
    );
  });

  it("confines the badge matcher to line 0 too, not just the bold-token matcher", () => {
    // The badge matcher's own leading whitespace used to be `\s*`, which
    // matches `\n` — exactly the hole already closed for SEVERITY_FIELD's
    // prefix above, reopened here because the two matchers only shared the
    // INTENT in prose, not the whitespace class that actually enforces it. A
    // header whose real line 0 carries no severity at all must not arm the
    // ladder off a badge that only appears once the text has walked to line 1.
    expect(
      codexSeverity("\n![P1 Badge](https://img.shields.io/badge/P1-orange)"),
    ).toBe("unknown");
    expect(
      codexSeverity(
        "Some unrelated title\n![P2 Badge](https://img.shields.io/badge/P2-yellow)",
      ),
    ).toBe("unknown");
    // A real badge on line 0 still parses, tabs included.
    expect(
      codexSeverity("\t![P1 Badge](https://img.shields.io/badge/P1-orange)"),
    ).toBe("high");
  });

  it("enumerates the severity-field prefix — a backtick or digit before the token is not a severity", () => {
    // `[^\p{L}\n]*` ("any non-letter run") was far wider than the shape it
    // claimed to match. Two decoys show it; both are severity-LESS findings,
    // so classifying them inverts the fail-open contract at its load-bearing
    // input — `severityOf` feeds `fail_open.inert_when_unknown`, and a finding
    // that should read `unknown` (ladder inert) instead armed the ladder.
    expect(
      jigSeverity(
        "`**low**` is a supported token, not this finding’s severity.",
      ),
    ).toBe("unknown");
    expect(jigSeverity("3 **low**-level branches are skipped")).toBe("unknown");
    // The real formats still parse: emoji + space, and a bare token.
    expect(jigSeverity("\u{1F7E1} **medium** \u00b7 correctness")).toBe(
      "medium",
    );
    expect(jigSeverity("**high** \u00b7 no emoji at all")).toBe("high");
  });

  it("narrows the prefix to the coloured circles and to line 0 — a warning sign, or a decoration-only first line, is not a severity", () => {
    // The first enumeration was still two steps too wide, and each step had
    // its own decoy. `\p{Extended_Pictographic}` admits every emoji rather
    // than the coloured circles the contract names, so a title merely OPENING
    // with a warning sign classified `blocker`…
    expect(
      jigSeverity("\u26a0\ufe0f **blocker** behavior is unsupported"),
    ).toBe("unknown");
    // …and `\s` matches `\n`, so dropping the `m` flag never confined the
    // match to line 0 at all — the PREFIX walked to line 1 by itself. Note
    // this decoy defeats the circle fix alone: swap the warning sign for a
    // real circle and the whitespace branch is the only thing still holding
    // the line.
    expect(jigSeverity("\u26a0\ufe0f\n**low** is only an example token")).toBe(
      "unknown",
    );
    expect(jigSeverity("\u{1F7E1}\n**low** is only an example token")).toBe(
      "unknown",
    );
    // Every coloured circle the reviewers actually emit still parses, as does
    // the bare-token form.
    for (const circle of [
      "\u{1F534}",
      "\u{1F535}",
      "\u{1F7E0}",
      "\u{1F7E1}",
      "\u{1F7E2}",
      "\u{1F7E3}",
      "\u{1F7E4}",
      "\u26aa",
      "\u26ab",
    ]) {
      expect(jigSeverity(`${circle} **medium** \u00b7 correctness`)).toBe(
        "medium",
      );
    }
    expect(jigSeverity("\t**low** \u00b7 leading tab")).toBe("low");
    // The VS16 branch is DEFENSIVE and unreachable via any circle in the
    // class today (all are Emoji_Presentation=Yes), so this asserts what it
    // would do rather than a shape any emitter currently produces. Kept
    // deliberately, and labelled so, because an unlabelled probe over an
    // unreachable state reads as evidence that something emits it.
    expect(jigSeverity("\u{1F7E1}\ufe0f **high** \u00b7 x")).toBe("high");
    // …and the defensive branch must not become a way back across a line.
    expect(jigSeverity("\u{1F7E1}\ufe0f\n**low** is an example")).toBe(
      "unknown",
    );
  });

  it("requires VS16 to follow a circle rather than standing alone; ZWJ is not decoration at all", () => {
    // The first cut of the circle-only fix still listed VS16 and ZWJ as their
    // own top-level branches under `*`, so each was independently reachable
    // with no circle anywhere before it. A stray invisible code point sitting
    // directly in front of a quoted bold token — plausible copy-paste
    // noise in prose, not decoration a reviewer emitted — then classified
    // as a real severity instead of `unknown`, arming a ladder that should
    // have failed open.
    expect(jigSeverity("\ufe0f**high** hidden VS16")).toBe("unknown");
    expect(jigSeverity("\u200d**low** hidden ZWJ")).toBe("unknown");
    // Binding the modifier to a preceding circle closed the standalone case
    // above but not this one: a ZWJ joins its base to whatever follows it, so
    // a circle immediately followed by a ZWJ and then the bold token — with
    // nothing after the ZWJ to join with — is an incomplete, dangling
    // sequence, not decoration. This used to classify `high`; the ZWJ branch
    // is now removed entirely rather than re-patched, so it reads `unknown`.
    expect(jigSeverity("\u{1F7E1}\u200d**high** hidden ZWJ")).toBe("unknown");
    // A run of several circles, each optionally carrying its own VS16, still
    // parses — the fix binds a modifier to ITS circle, it does not forbid
    // more than one circle in the prefix.
    expect(
      jigSeverity("\u{1F7E1}\ufe0f\u{1F534} **high** \u00b7 two circles"),
    ).toBe("high");
  });

  it("anchors the bold severity token to line 0 of the header — no `m` flag", () => {
    // An earlier fix anchored the bold matcher to line 0 of the header but
    // carried the `m` flag, so `^` restarted on EVERY header line and the
    // anchor it claimed to add was defeated by any header whose second line
    // BEGINS with a quoted token (only non-letters may precede it, which a
    // leading backtick satisfies) — ordinary prose in a finding about severity
    // parsing.
    // A severity-less finding was classified `low`, bypassing
    // fail_open.inert_when_unknown. Mutation-checked: re-adding `m` reddens
    // this.
    expect(
      jigSeverity(
        "Anchor severity parsing to the header\n`**low**` is a supported token, and this line begins with it.",
      ),
    ).toBe("unknown");
    // …while a REAL severity field on line 0 still parses, with body prose
    // below it quoting a different token as an example.
    expect(
      jigSeverity(
        "\u{1F7E0} **high** \u00b7 correctness\nCompare against `**blocker**` for the top tier.",
      ),
    ).toBe("high");
  });

  it("does not pick up a badge quoted later in the body as an example", () => {
    // A low-severity finding whose explanation quotes a higher-severity badge
    // as an example must not be misread as that higher severity — the badge
    // is only a signal in the leading header position.
    expect(
      codexSeverity(
        "Explanation text with no leading badge that later quotes ![P0 Badge](...) as an example of the wrong shape.",
      ),
    ).toBe("unknown");
  });

  it("does not pick up a bold token quoted later in the body of a badge-format finding", () => {
    // A P2 (medium) badge finding whose own explanation quotes a
    // higher-severity BOLD token as an example of a malformed shape must not
    // be misread as that higher severity — the badge-format header carries no
    // bold canonical token of its own, so an unscoped search falls through to
    // the body and finds the decoy instead (the bold-token counterpart of the
    // badge case above).
    expect(
      codexSeverity(
        "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Some title**\n\n" +
          "For example, `This low-priority finding demonstrates the malformed token **blocker**` returns `blocker`.",
      ),
    ).toBe("medium");
  });

  it("does not pick up a bold token quoted in a badge-format finding's own title", () => {
    // A badge-format header whose TITLE (not body) quotes a bold canonical
    // token as a decoy must still classify by the leading badge, not the
    // decoy — the badge matcher is anchored to the structurally leading
    // position and runs before the unanchored bold-token search, so a decoy
    // anywhere later in the header can no longer win (the title-level
    // counterpart of the body-level case above).
    expect(
      codexSeverity(
        "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Handle the **blocker** token**",
      ),
    ).toBe("medium");
  });

  it("does not pick up a bold token quoted in a severity-less, badge-less title", () => {
    // No badge and no leading severity field at all — just a title that
    // happens to quote a canonical word in bold. Every earlier round narrowed
    // WHERE the bold search ran (leading paragraph, past HTML comments,
    // after the badge check) without ever anchoring the search ITSELF, so an
    // unscoped `header.match(/\*\*(...)\*\*/i)` still found this decoy
    // wherever it sat in the header. The token must now be the leading
    // content of the header — no letters before it, only emoji/punctuation/
    // whitespace, the shape every real severity field has.
    expect(jigSeverity("Handle the **blocker** token safely")).toBe("unknown");
  });

  it("scopes past leading ai-review HTML-comment markers to find the header", () => {
    // The AI reviewer's real inline-comment shape leads with several
    // `<!-- ai-review-* -->` marker lines before the severity bullet — the
    // header/body split must skip those rather than treating the first
    // marker line as the whole header.
    expect(
      jigSeverity(
        "<!-- ai-review-inline -->\n<!-- ai-review-fp: abc123 -->\n<!-- ai-review-round: 11 -->\n" +
          "🟡 **medium** · 🎯 correctness · confidence: high\n\n" +
          "For example, `This low-priority finding demonstrates the malformed token **blocker**` returns `blocker`.",
      ),
    ).toBe("medium");
  });

  it("does not strip a leading comment that is not an ai-review marker", () => {
    // Only `<!-- ai-review-* -->` markers are stripped before the header is
    // computed. An unrelated leading HTML comment must be left in place, so
    // it stays part of the (marker-only) first paragraph rather than
    // exposing whatever body prose follows it as the header — otherwise a
    // bold token quoted there as an example is misread as the real severity.
    expect(
      jigSeverity(
        "<!-- some unrelated editor comment -->\n\n" +
          "For example, `This low-priority finding demonstrates the malformed token **blocker**` returns `blocker`.",
      ),
    ).toBe("unknown");
  });

  // The reviewer's `🏷️ category:` tag, parsed the same way and with the same
  // fallback contract as severity.
  it("extracts category from the header tag", () => {
    expect(
      categoryOf("🟠 **high** · 🏷️ category: data-integrity · confidence: high"),
    ).toBe("data-integrity");
    // The reviewer contract's illustrative example renders the FULL bullet line
    // (`` - `path:line` — <text> ``), but `categoryOf` never sees that raw
    // line in production: `parseBodyFindings` strips the loc/dash prefix
    // first and passes only the text after it — exactly what's fed here.
    // The leading `` - `service/db.ts:42` — `` prefix, if handed to
    // `categoryOf` directly, is exactly the class of decoy
    // `CATEGORY_LEAD_FIELD` now correctly rejects: it isn't
    // permitted-decoration-only before the severity token, so severityOf
    // itself would call it `unknown` too.
    expect(
      categoryOf(
        "🟠 **high** · 🏷️ category: compliance (correctness · beyond-pr) — retention policy is unenforced",
      ),
    ).toBe("compliance");
  });

  it("falls back to unknown when the reviewer emits no category token — the backward-compatible, older shape", () => {
    // The reviewer emits NO token at all for an uncategorized finding — never
    // `category: unknown` — so an older comment and an uncategorized
    // one are indistinguishable here, both reading `unknown`.
    expect(categoryOf("🟡 **medium** · confidence: high")).toBe("unknown");
    expect(categoryOf("no category here")).toBe("unknown");
  });

  it("scopes the category search to the header, past leading ai-review markers, the same as severityOf", () => {
    expect(
      categoryOf(
        "<!-- ai-review-inline -->\n<!-- ai-review-fp: abc123 -->\n" +
          "🟡 **medium** · 🏷️ category: security · confidence: high\n\n" +
          "For example, `🏷️ category: docs` would be a different category if this were the header.",
      ),
    ).toBe("security");
    // A tag quoted as an example in a SEPARATE paragraph (past the first
    // blank line) must not be misread as the real category — the same decoy
    // class severityOf's own header scoping exists to reject.
    expect(
      categoryOf(
        "🟡 **medium** · confidence: high\n\n" +
          "For example, `🏷️ category: docs` is how a docs finding would be tagged.",
      ),
    ).toBe("unknown");
  });

  it("restricts the category search to the header’s OWN line 0, rejecting a decoy on a later header line before any blank line", () => {
    // The exact multi-line decoy class that took severityOf three fixes to
    // close: a SECOND line of the same header block — no blank line before
    // it — quoting the tag as an example. A whole-header (unanchored) search
    // finds it; scoping to line 0 does not.
    expect(
      categoryOf(
        "Some title line with no category tag on it.\n" +
          "For example, this line quotes `🏷️ category: security` as an example.",
      ),
    ).toBe("unknown");
    // …while a REAL tag on line 0 still parses, with a later header line (no
    // blank line before it) quoting a different token as an example.
    expect(
      categoryOf(
        "🟡 **medium** · 🏷️ category: docs · confidence: high\n" +
          "For example, `🏷️ category: security` would read differently.",
      ),
    ).toBe("docs");
  });

  it("rejects a decoy quoted ON line 0 itself, with no real field present", () => {
    // The finding's own title quotes the syntax as a backtick-fenced
    // example — unlike the multi-line decoy above, this sits on line 0, so
    // the line-0 restriction alone does not reject it. Nothing precedes
    // `🏷️` here but a backtick, never the `·` separator every real field
    // is joined by, so this must still read `unknown`.
    expect(categoryOf("Fix parsing of `🏷️ category: security`")).toBe("unknown");
    // The same decoy, now sharing line 0 with a REAL severity token that
    // carries no category of its own — the `·` before `🏷️` must belong to
    // the metadata segment itself, not to any `·` anywhere earlier in the
    // line.
    expect(
      categoryOf(
        "🟡 **medium** · confidence: high — Fix parsing of `🏷️ category: security`",
      ),
    ).toBe("unknown");
    // A real tag, still correctly extracted when it is genuinely preceded
    // by the `·` separator — guards against an over-broad fix that starts
    // rejecting every match.
    expect(
      categoryOf("🟡 **medium** · 🏷️ category: docs · confidence: high"),
    ).toBe("docs");
  });

  it("rejects a malformed token instead of truncating it to a valid-looking prefix", () => {
    // An unbounded token class (`[a-z][a-z-]*`) read `security_critical` as
    // `security` — accepting the field's syntax while silently discarding
    // the part that made it invalid, rather than falling through to
    // `unknown`. Same for a digit suffix and a dangling trailing hyphen.
    expect(
      categoryOf(
        "🟡 **medium** · 🏷️ category: security_critical · confidence: high",
      ),
    ).toBe("unknown");
    expect(
      categoryOf("🟡 **medium** · 🏷️ category: security2 · confidence: high"),
    ).toBe("unknown");
    expect(
      categoryOf("🟡 **medium** · 🏷️ category: security- · confidence: high"),
    ).toBe("unknown");
    // A hyphenated multi-word token is still valid and unaffected by the
    // boundary check.
    expect(
      categoryOf(
        "🟡 **medium** · 🏷️ category: data-integrity · confidence: high",
      ),
    ).toBe("data-integrity");
  });

  it("rejects a category-shaped field with no genuine severity field leading it", () => {
    // Neither decoy has a `·` immediately preceding `🏷️` that actually
    // separates it from a real severity field — the first has nothing
    // before it at all, the second has only prose ending in "of". The old
    // "some `·` (or line start) precedes the tag" check accepted both.
    expect(categoryOf("🏷️ category: security is valid syntax")).toBe("unknown");
    expect(categoryOf("Fix parsing of · 🏷️ category: security")).toBe("unknown");
  });

  it("restricts the category match to the field right after severity, not any later field", () => {
    // A genuine severity field followed by an unrelated field, followed by a
    // quoted-looking category tag two fields later — nothing here is a real
    // category, since the reviewer always renders the tag immediately after
    // severity. Scanning every later field for a match (rather than only the
    // one right after severity) let this fabricate `security`.
    expect(
      categoryOf(
        "🟡 **medium** · confidence: high — Explain separator · 🏷️ category: security",
      ),
    ).toBe("unknown");
  });

  it("rejects trailing prose left dangling after the token, with a genuine leading severity field", () => {
    // The decoy above omits the leading severity field, so it is rejected by
    // CATEGORY_LEAD_FIELD before CATEGORY_FIELD's own right boundary is ever
    // exercised — `fields.length < 2` short-circuits it. With a real `**medium**`
    // field ahead of it, the same malformed middle reaches CATEGORY_FIELD, whose
    // old `(?=\s|$)` lookahead checked only the character immediately after the
    // token — matching `security` and silently discarding `is valid syntax`.
    expect(
      categoryOf("🟡 **medium** · 🏷️ category: security is valid syntax"),
    ).toBe("unknown");
  });

  it("rejects a lead field that merely ENDS with a bold severity token, matching severityOf’s own leading-content requirement", () => {
    // `Fix the **medium**` ends with `**medium**` but is not a genuine
    // severity field — `severityOf` requires nothing but permitted decoration
    // (whitespace/emoji/VS16/ZWJ) before the token, and prose like "Fix the "
    // fails that. The old CATEGORY_LEAD_FIELD only checked the suffix, so it
    // accepted this title as a lead field and fabricated a category on a
    // header severityOf itself classifies `unknown`.
    expect(jigSeverity("Fix the **medium** · 🏷️ category: security")).toBe(
      "unknown",
    );
    expect(categoryOf("Fix the **medium** · 🏷️ category: security")).toBe(
      "unknown",
    );
    // A real lead field — only permitted decoration before the token — still
    // parses.
    expect(categoryOf("🟡 **medium** · 🏷️ category: security")).toBe("security");
  });

  it("threads category through classify for every finding source", () => {
    const backlog = JSON.stringify([
      {
        fingerprint: "fp-backlog-cat",
        path: "a.ts",
        comment: "a backlog finding",
        severity: "low",
        category: "style",
      },
    ]);
    const body = [
      "<!-- ai-code-review -->",
      "### headline",
      "",
      "- `b.ts:1` — 🟠 **high** · 🏷️ category: security · confidence: high — a real finding",
      "",
      // `declared` (3) exceeds what backlog + body classify (2), so a third,
      // `unaccounted` slot is created — exercising all three `push()` sites in
      // one pass.
      "> 3 finding(s) without a diff-anchorable line are in the summary above only.",
      "",
      `<!-- ai-reviewed-sha: ${HEAD} -->`,
      `<!-- ai-review-backlog: ${Buffer.from(backlog).toString("base64")} -->`,
    ].join("\n");
    const r = classify({
      pr: 1,
      stickyCommentId: 1,
      stickyBody: body,
      anchoredKeys: [],
      addressedFingerprints: new Set(),
    });
    expect(r.findings.find((f) => f.source === "backlog")?.category).toBe(
      "style",
    );
    expect(r.findings.find((f) => f.source === "body")?.category).toBe(
      "security",
    );
    expect(r.findings.find((f) => f.source === "unaccounted")?.category).toBe(
      "unknown",
    );
  });

  it("reads summary bullets in the sticky author's severity formats", () => {
    const body = [
      "<!-- ai-code-review -->",
      "### headline",
      "",
      "- `a.ts:12` — ![P1 Badge](https://img.shields.io/badge/P1-orange) badge finding",
      "- `b.ts:3` — 🟡 **medium** · 🏷️ category: correctness — jig finding",
      "",
    ].join("\n");
    const severities = (stickyAuthor: string | null) =>
      classify({
        pr: 1,
        stickyCommentId: 1,
        stickyBody: body,
        stickyAuthor,
        anchoredKeys: [],
        addressedFingerprints: new Set(),
      }).findings.map((f) => f.severity);
    // The Codex connector's badge is read from its sticky, and Jig's own
    // format still applies to whoever posted the sticky.
    expect(severities("chatgpt-codex-connector[bot]")).toEqual([
      "high",
      "medium",
    ]);
    // Any other author's sticky reads Jig's format only.
    expect(severities("some-reviewer[bot]")).toEqual(["unknown", "medium"]);
    expect(severities(null)).toEqual(["unknown", "medium"]);
  });

  // CodeRabbit's current inline-finding header — three
  // italic, pipe-delimited fields (category | severity | effort) — matched
  // neither the bold-token matcher nor the badge matcher, so 100% of its
  // findings read `unknown` and the decline ladder was inert for all of them
  // across three independent PRs. Every fixture below is
  // a real header verbatim from one of those PRs.
  it("reads CodeRabbit’s pipe-delimited severity field, from CodeRabbit", () => {
    // Every fixture also carries `'coderabbitai'` as the second argument —
    // the shape alone no longer classifies; see `severityOf`'s own doc for
    // why an author-blind version of this exact test would be a false
    // positive on the class it exists to catch.
    expect(
      sev(
        "_🩺 Stability & Availability_ | _🔴 Critical_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("blocker");
    expect(
      sev(
        "_📐 Maintainability & Code Quality_ | _🟡 Minor_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("low");
    expect(
      sev(
        "_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("high");
    // The emoji before the token is optional — only the word is load-bearing.
    expect(sev("_Stability_ | _Critical_ | _Quick win_", "coderabbitai")).toBe(
      "blocker",
    );
  });

  // CodeRabbit added a fourth tier, `🔵 Trivial`, below `Minor`.
  // The matcher knew only Critical/Major/Minor, so every Trivial finding read
  // `unknown` and the decline ladder was inert for it. Both headers below are
  // verbatim CodeRabbit inline-finding headers.
  it("reads CodeRabbit’s `Trivial` tier as the weakest canonical severity", () => {
    expect(
      sev(
        "_📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("low");
    expect(
      sev(
        "_📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _💤 Low value_",
        "coderabbitai",
      ),
    ).toBe("low");
    // The author gate still binds the new token.
    expect(
      sev(
        "_📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _⚡ Quick win_",
        "example-review",
      ),
    ).toBe("unknown");
  });

  // CodeRabbit moved its three header fields from `_italic_` to
  // `**bold**` (2026-10-09). Every real header below is verbatim from one PR;
  // the `Critical` row has no real instance there (none was raised), so it is
  // the earlier italic header re-emphasized with the same marker.
  it("reads CodeRabbit’s **bold** header across all four tiers", () => {
    const cases: Array<[string, string]> = [
      [
        "**🩺 Stability & Availability** | **🔴 Critical** | **⚡ Quick win**",
        "blocker",
      ],
      ["**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**", "high"],
      [
        "**🗄️ Data Integrity & Integration** | **🟠 Major** | **🏗️ Heavy lift**",
        "high",
      ],
      [
        "**🎯 Functional Correctness** | **🟡 Minor** | **⚡ Quick win**",
        "low",
      ],
      [
        "**📐 Maintainability & Code Quality** | **🟡 Minor** | **⚡ Quick win**",
        "low",
      ],
      [
        "**📐 Maintainability & Code Quality** | **🔵 Trivial** | **⚡ Quick win**",
        "low",
      ],
    ];
    for (const [header, expected] of cases) {
      expect(sev(header, "coderabbitai")).toBe(expected);
      // The author gate binds the bold form exactly as it binds the italic one.
      expect(sev(header, "shadow-review")).toBe("unknown");
      expect(sev(header)).toBe("unknown");
    }
    // The emoji is optional in the bold form too.
    expect(
      sev("**Stability** | **Critical** | **Quick win**", "coderabbitai"),
    ).toBe("blocker");
    // A header followed by the finding body still reads from line 0.
    expect(
      sev(
        "**🔒 Security & Privacy** | **🟠 Major** | **⚡ Quick win**\n\n`foo` leaks the token.",
        "coderabbitai",
      ),
    ).toBe("high");
  });

  it("accepts either emphasis marker field by field, not only a uniform header", () => {
    expect(
      sev("**🔒 Security** | _🟠 Major_ | **⚡ Quick win**", "coderabbitai"),
    ).toBe("high");
    expect(
      sev("_🔒 Security_ | **🟠 Major** | _⚡ Quick win_", "coderabbitai"),
    ).toBe("high");
  });

  it("keeps the shape guards on the bold form: arity, end-to-end match, wrapped fields", () => {
    // Bold equivalents of the italic decoys below.
    const decoy = "**Expected** | **Critical** | **Actual**";
    expect(sev(decoy)).toBe("unknown");
    expect(sev(decoy, "chatgpt-codex-connector")).toBe("unknown");
    expect(sev(decoy, "shadow-review")).toBe("unknown");
    // Authorship still gates the path rather than disabling it.
    expect(sev(decoy, "coderabbitai")).toBe("blocker");
    // Two fields, four fields.
    expect(sev("**🩺 Stability** | **🔴 Critical**", "coderabbitai")).toBe(
      "unknown",
    );
    expect(
      sev(
        "**🩺 Stability** | **🔴 Critical** | **⚡ Quick win** | **extra**",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // Trailing effort field not emphasized at all.
    expect(
      sev(
        "**🩺 Stability** | **🔴 Critical** | not bold at all",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // Severity token embedded in a longer field, not the field"s whole
    // content. Each fixture defeats exactly ONE anchor of
    // `CODERABBIT_SEVERITY_FIELD` (trailing text breaks `$`; leading text
    // breaks `^`), so removing either anchor alone turns a probe red.
    expect(
      sev(
        "**🩺 Stability** | **Critical is a token** | **⚡ Quick win**",
        "coderabbitai",
      ),
    ).toBe("unknown");
    expect(
      sev(
        "**🩺 Stability** | **see Critical** | **⚡ Quick win**",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // A longer word that merely begins with a token.
    expect(
      sev("**🩺 Stability** | **Majority** | **⚡ Quick win**", "coderabbitai"),
    ).toBe("unknown");
    // Unknown vocabulary word.
    expect(
      sev("**some field** | **not a severity** | **third**", "coderabbitai"),
    ).toBe("unknown");
    // Two separate bold spans are not one wrapped field.
    expect(
      sev(
        "**a** and **b** | **🔴 Critical** | **⚡ Quick win**",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // A single bold field with no pipes.
    expect(sev("**🔴 Critical**", "coderabbitai")).toBe("unknown");
  });

  it("requires the raising comment be authored by CodeRabbit, not merely shaped like its header", () => {
    // Exactly CodeRabbit's three-field shape, with a real severity token in
    // the middle — but this is a bug report's own before/after fields, not a
    // CodeRabbit finding. The arity+shape fix alone still misread this
    // as `blocker`; only gating on authorship closes it.
    const decoy = "_Expected_ | _Critical_ | _Actual_";
    expect(sev(decoy)).toBe("unknown");
    expect(sev(decoy, null)).toBe("unknown");
    expect(sev(decoy, "chatgpt-codex-connector")).toBe("unknown");
    expect(sev(decoy, "example-review")).toBe("unknown");
    // The identical shape, actually from CodeRabbit, still classifies —
    // authorship gates the path, it does not disable it.
    expect(sev(decoy, "coderabbitai")).toBe("blocker");
  });

  it("does not misread an unrelated pipe character in another reviewer’s prose as CodeRabbit’s header", () => {
    // Author is `'coderabbitai'` throughout this test so each case actually
    // exercises the `pipe-fields` shape's own rejection rather than
    // returning `unknown` on the author gate alone.
    //
    // No genuine lead field (not wrapped `_..._`) — a decoy pipe in ordinary
    // prose must not be mistaken for CodeRabbit's category|severity split.
    expect(
      sev("Use a pipe | for separation, not a comma.", "coderabbitai"),
    ).toBe("unknown");
    // A lead field that IS italic-wrapped but whose second field is not one of
    // CodeRabbit's severity tokens must still read unknown, not guess.
    expect(
      sev("_some field_ | _not a severity_ | _third_", "coderabbitai"),
    ).toBe("unknown");
    // A single field (no pipe at all) — the pre-existing bold/badge matchers
    // still own this shape; the CodeRabbit matcher must not fire on it.
    expect(sev("_🔴 Critical_", "coderabbitai")).toBe("unknown");
    // CodeRabbit's comments are read in CodeRabbit's format only, so Jig's
    // own bold token from that login is not a severity.
    expect(
      sev(
        "🟠 **high** — not the pipe-delimited CodeRabbit shape",
        "coderabbitai",
      ),
    ).toBe("unknown");
  });

  it("requires an exact end-to-end match on CodeRabbit’s severity field, not merely a quoted decoy inside a longer field", () => {
    // The token must be the field's ENTIRE content — a body sentence quoting
    // `_Critical_` as an example inside a longer field must not match, the
    // same discipline `SEVERITY_FIELD` and `CATEGORY_FIELD` already apply.
    expect(
      sev(
        "_🩺 Stability_ | _for example, _Critical_ is a token_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // The same one-anchor-at-a-time discipline for the italic form: each of
    // these defeats only `$` or only `^`.
    expect(
      sev(
        "_🩺 Stability_ | _Critical is a token_ | _⚡ Quick win_",
        "coderabbitai",
      ),
    ).toBe("unknown");
    expect(
      sev("_🩺 Stability_ | _see Critical_ | _⚡ Quick win_", "coderabbitai"),
    ).toBe("unknown");
  });

  it("requires exactly three CodeRabbit fields, rejecting a truncated or padded header", () => {
    // Two fields (category | severity, no effort) — must not be accepted on
    // the strength of the first two fields alone.
    expect(sev("_🩺 Stability_ | _🔴 Critical_", "coderabbitai")).toBe(
      "unknown",
    );
    // Four-plus fields — an extra trailing field must not be silently
    // ignored either.
    expect(
      sev(
        "_🩺 Stability_ | _🔴 Critical_ | _⚡ Quick win_ | _extra_",
        "coderabbitai",
      ),
    ).toBe("unknown");
    // The trailing effort field must itself look like a genuine italic
    // field, not merely be present — a decoy that happens to carry three
    // pipe-delimited segments must not pass on arity alone.
    expect(
      sev("_🩺 Stability_ | _🔴 Critical_ | not italic at all", "coderabbitai"),
    ).toBe("unknown");
  });

  it("leaves CodeRabbit’s freeform category field unmapped — reads unknown, safely", () => {
    // categoryOf's `🏷️ category:` shape does not match CodeRabbit's freeform
    // lead field at all — this is deliberate (see categoryOf's doc comment):
    // no confirmed mapping from CodeRabbit's prose vocabulary onto the closed
    // `categories:` taxonomy exists, and `category` is not in
    // `fail_open.inert_when_unknown`, so an unknown category never disarms
    // the ladder the way an unknown severity does.
    expect(
      categoryOf(
        "_🩺 Stability & Availability_ | _🔴 Critical_ | _⚡ Quick win_",
      ),
    ).toBe("unknown");
  });

  it("threads the raising comment’s real author through threadFrom into severityOf — not merely severityOf called directly", () => {
    // Every fixture above calls `severityOf` with a hand-supplied login,
    // which proves the function's own authorship gate but nothing about
    // whether `threadFrom` (the actual GraphQL-to-ThreadSample consumer)
    // extracts and forwards `firstAuthor?.login` correctly. An earlier fix
    // wired that up in `lib/sample.ts`; this exercises it end to end.
    const node = {
      id: "T-coderabbit",
      path: "a.ts",
      line: 1,
      isResolved: false,
    };
    const coderabbitBody =
      "_🩺 Stability & Availability_ | _🔴 Critical_ | _⚡ Quick win_";

    const fromCodeRabbit = threadFrom(
      node,
      [
        {
          url: "https://example.invalid/cr1",
          authorAssociation: "NONE",
          createdAt: "2026-08-01T00:00:00Z",
          author: { login: "coderabbitai", __typename: "Bot" },
          body: coderabbitBody,
        },
      ],
      false,
    );
    expect(fromCodeRabbit.severity).toBe("blocker");

    // Identical shape, a different (non-CodeRabbit) author — threadFrom must
    // not classify it, the same authorship gate severityOf enforces when
    // called directly. This is what catches a regression where threadFrom
    // stops forwarding `firstAuthor?.login` at all: every fixture above would
    // stay green (severityOf is still correct in isolation) while this thread
    // silently starts reading `unknown` for genuine CodeRabbit findings, or
    // — the more dangerous direction — starts misreading decoys as real ones.
    const fromDecoy = threadFrom(
      node,
      [
        {
          url: "https://example.invalid/cr2",
          authorAssociation: "NONE",
          createdAt: "2026-08-01T00:00:00Z",
          author: { login: "some-other-bot", __typename: "Bot" },
          body: coderabbitBody,
        },
      ],
      false,
    );
    expect(fromDecoy.severity).toBe("unknown");
  });

  it("fingerprints on content, so the key is stable while the finding is", () => {
    const a = fingerprintOf("AGENTS.md", 12, "the finding text");
    expect(a).toBe(fingerprintOf("AGENTS.md", 12, "the finding text"));
    expect(a).not.toBe(fingerprintOf("OTHER.md", 12, "the finding text"));
  });

  it("fingerprints the WHOLE finding, so a shared opening is not a collision", () => {
    // The reviewer opens findings with repeated severity/rationale boilerplate,
    // so two real findings on one path can share a long prefix. On a truncating
    // hash they collide: push() drops the second, and one answer marker clears
    // both — convergence over live work.
    const shared = `🟠 **high** · 🎯 correctness · confidence: high · ⚡ quick fix — ${"x".repeat(140)}`;
    expect(fingerprintOf("a.ts", 40, `${shared} the FIRST finding`)).not.toBe(
      fingerprintOf("a.ts", 40, `${shared} the SECOND finding`),
    );
  });

  it("fingerprints the LINE too, so one wording at two sites is two findings", () => {
    // Text alone is not an identity. A finding class the reviewer emits per
    // occurrence — a hand-maintained tally, a missing guard — reads identically
    // wherever it fires, and this PR has produced such a pair. Sharing a key
    // makes push() drop the second silently, and answering the survivor drives
    // the summary count to zero while the sibling occurrence stays live.
    const text = "🔵 **low** — hand-maintained tally, derivable from the list";
    expect(fingerprintOf("a.ts", 40, text)).not.toBe(
      fingerprintOf("a.ts", 99, text),
    );
    // The path/line delimiter is load-bearing: without it `a.ts|4` + `0|text`
    // and `a.ts|40` + `text` hash the same bytes.
    expect(fingerprintOf("a.ts", 40, text)).not.toBe(
      fingerprintOf("a.ts", 4, `0|${text}`),
    );
    // An unanchored bullet (no line) is its own key, not line 0's.
    expect(fingerprintOf("a.ts", null, text)).not.toBe(
      fingerprintOf("a.ts", 0, text),
    );
  });

  it.each([
    ["durable", "abc123", { fingerprint: "abc123", sha: "", round: null }],
    [
      "fix-dependent and roundless",
      "abc123@deadbee",
      { fingerprint: "abc123", sha: "deadbee", round: null },
    ],
    [
      "fix-dependent with the round it was posted in",
      "abc123@deadbee#12",
      { fingerprint: "abc123", sha: "deadbee", round: 12 },
    ],
    // Not a round, so not stripped as one: it stays inside the SHA, which then
    // matches no real head and the marker simply expires. Fail-closed, in the
    // direction that costs a re-answer rather than a suppressed live finding.
    [
      "a # suffix that is not all digits",
      "abc123@deadbee#r12",
      { fingerprint: "abc123", sha: "deadbee#r12", round: null },
    ],
    // A round suffix is only ever stamped alongside `@sha` — no producer emits
    // a bare `<fingerprint>#<round>`. Stripping it anyway would silently
    // mis-key a durable marker whose fingerprint genuinely ends in `#7`.
    [
      "a durable marker with an all-digit # suffix but no @sha",
      "abc123#7",
      { fingerprint: "abc123#7", sha: "", round: null },
    ],
    // An `@` is present, but nothing between it and the `#` — an EMPTY sha.
    // Stripping #7 as a round here would leave `abc@`, which the fingerprint/
    // sha split reads back as sha `''` — the exact shape collectAddressed
    // treats as a bare, DURABLE marker, silently coercing a malformed
    // fix-dependent attempt into a permanent answer for `abc`. Not stripped,
    // so it falls through to the ordinary split: a nonempty sha `#7` that
    // matches no real head.
    [
      "an @ with an EMPTY sha before an all-digit # suffix",
      "abc@#7",
      { fingerprint: "abc", sha: "#7", round: null },
    ],
  ])("parses a %s marker payload", (_label, raw, expected) => {
    expect(parseMarkerPayload(raw as string)).toEqual(expected);
  });

  it("collects addressed fingerprints from driver comments", () => {
    const found = collectAddressed([
      {
        body: "**wont-fix** — declined.\n<!-- drive-pr-addressed: abc123 -->",
        authorAssociation: "OWNER",
      },
      {
        body: "**deferred** — filed ENG-1.\n<!-- drive-pr-addressed: def456 -->\n<!-- drive-pr-addressed: ghi789 -->",
        authorAssociation: "COLLABORATOR",
      },
    ]);
    expect([...found].sort()).toEqual(["abc123", "def456", "ghi789"]);
  });

  it("reads the outcome a comment opens with", () => {
    expect(outcomeOf("**accepted** — fixed.")).toBe("accepted");
    expect(outcomeOf("**wont-fix** — declined.")).toBe("wont-fix");
    expect(outcomeOf("accepted — unbolded, so not an answer")).toBeNull();
  });

  it("requires the EXACT machine-read prefix, not merely a leading token", () => {
    // The prefix is what `answer-summary-finding.ts` composes and what
    // `reply-to-thread.ts` enforces. Tolerating indentation made an indented
    // worked EXAMPLE — the grammar being documented rather than used — count as
    // a real answer, so a trusted collaborator explaining the format alongside a
    // fingerprint retired the finding with nobody having dispositioned it.
    expect(
      outcomeOf("  **wont-fix** — an indented example, not an answer"),
    ).toBeNull();
    expect(outcomeOf("> **accepted** — a quotation of one")).toBeNull();
    expect(
      outcomeOf("**accepted** - hyphen, not the composed separator"),
    ).toBeNull();
    expect(outcomeOf("**accepted**")).toBeNull();
  });

  it("ignores an indented example even when it carries a real fingerprint", () => {
    const found = collectAddressed([
      {
        body: "the grammar is:\n\n    **wont-fix** — why.\n    <!-- drive-pr-addressed: abc123 -->\n",
        authorAssociation: "OWNER",
      },
    ]);
    expect([...found]).toEqual([]);
  });

  it("keeps DURABLE outcomes content-keyed across every later head", () => {
    // rejected / wont-fix / deferred are claims about the finding's MERIT, not
    // about a head. A standing backlog item the reviewer re-emits every round
    // must stay answered, which is the whole reason the key is content-derived.
    for (const outcome of ["rejected", "wont-fix", "deferred"]) {
      const found = collectAddressed(
        [
          {
            body: `**${outcome}** — standing decision.\n<!-- drive-pr-addressed: dur1 -->`,
            authorAssociation: "OWNER",
          },
        ],
        { reviewerPosition: () => "past" },
      );
      expect([...found]).toEqual(["dur1"]);
    }
  });

  it.each(["accepted", "moot"])(
    "STOPS honouring a %s marker once the reviewer moved PAST that head",
    (outcome) => {
      // The finding's text is unchanged, so its fingerprint is unchanged. An
      // incomplete fix, a revert, or a later round REINTRODUCING the code a
      // `moot` said was gone all reproduce it verbatim — and a content-keyed
      // marker would suppress the live occurrence forever, converging over real
      // work. `moot` is fix-dependent for exactly the reason `accepted` is: it
      // says the code is gone AS OF a head, and this drive's own edit is
      // usually what removed it.
      const sources = [
        {
          body: `**${outcome}** — answered.\n<!-- drive-pr-addressed: fp1@aaaa111 -->`,
          authorAssociation: "OWNER",
        },
      ];
      // Reviewer's review predates the fix: the answer still stands.
      expect([
        ...collectAddressed(sources, { reviewerPosition: () => "behind" }),
      ]).toEqual(["fp1"]);
      // Reviewer has read past that head and is STILL reporting it.
      expect([
        ...collectAddressed(sources, { reviewerPosition: () => "past" }),
      ]).toEqual([]);
    },
  );

  it("honours a BACKLOG fix marker at the very head the reviewer reviewed", () => {
    // The acceptance criterion: the answer registers at the review of
    // ITS OWN sha, not merely within some bounded number of rounds. Step 6
    // orders push → set-verified → status → answer, so a fix-dependent marker
    // is always posted at a head the reviewer has already reviewed — position
    // `at`, every time — and expiring there made the marker inert on arrival.
    // Measured across five drives: up to six re-answers of one verified-fixed
    // finding, and one drive terminated HITL_PARKED instead of CONVERGED
    // purely because of it.
    //
    // A backlog entry is carried forward by its original firstRound rather than
    // re-derived from the current diff, so its presence at the fix's head is
    // not a judgment about that head and falsifies nothing.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: bk1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
      ],
      { reviewerPosition: () => "at", backlogFingerprints: new Set(["bk1"]) },
    );
    expect([...found]).toEqual(["bk1"]);
  });

  it("exempts a winddown-deferred marker the reviewer has read PAST", () => {
    // The clause that outlives the one-head grace above, on the narrower set
    // the reviewer forwards without re-verifying. Position `past` is what the
    // grace cannot rescue — the first later push reaches it — so this is
    // exactly where the two rules stop overlapping.
    //
    // The NON-winddown marker in the same shape must still expire — the
    // exemption is scoped to the set whose re-emission carries no signal,
    // never a loosening of the general rule.
    const sources = [
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111#7 -->",
        authorAssociation: "OWNER",
      },
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: notwd@aaaa111#7 -->",
        authorAssociation: "OWNER",
      },
    ];
    const found = collectAddressed(sources, {
      reviewerPosition: () => "past",
      winddownDeferred: new Set(["wd1"]),
      currentRound: 8,
    });
    expect([...found]).toEqual(["wd1"]);
  });

  it("EXPIRES a winddown-deferred marker once the exemption bound is past", () => {
    // The other half of the same missing signal. Because the reviewer forwards
    // these entries without re-verifying them, a later round that REVERTS the
    // fix re-emits the identical fingerprint under the identical reason — so
    // an unbounded exemption suppresses a genuinely live finding forever, and
    // drive-status.ts converges over it. Elapsed rounds are the only evidence
    // available on this side, so the marker names the round it was posted in
    // and the exemption lapses WINDDOWN_EXEMPTION_ROUNDS later.
    const sources = [
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111#7 -->",
        authorAssociation: "OWNER",
      },
    ];
    const at = (currentRound: number) => [
      ...collectAddressed(sources, {
        reviewerPosition: () => "past",
        winddownDeferred: new Set(["wd1"]),
        currentRound,
      }),
    ];
    // The LAST round the marker still holds, and the first one it does not.
    // Written as arithmetic on the constant rather than as literals so the two
    // move together if the bound is ever retuned — the point under test is the
    // boundary, not the number 3.
    expect(at(7 + WINDDOWN_EXEMPTION_ROUNDS)).toEqual(["wd1"]);
    expect(at(7 + WINDDOWN_EXEMPTION_ROUNDS + 1)).toEqual([]);
  });

  it("withholds the exemption from a FUTURE or unsafe round instead of computing a negative gap", () => {
    // No producer ever stamps a round ahead of `currentRound` — but the round
    // rides in on hand-writable marker text, and `currentRound - round`
    // going negative is `<= WINDDOWN_EXEMPTION_ROUNDS` for ANY negative value.
    // Left unchecked, a marker naming a round the reviewer hasn't reached yet
    // stays exempt until `currentRound` catches up past `round +
    // WINDDOWN_EXEMPTION_ROUNDS` — permanent in practice for a large enough
    // round — unbounded suppression.
    const sources = [
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111#999999 -->",
        authorAssociation: "OWNER",
      },
    ];
    expect([
      ...collectAddressed(sources, {
        reviewerPosition: () => "past",
        winddownDeferred: new Set(["wd1"]),
        currentRound: 8,
      }),
    ]).toEqual([]);
    // A digit run past Number.MAX_SAFE_INTEGER must fail closed the same way,
    // rather than exempting on an imprecise/rounded comparison.
    const unsafe = [
      {
        body: `**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111#${"9".repeat(30)} -->`,
        authorAssociation: "OWNER",
      },
    ];
    expect([
      ...collectAddressed(unsafe, {
        reviewerPosition: () => "past",
        winddownDeferred: new Set(["wd1"]),
        currentRound: 8,
      }),
    ]).toEqual([]);
  });

  it("withholds the exemption from a marker carrying no round, and from a roundless sticky", () => {
    // Both directions fail CLOSED. A roundless marker is either hand-written or
    // predates the bound; a sticky with no `ai-review-round` leaves nothing to
    // measure elapsed rounds against. Either way the exemption cannot be
    // bounded, and an unbounded one is the defect — so the finding goes back on
    // the unaddressed list, which costs one re-answer and re-stamps a round.
    const winddownDeferred = new Set(["wd1"]);
    const roundless = [
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111 -->",
        authorAssociation: "OWNER",
      },
    ];
    expect([
      ...collectAddressed(roundless, {
        reviewerPosition: () => "past",
        winddownDeferred,
        currentRound: 8,
      }),
    ]).toEqual([]);
    expect([
      ...collectAddressed(
        [
          {
            body: "**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@aaaa111#7 -->",
            authorAssociation: "OWNER",
          },
        ],
        {
          reviewerPosition: () => "past",
          winddownDeferred,
          currentRound: null,
        },
      ),
    ]).toEqual([]);
  });

  it("does not let the round suffix restore an expired NON-winddown marker", () => {
    // The round is read only inside the exemption. A fingerprint the reviewer
    // does re-verify keeps the full position expiry no matter how fresh its
    // marker is, or the bound would become a general-purpose grace period on
    // every fix-dependent answer.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: notwd@aaaa111#8 -->",
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: () => "past",
        winddownDeferred: new Set(["wd1"]),
        currentRound: 8,
      },
    );
    expect([...found]).toEqual([]);
  });

  it("still REFUSES an UNDATED accepted marker for a winddown-deferred finding", () => {
    // "Durable once dated" — the exemption removes the position expiry, never
    // the dating requirement. An undated accepted/moot marker is hand-written
    // and unverifiable regardless of which backlog list its fingerprint
    // appears in.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — answered.\n<!-- drive-pr-addressed: wd1 -->",
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: () => "behind",
        winddownDeferred: new Set(["wd1"]),
      },
    );
    expect([...found]).toEqual([]);
  });

  it("does NOT honour a BODY-sourced fix marker at that same head", () => {
    // The grace is scoped to the set whose re-emission carries no signal, never
    // a loosening of the general rule. An unanchored body bullet IS a fresh
    // judgment about the head it was emitted on, and it self-clears when the
    // reviewer stops emitting it — so re-emission there genuinely falsifies the
    // answer, exactly as it does for a thread.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: body1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
      ],
      { reviewerPosition: () => "at", backlogFingerprints: new Set(["bk1"]) },
    );
    expect([...found]).toEqual([]);
  });

  it("expires a fix marker at position PAST, backlog-sourced or not", () => {
    // The case a permanent exemption could not handle: a later round REVERTS
    // or regresses the fix and reproduces the finding under the same
    // fingerprint, so it must come back. The grace is exactly one head wide —
    // any later push moves the reviewed SHA off the marked one — which is what
    // makes it safe where a permanent exemption would not be.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: bk1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
        {
          body: "**moot** — code removed.\n<!-- drive-pr-addressed: body1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
      ],
      { reviewerPosition: () => "past", backlogFingerprints: new Set(["bk1"]) },
    );
    expect([...found]).toEqual([]);
  });

  it("honours a fix marker at position BEHIND, backlog-sourced or not", () => {
    // A review that predates the commit cannot have judged it, so where the
    // finding came from does not matter yet.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: bk1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
        {
          body: "**moot** — code removed.\n<!-- drive-pr-addressed: body1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: () => "behind",
        backlogFingerprints: new Set(["bk1"]),
      },
    );
    expect([...found].sort()).toEqual(["bk1", "body1"]);
  });

  it("still REFUSES an UNDATED accepted marker for a BACKLOG finding", () => {
    // The grace removes the expiry, never the dating requirement. An undated
    // accepted/moot marker is hand-written — `answer-summary-finding.ts` always
    // stamps one — and unverifiable regardless of which list its fingerprint
    // appears in. Asserted at the most permissive position, so the refusal
    // cannot be coming from the position test.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — answered.\n<!-- drive-pr-addressed: bk1 -->",
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: () => "behind",
        backlogFingerprints: new Set(["bk1"]),
      },
    );
    expect([...found]).toEqual([]);
  });

  it("grants NO grace at all when the backlog set is absent", () => {
    // `AddressedOptions` documents absent as "no grace at all: fail closed",
    // and every other caller-omitted option here is pinned the same way. Left
    // unpinned, widening the membership test to `!== false` — which grants the
    // grace to EVERY fingerprint whenever the set is omitted — passed all of
    // `summary-findings parsing`, since no other probe reaches position `at`
    // without supplying one. That is the false-convergence direction.
    const found = collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: bk1@aaaa111 -->",
          authorAssociation: "OWNER",
        },
      ],
      { reviewerPosition: () => "at" },
    );
    expect([...found]).toEqual([]);
  });

  it("a backlog finding answered at the reviewed head stays addressed end to end", () => {
    // The same wiring the CLI performs: the backlog set is EVERY fingerprint in
    // the sticky's own blob, the marker is dated with the head the fix landed
    // on, and the reviewer has since reviewed exactly that head while still
    // carrying the entry forward. The answered entry carries no `reason` at
    // all, which pins that the grace keys on backlog MEMBERSHIP rather than on
    // the retired `winddown-deferred` reason. The sibling entry, never
    // answered, must remain the only unaddressed finding.
    //
    // The set comes from `backlogFingerprintsOf` — the function the CLI itself
    // calls — not from a hand-copy of its body. Re-implementing the expression
    // inline made this probe agree with itself: narrowing the CLI back to the
    // retired `reason === 'winddown-deferred'` subset passed the whole suite.
    const body = stickyBody();
    const backlogFingerprints = backlogFingerprintsOf(body);
    const addressed = collectAddressed(
      [
        {
          body: `**accepted** — fixed in this drive.\n<!-- drive-pr-addressed: c773d9fdb7974e6d@${HEAD} -->`,
          authorAssociation: "OWNER",
        },
      ],
      {
        // What `reviewerPosition(sha, HEAD)` itself would answer.
        reviewerPosition: (sha) => (sha === HEAD ? "at" : "past"),
        backlogFingerprints,
      },
    );
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: body,
      anchoredKeys: [".claude/agents/review-arbiter.md"],
      addressedFingerprints: addressed,
      reviewedSha: HEAD,
    });
    expect(r.unaddressed.map((f) => f.fingerprint)).toEqual([
      "b9a7a18089043564",
    ]);
  });

  it("a winddown backlog finding answered at a reviewed head stays addressed end to end", () => {
    // The half of the same wiring, at the position the one-head grace
    // above no longer covers: the winddown set is read off the sticky's own
    // backlog blob, the marker is dated AND rounded, and the reviewer has read
    // PAST that head while still carrying the entry forward. The sibling entry,
    // never answered, must remain the only unaddressed finding.
    const body = stickyBody();
    // From `winddownFingerprintsOf` — the function the CLI itself calls — for
    // the same reason the grace probe above uses `backlogFingerprintsOf`: an
    // inline hand-copy of the expression makes the probe agree with itself, and
    // the body-bullet exclusion this set now applies would then be untested on
    // the path that actually runs.
    const winddownDeferred = winddownFingerprintsOf(body);
    const addressed = collectAddressed(
      [
        {
          body: `**accepted** — fixed in this drive.\n<!-- drive-pr-addressed: b9a7a18089043564@${HEAD}#${STICKY_ROUND} -->`,
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: () => "past",
        winddownDeferred,
        currentRound: STICKY_ROUND,
      },
    );
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: body,
      anchoredKeys: [".claude/agents/review-arbiter.md"],
      addressedFingerprints: addressed,
      reviewedSha: HEAD,
    });
    expect(r.unaddressed.map((f) => f.fingerprint)).toEqual([
      "c773d9fdb7974e6d",
    ]);
  });

  it("withholds BOTH exemptions from a fingerprint the sticky also emits as a body bullet", () => {
    // Dual emission breaks the premise both exemptions rest on: a backlog entry
    // is carried forward by its original firstRound and a winddown-deferred one
    // is forwarded without re-verification, so neither re-emission falsifies an
    // answer — but a BODY bullet at this head is a fresh judgment, which does.
    // The fingerprint is one global key and `classify` dedups the pair into a
    // single finding, so honouring the marker for "the backlog copy" would
    // clear the freshly-judged one with it.
    //
    // The colliding fingerprint is DERIVED from the bullet via `fingerprintOf`
    // — the same call `classify` makes — rather than pasted in, so the probe
    // cannot pass on a fingerprint that no longer matches what the body yields.
    const path = ".claude/agents/review-arbiter.md";
    const line = 31;
    const text =
      "🟡 **medium** (high confidence, quick) — The arbiter’s sensitivity input omits the shared-schema exception.";
    const dual = fingerprintOf(path, line, text);
    const body = [
      "<!-- ai-code-review -->",
      "### 🎯 correctness",
      "",
      `- \`${path}:${line}\` — ${text}`,
      "",
      `<!-- ai-reviewed-sha: ${HEAD} -->`,
      "<!-- ai-review-round: 7 -->",
      `<!-- ai-review-backlog: ${Buffer.from(
        JSON.stringify([
          {
            fingerprint: dual,
            path,
            line,
            severity: "medium",
            dimension: "correctness",
            comment: "also carried forward, contradicting the bullet above",
            firstRound: 6,
            reason: "winddown-deferred",
          },
        ]),
      ).toString("base64")} -->`,
    ].join("\n");

    // Both sets drop it — the grace and the round budget are stacked rules, so
    // closing only one leaves the other honouring the same marker.
    expect([...backlogFingerprintsOf(body)]).toEqual([]);
    expect([...winddownFingerprintsOf(body)]).toEqual([]);

    // And end to end: with those sets, neither `at` nor a within-budget round
    // retires the finding.
    const sources = [
      {
        body: `**accepted** — fixed.\n<!-- drive-pr-addressed: ${dual}@${HEAD}#7 -->`,
        authorAssociation: "OWNER",
      },
    ];
    expect([
      ...collectAddressed(sources, {
        reviewerPosition: () => "at",
        backlogFingerprints: backlogFingerprintsOf(body),
        winddownDeferred: winddownFingerprintsOf(body),
        currentRound: 7,
      }),
    ]).toEqual([]);
  });

  it("refuses the winddown exemption for a marker SHA git cannot resolve", () => {
    // The exemption ignores POSITION by design, but "the marker names no
    // commit this repository has" is not a position: folded into `past`, a
    // hand-written marker would ride the exemption for its entire round
    // budget. `unknown` separates the two, and only the position half is
    // ignored.
    //
    // The marker carries a `#round` INSIDE the budget, and that is what makes
    // the probe bind: `exemptFromExpiry` fails closed on a roundless marker all
    // by itself, so an undated one passes this test whether the `unknown` gate
    // exists or not, and mutating the gate out would leave it green. The
    // markers below differ ONLY in position, so the gate is the sole thing
    // separating their outcomes.
    const sources = (sha: string) => [
      {
        body: `**accepted** — fixed.\n<!-- drive-pr-addressed: wd1@${sha}#7 -->`,
        authorAssociation: "OWNER",
      },
    ];
    const opts = {
      winddownDeferred: new Set(["wd1"]),
      currentRound: 8,
    };
    expect([
      ...collectAddressed(sources(BASE), {
        ...opts,
        reviewerPosition: () => "unknown" as const,
      }),
    ]).toEqual([]);
    // The datable case is unchanged — this is a new refusal, not a narrowing of
    // the exemption itself.
    expect([
      ...collectAddressed(sources(BASE), {
        ...opts,
        reviewerPosition: () => "past" as const,
      }),
    ]).toEqual(["wd1"]);
  });

  it("passes the accepted marker SHA — not the fingerprint — to reviewerPosition", () => {
    const seen: string[] = [];
    collectAddressed(
      [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@deadbeef -->",
          authorAssociation: "OWNER",
        },
      ],
      {
        reviewerPosition: (sha) => {
          seen.push(sha);
          return "past";
        },
      },
    );
    expect(seen).toEqual(["deadbeef"]);
  });

  it.each(["accepted", "moot"])(
    "REFUSES a %s marker that carries no SHA",
    (outcome) => {
      // It cannot be dated, so it cannot be checked, and a marker that cannot
      // be checked must not be able to retire a finding. answer-summary-
      // finding.ts always stamps these two, so an undated one reached the PR by
      // hand — refusing it costs a re-answer and buys back a suppression that
      // would otherwise be permanent.
      const found = collectAddressed(
        [
          {
            body: `**${outcome}** — answered, trust me.\n<!-- drive-pr-addressed: undated -->`,
            authorAssociation: "OWNER",
          },
        ],
        { reviewerPosition: () => "behind" },
      );
      expect([...found]).toEqual([]);
    },
  );

  it("positions the reviewer against REAL commits in this repository", async () => {
    // The question is not "has this commit been reviewed" but WHERE the
    // reviewer's head sits relative to it, and the difference is every case
    // except the linear one. `git merge-base --is-ancestor` exits 0 (ancestor),
    // 1 (not), or >=2 (could not answer: unknown SHA, shallow clone, not a
    // repo); an error must land in `past`, or a shallow CI checkout silently
    // restores the exact content-keyed suppression this removes.
    const real = (await Bun.$`git rev-parse HEAD`.text()).trim();
    const parent = (await Bun.$`git rev-parse HEAD~1`.text()).trim();
    // The reviewer's review predates the fix.
    expect(reviewerPosition(real, parent)).toBe("behind");
    // Sitting exactly on it, and past it.
    expect(reviewerPosition(real, real)).toBe("at");
    expect(reviewerPosition(parent, real)).toBe("past");
    // An ABBREVIATED reviewed SHA names the SAME commit, and must read `at`.
    // `reviewedShaFrom` accepts `[0-9a-f]{7,40}`, so deciding equality by raw
    // string comparison misses this and falls through to `--is-ancestor` —
    // which exits 0 for two equal commits, as asserted below, and so reports
    // the reviewer as strictly behind a fix it is sitting exactly on. That
    // would extend the backlog-only `at` grace to every finding.
    expect(
      Bun.spawnSync(["git", "merge-base", "--is-ancestor", real, real], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode,
    ).toBe(0);
    expect(reviewerPosition(real, real.slice(0, 8))).toBe("at");
    // git cannot resolve one side. Never `behind` either way — but the two
    // sides are NOT the same answer. An unresolvable MARKER sha means the
    // marker names nothing datable at all, which the winddown exemption has to
    // refuse even though it ignores position by design; an unresolvable
    // REVIEWED sha is an ordinary non-answer about the reviewer, which `past`
    // already covers and which must not gain the stricter treatment.
    expect(reviewerPosition("0".repeat(40), real)).toBe("unknown");
    expect(reviewerPosition(real, "0".repeat(40))).toBe("past");
    // And no reviewed SHA at all is the same unknown-about-the-reviewer.
    expect(reviewerPosition(real, undefined)).toBe("past");
  });

  it("positions a REBASED-away reviewed head as past, in both directions", async () => {
    // A PR branch can be rebased or force-pushed, and the reviewed head then
    // need not descend from the marked commit at all. Asking "is the marker an
    // ancestor of the reviewed head" answers NO for that, which reads as "the
    // reviewer has not seen the fix yet" — so the marker goes on suppressing a
    // finding the reviewer is re-emitting on the rewritten branch, which is the
    // false convergence the expiry exists to close.
    //
    // The commits must be REAL objects in the repository `reviewerPosition`
    // actually runs git in, or `rev-parse --verify` fails and the probe passes
    // through the cannot-resolve branch instead — green for a reason that has
    // nothing to do with divergence. `makeOrphanCommit` writes parentless
    // commits straight into this repo's object store, touching no ref, index or
    // worktree: two real, resolvable, genuinely unrelated commits, so git
    // answers 1 both ways. It supplies the author identity explicitly, because
    // `commit-tree` will not invent one and exits 128 on a machine with no
    // `user.email` — every CI runner. A developer's own git config hides that
    // completely, which is exactly how this probe passed locally and broke the
    // `code-quality-and-build` job on its first push.
    const a = makeOrphanCommit("drive-pr-probe-a");
    const b = makeOrphanCommit("drive-pr-probe-b");
    expect(a).not.toBe(b);
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      // Neither is an ancestor of the other — exit 1, the branch that used to
      // mean "reviewer is behind, keep honouring the marker".
      expect(
        Bun.spawnSync(["git", "merge-base", "--is-ancestor", x, y], {
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode,
      ).toBe(1);
      // Which side is "newer" is exactly what a rewritten history destroys, so
      // both directions are `past` and both expire the marker.
      expect(reviewerPosition(x, y)).toBe("past");
    }
  });

  it("FAILS CLOSED on an accepted marker when ancestry cannot be resolved", () => {
    // No reviewerPosition supplied — the CLI could not date the marker, so the
    // default position is `past`. Honouring it would retire a finding on the
    // strength of a check that never ran.
    const found = collectAddressed([
      {
        body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@aaaa111 -->",
        authorAssociation: "OWNER",
      },
    ]);
    expect([...found]).toEqual([]);
  });

  it("IGNORES an addressed marker from an untrusted commenter", () => {
    // PR comments are world-writable, and fingerprints are visible in the
    // sticky comment. Without an author check, any passer-by could mark a
    // finding answered and let the drive converge over live work.
    const found = collectAddressed([
      {
        body: "**rejected** — nothing to see.\n<!-- drive-pr-addressed: abc123 -->",
        authorAssociation: "NONE",
      },
      {
        body: "**rejected** — nothing to see.\n<!-- drive-pr-addressed: def456 -->",
        authorAssociation: "FIRST_TIME_CONTRIBUTOR",
      },
      {
        body: "**wont-fix** — declined per the rubric.\n<!-- drive-pr-addressed: ok789 -->",
        authorAssociation: "MEMBER",
      },
    ]);
    expect([...found]).toEqual(["ok789"]);
  });

  it("IGNORES a marker in a trusted comment that is not an ANSWER", () => {
    // Trust is necessary, not sufficient. A collaborator quoting or documenting
    // a marker — pasting a worked example into a design note — would otherwise
    // retire the finding from `unaddressed` with nobody having dispositioned it.
    const found = collectAddressed([
      {
        body: "For example, the driver posts:\n<!-- drive-pr-addressed: quoted1 -->",
        authorAssociation: "OWNER",
      },
      {
        body: "accepted — fixed it.\n<!-- drive-pr-addressed: unbolded -->",
        authorAssociation: "OWNER",
      },
      {
        body: "**deferred** — filed ENG-1234.\n<!-- drive-pr-addressed: real1 -->",
        authorAssociation: "OWNER",
      },
    ]);
    expect([...found]).toEqual(["real1"]);
  });

  describe("findExactMarkers", () => {
    // Deliberately NOT `collectAddressed` + `reviewerPosition`: routing the
    // duplicate-post reconciliation through the reviewer-catch-up expiry
    // reintroduced the exact bug it was meant to close — once the reviewer
    // has read a fix-dependent marker's SHA, `collectAddressed` expires it,
    // so a driver reconciling moments after its OWN successful post would
    // see it as unaddressed and post a second one. `findExactMarkers` asks a
    // narrower, expiry-free question: does a marker with this exact
    // fingerprint AND this exact suffix exist.

    it("finds a fix-dependent marker ONLY when the sha matches exactly", () => {
      const sources = [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@sha1 -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([...findExactMarkers(sources, new Set(["fp1"]), "sha1")]).toEqual([
        "fp1",
      ]);
      // A DIFFERENT sha — a later round re-answering the same fingerprint
      // after a legitimate expiry — must NOT read as already-posted.
      expect([...findExactMarkers(sources, new Set(["fp1"]), "sha2")]).toEqual(
        [],
      );
    });

    it("ignores the marker ROUND when matching, so a round-advanced reclaim finds its predecessor", () => {
      // The round records WHEN an answer was posted, not what it claims. A
      // driver reclaiming an abandoned held-batch claim asks about the same
      // fingerprint and the same SHA, but its sticky may have advanced a round
      // since — comparing the round would miss the existing marker and post a
      // duplicate, which is the whole bug this function exists to close,
      // reached through the round field.
      const sources = [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@sha1#7 -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([...findExactMarkers(sources, new Set(["fp1"]), "sha1")]).toEqual([
        "fp1",
      ]);
    });

    it("is NOT expired by the reviewer having reviewed past the marker SHA", () => {
      // The whole point: no reviewerPosition/reviewedSha input exists here at all.
      // A marker for a SHA the reviewer has long since reviewed still counts
      // as "this exact answer already exists" when asked about that SAME sha.
      const sources = [
        {
          body: "**moot** — code removed.\n<!-- drive-pr-addressed: fp1@oldsha -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), "oldsha"),
      ]).toEqual(["fp1"]);
    });

    it("finds a durable (no-sha) marker only when no markerSha is requested", () => {
      const sources = [
        {
          body: "**wont-fix** — declined.\n<!-- drive-pr-addressed: fp1 -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), undefined),
      ]).toEqual(["fp1"]);
      // Asking for a specific sha must not match the bare, durable marker.
      expect([...findExactMarkers(sources, new Set(["fp1"]), "sha1")]).toEqual(
        [],
      );
    });

    it("ignores fingerprints outside the requested set, and untrusted or non-answer comments", () => {
      const sources = [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: other@sha1 -->",
          authorAssociation: "OWNER",
        },
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@sha1 -->",
          authorAssociation: "NONE",
        },
        {
          body: "accepted — unbolded.\n<!-- drive-pr-addressed: fp1@sha1 -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([...findExactMarkers(sources, new Set(["fp1"]), "sha1")]).toEqual(
        [],
      );
    });

    it("lets a STALE winddown-deferred marker be reposted at the same SHA with a fresh round", () => {
      // The reviewer forwards a winddown-deferred backlog entry WITHOUT a new
      // commit, so a legitimate re-answer after `collectAddressed` expires the
      // old marker reuses the exact same `pushedSha`. Treating that stale
      // marker as an exact match would make `answer-summary-finding.ts` skip
      // the repost forever — the finding stays unaddressed with nothing left
      // to refresh it. Posted in round 7, exemption window is
      // WINDDOWN_EXEMPTION_ROUNDS (3): still a match through round 10, a
      // refresh target from round 11 on.
      const sources = [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@sha1#7 -->",
          authorAssociation: "OWNER",
        },
      ];
      const winddownDeferred = new Set(["fp1"]);
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), "sha1", {
          winddownDeferred,
          currentRound: 7 + WINDDOWN_EXEMPTION_ROUNDS,
        }),
      ]).toEqual(["fp1"]);
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), "sha1", {
          winddownDeferred,
          currentRound: 7 + WINDDOWN_EXEMPTION_ROUNDS + 1,
        }),
      ]).toEqual([]);
      // A NON-winddown fingerprint in the exact same shape must still match
      // unconditionally — the crash-recovery guarantee is untouched for the
      // common case, which never legitimately reposts at the same SHA.
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), "sha1", {
          winddownDeferred: new Set(["other"]),
          currentRound: 7 + WINDDOWN_EXEMPTION_ROUNDS + 1,
        }),
      ]).toEqual(["fp1"]);
    });

    it("keeps the ordinary unconditional match for a winddown fingerprint when the sticky carries NO round", () => {
      // With no `opts.currentRound`, `exemptFromExpiry` fails closed to "not
      // exempt" unconditionally — if that alone triggered the stale-refresh
      // path, EVERY same-SHA winddown marker would read as stale, including
      // one this very pass posted moments ago (crash recovery). Worse,
      // `answer-summary-finding.ts` stamps no round on a roundless sticky
      // either, so the "fresh" repost would be textually identical to the
      // marker just posted — an infinite loop of duplicate comments, not a
      // one-time refresh. `currentRound: null` must retain the ordinary
      // unconditional match instead.
      const sources = [
        {
          body: "**accepted** — fixed.\n<!-- drive-pr-addressed: fp1@sha1 -->",
          authorAssociation: "OWNER",
        },
      ];
      expect([
        ...findExactMarkers(sources, new Set(["fp1"]), "sha1", {
          winddownDeferred: new Set(["fp1"]),
          currentRound: null,
        }),
      ]).toEqual(["fp1"]);
    });
  });

  it("excludes a body finding whose path DID receive an inline comment", () => {
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: stickyBody(),
      anchoredKeys: [".claude/agents/review-arbiter.md"],
      addressedFingerprints: new Set(),
    });
    // Only the two backlog entries remain — the anchored bullet is a thread's
    // problem, and list-unresolved-threads.ts already counts it.
    expect(r.total).toBe(2);
    expect(r.findings.every((f) => f.source === "backlog")).toBe(true);
  });

  it("counts an UNANCHORED body finding as summary-only work", () => {
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: stickyBody(),
      anchoredKeys: [],
      addressedFingerprints: new Set(),
    });
    expect(r.total).toBe(3);
    expect(r.findings.filter((f) => f.source === "body")).toHaveLength(1);
    expect(r.unaddressed).toHaveLength(3);
  });

  it("marks a finding addressed only via its drive-pr-addressed marker", () => {
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: stickyBody(),
      anchoredKeys: [".claude/agents/review-arbiter.md"],
      addressedFingerprints: new Set(["b9a7a18089043564"]),
    });
    expect(r.total).toBe(2);
    expect(r.unaddressed).toHaveLength(1);
    expect(r.unaddressed[0]?.fingerprint).toBe("c773d9fdb7974e6d");
  });

  it("reports a shortfall when the declared count exceeds what was classified", () => {
    // Fail closed: an unexplained gap between what the reviewer says it could
    // not anchor and what we could find must block convergence, not round down.
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      stickyBody: stickyBody({ backlog: false, unanchored: 3 }),
      anchoredKeys: [".claude/agents/review-arbiter.md"],
      addressedFingerprints: new Set(),
    });
    expect(r.declaredUnanchored).toBe(3);
    expect(r.findings.filter((f) => f.source === "unaccounted")).toHaveLength(
      3,
    );
    expect(r.unaddressed).toHaveLength(3);
  });

  it("does not manufacture a phantom slot for a finding the backlog already holds", () => {
    // The declaration may well count backlog entries, which are unanchored by
    // construction. Measuring the shortfall against body bullets alone then
    // synthesises a slot for a finding that was already enumerated — a phantom
    // that answering real findings cannot clear and that returns on every new
    // head, i.e. a loop that never converges rather than one that fails closed.
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      // 2 backlog entries + 1 unanchored bullet = 3 classified; declared 3.
      stickyBody: stickyBody({ unanchored: 3 }),
      anchoredKeys: [],
      addressedFingerprints: new Set(),
      reviewedSha: HEAD,
    });
    expect(r.declaredUnanchored).toBe(3);
    expect(r.findings.filter((f) => f.source === "unaccounted")).toHaveLength(
      0,
    );
    expect(r.total).toBe(3);
  });

  it("inline comments anchor a `path:line` group ENTIRELY or not at all", () => {
    // `path:line` is a position, not an identity. Two findings can share one,
    // and a membership test then calls both anchored — the unthreaded sibling
    // vanishes and the driver converges over it.
    //
    // Consuming slots in document order is the subtler version of the same bug:
    // with two bullets and one comment it declares the FIRST anchored. If the
    // comment was the SECOND one's, the genuinely unthreaded bullet has
    // disappeared while the threaded one is duplicated as summary work —
    // resolving that thread and answering the duplicate then drives both counts
    // to zero without the first finding ever being dispositioned.
    const body = [
      "## Findings",
      "",
      "- `a.ts:40` — 🟠 **high** the FIRST finding on this line",
      "- `a.ts:40` — 🟡 **medium** the SECOND finding on this line",
      "",
    ].join("\n");
    const at = (keys: string[]) =>
      classify({
        pr: 1,
        stickyCommentId: 9,
        stickyBody: body,
        anchoredKeys: keys,
        addressedFingerprints: new Set(),
      }).findings.filter((f) => f.source === "body");

    // No comment there: both bullets are summary-only.
    expect(at([])).toHaveLength(2);
    // ONE comment there: which bullet it belongs to is unknowable, so BOTH stay
    // open work. Fail-closed — at worst this asks for an answer that already
    // has a thread.
    expect(at(["a.ts:40"])).toHaveLength(2);
    // TWO comments there: the group is fully covered, nothing left over.
    expect(at(["a.ts:40", "a.ts:40"])).toHaveLength(0);
    // MIXED: one exact anchor plus one whose anchor went outdated (bare path).
    // That is two real inline comments for two bullets, so the group is covered
    // — asking the exact and bare pools independently rejects it, because each
    // pool alone falls one short, and the driver then demands answers for
    // findings that already have threads and can never converge.
    expect(at(["a.ts:40", "a.ts"])).toHaveLength(0);
    // Still fail-closed when the combined total falls short.
    expect(at(["a.ts"])).toHaveLength(2);
  });

  it("does not spend one file’s bare-path slot on two different lines", () => {
    // The bare-path pool is shared by every group on the file, so combining the
    // pools must still COUNT: one outdated comment cannot cover a bullet on
    // line 40 and another on line 99. Drawing in bullet order keeps it
    // deterministic, and the group left short stays open.
    const body = [
      "## Findings",
      "",
      "- `a.ts:40` — 🟠 **high** the finding on forty",
      "- `a.ts:99` — 🟡 **medium** the finding on ninety-nine",
      "",
    ].join("\n");
    const at = (keys: string[]) =>
      classify({
        pr: 1,
        stickyCommentId: 9,
        stickyBody: body,
        anchoredKeys: keys,
        addressedFingerprints: new Set(),
      }).findings.filter((f) => f.source === "body");

    // One bare slot, two single-bullet groups: it could belong to either, so
    // BOTH stay open. Handing it to whichever bullet comes first would hide a
    // live finding on the strength of document order.
    expect(at(["a.ts"])).toHaveLength(2);
    // One bare slot each: both covered.
    expect(at(["a.ts", "a.ts"])).toHaveLength(0);
    // An exact anchor for one, a bare slot for the other: both covered, and the
    // exact one is not wasted on the group that could have used the bare slot.
    expect(at(["a.ts:99", "a.ts"])).toHaveLength(0);
  });

  it("an OUTDATED anchor covers a file’s leftovers only when it covers them ALL", () => {
    // An inline comment whose anchor went outdated reports no line, so its key
    // is the bare path. Treated as membership, it hides every bullet on that
    // file — the whole-history failure mode round-scoping already fixed once,
    // coming back in through the fallback. Treated as one slot handed to
    // whichever bullet comes first, it hides an arbitrary one of them.
    const at = (bullets: string[], keys: string[]) =>
      classify({
        pr: 1,
        stickyCommentId: 9,
        stickyBody: ["## Findings", "", ...bullets, ""].join("\n"),
        anchoredKeys: keys,
        addressedFingerprints: new Set(),
      }).findings.filter((f) => f.source === "body");

    const two = [
      "- `a.ts:40` — 🟠 **high** the first finding",
      "- `a.ts:99` — 🟡 **medium** an unrelated finding on the same file",
    ];
    // One outdated comment, two candidate bullets: unknowable, so both stay
    // open — NOT the first one silently retired.
    expect(at(two, ["a.ts"])).toHaveLength(2);
    // One outdated comment and a single candidate: unambiguous, so the fallback
    // still does its job and the bullet is not re-reported as summary work.
    expect(at([two[0] ?? ""], ["a.ts"])).toHaveLength(0);
    // A different file's outdated anchor covers nothing here.
    expect(at([two[0] ?? ""], ["b.ts"])).toHaveLength(1);
  });

  it("the unaccounted slot reports the count the shortfall was measured against", () => {
    // The shortfall is measured against every classified finding, so quoting
    // the body-bullet count in the slot text can claim zero were classified
    // while backlog findings sit right above — misdirecting the one operator
    // who has to read the summary comment and answer the slot by hand. The
    // count must also be captured before the slot loop, which grows `findings`.
    const r = classify({
      pr: 1,
      stickyCommentId: 9,
      // 2 backlog entries, no unanchored bullet (the one body bullet IS
      // anchored), declared 4 → 2 classified, 2 unaccounted slots.
      stickyBody: stickyBody({ unanchored: 4 }),
      anchoredKeys: [".claude/agents/review-arbiter.md:31"],
      addressedFingerprints: new Set(),
      reviewedSha: HEAD,
    });
    const slots = r.findings.filter((f) => f.source === "unaccounted");
    expect(slots).toHaveLength(2);
    // Both slots quote the same, correct classified count — not 0 (bodyOnly),
    // and not a number that drifts as the loop pushes.
    for (const s of slots) {
      expect(s.text).toContain("only 2 could be classified");
    }
  });

  it("scopes unaccounted slot keys to the reviewed HEAD, not the sticky id", () => {
    // The sticky comment is upserted, so its id is constant across every round.
    // Keying a slot on it means slot 1 of a later round silently inherits the
    // answer given to a completely different, unidentifiable finding.
    const at = (sha: string) =>
      classify({
        pr: 1,
        stickyCommentId: 9, // identical across both rounds, as in reality
        stickyBody: stickyBody({ backlog: false, unanchored: 1, sha }),
        anchoredKeys: [".claude/agents/review-arbiter.md"],
        addressedFingerprints: new Set(),
        reviewedSha: sha,
      }).findings[0]?.fingerprint;
    expect(at(HEAD)).not.toBe(at(PREV));
    expect(at(HEAD)).toContain(HEAD.slice(0, 12));
  });
});

describe("fixture head tokens", () => {
  it("are not objects in this repository, at full length OR abbreviated", async () => {
    // The invariant the module constants' own comment states, mechanized: a
    // token that resolves makes every `git rev-parse` path downstream
    // (`reviewerPosition`, the abbreviation witness) behave differently from
    // the opaque-string case the probes using it assume — and differently
    // between checkouts, since whether a given object is present depends on
    // which branches were fetched. That is not hypothetical: `HEAD` WAS such a
    // literal once, and two probes silently depended on an idle feature branch
    // still existing on origin. A probe that genuinely needs git to answer
    // calls `realHead()`.
    //
    // Abbreviations too, not just the full 40: `drive-status.ts` resolves
    // 7-to-40-hex markers, so a token whose PREFIX resolves would re-arm the
    // same dependency one layer down.
    //
    // ONE `cat-file --batch-check` for every revision below, rather than a
    // `rev-parse` spawn each: that ran ~10s of pure process startup on an idle
    // machine and blew the suite's 30s timeout outright under concurrent
    // worktree load, which is a flaky test rather than a slow one. `--batch-check`
    // reads revisions from stdin and answers per line, so the cost is one spawn.
    const revs = [HEAD, PREV, BASE, BASE_MOVED].flatMap((t) => [
      t,
      t.slice(0, 8),
    ]);
    //
    // `GIT_NO_LAZY_FETCH=1` because this repository is a PARTIAL clone
    // (`remote.origin.promisor`, `blob:none`), where asking about an object git
    // does not have makes it try to fetch one from origin: ~1.3s of network per
    // missing rev, which blew the 5s timeout outright and made the probe depend
    // on connectivity to answer a question that is purely local. Suppressing the
    // fetch is also what makes `missing` MEAN missing here rather than
    // "unfetchable right now".
    const out = Bun.spawnSync(["git", "cat-file", "--batch-check"], {
      stdin: new TextEncoder().encode(`${revs.join("\n")}\n`),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    }).stdout.toString();
    // `<input> missing` for an object that is not here, `<input> ambiguous` for
    // a prefix matching several. BOTH are the invariant holding — neither
    // resolves to an object — and only equality with `missing` was asserted at
    // first, which would fail on a state the invariant permits: as objects
    // accumulate, an 8-character prefix can become ambiguous without ever
    // resolving. Normalized to one token so the comparison stays a whole-list
    // one and a failure still NAMES the rev (`<rev> <sha> commit 123` against
    // `<rev> unresolved`).
    const answers = out
      .trim()
      .split("\n")
      .map((line) => line.replace(/ (?:missing|ambiguous)$/, " unresolved"));
    expect(answers).toEqual(revs.map((rev) => `${rev} unresolved`));
  });

  it("realHead() resolves, so the probes that need git get a real answer", async () => {
    // The other half: the escape hatch has to actually work, or a probe
    // switched to it fails closed to `past`/unresolvable and passes for the
    // wrong reason.
    const head = await realHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const { exitCode } =
      await Bun.$`git rev-parse --verify --quiet ${`${head}^{commit}`}`
        .nothrow()
        .quiet();
    expect(exitCode).toBe(0);
  });
});
