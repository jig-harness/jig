/** The one reading of a park's options and answers every surface shows. */
import { describe, expect, it } from "bun:test";
import {
  answerStateWords,
  answerView,
  optionNumbers,
} from "../decision-card.ts";

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
