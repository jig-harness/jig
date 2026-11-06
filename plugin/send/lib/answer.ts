/**
 * `answer <key> <text>`: a comment on the pull request whose first line is
 * `answer <key>: <text>`, the line the re-arm reads as the person's verdict,
 * with the record envelope naming the writer and its host beside it
 * (`skills/drive-pr/scripts/lib/answer-comment.ts`).
 *
 * Checked before the write: the pull request is open, its drive ledger
 * reads, the key is one of its parked questions, and no trusted comment
 * after the park answers it yet. An answer the re-arm has read cannot be
 * taken back, so the text is the person's own words, checked as one line
 * (`verbs.ts`) and shown in full before it is sent.
 */
import { ok } from "../../shared/outcome.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  answerComment,
  answerLine,
  postAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import { parkedQuestions, readDrive } from "../../ask/lib/drive.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { type Planned, refused } from "./plan.ts";

/** The plan of an answer, or why the drive cannot take it. */
export async function planAnswer(
  ctx: AskContext,
  key: string,
  text: string,
  login: string,
  writesAs: string,
): Promise<Planned> {
  const d = await readDrive(ctx);
  const pr = Number(ctx.address.key);
  if (d.pull === null) return refused(d.answer.stateDetail);
  const { doc, read } = d.pull;
  if (!read)
    return refused(
      `pull request ${pr} did not read, so whether it is open is not known`,
    );
  if (doc.state !== "OPEN")
    return refused(
      `pull request ${pr} is ${doc.state.toLowerCase()}: no drive waits on an answer`,
    );
  if (d.comments === null)
    return refused(
      `the comments of pull request ${pr} did not read, so its parked questions and their answers are not known`,
    );
  if (d.ledger === null)
    return refused(
      `pull request ${pr} has no drive ledger, so it has no parked question`,
    );
  if (typeof d.ledger === "string")
    return refused(
      `the parked questions of pull request ${pr} cannot be read: ${d.ledger}`,
    );
  const questions = parkedQuestions(d.ledger, d.comments);
  const question = questions.find((q) => q.key === key);
  if (question === undefined)
    return refused(
      `${key} is not a parked question of pull request ${pr}; ${
        questions.length === 0
          ? "it has none"
          : `its parked questions are ${questions.map((q) => q.key).join(", ")}`
      }`,
    );
  if (question.answered)
    return refused(
      `${key} is already answered by a trusted comment after its park; a second answer is not sent`,
    );
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: "answer",
    writesAs,
    record: `a comment on pull request ${pr}: "${answerLine(key, text)}", with the record envelope naming ${login} and this host (as a digest) in a hidden marker`,
    where: doc.url,
    reader:
      "the re-arm, which hands your answer to the drive's passes as your verdict once every parked question is answered: the dispatcher's next tick where a dispatcher reads the pull request, else the re-arm command the stop printed",
    undo: "none once the re-arm has read it; until then, delete the comment",
    notice:
      "the answer is a comment on the pull request, readable by whoever can read the pull request",
    write: async () => {
      const body = answerComment(
        key,
        text,
        pr,
        localWriter("forge", login),
        new Date().toISOString(),
      );
      const posted = await postAnswerComment(ctx.address.repo, pr, body);
      return posted.ok ? ok(posted.value ?? doc.url) : posted;
    },
  });
}
