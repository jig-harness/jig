/**
 * The answer `jig send` writes: its text is checked as one line within its
 * limit, the comment carries the record envelope in its own marker, and the
 * re-arm's rule for a person's answer reads it as one while it still refuses
 * every comment with any other hidden marker, a damaged record among them.
 * A structured answer it writes reads back, through the readers' one
 * parser, as the choice it names with its digest, and a person's later
 * answer replaces their earlier one. The comments the dispatch dashboard's
 * Send writes from a browser, one per decision, read the same way.
 */
import { describe, expect, it } from "bun:test";
import { decodeMarker } from "../../../shared/records/envelope.ts";
import { localWriter } from "../../../shared/records/writer.ts";
import { BROWSER_HOST } from "../../../shared/records/writer-shape.ts";
import { cardAnswerComments } from "../../../shared/decisions/answer-record.ts";
import { decisionDigest } from "../../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../../shared/decisions/park.ts";
import {
  ANSWER_TEXT_MAX,
  answerComment,
  structuredAnswerText,
  answerKeyFault,
  answerTextFault,
  withoutAnswerRecord,
} from "../scripts/lib/answer-comment.ts";
import { answersKey, isAnswer } from "../scripts/lib/driver/rearm.ts";
import { isPersonsComment } from "../scripts/lib/provisional.ts";
import { parkAnswers } from "../scripts/lib/driver/park-answers.ts";
import type { ParkedItem } from "../scripts/lib/state/park-frame.ts";

const AT = "2026-11-06T10:00:00.000Z";
const body = () =>
  answerComment("PRRT_k1", "keep it", 12, localWriter("forge", "owner"), AT);
const asComment = (text: string) => ({
  author: "owner",
  association: "OWNER",
  at: AT,
  url: "u",
  body: text,
});

describe("answerTextFault", () => {
  it("takes one line within the limit, and refuses an empty, multi-line, marked or long one", () => {
    expect(answerTextFault("keep the flag for one release")).toBeNull();
    expect(answerTextFault("  ")).toContain("empty");
    expect(answerTextFault("yes\nno")).toContain("one line");
    expect(answerTextFault("yes\u202eon")).toContain("control character");
    expect(answerTextFault("yes <!-- x")).toContain("hidden marker");
    expect(answerTextFault("y".repeat(ANSWER_TEXT_MAX))).toBeNull();
    expect(answerTextFault("y".repeat(ANSWER_TEXT_MAX + 1))).toContain(
      `past the ${ANSWER_TEXT_MAX}`,
    );
    expect(answerKeyFault("PRRT_k1")).toBeNull();
    expect(answerKeyFault("two words")).toContain("without spaces");
    expect(answerKeyFault("a\u007fb")).toContain("cannot be written");
    expect(answerKeyFault("a\u202eb")).toContain("cannot be written");
  });
});

describe("the answer comment", () => {
  it("opens with the answer line and carries the envelope naming its writer and host", () => {
    const text = body();
    expect(text.split("\n")[0]).toBe("answer PRRT_k1: keep it");
    const read = decodeMarker(text, "jig-send-answer", "drive-answer");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.envelope.key).toBe("answer:PRRT_k1");
    expect(read.value.envelope.writer.login).toBe("owner");
    expect(read.value.envelope.writer.host).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(read.value.payload).toEqual({ pr: 12 });
  });

  it("is a person's answer to its key by the re-arm's rule, and the pass is handed the line alone", () => {
    const text = body();
    expect(answersKey(text, "PRRT_k1")).toBe(true);
    expect(isAnswer(asComment(text), Date.parse(AT) - 1)).toBe(true);
    expect(isPersonsComment("OWNER", text)).toBe(true);
    expect(withoutAnswerRecord(text)).toBe("answer PRRT_k1: keep it");
  });

  it("does not make a comment with another marker, or a damaged record, a person's answer", () => {
    const other = `${body()}\n<!-- drive-pr-ledger -->`;
    expect(isAnswer(asComment(other), 0)).toBe(false);
    expect(isPersonsComment("OWNER", other)).toBe(false);
    const damaged = body().replace('"kind":"drive-answer"', '"kind":"nothing"');
    expect(withoutAnswerRecord(damaged)).toBe(damaged);
    expect(isAnswer(asComment(damaged), 0)).toBe(false);
  });
});

const decision: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Keep the flag?",
    recommended: "keep",
    why: "Readers still pass it",
    options: [
      { id: "keep", name: "Keep", summary: "It stays.", pay: ["Upkeep"] },
      { id: "drop", name: "Remove", summary: "It goes.", pay: ["Breakage"] },
    ],
  },
  steps: [],
  alreadyDone: "Read the callers.",
};
const DIGEST = decisionDigest(decision);
const parked: ParkedItem = {
  key: "F_k1",
  kind: "finding",
  reason: "Keep the flag?",
  round: 1,
  at: "2026-11-06T09:00:00.000Z",
  class: "scope",
  decision,
  digest: DIGEST,
};
const listed = (id: number, text: string, at: string) => ({
  body: text,
  user: { login: "owner" },
  author_association: "OWNER",
  created_at: at,
  updated_at: at,
  html_url: `https://example.test/pull/12#issuecomment-${id}`,
});
const structured = (
  form: "approve" | "choose",
  option: string,
  note?: string,
) =>
  answerComment(
    "F_k1",
    structuredAnswerText({ form, option }, DIGEST),
    12,
    localWriter("forge", "owner"),
    AT,
    {
      decision: DIGEST,
      choice: { option, form },
      ...(note === undefined ? {} : { note }),
    },
  );

