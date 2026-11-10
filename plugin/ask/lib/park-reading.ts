/** The answer read shared by ask, send and the drive's classifier. */
import {
  parkAnswers,
  threadComments,
} from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { CommentLike } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import type { ParkReading } from "../../dispatch/lib/sources/ledgers.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { PendingAnswer } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import type { AskContext } from "./station.ts";
import { within, PAST_DEADLINE } from "./reading.ts";
import type { ThreadEntry } from "./answer.ts";

export type ParkAnswers = Awaited<ReturnType<typeof parkAnswers>>;

/** The ledger's parked questions, answered by the shared read of all their comments. */
export function parkedQuestions(
  ledger: Ledger,
  found: ParkAnswers | null,
): {
  key: string;
  kind: string;
  reason: string;
  answered: boolean;
}[] {
  return ledger.parked.map((p) => ({
    key: p.key,
    kind: p.kind,
    reason: p.reason,
    answered:
      found !== null &&
      !("unreadable" in found) &&
      found.unread.length === 0 &&
      found.answered.some((v) => v.key === p.key),
  }));
}

export async function readParkThread(
  ctx: AskContext,
  key: string,
): Promise<CommentLike[] | null> {
  const record = `park-answer-thread:${key}`;
  const sec = ctx.reading.sourceSec();
  if (sec === 0) {
    ctx.reading.note({ record, read: false, detail: PAST_DEADLINE });
    return null;
  }
  ctx.reading.forgeCall();
  const got = await within(sec, () => threadComments(key, sec));
  const comments = got?.value ?? null;
  ctx.reading.note({
    record,
    read: comments !== null,
    ...(comments !== null
      ? {}
      : {
          detail:
            got === null
              ? `the thread read exceeded its ${sec} s deadline`
              : "the thread comments did not read",
        }),
  });
  return comments;
}

/** The same thread reads as the re-arm, counted and bounded by this answer's deadline. */
export async function readParkAnswers(
  ctx: AskContext,
  pr: number,
  ledger: Ledger,
  listing: readonly unknown[] | null,
): Promise<ParkAnswers> {
  if (listing === null) return { unreadable: "the pull request's comments" };
  const found = await parkAnswers(
    pr,
    ledger.parked,
    ctx.address.repo,
    listing,
    {
      threadComments: (key) => readParkThread(ctx, key),
    },
  );
  const complete = !("unreadable" in found) && found.unread.length === 0;
  ctx.reading.note({
    record: "park-answers",
    read: complete,
    ...(complete
      ? {}
      : { detail: "not every place an answer could be was read" }),
  });
  return found;
}

/** A classifier uses no partial answer history as proof of a settled item. */
export function parkReading(found: ParkAnswers | null): ParkReading {
  if (found === null) return { unreadable: "its parks" };
  if ("unreadable" in found) return found;
  if (found.unread.length > 0)
    return {
      unreadable: found.unread.map((p) => `${p.kind} ${p.key}`).join(", "),
    };
  return {
    answered: found.answered.length,
    waiting: found.waiting.map((p) => `${p.kind} ${p.key}`),
    disputed: found.disputed.map((d) => `${d.item.kind} ${d.item.key}`),
  };
}

/** A person's answer, including the shared parser's interpretation. */
export function answerText(answer: PendingAnswer): string {
  const choice = answer.choice;
  return choice === undefined
    ? `free answer: ${answer.body}`
    : `structured answer: chose ${choice.option}${choice.recommended ? " (recommended)" : ""}${choice.note === undefined ? "" : `; note: ${choice.note}`}`;
}

/** Review-thread replies are absent from the pull request's conversation. */
export function parkAnswerEntries(
  found: ParkAnswers | null,
  address: string,
): ThreadEntry[] {
  if (found === null || "unreadable" in found) return [];
  const answers = [
    ...found.answered.map((v) => ({
      key: v.key,
      answers: v.answers,
      disputed: false,
    })),
    ...found.disputed.map((v) => ({
      key: v.item.key,
      answers: v.answers,
      disputed: true,
    })),
  ].flatMap((v) =>
    v.answers.map((a) => ({
      at: a.at,
      kind: "answer" as const,
      from: a.author,
      to: address,
      text: `${v.disputed ? "disputed " : ""}${v.key}: ${answerText(a)}`,
      record: { kind: "pull-request-comment", url: a.url },
    })),
  );
  return [
    ...answers,
    ...found.notes.map((n) => ({
      at: n.at,
      kind: "answer" as const,
      from: n.author,
      to: address,
      text: `${n.item.key}: note with no answer: ${n.note}`,
      record: { kind: "pull-request-comment", url: n.url },
    })),
  ];
}

/** Classification is visible in the ordinary text answer as well as its thread. */
export function parkAnswerSummary(found: ParkAnswers | null): string[] {
  if (found === null || "unreadable" in found) return [];
  return [
    ...found.answered.map(
      (v) =>
        `${v.key}: ${v.answers.every((a) => a.choice === undefined) ? "free answer" : `structured answer choosing ${v.answers[0]?.choice?.option ?? ""}`}`,
    ),
    ...found.disputed.map((v) => `${v.item.key}: disputed answers`),
    ...found.notes.map((v) => `${v.item.key}: note with no answer`),
  ];
}
