/** A top-level reply can carry several independently classified answers. */
export const SUMMARY_ANSWER_SEPARATOR =
  "\n\n<!-- drive-pr-summary-answer -->\n";

export function summaryAnswerBlocks(body: string): string[] {
  return body.split(SUMMARY_ANSWER_SEPARATOR);
}
