/**
 * The audit sheet: the report source's validation, the checks against the
 * record and the fit report, when each recommendation is due under the
 * profile, the sheet's sections and markers, the Markdown copy, the
 * decisions text, the command line and the colours.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import { TEXT_PAIRS } from "../scripts/report/css.ts";
import {
  feedbackText,
  type FeedbackInput,
  missingFields,
} from "../scripts/report/feedback-text.ts";
import { renderReportHtml } from "../scripts/report/html.ts";
import { renderReportMarkdown } from "../scripts/report/markdown.ts";
import {
  horizonOf,
  inputProblems,
  mapRows,
  startHere,
  targetsOf,
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
  noProfile,
  RECORD_PATH,
  rawSource,
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
});

const sectionIds = (html: string) =>
  [...html.matchAll(/<section class="sec[^"]*" id="([a-z]+)"/g)].map(
    (m) => m[1],
  );

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
    ]);
    expect(again).toContain("Compared with the audit of 2026-07-19");
    expect(again).toMatch(
      /Fixed \(1\)<\/h3><ul class="chg"><li><code>M1\/gate-set-documented<\/code>/,
    );
  });

  test("names the commit, the plugin and the suggested profile in the masthead", () => {
    expect(html).toContain(`title="${COMMIT}">63ddae6</dd>`);
    expect(html).toContain("<dd>0.15.0</dd>");
    expect(html).toContain(
      'Solo/Lite <span class="pchip p-suggested">suggested</span>',
    );
    expect(html).not.toContain("Heading to");
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
    expect(grow).toContain("<dt>Heading to</dt><dd>Team/Standard</dd>");
  });

  /** The map's rows, without its legend. */
  const mapOf = (page: string) =>
    page.slice(page.indexOf('<ol class="mmap">'), page.indexOf('id="start"'));

  test("never colours a criterion beyond the target as a gap", () => {
    const rings = [...mapOf(html).matchAll(/<i class="c c-[a-z-]+ gap"/g)]
      .length;
    expect(rings).toBe(4);
    expect(renderReportHtml(reportInput({ source: noProfile }))).not.toMatch(
      /<i class="c c-[a-z-]+ gap"/,
    );
  });

  test("folds what is not for now under its own heading, saying why", () => {
    expect(html).toContain(
      '<details class="later" id="h-optional" open data-fold><summary><span class="later-h">Optional</span> <span class="later-n">(2)</span></summary><p class="intro">Beyond what Solo/Lite asks for. Not needed for this profile: take one when the project needs it.</p>',
    );
    const grow = renderReportHtml(
      reportInput({ record: recordText(["heading_to: team-standard"]) }),
    );
    expect(grow).toContain(
      "Beyond what Solo/Lite asks for now; worth it as the project grows toward Team/Standard.",
    );
    expect(grow).not.toContain('id="h-optional"');
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

/** An older record of the same repository: CI was not running the gates then. */
function priorRecord(): string {
  return readFileSync(RECORD_PATH, "utf8")
    .replace('date: "2026-10-12"', 'date: "2026-07-19"')
    .replace("plugin_version: 0.15.0", "plugin_version: 0.14.0")
    .replace(
      /(M1\/gate-set-documented:[^\n]*\n(?:\s+#[^\n]*\n)*\s+score:) convention/,
      "$1 absent",
    );
}

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
      }),
    ).toEqual([
      { id: "R2", needs: ["note"] },
      { id: "R4", needs: ["revisit_when"] },
      { id: "R5", needs: ["note"] },
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
      sheet: join(out, "jig-audit-2026-10-12.html"),
      markdown: join(out, "jig-audit-2026-10-12.md"),
    });
    expect(readdirSync(out).sort()).toEqual([
      "jig-audit-2026-10-12.html",
      "jig-audit-2026-10-12.md",
    ]);

    const extracted = run(["extract", join(out, "jig-audit-2026-10-12.html")]);
    expect(extracted.code).toBe(0);
    const data = JSON.parse(extracted.out);
    expect(data.source).toEqual(rawSource());
    expect(data.prior).toBeNull();
    // Each part, written back to a file, renders the same sheet again.
    const again = join(dir, "again");
    writeFileSync(join(dir, "source.json"), JSON.stringify(data.source));
    writeFileSync(join(dir, "record.yaml"), JSON.stringify(data.record));
    writeFileSync(join(dir, "fit.json"), JSON.stringify(data.fit));
    const second = run([
      "render",
      join(dir, "source.json"),
      "--record",
      join(dir, "record.yaml"),
      "--fit",
      join(dir, "fit.json"),
      "--out",
      again,
    ]);
    expect(second.code).toBe(0);
    expect(readFileSync(join(again, "jig-audit-2026-10-12.html"), "utf8")).toBe(
      readFileSync(join(out, "jig-audit-2026-10-12.html"), "utf8"),
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
