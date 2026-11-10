import { describe, expect, it } from "bun:test";
import type { ParkedDecision } from "../../../shared/decisions/park.ts";
import type { ParkedItem } from "../scripts/lib/state/schema.ts";
import {
  latestAnswers,
  noteWithoutAnswer,
  parseAnswerComment,
  disputedAnswers,
} from "../scripts/lib/answer-forms.ts";

const decision: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Keep the flag?",
    recommended: "a",
    why: "Keeps the existing behavior",
    options: [
      {
        id: "a",
        name: "Keep",
        summary: "Keep the flag",
        pay: ["Carry the flag"],
      },
      {
        id: "b",
        name: "Don't release",
        summary: "Stop the release",
        pay: ["Wait for a fix"],
      },
    ],
  },
  steps: [],
  alreadyDone: "Checked the flag",
};
const item: ParkedItem = {
  key: "PRRT_a",
  kind: "thread",
  reason: "Keep the flag?",
  round: 1,
  at: "2026-11-10T10:00:00Z",
  decision,
};
const comment = (
  body: string,
  author = "alice",
  at = "2026-11-10T11:00:00Z",
) => ({
  author,
  association: "OWNER",
  at,
  url: `https://example.test/${author}/${at}`,
  body,
});
const parse = (
  body: string,
  place: "thread" | "conversation" = "conversation",
) => parseAnswerComment(item, comment(body), place);

