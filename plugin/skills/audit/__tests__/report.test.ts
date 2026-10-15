/**
 * The audit sheet: the report source's validation, the checks against the
 * record and the fit report, when each recommendation is due under the
 * profile, the sheet's sections and markers, the Markdown copy, the
 * decisions text, the command line and the colours.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import { checkRecord, compare, parseRecord } from "../scripts/lib/record.ts";
import { TEXT_PAIRS } from "../scripts/report/css.ts";
import {
  feedbackText,
  type FeedbackInput,
  missingFields,
} from "../scripts/report/feedback-text.ts";
import { PROFILE_WHO } from "../scripts/report/guide-text.ts";
import { renderReportHtml } from "../scripts/report/html.ts";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import {
  countsOf,
  horizonOf,
  inputProblems,
  mapRows,
  startHere,
  targetsOf,
  trendOf,
  trendSummary,
  uncoveredGaps,
  worthWhen,
} from "../scripts/report/model.ts";
import {
  parseReportSource,
  type Recommendation,
  ReportSourceError,
  reportFingerprint,
} from "../scripts/report/source.ts";
import { cleanEnv, runScript, scratchRepo } from "./helpers.ts";
import {
  COMMIT,
  FIT_PATH,
  addedAfter,
  historyRecord,
  noProfile,
  priorRecord,
  RECORD_PATH,
  rawSource,
  currentRecordAt,
  recordAt,
  recordText,
  reportInput,
  SOURCE_PATH,
} from "./report-fixtures.ts";

function problemsOf(change: (s: Record<string, unknown>) => void): string[] {
  const raw = rawSource();
  change(raw);
  try {
    parseReportSource(raw);
  } catch (error) {
    if (error instanceof ReportSourceError) return error.problems;
    throw error;
  }
  return [];
}

const recs = (s: Record<string, unknown>) =>
  s.recommendations as Record<string, unknown>[];
const rec = (s: Record<string, unknown>, i: number) =>
  recs(s)[i] as Record<string, unknown>;

describe("the report source", () => {
  test("the execa fixture is valid", () => {
    expect(problemsOf(() => undefined)).toEqual([]);
  });

  test("names every problem with its path, all in one run", () => {
    const problems = problemsOf((s) => {
      s.v = 2;
      s.extra = true;
      delete s.summary;
      rec(s, 0).id = "P1";
      rec(s, 1).refs = ["M1/ok", "nonsense", "M1/ok"];
      rec(s, 2).leverage = "huge";
      rec(s, 3).effort = "tiny";
      rec(s, 4).lighter = " ";
      (s.repository as Record<string, unknown>).url = "http://example.com";
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        "$.extra: unknown field",
        "$.summary: is required",
        "$.v: must be 1",
        "$.recommendations[0].id: must be R<n>, such as R1",
        "$.recommendations[1].refs[1]: must be M<n>/<criterion id> or config/<id>",
        "$.recommendations[1].refs: names a ref twice",
        "$.recommendations[2].leverage: must be high | medium | low",
        "$.recommendations[3].effort: must be small | medium | large",
        "$.recommendations[4].lighter: must be a non-empty string",
        "$.repository.url: must be an https URL with no spaces, parentheses or backslashes",
      ]),
    );
  });

  test("refuses a duplicate id, a suggested profile without a reason, and a repository name over two lines", () => {
    expect(
      problemsOf((s) => {
        rec(s, 1).id = "R1";
        delete (s.profile as Record<string, unknown>).why;
        (s.repository as Record<string, unknown>).name = "a\nb";
      }),
    ).toEqual([
      "$.repository.name: must be one line",
      "$.profile.why: is required for a suggested profile",
      "$.recommendations: has a duplicate id",
    ]);
  });

  test("checks each signal to revisit the profile: a text and at least one piece of evidence", () => {
    const profile = (s: Record<string, unknown>) =>
      s.profile as Record<string, unknown>;
    expect(
      problemsOf((s) => {
        profile(s).signals = [
          { text: "A second deploy target appeared.", evidence: ["fly.toml"] },
        ];
      }),
    ).toEqual([]);
    expect(
      problemsOf((s) => {
        profile(s).signals = [
          { text: " ", evidence: [] },
          { text: "Five contributors this quarter.", evidence: ["x"], at: 1 },
        ];
      }),
    ).toEqual([
      "$.profile.signals[0].text: must be a non-empty string",
      "$.profile.signals[0].evidence: needs at least 1 item(s)",
      "$.profile.signals[1].at: unknown field",
    ]);
    expect(
      problemsOf((s) => {
        profile(s).signals = [];
      }),
    ).toEqual(["$.profile.signals: needs at least 1 item(s)"]);
  });

  test("accepts no recommendations, and leaves drift and terms optional", () => {
    expect(
      problemsOf((s) => {
        s.recommendations = [];
        delete s.drift;
        delete s.terms;
      }),
    ).toEqual([]);
  });
});

describe("the checks against the record and the fit report", () => {
  test("pass for the fixture", () => {
    expect(inputProblems(reportInput())).toEqual([]);
  });

  test("refuse a criterion the record did not score and a finding the fit report does not hold", () => {
    const input = reportInput({
      source: (s) => {
        rec(s, 0).refs = ["M1/no-such-criterion"];
        rec(s, 3).refs = ["config/no-such-finding"];
      },
    });
    expect(inputProblems(input)).toEqual([
      "$.recommendations[0] (R1).refs: M1/no-such-criterion is not a criterion the record scored",
      "$.recommendations[3] (R4).refs: config/no-such-finding is not a finding of the configuration-fit report",
    ]);
  });

  test("take a configuration ref on trust without a fit report", () => {
    const input = reportInput({
      fit: false,
      source: (s) => {
        rec(s, 3).refs = ["config/anything"];
      },
    });
    expect(inputProblems(input)).toEqual([]);
  });

  const declined = (after?: string) =>
    [
      '  - refs: ["M5/adrs-exist-numbered-from-template"]',
      '    reason: "Two maintainers; decisions live in pull requests."',
      '    revisit_when: "a third maintainer joins"',
      ...(after ? [`    revisit_after: "${after}"`] : []),
    ].join("\n");

  test("refuse a recommendation the team declined and still holds", () => {
    const problems = inputProblems(
      reportInput({ record: recordText([], declined()) }),
    );
    expect(problems).toEqual([
      "$.recommendations[4] (R5): the team declined M5/adrs-exist-numbered-from-template and holds it until: a third maintainer joins; leave it out of the report",
    ]);
  });

  test("let a declined recommendation back once its revisit date has passed", () => {
    expect(
      inputProblems(
        reportInput({ record: recordText([], declined("2026-10-01")) }),
      ),
    ).toEqual([]);
  });

  test("refuse a recommendation that bundles a held ref with other work", () => {
    const input = reportInput({
      record: recordText([], declined()),
      source: (s) => {
        rec(s, 4).refs = [
          "M5/adrs-exist-numbered-from-template",
          "M5/amendment-discipline-documented",
        ];
      },
    });
    expect(inputProblems(input)).toEqual([
      "$.recommendations[4] (R5): the team declined M5/adrs-exist-numbered-from-template and holds it until: a third maintainer joins; leave it out of the report",
    ]);
  });

  test("a decline never holds back a configuration error", () => {
    const configDecline = [
      '  - refs: ["config/type:review.bots"]',
      '    reason: "Not now."',
      '    revisit_when: "never"',
    ].join("\n");
    const fit = (severity: string) =>
      reportInput({
        record: recordText([], configDecline),
        source: (s) => {
          rec(s, 3).refs = ["config/type:review.bots"];
        },
        fitFindings: [
          { id: "type:review.bots", severity, message: "a list of logins" },
        ],
      });
    expect(inputProblems(fit("error"))).toEqual([]);
    expect(inputProblems(fit("warning"))).toEqual([
      "$.recommendations[3] (R4): the team declined config/type:review.bots and holds it until: never; leave it out of the report",
    ]);
  });

  test("hold the profile to the record's", () => {
    expect(
      inputProblems(
        reportInput({
          source: (s) => {
            s.profile = { id: "team-standard", source: "declared" };
          },
        }),
      ),
    ).toEqual([
      "$.profile: a declared profile is the record's, and the record's is not set",
    ]);
    expect(
      inputProblems(
        reportInput({ record: recordText(["profile: team-standard"]) }),
      ),
    ).toEqual([
      "$.profile: the record declares team-standard; suggest a profile only when the team has none",
    ]);
    expect(
      inputProblems(
        reportInput({
          record: recordText(["heading_to: big-enterprise"]),
          source: (s) => {
            (s.profile as Record<string, unknown>).id = "no-such";
          },
        }),
      ),
    ).toEqual([
      "record: heading_to: big-enterprise is not one of solo-lite, team-standard, regulated-strict",
      "$.profile.id: no-such is not one of solo-lite, team-standard, regulated-strict",
    ]);
  });

  test("refuse a history record newer than the audited one", () => {
    expect(
      inputProblems(
        reportInput({
          prior: priorRecord(),
          history: [historyRecord(), recordAt("2026-11-02")],
        }),
      ),
    ).toEqual([
      "history: the record of 2026-11-02 (2026110) is newer than the audited record of 2026-10-12; give only older records",
    ]);
  });

  test("refuse a prior newer than the audit, history newer than the prior, and two history records of one day", () => {
    const otherCommit = (text: string) =>
      text.replace(/^commit: "?(\w)/m, (m, c: string) =>
        m.replace(c, c === "f" ? "e" : "f"),
      );
    expect(
      inputProblems(
        reportInput({
          prior: recordAt("2026-11-02"),
          history: [historyRecord()],
        }),
      ),
    ).toEqual([
      "prior: the record of 2026-11-02 (2026110) is newer than the audited record of 2026-10-12; give the last audit before it",
    ]);
    expect(
      inputProblems(
        reportInput({
          prior: priorRecord(),
          history: [recordAt("2026-08-01")],
        }),
      ),
    ).toEqual([
      "history: the record of 2026-08-01 (2026080) is newer than the prior record of 2026-07-19; give the latest as --prior and only older records as history",
    ]);
    const problems = inputProblems(
      reportInput({
        prior: priorRecord(),
        history: [historyRecord(), otherCommit(historyRecord())],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^history: the records 2026-04-02 \(\w{7}\) and 2026-04-02 \(\w{7}\) share a date, so the trend cannot order them; give one of them$/,
    );
  });

  test("refuse an incomplete record", () => {
    const record = recordWithout("M1/ci-runs-gates-on-pr");
    expect(inputProblems(reportInput({ record }))).toContain(
      "record: M1/ci-runs-gates-on-pr: missing",
    );
  });
});

/** The record without one criterion's entry. */
function recordWithout(key: string): string {
  const text = readFileSync(RECORD_PATH, "utf8");
  const start = text.indexOf(`  ${key}:`);
  const next = text.indexOf("\n  M", start + 1);
  return text.slice(0, start) + text.slice(next + 1);
}

