import { describe, expect, it } from "bun:test";
import { answerText } from "./replies.ts";

describe("the answer lines Copy takes", () => {
  it("leaves the option blank where nothing is drafted", () => {
    expect(answerText(["PRRT_x1"], [])).toBe("answer PRRT_x1: ");
  });

  it("puts each draft after its key's colon, trimmed", () => {
    expect(answerText(["PRRT_x1"], ["  A, it is smaller \n"])).toBe(
      "answer PRRT_x1: A, it is smaller",
    );
  });

  it("gives one line per key, a blank line between them", () => {
    expect(answerText(["PRRT_x1", "PRRT_x2"], ["A", ""])).toBe(
      "answer PRRT_x1: A\n\nanswer PRRT_x2: ",
    );
  });
});
