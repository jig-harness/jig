import { expect, test } from "bun:test";
import { definedFields } from "../defined-fields.ts";

test("forwards supplied optional values and omits undefined keys", () => {
  const fields = definedFields({
    absent: undefined,
    disabled: false,
    count: 0,
    label: "",
    cleared: null,
    supplied: "value",
  });
  expect(fields).toEqual({
    disabled: false,
    count: 0,
    label: "",
    cleared: null,
    supplied: "value",
  });
  expect(fields).not.toHaveProperty("absent");
});
