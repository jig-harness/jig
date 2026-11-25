/**
 * drive-pr suite: summary-findings.ts reads the same marker overrides as
 * drive-status.ts. Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SCRIPTS, useDrivePrSuite } from "./drive-pr-harness.ts";

useDrivePrSuite();

describe("summary-findings marker overrides", () => {
  it("reads the SAME sticky and reviewed-SHA markers drive-status.ts is configured with", async () => {
    // The parser exports stable defaults; its selection helpers read overrides
    // lazily. Run in a subprocess so the environment belongs to the import.
    const src = join(SCRIPTS, "summary-findings.ts");
    const overlay = join(SCRIPTS, "lib", "overlay.ts");
    const sticky = join(SCRIPTS, "lib", "status", "reviewer-sticky.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const m = await import(${JSON.stringify(src)});
         const o = await import(${JSON.stringify(overlay)});
         const s = await import(${JSON.stringify(sticky)});
         console.log(JSON.stringify({
           defaultSticky: m.STICKY_MARKER,
           defaultSha: m.SHA_MARKER,
           sticky: o.stickyMarker(),
           parsed: m.reviewedShaFrom('<!-- custom+sha: abc1234 -->'),
           selected: m.reviewerSticky([
             { id: 1, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n- custom-marker finding' },
             { id: 2, user: { login: 'reviewer[bot]' }, body: '<!-- ai-code-review -->\\n- default-marker finding' },
           ], false)?.id,
           unstampedSelected: m.reviewerSticky([
             { id: 3, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->' },
             { id: 4, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n- unanchored finding' },
           ], false)?.id,
           proseBacklogSelected: m.reviewerSticky([
             { id: 5, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n- \`a.ts\` — finding' },
             { id: 6, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\nai-review-backlog is mentioned here' },
           ], false)?.id,
           skipSelected: m.reviewerSticky([
             { id: 11, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n- \`a.ts\` — finding' },
             { id: 12, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`abc1234\` skipped\\n<!-- /ai-review-skip-notice -->' },
           ], false)?.id,
           declaredSelected: m.reviewerSticky([
             { id: 7, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->' },
             { id: 8, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n> 1 finding(s) without a diff-anchorable line' },
           ], false)?.id,
           newerRoundSelected: m.reviewerSticky([
             { id: 9, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-round: 1 -->\\n- \`a.ts\` — finding' },
             { id: 10, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-round: 2 -->' },
           ], false)?.id,
           stampedNewerRoundSelected: m.reviewerSticky([
             { id: 21, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->\\n- \`a.ts\` — finding' },
             { id: 22, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 2 -->' },
           ], false)?.id,
           acknowledgementSelected: m.reviewerSticky([
             { id: 13, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->\\n- \`a.ts\` — finding' },
             { id: 14, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->\\nacknowledged' },
           ], false)?.id,
           cleanReplacementSelected: m.reviewerSticky([
             { id: 15, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->\\n- \`a.ts\` — finding' },
             { id: 16, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 1 -->\\nall clear' },
           ], false)?.id,
           abbreviatedAcknowledgementSelected: m.reviewerSticky([
             { id: 17, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234def5678 -->\\n- \`a.ts\` — finding' },
             { id: 18, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\nall clear' },
           ], false)?.id,
           unstampedFindingKeepsSelection: m.reviewerSticky([
             { id: 19, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n- \`a.ts\` — finding' },
             { id: 20, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\nacknowledged' },
           ], false)?.id,
           trailingProseDeclaration: (() => { const b = s.reviewerStickyBody({ user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n> 2 findings without a diff-anchorable line (see the summary below).' }, (login) => login === 'reviewer[bot]', '<!-- other-review -->'); return m.parseDeclaredUnanchored(b ?? ''); })(),
          inPlaceSkipKeepsStamp: s.reviewerStickyIn([
            { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
          ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
          stickyTimestamp: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->\\nacknowledged', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha').updatedAt,
           skipKeepsReviewWitness: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           lowerRoundDoesNotReplace: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 1 -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           fullStampKeepsWitnessTime: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234def5678 -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           unstampedSkipDoesNotBorrowWitness: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\ndef5678 skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           invalidRoundDoesNotBorrowWitness: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-round: 999999999999999999999 -->\\n<!-- ai-review-skip-notice -->\\ndef5678 skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           firstUnstampedSkipStandsAlone: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           lowerRoundUnstampedSkipDoesNotReplace: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`abc1234\` skipped\\n<!-- /ai-review-skip-notice -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->\\n<!-- ai-review-round: 1 -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           lowerRoundStampDoesNotReplaceSkip: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-skip-notice -->\\n\`abc1234\` skipped\\n<!-- /ai-review-skip-notice -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 1 -->', updated_at: '2026-11-24T11:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           fencedSkipPayload: s.structuralSkipNotices('<!-- ai-review-skip-notice -->\\n\`\`\`\\nexample\\n\`\`\`\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->', 'ai-review-skip-notice'),
           initialSkipDoesNotHideFindings: m.reviewerSticky([
             { id: 21, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-round: 3 -->\\n<!-- ai-review-skip-notice -->\\n\`abc1234\` skipped\\n<!-- /ai-review-skip-notice -->' },
             { id: 22, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 2 -->\\n- \`a.ts\` — finding' },
           ], false)?.id,
           ignoresExamples: s.reviewerStickyBody(
             { user: { login: 'reviewer[bot]' }, body: '> <!-- other-review -->\\n\`\`\`\\n<!-- other-review -->\\n\`\`\`\\n    <!-- other-review -->' },
             (login) => login === 'reviewer[bot]',
             '<!-- other-review -->',
           ),
           latestStamp: m.reviewedShaFrom('<!-- custom+sha: abc1234 -->\\n<!-- custom+sha: def5678 -->'),
           malformedRoundKeepsSummary: m.reviewerSticky([
             { id: 23, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->\\n- \`a.ts\` — finding' },
             { id: 24, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 1 -->\\n<!-- ai-review-round: 3 -->\\nall clear' },
           ], false)?.id,
           malformedRound: s.hasInvalidReviewRound('<!-- ai-review-round: 2 -->\\n<!-- ai-review-round:'),
           malformedSha: s.hasInvalidReviewedSha('<!-- custom+sha: abc1234 -->\\n<!-- custom+sha: malformed -->', 'custom+sha'),
           spacedSha: s.hasInvalidReviewedSha('<!-- custom+sha : unavailable -->', 'custom+sha'),
           caseVariantSha: s.hasInvalidReviewedSha('<!-- CUSTOM+SHA: abc1234 -->', 'custom+sha'),
           quotedDeclaration: m.reviewerSticky([
             { id: 25, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n> 2 findings without a diff-anchorable line <!-- custom+sha: def5678 -->' },
           ], false)?.id,
           quotedDeclarationBody: (() => { const b = s.reviewerStickyBody({ user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n> 2 findings without a diff-anchorable line\\n> <!-- custom+sha: def5678 -->' }, (login) => login === 'reviewer[bot]', '<!-- other-review -->'); return { sha: m.reviewedShaFrom(b ?? ''), declared: m.parseDeclaredUnanchored(b ?? '') }; })(),
           quotedFencedDeclaration: (() => { const b = s.reviewerStickyBody({ user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n> \`\`\`\\n> 2 findings without a diff-anchorable line\\n> \`\`\`' }, (login) => login === 'reviewer[bot]', '<!-- other-review -->'); return m.parseDeclaredUnanchored(b ?? ''); })(),
           validSupersedesMalformed: m.reviewerSticky([
             { id: 31, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: malformed -->\\n<!-- ai-review-round: 2 -->\\n- \`a.ts\` — finding' },
             { id: 32, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 3 -->\\nall clear' },
           ], false)?.id,
           malformedSummarySurvivesSkip: (() => { try {
             m.reviewerSticky([
               { id: 26, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: malformed -->\\n<!-- ai-review-round: 5 -->\\n- \`a.ts\` — finding' },
               { id: 27, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 6 -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->' },
             ], false); return null;
           } catch (e) { return String(e instanceof Error ? e.message : e); } })(),
           multipleMalformedSummariesSurvivePartialRecovery: (() => { try {
             m.reviewerSticky([
               { id: 28, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: malformed -->\\n<!-- ai-review-round: 5 -->\\n- \`a.ts\` — finding' },
               { id: 29, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: malformed -->\\n<!-- ai-review-round: 2 -->\\n- \`b.ts\` — finding' },
               { id: 30, user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: def5678 -->\\n<!-- ai-review-round: 3 -->\\nall clear' },
             ], false); return null;
           } catch (e) { return String(e instanceof Error ? e.message : e); } })(),
           foreignSkipDoesNotSetWatermark: s.reviewerStickyIn([
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 1 -->', updated_at: '2026-11-24T10:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- ai-review-round: 3 -->\\n<!-- ai-review-skip-notice -->\\n\`def5678\` skipped\\n<!-- /ai-review-skip-notice -->', updated_at: '2026-11-24T11:00:00Z' },
             { user: { login: 'reviewer[bot]' }, body: '<!-- other-review -->\\n<!-- custom+sha: abc1234 -->\\n<!-- ai-review-round: 2 -->', updated_at: '2026-11-24T12:00:00Z' },
           ], (login) => login === 'reviewer[bot]', '<!-- other-review -->', 'custom+sha'),
           declaredNegative: (() => { try { m.parseDeclaredUnanchored('> -1.0 findings without a diff-anchorable line'); return false; } catch { return true; } })(),
           declaredConflict: (() => { try { m.parseDeclaredUnanchored('> 0 findings without a diff-anchorable line\\n> 4 findings without a diff-anchorable line'); return false; } catch { return true; } })(),
         }));`,
      ],
      {
        env: {
          ...process.env,
          DRIVE_PR_STICKY_MARKER: "<!-- other-review -->",
          DRIVE_PR_SHA_MARKER: "custom+sha",
          DRIVE_PR_REVIEWER_APP: "reviewer",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const got = JSON.parse(out);
    expect(got.defaultSticky).toBe("<!-- ai-code-review -->");
    expect(got.defaultSha).toBe("ai-reviewed-sha");
    expect(got.sticky).toBe("<!-- other-review -->");
    expect(got.selected).toBe(1);
    // A later auxiliary comment cannot erase a finding-bearing sticky.
    expect(got.unstampedSelected).toBe(3);
    expect(got.proseBacklogSelected).toBe(5);
    expect(got.skipSelected).toBe(11);
    expect(got.declaredSelected).toBe(8);
    // A round number alone never retires findings: the unstamped round 2
    // comment leaves the finding-bearing summary selected.
    expect(got.newerRoundSelected).toBe(9);
    // A newer round stamped with its own reviewed head is a real replacement.
    expect(got.stampedNewerRoundSelected).toBe(22);
    // A stamp-only acknowledgement is not evidence of a distinct review, even
    // when it repeats the summary's round, so it cannot erase that summary.
    expect(got.acknowledgementSelected).toBe(13);
    // A clean stamp for a different reviewed head is a replacement, even when
    // the reviewer reuses the previous round marker.
    expect(got.cleanReplacementSelected).toBe(16);
    expect(got.abbreviatedAcknowledgementSelected).toBe(17);
    // A later stamp cannot erase findings whose selected summary has no
    // reviewed-SHA evidence of a different review.
    expect(got.unstampedFindingKeepsSelection).toBe(19);
    // A same-head acknowledgement cannot attest a reviewer rerun in progress.
    expect(got.stickyTimestamp).toBe("2026-11-24T10:00:00Z");
    expect(got.skipKeepsReviewWitness).toMatchObject({
      sha: "abc1234",
      round: 2,
      updatedAt: "2026-11-24T10:00:00Z",
    });
    expect(got.skipKeepsReviewWitness.skip).toBeNull();
    expect(got.lowerRoundDoesNotReplace).toMatchObject({
      sha: "abc1234",
      round: 2,
      updatedAt: "2026-11-24T10:00:00Z",
    });
    expect(got.fullStampKeepsWitnessTime).toMatchObject({
      sha: "abc1234",
      round: 2,
      updatedAt: "2026-11-24T10:00:00Z",
    });
    expect(got.unstampedSkipDoesNotBorrowWitness).toMatchObject({
      sha: "abc1234",
      round: 2,
      skip: null,
    });
    expect(got.invalidRoundDoesNotBorrowWitness).toMatchObject({
      sha: "abc1234",
      round: 2,
      skip: null,
    });
    expect(got.firstUnstampedSkipStandsAlone).toMatchObject({
      sha: "",
      round: null,
      skip: { head: "def5678" },
    });
    expect(got.lowerRoundUnstampedSkipDoesNotReplace).toMatchObject({
      sha: "",
      round: null,
      skip: { head: "abc1234" },
    });
    expect(got.lowerRoundStampDoesNotReplaceSkip).toMatchObject({
      sha: "",
      round: null,
      skip: { head: "abc1234" },
    });
    expect(got.fencedSkipPayload).toContain("`def5678` skipped");
    expect(got.fencedSkipPayload).not.toContain("example");
    expect(got.initialSkipDoesNotHideFindings).toBe(22);
    expect(got.ignoresExamples).toBeNull();
    // And the reviewed SHA is actually extracted under the custom name — it
    // scopes the unaccounted-slot keys, so failing to read it degrades every
    // slot to the shared `nohead` scope, where an answer given on one head
    // marks a different finding addressed on the next.
    expect(got.parsed).toBe("abc1234");
    expect(got.latestStamp).toBe("def5678");
    // Invalid marker sequences are not an absent round or stamp: a clean
    // acknowledgement carrying either one cannot erase an earlier summary.
    expect(got.malformedRoundKeepsSummary).toBe(23);
    expect(got.malformedRound).toBe(true);
    expect(got.malformedSha).toBe(true);
    expect(got.spacedSha).toBe(true);
    expect(got.caseVariantSha).toBe(true);
    expect(got.quotedDeclaration).toBe(25);
    const unreadable = "reviewer summary protocol evidence is unreadable";
    expect(got.malformedSummarySurvivesSkip).toBe(unreadable);
    expect(got.multipleMalformedSummariesSurvivePartialRecovery).toBe(
      unreadable,
    );
    expect(got.validSupersedesMalformed).toBe(32);
    expect(got.trailingProseDeclaration).toBe(2);
    expect(got.inPlaceSkipKeepsStamp.sha).toBe("abc1234");
    expect(got.inPlaceSkipKeepsStamp.skip).not.toBeNull();
    expect(got.quotedDeclarationBody).toEqual({ sha: undefined, declared: 2 });
    expect(got.quotedFencedDeclaration).toBe(0);
    expect(got.foreignSkipDoesNotSetWatermark).toMatchObject({
      sha: "abc1234",
      round: 2,
      updatedAt: "2026-11-24T12:00:00Z",
    });
    expect(got.declaredNegative).toBe(true);
    expect(got.declaredConflict).toBe(true);
  });
});
