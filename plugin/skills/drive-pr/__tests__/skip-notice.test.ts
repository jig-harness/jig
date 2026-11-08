/**
 * drive-pr suite: the reviewer's skip notice as `skip-notice.ts` reads it out
 * of a sticky comment's body, and the announcement's wording for a head the
 * reviewer skipped (`reviewed-sha.ts`). Runs under the default marker,
 * `ai-review-skip-notice`; the configured marker is covered end to end in
 * drive-pr-status-skipped-head.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { reviewedClaim } from "../scripts/lib/status/reviewed-sha.ts";
import { skipNoticeIn } from "../scripts/lib/status/skip-notice.ts";

const HEAD = "620e0a470d8d1111111111111111111111111111";
const OTHER = "9d90e8f9bd2b2222222222222222222222222222";

const block = (inner: string) =>
  `<!-- ai-review-skip-notice -->\n${inner}\n<!-- /ai-review-skip-notice -->`;

describe("skipNoticeIn", () => {
  it("reads the head and the text, markup removed", () => {
    const body = `<!-- ai-code-review -->\n${block(
      `> [!WARNING]\n> **Review did not run** for push \`${HEAD.slice(0, 12)}\` — skipped: empty diff.`,
    )}\n### findings`;
    expect(skipNoticeIn(body)).toEqual({
      head: HEAD.slice(0, 12),
      text: `Review did not run for push \`${HEAD.slice(0, 12)}\` — skipped: empty diff.`,
    });
  });

  it("takes the last block when the body carries several", () => {
    const body = `${block(`push \`${OTHER}\``)}\n${block(`push \`${HEAD}\``)}`;
    expect(skipNoticeIn(body)?.head).toBe(HEAD);
  });

  it("returns null for a block that names no head", () => {
    expect(skipNoticeIn(block("Review did not run for this push."))).toBeNull();
  });

  it("returns null without a closing marker", () => {
    expect(
      skipNoticeIn(`<!-- ai-review-skip-notice -->\npush \`${HEAD}\``),
    ).toBeNull();
  });

  it("prefers a commit id in backticks to a bare one before it", () => {
    const body = block(`after ${OTHER.slice(0, 10)}, push \`${HEAD}\``);
    expect(skipNoticeIn(body)?.head).toBe(HEAD);
  });

  it("falls back to the first bare commit id", () => {
    expect(skipNoticeIn(block(`push ${HEAD} was skipped`))?.head).toBe(HEAD);
  });

  it("truncates a long text", () => {
    const text = skipNoticeIn(block(`push \`${HEAD}\` ${"x".repeat(400)}`))
      ?.text as string;
    expect(text.length).toBe(300);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("the announcement's wording", () => {
  it("names the reviewed head of a skipped one", () => {
    expect(reviewedClaim("skip-notice", HEAD)).toBe(
      `reviewed \`${HEAD.slice(0, 12)}\` and skipped this head, whose pull-request diff is the same`,
    );
  });

  it("claims a review of this exact head otherwise", () => {
    expect(reviewedClaim("comment-marker", HEAD)).toBe(
      "completed its review of this exact head",
    );
  });
});
