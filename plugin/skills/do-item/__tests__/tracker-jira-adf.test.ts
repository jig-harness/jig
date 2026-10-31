import { describe, expect, it } from "bun:test";
import {
  type AdfNode,
  adfToMarkdown,
  markdownToAdf,
} from "../scripts/lib/tracker/jira/adf.ts";

const CORPUS = [
  "# Fix the login page",
  "",
  "Some **bold**, *emphasis*, ~~struck~~ and `inline code`, with a [link](https://example.com/a?b=1).",
  "A second line keeps snake_case and **bold [a link](https://example.com/b)**.",
  "",
  "<!-- jig:finding ENG-12 kind=debt -->",
  "",
  "## Steps",
  "",
  "- open the page",
  "- sign in",
  "  - with a password",
  "  - with a passkey",
  "    1. pick the key",
  "- see the error",
  "",
  "3. third",
  "4. fourth",
  "",
  "```ts",
  "const x = 1;",
  "",
  "console.log(x);",
  "```",
  "",
  "> Quoted text",
  "> over two lines",
  "",
  "---",
  "",
  "| Field | Value |",
  "| --- | --- |",
  "| state | **open** |",
  "| pipe | a\\|b |",
  "",
  "Escaped \\*stars\\*, \\[brackets\\] and \\_leading underscores.",
  "\\# not a heading",
  "1\\. not a list",
].join("\n");

const text = (t: string, marks?: AdfNode["marks"]): AdfNode =>
  marks === undefined
    ? { type: "text", text: t }
    : { type: "text", text: t, marks };
const para = (...content: AdfNode[]): AdfNode => ({
  type: "paragraph",
  content,
});
const doc = (...content: AdfNode[]) => ({
  type: "doc" as const,
  version: 1 as const,
  content,
});

describe("ADF: Markdown round trip", () => {
  it("reads back a corpus with headings, nested lists, code, links, a table and a marker unchanged", () => {
    expect(adfToMarkdown(markdownToAdf(CORPUS))).toBe(CORPUS);
  });

  it("writes the nodes and marks Jira expects", () => {
    const adf = markdownToAdf(CORPUS);
    const types = (nodes: AdfNode[]): string[] =>
      nodes.flatMap((n) => [n.type, ...types(n.content ?? [])]);
    const all = types(adf.content);
    for (const t of [
      "heading",
      "bulletList",
      "orderedList",
      "listItem",
      "codeBlock",
      "blockquote",
      "rule",
      "table",
      "tableRow",
      "tableHeader",
      "tableCell",
      "hardBreak",
    ])
      expect(all).toContain(t);
    expect(adf.content[0]).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [text("Fix the login page")],
    });
    expect(adf.content[2]).toEqual(
      para(text("<!-- jig:finding ENG-12 kind=debt -->")),
    );
    const code = adf.content.find((n) => n.type === "codeBlock");
    expect(code?.attrs).toEqual({ language: "ts" });
    const ordered = adf.content.find((n) => n.type === "orderedList");
    expect(ordered?.attrs).toEqual({ order: 3 });
  });

  it("nests marks inside a link and a link inside strong", () => {
    expect(markdownToAdf("**bold [x](https://e.x)**").content[0]).toEqual(
      para(
        text("bold ", [{ type: "strong" }]),
        text("x", [
          { type: "link", attrs: { href: "https://e.x" } },
          { type: "strong" },
        ]),
      ),
    );
  });

  it("writes an empty body as one empty paragraph and reads it back empty", () => {
    expect(markdownToAdf("")).toEqual(doc(para()));
    expect(adfToMarkdown(markdownToAdf(""))).toBe("");
  });

  it("escapes text that would read back as syntax", () => {
    const written = adfToMarkdown(doc(para(text("# a *b* [c] 2. d"))));
    expect(written).toBe("\\# a \\*b\\* \\[c\\] 2. d");
    expect(adfToMarkdown(markdownToAdf(written))).toBe(written);
  });
});

describe("ADF: reading what only Jira writes", () => {
  it("renders mentions, emoji, cards, status, dates and media as plain Markdown", () => {
    const md = adfToMarkdown(
      doc(
        para(
          { type: "mention", attrs: { id: "abc", text: "@Dana Lee" } },
          text(" "),
          { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
          text(" "),
          { type: "emoji", attrs: { shortName: ":jig:" } },
          text(" "),
          { type: "inlineCard", attrs: { url: "https://example.com/c" } },
          text(" "),
          { type: "status", attrs: { text: "BLOCKED", color: "red" } },
          text(" "),
          {
            type: "date",
            attrs: { timestamp: String(Date.parse("2026-10-31T00:00:00Z")) },
          },
        ),
        {
          type: "mediaSingle",
          content: [
            {
              type: "media",
              attrs: { id: "m", type: "file", alt: "screenshot.png" },
            },
          ],
        },
      ),
    );
    expect(md).toBe(
      "@Dana Lee 🎉 :jig: https://example.com/c BLOCKED 2026-10-31\n\n[screenshot.png]",
    );
  });

  it("renders panels, expands, task and decision lists", () => {
    const md = adfToMarkdown(
      doc(
        {
          type: "panel",
          attrs: { panelType: "info" },
          content: [para(text("Note"))],
        },
        {
          type: "expand",
          attrs: { title: "Details" },
          content: [para(text("Hidden"))],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [text("shipped")],
            },
            {
              type: "taskItem",
              attrs: { state: "TODO" },
              content: [text("test")],
            },
          ],
        },
        {
          type: "decisionList",
          content: [{ type: "decisionItem", content: [text("use ADF")] }],
        },
      ),
    );
    expect(md).toBe(
      "> Note\n\n**Details**\n\nHidden\n\n- [x] shipped\n- [ ] test\n\n- use ADF",
    );
  });

  it("yields an unknown node's text and drops an unknown mark", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "futureBlock", content: [para(text("inside"))] },
          para(
            text("colored", [
              { type: "textColor", attrs: { color: "#f00" } },
              { type: "strong" },
            ]),
          ),
        ),
      ),
    ).toBe("inside\n\n**colored**");
  });

  it("reads a missing description as empty", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
  });
});
