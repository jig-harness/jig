/**
 * A decision as a card numbers it and commits it: the recommended option is
 * 1 on every card, a pick under a class not listed as Decide or of an option
 * that cannot be undone takes two steps, and a pick reaches the comment as
 * `approve` or `choose <option>` with the framing's digest, never as its
 * number.
 */
import { describe, expect, it } from "bun:test";
import {
  cardAnswerLines,
  cardComment,
  choiceInLine,
  isGuardedPick,
  numberOptions,
  answerStateWords,
  answerView,
  optionNumbers,
} from "../decision-card.ts";

const opt = (name: string, recommended = false) => ({ name, recommended });

describe("numberOptions", () => {
  it("numbers the recommended option 1 and the rest in the decision's order", () => {
    const numbered = numberOptions([
      opt("Remove"),
      opt("Rename"),
      opt("Keep", true),
    ]);
    expect(numbered.map((n) => [n.number, n.option.name])).toEqual([
      [1, "Keep"],
      [2, "Remove"],
      [3, "Rename"],
    ]);
  });

  it("keeps the decision's order when it recommends no single option", () => {
    expect(
      numberOptions([opt("A"), opt("B")]).map((n) => n.option.name),
    ).toEqual(["A", "B"]);
    expect(
      numberOptions([opt("A", true), opt("B", true), opt("C")]).map(
        (n) => n.option.name,
      ),
    ).toEqual(["A", "B", "C"]);
  });

  it("numbers nothing for a decision with no options", () => {
    expect(numberOptions([])).toEqual([]);
  });
});

describe("isGuardedPick", () => {
  it("takes one step for a class the acts table lists as Decide", () => {
    expect(isGuardedPick("scope", {})).toBe(false);
    expect(isGuardedPick("scope", { reversible: true })).toBe(false);
  });

  it("guards an Authorize class, a class the table does not list, and no class", () => {
    expect(isGuardedPick("destructive", {})).toBe(true);
    expect(isGuardedPick("our-own-class", {})).toBe(true);
    expect(isGuardedPick(null, {})).toBe(true);
    expect(isGuardedPick("constructor", {})).toBe(true);
  });

  it("guards an option marked as one that cannot be undone, whatever its class", () => {
    expect(isGuardedPick("scope", { reversible: false })).toBe(true);
  });
});

describe("the lines a card writes", () => {
  it("writes the recommended option as approve, with the digest", () => {
    expect(
      cardAnswerLines(
        "PRRT_a",
        { kind: "pick", option: "Keep", recommended: true },
        "3fa9c2d1e0b4",
      ),
    ).toEqual(["answer PRRT_a: approve [3fa9c2d1e0b4]"]);
  });

  it("writes another option by its name, and a note on its own line", () => {
    expect(
      cardAnswerLines(
        "PRRT_a",
        {
          kind: "pick",
          option: "Remove",
          recommended: false,
          note: " only after the migration merges ",
        },
        "3fa9c2d1e0b4",
      ),
    ).toEqual([
      "answer PRRT_a: choose Remove [3fa9c2d1e0b4]",
      "note PRRT_a: only after the migration merges",
    ]);
  });

  it("leaves out a blank note, and the digest of a park from before digests", () => {
    expect(
      cardAnswerLines(
        "PRRT_a",
        { kind: "pick", option: "Remove", recommended: false, note: "  " },
        undefined,
      ),
    ).toEqual(["answer PRRT_a: choose Remove"]);
  });

  it("writes a person's own words with the digest after them", () => {
    expect(
      cardAnswerLines(
        "PRRT_a",
        { kind: "free", text: "neither, ask the owner " },
        "3fa9c2d1e0b4",
      ),
    ).toEqual(["answer PRRT_a: neither, ask the owner [3fa9c2d1e0b4]"]);
  });

  it("joins a card's decisions into one comment, a blank line between them", () => {
    expect(
      cardComment([
        {
          key: "PRRT_a",
          digest: "3fa9c2d1e0b4",
          answer: {
            kind: "pick",
            option: "Keep",
            recommended: true,
            note: "for one release",
          },
        },
        {
          key: "PRRT_b",
          digest: "0123456789ab",
          answer: { kind: "pick", option: "Drop", recommended: false },
        },
      ]),
    ).toBe(
      "answer PRRT_a: approve [3fa9c2d1e0b4]\nnote PRRT_a: for one release\n\nanswer PRRT_b: choose Drop [0123456789ab]",
    );
  });
});

describe("choiceInLine", () => {
  const keep = opt("Keep", true);
  const remove = opt("Remove");
  const options = [keep, remove];
  const rec = (o: { recommended: boolean }) => o.recommended;

  it("reads approve and choose as the drive's readers do, with the digest taken off first", () => {
    expect(choiceInLine("Approve. [3fa9c2d1e0b4]", options, rec)).toEqual({
      option: keep,
      form: "approve",
    });
    expect(choiceInLine("choose `remove`", options, rec)).toEqual({
      option: remove,
      form: "choose",
    });
  });

  it("reads anything else as free", () => {
    expect(choiceInLine("approve, but later", options, rec)).toBeNull();
    expect(choiceInLine("choose Rename", options, rec)).toBeNull();
    expect(
      choiceInLine("approve", [opt("A", true), opt("B", true)], rec),
    ).toBeNull();
  });
});

const at = "2026-11-10T10:00:00Z";

describe("optionNumbers", () => {
  it("numbers the recommended option 1 and the rest in the decision's order, keeping that order", () => {
    const got = optionNumbers([
      { name: "Drop", recommended: false },
      { name: "Keep", recommended: true },
      { name: "Rename", recommended: false },
    ]);
    expect(got.map((o) => [o.name, o.number])).toEqual([
      ["Drop", 2],
      ["Keep", 1],
      ["Rename", 3],
    ]);
  });
});

describe("answerView", () => {
  it("reads a choice with its note, a free answer and a stale one", () => {
    expect(
      answerView({
        author: "ana",
        at,
        url: "u",
        digest: "3fa9c2d1e0b4",
        choice: {
          option: "Keep",
          recommended: true,
          form: "approve",
          note: "after the migration",
        },
      }),
    ).toEqual({
      author: "ana",
      at,
      url: "u",
      choice: { option: "Keep", recommended: true, form: "approve" },
      note: "after the migration",
    });
    expect(answerView({ author: "bo", at, url: "u" }).free).toBe(true);
    expect(
      answerView({
        author: "cy",
        at,
        url: "u",
        digest: "000000000000",
        stale: true,
      }).stale,
    ).toEqual({ digest: "000000000000" });
  });

  it("says why answers keep a decision waiting", () => {
    const views = [
      answerView({ author: "bo", at, url: "u" }),
      answerView({
        author: "cy",
        at,
        url: "u",
        digest: "000000000000",
        stale: true,
      }),
    ];
    expect(answerStateWords("stale", views)).toBe(
      "Stale, so it waits for an answer to the current framing: @bo wrote a free answer; @cy answered an earlier framing (000000000000), a stale answer.",
    );
    expect(answerStateWords(undefined, [])).toBeNull();
  });
});
