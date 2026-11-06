/** dispatch: a failure as one line, whatever was thrown. */
import { describe, expect, it } from "bun:test";
import { failureText } from "../lib/text.ts";

describe("failureText", () => {
  it("takes an error's first line", () => {
    expect(failureText(new Error("boom\nstack"))).toBe("boom");
  });

  it("survives an error whose message is not a string", () => {
    const malformed = Object.assign(new Error("placeholder"), { message: null });
    expect(failureText(malformed)).toBe("null");
  });

  it("survives a value with no text form", () => {
    expect(failureText(Object.create(null))).toBe("an unknown failure");
  });
});
