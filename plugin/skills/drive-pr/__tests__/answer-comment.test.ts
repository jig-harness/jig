/**
 * The answer `jig send` writes: its text is checked as one line within its
 * limit, the comment carries the record envelope in its own marker, and the
 * re-arm's rule for a person's answer reads it as one while it still refuses
 * every comment with any other hidden marker, a damaged record among them.
 */
import { describe, expect, it } from "bun:test";
import { decodeMarker } from "../../../shared/records/envelope.ts";
import { localWriter } from "../../../shared/records/writer.ts";
import {
  ANSWER_TEXT_MAX,
  answerComment,
  answerKeyFault,
  answerTextFault,
  withoutAnswerRecord,
} from "../scripts/lib/answer-comment.ts";
import { answersKey, isAnswer } from "../scripts/lib/driver/rearm.ts";
import { isPersonsComment } from "../scripts/lib/provisional.ts";

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
    expect(answerTextFault("yes‮on")).toContain("control character");
    expect(answerTextFault("yes <!-- x")).toContain("hidden marker");
    expect(answerTextFault("y".repeat(ANSWER_TEXT_MAX))).toBeNull();
    expect(answerTextFault("y".repeat(ANSWER_TEXT_MAX + 1))).toContain(
      `past the ${ANSWER_TEXT_MAX}`,
    );
    expect(answerKeyFault("PRRT_k1")).toBeNull();
    expect(answerKeyFault("two words")).toContain("without spaces");
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
