import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModules } from "../scripts/lib/criteria.ts";
import {
  changesRecord,
  checkEdited,
  editRecordText,
  type Feedback,
  FeedbackRefused,
  type FeedbackPlan,
  parseFeedback,
  planFeedback,
  readReportView,
  renderPlan,
} from "../scripts/lib/feedback.ts";
import { loadProfiles } from "../scripts/lib/profiles.ts";
import { checkRecord, parseRecord } from "../scripts/lib/record.ts";
import { ranked } from "../scripts/report/model.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const modules = loadModules();
const profiles = loadProfiles(modules);
const catalog = { modules, profiles };
const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const TODAY = "2026-10-13";

const scored = modules
  .flatMap((m) => m.criteria)
  .flatMap((c) => [
    `  ${c.key}:   # ${c.level}, requires ${c.requires}`,
    "    # what the criterion asks",
    "    score: absent",
    `    evidence: "nothing found for ${c.id}"`,
  ])
  .join("\n");

/** A complete, commented record; `profile` and `declined` are its lines for those keys. */
function recordText(
  profile = "profile: null   # solo-lite | team-standard | regulated-strict",
  declined = "declined: []   # recommendations the team chose not to take",
): string {
  return [
    "# Jig audit record: written by /jig:audit, read by its next run.",
    "version: 1",
    "plugin_version: 0.16.0",
    'date: "2026-10-13"',
    `commit: ${SHA}`,
    "shape: library   # a package others depend on",
    ...(profile ? [profile] : []),
    "criteria:",
    "  # every module, in order",
    scored,
    ...(declined ? [declined] : []),
    "",
  ].join("\n");
}

const rec = (id: string, refs: string[], leverage: string, effort: string) => ({
  id,
  refs,
  title: `Title of ${id}`,
  finding: "What is true now.",
  action: `Action of ${id}`,
  evidence: ["README.md:1"],
  leverage,
  effort,
});

const reportSource = JSON.stringify({
  v: 1,
  repository: { name: "example/web", url: "https://example.com/web" },
  summary: "A summary.",
  examined: { read: ["the instruction files"] },
  stack: [
    {
      facet: "CI",
      detected: "GitHub Actions",
      evidence: ".github/workflows/ci.yml",
    },
  ],
  drift: [
    {
      text: "The README names a script that does not exist.",
      evidence: ["README.md:3"],
    },
  ],
  recommendations: [
    rec("R1", ["M5/adrs-exist-numbered-from-template"], "high", "small"),
    rec("R2", ["M1/ci-runs-gates-on-pr"], "medium", "small"),
    rec("R3", ["M1/gate-set-documented"], "high", "large"),
    rec("R4", ["M1/precommit-autofix-hooks"], "medium", "medium"),
    rec("R5", ["M2/derived-inventory-exists"], "low", "small"),
    rec("R6", ["config/suggestion:gates.command"], "low", "large"),
    rec("R7", ["M1/escape-hatch-documented"], "high", "small"),
  ],
});
const report = readReportView(reportSource, "report.json");

const block = (body: string) =>
  `# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
audit_feedback:
  v: 1
  repository: "example/web"
  commit: "${SHA}"
  report: "${report.fingerprint}"
${body}`;

const FULL = block(`  profile: team-standard
  accept: [R1, R3, R6, R7]
  refine:
    - { id: R2, note: "Use the existing lint job, not a new one." }
  decline:
    - { id: R4, refs: ["M1/precommit-autofix-hooks"], reason: "The editor formats on save.", revisit_when: "formatting failures reach CI" }
  wrong:
    - { id: R5, refs: ["M2/derived-inventory-exists"], note: "dist/ is not committed." }
`);

const plan = (text: string, record = recordText()): FeedbackPlan =>
  planFeedback(parseFeedback(text), {
    record: parseRecord(record, "record.yaml"),
    report,
    modules,
    profiles,
    today: TODAY,
  });

const refusedWith = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof FeedbackRefused) return error.problems;
    throw error;
  }
  throw new Error("not refused");
};

