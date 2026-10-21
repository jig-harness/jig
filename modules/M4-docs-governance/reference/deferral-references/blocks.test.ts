// How a document splits into the blocks the deferral check judges.
import { describe, expect, test } from "bun:test";
import { units } from "./blocks";
import { parseConfig, readDocument } from "./check-deferrals";

const config = parseConfig(
  `items:
  - '\\b[A-Z][A-Z0-9]{1,9}-\\d+\\b'
`,
  "test.yaml",
);
const findingsOf = (content: string) =>
  readDocument(content, config).findings.map((f) => `${f.line}:${f.rule}`);
const keysOf = (content: string) =>
  readDocument(content, config).deferrals.map((d) => d.keys);

describe("units", () => {
  test("paragraphs, list items with continuations, table rows and headings are separate blocks", () => {
    const doc = [
      "# Title with a heading",
      "",
      "First line",
      "second line.",
      "",
      "- item one",
      "  continued",
      "- item two",
      "  - nested",
      "",
      "| a | b |",
      "|---|---|",
      "| c | d |",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 1],
      [3, 4],
      [6, 7],
      [8, 8],
      [9, 9],
      [11, 11],
      [12, 12],
      [13, 13],
    ]);
  });

  test("frontmatter and fenced code are not prose", () => {
    const doc = [
      "---",
      "title: tracked to closure",
      "---",
      "",
      "```",
      "tracked to closure",
      "```",
      "",
      "~~~~",
      "```",
      "will be filed",
      "~~~~",
      "",
      "after",
    ].join("\n");
    expect(units(doc).map((u) => u.text)).toEqual(["after"]);
    expect(findingsOf(doc)).toEqual([]);
  });

  test("a fence inside a nested list item is code, however deep it is indented", () => {
    const doc = [
      "- a",
      "  - b",
      "",
      "        ```",
      "        will be filed",
      "        ENG-5",
      "        ```",
      "",
      "  - c, tracked to closure.",
    ].join("\n");
    expect(findingsOf(doc)).toEqual(["9:deferral-names-no-item"]);
    expect(keysOf(doc)).toEqual([[]]);
  });

  test("a loose list item keeps its indented later paragraph, a flush paragraph is its own block", () => {
    const doc = [
      "- Audit the log.",
      "",
      "  Tracked to closure under ENG-7.",
      "",
      "Not part of it.",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 3],
      [5, 5],
    ]);
    expect(keysOf(doc)).toEqual([["ENG-7"]]);
  });

  test("block quotes are read like the text inside them", () => {
    expect(findingsOf("> A follow-up will be filed.\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("a closing fence is the fence run alone; a longer line is still code", () => {
    const doc = [
      "```",
      "```still-code",
      "will be filed",
      "```",
      "",
      "after",
    ].join("\n");
    expect(units(doc).map((u) => u.text)).toEqual(["after"]);
  });

  test("a table without outer pipes keeps each row its own block", () => {
    const doc = [
      "Risk | Tracking",
      "--- | ---",
      "A | tracked to closure",
      "B | ENG-1",
    ].join("\n");
    expect(units(doc).map((u) => [u.start, u.end])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(findingsOf(doc)).toEqual(["3:deferral-names-no-item"]);
  });

  test("entering or leaving a block quote ends the block", () => {
    expect(findingsOf("Tracked to closure.\n> ENG-1\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(findingsOf("> Tracked to closure.\nENG-1\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(findingsOf("> Tracked to closure\n> under ENG-1.\n")).toEqual([]);
  });

  test("a paragraph after a nested item belongs to the item its indent reaches", () => {
    const doc = ["- Tracked to closure.", "  - Context.", "", "  ENG-1"].join(
      "\n",
    );
    expect(findingsOf(doc)).toEqual([]);
    expect(keysOf(doc)).toEqual([["ENG-1"]]);
    const deeper = [
      "- Outer.",
      "  - Tracked to closure.",
      "",
      "    ENG-2",
    ].join("\n");
    expect(keysOf(deeper)).toEqual([["ENG-2"]]);
  });

  test("an HTML comment is blanked across lines and blocks before blocks are built", () => {
    expect(findingsOf("Tracked to closure.\n<!--\nENG-1\n\n-->\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
    expect(
      findingsOf("Tracked to closure <!-- a\nnote --> under ENG-1.\n"),
    ).toEqual([]);
    expect(findingsOf("<!-- note -->\nTracked to closure.\n")).toEqual([
      "1:deferral-names-no-item",
    ]);
  });

  test("an empty document and a document of only a rule have no blocks", () => {
    expect(units("")).toEqual([]);
    expect(units("---\n")).toEqual([]);
  });
});
