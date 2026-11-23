import { describe, expect, it } from "bun:test";
import { rawTextMentionsJsonKey } from "../scripts/lib/state/raw-json-key.ts";

describe("rawTextMentionsJsonKey", () => {
  const cases: [string, string, boolean][] = [
    ["a key in an unparseable document", '{"ciHold" : 1', true],
    ["a match in value position", '{"reason":"ciHold"}', false],
    ["an escaped spelling of the key", '{"c\\u0069Hold":1}', true],
    ["an escaped near miss", '{"ci\\u0068old":1}', false],
    ["an unterminated literal", '"ciHold', false],
    ["a key after an escaped quote", 'x "a\\"b" "ciHold":', true],
    ["a literal with no colon after it", '{"ciHold"', false],
    ["text with no literal", "ciHold:", false],
  ];
  for (const [name, text, expected] of cases)
    it(`reads ${name}`, () => {
      expect(rawTextMentionsJsonKey(text, "ciHold")).toBe(expected);
    });
});
