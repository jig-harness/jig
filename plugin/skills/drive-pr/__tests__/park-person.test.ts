import { describe, expect, it } from "bun:test";
import { parseCatalog } from "../scripts/lib/change-areas-catalog.ts";
import { personForPark } from "../scripts/lib/state/park-person.ts";

const catalog = parseCatalog({
  areas: {
    api: { paths: ["api/**"], owner: "api-owner" },
    web: { paths: ["web/**"], owner: "web-owner" },
  },
});

describe("a parked question's person", () => {
  it("routes by its own anchor, then dispatch.person, then the PR author", () => {
    expect(personForPark("api/route.ts", catalog, "maintainer", "author")).toBe(
      "api-owner",
    );
    expect(personForPark("web/view.ts", catalog, "maintainer", "author")).toBe(
      "web-owner",
    );
    expect(personForPark(null, catalog, "maintainer", "author")).toBe(
      "maintainer",
    );
    expect(personForPark("other.ts", catalog, undefined, "author")).toBe(
      "author",
    );
  });
  it("does not choose an arbitrary owner where ownership overlaps", () => {
    const overlapping = parseCatalog({
      areas: {
        first: { paths: ["**"], owner: "first" },
        second: { paths: ["api/**"], owner: "second" },
      },
    });
    expect(
      personForPark("api/route.ts", overlapping, "maintainer", "author"),
    ).toBe("maintainer");
  });
  it("uses the fallback for catalog ownership that is not a person", () => {
    for (const owner of [
      { team: "api" },
      "team/api",
      ["first", "second"],
      null,
    ]) {
      const catalog = parseCatalog({
        areas: { api: { paths: ["api/**"], owner } },
      });
      expect(
        personForPark("api/route.ts", catalog, "maintainer", "author"),
      ).toBe("maintainer");
      expect(personForPark("api/route.ts", catalog, undefined, "author")).toBe(
        "author",
      );
    }
  });
  it("rejects malformed configured logins instead of mentioning arbitrary text", () => {
    expect(() =>
      personForPark(null, catalog, "a\n@everyone", "author"),
    ).toThrow("dispatch.person");
    expect(() => personForPark(null, catalog, undefined, "")).toThrow("author");
  });
});
