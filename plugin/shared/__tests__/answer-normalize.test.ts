import { expect, test } from "bun:test";
import { normalizeAnswerText } from "../decisions/answer-normalize.ts";

test.each([
  ["ＡＰＰＲＯＶＥ！", "approve"],
  ["Don’t release", "don't release"],
  ["“Keep” — current", '"keep" - current'],
  ["**Choose** `Keep`", "choose keep"],
  ["__Choose__ Keep", "choose keep"],
  ["  Choose\t\n Keep. ", "choose keep"],
  ["Keep!!", "keep!"],
  ["Keep !", "keep"],
  ["Keep?", "keep?"],
])("normalizes answer spelling %j to %j", (text, expected) => {
  expect(normalizeAnswerText(text)).toBe(expected);
});
