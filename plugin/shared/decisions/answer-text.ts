import { ANSWER_TEXT_MAX } from "./answer-limits.ts";

/** Why text cannot be sent as a structured answer, or `null` when it can. */
export function answerTextFault(text: string): string | null {
  if (text.trim() === "") return "the answer is empty";
  if (
    [...text].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  )
    return "the answer holds a line break or another control character; send one line";
  if (text.includes("<!--"))
    return "the answer holds a hidden marker (<!--), which no person's answer carries";
  const length = [...text].length;
  return length > ANSWER_TEXT_MAX
    ? `the answer is ${length} characters, past the ${ANSWER_TEXT_MAX} an answer may have`
    : null;
}