describe("parsing a feedback block", () => {
  test("reads every choice", () => {
    const f: Feedback = parseFeedback(FULL);
    expect(f.repository).toBe("example/web");
    expect(f.commit).toBe(SHA);
    expect(f.profile).toBe("team-standard");
    expect(f.accept).toEqual(["R1", "R3", "R6", "R7"]);
    expect(f.refine).toEqual([
      { id: "R2", note: "Use the existing lint job, not a new one." },
    ]);
    expect(f.decline[0]?.revisit_when).toBe("formatting failures reach CI");
    expect(f.wrong[0]?.refs).toEqual(["M2/derived-inventory-exists"]);
  });

  test("finds the block in pasted text around it", () => {
    const pasted = `Here are our decisions from the sheet:\n\n\`\`\`yaml\n${FULL}\`\`\`\n\nThanks!\n`;
    expect(parseFeedback(pasted)).toEqual(parseFeedback(FULL));
    const indented = FULL.split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    expect(parseFeedback(`Pasted:\n${indented}\nDone.`)).toEqual(
      parseFeedback(FULL),
    );
  });

  test("a block with no choices is empty, not refused", () => {
    const f = parseFeedback(block(""));
    expect([f.accept, f.refine, f.decline, f.wrong]).toEqual([[], [], [], []]);
    expect(f.profile).toBeUndefined();
  });

  test.each([
    ["no block", "We accept everything."],
    ["two blocks", `${FULL}\n${FULL}`],
    ["an unknown key", block("  approve: [R1]\n")],
    [
      "an unknown key in a choice",
      block('  refine:\n    - { id: R2, text: "x" }\n'),
    ],
    [
      "a duplicate id across choices",
      block("  accept: [R1]\n  refine:\n    - { id: R1 }\n"),
    ],
    ["a duplicate id in one choice", block("  accept: [R1, R1]\n")],
    ["an id that is not R<n>", block("  accept: [rec-1]\n")],
    [
      "a decline without a reason",
      block(
        '  decline:\n    - { id: R4, refs: ["M1/precommit-autofix-hooks"], revisit_when: "w" }\n',
      ),
    ],
    [
      "a decline with an empty revisit condition",
      block(
        '  decline:\n    - { id: R4, refs: ["M1/precommit-autofix-hooks"], reason: "r", revisit_when: " " }\n',
      ),
    ],
    [
      "a decline without refs",
      block('  decline:\n    - { id: R4, reason: "r", revisit_when: "w" }\n'),
    ],
    [
      "a malformed ref",
      block('  wrong:\n    - { id: R5, refs: ["derived"] }\n'),
    ],
    ["another version", block("").replace("v: 1", "v: 2")],
    ["invalid YAML", block("  accept: [R1\n")],
  ])("refuses %s", (_, text) => {
    expect(refusedWith(() => parseFeedback(text)).length).toBeGreaterThan(0);
  });
});

