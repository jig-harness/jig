import { describe, expect, test } from "bun:test";
import {
  COMMAND_OUTPUT_SHAPES,
  CLASSIFY_OUTPUT_SHAPE,
  VALIDATION_PLAN_SHAPE,
} from "../repo-command-shapes.ts";
import { matches, toJsonSchema } from "../shapes.ts";

describe("repository command output shapes", () => {
  test("classification permits only declared nonempty fields", () => {
    expect(
      matches(CLASSIFY_OUTPUT_SHAPE, {
        path: "src/a.ts",
        language: "TypeScript",
      }),
    ).toBe(true);
    for (const value of [
      {},
      { path: 4 },
      { path: "a", module: " " },
      { path: "a", other: "x" },
    ])
      expect(matches(CLASSIFY_OUTPUT_SHAPE, value)).toBe(false);
  });
  test("validation plans require a boolean box decision", () => {
    expect(
      matches(VALIDATION_PLAN_SHAPE, {
        validation: { testbox: { required: false } },
      }),
    ).toBe(true);
    for (const value of [
      [],
      {},
      { validation: { testbox: { required: "false" } } },
    ])
      expect(matches(VALIDATION_PLAN_SHAPE, value)).toBe(false);
  });
  test("all published command outputs have serializable schemas", () => {
    expect(Object.keys(COMMAND_OUTPUT_SHAPES)).toContain("reflection-check");
    for (const shape of Object.values(COMMAND_OUTPUT_SHAPES))
      expect(JSON.parse(JSON.stringify(toJsonSchema(shape)))).toEqual(
        toJsonSchema(shape),
      );
  });
});