describe("whole-comment answer forms", () => {
  it("reads approval, normalized names and a checked note while preserving the whole comment", () => {
    expect(parse("answer PRRT_a: **Approve!**")?.choice).toEqual({
      option: "Keep",
      recommended: true,
      form: "approve",
    });
    const body =
      "answer PRRT_a: choose `Don’t release`.\nnote PRRT_a: only until the fix lands";
    expect(parse(body)).toMatchObject({
      body,
      bodyHash: expect.any(String),
      choice: {
        option: "Don't release",
        recommended: false,
        form: "choose",
        note: "only until the fix lands",
      },
    });
    expect(parse("APPROVE.", "thread")?.choice?.option).toBe("Keep");
    expect(
      parse("approve\nnote PRRT_a: after the migration", "thread")?.choice
        ?.note,
    ).toBe("after the migration");
    expect(
      parse(
        "answer PRRT_a: approve\nnote PRRT_a: after the migration",
        "thread",
      )?.choice?.note,
    ).toBe("after the migration");
  });

  it("keeps conditions, unknown choices, examples and duplicate lines as free answers", () => {
    for (const body of [
      "answer PRRT_a: approve, but keep the old flag",
      "answer PRRT_a: choose missing",
      "answer PRRT_a: approve\nonly after the migration",
      "answer PRRT_a: approve\n> my own condition",
      "answer PRRT_a: approve\n```suggestion\nchange it\n```",
      "answer PRRT_a: approve\n    keep the old flag",
      "answer PRRT_a: approve\n    > Keep the flag?",
      "answer PRRT_a: approve\nanswer PRRT_a: choose Keep",
      "answer PRRT_a: approve\nnote other: unrelated",
      `answer PRRT_a: approve\nnote PRRT_a: ${"x".repeat(501)}`,
    ]) {
      expect(parse(body)?.body).toBe(body);
      expect(parse(body)?.choice).toBeUndefined();
    }
  });

  it("recognizes notification quotes conservatively and ignores fenced/indented answer examples", () => {
    expect(
      parse("> Keep the flag?\nanswer PRRT_a: approve")?.choice?.option,
    ).toBe("Keep");
    expect(parse("```\nanswer PRRT_a: approve\n```")).toBeNull();
    expect(parse("    answer PRRT_a: approve")).toBeNull();
    expect(parse("note PRRT_a: after the migration")).toBeNull();
    expect(parse("note PRRT_a: after the migration", "thread")).toBeNull();
    expect(parse("  \n", "thread")).toBeNull();
  });

  it("keeps a legacy park's approval free when no model recommendation exists", () => {
    const { decision: _decision, ...legacy } = item;
    const old = parseAnswerComment(legacy, comment("approve"), "thread");
    expect(old?.body).toBe("approve");
    expect(old?.choice).toBeUndefined();
  });

  it("reads a legacy framed record through the existing parser", () => {
    const legacy: ParkedItem = {
      key: item.key,
      kind: item.kind,
      at: item.at as string,
      round: 1,
      reason: item.reason,
      class: "scope",
      record:
        "## Question\n\nKeep the flag?\n\n## Options\n\n- **Keep** — Changes: Keep it. Costs: Carry it.\n- **Remove** — Changes: Delete it. Costs: Lose it.\n\n## Recommended\n\n**Keep** — because it remains useful.\n\n## Class\n\nscope\n\n## Steps for a person\n\nNone.\n\n## Already done\n\nChecked the flag.",
    };
    expect(
      parseAnswerComment(legacy, comment("approve"), "thread")?.choice,
    ).toEqual({ option: "Keep", recommended: true, form: "approve" });
    expect(
      parseAnswerComment(legacy, comment("choose Remove"), "thread")?.choice
        ?.option,
    ).toBe("Remove");
  });

  it("uses edit times and the trust guard for admission", () => {
    const before = comment(
      "answer PRRT_a: approve",
      "alice",
      "2026-11-10T09:00:00Z",
    );
    expect(parseAnswerComment(item, before, "conversation")).toBeNull();
    expect(
      parseAnswerComment(
        item,
        { ...before, editedAt: "2026-11-10T12:00:00Z" },
        "conversation",
      )?.at,
    ).toBe("2026-11-10T12:00:00Z");
    expect(
      parseAnswerComment(item, { ...before, editedAt: "bad" }, "conversation"),
    ).toBeNull();
    expect(
      parseAnswerComment(
        item,
        { ...comment("approve"), association: "CONTRIBUTOR" },
        "thread",
      ),
    ).toBeNull();
    expect(
      parse("answer PRRT_a: approve\n<!-- drive-pr-ledger -->"),
    ).toBeNull();
  });

  it("keeps another keyed answer on a thread as part of a free answer", () => {
    const body = "answer PRRT_a: approve\nanswer other: approve";
    expect(parse(body, "thread")?.choice).toBeUndefined();
    expect(parse(body, "conversation")?.choice?.option).toBe("Keep");
    expect(
      parse("answer PRRT_a: choose Keep: safely", "conversation")?.choice,
    ).toBeUndefined();
    expect(
      parse("answer PRRT_a: approve\nnote PRRT_a: only\u202eafter")?.choice,
    ).toBeUndefined();
  });

  it("preserves colons in parked keys as well as answer text", () => {
    const colonItem = { ...item, key: "scope:release" };
    expect(
      parseAnswerComment(
        colonItem,
        comment("approve\nnote scope:release: after the migration"),
        "thread",
      )?.choice?.note,
    ).toBe("after the migration");
    expect(
      parseAnswerComment(
        colonItem,
        comment("answer scope:release: choose Keep: safely"),
        "conversation",
      )?.choice,
    ).toBeUndefined();
  });

  it("keeps standalone notes and other keyed answers structured when their text has a colon", () => {
    expect(noteWithoutAnswer(item, comment("note PRRT_a: after 10:00"))).toBe(
      "after 10:00",
    );
    expect(
      parse(
        "answer PRRT_a: approve\nanswer other: approve\nnote other: after 10:00",
      )?.choice?.option,
    ).toBe("Keep");
    expect(
      parse("answer PRRT_a: approve\nanswer scope:release: approve")?.choice
        ?.option,
    ).toBe("Keep");
    expect(
      parse(
        "answer PRRT_a: approve\nanswer other: choose Mode: safe\nnote other: use Mode: safe",
      )?.choice?.option,
    ).toBe("Keep");
    expect(
      parse(
        "answer PRRT_a: approve\nanswer other:choose Mode: safe\nnote other:after 10:00",
      )?.choice?.option,
    ).toBe("Keep");
    expect(
      parse(
        "answer PRRT_a: approve\nnote other: use Mode: safe\nanswer other: choose Mode: safe",
      )?.choice?.option,
    ).toBe("Keep");
  });

  it("keeps duplicate companion answers and notes free for every keyed reader", () => {
    for (const body of [
      "answer PRRT_a: approve\nanswer other: approve\nanswer other: choose Keep",
      "answer PRRT_a: approve\nanswer other: approve\nnote other: first\nnote other: second",
    ]) {
      expect(parse(body)?.choice).toBeUndefined();
    }
  });

  it("keeps unambiguous colon-bearing companion keys distinct", () => {
    expect(
      parse(
        "answer PRRT_a: approve\nanswer scope:one: approve\nanswer scope:two: approve",
      )?.choice?.option,
    ).toBe("Keep");
    expect(
      parse(
        "answer PRRT_a: approve\nanswer scope:one: approve\nnote scope:two: wait",
      )?.choice,
    ).toBeUndefined();
  });

  it("keeps ambiguous compact companion keys free without quadratic scanning", () => {
    expect(
      parse(
        "answer PRRT_a: approve\nanswer other:approve\nnote other:after10:00",
      )?.choice,
    ).toBeUndefined();
    expect(
      parse(
        "answer PRRT_a: approve\nanswer other:approve\nanswer other:choose:Remove",
      )?.choice,
    ).toBeUndefined();
    expect(
      parse(`answer PRRT_a: approve\nanswer other:${":".repeat(30_000)}x`)
        ?.choice,
    ).toBeUndefined();
  });

  it("matches only the public decision when stripping a notification quote", () => {
    const d = structuredClone(decision);
    const first = d.call.options[0];
    if (first === undefined) throw new Error("fixture option missing");
    first.summary = "Notify alice@example.test";
    const raw = "- **Keep** — Changes: Notify <redacted> Costs: Carry the flag";
    const body = `> ${raw}\nanswer PRRT_a: approve`;
    expect(
      parseAnswerComment(
        { ...item, decision: d },
        comment(body),
        "conversation",
      )?.choice?.option,
    ).toBe("Keep");
    expect(
      parseAnswerComment(
        { ...item, decision: d },
        comment(body.replace("<redacted>", "alice@example.test")),
        "conversation",
      )?.choice,
    ).toBeUndefined();
    const sensitive = { ...item, reason: "Notify alice@example.test?" };
    expect(
      parseAnswerComment(
        sensitive,
        comment("> Notify alice@example.test?\nanswer PRRT_a: approve"),
        "conversation",
      )?.choice,
    ).toBeUndefined();
    expect(
      parseAnswerComment(
        sensitive,
        comment("> Notify <redacted>?\nanswer PRRT_a: approve"),
        "conversation",
      )?.choice?.option,
    ).toBe("Keep");
  });
});

