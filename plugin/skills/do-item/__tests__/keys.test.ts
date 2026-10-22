import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  ANY_KEY_SOURCE,
  issueKeysOf,
  keyFromBranch,
  numberKeys,
  teamKeys,
} from "../scripts/lib/tracker/keys.ts";

const ENG = teamKeys("ENG");
const GH = numberKeys("acme/app");
const found = (source: string, text: string) =>
  [...text.matchAll(new RegExp(source, "g"))].map((m) => m[0]);

describe("issue key shapes", () => {
  it("finds a team key in text only as a whole token", () => {
    expect(
      found(ENG.source, "Closes ENG-12, see XENG-3 and ENG-4a; (ENG-5)"),
    ).toEqual(["ENG-12", "ENG-5"]);
    expect(ENG.normalize(" eng-7 ")).toBe("ENG-7");
    expect(ENG.normalize("OPS-7")).toBeNull();
    expect([ENG.toBranch("ENG-7"), ENG.toFileStem("ENG-7")]).toEqual([
      "ENG-7",
      "ENG-7",
    ]);
  });

  it("finds a number key in text, never another repository's or an entity", () => {
    expect(
      found(GH.source, "Closes #12, other/lib#3, &#38; #0 ##4 #5x (#6)"),
    ).toEqual(["#12", "#6"]);
    for (const input of [
      "#12",
      "12",
      "https://github.com/acme/app/issues/12#issuecomment-1",
    ])
      expect(GH.normalize(input)).toBe("#12");
    for (const input of [
      "#0",
      "ENG-12",
      "https://github.com/other/lib/issues/12",
      "x12",
    ])
      expect(GH.normalize(input)).toBeNull();
    expect([
      GH.toBranch("#12"),
      GH.toFileStem("#12"),
      GH.fromFileStem("issue-12"),
    ]).toEqual(["12", "issue-12", "#12"]);
  });

  it("matches any tracker's key when the tracker is unknown", () => {
    expect(found(ANY_KEY_SOURCE, "ENG-1 and #2 but not ADR0-x or a#3")).toEqual(
      ["ENG-1", "#2"],
    );
  });

  it("follows the configured adapter, and is unknown for Linear without a team", () => {
    expect(issueKeysOf(parseTrackerConfig({}))).toBeNull();
    expect(
      issueKeysOf(parseTrackerConfig({ issue_tracker: { team: "ENG" } }))
        ?.example,
    ).toBe("ENG-123");
    expect(
      issueKeysOf(parseTrackerConfig({ issue_tracker: { adapter: "github" } }))
        ?.example,
    ).toBe("#123");
  });
});

describe("the key a branch names", () => {
  const DEFAULT = "{key_lower}-{slug}";

  it("reads a team key where the pattern puts it, after one optional prefix", () => {
    expect(keyFromBranch("eng-12-fix-login", ENG, DEFAULT)).toBe("ENG-12");
    expect(keyFromBranch("feature/ENG-12-fix", ENG, DEFAULT)).toBe("ENG-12");
    expect(keyFromBranch("a/b/eng-12-fix", ENG, DEFAULT)).toBeNull();
    expect(keyFromBranch("eng-123x", ENG, DEFAULT)).toBeNull();
    expect(keyFromBranch("feature/eng-3", ENG, "feature/{key}-{slug}")).toBe(
      "ENG-3",
    );
  });

  it("reads a number key only where the pattern puts it", () => {
    expect(keyFromBranch("12-fix-login", GH, DEFAULT)).toBe("#12");
    expect(keyFromBranch("12", GH, DEFAULT)).toBe("#12");
    expect(keyFromBranch("feature/3-column-layout", GH, DEFAULT)).toBeNull();
    expect(keyFromBranch("v2-retry", GH, DEFAULT)).toBeNull();
    expect(keyFromBranch("issue/12-fix", GH, "issue/{key}-{slug}")).toBe("#12");
  });

  it("reads a key the pattern puts after the slug from the whole branch", () => {
    expect(keyFromBranch("fix-login-12", GH, "{slug}-{key}")).toBe("#12");
    expect(keyFromBranch("fix-3-tests-12", GH, "{slug}-{key}")).toBe("#12");
    expect(keyFromBranch("fix-3-tests", GH, "{slug}-{key}")).toBeNull();
    expect(keyFromBranch("12", GH, "{slug}-{key}")).toBeNull();
    expect(keyFromBranch("fix-flaky-eng-12", ENG, "{slug}-{key_lower}")).toBe(
      "ENG-12",
    );
  });
});
