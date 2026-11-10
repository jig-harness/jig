/**
 * `answer <key> …`: a comment on the pull request whose first line is
 * `answer <key>: <text>`, the line the re-arm reads as the person's verdict,
 * with the record envelope naming the writer and its host beside it
 * (`skills/drive-pr/scripts/lib/answer-comment.ts`).
 *
 * The text is the person's own words, checked as one line (`verbs.ts`), or a
 * structured form: `--approve` (the option the park recommends) or
 * `--choose <option>`, written as the park spells the option and ending with
 * the digest of the framing, with a `note <key>:` line when `--note` gives
 * one, and the digest and the choice as the record's payload fields
 * (`answer-choice.ts`).
 *
 * Checked before the write: the pull request is open, its drive ledger
 * reads, every place an answer could be was read, and the key is one of its
 * parked questions. A structured form must name an option the park offers.
 * A park with a digest binds a structured answer to the framing the person
 * read: `--dry-run` prints the digest and the command that names it, a real
 * send must name it (`--decision`), and a digest that is no longer the
 * park's refuses, writing nothing. A park from before digests has none and
 * is bound by time alone, so `--decision` is refused there rather than
 * written as a binding that is not one.
 *
 * A person who already answered may answer again: each person's latest
 * answer is the one the readers count, so the plan shows the earlier answer
 * first and says this one replaces it. Another person's answer does not
 * refuse the send; the plan names it and says that differing answers leave
 * the item disputed, which the two settle between them.
 */
import { ok } from "../../shared/outcome.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  answerComment,
  answerLine,
  postAnswerComment,
  type StructuredParts,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import { parkedQuestions } from "../../ask/lib/park-reading.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import type { AnswerRequest } from "./answer-request.ts";
import { optionInFull, resolveChoice, shellWord } from "./answer-choice.ts";
import {
  ANSWER_READER,
  answersTo,
  earlierAnswer,
  READABLE_NOTICE,
  readParks,
  TICK,
} from "./answer-parks.ts";
import { type Planned, refused } from "./plan.ts";
import { planAnswerAll } from "./answer-all.ts";

type OneAnswer = Extract<AnswerRequest, { all: false }>;

interface Written {
  text: string;
  parts?: StructuredParts;
  detail: Array<[string, string]>;
}

/** The command a person sends after reading the dry run: the request, the option as the park spells it, and the digest. */
function sendCommand(
  address: string,
  request: OneAnswer,
  option: string,
  digest: string,
): string {
  const form =
    request.form.kind === "approve"
      ? "--approve"
      : `--choose ${shellWord(option)}`;
  const note =
    request.note === undefined ? "" : ` --note ${shellWord(request.note)}`;
  return `jig send ${address} answer ${request.key} ${form}${note} --decision ${digest}`;
}

type Structured = Extract<OneAnswer["form"], { kind: "approve" | "choose" }>;
type Row = [string, string];

/** Why a structured answer to `item` is not bound to the framing the person read, or `null` when it is. */
function bindingFault(
  item: ParkedItem,
  decision: string | undefined,
  dryRun: boolean,
): string | null {
  const digest = item.digest;
  if (digest === undefined)
    return decision === undefined
      ? null
      : `${item.key} was parked before decision digests, so it has none and an answer to it is bound by time alone; leave --decision out`;
  if (decision !== undefined && decision !== digest)
    return `--decision ${decision} is not the decision digest of ${item.key}'s framing now: the drive framed it again since you read it, and nothing is sent; run the dry run again, read the decision, and send the command it prints`;
  if (decision === undefined && !dryRun)
    return "name the framing you read: run this with --dry-run, read the option it shows, then send the command it prints, which names the decision's digest with --decision";
  return null;
}

