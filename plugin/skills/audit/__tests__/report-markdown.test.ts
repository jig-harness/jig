/** The audit report's Markdown copy: sections, escaping, gaps and history. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import {
  addedAfter,
  historyRecord,
  noProfile,
  priorRecord,
  recordText,
  reportInput,
} from "./report-fixtures.ts";

describe("the Markdown copy", () => {
  const md = renderReportMarkdown(
    reportInput({ record: recordText(["heading_to: team-standard"]) }),
  );

  test("has the sheet's sections in the same order", () => {
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual([
      "In short",
      "Maturity map",
      "Start here",
      "Recommendations",
      "Module detail",
      "Configuration fit",
      "Drift",
      "What was examined",
      "Terms",
    ]);
    expect(md).toContain("### As you grow (2)");
    expect(md).toContain(
      "| M0 Instruction architecture: Agents and new contributors",
    );
    expect(md).toContain(
      "- **Lighter option:** Pin the actions to commit hashes by hand now",
    );
  });

  test("writes the source's text as text, never as Markdown", () => {
    const hostile = renderReportMarkdown(
      reportInput({
        source: (s) => {
          s.summary = "*bold* [link](x) <b>";
        },
      }),
    );
    expect(hostile).toContain("\\*bold\\* \\[link\\](x) \\<b\\>");
  });

  test("fences the starter configuration so nothing in it can close the fence", () => {
    expect(md).toContain("```yaml\n# Starter .config/jig.yaml");
  });

  test("lists the gaps no recommendation covers, and counts them", () => {
    expect(md).toContain("- 2 gaps no recommendation covers");
    expect(md).toContain(
      "### Not covered by a recommendation (2)\n\nCriteria within the target that do not meet their bar",
    );
    expect(md).toContain("- `M0/glossary-exists`: ");
    expect(md).toMatch(
      /\| \*\*glossary-exists\*\*: .* \| \*\*absent\*\* \(needed for the target, not met yet; a gap no recommendation covers\) \|/,
    );
  });

  test("lists the criteria still open within the target, and only counts those beyond it", () => {
    const text = renderReportMarkdown(reportInput({ prior: priorRecord() }));
    const added = addedAfter("0.14.0");
    expect(text).toContain(`### What changed (${added.length + 1})`);
    // Keep the snapshot's historical changes stable as the catalog grows.
    // Check the added rows against today's catalog separately.
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
    const addedRows = text
      .split("\n")
      .filter((line) => line.endsWith("| Added by Jig |"));
    expect(addedRows).toHaveLength(added.length);
    for (const key of added) {
      const [module, criterion] = key.split("/");
      expect(
        addedRows.some(
          (line) =>
            line.startsWith(`| ${module} `) &&
            line.includes(`| \`${criterion}\` | not scored → `),
        ),
      ).toBe(true);
    }
    const none = renderReportMarkdown(
      reportInput({ prior: priorRecord(), source: noProfile }),
    );
    expect(none).toContain(
      "Compared with the audit of 2026-07-19 (plugin 0.14.0): 82 still open, 36 unchanged and met.",
    );
    expect(none).not.toContain("Still open");
    expect(none).not.toContain("beyond the target");
  });

  test("writes the trend as the sheet does", () => {
    const text = renderReportMarkdown(
      reportInput({ prior: priorRecord(), history: [historyRecord()] }),
    );
    expect(text).toContain(
      [
        "### Trend",
        "",
        "1 module moved up since 2026-04-02.",
        "",
        "Each module's level at every audit given, oldest first, for the modules whose level changed.",
        "",
        "| Module | 2026-04-02 | 2026-07-19 | Now 2026-10-12 |",
        "|--------|---|---|---|",
        "| M2 Generated artifact freshness | none | ↑ Lite | Lite |",
      ].join("\n"),
    );
    expect(text).not.toContain("### Levels that changed");
  });

  test("names the signals to revisit the profile beside it", () => {
    const text = renderReportMarkdown(
      reportInput({
        source: (s) => {
          (s.profile as Record<string, unknown>).signals = [
            { text: "A deploy workflow appeared.", evidence: ["deploy.yml"] },
          ];
        },
      }),
    );
    expect(text).toContain(
      "**Profile:** Solo/Lite (suggested; worth revisiting).",
    );
    expect(text).toContain(
      "**Worth revisiting the profile.** Facts that suggest",
    );
    expect(text).toContain(
      "- A deploy workflow appeared. *Evidence:* `deploy.yml`",
    );
  });
});
