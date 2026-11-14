import { expect, test } from "bun:test";
import { chapterBody, indexBody, schemaResource } from "./protocol.ts";
import { siteRoute } from "./routes.ts";

test("Protocol filenames become chapter routes", () => {
  expect(siteRoute("plugin/protocol/README.md")).toBe("/protocol/");
  expect(siteRoute("plugin/protocol/drive-exits.md")).toBe(
    "/protocol/drive-exits/",
  );
});

test("generated rows get distinct linkable value anchors, preserving prose", () => {
  const source =
    "# Chapter\n\nVersion 1 · stable\n\nProse.\n\n<!-- protocol:generated source=x -->\n\n| Value | Meaning |\n| --- | --- |\n| `A_B` | first |\n| `A-B` | second |\n| `A_B` | third |\n\n<!-- /protocol:generated -->";
  const body = chapterBody(source);
  expect(body).toContain("Prose.");
  expect(body).not.toContain("Version 1");
  expect(body).toContain('id="value-A_B"');
  expect(body).toContain('href="#value-A-B"');
  expect(body).toContain('id="value-A_B-2"');
});

test("schema ids place the unchanged schema at its chapter and version", () => {
  const text =
    '{"$id":"https://example.com/schemas/mailbox/2/message.json","type":"object"}\n';
  expect(
    schemaResource(text, "message.json", [{ chapter: "mailbox", version: 2 }]),
  ).toEqual({
    route: "mailbox/v2/schemas/message.json",
    text,
  });
  expect(() =>
    schemaResource('{"$id":"https://other.test/a"}', "a.json", [
      { chapter: "mailbox", version: 2 },
    ]),
  ).toThrow();
});

test("a chapter's source data link points to its versioned site resource", () => {
  expect(
    chapterBody("[Data](data/mailbox.json)", {
      chapter: "mailbox",
      version: 2,
    }),
  ).toBe("[Data](/protocol/mailbox/v2/data.json)");
});

test("punctuated values have browser-safe anchors and remain distinct", () => {
  const body = chapterBody(
    "<!-- protocol:generated source=x -->\n| Value | Meaning |\n| --- | --- |\n| `hitl:legal` | first |\n| `hitl-3Alegal` | second |\n<!-- /protocol:generated -->",
  );
  expect(body).toContain('id="value-hitl-3Alegal" href="#value-hitl-3Alegal"');
  expect(body).toContain('id="value-hitl-3Alegal-2"');
  expect(body).not.toContain("%3A");
});

test("the index links every data file to the chapter's published version", () => {
  expect(
    indexBody("# Protocol\n\n[Data](data/mailbox.json)", [
      { chapter: "mailbox", version: 2 },
    ]),
  ).toBe("\n[Data](/protocol/mailbox/v2/data.json)");
});
