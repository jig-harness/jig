import { describe, expect, it } from "bun:test";
import type { ParkedItem } from "../scripts/lib/state/schema.ts";
import { parkAnswers } from "../scripts/lib/driver/rearm.ts";
import { humanVerdictNotice } from "../scripts/lib/driver/human-answer-notice.ts";
import { redactStrings } from "../../../shared/redact.ts";
import { renderParkedDecision } from "../../../shared/decisions/park.ts";

const item: ParkedItem = {
  key: "PRRT_a",
  kind: "thread",
  reason: "Keep it?",
  round: 1,
  at: "2026-11-10T10:00:00Z",
  decision: {
    schema: "parked-decision/v1",
    class: "scope",
    call: {
      id: "a",
      question: "Keep it?",
      recommended: "a",
      why: "The flag remains useful",
      options: [
        {
          id: "a",
          name: "Keep",
          summary: "Notify alice@example.test",
          pay: ["Carry it"],
        },
        { id: "b", name: "Remove", summary: "Delete it", pay: ["Lose it"] },
      ],
    },
    steps: [],
    alreadyDone: "Checked the flag",
  },
};
const comment = (
  body: string,
  author = "alice",
  at = "2026-11-10T11:00:00Z",
) => ({
  author,
  association: "OWNER",
  at,
  url: `https://example.test/${author}`,
  body,
});
const conversation = (
  body: string,
  author = "alice",
  at = "2026-11-10T11:00:00Z",
  updated_at?: string,
) => ({
  user: { login: author },
  author_association: "OWNER",
  created_at: at,
  ...(updated_at === undefined ? {} : { updated_at }),
  html_url: `https://example.test/${author}`,
  body,
});

describe("one park interpretation for local state and the published ledger", () => {
  it("keeps old unsafe option names free on both sides of ledger redaction", async () => {
    const unsafe = structuredClone(item);
    if (unsafe.decision === undefined)
      throw new Error("fixture decision missing");
    const first = unsafe.decision.call.options[0];
    if (first === undefined) throw new Error("fixture option missing");
    first.name = "Notify alice@example.test";
    for (const framing of [unsafe, redactStrings(unsafe)]) {
      for (const text of [
        "approve",
        "choose Notify alice@example.test",
        "choose Notify <redacted>",
      ]) {
        const result = await parkAnswers(
          12,
          [framing],
          "example/repo",
          [conversation(`answer PRRT_a: ${text}`)],
          { threadComments: async () => [] },
        );
        if ("unreadable" in result) throw new Error("fixture unreadable");
        expect(result.answered[0]?.answers[0]?.choice).toBeUndefined();
      }
    }
    first.name = "KEEP";
    const second = unsafe.decision.call.options[1];
    if (second === undefined) throw new Error("fixture option missing");
    second.name = "Keep.";
    const result = await parkAnswers(
      12,
      [unsafe],
      "example/repo",
      [conversation("answer PRRT_a: approve")],
      { threadComments: async () => [] },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    expect(result.answered[0]?.answers[0]?.choice).toBeUndefined();
  });

  it("retains a legacy framed decision's changes and costs after interpreting approval", async () => {
    if (item.decision === undefined)
      throw new Error("fixture decision missing");
    const { decision, ...rest } = item;
    const legacy: ParkedItem = {
      ...rest,
      class: decision.class,
      record: renderParkedDecision(decision),
    };
    const result = await parkAnswers(
      12,
      [legacy],
      "example/repo",
      [conversation("answer PRRT_a: approve")],
      { threadComments: async () => [] },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    expect(result.answered[0]?.answers[0]?.choice?.option).toBe("Keep");
    expect(result.answered[0]?.decision?.call.options[0]).toMatchObject({
      name: "Keep",
      summary: "Notify alice@example.test",
      pay: ["Carry it"],
    });
  });

  it("retains a selected decision for the pass and uses edits to select the person's last word", async () => {
    const result = await parkAnswers(
      12,
      [item],
      "example/repo",
      [
        conversation(
          "answer PRRT_a: approve",
          "alice",
          "2026-11-10T09:00:00Z",
          "2026-11-10T13:00:00Z",
        ),
      ],
      {
        threadComments: async () => [
          comment("choose Remove", "ALICE", "2026-11-10T12:00:00Z"),
        ],
      },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    expect(result.answered[0]).toMatchObject({
      key: item.key,
      decision: item.decision,
      answers: [
        {
          author: "alice",
          at: "2026-11-10T13:00:00Z",
          choice: { option: "Keep", form: "approve", recommended: true },
          bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
    const notice = humanVerdictNotice(result.answered, "/kept/answers.json");
    expect(notice).toContain("@alice chose **Keep** (the recommended option)");
    expect(notice).toContain("Notify alice@example.test");
  });

  it("requires every source even when the readable half contains an answer", async () => {
    const result = await parkAnswers(
      12,
      [item],
      "example/repo",
      [conversation("answer PRRT_a: approve")],
      { threadComments: async () => null },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    expect(result.answered).toEqual([]);
    expect(result.waiting).toEqual([item]);
    expect(result.unread).toEqual([item]);
    expect(result.responded).toEqual([item]);
  });

  it("leaves disagreements waiting and agrees across raw and redacted decisions", async () => {
    const listing = [
      conversation(
        "> - **Keep** — Changes: Notify <redacted> Costs: Carry it\nanswer PRRT_a: approve",
      ),
    ];
    const read = async (park: ParkedItem) =>
      parkAnswers(12, [park], "example/repo", listing, {
        threadComments: async () => [comment("wait, don't", "bob")],
      });
    const local = await read(item);
    const published = await read(redactStrings(item));
    for (const result of [local, published]) {
      if ("unreadable" in result) throw new Error("fixture unreadable");
      expect(result.answered).toEqual([]);
      expect(result.waiting.map((p) => p.key)).toEqual([item.key]);
      expect(result.responded.map((p) => p.key)).toEqual([item.key]);
      expect(result.disputed[0]?.answers.map((a) => a.choice?.option)).toEqual([
        "Keep",
        undefined,
      ]);
    }
  });

  it("keeps notes without answers visible while waiting for a decision", async () => {
    const result = await parkAnswers(
      12,
      [item],
      "example/repo",
      [conversation("note PRRT_a: only after the migration")],
      { threadComments: async () => [] },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    expect(result.answered).toEqual([]);
    expect(result.responded).toEqual([]);
    expect(result.notes).toMatchObject([
      { author: "alice", note: "only after the migration" },
    ]);
  });

  it("never clips a chosen name or note while cutting large decisions", async () => {
    const huge = structuredClone(item);
    if (huge.decision === undefined)
      throw new Error("fixture decision missing");
    huge.decision.alreadyDone = "checked ".repeat(3000);
    const note = "after the migration ".repeat(20).trim();
    const result = await parkAnswers(
      12,
      [huge],
      "example/repo",
      [conversation(`answer PRRT_a: approve\nnote PRRT_a: ${note}`)],
      { threadComments: async () => [] },
    );
    if ("unreadable" in result) throw new Error("fixture unreadable");
    const notice = humanVerdictNotice(result.answered, "/kept/answers.json");
    expect(notice).toContain("@alice chose **Keep**");
    expect(notice).toContain(note);
    expect(notice).toContain("/kept/answers.json");
    expect(notice).toContain("cut; read the rest");
    expect(notice.length).toBeLessThanOrEqual(15_000);
  });
});
