import { describe, expect, test } from "bun:test";
import { checkConfig, loadSchema } from "../scripts/lib/schema.ts";

const schema = loadSchema();

describe("reflection class seed configuration", () => {
  const valid = { slug: "missing-guard", shape: "A required check is absent" };

  test("accepts inline entries and a local vocabulary path", () => {
    expect(
      checkConfig(
        {
          reflection: {
            classes: [valid, { ...valid, source: "team register" }],
            classes_from: "~/classes.yaml",
          },
        },
        schema,
      ),
    ).toEqual([]);
  });

  test.each([
    ["classes", "missing-guard"],
    ["classes", [{ ...valid, slug: "bad_slug" }]],
    ["classes", [{ ...valid, shape: " " }]],
    ["classes", [{ ...valid, shape: "two\nlines" }]],
    ["classes", [{ slug: valid.slug }]],
    ["classes", [{ ...valid, source: 42 }]],
    ["classes", [{ ...valid, source: " " }]],
    ["classes_from", ["classes.yaml"]],
    ["classes_from", "https://example.com/classes.yaml"],
  ])("rejects an invalid %s value %p", (field, value) => {
    expect(
      checkConfig({ reflection: { [field]: value } }, schema).map(
        (finding) => finding.id,
      ),
    ).toContain(`type:reflection.${field}`);
  });
  test.each(["classes", "classes_from"])("rejects null for %s", (field) => {
    expect(checkConfig({ reflection: { [field]: null } }, schema)).toEqual([
      expect.objectContaining({
        id: `null:reflection.${field}`,
        severity: "error",
      }),
    ]);
  });
});
