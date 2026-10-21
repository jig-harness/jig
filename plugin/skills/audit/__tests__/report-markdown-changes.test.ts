/**
 * The Markdown copy of the audit sheet: what changed since the prior audit,
 * row by row, and how the criteria still open are counted against the
 * profile's target. Kept apart from the rest of the sheet's tests because the
 * expected rows list every criterion added since the prior record, so the
 * list grows with the criteria.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import { noProfile, priorRecord, reportInput } from "./report-fixtures.ts";

describe("the Markdown copy: changes since the last audit", () => {
  test("lists the criteria still open within the target, and only counts those beyond it", () => {
    const text = renderReportMarkdown(reportInput({ prior: priorRecord() }));
    expect(text).toContain(
      readFileSync(
        new URL("./fixtures/report/prior-changes.md", import.meta.url),
        "utf8",
      ).trimEnd(),
    );
    const none = renderReportMarkdown(
      reportInput({ prior: priorRecord(), source: noProfile }),
    );
    expect(none).toContain(
      "Compared with the audit of 2026-07-19 (plugin 0.14.0): 82 still open, 36 unchanged and met.",
    );
    expect(none).not.toContain("Still open");
    expect(none).not.toContain("beyond the target");
  });
});
