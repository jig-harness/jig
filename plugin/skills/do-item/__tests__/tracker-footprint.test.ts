import { expect, test } from "bun:test";
import {
  footprintBody,
  readFootprint,
  selectFootprint,
} from "../../../shared/footprint.ts";
import {
  adfToMarkdown,
  markdownToAdf,
} from "../scripts/lib/tracker/jira/adf.ts";

const record = {
  key: "#42",
  at: "2026-11-14T17:30:00.000Z",
  source: "pickup" as const,
  base: "abcdef0123456789",
  paths: ["plugin/shared/", "plugin/jig.ts"],
  areas: ["shared"],
  pickup: "session-42",
  writer: { host: "digest", login: "writer" },
};
test("multiline records round trip through tracker markup, including Jira", () => {
  const body = footprintBody(record);
  expect(readFootprint(body, "#42")).toEqual(record);
  expect(readFootprint(adfToMarkdown(markdownToAdf(body)), "#42")).toEqual(
    record,
  );
  expect(
    readFootprint(adfToMarkdown(markdownToAdf(`Introduction\n${body}`)), "#42"),
  ).toEqual(record);
});
test("only trusted, valid records for this item count; active pickup wins", () => {
  const old = { ...record, at: "2026-11-14T17:00:00.000Z" };
  const newer = {
    ...record,
    source: "scout" as const,
    pickup: undefined,
    at: "2026-11-14T18:00:00.000Z",
  };
  const comments = [old, newer].map((r) => ({
    body: footprintBody(r),
    createdAt: r.at,
    trusted: true,
  }));
  comments.push({
    body: footprintBody({ ...record, at: "2026-11-14T19:00:00.000Z" }),
    createdAt: record.at,
    trusted: false,
  });
  expect(selectFootprint("#42", comments, "session-42")).toEqual(old);
  expect(selectFootprint("#42", comments)).toEqual(newer);
  expect(selectFootprint("#43", comments)).toBeNull();
});
test("paths cannot escape the repository or carry glob syntax", () => {
  for (const path of [
    "/tmp/a",
    "../a",
    "a/../b",
    "C:/a",
    "a\\b",
    "a/**",
    "./a",
    "a//b",
    "a\nfile",
  ]) {
    expect(() => footprintBody({ ...record, paths: [path] })).toThrow();
  }
  expect(
    readFootprint(footprintBody(record).replace('"v":1', '"v":99'), record.key),
  ).toBeNull();
});
test("published shape rejects paths and identifiers that local readers reject", () => {
  for (const paths of [["src/**"], ["/tmp/file"], ["../escape"]])
    expect(() => footprintBody({ ...record, paths })).toThrow();
  expect(() => footprintBody({ ...record, base: "abcdef0\n" })).toThrow();
  expect(() => footprintBody({ ...record, areas: ["shared\n"] })).toThrow();
});
