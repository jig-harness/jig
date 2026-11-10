import { describe, expect, test } from "bun:test";
import { itemBaseOf, itemBases, itemLinkFrom } from "../item-links.ts";

describe("itemBaseOf", () => {
  test("a GitHub issue link gives the issues base", () => {
    expect(itemBaseOf("https://github.com/o/r/issues/12", "#12")).toEqual({
      family: "#",
      base: "https://github.com/o/r/issues/",
    });
  });

  test("a link with a title slug after the key drops the slug", () => {
    expect(
      itemBaseOf("https://tracker.example/acme/issue/ENG-4/fix-it", "ENG-4"),
    ).toEqual({ family: "ENG", base: "https://tracker.example/acme/issue/" });
  });

  test("a link that does not name the key, or is not a web address, gives none", () => {
    expect(itemBaseOf("https://github.com/o/r/issues/12", "#13")).toBeNull();
    expect(itemBaseOf("https://example.test/ENG-40", "ENG-4")).toBeNull();
    expect(itemBaseOf("file:///ENG-4", "ENG-4")).toBeNull();
    expect(itemBaseOf("https://github.com/o/r/pull/12", "PR #12")).toBeNull();
  });
});

describe("itemLinkFrom", () => {
  const bases = itemBases([
    { target: "#3", url: "https://github.com/o/r/issues/3" },
    { target: "ENG-4", url: "https://site.example/browse/ENG-4" },
    { target: "PR #9", url: "https://github.com/o/r/pull/9" },
    { target: "WEB-1", url: null },
  ]);

  test("a key takes its own family's base", () => {
    expect(itemLinkFrom(bases, "#77")).toBe("https://github.com/o/r/issues/77");
    expect(itemLinkFrom(bases, "ENG-9")).toBe(
      "https://site.example/browse/ENG-9",
    );
  });

  test("a prefixed key of another family takes the one prefixed base", () => {
    expect(itemLinkFrom(bases, "OPS-2")).toBe(
      "https://site.example/browse/OPS-2",
    );
  });

  test("no base, two prefixed bases, or a key of no family gives none", () => {
    expect(itemLinkFrom(new Map(), "#1")).toBeNull();
    const two = itemBases([
      { target: "ENG-1", url: "https://a.example/browse/ENG-1" },
      { target: "OPS-1", url: "https://b.example/browse/OPS-1" },
    ]);
    expect(itemLinkFrom(two, "WEB-1")).toBeNull();
    expect(itemLinkFrom(itemBases([]), "#5")).toBeNull();
    expect(itemLinkFrom(bases, "the outcome log")).toBeNull();
    expect(
      itemLinkFrom(
        itemBases([{ target: "ENG-1", url: "https://a.example/browse/ENG-1" }]),
        "#5",
      ),
    ).toBeNull();
  });
});
