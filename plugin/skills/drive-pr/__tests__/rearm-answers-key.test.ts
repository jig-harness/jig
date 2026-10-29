/**
 * drive-pr suite: which pull-request comment lines answer a parked key. Only
 * an `answer <key>: …` line with a decision after the colon, outside any
 * fenced block, counts.
 */

import { describe, expect, it } from "bun:test";
import { answersKey } from "../scripts/lib/driver/rearm.ts";

describe("answersKey", () => {
  it("accepts an answer line with a decision", () => {
    expect(answersKey("answer PRRT_p: option B", "PRRT_p")).toBe(true);
    expect(answersKey("context\n  Answer PRRT_p: keep it", "PRRT_p")).toBe(
      true,
    );
  });

  it("refuses an answer line with nothing after the colon", () => {
    expect(answersKey("answer PRRT_p:", "PRRT_p")).toBe(false);
    expect(answersKey("answer PRRT_p:   \nthanks", "PRRT_p")).toBe(false);
  });

  it("refuses an answer line inside a fenced block", () => {
    const body = ["Reply like this:", "```", "answer PRRT_p: option B", "```"];
    expect(answersKey(body.join("\n"), "PRRT_p")).toBe(false);
    const tilde = ["~~~", "answer PRRT_p: option B", "~~~"].join("\n");
    expect(answersKey(tilde, "PRRT_p")).toBe(false);
  });

  it("closes a fence only on a run of its own marker at least as long", () => {
    const longer = ["````", "```", "answer PRRT_p: option B", "````"];
    expect(answersKey(longer.join("\n"), "PRRT_p")).toBe(false);
    const mixed = ["```", "~~~", "answer PRRT_p: option B", "```"];
    expect(answersKey(mixed.join("\n"), "PRRT_p")).toBe(false);
    const infoNotClose = ["```", "```ts", "answer PRRT_p: option B", "```"];
    expect(answersKey(infoNotClose.join("\n"), "PRRT_p")).toBe(false);
    const closed = ["````", "x", "`````", "answer PRRT_p: option B"];
    expect(answersKey(closed.join("\n"), "PRRT_p")).toBe(true);
  });

  it("refuses a quoted line and a mere mention", () => {
    expect(answersKey("> answer PRRT_p: option B", "PRRT_p")).toBe(false);
    expect(answersKey("about PRRT_p: later", "PRRT_p")).toBe(false);
  });
});