describe("the latest answer of each person", () => {
  const answer = (body: string, author: string, at: string) => {
    const found = parseAnswerComment(item, comment(body, author, at), "thread");
    if (found === null) throw new Error("fixture answer missing");
    return found;
  };
  it("replaces an approval with the same person's latest free answer", () => {
    const early = answer("approve", "Alice", "2026-11-10T11:00:00Z");
    const late = answer("wait, don't", "alice", "2026-11-10T12:00:00Z");
    expect(latestAnswers([late, early])).toEqual([late]);
  });
  it("requires the same option and identical note across structured answers; all free answers still count", () => {
    const yes = answer("approve", "alice", "2026-11-10T11:00:00Z");
    const same = answer("choose Keep", "bob", "2026-11-10T11:00:00Z");
    expect(disputedAnswers([yes, same])).toBe(false);
    expect(
      disputedAnswers([yes, answer("choose Don't release", "bob", same.at)]),
    ).toBe(true);
    expect(disputedAnswers([yes, answer("not yet", "bob", same.at)])).toBe(
      true,
    );
    expect(
      disputedAnswers([
        answer("not yet", "alice", yes.at),
        answer("go ahead", "bob", same.at),
      ]),
    ).toBe(false);
    const noted = parseAnswerComment(
      item,
      comment(
        "answer PRRT_a: approve\nnote PRRT_a: after the migration",
        "bob",
      ),
      "conversation",
    );
    if (noted === null) throw new Error("fixture note missing");
    expect(disputedAnswers([yes, noted])).toBe(true);
  });
});
