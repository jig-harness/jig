/**
 * The reviewer's skip notice: a block in its sticky comment saying it did not
 * review a pushed head, between `<!-- <marker> -->` and `<!-- /<marker> -->`
 * (`review.skip_notice_marker`, default `ai-review-skip-notice`). A reviewer
 * that skips a push (one whose diff it has nothing to review in, say) leaves
 * its reviewed-SHA marker on the head it last reviewed, so without this
 * notice the drive cannot tell a head the reviewer has not reached yet from
 * one it will never review.
 *
 * The head the notice names is its first commit id in backticks, else its
 * first bare one (7 to 40 lowercase hex). Its text is kept, markup removed,
 * for the reason the drive reports.
 */
import { skipNoticeMarker } from "../overlay.ts";

export interface SkipNotice {
  /** The head the notice names, as written: a full or abbreviated commit id. */
  head: string;
  /** The notice's text on one line, without its markup. */
  text: string;
}

const MAX_TEXT = 300;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The last skip notice in `body`, or `null` when it carries none naming a head. */
export function skipNoticeIn(body: string): SkipNotice | null {
  const marker = escapeRegExp(skipNoticeMarker());
  const blocks = [
    ...body.matchAll(
      new RegExp(
        `<!--\\s*${marker}\\s*-->([\\s\\S]*?)<!--\\s*/\\s*${marker}\\s*-->`,
        "g",
      ),
    ),
  ];
  const inner = blocks.at(-1)?.[1];
  if (inner === undefined) return null;
  const head =
    /`([0-9a-f]{7,40})`/.exec(inner)?.[1] ??
    /(?<![0-9A-Za-z])([0-9a-f]{7,40})(?![0-9A-Za-z])/.exec(inner)?.[1];
  if (head === undefined) return null;
  const text = inner
    .replace(/\[![A-Za-z]+\]/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    head,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
  };
}
