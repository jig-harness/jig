/**
 * The pull-request title pattern: validation, rendering, and matching against
 * recent trunk subjects.
 */
import { describe, expect, it } from "bun:test";
import {
  keyIsAmbiguous,
  matchesTitlePattern,
  parseTitlePattern,
  renderTitle,
  titlePatternShare,
  validateTitlePattern,
} from "../title-pattern.ts";

describe("validateTitlePattern", () => {
  it("accepts a pattern with the key and the summary once each", () => {
    expect(() => validateTitlePattern("{key}: {summary}")).not.toThrow();
    expect(() => validateTitlePattern("[{key}] {summary}")).not.toThrow();
  });

  it.each([
    ["{summary}", /must contain \{key\} exactly once/],
    ["{key}", /must contain \{summary\} exactly once/],
    ["{key}: {summary} {summary}", /\{summary\} exactly once/],
    ["{key}: {title}", /unknown placeholder \{title\}/],
    ["{key}: {summary} {", /unbalanced brace/],
    ["{key}: {summary} }", /unbalanced brace/],
  ])("refuses %p", (pattern, message) => {
    expect(() => validateTitlePattern(pattern)).toThrow(message);
  });
});

describe("parseTitlePattern", () => {
  it("is null without the pattern format", () => {
    expect(parseTitlePattern({}, null)).toBeNull();
    expect(parseTitlePattern({}, "free")).toBeNull();
  });

  it("returns the pattern under the pattern format", () => {
    expect(
      parseTitlePattern({ title_pattern: "{key}: {summary}" }, "pattern"),
    ).toBe("{key}: {summary}");
  });

  it("refuses the pattern format without a pattern, and a pattern without the format", () => {
    expect(() => parseTitlePattern({}, "pattern")).toThrow(
      /needs pull_requests\.title_pattern/,
    );
    expect(() =>
      parseTitlePattern({ title_pattern: "{key}: {summary}" }, "free"),
    ).toThrow(/needs pull_requests\.title_format set to pattern/);
    expect(() => parseTitlePattern({ title_pattern: 3 }, "pattern")).toThrow(
      /nonempty string/,
    );
  });
});

describe("renderTitle", () => {
  it("fills the key and the summary", () => {
    expect(renderTitle("{key}: {summary}", "ENG-12", "<summary>")).toBe(
      "ENG-12: <summary>",
    );
    expect(renderTitle("[{key}] {summary}", "#7", "Add a thing")).toBe(
      "[#7] Add a thing",
    );
  });

  it("leaves placeholder-like text in the summary alone", () => {
    expect(renderTitle("{key}: {summary}", "ENG-1", "use {key} here")).toBe(
      "ENG-1: use {key} here",
    );
  });
});

describe("matchesTitlePattern", () => {
  const pattern = "{key}: {summary}";

  it("matches a title the pattern renders", () => {
    expect(
      matchesTitlePattern(pattern, "ENG-12: Add a thing", "prefixed"),
    ).toBe(true);
    expect(matchesTitlePattern(pattern, "#12: Add a thing", "hash")).toBe(true);
  });

  it("allows the suffix a squash merge appends", () => {
    expect(
      matchesTitlePattern(pattern, "ENG-12: Add a thing (#345)", "prefixed"),
    ).toBe(true);
    expect(
      matchesTitlePattern(pattern, "#12: Add a thing (#345)", "hash"),
    ).toBe(true);
  });

  it.each([
    "Add a thing",
    "feat: add a thing",
    "ENG-12 Add a thing",
    "ENG-12: ",
    "eng: Add a thing",
    "#12: Add a thing",
  ])("does not match %p", (subject) => {
    expect(matchesTitlePattern(pattern, subject, "prefixed")).toBe(false);
  });

  it("reads the key as the tracker writes it", () => {
    expect(matchesTitlePattern(pattern, "ENG-12: Add a thing", "hash")).toBe(
      false,
    );
    expect(matchesTitlePattern("{key} {summary}", "covid-19 fix", "hash")).toBe(
      false,
    );
  });

  it("flags a hash key at the end of the pattern as ambiguous", () => {
    expect(keyIsAmbiguous("{summary} ({key})", "hash")).toBe(true);
    expect(keyIsAmbiguous("{summary} ({key})", "prefixed")).toBe(false);
    expect(keyIsAmbiguous("{key}: {summary}", "hash")).toBe(false);
  });

  it("escapes the literal parts of the pattern", () => {
    expect(
      matchesTitlePattern("[{key}] {summary}", "[ENG-1] x", "prefixed"),
    ).toBe(true);
    expect(
      matchesTitlePattern("[{key}] {summary}", "ENG-1 x", "prefixed"),
    ).toBe(false);
    expect(
      matchesTitlePattern("{key}. {summary}", "ENG-1x x", "prefixed"),
    ).toBe(false);
  });
});

describe("titlePatternShare", () => {
  const pattern = "{key}: {summary}";

  it("counts matching subjects, skipping merge commits", () => {
    expect(
      titlePatternShare(
        pattern,
        [
          "ENG-1: a",
          "ENG-2: b (#3)",
          "Merge pull request #4 from x/y",
          "fix: c",
          "ENG-5: d",
          "ENG-6: e",
        ],
        "prefixed",
      ),
    ).toEqual({ matching: 4, total: 5 });
  });

  it("is null when too little history remains to judge", () => {
    expect(
      titlePatternShare(pattern, ["ENG-1: a", "fix: b"], "prefixed"),
    ).toBeNull();
  });
});
