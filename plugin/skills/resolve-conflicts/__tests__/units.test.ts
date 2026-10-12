/**
 * The pure pieces: marker parsing, path globs, the lockfile table, conflict
 * kinds, pull-request numbers and the line filter of the dropped-change check.
 */
import { describe, expect, it } from "bun:test";
import {
  globToRegExp,
  LOCKFILES,
  regenerateFor,
} from "../scripts/lib/classify.ts";
import { prNumber } from "../scripts/conflict-map.ts";
import { significant } from "../scripts/lib/drops.ts";
import { markerKind, markerLines, parseHunks } from "../scripts/lib/markers.ts";
import { kindOf } from "../scripts/lib/snapshot.ts";

const stage = { mode: "100644", blob: "0".repeat(40) };

describe("parseHunks", () => {
  it("reads regions with and without a base section", () => {
    const text = [
      "a",
      "<<<<<<< HEAD",
      "ours 1",
      "ours 2",
      "||||||| base",
      "base",
      "=======",
      "theirs",
      ">>>>>>> main",
      "b",
      "<<<<<<< HEAD",
      "=======",
      "only theirs",
      ">>>>>>> main",
      "",
    ].join("\n");
    expect(parseHunks(text)).toEqual([
      {
        start: 2,
        end: 9,
        oursLabel: "HEAD",
        baseLabel: "base",
        theirsLabel: "main",
        ours: "ours 1\nours 2",
        base: "base",
        theirs: "theirs",
      },
      {
        start: 11,
        end: 14,
        oursLabel: "HEAD",
        baseLabel: null,
        theirsLabel: "main",
        ours: "",
        base: null,
        theirs: "only theirs",
      },
    ]);
  });

  it("honours a larger marker size and leaves longer runs as text", () => {
    const text =
      "<<<<<<<<< HEAD\n<<<<<<< not a marker\n=========\nx\n>>>>>>>>> main\n";
    expect(parseHunks(text, 9)).toMatchObject([
      { start: 1, end: 5, ours: "<<<<<<< not a marker", theirs: "x" },
    ]);
    expect(parseHunks(text)).toEqual([]);
    expect(markerKind("<<<<<<<< HEAD", 7)).toBeNull();
  });

  it("reads lines that end in a carriage return", () => {
    expect(
      parseHunks("<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> main\r\n"),
    ).toMatchObject([{ ours: "a", theirs: "b", theirsLabel: "main" }]);
  });

  it("markerLines finds every marker, including a stray one", () => {
    expect(markerLines("x\n=======\ny\n>>>>>>>\n")).toEqual([2, 4]);
  });
});

describe("globToRegExp", () => {
  const cases: [string, string, boolean][] = [
    ["src/generated/**", "src/generated/a/b.ts", true],
    ["src/generated/**", "src/other/a.ts", false],
    ["**/schema.json", "schema.json", true],
    ["**/schema.json", "a/b/schema.json", true],
    ["docs/*.md", "docs/index.md", true],
    ["docs/*.md", "docs/guide/index.md", false],
    ["file?.txt", "file1.txt", true],
    ["a.b", "axb", false],
  ];
  for (const [glob, path, matches] of cases)
    it(`${glob} ${matches ? "matches" : "does not match"} ${path}`, () => {
      expect(globToRegExp(glob).test(path)).toBe(matches);
    });
});

describe("regenerateFor", () => {
  it("knows the common lockfiles by name, in any directory", () => {
    expect(Object.keys(LOCKFILES)).toContain("Cargo.lock");
    expect(regenerateFor("services/api/go.sum", [])).toEqual({
      class: "lockfile",
      command: "go mod tidy",
      cwd: "services/api",
      source: "built-in",
    });
    expect(regenerateFor("src/index.ts", [])).toBeNull();
  });

  it("does not read inherited properties as lockfiles", () => {
    for (const name of ["constructor", "toString", "__proto__"])
      expect(regenerateFor(`src/${name}`, [])).toBeNull();
  });

  it("lets configuration win over the table", () => {
    expect(
      regenerateFor("go.sum", [{ paths: ["go.sum"], command: "make deps" }]),
    ).toMatchObject({ class: "generated", command: "make deps", cwd: "." });
  });
});

describe("kindOf", () => {
  const cases: [string, Parameters<typeof kindOf>[0]][] = [
    ["both-modified", { base: stage, ours: stage, theirs: stage }],
    ["both-added", { base: null, ours: stage, theirs: stage }],
    ["deleted-by-ours", { base: stage, ours: null, theirs: stage }],
    ["deleted-by-theirs", { base: stage, ours: stage, theirs: null }],
    ["added-by-ours", { base: null, ours: stage, theirs: null }],
    ["added-by-theirs", { base: null, ours: null, theirs: stage }],
    ["both-deleted", { base: stage, ours: null, theirs: null }],
  ];
  for (const [kind, stages] of cases)
    it(kind, () => {
      expect(kindOf(stages)).toBe(kind as ReturnType<typeof kindOf>);
    });
});

describe("prNumber", () => {
  it("reads squash and merge-commit subjects", () => {
    expect(prNumber("Raise the retry limit (#15)")).toBe(15);
    expect(prNumber("Merge pull request #42 from someone/branch")).toBe(42);
    expect(prNumber("Fix #12 in the middle")).toBeNull();
  });

  it("reads no pull request from a number the snapshot cannot hold", () => {
    expect(prNumber("Adjust configuration (#0)")).toBeNull();
    expect(prNumber("Adjust configuration (#007)")).toBe(7);
    expect(prNumber("Adjust configuration (#99999999999999999999)")).toBeNull();
  });
});

describe("significant", () => {
  it("ignores blank and punctuation-only lines", () => {
    for (const line of ["", "  ", "}", "});", "],", "*/"])
      expect(significant(line)).toBe(false);
    for (const line of ["retries: 5,", "x", "0"])
      expect(significant(line)).toBe(true);
  });
});