describe("planning against the audit", () => {
  test("refuses a block for another repository or commit", () => {
    const other = FULL.replace('"example/web"', '"example/api"').replace(
      SHA,
      "f".repeat(40),
    );
    const problems = refusedWith(() => plan(other));
    expect(problems).toContain(
      "the block is for example/api; the report is for example/web",
    );
    expect(problems.some((p) => p.includes("record audited"))).toBe(true);
  });

  test("refuses a block made on another version of the report, or a sheet of another record", () => {
    const stale = FULL.replace(report.fingerprint, "000000000000");
    expect(refusedWith(() => plan(stale))[0]).toContain(
      "the block was made on another version of the report",
    );
    const sheetOfOther = { ...report, recordCommit: "f".repeat(40) };
    const problems = refusedWith(() =>
      planFeedback(parseFeedback(FULL), {
        record: parseRecord(recordText(), "record.yaml"),
        report: sheetOfOther,
        modules,
        profiles,
        today: TODAY,
      }),
    );
    expect(problems[0]).toContain(
      "the sheet was rendered with the record of commit",
    );
  });

  test("refuses an id the report does not have", () => {
    expect(refusedWith(() => plan(block("  accept: [R9]\n")))).toEqual([
      "R9: the report has no such recommendation",
    ]);
  });

  test("refuses refs that differ from the recommendation's", () => {
    const problems = refusedWith(() =>
      plan(
        block(
          '  decline:\n    - { id: R4, refs: ["M1/gate-set-documented"], reason: "r", revisit_when: "w" }\n  wrong:\n    - { id: R5, refs: ["M2/hand-editing-forbidden"] }\n',
        ),
      ),
    );
    expect(problems.map((p) => p.split(":")[0])).toEqual(["R4", "R5"]);
  });

  test("refuses accepted or refined work on a criterion the record holds", () => {
    const declined = (after: string) =>
      recordText(
        undefined,
        `declined:\n  - refs: ["M1/gate-set-documented"]\n    reason: "later"\n    revisit_when: "the team grows"${after}`,
      );
    const work = block(
      '  accept: [R3]\n  refine:\n    - { id: R7, note: "n" }\n',
    );
    expect(refusedWith(() => plan(work, declined("")))).toEqual([
      "R3: the record declines M1/gate-set-documented and holds it until: the team grows; leave it out, or record the condition as met first",
    ]);
    // Due on its date, the same work is planned.
    const due = plan(work, declined('\n    revisit_after: "2026-10-13"'));
    expect(due.work.map((w) => w.id)).toEqual(["R7", "R3"]);
  });

  test("two declines of the same refs are recorded once, and refused when they differ", () => {
    const source = JSON.parse(reportSource) as {
      recommendations: ReturnType<typeof rec>[];
    };
    source.recommendations.push(
      rec("R8", ["M1/precommit-autofix-hooks"], "low", "small"),
    );
    const twice = readReportView(JSON.stringify(source), "report.json");
    const decide = (second: string) =>
      planFeedback(
        parseFeedback(
          block(`  decline:
    - { id: R4, refs: ["M1/precommit-autofix-hooks"], reason: "r", revisit_when: "w" }
    - { id: R8, refs: ["M1/precommit-autofix-hooks"], reason: "${second}", revisit_when: "w" }
`).replace(report.fingerprint, twice.fingerprint),
        ),
        {
          record: parseRecord(
            recordText(
              undefined,
              'declined:\n  - refs: ["M1/precommit-autofix-hooks"]\n    reason: "old"\n    revisit_when: "w"',
            ),
            "record.yaml",
          ),
          report: twice,
          modules,
          profiles,
          today: TODAY,
        },
      );
    const agreed = decide("r");
    expect(agreed.declined).toMatchObject([{ id: "R4", replaces: 0 }]);
    expect(agreed.alreadyDeclined).toEqual(["R8"]);
    expect(refusedWith(() => decide("another"))).toEqual([
      "R8: declines M1/precommit-autofix-hooks as R4 does, with another reason or condition; decide them once",
    ]);
  });

  test("refuses a profile profiles.yaml does not have, or one that rules out the record's conditions", () => {
    expect(
      refusedWith(() => plan(block("  profile: enterprise\n")))[0],
    ).toContain("profile: enterprise is not one of");
    const conditioned = recordText(
      "profile: team-standard\nprofile_conditions: [M12]",
    );
    expect(
      refusedWith(() => plan(block("  profile: solo-lite\n"), conditioned)),
    ).toEqual([
      "profile_conditions: Solo/Lite has no conditional target for M12",
    ]);
  });

  test("ranks work as the sheet's Start here ranks it: leverage × effort, then the report's order", () => {
    const p = plan(FULL);
    expect(p.work.map((w) => w.id)).toEqual(["R1", "R7", "R2", "R3", "R6"]);
    expect(p.work.find((w) => w.id === "R2")).toMatchObject({
      choice: "refine",
      note: "Use the existing lint job, not a new one.",
    });
  });

  test("lets a quick win break a tie of value, never outrank a more valuable move", () => {
    const quick = JSON.parse(reportSource);
    quick.recommendations = quick.recommendations.map((r: { id: string }) =>
      ["R6", "R7"].includes(r.id) ? { ...r, quick_win: true } : r,
    );
    const view = readReportView(JSON.stringify(quick), "report.json");
    const p = planFeedback(
      parseFeedback(FULL.replace(report.fingerprint, view.fingerprint)),
      {
        record: parseRecord(recordText(), "record.yaml"),
        report: view,
        modules,
        profiles,
        today: TODAY,
      },
    );
    const ids = p.work.map((w) => w.id);
    expect(ids).toEqual(["R7", "R1", "R2", "R3", "R6"]);
    expect(ids).toEqual(
      ranked(view.recommendations.filter((r) => ids.includes(r.id))).map(
        (r) => r.id,
      ),
    );
  });

  test("returns the declines, the profile change and the calibration notes", () => {
    const p = plan(FULL);
    expect(p.declined).toEqual([
      {
        id: "R4",
        entry: {
          refs: ["M1/precommit-autofix-hooks"],
          reason: "The editor formats on save.",
          revisit_when: "formatting failures reach CI",
        },
      },
    ]);
    expect(p.profile).toEqual({ from: null, to: "team-standard" });
    expect(p.wrong[0]?.refs).toEqual([
      {
        ref: "M2/derived-inventory-exists",
        statement: expect.any(String),
        score: "absent",
        evidence: "nothing found for derived-inventory-exists",
      },
    ]);
  });

  test("a profile the record already names is no change", () => {
    const p = plan(
      block("  profile: team-standard\n"),
      recordText("profile: team-standard"),
    );
    expect(p.profile).toBeNull();
  });

  test("renders what was recorded, the work and the calibration notes", () => {
    const out = renderPlan(plan(FULL), { record: "r.yaml", dryRun: false });
    expect(out).toContain("Recorded in r.yaml:");
    expect(out).toContain(
      "- declined R4 [M1/precommit-autofix-hooks]: The editor formats on save.",
    );
    expect(out).toContain(
      "5. R6 [config/suggestion:gates.command] Title of R6 — Action of R6",
    );
    expect(out).toContain(
      "3. R2 [M1/ci-runs-gates-on-pr] Title of R2 — Action of R2 (note: Use the existing lint job, not a new one.)",
    );
    expect(out).toContain("re-examine; the score is not changed");
    expect(out).toContain("scored absent; evidence: nothing found for");
    expect(out).toContain("the team's note: dist/ is not committed.");
  });
});

