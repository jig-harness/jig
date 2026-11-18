import { afterAll, describe, expect, test } from "bun:test";
import { compareWithBase } from "../base.ts";
import {
  type Chapter,
  type DataFile,
  type DataValue,
  dataOf,
  type FieldComparison,
  type FieldSpec,
} from "../chapter.ts";
import { CHAPTERS } from "../chapters.ts";
import { generate } from "../generate.ts";
import {
  cleanUp,
  FIELDS,
  fixtureChapter,
  layout,
  ok,
  tempDir,
} from "./fixture.ts";

afterAll(cleanUp);

const textField = (comparedAs?: FieldComparison): FieldSpec => ({
  type: "string",
  nullable: true,
  required: true,
  identifies: false,
  ...(comparedAs === undefined ? {} : { comparedAs }),
  description: "A field under test.",
});

const ALPHA = { name: "ALPHA", code: 1, meaning: "the first thing happened" };

/** A one-value chapter whose `extra` field is declared as `comparedAs`. */
function chapterWith(
  extra: string | null,
  comparedAs?: FieldComparison,
  more: Partial<Parameters<typeof fixtureChapter>[0]> = {},
): Chapter {
  return fixtureChapter({
    fields: { ...FIELDS, extra: textField(comparedAs) },
    values: [{ ...ALPHA, extra }],
    ...more,
  });
}

/** What the comparison finds in `now` against `base`, as data files. */
function compare(
  base: DataFile,
  now: DataFile,
  breaking: readonly string[] = [],
): string[] {
  return compareWithBase({
    base: new Map([[base.chapter, base]]),
    chapters: [],
    data: new Map([[now.chapter, now]]),
    withdrawn: [],
    breaking,
  }).map((f) => f.problem);
}

const changed = (from: string | null, to: string | null) =>
  `the value name "ALPHA", code 1 changed its extra from ${JSON.stringify(from)} to ${JSON.stringify(to)}`;

/** The findings of moving `extra` from `was` to `is`, under one declaration. */
const problems = (
  was: string | null,
  is: string | null,
  comparedAs?: FieldComparison,
) =>
  compare(
    dataOf(chapterWith(was, comparedAs)),
    dataOf(chapterWith(is, comparedAs)),
  );

describe("what a data file publishes about a field", () => {
  test("every field states its comparison: meaning is prose, an undeclared field exact", () => {
    const { fields } = dataOf(chapterWith("x", "names"));
    expect(fields.meaning?.comparedAs).toBe("prose");
    expect(fields.name?.comparedAs).toBe("exact");
    expect(fields.code?.comparedAs).toBe("exact");
    expect(fields.extra?.comparedAs).toBe("names");
  });

  test("the stable chapters declare their prose and their lists", () => {
    const declared = (id: string) => {
      const chapter = CHAPTERS.find((c) => c.id === id) as Chapter;
      const { fields } = dataOf(chapter);
      return Object.fromEntries(
        Object.entries(fields)
          .filter(([n, s]) => n !== "meaning" && s.comparedAs !== "exact")
          .map(([n, s]) => [n, s.comparedAs]),
      );
    };
    expect(declared("repo-commands")).toEqual({
      runBy: "names",
      given: "prose",
      answers: "prose",
    });
    expect(declared("pr-labels")).toEqual({ writers: "names" });
    expect(declared("mailbox")).toEqual({ carriedBy: "carriers" });
    expect(declared("followup-claim")).toEqual({ carriedBy: "carriers" });
    expect(declared("rule-matchers")).toEqual({
      compared: "prose",
      facts: "names",
      readBy: "names",
    });
    expect(declared("drive-exits")).toEqual({
      stop: "prose",
      nextStep: "prose",
    });
    expect(declared("comment-markers")).toEqual({});
  });
});

describe("a field compared exactly", () => {
  test("is the default, and any change to it is a break", () => {
    expect(problems("a", "b")).toEqual([changed("a", "b")]);
  });

  test("reads a list in another order as a change", () => {
    expect(problems("a, b", "b, a", "exact")).toEqual([
      changed("a, b", "b, a"),
    ]);
  });
});

