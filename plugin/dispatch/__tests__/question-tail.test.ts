import { expect, test } from "bun:test";
import { QuestionTail } from "../lib/question-tail.ts";

test("keeps the last question, decoding a character split across chunks", () => {
  const tail = new QuestionTail("Question:", 20);
  const bytes = Buffer.from("noise\nQuestion: é?\nmore\n");
  const cut = bytes.indexOf(0xc3) + 1;
  tail.write(bytes.subarray(0, cut));
  tail.write(bytes.subarray(cut));
  tail.end();
  expect(tail.question).toBe("Question: é?");
});

test("closes an unterminated last line and caps its length", () => {
  const tail = new QuestionTail("Question:", 5);
  tail.write(Buffer.from("Question: abcdefghij"));
  tail.end();
  expect(tail.question).toBe("Question: abcd");
});

test("ignores a bare prefix", () => {
  const tail = new QuestionTail("Question:", 20);
  tail.write(Buffer.from("Question:\n"));
  tail.end();
  expect(tail.question).toBe("");
});