describe("a structured answer the send writes", () => {
  it("writes the form with its digest, the note line and the payload fields under version 1", () => {
    const text = structured("choose", "Remove", "after the migration");
    expect(text.split("\n").slice(0, 2)).toEqual([
      `answer F_k1: choose Remove [${DIGEST}]`,
      "note F_k1: after the migration",
    ]);
    const read = decodeMarker(text, "jig-send-answer", "drive-answer");
    expect(read.ok && read.value.envelope.v).toBe(1);
    expect(read.ok && read.value.payload).toEqual({
      pr: 12,
      decision: DIGEST,
      choice: { option: "Remove", form: "choose" },
    });
  });

  it("reads back through the readers' parser as the choice it names, bound to its digest", async () => {
    const found = await parkAnswers(12, [parked], "o/r", [
      listed(1, structured("choose", "Remove", "after the migration"), AT),
    ]);
    if ("unreadable" in found) throw new Error(found.unreadable);
    const [verdict] = found.answered;
    expect(verdict?.answers[0]?.choice).toEqual({
      option: "Remove",
      recommended: false,
      form: "choose",
      digest: DIGEST,
      note: "after the migration",
    });
    expect(verdict?.answers[0]?.stale).toBeUndefined();
  });

  it("is replaced by the same person's later answer", async () => {
    const found = await parkAnswers(12, [parked], "o/r", [
      listed(1, structured("choose", "Remove"), AT),
      listed(2, structured("approve", "Keep"), "2026-11-06T11:00:00.000Z"),
    ]);
    if ("unreadable" in found) throw new Error(found.unreadable);
    expect(found.disputed).toEqual([]);
    const answers = found.answered[0]?.answers ?? [];
    expect(answers).toHaveLength(1);
    expect(answers[0]?.choice?.option).toBe("Keep");
    expect(answers[0]?.choice?.form).toBe("approve");
  });
});

describe("the answers the dashboard's Send writes from a browser", () => {
  const second: ParkedItem = {
    ...parked,
    key: "F_k2",
    reason: "Keep the other flag?",
  };
  const comments = cardAnswerComments(
    [
      {
        key: "F_k1",
        digest: DIGEST,
        answer: {
          kind: "pick",
          option: "Remove",
          recommended: false,
          note: "after the migration",
        },
      },
      { key: "F_k2", digest: DIGEST, answer: { kind: "free", text: "later" } },
    ],
    12,
    { login: "owner", host: BROWSER_HOST },
    AT,
  );

  it("are one comment per decision, each the record jig send writes, naming the browser as its host", () => {
    expect(comments.map((c) => c.key)).toEqual(["F_k1", "F_k2"]);
    const [first, other] = comments;
    expect(first?.body.split("\n").slice(0, 2)).toEqual([
      `answer F_k1: choose Remove [${DIGEST}]`,
      "note F_k1: after the migration",
    ]);
    const read = decodeMarker(
      first?.body ?? "",
      "jig-send-answer",
      "drive-answer",
    );
    expect(read.ok && read.value.envelope).toMatchObject({
      key: "answer:F_k1",
      writer: { login: "owner", host: "dashboard (browser)" },
    });
    expect(read.ok && read.value.payload).toEqual({
      pr: 12,
      decision: DIGEST,
      choice: { option: "Remove", form: "choose" },
    });
    const free = decodeMarker(
      other?.body ?? "",
      "jig-send-answer",
      "drive-answer",
    );
    expect(free.ok && free.value.payload).toEqual({ pr: 12 });
  });

  it("are a person's answers by the re-arm's rule, and read back as the choice and the words they carry", async () => {
    for (const c of comments) {
      expect(isAnswer(asComment(c.body), Date.parse(AT) - 1)).toBe(true);
      expect(answersKey(c.body, c.key)).toBe(true);
      expect(isPersonsComment("OWNER", c.body)).toBe(true);
    }
    const found = await parkAnswers(12, [parked, second], "o/r", [
      listed(1, comments[0]?.body ?? "", AT),
      listed(2, comments[1]?.body ?? "", AT),
    ]);
    if ("unreadable" in found) throw new Error(found.unreadable);
    const byKey = new Map(found.answered.map((v) => [v.key, v.answers]));
    expect(byKey.get("F_k1")?.[0]?.choice).toEqual({
      option: "Remove",
      recommended: false,
      form: "choose",
      digest: DIGEST,
      note: "after the migration",
    });
    expect(byKey.get("F_k2")?.[0]?.choice).toBeUndefined();
    expect(byKey.get("F_k2")?.[0]?.body).toBe(`answer F_k2: later [${DIGEST}]`);
  });
});
