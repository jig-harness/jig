/**
 * The whole decision loop: a sheet rendered from an audit, the decisions its
 * copy button writes, and `record.ts apply-feedback` recording them with the
 * sheet itself as the report; and the scoring loop before it, from a draft
 * scoped to a profile, through workers' partial drafts, to a record that
 * checks.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModules } from "../scripts/lib/criteria.ts";
import { parseRecord, unscored } from "../scripts/lib/record.ts";
import { feedbackText } from "../scripts/report/feedback-text.ts";
import { renderReportHtml } from "../scripts/report/html.ts";
import { reportFingerprint } from "../scripts/report/source.ts";
import { cleanEnv, runScript, scratchRepo } from "./helpers.ts";
import { recordText, reportInput } from "./report-fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "jig-audit-round-trip-"));
const repos: string[] = [];
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

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
  // Ranked as the sheet's Start here; the lighter choice reaches the work as
  // its note.
  const work = run.out.slice(run.out.indexOf("Work, ranked as"));
  expect(work.indexOf("R1")).toBeLessThan(work.indexOf("R3"));
  expect(work.indexOf("R3")).toBeLessThan(work.indexOf("R4"));
  expect(work).toContain(
    "the lighter option: Pin the actions to commit hashes by hand now",
  );
  expect(work).toContain("(note: start with the release workflow)");
  expect(work).toContain("(the full action, not chosen: ");
});

test("conditional targets and wrong scores copied from a sheet are recorded against that sheet", () => {
  const input = reportInput();
  const sheet = join(dir, "sheet-conditions.html");
  const record = join(dir, "jig-audit-conditions.yaml");
  const decisions = join(dir, "decisions-conditions.yaml");
  writeFileSync(sheet, renderReportHtml(input));
  writeFileSync(record, recordText());
  const scored = input.record.criteria.get("M3/consumer-view-generated");
  writeFileSync(
    decisions,
    feedbackText(
      {
        repository: input.source.repository.name,
        commit: input.record.commit,
        report: reportFingerprint(input.source.recommendations),
        date: input.record.date,
        recommendations: input.source.recommendations,
      },
      {
        profile: "team-standard",
        conditions: ["M12"],
        decisions: { R1: { choice: "accept" } },
        scores: {
          "M3/consumer-view-generated": "The docs build generates the view.",
        },
      },
    ),
  );

  const run = runScript(
    "record.ts",
    ["apply-feedback", decisions, "--report", sheet, record],
    dir,
    cleanEnv(),
  );
  expect(run.err).toBe("");
  expect(run.code).toBe(0);

  const after = parseRecord(readFileSync(record, "utf8"), record);
  expect(after.profile).toBe("team-standard");
  expect(after.profile_conditions).toEqual(["M12"]);
  // The score the team says is wrong is left for the agent to re-examine.
  expect(after.criteria.get("M3/consumer-view-generated")).toEqual(scored);
  expect(run.out).toContain("- profile_conditions: [M12] (now applies: M12)");
  expect(run.out).toContain(
    "This score is wrong (calibration notes: re-examine; the score is not changed):",
  );
  expect(run.out).toContain(
    `- M3/consumer-view-generated (${input.modules.flatMap((m) => m.criteria).find((c) => c.key === "M3/consumer-view-generated")?.statement}): scored ${scored?.score}; evidence: ${scored?.evidence}`,
  );
  expect(run.out).toContain(
    "  the team's note: The docs build generates the view.",
  );
});

test("a draft scoped to a profile, scored by two workers, merges into a record that checks", () => {
  const repo = scratchRepo({
    "AGENTS.md": "# Agents\n",
    "docs/notes.md": "a\nb\n",
  });
  repos.push(repo);
  const draft = join(dir, "scoped.yaml");
  const scoped = runScript(
    "score.ts",
    ["--draft", draft, "--profile", "solo-lite"],
    repo,
  );
  expect(scoped.err).toBe("");
  expect(scoped.code).toBe(0);
  const open = unscored(
    parseRecord(readFileSync(draft, "utf8"), draft),
    loadModules(),
  );
  expect(open.length).toBeGreaterThan(0);
  // Each worker scores half of what is left, in its own copy of the draft.
  const half = Math.ceil(open.length / 2);
  const partials = [open.slice(0, half), open.slice(half)].map((keys, i) => {
    const answers = join(dir, `worker-${i}.txt`);
    writeFileSync(
      answers,
      keys.map((k) => `${k}: convention | docs/notes.md:2`).join("\n"),
    );
    const into = join(dir, `worker-${i}.yaml`);
    const fill = runScript(
      "record.ts",
      ["fill", draft, answers, "--into", into],
      repo,
    );
    expect(fill.code).toBe(0);
    return into;
  });
  const merged = runScript("record.ts", ["merge", draft, ...partials], repo);
  expect(merged.err).toBe("");
  expect(merged.code).toBe(0);
  expect(merged.out).toContain("every criterion is scored");

  const check = runScript("record.ts", ["check", draft], repo);
  expect(check.out).not.toContain("warning:");
  expect(check.code).toBe(0);
  expect(check.out).toMatch(
    /record complete: \d+ criteria scored \(\d+ not examined\)/,
  );
  const summary = runScript(
    "record.ts",
    ["summary", draft, "--profile", "solo-lite"],
    repo,
  );
  expect(summary.code).toBe(0);
  expect(summary.out).toContain(
    "| M3 change-area-catalog | not examined | — | — |",
  );
});