describe("a prose field", () => {
  test("may be reworded", () => {
    expect(problems("one wording", "another wording", "prose")).toEqual([]);
  });

  test("may not be emptied, which takes away what a reader was told", () => {
    expect(problems("words", null, "prose")).toEqual([changed("words", null)]);
    expect(problems("words", "  ", "prose")).toEqual([changed("words", "  ")]);
  });

  test("may not appear on a value that had none", () => {
    expect(problems(null, "words", "prose")).toEqual([changed(null, "words")]);
  });

  test("keeps a null null, and an empty text from becoming one, in both directions", () => {
    expect(problems(null, "", "prose")).toEqual([changed(null, "")]);
    expect(problems(null, "  ", "prose")).toEqual([changed(null, "  ")]);
    expect(problems("", null, "prose")).toEqual([changed("", null)]);
    expect(problems("  ", null, "prose")).toEqual([changed("  ", null)]);
  });

  test("keeps a reworded meaning passing, and a meaning another value holds failing", () => {
    const two = (second: string) =>
      dataOf(
        fixtureChapter({
          values: [ALPHA, { name: "BETA", code: 2, meaning: second }],
        }),
      );
    expect(compare(two("the second"), two("the second, reworded"))).toEqual([]);
    expect(compare(two("the second"), two(ALPHA.meaning))).toEqual([
      'the value name "BETA", code 2 now carries the meaning the base gives name "ALPHA", code 1',
    ]);
  });
});

describe("a field listing names", () => {
  test("may gain a name, in any order", () => {
    expect(problems("drive, tick", "tick, followup, drive", "names")).toEqual(
      [],
    );
  });

  test("may not lose one", () => {
    expect(problems("drive, tick", "tick", "names")).toEqual([
      changed("drive, tick", "tick"),
    ]);
    expect(problems("drive", "", "names")).toEqual([changed("drive", "")]);
  });

  test("may not start or stop being listed", () => {
    expect(problems("drive", null, "names")).toEqual([changed("drive", null)]);
    expect(problems(null, "drive", "names")).toEqual([changed(null, "drive")]);
  });
});

describe("a field listing what carries a value", () => {
  test("is read by its declaration, whatever its name", () => {
    expect(
      problems(
        "tick (always)",
        "manual (sometimes), tick (always)",
        "carriers",
      ),
    ).toEqual([]);
    expect(problems("tick (always)", "tick (sometimes)", "carriers")).toEqual([
      changed("tick (always)", "tick (sometimes)"),
    ]);
  });

  /** The chapter with ALPHA's carriers, and a new value BETA carried as `beta` says. */
  const withNew = (alpha: string, beta: string, how: FieldComparison) =>
    dataOf(
      fixtureChapter({
        fields: { ...FIELDS, extra: textField(how) },
        values: [
          { ...ALPHA, extra: alpha },
          { name: "BETA", code: 2, meaning: "new", extra: beta },
        ],
      }),
    );
  const REQUIRED =
    'the new value name "BETA", code 2 is required of every writer';

  test("makes a new value a known carrier always holds a break", () => {
    const base = dataOf(chapterWith("tick (sometimes)", "carriers"));
    expect(
      compare(base, withNew("tick (sometimes)", "tick (always)", "carriers")),
    ).toEqual([REQUIRED]);
  });

  test("refuses declaring the field exact, which would drop that break from the next baseline", () => {
    const base = dataOf(chapterWith("tick (sometimes)", "carriers"));
    expect(
      compare(base, withNew("tick (sometimes)", "tick (always)", "exact")),
    ).toContain(
      "the field extra is now compared as exact, and the base compares it as carriers",
    );
  });

  test("keeps the break on a baseline that already holds the field as carriers", () => {
    const base = withNew("tick (sometimes)", "tick (sometimes)", "carriers");
    expect(
      compare(
        base,
        dataOf(
          fixtureChapter({
            fields: { ...FIELDS, extra: textField("carriers") },
            values: [
              { ...ALPHA, extra: "tick (sometimes)" },
              {
                name: "BETA",
                code: 2,
                meaning: "new",
                extra: "tick (sometimes)",
              },
              {
                name: "GAMMA",
                code: 3,
                meaning: "newer",
                extra: "tick (always)",
              },
            ],
          }),
        ),
      ),
    ).toEqual([
      'the new value name "GAMMA", code 3 is required of every writer',
    ]);
  });

  test("does not take a carrier for new because no row names it, when a value of the base is identified by it", () => {
    const base = dataOf(
      fixtureChapter({
        fields: { ...FIELDS, extra: textField("carriers") },
        values: [
          { ...ALPHA, extra: "note (always)" },
          {
            name: "tick",
            code: 2,
            meaning: "a kind with no field rows",
            extra: null,
          },
        ],
      }),
    );
    const now = dataOf(
      fixtureChapter({
        fields: { ...FIELDS, extra: textField("carriers") },
        values: [
          { ...ALPHA, extra: "note (always)" },
          {
            name: "tick",
            code: 2,
            meaning: "a kind with no field rows",
            extra: null,
          },
          { name: "BETA", code: 3, meaning: "new", extra: "tick (always)" },
        ],
      }),
    );
    expect(compare(base, now)).toEqual([
      'the new value name "BETA", code 3 is required of every writer',
    ]);
  });

  test("reads carriers it cannot parse on a new value as a break", () => {
    const base = dataOf(chapterWith("tick (sometimes)", "carriers"));
    expect(
      compare(base, withNew("tick (sometimes)", "tick(always)", "carriers")),
    ).toEqual([REQUIRED]);
  });

  test("lets a carrier no value names yet join as always, on a listed value and a new one", () => {
    const base = dataOf(chapterWith("note (always)", "carriers"));
    expect(
      compare(
        base,
        withNew(
          "note (always), question (always)",
          "question (always)",
          "carriers",
        ),
      ),
    ).toEqual([]);
  });

  test("refuses a known carrier joining a listed value as always", () => {
    const two = (alpha: string) =>
      withNew(alpha, "manual (sometimes)", "carriers");
    expect(
      compare(two("tick (always)"), two("tick (always), manual (always)")),
    ).toEqual([changed("tick (always)", "tick (always), manual (always)")]);
  });

  test("a field merely named carriedBy is compared exactly", () => {
    const chapter = (carriedBy: string) =>
      dataOf(
        fixtureChapter({
          fields: { ...FIELDS, carriedBy: textField() },
          values: [{ ...ALPHA, carriedBy }],
        }),
      );
    expect(
      compare(
        chapter("tick (always)"),
        chapter("tick (always), manual (sometimes)"),
      ),
    ).toHaveLength(1);
  });
});

