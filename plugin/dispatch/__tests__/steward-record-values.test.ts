/**
 * The steward records' tables (`lib/steward-record-values.ts`) hold what
 * their shapes (`lib/steward-record-shapes.ts`) check: each kind the table
 * lists has a shape, each shape's fields are the kind's fields and the ones
 * every kind carries, all required and no other, and the causes and the
 * summary's bound are the closing report's.
 */
import { describe, expect, test } from "bun:test";
import { CONCLUDED_MAX, STEWARD_CAUSES } from "../../shared/closing-report.ts";
import { matches, type JsonSchema } from "../../shared/shapes.ts";
import {
  STEWARD_RECORD_SHAPES,
  STEWARD_SUBMISSION_SHAPE,
} from "../lib/steward-record-shapes.ts";
import {
  STEWARD_CAUSE_VALUES,
  STEWARD_COMMON_FIELDS,
  STEWARD_RECORD_KINDS,
  STEWARD_RECORD_LIMITS,
  type StewardKindName,
} from "../lib/steward-record-values.ts";

type Schema = Exclude<JsonSchema, boolean>;

/** The object schemas of a kind: one, or one per alternative form. */
function objectsOf(kind: StewardKindName): Schema[] {
  const schema = STEWARD_RECORD_SHAPES[kind].schema as Schema;
  return Array.isArray(schema.anyOf) ? (schema.anyOf as Schema[]) : [schema];
}

describe("the steward records' tables and shapes", () => {
  test("give every kind a shape, and no shape a kind the table lacks", () => {
    expect(Object.keys(STEWARD_RECORD_SHAPES)).toEqual(
      Object.keys(STEWARD_RECORD_KINDS),
    );
  });

  test("give each kind's shape exactly its table's fields, every one required, and no other", () => {
    for (const kind of Object.keys(STEWARD_RECORD_KINDS) as StewardKindName[]) {
      const fields = [
        ...Object.keys(STEWARD_COMMON_FIELDS),
        ...Object.keys(STEWARD_RECORD_KINDS[kind].fields),
      ].sort();
      for (const object of objectsOf(kind)) {
        expect(Object.keys(object.properties as object).sort()).toEqual(fields);
        expect([...(object.required as string[])].sort()).toEqual(fields);
        expect(object.additionalProperties).toBe(false);
        expect((object.properties as Record<string, Schema>).kind).toEqual({
          const: kind,
        });
      }
    }
  });

  test("list the closing report's causes a steward records, and its bound on what a run concluded", () => {
    expect(Object.keys(STEWARD_CAUSE_VALUES)).toEqual([...STEWARD_CAUSES]);
    expect(STEWARD_RECORD_LIMITS.summary.value).toBe(CONCLUDED_MAX);
  });

  test("give every entry a meaning", () => {
    const meanings = [
      ...Object.values(STEWARD_COMMON_FIELDS),
      ...Object.values(STEWARD_RECORD_KINDS).flatMap((k) => [
        k,
        ...Object.values(k.fields),
      ]),
      ...Object.values(STEWARD_CAUSE_VALUES),
      ...Object.values(STEWARD_RECORD_LIMITS),
    ].map((v) => v.meaning.trim());
    expect(meanings.filter((m) => m === "")).toEqual([]);
  });

  test("hold a submission to its bound on records", () => {
    const record = {
      kind: "resume",
      record: "20261101T000000Z-0123abcd",
      reason: "recommended",
    };
    const max = STEWARD_RECORD_LIMITS.records.value;
    expect(
      matches(
        STEWARD_SUBMISSION_SHAPE,
        Array.from({ length: max }, () => record),
      ),
    ).toBe(true);
    expect(
      matches(
        STEWARD_SUBMISSION_SHAPE,
        Array.from({ length: max + 1 }, () => record),
      ),
    ).toBe(false);
  });
});
