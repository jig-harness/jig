/**
 * A person's answer to a parked question as one pull-request comment, the
 * `drive-answer` record, written by `jig send … answer` and by the dispatch
 * dashboard's Send alike:
 *
 *   answer <key>: <text>
 *   note <key>: <note>
 *
 *   <!-- jig-send-answer
 *   {"kind":"drive-answer","v":1,"key":"answer:<key>","writer":{…},"at":"…","pr":<PR>,"decision":"<digest>","choice":{"option":"<name>","form":"approve|choose"}}
 *   -->
 *
 * The first line is what the re-arm reads (`driver/rearm.ts`): an
 * `answer <key>:` line, from an author the forge vouches for, after the
 * park. A structured answer's text is `approve` or `choose <option>`, ending
 * with the digest of the framing the person read (`approve [<digest>]`)
 * when the park has one, and may have a `note <key>:` line beside it; its
 * record then carries the digest (`decision`) and the option chosen and its
 * form (`choice`) as payload fields. The record stays at version 1: a reader
 * that does not know a payload field ignores it. The hidden marker holds the
 * record envelope, which names the writer: `jig send` names its login and
 * its host (as a digest, like every record on the forge), the dashboard's
 * Send its login and `BROWSER_HOST`. A comment carrying any other hidden
 * marker is a script's and never a person's answer; this record is the one
 * marker an answer may carry, so the readers take it out
 * (`withoutAnswerRecord`) before they apply that rule and before they hand
 * the comment to a pass. It adds no authority: who may answer is still the
 * re-arm's rule for an author.
 *
 * One comment answers one key, so a card of several decisions is sent as
 * one comment per decision (`cardAnswerComments`).
 *
 * No `node:` import: the dashboard's page bundles it.
 */
import { type Envelope, decodeMarker, encode } from "../records/envelope.ts";
import type { Writer } from "../records/writer-shape.ts";
import {
  answerLine,
  type CardAnswer,
  cardAnswerText,
  noteLine,
  type WrittenChoice,
} from "../decision-card.ts";

/** The record's kind in the records registry. */
export const ANSWER_KIND = "drive-answer";
/** The hidden marker the record sits in. */
const ANSWER_MARKER = "jig-send-answer";
const ANSWER_OPEN = `<!-- ${ANSWER_MARKER}`;
const ANSWER_CLOSE = "\n-->";

/** What a structured answer adds to its comment: the note line and the record's payload fields. */
export interface StructuredParts {
  note?: string;
  /** The digest of the framing the person read; absent on a park from before digests. */
  decision?: string;
  choice: WrittenChoice;
}

/**
 * The comment that answers parked `key` of pull request `pr` with `text`,
 * as `writer` at `at`; a structured answer's note line and payload fields
 * from `structured`.
 */
export function answerComment(
  key: string,
  text: string,
  pr: number,
  writer: Writer,
  at: string,
  structured?: StructuredParts,
): string {
  const envelope: Envelope = {
    kind: ANSWER_KIND,
    v: 1,
    key: `answer:${key}`,
    writer,
    at,
  };
  const note =
    structured?.note === undefined ? "" : `\n${noteLine(key, structured.note)}`;
  const payload =
    structured === undefined
      ? { pr }
      : {
          pr,
          ...(structured.decision === undefined
            ? {}
            : { decision: structured.decision }),
          choice: structured.choice,
        };
  return `${answerLine(key, text)}${note}\n\n${ANSWER_OPEN}\n${encode(envelope, payload)}${ANSWER_CLOSE}`;
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

/** The record's payload parts for a card's answer: a pick's choice, digest and note; a free answer has none. */
function cardAnswerParts(
  answer: CardAnswer,
  digest: string | undefined,
): StructuredParts | undefined {
  if (answer.kind === "free") return undefined;
  const note = answer.note?.trim() ?? "";
  return {
    choice: {
      option: answer.option,
      form: answer.recommended ? "approve" : "choose",
    },
    ...(digest === undefined ? {} : { decision: digest }),
    ...(note === "" ? {} : { note }),
  };
}

/**
 * One comment per decision a card answers, each the `drive-answer` record
 * `jig send` writes for its key: the answer line (and a pick's note line)
 * the card's Copy takes for that decision, then the record.
 */
export function cardAnswerComments(
  answers: ReadonlyArray<{ key: string; digest?: string; answer: CardAnswer }>,
  pr: number,
  writer: Writer,
  at: string,
): Array<{ key: string; body: string }> {
  return answers.map((a) => ({
    key: a.key,
    body: answerComment(
      a.key,
      cardAnswerText(a.answer, a.digest),
      pr,
      writer,
      at,
      cardAnswerParts(a.answer, a.digest),
    ),
  }));
}