describe("editing the record", () => {
  const p = plan(FULL);

  /** Apply the plan to `text`; the result must parse, check and keep every comment. */
  function applied(text: string): string {
    const before = parseRecord(text, "r.yaml");
    const edited = editRecordText(text, p);
    expect(checkEdited(before, edited, "r.yaml", p, catalog)).toEqual([]);
    const after = parseRecord(edited, "r.yaml");
    expect(checkRecord(after, modules, profiles)).toEqual([]);
    expect(after.profile).toBe("team-standard");
    const comments = (t: string) =>
      t.split("\n").filter((l) => l.trimStart().startsWith("#")).length;
    expect(comments(edited)).toBe(comments(text));
    for (const c of text.matchAll(/#[^\n]*/g)) expect(edited).toContain(c[0]);
    return edited;
  }

  test("declined: [] becomes a block list and keeps its comment", () => {
    const edited = applied(recordText());
    expect(edited).toContain(
      'declined:   # recommendations the team chose not to take\n  - refs: ["M1/precommit-autofix-hooks"]',
    );
    expect(edited).toContain(
      "profile: team-standard   # solo-lite | team-standard | regulated-strict",
    );
  });

  test("an existing block list gains the entry at its end", () => {
    const existing = `declined:   # held decisions
  # the first one
  - refs: ["M5/numbering-gate-enforced"]
    reason: "Two maintainers."   # for now
    revisit_when: "a third joins"

  # trailing note`;
    const edited = applied(recordText(undefined, existing));
    const after = parseRecord(edited, "r.yaml");
    expect(after.declined.map((d) => d.refs[0])).toEqual([
      "M5/numbering-gate-enforced",
      "M1/precommit-autofix-hooks",
    ]);
    expect(edited.indexOf("M1/precommit")).toBeLessThan(
      edited.indexOf("# trailing note"),
    );
  });

  test("a block list written without indentation keeps its style", () => {
    const existing = `declined:
- refs: ["M5/numbering-gate-enforced"]
  reason: "r"
  revisit_when: "w"`;
    const edited = applied(recordText(undefined, existing));
    expect(edited).toContain('\n- refs: ["M1/precommit-autofix-hooks"]');
  });

  test("a one-line list is rewritten as a block list", () => {
    const edited = applied(
      recordText(
        undefined,
        'declined: [{ refs: ["M5/numbering-gate-enforced"], reason: "r", revisit_when: "w" }]   # held',
      ),
    );
    expect(parseRecord(edited, "r.yaml").declined).toHaveLength(2);
  });

  test("a one-line list keeps every key its entries were written with", () => {
    const edited = applied(
      recordText(
        undefined,
        'declined: [{ refs: ["M5/numbering-gate-enforced"], reason: "r", revisit_when: "w", owner: "maintainers" }]',
      ),
    );
    expect(edited).toContain('    owner: "maintainers"');
    expect(parseRecord(edited, "r.yaml").declined[0]?.other).toEqual({
      owner: "maintainers",
    });
  });

  test("a # inside a quoted value is not taken for a comment", () => {
    const text = recordText(
      undefined,
      'declined: [{ refs: ["M5/numbering-gate-enforced"], reason: "see # 3", revisit_when: "w" }]   # held',
    );
    const edited = editRecordText(text, p);
    expect(edited).toContain("declined:   # held\n");
    expect(parseRecord(edited, "r.yaml").declined[0]?.reason).toBe("see # 3");
  });

  test("a record with Windows line endings keeps them", () => {
    const text = recordText().replaceAll("\n", "\r\n");
    const edited = editRecordText(text, p);
    expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
    expect(parseRecord(edited, "r.yaml").declined).toHaveLength(1);
  });

  test("a record without declined: gains one at its end", () => {
    const edited = applied(recordText(undefined, ""));
    expect(
      edited.endsWith('revisit_when: "formatting failures reach CI"\n'),
    ).toBe(true);
  });

  test("a record without profile: gains one after shape:", () => {
    const edited = applied(recordText(""));
    expect(edited).toContain(
      "shape: library   # a package others depend on\nprofile: team-standard\n",
    );
  });

  test("a profile already set is replaced", () => {
    const edited = applied(recordText("profile: solo-lite   # chosen early"));
    expect(edited).toContain("profile: team-standard   # chosen early");
  });

  test("a multi-line flow list is refused rather than mangled", () => {
    const text = recordText(
      undefined,
      'declined: [\n  { refs: ["M5/numbering-gate-enforced"], reason: "r", revisit_when: "w" }\n]',
    );
    expect(() => editRecordText(text, p)).toThrow("block list");
  });

  test("deciding the same refs again renews the entry, keeping its comments", () => {
    const expired = (list: string) =>
      recordText(
        undefined,
        list === "block"
          ? `declined:
  # decided at the first audit
  - refs: ["M1/precommit-autofix-hooks"]
    reason: "Too early."   # two of us then
    revisit_when: "a second contributor"
    revisit_after: "2026-01-01"
    owner: "maintainers"
  - refs: ["M5/numbering-gate-enforced"]
    reason: "r"
    revisit_when: "w"
    owner: "docs team"`
          : 'declined: [{ refs: ["M1/precommit-autofix-hooks"], reason: "Too early.", revisit_when: "a second contributor", revisit_after: "2026-01-01", owner: "maintainers" }]',
      );
    for (const form of ["block", "one-line"]) {
      const text = expired(form);
      const renewed = plan(FULL, text);
      expect(renewed.declined).toMatchObject([{ id: "R4", replaces: 0 }]);
      expect(renewed.alreadyDeclined).toEqual([]);
      const edited = editRecordText(text, renewed);
      const before = parseRecord(text, "r.yaml");
      expect(checkEdited(before, edited, "r.yaml", renewed, catalog)).toEqual(
        [],
      );
      const after = parseRecord(edited, "r.yaml");
      expect(after.declined).toHaveLength(before.declined.length);
      expect(after.declined[0]).toEqual({
        refs: ["M1/precommit-autofix-hooks"],
        reason: "The editor formats on save.",
        revisit_when: "formatting failures reach CI",
        other: { owner: "maintainers" },
      });
      expect(after.declined.slice(1)).toEqual(before.declined.slice(1));
      if (form === "block")
        for (const comment of [
          "# decided at the first audit",
          "# two of us then",
        ])
          expect(edited).toContain(`\n  ${comment}\n`);
      expect(renderPlan(renewed, { record: "r", dryRun: false })).toContain(
        "- declined again R4 [M1/precommit-autofix-hooks]",
      );
    }
  });

  test("an edit that changes an entry it does not renew fails the check", () => {
    const text = recordText(
      undefined,
      `declined:
  - refs: ["M5/numbering-gate-enforced"]
    reason: "r"
    revisit_when: "w"
    owner: "maintainers"`,
    );
    const before = parseRecord(text, "r.yaml");
    const edited = editRecordText(text, p).replace(
      '    owner: "maintainers"\n',
      "",
    );
    expect(checkEdited(before, edited, "r.yaml", p, catalog)).toContain(
      "declined: entry 1 no longer reads as it did",
    );
  });

  test("applying the same feedback again adds nothing", () => {
    const once = editRecordText(recordText(), p);
    const again = plan(FULL, once);
    expect(again.declined).toEqual([]);
    expect(again.alreadyDeclined).toEqual(["R4"]);
    expect(again.profile).toBeNull();
    expect(renderPlan(again, { record: "r", dryRun: false })).toContain(
      "Nothing new to record in r.",
    );
  });
});

describe("conditional targets and wrong scores", () => {
  const TEAM = "profile: team-standard   # chosen at the first audit";
  const FLAG =
    '  scores:\n    - { ref: "M1/ci-runs-gates-on-pr", note: "CI runs the gates on every pull request." }\n';

  test("reads both keys, and an older block without them", () => {
    const f = parseFeedback(
      block(
        '  profile_conditions: [M12, M3]\n  scores:\n    - { ref: "M3/consumer-view-generated", note: "Generated by the docs build." }\n',
      ),
    );
    expect(f.profile_conditions).toEqual(["M12", "M3"]);
    expect(f.scores).toEqual([
      {
        ref: "M3/consumer-view-generated",
        note: "Generated by the docs build.",
      },
    ]);
    const older = parseFeedback(FULL);
    expect(older.profile_conditions).toBeUndefined();
    expect(older.scores).toEqual([]);
    expect(
      parseFeedback(block("  profile_conditions: []\n")).profile_conditions,
    ).toEqual([]);
  });

  test.each([
    ["conditions that are not a list", "  profile_conditions: M12\n"],
    [
      "a condition that is not a module",
      "  profile_conditions: [M12, parallel]\n",
    ],
    ["a condition named twice", "  profile_conditions: [M12, M12]\n"],
    [
      "a score flag without a note",
      '  scores:\n    - { ref: "M3/consumer-view-generated" }\n',
    ],
    [
      "a score flag with an empty note",
      '  scores:\n    - { ref: "M3/consumer-view-generated", note: " " }\n',
    ],
    [
      "a score flag on a configuration finding",
      '  scores:\n    - { ref: "config/x", note: "n" }\n',
    ],
    [
      "a score flag with an unknown key",
      '  scores:\n    - { ref: "M3/consumer-view-generated", note: "n", score: "mechanical" }\n',
    ],
    [
      "a criterion flagged twice",
      '  scores:\n    - { ref: "M3/consumer-view-generated", note: "a" }\n    - { ref: "M3/consumer-view-generated", note: "b" }\n',
    ],
  ])("refuses %s", (_, body) => {
    expect(refusedWith(() => parseFeedback(block(body))).length).toBe(1);
  });

  test("refuses conditions the profile that will apply does not have, or with no profile", () => {
    expect(
      refusedWith(() => plan(block("  profile_conditions: [M12]\n"))),
    ).toEqual(["profile_conditions: set without a profile"]);
    expect(
      refusedWith(() =>
        plan(block("  profile_conditions: [M5]\n"), recordText(TEAM)),
      ),
    ).toEqual([
      "profile_conditions: Team/Standard has no conditional target for M5",
    ]);
    // The profile the block chooses is the one the conditions are checked against.
    expect(
      refusedWith(() =>
        plan(
          block("  profile: solo-lite\n  profile_conditions: [M12]\n"),
          recordText(TEAM),
        ),
      ),
    ).toEqual([
      "profile_conditions: Solo/Lite has no conditional target for M12",
    ]);
    expect(
      plan(block("  profile: team-standard\n  profile_conditions: [M12]\n"))
        .conditions,
    ).toEqual({ from: [], to: ["M12"] });
    // A condition of the heading-to profile stands, as it does in the record.
    expect(
      plan(
        block("  profile_conditions: [M12]\n"),
        recordText("profile: solo-lite\nheading_to: team-standard"),
      ).conditions,
    ).toEqual({ from: [], to: ["M12"] });
  });

  test("refuses a score flag on a criterion the record does not hold", () => {
    expect(
      refusedWith(() =>
        plan(
          block(
            '  scores:\n    - { ref: "M3/no-such-criterion", note: "n" }\n',
          ),
        ),
      ),
    ).toEqual(["M3/no-such-criterion: the record has no such criterion"]);
  });

  test("the record's own set, in any order, is no change", () => {
    const p = plan(
      block("  profile_conditions: [M3, M12]\n"),
      recordText(`${TEAM}\nprofile_conditions: [M12, M3]`),
    );
    expect(p.conditions).toBeNull();
    expect(changesRecord(p)).toBe(false);
  });

  /** Set the conditions to `to` in `text`; the result must check, read `to` and keep every comment. */
  function conditioned(text: string, to: string[]): string {
    const p = plan(block(`  profile_conditions: [${to.join(", ")}]\n`), text);
    expect(changesRecord(p)).toBe(true);
    const before = parseRecord(text, "r.yaml");
    const edited = editRecordText(text, p);
    expect(checkEdited(before, edited, "r.yaml", p, catalog)).toEqual([]);
    expect(parseRecord(edited, "r.yaml").profile_conditions ?? []).toEqual(to);
    for (const c of text.matchAll(/#[^\n]*/g)) expect(edited).toContain(c[0]);
    return edited;
  }

  test("an absent profile_conditions: is added after profile:", () => {
    expect(conditioned(recordText(TEAM), ["M3", "M12"])).toContain(
      `${TEAM}\nprofile_conditions: [M3, M12]\ncriteria:`,
    );
  });

  test("a present one is replaced, keeping its comment", () => {
    expect(
      conditioned(
        recordText(
          `${TEAM}\nprofile_conditions: [M12]   # parallel workspaces`,
        ),
        ["M3"],
      ),
    ).toContain(
      `${TEAM}\nprofile_conditions: [M3]   # parallel workspaces\ncriteria:`,
    );
  });

  test("a block list is replaced whole, keeping its comments", () => {
    expect(
      conditioned(
        recordText(
          `${TEAM}\nprofile_conditions:   # agreed\n  # the agents\n  - M12\n  - M3   # a large codebase`,
        ),
        ["M12"],
      ),
    ).toContain(
      "profile_conditions: [M12]   # agreed\n  # the agents\n  # a large codebase\ncriteria:",
    );
  });

  test("a flow list over several lines is replaced whole, keeping its comments", () => {
    expect(
      conditioned(
        recordText(
          `${TEAM}\nprofile_conditions: [   # agreed\n  M12,   # the agents\n  M3\n]`,
        ),
        ["M12"],
      ),
    ).toContain(
      "profile_conditions: [M12]   # agreed\n# the agents\ncriteria:",
    );
  });

  test("an empty list removes the key, keeping its comment", () => {
    const edited = conditioned(
      recordText(`${TEAM}\nprofile_conditions: [M12]   # parallel workspaces`),
      [],
    );
    expect(edited).not.toContain("profile_conditions");
    expect(edited).toContain(`${TEAM}\n# parallel workspaces\ncriteria:`);
  });

  test("says what changed, and prints each wrong score as a calibration note", () => {
    const p = plan(
      block(`  profile_conditions: [M3]\n${FLAG}`),
      recordText(`${TEAM}\nprofile_conditions: [M12]`),
    );
    expect(p.scores).toEqual([
      {
        ref: "M1/ci-runs-gates-on-pr",
        statement: expect.any(String),
        score: "absent",
        evidence: "nothing found for ci-runs-gates-on-pr",
        note: "CI runs the gates on every pull request.",
      },
    ]);
    const out = renderPlan(p, { record: "r.yaml", dryRun: false });
    expect(out).toContain(
      "- profile_conditions: [M3] (now applies: M3; no longer applies: M12)",
    );
    expect(out).toContain(
      "This score is wrong (calibration notes: re-examine; the score is not changed):",
    );
    expect(out).toMatch(
      /\n- M1\/ci-runs-gates-on-pr \(.+\): scored absent; evidence: nothing found for ci-runs-gates-on-pr\n {2}the team's note: CI runs the gates on every pull request\.\n/,
    );
    const removed = plan(
      block("  profile_conditions: []\n"),
      recordText(`${TEAM}\nprofile_conditions: [M12]`),
    );
    expect(renderPlan(removed, { record: "r", dryRun: false })).toContain(
      "- profile_conditions: none (no longer applies: M12)",
    );
  });

  test("a wrong score alone changes nothing in the record", () => {
    const p = plan(block(FLAG));
    expect(changesRecord(p)).toBe(false);
    const out = renderPlan(p, { record: "r.yaml", dryRun: false });
    expect(out).toStartWith("Nothing new to record in r.yaml.");
    expect(out).toContain("the team's note: CI runs the gates");
  });
});

describe("the command line", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  const RECORD = ".config/jig-audit.yaml";
  function repo(record = recordText()): string {
    const root = scratchRepo({
      [RECORD]: record,
      "report.json": reportSource,
      "feedback.txt": `Decisions:\n\n${FULL}`,
    });
    roots.push(root);
    return root;
  }

  test("a dry run fails where the real run would, and writes nothing", () => {
    const flow =
      'declined: [{ refs: ["M5/numbering-gate-enforced"],\n  reason: "r", revisit_when: "w" }]';
    const root = repo(recordText(undefined, flow));
    const before = readFileSync(join(root, RECORD), "utf8");
    const r = runScript(
      "record.ts",
      [
        "apply-feedback",
        "feedback.txt",
        "--report",
        "report.json",
        "--dry-run",
      ],
      root,
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot extend");
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(before);
  });

  test("records the decisions and prints the work", () => {
    const root = repo();
    const r = runScript(
      "record.ts",
      ["apply-feedback", "feedback.txt", "--report", "report.json"],
      root,
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Recorded in");
    expect(r.out).toContain("1. R1 [M5/adrs-exist-numbered-from-template]");
    const written = readFileSync(join(root, RECORD), "utf8");
    expect(written).toContain('- refs: ["M1/precommit-autofix-hooks"]');
    expect(written).toContain("# a package others depend on");
    const again = runScript(
      "record.ts",
      ["apply-feedback", "feedback.txt", "--report", "report.json"],
      root,
    );
    expect(again.out).toContain("Nothing new to record");
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(written);
  });

  test("--dry-run writes nothing; --json prints the plan; - reads standard input", () => {
    const root = repo();
    const before = readFileSync(join(root, RECORD), "utf8");
    const r = runScript(
      "record.ts",
      [
        "apply-feedback",
        "-",
        "--report",
        "report.json",
        RECORD,
        "--dry-run",
        "--json",
      ],
      root,
      undefined,
      FULL,
    );
    expect(r.code).toBe(0);
    const parsed: unknown = JSON.parse(r.out);
    expect(parsed).toMatchObject({ profile: { to: "team-standard" } });
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(before);
    const text = runScript(
      "record.ts",
      [
        "apply-feedback",
        "feedback.txt",
        "--report",
        "report.json",
        "--dry-run",
      ],
      root,
    );
    expect(text.out).toContain("(dry run: nothing written)");
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(before);
  });

  test("refused feedback exits 1 and leaves the record alone", () => {
    const root = repo();
    writeFileSync(join(root, "feedback.txt"), block("  accept: [R9]\n"));
    const before = readFileSync(join(root, RECORD), "utf8");
    const r = runScript(
      "record.ts",
      ["apply-feedback", "feedback.txt", "--report", "report.json"],
      root,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("R9: the report has no such recommendation");
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(before);
  });

  test("a misspelt or repeated option is refused before anything is written", () => {
    const root = repo();
    const before = readFileSync(join(root, RECORD), "utf8");
    const run = (args: string[]) =>
      runScript(
        "record.ts",
        ["apply-feedback", "feedback.txt", "--report", "report.json", ...args],
        root,
      );
    const misspelt = run(["--dryrun"]);
    expect(misspelt.code).toBe(2);
    expect(misspelt.err).toContain("--dryrun");
    expect(run(["--json", "--json"]).err).toContain("--json given twice");
    expect(readFileSync(join(root, RECORD), "utf8")).toBe(before);
  });

  test("usage errors and unreadable files exit 2", () => {
    const root = repo();
    const run = (args: string[]) =>
      runScript("record.ts", ["apply-feedback", ...args], root).code;
    expect(run(["feedback.txt"])).toBe(2);
    expect(run(["feedback.txt", "--report"])).toBe(2);
    expect(run([])).toBe(2);
    expect(run(["missing.txt", "--report", "report.json"])).toBe(2);
    expect(run(["feedback.txt", "--report", "missing.json"])).toBe(2);
  });
});
