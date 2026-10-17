import { describe, expect, test } from "bun:test";
import { parseCheckAttr, readAttributes } from "../scripts/lib/git.ts";
import { classified, repository } from "./helpers.ts";

describe("parseCheckAttr", () => {
  test("reads NUL-separated triples and keeps the linguist attributes", () => {
    const out = [
      "web/vendor.js",
      "linguist-vendored",
      "set",
      "web/vendor.js",
      "text",
      "auto",
      "api/schema.ts",
      "linguist-generated",
      "true",
      "lib/tool.inc",
      "linguist-language",
      "Shell",
      "",
    ].join("\0");
    const attrs = parseCheckAttr(out);
    expect([...attrs.keys()]).toEqual([
      "web/vendor.js",
      "api/schema.ts",
      "lib/tool.inc",
    ]);
    expect(Object.fromEntries(attrs.get("web/vendor.js") ?? [])).toEqual({
      "linguist-vendored": "set",
    });
    expect(attrs.get("lib/tool.inc")?.get("linguist-language")).toBe("Shell");
  });

  test("empty output means no attributes", () => {
    expect(parseCheckAttr("").size).toBe(0);
  });

  test("refuses output that is not whole triples", () => {
    expect(() => parseCheckAttr("a\0linguist-vendored\0")).toThrow(/triples/);
    expect(() => parseCheckAttr("a\0linguist-vendored\0set")).toThrow(
      /triples/,
    );
  });
});

describe("attributes in classification", () => {
  test("linguist-vendored makes a file vendored; unset keeps vendor/ in", () => {
    expect(
      classified("web/lib/chart.js", "", undefined, undefined, {
        "linguist-vendored": "set",
      }).kind,
    ).toEqual({ value: "vendored", rule: "attribute linguist-vendored" });
    expect(
      classified("vendor/own/tool.go", "", undefined, undefined, {
        "linguist-vendored": "unset",
      }).kind.value,
    ).toBe("code");
  });

  test("linguist-generated marks a file generated; unset overrides the conventions", () => {
    expect(
      classified("api/schema.ts", "", undefined, undefined, {
        "linguist-generated": "true",
      }).kind,
    ).toEqual({ value: "generated", rule: "attribute linguist-generated" });
    expect(
      classified("api/generated/hand.ts", "", undefined, undefined, {
        "linguist-generated": "false",
      }).kind.value,
    ).toBe("code");
  });

  test("linguist-documentation makes a file docs", () => {
    expect(
      classified("examples/demo.ts", "", undefined, undefined, {
        "linguist-documentation": "set",
      }).kind.value,
    ).toBe("docs");
  });

  test("linguist-language overrides the language", () => {
    expect(
      classified("lib/tool.inc", "", undefined, undefined, {
        "linguist-language": "Shell",
      }).language,
    ).toEqual({ value: "Shell", rule: "attribute linguist-language" });
  });
});

describe("readAttributes", () => {
  test("asks git once for every path's attributes", async () => {
    const root = repository({
      ".gitattributes":
        "web/lib/** linguist-vendored\napi/*.pb.ts -linguist-generated\n",
      "web/lib/chart.js": "x\n",
      "api/a.pb.ts": "x\n",
      "api/b.ts": "x\n",
    });
    const attrs = await readAttributes(root, [
      "web/lib/chart.js",
      "api/a.pb.ts",
      "api/b.ts",
    ]);
    expect(attrs.get("web/lib/chart.js")?.get("linguist-vendored")).toBe("set");
    expect(attrs.get("api/a.pb.ts")?.get("linguist-generated")).toBe("unset");
    expect(attrs.has("api/b.ts")).toBe(false);
  });

  test("a failed call is an error, not an empty answer", async () => {
    const root = repository({ "a.txt": "x\n" });
    await expect(
      readAttributes(`${root}/not-a-repository-dir`, ["a.txt"]),
    ).rejects.toThrow(/git check-attr failed/);
  });
});
