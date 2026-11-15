import { describe, expect, test } from "bun:test";
import { s } from "../../../plugin/shared/shapes.ts";
import { compareWithBase } from "../base.ts";
import { dataOf } from "../chapter.ts";
import { schemaChanges } from "../schema-compatibility.ts";
import { fixtureChapter } from "./fixture.ts";
import {
  expectSchemaAccepts,
  expectSchemaRejects,
} from "./schema-validator.ts";

const baseShape = s.object({
  name: s.string(),
  count: s.optional(s.integer()),
});

function compare(
  shape: typeof baseShape | null,
  version = 1,
  breaking: string[] = [],
) {
  const before = {
    ...fixtureChapter(),
    schemas: [{ name: "record", shape: baseShape }],
  };
  const after = {
    ...fixtureChapter({ version }),
    schemas: shape ? [{ name: "record", shape }] : [],
  };
  return compareWithBase({
    base: new Map([[before.id, dataOf(before)]]),
    chapters: [after],
    data: new Map([[after.id, dataOf(after)]]),
    withdrawn: [],
    breaking,
  });
}

describe("stable schema compatibility", () => {
  test("the chapter base gate rejects schema removal", () => {
    expect(
      compare(null).some((f) => /schema record.*gone/.test(f.problem)),
    ).toBe(true);
  });

  test("a break needs a version raise and the chapter's breaking note", () => {
    expect(compare(null, 2)).not.toEqual([]);
    expect(compare(null, 2, ["**Breaking:** fixture.md changed"])).toEqual([]);
    expect(compare(null, 1, ["**Breaking:** fixture.md changed"])).not.toEqual(
      [],
    );
  });

  test("field removal, retyping and new requirements fail", () => {
    for (const shape of [
      s.object({ name: s.string() }),
      s.object({ name: s.integer(), count: s.optional(s.integer()) }),
      s.object({ name: s.string(), count: s.integer() }),
      s.object({
        name: s.string(),
        count: s.optional(s.integer()),
        added: s.boolean(),
      }),
    ])
      expect(
        schemaChanges(baseShape.schema, shape.schema).length,
      ).toBeGreaterThan(0);
  });

  test("optional additions and wider constraints pass", () => {
    expect(
      schemaChanges(
        s.object(
          { name: s.string(), count: s.optional(s.integer()) },
          { additionalProperties: false },
        ).schema,
        s.object({
          name: s.string(),
          count: s.optional(s.integer()),
          added: s.optional(s.boolean()),
        }).schema,
      ),
    ).toEqual([]);
    expect(
      schemaChanges(
        s.string({ minLength: 2, maxLength: 8 }).schema,
        s.string({ minLength: 1, maxLength: 9 }).schema,
      ),
    ).toEqual([]);
    expect(
      schemaChanges(s.enum(["one"]).schema, s.enum(["one", "two"]).schema),
    ).toEqual([]);
  });

  test("typed optional additions narrow previously unrestricted extra fields", () => {
    const after = s.object({
      name: s.string(),
      count: s.optional(s.integer()),
      extra: s.optional(s.boolean()),
    });
    const existingRecord = { name: "example", extra: 123 };
    expectSchemaAccepts(baseShape.schema, existingRecord);
    expectSchemaRejects(after.schema, existingRecord);
    expect(
      schemaChanges(baseShape.schema, after.schema).some((p) =>
        p.includes("extra"),
      ),
    ).toBe(true);
    expect(
      schemaChanges(
        baseShape.schema,
        s.object({
          name: s.string(),
          count: s.optional(s.integer()),
          extra: s.optional(s.unknown()),
        }).schema,
      ),
    ).toEqual([]);
  });

  test("alternative removal or narrowing fails, additive alternatives pass", () => {
    const one = s.object({ kind: s.literal("one"), value: s.string() });
    const two = s.object({ kind: s.literal("two"), value: s.integer() });
    const before = s.union([one, two]).schema;
    expect(schemaChanges(before, s.union([one]).schema).length).toBeGreaterThan(
      0,
    );
    expect(
      schemaChanges(
        before,
        s.union([
          one,
          s.object({
            kind: s.literal("two"),
            value: s.integer({ minimum: 10 }),
          }),
        ]).schema,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      schemaChanges(before, s.union([two, one, s.literal(null)]).schema),
    ).toEqual([]);
  });

  test("nested arrays and intersections retain their fields", () => {
    expect(
      schemaChanges(s.array(baseShape).schema, s.array(s.object({})).schema)
        .length,
    ).toBeGreaterThan(0);
    const before = s.intersection(baseShape, s.object({ flag: s.boolean() }));
    expect(
      schemaChanges(
        before.schema,
        s.intersection(baseShape, s.object({})).schema,
      ).length,
    ).toBeGreaterThan(0);
  });
});
