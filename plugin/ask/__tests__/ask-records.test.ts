/**
 * The record readers `jig ask` shares: an answer line counts only outside a
 * fenced block, and only by a commenter and in a form the re-arm accepts.
 */
import { describe, expect, it } from "bun:test";
import { answerEntries } from "../lib/thread.ts";
import type { CommentFields } from "../lib/forge.ts";

function comment(body: string): CommentFields {
  return {
    id: 1,
    body,
    login: "owner",
    association: "OWNER",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    url: "u",
  };
}

describe("answerEntries", () => {
  it("keeps the real answer line and drops the same key shown in a fence", () => {
    const body = [
      "answer K: yes",
      "",
      "Write it like this:",
      "```",
      "answer K: no",
      "```",
    ].join("\n");
    const out = answerEntries([comment(body)], "drive@o/r#1", "u");
    expect(out.map((e) => e.text)).toEqual(["answer K: yes"]);
  });

  it("drops a line that appears only inside a fence", () => {
    const body = "```\nanswer K: no\n```";
    expect(answerEntries([comment(body)], "a", "u")).toEqual([]);
  });

  it("drops a comment the re-arm would not accept: an outcome reply, or an untrusted association", () => {
    const outcome = comment("**accepted** — fixed.\nanswer K: yes");
    const none = { ...comment("answer K: yes"), association: "NONE" };
    expect(answerEntries([outcome, none], "a", "u")).toEqual([]);
  });
});