/** The structured answer `request` makes to `item`, bound to the digest the person read, or why it is not sent. */
function structured(
  item: ParkedItem,
  request: OneAnswer & { form: Structured },
  login: string,
  address: string,
  dryRun: boolean,
): Planned | Written {
  const fault = bindingFault(item, request.decision, dryRun);
  if (fault !== null) return refused(fault);
  const resolved = resolveChoice(item, request.form, request.note, login);
  if (!resolved.ok) return resolved;
  const { option, recommended, text, parts } = resolved.value;
  const digest = item.digest;
  const send: Row[] =
    digest !== undefined && dryRun
      ? [["send", sendCommand(address, request, option.name, digest)]]
      : [];
  return {
    text,
    parts,
    detail: [
      [
        "decision",
        digest ??
          "none: parked before decision digests, so the answer is bound by time alone",
      ],
      ["option", optionInFull(option, recommended)],
      ...send,
    ],
  };
}

/** What `request` writes to `item`: the person's words as they are, or a structured answer. */
function writtenFor(
  item: ParkedItem,
  request: OneAnswer,
  login: string,
  address: string,
  dryRun: boolean,
): Planned | Written {
  const { form } = request;
  return form.kind === "free"
    ? { text: form.text, detail: [] }
    : structured(item, { ...request, form }, login, address, dryRun);
}

/** The notice of an answer: who can read it, and what it does to earlier answers. */
function noticeOf(replaces: boolean, beside: boolean): string {
  return [
    READABLE_NOTICE,
    ...(replaces
      ? [
          "your latest answer is the one the drive counts, so this one replaces it",
        ]
      : []),
    ...(beside
      ? [
          "when this answer and another person's differ (another option, another note, or a free answer beside a structured one), the item is disputed and waits until you agree",
        ]
      : []),
  ].join("; ");
}

/** The plan of an answer to one parked key, or why the drive cannot take it. */
async function planAnswer(
  ctx: AskContext,
  request: OneAnswer,
  login: string,
  writesAs: string,
  dryRun: boolean,
): Promise<Planned> {
  const read = await readParks(ctx);
  if (!read.ok) return read;
  const { pr, doc, ledger, found } = read.value;
  const { key } = request;
  const item = ledger.parked.find((p) => p.key === key);
  if (item === undefined) {
    const questions = parkedQuestions(ledger, found);
    return refused(
      `${key} is not a parked question of pull request ${pr}; ${
        questions.length === 0
          ? "it has none"
          : `its parked questions are ${questions.map((q) => q.key).join(", ")}`
      }`,
    );
  }
  const written = writtenFor(item, request, login, ctx.name, dryRun);
  if ("ok" in written) return written;
  const answers = answersTo(found, key);
  const mine = answers.filter(
    (a) => a.author.toLowerCase() === login.toLowerCase(),
  );
  const others = answers.filter((a) => !mine.includes(a));
  const lines = [
    answerLine(key, written.text),
    ...(written.parts?.note === undefined
      ? []
      : [`note ${key}: ${written.parts.note}`]),
  ];
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: "answer",
    writesAs,
    earlier: [
      ...mine.map((a) => earlierAnswer(a, "your answer")),
      ...others.map((a) => earlierAnswer(a, `${a.author}'s answer`)),
    ],
    record: `a comment on pull request ${pr}: ${lines.map((l) => `"${l}"`).join(" and ")}, with the record envelope naming ${login} and this host (as a digest)${written.parts === undefined ? "" : ", the decision's digest and the option chosen"} in a hidden marker`,
    where: doc.url,
    reader: ANSWER_READER,
    tick: TICK,
    undo: "none once the re-arm has read it; until then, delete the comment, or answer again: your latest answer is the one that counts",
    notice: noticeOf(mine.length > 0, others.length > 0),
    detail: written.detail,
    write: async () => {
      const body = answerComment(
        key,
        written.text,
        pr,
        localWriter("forge", login),
        new Date().toISOString(),
        written.parts,
      );
      const posted = await postAnswerComment(ctx.address.repo, pr, body);
      return posted.ok ? ok(posted.value ?? doc.url) : posted;
    },
  });
}

/** The plan of `request`: one key's answer, or every eligible item's approval. */
export function planAnswerRequest(
  ctx: AskContext,
  request: AnswerRequest,
  login: string,
  writesAs: string,
  dryRun: boolean,
): Promise<Planned> {
  return request.all
    ? planAnswerAll(ctx, request.decisionSet, login, writesAs, dryRun)
    : planAnswer(ctx, request, login, writesAs, dryRun);
}
