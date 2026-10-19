/**
 * The pure pieces: marker parsing, the lockfile table, conflict
 * kinds, pull-request numbers and the line filter of the dropped-change check.
 */
import { describe, expect, it } from "bun:test";
import { LOCKFILES, regenerateFor } from "../scripts/lib/classify.ts";
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

describe("regenerateFor", () => {
  const configured = (paths: string[], command: string | null) => ({
    paths,
    command,
    source: "configuration" as const,
  });
  const catalog = (paths: string[], command: string | null) => ({
    paths,
    command,
    source: "catalog" as const,
  });

  it("matches configured globs with alternatives and character classes", () => {
    const entries = [configured(["gen/{api,web}/[ab].ts"], "make")];
    expect(regenerateFor("gen/web/b.ts", entries)?.class).toBe("generated");
    expect(regenerateFor("gen/cli/b.ts", entries)).toBeNull();
  });

  it("knows the common lockfiles by name, in any directory", () => {
    expect(Object.keys(LOCKFILES)).toContain("Cargo.lock");
    expect(regenerateFor("services/api/go.sum", [])).toEqual({
      class: "lockfile",
      regenerate: {
        command: "go mod tidy",
        cwd: "services/api",
        source: "built-in",
      },
    });
    expect(regenerateFor("src/index.ts", [])).toBeNull();
  });

  it("does not read inherited properties as lockfiles", () => {
    for (const name of ["constructor", "toString", "__proto__"])
      expect(regenerateFor(`src/${name}`, [])).toBeNull();
  });

  it("lets configuration win over the table", () => {
    expect(
      regenerateFor("go.sum", [configured(["go.sum"], "make deps")]),
    ).toMatchObject({
      class: "generated",
      regenerate: { command: "make deps", cwd: ".", source: "configuration" },
    });
  });

  it("reads a catalog entry as generated, run from the root", () => {
    expect(
      regenerateFor("openapi.json", [catalog(["openapi.json"], "bun run gen")]),
    ).toEqual({
      class: "generated",
      regenerate: { command: "bun run gen", cwd: ".", source: "catalog" },
    });
  });

  it("orders configuration, then the catalog, then the lockfile table", () => {
    const entries = [
      configured(["bun.lock", "openapi.json"], "from configuration"),
      catalog(["bun.lock", "openapi.json", "schema.sql"], "from catalog"),
    ];
    expect(regenerateFor("bun.lock", entries)?.regenerate?.command).toBe(
      "from configuration",
    );
    expect(regenerateFor("openapi.json", entries)?.regenerate?.source).toBe(
      "configuration",
    );
    expect(regenerateFor("schema.sql", entries)?.regenerate?.command).toBe(
      "from catalog",
    );
    expect(
      regenerateFor("bun.lock", [catalog(["bun.lock"], "from catalog")])
        ?.regenerate?.command,
    ).toBe("from catalog");
    expect(regenerateFor("bun.lock", [])?.regenerate?.source).toBe("built-in");
  });

  it("keeps a catalog entry without a command a generated file with no command", () => {
    expect(
      regenerateFor("openapi.json", [catalog(["openapi.json"], null)]),
    ).toEqual({ class: "generated", regenerate: null });
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
