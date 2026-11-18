import { describe, expect, test } from "bun:test";
import { matches, s, toJsonSchema } from "../shapes.ts";

describe("shared shape descriptions", () => {
  const shape = s.object(
    {
      kind: s.literal("message"),
      count: s.integer({ minimum: 1 }),
      note: s.optional(s.nullable(s.string({ minLength: 1 }))),
      tags: s.array(s.enum(["a", "b"] as const)),
    },
    { additionalProperties: false },
  );
  test("one description validates fields and emits their schema", () => {
    expect(matches(shape, { kind: "message", count: 1, tags: ["a"] })).toBe(
      true,
    );
    for (const value of [
      null,
      {},
      { kind: "message", count: 1.5, tags: [] },
      { kind: "message", count: 1, tags: ["c"] },
      { kind: "message", count: 1, tags: [], extra: true },
    ])
      expect(matches(shape, value)).toBe(false);
    expect(toJsonSchema(shape)).toMatchObject({
      type: "object",
      required: ["kind", "count", "tags"],
      additionalProperties: false,
    });
  });
  test("unions, forbidden fields and unknown JSON values", () => {
    const choice = s.union([
      s.literal("yes"),
      s.object({ no: s.boolean(), forbidden: s.optional(s.never()) }),
    ]);
    expect(matches(choice, "yes")).toBe(true);
    expect(matches(choice, { no: false })).toBe(true);
    expect(matches(choice, { no: false, forbidden: true })).toBe(false);
    expect(matches(s.unknown(), null)).toBe(true);
    expect(matches(s.integer(), Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  test("items of the wrong shape are refused before they are compared", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20_000; i++) deep = { deep };
    const targets = s.array(s.string(), { uniqueItems: true });
    expect(matches(targets, [deep, "a"])).toBe(false);
  });

  test("unique items compare objects whatever their key order", () => {
    const unique = s.array(s.unknown(), { uniqueItems: true });
    expect(
      matches(unique, [
        { a: 1, b: [{ c: 2, d: 3 }] },
        { a: 1, b: [{ d: 4, c: 2 }] },
      ]),
    ).toBe(true);
    expect(
      matches(unique, [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    ).toBe(false);
    expect(
      matches(unique, [
        { a: 1, b: [{ c: 2, d: 3 }] },
        { b: [{ d: 3, c: 2 }], a: 1 },
      ]),
    ).toBe(false);
  });
});
