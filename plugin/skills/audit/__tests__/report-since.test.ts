/**
 * The audit sheet's Markdown copy, compared with an earlier audit: what is
 * still open within the profile's target, what lies beyond it, and what
 * changed since.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import { noProfile, priorRecord, reportInput } from "./report-fixtures.ts";

describe("the Markdown copy, since the last audit", () => {
  test("lists the criteria still open within the target, and only counts those beyond it", () => {
    const text = renderReportMarkdown(reportInput({ prior: priorRecord() }));
    // The fixture holds the historical changes; rows added after its audit
    // are checked against the live catalog in report-markdown.test.ts.
    const historicalChanges = (markdown: string) =>
      markdown
        .replace(/### What changed \(\d+\)/, "### What changed")
        .split("\n")
        .filter((line) => !line.endsWith("| Added by Jig |"))
        .join("\n");
    expect(historicalChanges(text)).toContain(
      historicalChanges(
        readFileSync(
          new URL("./fixtures/report/prior-changes.md", import.meta.url),
          "utf8",
        ).trimEnd(),
      ),
    );
    const none = renderReportMarkdown(
      reportInput({ prior: priorRecord(), source: noProfile }),
    );
    expect(none).toContain(
      "Compared with the audit of 2026-07-19 (plugin 0.14.0): 86 still open, 32 unchanged and met.",
    );
    expect(none).not.toContain("Still open");
    expect(none).not.toContain("beyond the target");
  });
});
