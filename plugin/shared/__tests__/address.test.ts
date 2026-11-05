/**
 * The address parser: `station@repository#key` in its written forms, the
 * repository resolved in full from a short name or the checkout, the key
 * checked against its station's form, and every refusal a reason that a
 * usage error prints, naming the stations where the station is the fault.
 */
import { describe, expect, it } from "bun:test";
import {
  checkKey,
  formatAddress,
  parseAddress,
  type RepositoryChoices,
  resolveRepository,
} from "../address.ts";

const CHOICES: RepositoryChoices = {
  known: [
    { slug: "jig-harness/jig", path: "/src/jig" },
    { slug: "acme/tools", path: "/src/tools" },
    { slug: "other/tools", path: "/src/other-tools" },
    { slug: null, path: "/src/local-only" },
  ],
  checkout: "jig-harness/jig",
};

describe("parseAddress", () => {
  it("reads the station, the repository as written and the key", () => {
    expect(parseAddress("drive@jig-harness/jig#456")).toEqual({
      ok: true,
      value: { station: "drive", repo: "jig-harness/jig", key: "456" },
    });
    expect(parseAddress("followup@jig#12")).toEqual({
      ok: true,
      value: { station: "followup", repo: "jig", key: "12" },
    });
    expect(parseAddress("pickup#ENG-4")).toEqual({
      ok: true,
      value: { station: "pickup", repo: null, key: "ENG-4" },
    });
  });

  it("takes the key as a second argument, and refuses it twice", () => {
    expect(parseAddress("drive@jig", "456")).toEqual({
      ok: true,
      value: { station: "drive", repo: "jig", key: "456" },
    });
    expect(parseAddress("drive", "456")).toMatchObject({
      ok: true,
      value: { repo: null, key: "456" },
    });
    expect(parseAddress("drive@jig#1", "2")).toMatchObject({
      ok: false,
      failure: { code: "malformed" },
    });
  });

  it("refuses an unknown station, naming the stations", () => {
    const r = parseAddress("review@jig#1");
    expect(r).toMatchObject({
      ok: false,
      failure: { code: "unknown-station" },
    });
    if (!r.ok) expect(r.failure.reason).toContain("pickup, drive, followup");
  });

  it("refuses a malformed address, naming the stations", () => {
    for (const input of [
      "@jig#1",
      "drive@jig",
      "drive@a/b/c#1",
      "drive@jig#4 5",
    ]) {
      const r = parseAddress(input);
      expect(r).toMatchObject({ ok: false, failure: { code: "malformed" } });
      if (!r.ok) expect(r.failure.reason).toContain("pickup, drive, followup");
    }
  });
});

describe("resolveRepository", () => {
  it("keeps a full name, and resolves a short one the dispatch file lists once", () => {
    expect(resolveRepository("someone/else", CHOICES)).toEqual({
      ok: true,
      value: "someone/else",
    });
    expect(resolveRepository("jig", CHOICES)).toEqual({
      ok: true,
      value: "jig-harness/jig",
    });
  });

  it("refuses a short name the dispatch file lists twice or not at all", () => {
    const two = resolveRepository("tools", CHOICES);
    expect(two).toMatchObject({
      ok: false,
      failure: { code: "ambiguous-repository" },
    });
    if (!two.ok)
      expect(two.failure.reason).toContain("acme/tools, other/tools");
    expect(resolveRepository("nowhere", CHOICES)).toMatchObject({
      ok: false,
      failure: { code: "unknown-repository" },
    });
  });

  it("takes the checkout's repository where the address leaves it out", () => {
    expect(resolveRepository(null, CHOICES)).toEqual({
      ok: true,
      value: "jig-harness/jig",
    });
    expect(
      resolveRepository(null, { known: CHOICES.known, checkout: null }),
    ).toMatchObject({ ok: false, failure: { code: "no-repository" } });
  });
});

describe("checkKey", () => {
  it("reads a pull request's number for drive and followup", () => {
    expect(checkKey("drive", "456", null)).toEqual({ ok: true, value: "456" });
    expect(checkKey("followup", "#7", null)).toEqual({ ok: true, value: "7" });
    for (const key of ["0", "seven", "ENG-4", "9".repeat(30)])
      expect(checkKey("drive", key, null)).toMatchObject({
        ok: false,
        failure: { code: "malformed-key" },
      });
  });

  it("checks a pick-up's key against its tracker's form", () => {
    const github = (s: string) =>
      /^#?[1-9]\d*$/.test(s) ? `#${s.replace(/^#/, "")}` : null;
    expect(checkKey("pickup", "12", github)).toEqual({
      ok: true,
      value: "#12",
    });
    expect(checkKey("pickup", "ENG-4", github)).toMatchObject({
      ok: false,
      failure: { code: "malformed-key" },
    });
    expect(checkKey("pickup", "12", null)).toMatchObject({
      ok: false,
      failure: { code: "malformed-key" },
    });
  });
});

describe("formatAddress", () => {
  it("prints the repository in full and the key after one #", () => {
    expect(
      formatAddress({ station: "drive", repo: "jig-harness/jig", key: "456" }),
    ).toBe("drive@jig-harness/jig#456");
    expect(
      formatAddress({ station: "pickup", repo: "jig-harness/jig", key: "#12" }),
    ).toBe("pickup@jig-harness/jig#12");
    expect(
      formatAddress({ station: "pickup", repo: "acme/app", key: "ENG-4" }),
    ).toBe("pickup@acme/app#ENG-4");
  });
});
