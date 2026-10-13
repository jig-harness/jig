/**
 * The whole decision loop: a sheet rendered from an audit, the decisions its
 * copy button writes, and `record.ts apply-feedback` recording them with the
 * sheet itself as the report.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecord } from "../scripts/lib/record.ts";
import { feedbackText } from "../scripts/report/feedback-text.ts";
import { renderReportHtml } from "../scripts/report/html.ts";
import { reportFingerprint } from "../scripts/report/source.ts";
import { cleanEnv, runScript } from "./helpers.ts";
import { recordText, reportInput } from "./report-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "jig-audit-round-trip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("decisions copied from a sheet are recorded against that sheet", () => {
  const input = reportInput();
  const sheet = join(dir, "sheet.html");
  const record = join(dir, "jig-audit.yaml");
  const decisions = join(dir, "decisions.yaml");
  writeFileSync(sheet, renderReportHtml(input));
  writeFileSync(record, recordText());
  const text = feedbackText(
    {
      repository: input.source.repository.name,
      commit: input.record.commit,
      report: reportFingerprint(input.source.recommendations),
      date: input.record.date,
      recommendations: input.source.recommendations,
    },
    {
      decisions: {
        R1: { choice: "accept" },
        R3: { choice: "lighter", note: "start with the release workflow" },
        R4: { choice: "refine", note: "use the test script" },
        R5: {
          choice: "decline",
          reason: "Two maintainers decide in pull requests.",
          revisit_when: "a third maintainer joins",
        },
      },
    },
  );
  // Pasted into a conversation, the block arrives with words around it.
  writeFileSync(decisions, `Here are our decisions:\n\n${text}\n\nThanks!\n`);

  const run = runScript(
    "record.ts",
    ["apply-feedback", decisions, "--report", sheet, record],
    dir,
    cleanEnv(),
  );
  expect(run.err).toBe("");
  expect(run.code).toBe(0);

  const after = parseRecord(readFileSync(record, "utf8"), record);
  expect(after.declined.map((d) => d.refs)).toEqual([
    ["M5/adrs-exist-numbered-from-template"],
  ]);
  expect(after.declined[0]?.revisit_when).toBe("a third maintainer joins");
  // Configuration first, then modules in adoption order; the lighter choice
  // reaches the work as its note.
  const work = run.out.slice(run.out.indexOf("Work, in adoption order"));
  expect(work.indexOf("R4")).toBeLessThan(work.indexOf("R1"));
  expect(work).toContain(
    "the lighter option: Pin the actions to commit hashes by hand now",
  );
  expect(work).toContain("(note: start with the release workflow)");
  expect(work).toContain("(the full action, not chosen: ");
});
