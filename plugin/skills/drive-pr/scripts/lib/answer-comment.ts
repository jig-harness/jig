/**
 * A person's answer to a parked question as `jig send … answer` writes it
 * (`drive-answer`): the comment and its record are
 * `shared/decisions/answer-record.ts`'s, which the dispatch dashboard's Send
 * writes too; this file posts it through the forge's command line.
 *
 * The text is the person's own words and reaches the drive's passes as
 * their verdict, so it is checked before it is written (`answerTextFault`):
 * one line of at most `ANSWER_TEXT_MAX` characters, with no control
 * characters (line breaks and the marks that reorder text among them) and
 * no hidden marker.
 */
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { ghCall, ghRepoEnv } from "./proc.ts";
import { ANSWER_TEXT_MAX } from "../../../../shared/decisions/answer-limits.ts";
import { answerTextFault } from "../../../../shared/decisions/answer-text.ts";
import {
  answerLine,
  structuredAnswerText,
  type WrittenChoice,
} from "../../../../shared/decision-card.ts";

/** The comment and its record are shared with the dashboard's Send. */
export {
  ANSWER_KIND,
  answerComment,
  type StructuredParts,
  withoutAnswerRecord,
} from "../../../../shared/decisions/answer-record.ts";
/** The longest answer, in characters: a sentence or two, which every pass's notice carries whole. */
export { ANSWER_TEXT_MAX, answerTextFault };
/** The answer line and a structured answer's text are written as the dashboard's card writes them (`shared/decision-card.ts`). */
export { answerLine, structuredAnswerText, type WrittenChoice };

/** Why `key` cannot be named in an answer line, or `null` when it can. */
export function answerKeyFault(key: string): string | null {
  return /^\S+$/.test(key) &&
    !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(key) &&
    !key.includes("<!--")
    ? null
    : `${JSON.stringify(key)} cannot be written in an answer line, which names its key without spaces`;
}

/** Post `body` as a comment on pull request `pr` of `repo`: its link (`null` when the forge named none), or why the forge did not take it. */
export async function postAnswerComment(
  repo: string,
  pr: number,
  body: string,
): Promise<Outcome<string | null, "refused">> {
  const r = await ghCall(
    [
      "api",
      "--method",
      "POST",
      `repos/${repo}/issues/${pr}/comments`,
      "-f",
      `body=${body}`,
    ],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").at(-1) ?? "";
    return failed(
      "refused",
      `the forge did not take the comment (gh exited ${r.code}${tail === "" ? "" : `: ${tail}`})`,
    );
  }
  let posted: unknown;
  try {
    posted = JSON.parse(r.stdout);
  } catch {
    posted = null;
  }
  const url = isRecord(posted) ? posted.html_url : undefined;
  return ok(typeof url === "string" && url !== "" ? url : null);
}