describe("when a recommendation is due", () => {
  const horizons = (input: ReturnType<typeof reportInput>) => {
    const t = targetsOf(input);
    return Object.fromEntries(
      input.source.recommendations.map((r) => [r.id, horizonOf(r, input, t)]),
    );
  };

  test("without any profile, everything is for now", () => {
    expect(horizons(reportInput({ source: noProfile }))).toEqual({
      R1: "now",
      R2: "now",
      R3: "now",
      R4: "now",
      R5: "now",
    });
  });

  test("a suggested profile measures like a declared one: beyond Solo/Lite is optional", () => {
    expect(horizons(reportInput())).toEqual({
      R1: "now",
      R2: "now",
      R3: "optional",
      R4: "now",
      R5: "optional",
    });
  });

  test("what the heading-to profile asks for waits until the project grows", () => {
    expect(
      horizons(
        reportInput({ record: recordText(["heading_to: team-standard"]) }),
      ),
    ).toEqual({ R1: "now", R2: "now", R3: "grow", R4: "now", R5: "grow" });
  });

  test("a declared profile that asks for more brings it into now", () => {
    expect(
      horizons(
        reportInput({
          record: recordText(["profile: team-standard"]),
          source: noProfile,
        }),
      ),
    ).toEqual({ R1: "now", R2: "now", R3: "now", R4: "now", R5: "now" });
  });

  test("a conditional target counts only once the team says it holds, and says when it would", () => {
    const m3 = (s: Record<string, unknown>) => {
      noProfile(s);
      rec(s, 4).refs = ["M3/catalog-is-single-source"];
    };
    const without = reportInput({
      record: recordText(["profile: team-standard"]),
      source: m3,
    });
    const r5 = without.source.recommendations[4];
    if (!r5) throw new Error("fixture lost R5");
    const t = targetsOf(without);
    expect(horizonOf(r5, without, t)).toBe("optional");
    expect(worthWhen(r5, without, t)).toBe(
      "what a change implies is no longer obvious from its paths",
    );
    const withIt = reportInput({
      record: recordText([
        "profile: team-standard",
        "profile_conditions: [M3]",
      ]),
      source: m3,
    });
    expect(horizonOf(r5, withIt, targetsOf(withIt))).toBe("now");
  });

  test("a criterion scored expected-absent is not asked for by the target", () => {
    const input = reportInput({
      record: recordText(["profile: team-standard"]),
      source: (s) => {
        noProfile(s);
        rec(s, 4).refs = ["M2/derived-inventory-exists"];
      },
    });
    const r5 = input.source.recommendations[4];
    if (!r5) throw new Error("fixture lost R5");
    expect(horizonOf(r5, input, targetsOf(input))).toBe("optional");
  });

  test("Start here draws only from now: the top three and the quick wins", () => {
    const input = reportInput();
    const { top, quick } = startHere(input, targetsOf(input));
    expect(top.map((r) => r.id)).toEqual(["R1", "R2", "R4"]);
    // R3 is a quick win, but Solo/Lite does not ask for it.
    expect(quick).toEqual([]);
    const all = reportInput({ source: noProfile });
    const open = startHere(all, targetsOf(all));
    expect(open.top.map((r) => r.id)).toEqual(["R1", "R2", "R3"]);
    expect(open.quick.map((r) => r.id)).toEqual(["R4"]);
  });
});

describe("the map", () => {
  test("lists every module in adoption order, the n/a ones with their reason", () => {
    const input = reportInput();
    const rows = mapRows(input, targetsOf(input));
    expect(rows.map((r) => r.module.module)).toEqual([...input.profiles.order]);
    expect(rows.filter((r) => r.naReason).map((r) => r.module.module)).toEqual([
      "M6",
      "M12",
    ]);
  });

  test("marks a gap only within the target, and none without a profile", () => {
    const input = reportInput();
    const rows = mapRows(input, targetsOf(input));
    const gaps = rows.flatMap((r) =>
      r.cells.filter((c) => c.gap).map((c) => c.criterion.key),
    );
    expect(gaps).toEqual([
      "M1/ci-runs-gates-on-pr",
      "M0/universal-instruction-file",
      "M0/gates-and-guardrails-listed",
      "M0/glossary-exists",
    ]);
    const bare = reportInput({ source: noProfile });
    expect(
      mapRows(bare, targetsOf(bare)).flatMap((r) =>
        r.cells.filter((c) => c.gap),
      ),
    ).toEqual([]);
  });

  test("a criterion added after the calibration audit still applies: Team/Standard's M14 Lite target shows its gaps", () => {
    const input = reportInput({
      record: recordText(["profile: team-standard"]),
      source: noProfile,
    });
    const rows = mapRows(input, targetsOf(input));
    const m14 = rows.find((r) => r.module.module === "M14");
    expect(m14?.naReason).toBeFalsy();
    expect(m14?.cells.filter((c) => c.gap).map((c) => c.criterion.key)).toEqual(
      ["M14/test-tiers-declared", "M14/testing-rules-written"],
    );
  });

  const uncovered = (input: ReturnType<typeof reportInput>) => {
    const t = targetsOf(input);
    const rows = mapRows(input, t);
    return {
      keys: uncoveredGaps(rows).map((c) => c.criterion.key),
      count: countsOf(input, rows, t).uncovered,
    };
  };

  test("finds the gaps no recommendation covers, and counts them", () => {
    // R1 and R2 move three of the four gaps; nothing moves the glossary.
    expect(uncovered(reportInput())).toEqual({
      keys: ["M0/glossary-exists"],
      count: 1,
    });
    expect(uncovered(reportInput({ source: noProfile }))).toEqual({
      keys: [],
      count: 0,
    });
  });

  test("a gap is covered by any recommendation that names it, or left deliberately by a held decline", () => {
    const covered = reportInput({
      source: (s) => {
        rec(s, 1).refs = [
          ...(rec(s, 1).refs as string[]),
          "M0/glossary-exists",
        ];
      },
    });
    expect(uncovered(covered).keys).toEqual([]);
    const declined = reportInput({
      record: recordText(
        [],
        '  - refs: ["M0/glossary-exists"]\n    reason: "Two maintainers share the words."\n    revisit_when: "a newcomer asks what a term means"',
      ),
    });
    expect(uncovered(declined).keys).toEqual([]);
  });
});

