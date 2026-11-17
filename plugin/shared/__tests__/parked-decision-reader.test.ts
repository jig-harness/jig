/**
 * What the readers of a parked decision accept and refuse: the stored
 * reader (`isParkedDecision`), which every reader of a kept decision goes
 * through (the drive's park and its pass handoff, the dispatcher's framed
 * result), and the strict authoring check (`checkParkedDecision`), with the
 * exact problems it names. The stored reader validates against the shape
 * description the Protocol's schema is generated from
 * (`decisions/park-shape.ts`), and the strict check takes its field lists
 * from the same description; these cases pin what each accepts and refuses,
 * and how an answer's spelling normalizes.
 */
import { describe, expect, it } from "bun:test";
import { normalizeAnswerText } from "../decisions/answer-normalize.ts";
import {
  checkParkedDecision,
  isParkedDecision,
  type ParkedDecision,
} from "../decisions/park.ts";

const OPTION_A = {
  id: "a",
  name: "Keep",
  summary: "Keep it.",
  pay: ["Concern stays."],
};
const OPTION_B = {
  id: "b",
  name: "Change",
  summary: "Change it.",
  pay: ["Review again."],
};
const DECISION: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "escalated",
  call: {
    id: "a",
    question: "Keep the current value?",
    options: [OPTION_A, OPTION_B],
    recommended: "a",
    why: "Matches the current contract.",
  },
  steps: [],
  alreadyDone: "Read the contract.",
};

/** The decision with `patch` applied to its top level, its call or its first option. */
const top = (patch: Record<string, unknown>) => ({ ...DECISION, ...patch });
const call = (patch: Record<string, unknown>) =>
  top({ call: { ...DECISION.call, ...patch } });
const option = (patch: Record<string, unknown>) =>
  call({ options: [{ ...OPTION_A, ...patch }, OPTION_B] });
const without = (value: Record<string, unknown>, key: string) => {
  const { [key]: _gone, ...rest } = value;
  return rest;
};

const FULL = top({
  facts: [{ text: "The value is read twice.", source: "src/a.ts:3" }],
  interplay: [{ from: "a", to: "b", text: "Changing it needs a review." }],
  sheet: "https://example.test/sheet",
  call: {
    ...DECISION.call,
    options: [
      {
        ...OPTION_A,
        tag: "safe",
        keep: ["The value."],
        rightWhen: "Nothing else reads it.",
        obligation: "Watch the logs.",
        reversible: true,
      },
      { ...OPTION_B, keep: [], reversible: false },
    ],
  },
});

describe("the stored reader", () => {
  it("reads every form a writer writes, each optional field present or absent", () => {
    for (const value of [
      DECISION,
      FULL,
      // Fields added later are tolerated, at every level.
      top({ later: 1 }),
      call({ later: [1] }),
      option({ later: null }),
      top({ facts: [{ text: "t", source: "s", later: 1 }] }),
      // Strings are not checked for content: a stored record may be redacted.
      top({ class: "", alreadyDone: "" }),
      call({ id: "", question: "no question mark", recommended: "zz" }),
      call({ options: [] }),
      option({ id: "toolongid1", name: "", pay: [] }),
      top({ steps: ["", "a"] }),
      top({ facts: [], interplay: [] }),
      top({ sheet: "not a url" }),
      // An optional field whose value is undefined reads as absent.
      top({ sheet: undefined, facts: undefined }),
      option({ keep: undefined, reversible: undefined, tag: undefined }),
    ])
      expect(isParkedDecision(value)).toBe(true);
  });

  it("refuses each way a field can break", () => {
    const refused: unknown[] = [
      null,
      undefined,
      "parked-decision/v1",
      [],
      [DECISION],
      top({ schema: "parked-decision/v2" }),
      top({ schema: undefined }),
      without(DECISION as unknown as Record<string, unknown>, "schema"),
      without(DECISION as unknown as Record<string, unknown>, "class"),
      without(DECISION as unknown as Record<string, unknown>, "alreadyDone"),
      without(DECISION as unknown as Record<string, unknown>, "steps"),
      without(DECISION as unknown as Record<string, unknown>, "call"),
      top({ class: 1 }),
      top({ class: null }),
      top({ alreadyDone: ["a"] }),
      top({ steps: "a" }),
      top({ steps: [1] }),
      top({ steps: null }),
      top({ call: null }),
      top({ call: [] }),
      top({ call: "a" }),
      ...["id", "question", "recommended", "why", "options"].map((key) =>
        top({
          call: without(
            DECISION.call as unknown as Record<string, unknown>,
            key,
          ),
        }),
      ),
      call({ id: 1 }),
      call({ question: null }),
      call({ recommended: 1 }),
      call({ why: ["a"] }),
      call({ options: {} }),
      call({ options: [OPTION_A, null] }),
      call({ options: [OPTION_A, "b"] }),
      ...["id", "name", "summary", "pay"].map((key) =>
        call({ options: [without(OPTION_A, key), OPTION_B] }),
      ),
      option({ id: 1 }),
      option({ name: null }),
      option({ summary: 2 }),
      option({ pay: "a" }),
      option({ pay: [1] }),
      option({ keep: "a" }),
      option({ keep: [1] }),
      option({ keep: null }),
      option({ tag: 1 }),
      option({ tag: null }),
      option({ rightWhen: [] }),
      option({ obligation: false }),
      option({ reversible: "yes" }),
      option({ reversible: null }),
      top({ sheet: 1 }),
      top({ sheet: null }),
      top({ facts: "a" }),
      top({ facts: null }),
      top({ facts: [null] }),
      top({ facts: [{ text: "t" }] }),
      top({ facts: [{ text: "t", source: 1 }] }),
      top({ interplay: {} }),
      top({ interplay: [{ from: "a", to: "b" }] }),
      top({ interplay: [{ from: "a", to: 1, text: "t" }] }),
      top({ interplay: [["a", "b", "t"]] }),
    ];
    for (const value of refused) expect(isParkedDecision(value)).toBe(false);
  });
});

