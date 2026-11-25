/** A top-level reply can carry several independently classified answers. */
export const SUMMARY_ANSWER_MARKER = "drive-pr-summary-answer";
export const ADDRESSED_MARKER = "drive-pr-addressed";
export const SUMMARY_ANSWER_SEPARATOR = `\n\n<!-- ${SUMMARY_ANSWER_MARKER} -->\n`;

export function summaryAnswerBlocks(body: string): string[] {
  return body.split(SUMMARY_ANSWER_SEPARATOR);
}
