/**
 * A person's answer to a parked question as `jig send … answer <key> <text>`
 * writes it (`drive-answer`): one pull-request comment,
 *
 *   answer <key>: <text>
 *
 *   <!-- jig-send-answer
 *   {"kind":"drive-answer","v":1,"key":"answer:<key>","writer":{…},"at":"…","pr":<PR>}
 *   -->
 *
 * The first line is what the re-arm reads (`driver/rearm.ts`): an
 * `answer <key>:` line, from an author the forge vouches for, after the
 * park. The hidden marker holds the record envelope, which names the writer
 * and its host (as a digest, like every record on the forge). A comment
 * carrying any other hidden marker is a script's and never a person's
 * answer; this record is the one marker an answer may carry, so the readers
 * take it out (`withoutAnswerRecord`) before they apply that rule and before
 * they hand the comment to a pass. It adds no authority: who may answer is
 * still the re-arm's rule for an author.
 *
 * The text is the person's own words and reaches the drive's passes as
 * their verdict, so it is checked before it is written (`answerTextFault`):
 * one line of at most `ANSWER_TEXT_MAX` characters, with no control
 * characters (line breaks and the marks that reorder text among them) and
 * no hidden marker.
 */
import {
  type Envelope,
  decodeMarker,
  encode,
} from "../../../../shared/records/envelope.ts";
import type { Writer } from "../../../../shared/records/writer.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { ghCall, ghRepoEnv } from "./proc.ts";
import { ANSWER_TEXT_MAX } from "../../../../shared/decisions/answer-limits.ts";
import { answerTextFault } from "../../../../shared/decisions/answer-text.ts";

/** The record's kind in the records registry. */
export const ANSWER_KIND = "drive-answer";
/** The hidden marker the record sits in. */
const ANSWER_MARKER = "jig-send-answer";
const ANSWER_OPEN = `<!-- ${ANSWER_MARKER}`;
const ANSWER_CLOSE = "\n-->";
/** The longest answer, in characters: a sentence or two, which every pass's notice carries whole. */
export { ANSWER_TEXT_MAX, answerTextFault };

/** Why `key` cannot be named in an answer line, or `null` when it can. */
export function answerKeyFault(key: string): string | null {
  return /^\S+$/.test(key) && !key.includes("<!--")
    ? null
    : `${JSON.stringify(key)} cannot be written in an answer line, which names its key without spaces`;
}

/** The line the re-arm reads. */
export function answerLine(key: string, text: string): string {
  return `answer ${key}: ${text.trim()}`;
}

/** The comment that answers parked `key` of pull request `pr` with `text`, as `writer` at `at`. */
export function answerComment(
  key: string,
  text: string,
  pr: number,
  writer: Writer,
  at: string,
): string {
  const envelope: Envelope = {
    kind: ANSWER_KIND,
    v: 1,
    key: `answer:${key}`,
    writer,
    at,
  };
  return `${answerLine(key, text)}\n\n${ANSWER_OPEN}\n${encode(envelope, { pr })}${ANSWER_CLOSE}`;
}

/**
 * `body` without its answer record, when it carries one that reads; as it
 * is otherwise, so a comment with any other hidden marker still carries it.
 */
export function withoutAnswerRecord(body: string): string {
  if (!body.includes(ANSWER_OPEN)) return body;
  const text = body.replaceAll("\r", "");
  if (!decodeMarker(text, ANSWER_MARKER, ANSWER_KIND).ok) return body;
  const start = text.indexOf(`${ANSWER_OPEN}\n`);
  const end = text.indexOf(ANSWER_CLOSE, start) + ANSWER_CLOSE.length;
  return `${text.slice(0, start)}${text.slice(end)}`.trimEnd();
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
