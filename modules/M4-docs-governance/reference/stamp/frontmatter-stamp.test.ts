import { describe, expect, test } from "bun:test";
import {
  extractLastUpdated,
  normalizeLastUpdated,
  stampLastUpdated,
  stickyDate,
  utcToday,
} from "./frontmatter-stamp";

const page = (date: string, body = "Body.", owner = "docs") =>
  `---\ntitle: Report\nlast_updated: ${date}\nowner: ${owner}\n---\n\n${body}\n`;

describe("utcToday", () => {
  test("is the UTC date, not the local one", () => {
    // 23:30 at UTC-5 on the 1st is already the 2nd in UTC.
    expect(utcToday(new Date("2026-03-01T23:30:00-05:00"))).toBe("2026-03-02");
  });
});

describe("stampLastUpdated", () => {
  test("replaces the frontmatter value", () => {
    expect(stampLastUpdated(page("2026-01-01"), "2026-02-02")).toBe(
      page("2026-02-02"),
    );
  });
  test("leaves a last_updated: line in the body alone", () => {
    const text = page("2026-01-01", "```yaml\nlast_updated: 2020-01-01\n```");
    const stamped = stampLastUpdated(text, "2026-02-02");
    expect(stamped).toContain("last_updated: 2026-02-02\nowner");
    expect(stamped).toContain("last_updated: 2020-01-01\n```");
  });
  test("reads the frontmatter at every YAML line break, as the stale gate does", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const text = page("2026-01-01").replaceAll("\n", eol);
      expect(stampLastUpdated(text, "2026-02-02")).toBe(
        page("2026-02-02").replaceAll("\n", eol),
      );
      expect(extractLastUpdated(text)).toBe("2026-01-01");
    }
  });
  test("stamps a key written with space before its colon", () => {
    const text = page("2026-01-01").replace("last_updated:", "last_updated :");
    expect(extractLastUpdated(text)).toBe("2026-01-01");
    expect(stampLastUpdated(text, "2026-02-02")).toBe(page("2026-02-02"));
  });
  test("reads the value as the shared reader does, comment and quotes included", () => {
    const commented = page("2026-01-01 # set by hand");
    expect(extractLastUpdated(commented)).toBe("2026-01-01");
    expect(stampLastUpdated(commented, "2026-02-02")).toBe(page("2026-02-02"));
    expect(extractLastUpdated(page("'2026-01-01'"))).toBe("2026-01-01");
  });
  test("refuses a value that continues past its key line", () => {
    for (const form of ["|-\n  2026-01-01", ">-\n  2026-01-01"])
      expect(extractLastUpdated(page(form))).toBe("2026-01-01");
    for (const form of ["|-\n  2026-01-01", ">\n  2026-01-01"])
      expect(() => stampLastUpdated(page(form), "2026-02-02")).toThrow(
        "continues past the key line",
      );
  });
  test("refuses frontmatter the shared reader reports an error in", () => {
    for (const text of [
      page("\n  2026-01-01"),
      page("2026-01-01\n  continuation"),
      page('"2026-01-01\n  continued"'),
      page("2026-01-01", "Body.", "docs\n  continuation"),
    ])
      expect(() => stampLastUpdated(text, "2026-02-02")).toThrow(
        "does not read cleanly",
      );
  });
  test("refuses unreadable frontmatter even where no last_updated: line is found", () => {
    for (const text of [
      '---\n"last_updated": 2026-01-01\n---\nBody.\n',
      "---\nlast_updated: 2026-01-01\nBody.\n",
      "---\ntitle: A\ntitle: B\n---\nBody.\n",
      "---\ntitle: Report\n",
    ])
      expect(() => stampLastUpdated(text, "2026-02-02")).toThrow(
        "does not read cleanly",
      );
  });
  test("returns readable frontmatter without last_updated: unchanged", () => {
    const text = "---\ntitle: Report\n---\nBody.\n";
    expect(stampLastUpdated(text, "2026-02-02")).toBe(text);
  });
  test("returns content without frontmatter unchanged", () => {
    expect(stampLastUpdated("# No frontmatter\n", "2026-02-02")).toBe(
      "# No frontmatter\n",
    );
  });
});

describe("normalizeLastUpdated and extractLastUpdated", () => {
  test("only the date line is set aside", () => {
    expect(normalizeLastUpdated(page("2026-01-01"))).toBe(
      normalizeLastUpdated(page("2026-05-05")),
    );
    expect(normalizeLastUpdated(page("2026-01-01"))).not.toBe(
      normalizeLastUpdated(page("2026-01-01", "Body.", "operations")),
    );
  });
  test("reads the frontmatter value only", () => {
    expect(extractLastUpdated(page("2026-01-01"))).toBe("2026-01-01");
    expect(extractLastUpdated("# x\nlast_updated: 2026-01-01\n")).toBeNull();
  });
});

describe("stickyDate", () => {
  const today = "2026-09-09";
  test("a new file gets today", () => {
    expect(stickyDate(null, page(today), today)).toBe(today);
  });
  test("an unchanged body keeps the existing date", () => {
    expect(stickyDate(page("2026-01-01"), page(today), today)).toBe(
      "2026-01-01",
    );
  });
  test("a changed body advances to today", () => {
    expect(
      stickyDate(page("2026-01-01"), page(today, "New body."), today),
    ).toBe(today);
  });
  test("a hand edit to other frontmatter is drift, so today", () => {
    expect(
      stickyDate(page("2026-01-01", "Body.", "operations"), page(today), today),
    ).toBe(today);
  });
});
