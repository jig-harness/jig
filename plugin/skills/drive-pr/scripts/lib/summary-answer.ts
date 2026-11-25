import { OUTCOMES } from "./outcome.ts";

const ANSWER_MARKER_NAMES = /^drive-pr-(?:summary-answer|addressed)\b/i;
const COMMENT_OPENER = /<!--\s*/;

export const MARKER_SAFE_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function summaryAnswerProblem(
  fingerprint: string,
  reason: string,
): string | undefined {
  if (!/^[A-Za-z0-9]/.test(fingerprint)) {
    return `fingerprint '${fingerprint}' must start with a letter or digit`;
  }
  if (!MARKER_SAFE_FINGERPRINT.test(fingerprint)) {
    return `fingerprint '${fingerprint}' contains a character the drive-pr-addressed marker cannot carry (allowed: letters, digits, . _ -).`;
  }
  if (reason.trim() === "") {
    return "the reason body on stdin was empty — a bare outcome explains nothing";
  }
  const leading = reason.trimStart();
  const token = OUTCOMES.find((outcome) =>
    leading.startsWith(`**${outcome}**`),
  );
  if (token !== undefined) {
    return `the reason already opens with an outcome token (**${token}**). Supply the reason alone.`;
  }
  if (
    reason
      .split(COMMENT_OPENER)
      .slice(1)
      .some((comment) => ANSWER_MARKER_NAMES.test(comment))
  ) {
    return "the reason cannot contain an answer marker";
  }
  return undefined;
}