describe("the declaration the comparison holds", () => {
  test("is the base's: marking a field prose does not excuse rewording it in the same change", () => {
    const found = compare(
      dataOf(chapterWith("one wording")),
      dataOf(chapterWith("another wording", "prose")),
    );
    expect(found).toContain(changed("one wording", "another wording"));
  });

  test("may not be loosened within a version", () => {
    const loosened = (from: FieldComparison, to: FieldComparison) =>
      compare(dataOf(chapterWith("a", from)), dataOf(chapterWith("a", to)));
    const finding = (from: FieldComparison, to: FieldComparison) =>
      `the field extra is now compared as ${to}, and the base compares it as ${from}`;
    expect(loosened("exact", "prose")).toEqual([finding("exact", "prose")]);
    expect(loosened("exact", "names")).toEqual([finding("exact", "names")]);
    expect(loosened("names", "prose")).toEqual([finding("names", "prose")]);
  });

  test("may be tightened to exact", () => {
    expect(
      compare(
        dataOf(chapterWith("a", "prose")),
        dataOf(chapterWith("a", "exact")),
      ),
    ).toEqual([]);
  });

  test("may be loosened with the version raised and a breaking note", () => {
    const base = dataOf(chapterWith("a"));
    const now = dataOf(chapterWith("a", "prose", { version: 2 }));
    expect(compare(base, now, ["**Breaking:** fixture.md changed."])).toEqual(
      [],
    );
  });

  test("is the one made now, for a base written before fields declared one", () => {
    const declared = dataOf(chapterWith("one wording"));
    const undeclared: DataFile = {
      ...declared,
      fields: Object.fromEntries(
        Object.entries(declared.fields).map(([name, spec]) => {
          const { comparedAs: _dropped, ...rest } = spec;
          return [name, rest];
        }),
      ),
    };
    expect(
      compare(undeclared, dataOf(chapterWith("another wording", "prose"))),
    ).toEqual([]);
    expect(compare(undeclared, dataOf(chapterWith("another wording")))).toEqual(
      [changed("one wording", "another wording")],
    );
  });
});

describe("a declaration the generator refuses", () => {
  const generated = (
    fields: Readonly<Record<string, FieldSpec>>,
    extra: string | number = 1,
  ) => {
    const chapter = fixtureChapter({
      fields,
      values: [{ ...ALPHA, extra } as DataValue],
    });
    const root = tempDir("comparison");
    ok(root, "init", "-q");
    layout(root, [chapter]);
    return generate({ root, chapters: [chapter], check: false }).findings.map(
      (f) => f.problem,
    );
  };

  test("a loose comparison on a field that holds no text", () => {
    expect(
      generated({
        ...FIELDS,
        extra: { ...textField("prose"), type: "integer" },
      }),
    ).toEqual([
      "the field extra is compared as prose, which only a string field can be",
    ]);
  });

  test("a carriers value that is not written as carriers", () => {
    expect(
      generated({ ...FIELDS, extra: textField("carriers") }, "tick,manual"),
    ).toEqual([
      'ALPHA\'s extra is "tick,manual", which is not a list of carriers, each with (always) or (sometimes)',
    ]);
  });

  test("a loose comparison on a field that identifies a value", () => {
    expect(
      generated({
        ...FIELDS,
        extra: {
          ...textField("names"),
          type: "integer",
          nullable: false,
          identifies: true,
        },
      }),
    ).toContain(
      "the field extra identifies a value, so it can only be compared as exact",
    );
  });
});