describe("the strict authoring check", () => {
  it("passes a decision each writer writes, every optional field present or absent", () => {
    expect(checkParkedDecision(DECISION, "escalated")).toEqual([]);
    expect(checkParkedDecision(FULL, "escalated")).toEqual([]);
  });

  it("names each problem with its path, in the order it finds them", () => {
    const cases: [unknown, string[]][] = [
      [null, ["$: must be an object"]],
      [[], ["$: must be an object"]],
      [
        {},
        [
          "$.schema: is required",
          "$.class: is required",
          "$.call: is required",
          "$.steps: is required",
          "$.alreadyDone: is required",
          "$.schema: must be parked-decision/v1",
          "$.class: must match --class",
          "$.alreadyDone: must be a non-empty string",
          "$.steps: must be an array",
          "$.call: must be an object",
        ],
      ],
      [
        top({ later: 1, other: 2 }),
        ["$.later: unknown field", "$.other: unknown field"],
      ],
      [
        top({ schema: "parked-decision/v2", class: "legal" }),
        ["$.schema: must be parked-decision/v1", "$.class: must match --class"],
      ],
      [
        top({ call: {} }),
        [
          "$.call.id: is required",
          "$.call.question: is required",
          "$.call.options: is required",
          "$.call.recommended: is required",
          "$.call.why: is required",
          "$.call[0].id: must be 1-8 letters or digits",
          "$.call.question: must be a non-empty string",
          "$.call.why: must be a non-empty string",
          "$.call.options: must be an array",
        ],
      ],
      [call({ later: 1 }), ["$.call.later: unknown field"]],
      [
        option({ later: 1, tag: "", reversible: "no" }),
        [
          "$.call.options[0].later: unknown field",
          "$.call.options[0].tag: must be a non-empty string",
          "$.call.options[0].reversible: must be a boolean",
        ],
      ],
      [
        call({ options: [{}, OPTION_B] }),
        [
          "$.call.options[0].id: must be 1-8 letters or digits",
          "$.call.options[0].id: is required",
          "$.call.options[0].name: is required",
          "$.call.options[0].summary: is required",
          "$.call.options[0].pay: is required",
          "$.call.options[0].name: must be a non-empty string",
          "$.call.options[0].summary: must be a non-empty string",
          "$.call.options[0].pay: must be an array",
          "$.call.recommended: must name an option id",
        ],
      ],
      [
        top({
          interplay: [
            { from: "a", to: "b" },
            { from: "a", to: "b", text: "t", x: 1 },
          ],
          facts: [{ text: "t" }],
          sheet: "http://example.test",
        }),
        [
          "$.facts[0].source: is required",
          "$.facts[0].source: must be a non-empty string",
          "$.sheet: must be an https URL with no spaces, parentheses or backslashes",
          "$.interplay[0].text: is required",
          "$.interplay[0].text: must be a non-empty string",
          "$.interplay[1].x: unknown field",
        ],
      ],
    ];
    for (const [value, problems] of cases)
      expect(checkParkedDecision(value, "escalated")).toEqual(problems);
  });
});

describe("an answer's spelling", () => {
  it("normalizes as it did, step by step", () => {
    const cases: [string, string][] = [
      ["ＡＰＰＲＯＶＥ！", "approve"],
      ["“Keep” — current’s", '"keep" - current\'s'],
      ["a‐b‑c‒d–e—f―g−h", "a-b-c-d-e-f-g-h"],
      ["‛x‟", "'x\""],
      ["**Choose** `Keep` __now__", "choose keep now"],
      ["  Choose\t\n Keep. ", "choose keep"],
      ["Keep..", "keep."],
      ["Keep !", "keep"],
      ["Keep ! ", "keep"],
      ["Keep?", "keep?"],
      ["", ""],
      ["   ", ""],
      [".", ""],
      ["ß ǅ ﬁ", "ß dž fi"],
    ];
    for (const [text, normalized] of cases)
      expect(normalizeAnswerText(text)).toBe(normalized);
  });
});