describe("the fixture records", () => {
  test("a record of 0.27.0 is complete, and against a 0.26.0 audit M14's criteria are added by Jig", () => {
    const { modules, profiles, schema } = reportInput();
    const current = parseRecord(
      currentRecordAt("2026-10-14", {}, "0.27.0"),
      "current.yaml",
    );
    expect(checkRecord(current, modules, profiles)).toEqual([]);
    const prior = parseRecord(
      recordAt("2026-10-13", {}, "0.26.0"),
      "prior.yaml",
    );
    const added = compare(prior, current, modules, schema, "2026-10-14")
      .criteria.filter((c) => c.change === "added-by-jig")
      .map((c) => c.key);
    const m14 = modules
      .find((m) => m.module === "M14")
      ?.criteria.map((c) => c.key);
    expect(m14?.length).toBe(12);
    expect(added).toEqual(addedAfter("0.26.0"));
    expect(added).toEqual(expect.arrayContaining(m14 ?? []));
  });

  test("a score override reaches a criterion added after the calibration audit", () => {
    expect(
      currentRecordAt(
        "2026-10-14",
        { "M14/test-tiers-declared": "mechanical" },
        "0.27.0",
      ),
    ).toMatch(
      /^ {2}M14\/test-tiers-declared:.*\n(?: {4}#.*\n)* {4}score: mechanical$/m,
    );
  });

  test("a score override for a criterion the record lacks is refused", () => {
    expect(() =>
      currentRecordAt("2026-10-14", { "M99/no-such-criterion": "mechanical" }),
    ).toThrow("M99/no-such-criterion");
    expect(() =>
      recordAt("2026-10-14", { "M99/no-such-criterion": "mechanical" }),
    ).toThrow("M99/no-such-criterion");
  });

  test("a score override key matches a criterion literally, not as a pattern", () => {
    expect(() =>
      currentRecordAt("2026-10-14", {
        "M14/test.tiers-declared": "mechanical",
      }),
    ).toThrow("M14/test.tiers-declared");
    expect(() =>
      recordAt("2026-10-14", { "M1/gate.set-documented": "absent" }),
    ).toThrow("M1/gate.set-documented");
  });
});

describe("the trend", () => {
  const withHistory = (history: string[]) =>
    reportInput({ prior: priorRecord(), history });

  test("lists each module's level at every record, oldest first, only where it changed", () => {
    const trend = trendOf(withHistory([historyRecord()]));
    expect(trend?.points.map((p) => [p.date, p.current])).toEqual([
      ["2026-04-02", false],
      ["2026-07-19", false],
      ["2026-10-12", true],
    ]);
    expect(trend?.rows).toEqual([
      {
        id: "M2",
        module: "M2 Generated artifact freshness",
        levels: [
          { word: "none", move: null },
          { word: "Lite", move: "up" },
          { word: "Lite", move: null },
        ],
      },
    ]);
    expect(trend && trendSummary(trend)).toBe(
      "1 module moved up since 2026-04-02.",
    );
  });

  test("orders the records by date whatever order they are given in, and counts the prior record once", () => {
    const older = recordAt("2026-01-05", {
      "M2/derived-inventory-exists": "absent",
    });
    const trend = trendOf(withHistory([historyRecord(), priorRecord(), older]));
    expect(trend?.points.map((p) => p.date)).toEqual([
      "2026-01-05",
      "2026-04-02",
      "2026-07-19",
      "2026-10-12",
    ]);
  });

  test("says when a module fell, and when nothing ends where it started", () => {
    // M0 attained Lite then: its three Lite criteria were met.
    const higher = recordAt("2026-04-02", {
      "M0/universal-instruction-file": "mechanical",
      "M0/gates-and-guardrails-listed": "mechanical",
      "M0/glossary-exists": "mechanical",
    });
    const fell = trendOf(withHistory([higher]));
    expect(fell?.rows.map((r) => r.module)).toContain(
      "M0 Instruction architecture",
    );
    expect(fell && trendSummary(fell)).toBe(
      "1 module moved down since 2026-04-02.",
    );
    const same = trendOf(withHistory([recordAt("2026-04-02")]));
    expect(same?.rows).toEqual([]);
    expect(same && trendSummary(same)).toBe(
      "No module's level changed since 2026-04-02.",
    );
  });

  test("counts each audit once, and the prior record last on its own day", () => {
    const sameDayAsPrior = recordAt("2026-07-19").replace(
      /^commit: "?2026/m,
      (m) => m.replace("2026", "1999"),
    );
    const input = withHistory([
      historyRecord(),
      historyRecord(),
      sameDayAsPrior,
      priorRecord(),
    ]);
    expect(inputProblems(input)).toEqual([]);
    const points = trendOf(input)?.points ?? [];
    expect(points.map((p) => p.date)).toEqual([
      "2026-04-02",
      "2026-07-19",
      "2026-07-19",
      "2026-10-12",
    ]);
    expect(points[2]?.commit).toBe(input.prior?.commit ?? "");
  });

  test("never counts the audited record as its own past, given as history on the prior's day", () => {
    const now = currentRecordAt("2026-10-12", {}, "0.15.0");
    const prior = recordAt("2026-10-12", {
      "M1/gate-set-documented": "absent",
    }).replace(/^commit: "?2026/m, (m) => m.replace("2026", "1999"));
    const input = reportInput({
      record: now,
      prior,
      history: [historyRecord(), now],
    });
    expect(inputProblems(input)).toEqual([]);
    const points = trendOf(input)?.points ?? [];
    expect(
      points.map((p) => [p.commit === input.record.commit, p.current]),
    ).toEqual([
      [false, false],
      [false, false],
      [true, true],
    ]);
  });

  test("keeps a same-day re-audit of the same commit whose scores differ", () => {
    const now = currentRecordAt("2026-10-12", {}, "0.15.0");
    const prior = recordAt(
      "2026-10-12",
      { "M1/gate-set-documented": "absent" },
      "0.15.0",
    );
    const input = reportInput({
      record: now,
      prior,
      history: [historyRecord()],
    });
    expect(input.prior?.commit).toBe(input.record.commit);
    expect(inputProblems(input)).toEqual([]);
    const trend = trendOf(input);
    expect(
      trend?.points.map((p) => [p.commit === input.record.commit, p.current]),
    ).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  test("counts an audit once whether its record was committed before or after the team's decisions", () => {
    const audit = recordAt("2026-07-19", {
      "M1/gate-set-documented": "absent",
    });
    const input = reportInput({
      prior: audit,
      history: [historyRecord(), audit, audit],
    });
    const [decided, reordered] = [input.prior, input.history[2]];
    if (!decided || !reordered) throw new Error("fixture records missing");
    decided.profile_conditions = ["M3", "M12"];
    decided.declined = [
      {
        refs: ["M1/gate-set-documented"],
        reason: "not now",
        revisit_when: "a second gate lands",
      },
    ];
    reordered.profile_conditions = ["M12", "M3"];
    expect(inputProblems(input)).toEqual([]);
    expect(trendOf(input)?.points.map((p) => p.date)).toEqual([
      "2026-04-02",
      "2026-07-19",
      "2026-10-12",
    ]);
  });

  test("measures each record without the criteria added after its plugin version", () => {
    const key = "M2/derived-inventory-exists";
    const input = withHistory([historyRecord()]);
    // A criterion the 0.15.0 catalog added, which the 0.14.0 records lack.
    input.modules = input.modules.map((m) => ({
      ...m,
      criteria: m.criteria.map((c) =>
        c.key === key ? { ...c, since: "0.15.0" } : c,
      ),
    }));
    for (const r of [...input.history, input.prior]) r?.criteria.delete(key);
    const words = trendOf(input)?.rows.flatMap((r) =>
      r.levels.map((l) => l.word),
    );
    expect(words).not.toContain("incomplete");
  });

  test("names a change to or from n/a or incomplete apart from a level that came back", () => {
    const input = withHistory([historyRecord()]);
    input.history[0]?.criteria.delete("M2/derived-inventory-exists");
    const trend = trendOf(input);
    expect(trend?.rows[0]?.levels.map((l) => l.word)).toEqual([
      "incomplete",
      "Lite",
      "Lite",
    ]);
    expect(trend && trendSummary(trend)).toBe(
      "1 module changed to or from n/a or incomplete since 2026-04-02.",
    );
  });

  test("is absent without a history", () => {
    expect(trendOf(reportInput({ prior: priorRecord() }))).toBeNull();
  });
});

const sectionIds = (html: string) =>
  [...html.matchAll(/<section class="sec[^"]*" id="([a-z]+)"/g)].map(
    (m) => m[1],
  );

/** The words a reader sees: without the tips' and module popovers' text, and without tags. */
const plain = (html: string) =>
  html
    .replace(/<span class="(?:tip|pop pop-m)"[^>]*>.*?<\/span>/g, "")
    .replace(/<[^>]+>/g, "");

describe("the sheet", () => {
  const html = renderReportHtml(reportInput());

  test("has its sections in reading order, without the comparison on a first audit", () => {
    expect(sectionIds(html)).toEqual([
      "summary",
      "map",
      "start",
      "recs",
      "detail",
      "config",
      "drift",
      "examined",
      "terms",
      "guide",
    ]);
  });

  test("adds what changed since the last audit only with a prior record", () => {
    const prior = priorRecord();
    const again = renderReportHtml(reportInput({ prior }));
    expect(sectionIds(again)).toEqual([
      "summary",
      "map",
      "start",
      "since",
      "recs",
      "detail",
      "config",
      "drift",
      "examined",
      "terms",
      "guide",
    ]);
    expect(again).toContain(
      '<p class="intro">Compared with the audit of 2026-07-19 (plugin 0.14.0).</p><ul class="bds"><li><span class="bd bd-fixed">Fixed <b>1</b></span></li>',
    );
    // One row per criterion: the module's chip, the criterion linked to its
    // detail, both scores as chips, and the change as a badge.
    expect(again).toMatch(
      /What changed \(42\)<\/h3><table class="chgt chg-t">.*?<tr><td><span class="pw mw"><a class="mchip" href="#d-M1" aria-describedby="(mp-\d+)">M1<\/a><span class="pop pop-m" role="tooltip" id="\1"><b>M1 Gates enforcement ladder<\/b> Stated rules become checks[^<]*<\/span><\/span><\/td><td class="cc"><a href="#c-M1-gate-set-documented"><code>gate-set-documented<\/code><\/a><\/td><td class="ba"><span class="sch s-absent">.*?absent<\/span>.*?<span class="sch s-convention">.*?convention<\/span><\/td><td><span class="bd bd-fixed">Fixed<\/span><\/td><\/tr>/,
    );
    // A criterion Jig added after the prior audit's plugin was not assessed then.
    const added = addedAfter("0.14.0");
    expect(added).toContain("M1/gate-outcomes-distinguish-could-not-check");
    for (const key of added)
      expect(again).toMatch(
        new RegExp(
          `<a href="#c-${key.replace("/", "-")}"><code>[^<]+<\\/code><\\/a><\\/td><td class="ba"><span class="nos" aria-hidden="true">—<\\/span><span class="vh">none<\\/span>(?:(?!<\\/tr>).)*<td><span class="bd bd-added-by-jig">Added by Jig<\\/span><\\/td><\\/tr>`,
        ),
      );
  });

  test("with older records, shows the trend in place of the levels table", () => {
    const prior = priorRecord();
    expect(renderReportHtml(reportInput({ prior }))).not.toContain("Trend");
    const page = renderReportHtml(
      reportInput({ prior, history: [historyRecord()] }),
    );
    const since = page.slice(
      page.indexOf('id="since"'),
      page.indexOf('id="recs"'),
    );
    expect(since).toContain(
      '<h3 class="sev-h">Trend</h3><p class="trend-s">1 module moved up since 2026-04-02.</p>',
    );
    expect(since).toMatch(
      /<th scope="col" title="20260402[0-9a-f]+">2026-04-02<\/th><th scope="col" title="20260719[0-9a-f]+">2026-07-19<\/th><th scope="col" title="63ddae6[0-9a-f]+">Now 2026-10-12<\/th>/,
    );
    expect(since).toMatch(
      /<tr><th scope="row"><span class="pw mw"><a class="mchip" href="#d-M2"[^>]*>M2<\/a>.*?<\/span><\/span> Generated artifact freshness<\/th><td>none<\/td><td class="mv-up"><span aria-hidden="true">↑ <\/span><span class="vh">up to <\/span>Lite<\/td><td>Lite<\/td><\/tr>/,
    );
    expect(since).not.toContain("Levels that changed");
  });

  test("marks the gap no recommendation covers, counts it and lists it under the recommendations", () => {
    // The legend's mark and the map's.
    expect([...html.matchAll(/<span class="c c-absent gap unc"/g)].length).toBe(
      2,
    );
    expect(html).toContain(
      '<span class="vh">glossary-exists: absent; needed for the target, not met yet; a gap no recommendation covers</span>',
    );
    expect(html).toContain(
      '<li class="unc-n"><a class="big" href="#uncovered">1</a>gap no recommendation covers</li>',
    );
    const recs = html.slice(
      html.indexOf('id="recs"'),
      html.indexOf('id="detail"'),
    );
    expect(recs).toMatch(
      /<div class="uncov" id="uncovered"><h3 class="sev-h">Not covered by a recommendation \(1\)<\/h3>.*<li><span class="cref"><span class="pw mw"><a class="mchip" href="#d-M0"[^>]*>M0<\/a>.*?<\/span><\/span> <a href="#c-M0-glossary-exists"><code>glossary-exists<\/code><\/a><\/span> /,
    );
    // Before the folded groups, after the recommendations for now.
    expect(recs.indexOf('id="uncovered"')).toBeLessThan(
      recs.indexOf('id="h-optional"'),
    );
    expect(html).toMatch(
      /<p class="cid">glossary-exists<\/p>.*?<span class="unct">a gap no recommendation covers<\/span>/,
    );
    const covered = renderReportHtml(
      reportInput({
        source: (s) => {
          rec(s, 1).refs = [
            ...(rec(s, 1).refs as string[]),
            "M0/glossary-exists",
          ];
        },
      }),
    );
    expect(covered).not.toContain('id="uncovered"');
    expect(covered).not.toContain("unc-n");
  });

  test("lists the uncovered gaps even when the audit makes no recommendation", () => {
    const page = renderReportHtml(
      reportInput({
        source: (s) => {
          s.recommendations = [];
        },
      }),
    );
    expect(sectionIds(page)).toContain("recs");
    expect(page).toContain("The audit makes no recommendation.");
    expect(page).toContain("Not covered by a recommendation (4)");
  });

  test("shows the signals to revisit the profile beside it, and only when there are some", () => {
    expect(html).not.toContain('id="signals"');
    const page = renderReportHtml(
      reportInput({
        source: (s) => {
          (s.profile as Record<string, unknown>).signals = [
            {
              text: "Seven people committed in the last quarter.",
              evidence: ["git shortlog -sn --since=3.months"],
            },
          ];
        },
      }),
    );
    expect(page).toContain(
      '<span class="pchip p-suggested">suggested</span> <a class="sig-l" href="#signals">worth revisiting</a>',
    );
    const summary = page.slice(
      page.indexOf('id="summary"'),
      page.indexOf('id="map"'),
    );
    expect(summary).toContain(
      '<div class="signals" id="signals"><h3>Worth revisiting the profile</h3>',
    );
    expect(summary).toContain(
      "<li><p>Seven people committed in the last quarter.</p>",
    );
    expect(summary).toContain("<code>git shortlog -sn --since=3.months</code>");
  });

  test("names the commit, the plugin and the suggested profile in the masthead", () => {
    expect(html).toContain(`title="${COMMIT}">63ddae6</dd>`);
    expect(html).toContain("<dd>0.15.0</dd>");
    expect(html).toContain(
      'Solo/Lite <span class="pchip p-suggested">suggested</span>',
    );
    const mast = html.slice(0, html.indexOf('id="summary"'));
    expect(mast).not.toContain("Heading to");
    // The profile's label opens the guide's part on profiles.
    expect(mast).toMatch(
      /<dt><span class="tw"><a class="term" href="#guide-profiles"[^>]*>Profile<\/a>/,
    );
  });

  test("welcomes the reader of a first audit to the guide, and gives a re-audit only a link", () => {
    const mast = (page: string) => page.slice(0, page.indexOf('id="summary"'));
    expect(mast(html)).toContain(
      '<div class="welcome" id="welcome"><p>This sheet shows where sindresorhus/execa stands on the delivery practices Jig describes, measured against the profile the team aims for, and what to do next. Besides its own record, nothing in the repository changes unless the team asks.</p><p><a href="#guide">New to Jig? Read the guide (5 min)</a></p></div>',
    );
    expect(mast(html)).not.toContain("How to read this report");
    const again = mast(renderReportHtml(reportInput({ prior: priorRecord() })));
    expect(again).not.toContain('id="welcome"');
    expect(again).toContain(
      '<p class="howto"><a href="#guide-read">How to read this report</a></p>',
    );
  });

  test("greys the modules that do not apply and says why", () => {
    expect(html).toMatch(
      /<li class="mrow na" id="map-M6">.*?Does not apply to this repository&#39;s shape: A mature utility library/,
    );
  });

  test("draws the heading-to target as a second marker only when the record names one", () => {
    expect(html).not.toContain('class="grp grow"');
    const grow = renderReportHtml(
      reportInput({ record: recordText(["heading_to: team-standard"]) }),
    );
    expect(grow).toContain('class="grp grow"');
    expect(grow).toContain('<span class="tgt hd">Heading to: Standard</span>');
    expect(grow).toMatch(
      />Heading to<\/a><span class="tip"[^>]*>[^<]*<\/span><\/span><\/dt><dd>Team\/Standard<\/dd>/,
    );
  });

  /** The map's rows, without its legend. */
  const mapOf = (page: string) =>
    page.slice(page.indexOf('<ol class="mmap">'), page.indexOf('id="start"'));

  test("never colours a criterion beyond the target as a gap", () => {
    const rings = [
      ...mapOf(html).matchAll(/<span class="c c-[a-z-]+ gap(?: unc)?">/g),
    ].length;
    expect(rings).toBe(4);
    expect(renderReportHtml(reportInput({ source: noProfile }))).not.toMatch(
      /<span class="c c-[a-z-]+ gap/,
    );
  });

  test("folds what is not for now under its own heading, saying why", () => {
    expect(html).toContain(
      '<details class="later" id="h-optional" open data-fold><summary><span class="later-h">Optional</span> <span class="later-n">(2)</span></summary><p class="intro">Beyond what <span class="tw"><a class="term" href="#guide-profiles"',
    );
    expect(plain(html)).toContain(
      "Beyond what Solo/Lite asks for. Not needed for this profile: take one when the project needs it.",
    );
    const grow = renderReportHtml(
      reportInput({ record: recordText(["heading_to: team-standard"]) }),
    );
    expect(plain(grow)).toContain(
      "Beyond what Solo/Lite asks for now; worth it as the project grows toward Team/Standard.",
    );
    expect(grow).not.toContain('id="h-optional"');
  });

  test("offers each profile's conditional targets beside the profile selector, checked as the record has them", () => {
    const declared = renderReportHtml(
      reportInput({
        record: recordText([
          "profile: team-standard",
          "profile_conditions: [M12]",
        ]),
        source: noProfile,
      }),
    );
    const picker = declared.slice(
      declared.indexOf('<div class="psel" data-js hidden>'),
    );
    const fieldset = (id: string) =>
      plain(
        new RegExp(
          `<fieldset class="conds" data-prof="${id}".*?</fieldset>`,
        ).exec(picker)?.[0] ?? "",
      );
    expect(fieldset("team-standard")).toBe(
      "Conditional targets that applyM12 Parallel agent ergonomics (Lite) applies when several agents work the repository in parallel workspacesM3 Change area catalog (Lite) applies when what a change implies is no longer obvious from its paths",
    );
    expect(picker).toMatch(
      /<fieldset class="conds" data-prof="team-standard" hidden><legend>.*?<\/legend><label class="cond"><input type="checkbox" value="M12" checked><span><span class="pw mw"><span class="mchip">M12<\/span>/,
    );
    expect(picker).toMatch(
      /<fieldset class="conds" data-prof="solo-lite" hidden><legend>.*?<\/legend><\/fieldset>/,
    );
    // A condition only the heading-to profile has is offered too, checked as the record has it.
    const heading = renderReportHtml(
      reportInput({
        record: recordText([
          "profile: solo-lite",
          "heading_to: team-standard",
          "profile_conditions: [M12]",
        ]),
        source: noProfile,
      }),
    );
    const solo = heading.slice(
      heading.indexOf('data-prof="solo-lite"'),
      heading.indexOf("</fieldset>", heading.indexOf('data-prof="solo-lite"')),
    );
    expect(plain(solo)).toContain(
      "M12 Parallel agent ergonomics (Lite) for Team/Standard, where the project is heading, applies when",
    );
    expect(solo).toContain(
      '<input type="checkbox" value="M12" checked><span><span class="pw mw"><span class="mchip">M12</span>',
    );
    expect(solo).toContain('<input type="checkbox" value="M3">');
  });

  test("lets the reader flag any criterion's score as wrong, hidden until the script runs", () => {
    const items = [
      ...html.matchAll(/<li data-crit="([^"]+)" id="c-[^"]+">.*?<\/li>/g),
    ];
    expect(items.length).toBe(
      reportInput().modules.flatMap((m) => m.criteria).length,
    );
    for (const m of items)
      expect(m[0]).toContain(
        '<div class="sw" data-js hidden><label class="swl"><input type="checkbox" data-sw><span>This score is wrong</span></label><label class="swn" hidden>Note<textarea data-swn rows="2"></textarea></label></div>',
      );
  });

  test("counts the criteria still open within the target apart from those beyond it, and folds the latter", () => {
    const since = (page: string) =>
      page.slice(page.indexOf('id="since"'), page.indexOf('id="recs"'));
    const suggested = since(
      renderReportHtml(reportInput({ prior: priorRecord() })),
    );
    expect(suggested).toContain(
      '<ul class="bds"><li><span class="bd bd-fixed">Fixed <b>1</b></span></li><li><span class="bd bd-added-by-jig">Added by Jig <b>41</b></span></li><li><span class="bd bd-open">Still open within the target <b>4</b></span></li><li><span class="bd bd-beyond">Still open beyond the target <b>78</b></span></li><li><span class="bd bd-unchanged">Unchanged and met <b>36</b></span></li></ul>',
    );
    expect(suggested).toMatch(
      /<details class="later sm" id="since-within" open data-fold><summary><span class="later-h">Still open within the target<\/span> <span class="later-n">\(4\)<\/span><\/summary><table class="chgt chg-t">.*?<tbody><tr><td><span class="pw mw"><a class="mchip" href="#d-M0".*?<code>universal-instruction-file<\/code>.*?<td><span class="bd bd-open">Still open<\/span><\/td><\/tr>/,
    );
    expect(suggested).toMatch(
      /<details class="later sm" id="since-beyond" open data-fold><summary><span class="later-h">Still open beyond the target<\/span> <span class="later-n">\(78\)<\/span><\/summary><p class="intro">Not met at either audit, and not needed for Solo\/Lite: its target does not reach them.<\/p><table class="chgt chg-t">.*?<span class="bd bd-beyond">Still open<\/span>/,
    );
    const declared = since(
      renderReportHtml(
        reportInput({
          prior: priorRecord(),
          record: recordText([
            "profile: team-standard",
            "profile_conditions: [M12]",
          ]),
          source: noProfile,
        }),
      ),
    );
    expect(declared).toContain(
      '<li><span class="bd bd-open">Still open within the target <b>34</b></span></li><li><span class="bd bd-beyond">Still open beyond the target <b>48</b></span></li>',
    );
    // Without a profile, every criterion still open is counted together and none is listed.
    const none = since(
      renderReportHtml(
        reportInput({ prior: priorRecord(), source: noProfile }),
      ),
    );
    expect(none).toContain(
      '<li><span class="bd bd-open">Still open <b>82</b></span></li><li><span class="bd bd-unchanged">Unchanged and met <b>36</b></span></li>',
    );
    expect(none).not.toContain("Still open within");
    expect(none).not.toContain("Still open beyond");
  });

  test("offers the lighter option only on a card that has one, and hides every choice until the script runs", () => {
    const cards = [
      ...html.matchAll(/<article class="rec" id="rec-(R\d)".*?<\/article>/g),
    ];
    const withLighter = cards
      .filter((m) => m[0].includes('value="lighter"'))
      .map((m) => m[1]);
    expect(withLighter).toEqual(["R3", "R5"]);
    for (const m of cards)
      expect(m[0]).toContain('<fieldset class="choose" data-js hidden>');
  });

  test("an absent the agent wrote over a probe's criterion is the agent's", () => {
    const text = readFileSync(RECORD_PATH, "utf8").replace(
      /(precommit-autofix-hooks:[^\n]*\n(?:\s+#[^\n]*\n)*\s+score: absent\n\s+evidence: )"probe: [^\n]*/,
      '$1"Read .github/workflows: no hook runs a formatter."',
    );
    const input = reportInput({ record: text });
    const cell = mapRows(input, targetsOf(input))
      .flatMap((r) => r.cells)
      .find((c) => c.criterion.id === "precommit-autofix-hooks");
    expect(cell?.score).toBe("absent");
    expect(cell?.decidedBy).toBe("agent");
  });

  test("only an absent with the probe's mark is the probe's", () => {
    const input = reportInput();
    const by = Object.fromEntries(
      mapRows(input, targetsOf(input))
        .flatMap((r) => r.cells)
        .filter((c) => c.criterion.probe && c.score === "absent")
        .map((c) => [c.criterion.key, c.decidedBy]),
    );
    // A probe found the hook manager and the decision records missing; the
    // agent read the workflow and found no commit-message check.
    expect(by["M1/precommit-autofix-hooks"]).toBe("probe");
    expect(by["M5/adrs-exist-numbered-from-template"]).toBe("probe");
    expect(Object.values(by)).toContain("agent");
    const raised = reportInput({
      record: currentRecordAt("2026-10-12", {
        "M1/precommit-autofix-hooks": "convention",
      }),
    });
    const cell = mapRows(raised, targetsOf(raised))
      .flatMap((r) => r.cells)
      .find((c) => c.criterion.key === "M1/precommit-autofix-hooks");
    // Raised over the probe's evidence, the score is the agent's.
    expect(cell?.decidedBy).toBe("agent");
  });

  test("the fingerprint changes with any field a decision is made on", () => {
    const recs = reportInput().source.recommendations;
    const changed = (edit: Partial<Recommendation>) =>
      reportFingerprint(recs.map((r, i) => (i === 0 ? { ...r, ...edit } : r)));
    const base = reportFingerprint(recs);
    expect(changed({ action: "Something else." })).not.toBe(base);
    expect(changed({ lighter: "A lighter way." })).not.toBe(base);
    expect(changed({ effort: "large" })).not.toBe(base);
    expect(changed({})).toBe(base);
  });

  test("says how each criterion was decided", () => {
    expect(html).toMatch(
      /<p class="cid">precommit-autofix-hooks<\/p>.*?<b>Decided by a probe\.<\/b>/,
    );
    expect(html).toMatch(
      /<p class="cid">ci-runs-gates-on-pr<\/p>.*?<b>Decided by the agent\.<\/b>/,
    );
  });

  test("shows the starter configuration with its own copy button", () => {
    expect(html).toContain(
      '<pre class="draft" id="draft"># Starter .config/jig.yaml',
    );
    expect(html).toContain('data-copy="draft"');
    const without = renderReportHtml(reportInput({ fit: false }));
    expect(without).toContain(
      "No configuration-fit report was given to this render.",
    );
  });

  test("loads nothing from elsewhere", () => {
    expect(html).not.toMatch(/<(link|img|iframe)\b|<[^>]+\ssrc=|@import|url\(/);
  });

  test("escapes the source's text", () => {
    const hostile = renderReportHtml(
      reportInput({
        source: (s) => {
          s.summary = '<script>alert(1)</script> & "quotes"';
        },
      }),
    );
    expect(hostile).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;",
    );
    expect(hostile).not.toContain("<script>alert(1)");
  });
});

describe("the marks and the chips", () => {
  const input = reportInput();
  const html = renderReportHtml(input);
  const map = html.slice(
    html.indexOf('<ol class="mmap">'),
    html.indexOf('id="start"'),
  );

  test("gives every criterion one mark in the map, linked to its detail, with a popover that explains it", () => {
    const criteria = input.modules.flatMap((m) => m.criteria);
    const marks = [
      ...map.matchAll(
        /<a class="cw" href="#(c-[^"]+)" aria-describedby="(p-[^"]+)">(.*?)<\/a><span class="pop pop-c" role="tooltip" id="\2">/g,
      ),
    ];
    expect(marks.length).toBe(criteria.length);
    for (const m of marks) expect(html).toContain(`id="${m[1]}"`);
    // Each mark draws its rung's icon and names itself for a reader who cannot see it.
    expect(map).toContain(
      '<a class="cw" href="#c-M0-glossary-exists" aria-describedby="p-c-M0-glossary-exists"><span class="c c-absent gap unc"><svg class="ic" aria-hidden="true"><use href="#lc-circle-dashed"/></svg></span><span class="vh">glossary-exists: absent; needed for the target, not met yet; a gap no recommendation covers</span></a>',
    );
    const pop =
      /<span class="pop pop-c" role="tooltip" id="p-c-M0-glossary-exists">(.*?)<\/span><\/span>(?=<span class="pw|<\/span>)/.exec(
        map,
      )?.[1];
    const text = (pop ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const glossary = criteria.find((c) => c.key === "M0/glossary-exists");
    expect(text).toContain(`glossary-exists ${glossary?.statement}`);
    expect(text).toContain("Level Lite");
    expect(text).toContain("Requires convention or stronger");
    expect(text).toContain("Score absent not there yet");
    expect(text).toContain("Decided by");
    expect(text).toContain(
      "Needed for the target, not met yet. No recommendation covers it.",
    );
  });

  test("draws each rung with its own icon, once in a sprite the marks point at", () => {
    expect(html.match(/<symbol id="lc-/g)?.length).toBe(6);
    for (const icon of [
      "circle-dashed",
      "file-text",
      "eye",
      "shield-check",
      "circle-slash",
      "circle-question-mark",
    ])
      expect(html).toContain(`<use href="#lc-${icon}"/>`);
  });

  test("renders every module as the same chip, with its name and purpose in a popover", () => {
    const chips = [
      ...html.matchAll(
        /<span class="pw mw">(?:<a class="mchip" href="#d-(M\d+)" aria-describedby="(mp-\d+)">\1<\/a>|<span class="mchip">(M\d+)<\/span>)<span class="pop pop-m" role="tooltip" id="(mp-\d+)"><b>(M\d+) [^<]+<\/b> [^<]+<\/span><\/span>/g,
      ),
    ];
    // In the map, the recommendation groups, the cards, the uncovered gaps, the detail and the guide.
    expect(chips.length).toBeGreaterThan(50);
    for (const c of chips) {
      if (c[2]) expect(c[2]).toBe(c[4] as string);
      expect(c[5]).toBe((c[1] ?? c[3]) as string);
    }
    const ids = chips.map((c) => c[4]);
    expect(new Set(ids).size).toBe(ids.length);
    // A criterion ref names its module by the chip, its criterion by the id alone.
    expect(html).not.toMatch(/<code>M\d+\/[a-z-]+<\/code>/);
  });

  test("links the method's words to the guide", () => {
    for (const section of [
      "guide-profiles",
      "guide-levels",
      "guide-ladder",
      "guide-read",
      "guide-process",
    ])
      expect(html).toContain(`<a class="term" href="#${section}"`);
  });

  test("renders the same file every time", () => {
    expect(renderReportHtml(reportInput())).toBe(html);
  });
});

describe("the guide", () => {
  const input = reportInput();
  const html = renderReportHtml(input);
  const guide = html.slice(
    html.indexOf('<section class="sec guide" id="guide"'),
  );

  test("is the page's last section, with every part", () => {
    expect(sectionIds(html).at(-1)).toBe("guide");
    expect(
      [
        ...guide.matchAll(
          /<section class="g-sec" id="([a-z-]+)"><h3>([^<]+)<\/h3>/g,
        ),
      ].map((m) => [m[1], m[2]]),
    ).toEqual([
      ["guide-what", "What this is"],
      ["guide-idea", "The idea"],
      ["guide-modules", "The modules"],
      ["guide-profiles", "Profiles"],
      ["guide-process", "How the audit works"],
      ["guide-read", "How to read this report"],
      ["guide-words", "Words used in this sheet"],
    ]);
    // The back link is the script's; without it the guide is a section like the others.
    expect(guide).toContain('<p class="g-back" data-js hidden>');
  });

  test("lists every module with its purpose from the criteria files", () => {
    for (const m of input.modules) expect(guide).toContain(m.purpose);
    expect(
      guide.match(/<ul class="g-mods">(.*?)<\/ul>/)?.[1]?.match(/<li>/g)
        ?.length,
    ).toBe(input.modules.length);
  });

  test("says who every shipped profile is for", () => {
    expect(Object.keys(PROFILE_WHO).sort()).toEqual(
      [...input.profiles.profiles.keys()].sort(),
    );
  });

  test("shows each profile's target for each module as profiles.yaml sets it", () => {
    const yaml = load(
      readFileSync(join(import.meta.dir, "..", "profiles.yaml"), "utf8"),
    ) as {
      profiles: Record<
        string,
        {
          name: string;
          targets?: Record<string, string>;
          conditional?: Record<string, { level: string; when: string }>;
        }
      >;
    };
    const table =
      guide.match(/<table class="chgt g-pt">.*?<\/table>/)?.[0] ?? "";
    const profiles = Object.values(yaml.profiles);
    expect(
      [...table.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m) => m[1]),
    ).toEqual(["Module", ...profiles.map((p) => p.name)]);
    const word = (level: string) =>
      level.charAt(0).toUpperCase() + level.slice(1);
    const rows = [...table.matchAll(/<tr><th scope="row">.*?<\/tr>/g)].map(
      (r) => {
        const [head, ...cells] = r[0]
          .split(/<\/th>|<\/td>/)
          .map((c) => plain(c).trim());
        return { module: head?.split(" ")[0], cells: cells.filter(Boolean) };
      },
    );
    expect(rows.map((r) => r.module)).toEqual(
      input.modules
        .map((m) => m.module)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );
    for (const row of rows)
      expect(row.cells).toEqual(
        profiles.map((p) => {
          const target = p.targets?.[row.module as string];
          const c = p.conditional?.[row.module as string];
          if (target) return word(target);
          return c ? `${word(c.level)}when ${c.when}` : "—";
        }),
      );
  });

  test("the Markdown copy says how to read it and points to the guide", () => {
    const md = renderReportMarkdown(input);
    expect(md).toContain(
      "**How to read this.** Jig audits how a repository delivers changes:",
    );
    expect(md).toContain(
      "[jig-audit-2026-10-12.html#guide](jig-audit-2026-10-12.html#guide).",
    );
    expect(md).toContain(
      "The rungs, weakest first: **absent** (not there yet), **convention** (written down, kept by habit),",
    );
  });
});

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
    expect(md).toContain("- 1 gap no recommendation covers");
    expect(md).toContain(
      "### Not covered by a recommendation (1)\n\nCriteria within the target that do not meet their bar",
    );
    expect(md).toContain("- `M0/glossary-exists`: ");
    expect(md).toMatch(
      /\| \*\*glossary-exists\*\*: .* \| \*\*absent\*\* \(needed for the target, not met yet; a gap no recommendation covers\) \|/,
    );
  });

  test("lists the criteria still open within the target, and only counts those beyond it", () => {
    const text = renderReportMarkdown(reportInput({ prior: priorRecord() }));
    expect(text).toContain(
      [
        "Compared with the audit of 2026-07-19 (plugin 0.14.0): 4 still open within Solo/Lite; 78 beyond it, not needed for this profile; 36 unchanged and met.",
        "",
        "### What changed (42)",
        "",
        "| Module | Criterion | Before → after | Change |",
        "|--------|-----------|----------------|--------|",
        "| M1 Gates enforcement ladder | `gate-set-documented` | absent → convention | Fixed |",
        "| M0 Instruction architecture | `load-model-recorded` | not scored → absent | Added by Jig |",
        "| M0 Instruction architecture | `context-budget-gated` | not scored → absent | Added by Jig |",
        "| M1 Gates enforcement ladder | `gate-outcomes-distinguish-could-not-check` | not scored → absent | Added by Jig |",
        "| M1 Gates enforcement ladder | `stale-exceptions-fail` | not scored → absent | Added by Jig |",
        "| M1 Gates enforcement ladder | `gate-self-tests-cover-empty-input` | not scored → absent | Added by Jig |",
        "| M3 Change area catalog | `area-class-resolved` | not scored → expected absent | Added by Jig |",
        "| M4 Docs governance | `frontmatter-subset-declared` | not scored → absent | Added by Jig |",
        "| M4 Docs governance | `generators-stamp-sticky-utc` | not scored → expected absent | Added by Jig |",
        "| M4 Docs governance | `orphan-report-generated` | not scored → absent | Added by Jig |",
        "| M4 Docs governance | `path-rules-enforce-subtree-vocabulary` | not scored → expected absent | Added by Jig |",
        "| M9 Tasks memory | `gate-flags-scoped-to-shipping-item` | not scored → absent | Added by Jig |",
        "| M9 Tasks memory | `epic-closure-requires-acceptance` | not scored → absent | Added by Jig |",
        "| M9 Tasks memory | `issues-prioritized-at-creation` | not scored → absent | Added by Jig |",
        "| M10 Environments deploy | `artifacts-built-once-promoted-by-digest` | not scored → expected absent | Added by Jig |",
        "| M10 Environments deploy | `promotions-serialized-from-trusted-ref` | not scored → expected absent | Added by Jig |",
        "| M10 Environments deploy | `deploy-verifies-live-identity` | not scored → expected absent | Added by Jig |",
        "| M10 Environments deploy | `release-state-off-source-line` | not scored → expected absent | Added by Jig |",
        "| M12 Parallel agent ergonomics | `change-records-one-file-per-change` | not scored → expected absent | Added by Jig |",
        "| M12 Parallel agent ergonomics | `change-records-assembled-after-merge` | not scored → expected absent | Added by Jig |",
        "| M13 Pipeline economy | `superseded-pr-runs-cancelled` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `every-job-has-timeout` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `no-required-pipeline-path-filtered` | not scored → convention | Added by Jig |",
        "| M13 Pipeline economy | `resolver-drives-selection` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `aggregate-required-check` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `heavy-non-gating-suites-scheduled` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `workflow-conventions-linted` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `job-timeout-ceiling-linted` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `ci-cost-measured` | not scored → absent | Added by Jig |",
        "| M13 Pipeline economy | `queue-stall-watchdog` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `test-tiers-declared` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `testing-rules-written` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `tier-budgets-enforced` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `full-e2e-never-per-change` | not scored → expected absent | Added by Jig |",
        "| M14 Testing strategy | `tests-type-checked` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `tests-come-with-changes` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `fixed-sleeps-banned` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `clock-reads-linted` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `predicates-proven-against-engine` | not scored → expected absent | Added by Jig |",
        "| M14 Testing strategy | `developer-state-isolated` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `doubles-and-builders-typed` | not scored → absent | Added by Jig |",
        "| M14 Testing strategy | `coverage-trend-scheduled` | not scored → absent | Added by Jig |",
        "",
        "### Still open within the target (4)",
        "",
        "| Module | Criterion | Before → after | Change |",
        "|--------|-----------|----------------|--------|",
        "| M0 Instruction architecture | `universal-instruction-file` | absent → absent | still open |",
        "| M0 Instruction architecture | `gates-and-guardrails-listed` | absent → absent | still open |",
        "| M0 Instruction architecture | `glossary-exists` | absent → absent | still open |",
        "| M1 Gates enforcement ladder | `ci-runs-gates-on-pr` | advisory → advisory | still open |",
        "",
        "The 78 still open beyond the target are in Module detail, marked not needed for this profile.",
      ].join("\n"),
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

describe("the decisions text", () => {
  const input: FeedbackInput = {
    repository: "example/web",
    commit: "1a2b3c4d5e6f7a8b9c0d",
    report: "0123456789ab",
    date: "2026-10-13",
    recordProfile: "solo-lite",
    recommendations: [
      { id: "R1", refs: ["M1/ci-runs-gates-on-pr"] },
      { id: "R2", refs: ["M0/universal-instruction-file"] },
      {
        id: "R3",
        refs: ["M1/third-party-automation-pinned-and-updated"],
        lighter: "Pin by hand first.",
      },
      { id: "R4", refs: ["M5/adrs-exist-numbered-from-template"] },
      { id: "R5", refs: ["M2/derived-inventory-exists", "config/x"] },
      { id: "R6", refs: ["M1/gate-set-documented"], lighter: "Write it down." },
    ],
  };

  test("is exactly the agreed block", () => {
    const text = feedbackText(input, {
      profile: "team-standard",
      decisions: {
        R5: { choice: "wrong", note: 'dist/ is "not" committed.' },
        R1: { choice: "accept" },
        R4: {
          choice: "decline",
          reason: "Two maintainers.",
          revisit_when: "a third maintainer joins",
        },
        R3: { choice: "lighter" },
        R2: { choice: "refine", note: "Use the lint job." },
        R6: { choice: "lighter", note: " We add the gate later. " },
      },
    });
    expect(text).toBe(
      [
        "# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)",
        "audit_feedback:",
        "  v: 1",
        '  repository: "example/web"',
        '  commit: "1a2b3c4d5e6f7a8b9c0d"',
        '  report: "0123456789ab"',
        "  profile: team-standard",
        "  accept: [R1]",
        "  refine:",
        '    - { id: R2, note: "Use the lint job." }',
        '    - { id: R3, note: "lighter option: Pin by hand first." }',
        '    - { id: R6, note: "lighter option: Write it down.; We add the gate later." }',
        "  decline:",
        '    - { id: R4, refs: ["M5/adrs-exist-numbered-from-template"], reason: "Two maintainers.", revisit_when: "a third maintainer joins" }',
        "  wrong:",
        '    - { id: R5, refs: ["M2/derived-inventory-exists", "config/x"], note: "dist/ is \\"not\\" committed." }',
      ].join("\n"),
    );
    // It reads back as YAML, notes unchanged.
    expect(load(text)).toEqual({
      audit_feedback: {
        v: 1,
        repository: "example/web",
        commit: "1a2b3c4d5e6f7a8b9c0d",
        report: "0123456789ab",
        profile: "team-standard",
        accept: ["R1"],
        refine: [
          { id: "R2", note: "Use the lint job." },
          { id: "R3", note: "lighter option: Pin by hand first." },
          {
            id: "R6",
            note: "lighter option: Write it down.; We add the gate later.",
          },
        ],
        decline: [
          {
            id: "R4",
            refs: ["M5/adrs-exist-numbered-from-template"],
            reason: "Two maintainers.",
            revisit_when: "a third maintainer joins",
          },
        ],
        wrong: [
          {
            id: "R5",
            refs: ["M2/derived-inventory-exists", "config/x"],
            note: 'dist/ is "not" committed.',
          },
        ],
      },
    });
  });

  test("leaves out empty lists, and the profile when it is the record's", () => {
    expect(
      feedbackText(input, {
        profile: "solo-lite",
        decisions: { R2: { choice: "accept" } },
      }),
    ).toBe(
      [
        "# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)",
        "audit_feedback:",
        "  v: 1",
        '  repository: "example/web"',
        '  commit: "1a2b3c4d5e6f7a8b9c0d"',
        '  report: "0123456789ab"',
        "  accept: [R2]",
      ].join("\n"),
    );
  });

  test("writes the conditional targets and the wrong scores, in module order", () => {
    const head = [
      "# Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)",
      "audit_feedback:",
      "  v: 1",
      '  repository: "example/web"',
      '  commit: "1a2b3c4d5e6f7a8b9c0d"',
      '  report: "0123456789ab"',
    ];
    const conditioned = { ...input, recordProfile: "team-standard" };
    const text = feedbackText(conditioned, {
      conditions: ["M12", "M3"],
      decisions: { R1: { choice: "accept" } },
      scores: {
        "M12/worktree-hooks-wired": " Each agent has its own clone. ",
        "M3/consumer-view-generated": 'The "docs" build generates it.',
      },
    });
    expect(text).toBe(
      [
        ...head,
        "  profile_conditions: [M3, M12]",
        "  accept: [R1]",
        "  scores:",
        '    - { ref: "M3/consumer-view-generated", note: "The \\"docs\\" build generates it." }',
        '    - { ref: "M12/worktree-hooks-wired", note: "Each agent has its own clone." }',
      ].join("\n"),
    );
    expect(load(text)).toMatchObject({
      audit_feedback: {
        profile_conditions: ["M3", "M12"],
        scores: [
          {
            ref: "M3/consumer-view-generated",
            note: 'The "docs" build generates it.',
          },
          {
            ref: "M12/worktree-hooks-wired",
            note: "Each agent has its own clone.",
          },
        ],
      },
    });
    // The record's own set is left out; an emptied one is written empty.
    const recorded = { ...conditioned, recordConditions: ["M12", "M3"] };
    expect(
      feedbackText(recorded, { conditions: ["M3", "M12"], decisions: {} }),
    ).toBe(head.join("\n"));
    expect(feedbackText(recorded, { conditions: [], decisions: {} })).toBe(
      [...head, "  profile_conditions: []"].join("\n"),
    );
    // A changed profile states the conditions that apply under it, when any do.
    expect(
      feedbackText(recorded, {
        profile: "regulated-strict",
        conditions: ["M12", "M3"],
        decisions: {},
      }),
    ).toBe(
      [
        ...head,
        "  profile: regulated-strict",
        "  profile_conditions: [M3, M12]",
      ].join("\n"),
    );
    expect(
      feedbackText(conditioned, { profile: "solo-lite", decisions: {} }),
    ).toBe([...head, "  profile: solo-lite"].join("\n"));
  });

  test("names what a decision lacks before it can be copied", () => {
    expect(
      missingFields(input, {
        decisions: {
          R1: { choice: "accept" },
          R2: { choice: "refine", note: " " },
          R3: { choice: "lighter" },
          R4: { choice: "decline", reason: "x" },
          R5: { choice: "wrong" },
        },
        scores: {
          "M3/consumer-view-generated": " ",
          "M1/gate-set-documented": "n",
        },
      }),
    ).toEqual([
      { id: "R2", needs: ["note"] },
      { id: "R4", needs: ["revisit_when"] },
      { id: "R5", needs: ["note"] },
      { id: "M3/consumer-view-generated", needs: ["note"] },
    ]);
  });
});

describe("the command line", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-audit-report-"));
  const run = (args: string[]) => runScript("report.ts", args, dir, cleanEnv());

  test("validates the source alone, and with the record and fit report", () => {
    const alone = run(["validate", SOURCE_PATH]);
    expect([alone.code, JSON.parse(alone.out)]).toEqual([
      0,
      { ok: true, checked: "source", recommendations: 5 },
    ]);
    const full = run([
      "validate",
      SOURCE_PATH,
      "--record",
      RECORD_PATH,
      "--fit",
      FIT_PATH,
    ]);
    expect(full.code).toBe(0);
    // A gap no recommendation covers is a warning; the exit code stays 0.
    expect(JSON.parse(full.out).uncovered).toEqual(["M0/glossary-exists"]);
    expect(full.err).toContain(
      "warning: M0/glossary-exists is within the Solo/Lite target and not met, and no recommendation covers it: ",
    );
  });

  test("takes --history once per record, and only with --prior", () => {
    const history = join(dir, "history.yaml");
    writeFileSync(history, historyRecord());
    const args = ["render", SOURCE_PATH, "--record", RECORD_PATH];
    const alone = run([...args, "--history", history]);
    expect(alone.code).toBe(2);
    expect(alone.err).toContain("--history needs --prior");
    const newer = join(dir, "newer.yaml");
    writeFileSync(newer, recordAt("2026-12-01"));
    const prior = join(dir, "prior.yaml");
    writeFileSync(prior, priorRecord());
    const refused = run([
      ...args,
      "--prior",
      prior,
      "--history",
      history,
      "--history",
      newer,
      "--out",
      join(dir, "newer-out"),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("history: the record of 2026-12-01");
    expect(existsSync(join(dir, "newer-out"))).toBe(false);
    expect(run(["validate", SOURCE_PATH, "--history", history]).code).toBe(2);
  });

  test("exits 1 for a refused source and 2 for usage or an unreadable input", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...rawSource(), v: 2 }));
    expect(run(["validate", bad]).code).toBe(1);
    const notJson = join(dir, "not.json");
    writeFileSync(notJson, "{");
    expect(run(["validate", notJson]).code).toBe(2);
    expect(run(["validate", join(dir, "missing.json")]).code).toBe(2);
    expect(run(["validate", SOURCE_PATH, "--prior", RECORD_PATH]).code).toBe(2);
    expect(run(["validate", SOURCE_PATH, "--record"]).code).toBe(2);
    expect(
      run([
        "validate",
        SOURCE_PATH,
        "--record",
        RECORD_PATH,
        "--record",
        RECORD_PATH,
      ]).code,
    ).toBe(2);
    expect(run(["frobnicate", SOURCE_PATH]).code).toBe(2);
    expect(run([]).code).toBe(2);
    expect(run(["extract", SOURCE_PATH]).code).toBe(2);
  });

  test("writes nothing for a refused source", () => {
    const out = join(dir, "refused");
    const declinedRecord = join(dir, "declined.yaml");
    writeFileSync(
      declinedRecord,
      recordText(
        [],
        '  - refs: ["M5/adrs-exist-numbered-from-template"]\n    reason: "No."\n    revisit_when: "never"',
      ),
    );
    const r = run([
      "render",
      SOURCE_PATH,
      "--record",
      declinedRecord,
      "--out",
      out,
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "the team declined M5/adrs-exist-numbered-from-template",
    );
    expect(existsSync(out)).toBe(false);
  });

  const SHEET = "jig-audit-2026-10-12.html";

  /**
   * Extract what a sheet in `out` embeds, write each part back to a file,
   * render again into `again`, and return the data and both sheets.
   */
  function roundTrip(out: string, again: string) {
    const extracted = run(["extract", join(out, SHEET)]);
    expect(extracted.code).toBe(0);
    const data = JSON.parse(extracted.out);
    const write = (name: string, value: unknown) => {
      const path = join(again, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    mkdirSync(again, { recursive: true });
    const args = [
      "render",
      write("source.json", data.source),
      "--record",
      write("record.yaml", data.record),
      "--fit",
      write("fit.json", data.fit),
    ];
    if (data.prior) args.push("--prior", write("prior.yaml", data.prior));
    (data.history as unknown[]).forEach((h, i) => {
      args.push("--history", write(`history-${i}.yaml`, h));
    });
    const second = run([...args, "--out", again]);
    expect(second.code).toBe(0);
    return {
      data,
      first: readFileSync(join(out, SHEET), "utf8"),
      second: readFileSync(join(again, SHEET), "utf8"),
    };
  }

  test("renders the sheet and its copy, and extracts what it was rendered from", () => {
    const out = join(dir, "out");
    const r = run([
      "render",
      SOURCE_PATH,
      "--record",
      RECORD_PATH,
      "--fit",
      FIT_PATH,
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      sheet: join(out, SHEET),
      markdown: join(out, "jig-audit-2026-10-12.md"),
    });
    expect(readdirSync(out).sort()).toEqual([SHEET, "jig-audit-2026-10-12.md"]);
    // Each part, written back to a file, renders the same sheet again.
    const { data, first, second } = roundTrip(out, join(dir, "again"));
    expect(data.source).toEqual(rawSource());
    expect(data.prior).toBeNull();
    expect(data.history).toEqual([]);
    expect(second).toBe(first);
  });

  test("renders the trend from older records, and the same sheet again from what it extracts", () => {
    const files = {
      prior: join(dir, "trend-prior.yaml"),
      older: join(dir, "trend-older.yaml"),
      oldest: join(dir, "trend-oldest.yaml"),
    };
    writeFileSync(files.prior, priorRecord());
    writeFileSync(files.older, historyRecord());
    writeFileSync(
      files.oldest,
      recordAt("2026-01-05", { "M2/derived-inventory-exists": "absent" }),
    );
    const out = join(dir, "trend-out");
    const r = run([
      "render",
      SOURCE_PATH,
      "--record",
      RECORD_PATH,
      "--fit",
      FIT_PATH,
      "--prior",
      files.prior,
      "--history",
      files.older,
      "--history",
      files.oldest,
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const { data, first, second } = roundTrip(out, join(dir, "trend-again"));
    // Embedded in the order given; the trend sorts them by date.
    expect(data.history.map((h: { date: string }) => h.date)).toEqual([
      "2026-04-02",
      "2026-01-05",
    ]);
    expect(first).toContain(
      '<p class="trend-s">1 module moved up since 2026-01-05.</p>',
    );
    expect(second).toBe(first);
    expect(
      readFileSync(join(out, "jig-audit-2026-10-12.md"), "utf8"),
    ).toContain(
      "| Module | 2026-01-05 | 2026-04-02 | 2026-07-19 | Now 2026-10-12 |",
    );
  });

  test("reads the repository's own record by default and writes to a new temporary folder", () => {
    const repo = scratchRepo({
      ".config/jig-audit.yaml": readFileSync(RECORD_PATH, "utf8"),
    });
    const r = runScript("report.ts", ["render", SOURCE_PATH], repo, cleanEnv());
    expect(r.code).toBe(0);
    const files = JSON.parse(r.out) as { sheet: string; markdown: string };
    expect(files.sheet.startsWith(repo)).toBe(false);
    expect(existsSync(files.sheet) && existsSync(files.markdown)).toBe(true);
  });
});

describe("colours", () => {
  /** sRGB hex or `oklch(L C H)` to relative luminance, the way a browser draws it. */
  function luminance(colour: string): number {
    const toLinear = (c: number) =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    let rgb: number[];
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
    if (hex)
      rgb = hex.slice(1).map((h) => toLinear(Number.parseInt(h, 16) / 255));
    else {
      const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(colour);
      if (!m) throw new Error(`cannot read ${colour}`);
      const [L, C, H] = m.slice(1).map(Number) as [number, number, number];
      const a = C * Math.cos((H * Math.PI) / 180);
      const b = C * Math.sin((H * Math.PI) / 180);
      const lms = [
        [1, 0.3963377774, 0.2158037573],
        [1, -0.1055613458, -0.0638541728],
        [1, -0.0894841775, -1.291485548],
      ].map(
        ([x, y, z]) =>
          (L * (x as number) + a * (y as number) + b * (z as number)) ** 3,
      );
      const toRgb = [
        [4.0767416621, -3.3077115913, 0.2309699292],
        [-1.2684380046, 2.6097574011, -0.3413193965],
        [-0.0041960863, -0.7034186147, 1.707614701],
      ];
      rgb = toRgb.map((row) =>
        Math.min(
          1,
          Math.max(
            0,
            row.reduce((s, k, i) => s + k * (lms[i] as number), 0),
          ),
        ),
      );
    }
    const [r, g, bl] = rgb as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  }
  const ratio = (fg: string, bg: string) => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [
      number,
      number,
    ];
    return (hi + 0.05) / (lo + 0.05);
  };

  test("reads a known pair right", () => {
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(luminance("oklch(1 0 0)")).toBeCloseTo(1, 2);
  });

  test("every text on its background reaches the accessibility minimum, 4.5:1", () => {
    expect(TEXT_PAIRS.length).toBeGreaterThan(20);
    const failing = TEXT_PAIRS.filter(([fg, bg]) => ratio(fg, bg) < 4.5).map(
      ([fg, bg, where]) =>
        `${where}: ${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`,
    );
    expect(failing).toEqual([]);
  });
});
