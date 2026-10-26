/**
 * scanner-annotations.test.ts — reading a scanner app's check-run annotations
 * as findings.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  DEFAULT_SCANNER_APPS,
  exitFor,
  findingsOf,
  flatten,
  LISTED_SUITES,
  type ScannerRun,
  scannerRuns,
  suitesCovered,
  unsettled,
} from "../scripts/lib/scanner-annotations.ts";
import {
  HEAD_A,
  HEAD_B,
  runScript,
  useStubForge,
  writeFixture,
} from "./scripts-harness.ts";

useStubForge();

const run = (
  slug: string,
  id: number,
  status = "completed",
  count: unknown = 1,
  conclusion: string | null = "neutral",
) => ({
  id,
  status,
  conclusion: status === "completed" ? conclusion : null,
  app: { slug },
  output: { annotations_count: count },
});

const value = <T>(
  r: { ok: true; value: T } | { ok: false; error: string },
): T => {
  expect(r).toMatchObject({ ok: true });
  return (r as { value: T }).value;
};

describe("scannerRuns", () => {
  it("keeps only the named apps' check runs, case-insensitively", () => {
    const runs = scannerRuns(
      [run("SonarQubeCloud", 1), run("github-actions", 2), run("other", 3)],
      DEFAULT_SCANNER_APPS,
    );
    expect(value(runs)).toEqual([
      {
        id: 1,
        app: "sonarqubecloud",
        completed: true,
        conclusion: "neutral",
        annotations: 1,
      },
    ]);
  });

  it("marks a run that has not completed", () => {
    const [r] = value(
      scannerRuns(
        [run("sonarqubecloud", 1, "in_progress", 0)],
        ["sonarqubecloud"],
      ),
    );
    expect(r?.completed).toBe(false);
    expect(r?.conclusion).toBeNull();
  });

  it("keeps an unreadable annotation count unknown, never zero", () => {
    const [r] = value(scannerRuns([run("x", 1, "completed", "3")], ["x"]));
    expect(r?.annotations).toBeNull();
  });

  it("refuses malformed listings rather than reading them as no runs", () => {
    expect(scannerRuns("nope", ["x"]).ok).toBe(false);
    expect(scannerRuns([null], ["x"]).ok).toBe(false);
    expect(scannerRuns([{ id: 1, app: { slug: "x" } }], ["x"]).ok).toBe(false);
    expect(scannerRuns([run("x", 1, "completed", 0, null)], ["x"]).ok).toBe(
      false,
    );
  });

  it("refuses a run whose app cannot be read, rather than taking it for another app", () => {
    for (const app of [{}, { slug: "" }, { slug: 7 }])
      expect(
        scannerRuns([{ ...run("x", 1), app }], DEFAULT_SCANNER_APPS).ok,
      ).toBe(false);
  });
});

describe("unsettled", () => {
  const r = (over: Partial<ScannerRun>): ScannerRun => ({
    id: 1,
    app: "x",
    completed: true,
    conclusion: "success",
    annotations: 0,
    ...over,
  });

  it("certifies analysed runs of every configured app", () => {
    expect(unsettled([r({})], ["x"], true)).toEqual({
      pending: [],
      unanalysed: [],
    });
  });

  it("waits for a configured app with no run yet, and for a running one", () => {
    expect(unsettled([], ["x"], true).pending).toHaveLength(1);
    expect(
      unsettled([r({ completed: false, conclusion: null })], ["x"], true)
        .pending,
    ).toHaveLength(1);
    expect(
      unsettled([r({}), r({ id: 2, app: "y" })], ["x", "y", "z"], true).pending,
    ).toEqual(["z: no check run on the head yet"]);
  });

  it("does not expect the default app where it does not run", () => {
    expect(unsettled([], DEFAULT_SCANNER_APPS, false).pending).toEqual([]);
  });

  it("reports a run that completed without analysing", () => {
    for (const conclusion of [
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
    ])
      expect(
        unsettled([r({ conclusion })], ["x"], true).unanalysed,
      ).toHaveLength(1);
    expect(
      unsettled([r({ conclusion: "failure" })], ["x"], true).unanalysed,
    ).toEqual([]);
  });
});

describe("findingsOf", () => {
  const r: ScannerRun = {
    id: 9,
    app: "sonarqubecloud",
    completed: true,
    conclusion: "neutral",
    annotations: null,
  };

  it("reads a warning with its rule message and the tool's link", () => {
    const found = value(
      findingsOf(r, [
        {
          path: "a/b.ts",
          start_line: 81,
          end_line: 81,
          annotation_level: "warning",
          title:
            "Do not use an object literal as default for parameter `rules`.",
          message:
            "\nSee more on https://sonarcloud.io/project/issues?id=x&open=Y",
        },
      ]),
    );
    expect(found).toEqual([
      {
        app: "sonarqubecloud",
        checkRunId: 9,
        path: "a/b.ts",
        line: 81,
        startLine: null,
        level: "warning",
        title: "Do not use an object literal as default for parameter `rules`.",
        message:
          "\nSee more on https://sonarcloud.io/project/issues?id=x&open=Y",
        url: "https://sonarcloud.io/project/issues?id=x&open=Y",
        fingerprint: expect.stringMatching(/^sonarqubecloud-[0-9a-f]{16}$/),
      },
    ]);
  });

  it("keeps the message beside a generic title", () => {
    const [f] = value(
      findingsOf(r, [
        {
          path: "README.md",
          start_line: 2,
          annotation_level: "warning",
          title: "Spell Checker",
          message: "Check your spelling for 'banaas'.",
        },
      ]),
    );
    expect(f?.title).toBe("Spell Checker");
    expect(f?.message).toBe("Check your spelling for 'banaas'.");
    expect(f?.url).toBeNull();
  });

  it("records the start of a multi-line range", () => {
    const [f] = value(
      findingsOf(r, [
        {
          path: "a.ts",
          start_line: 3,
          end_line: 5,
          annotation_level: "failure",
          title: "t",
        },
      ]),
    );
    expect(f?.line).toBe(5);
    expect(f?.startLine).toBe(3);
    expect(f?.message).toBeNull();
  });

  it("keeps a finding's fingerprint on a later run and a moved line, and gives another a different one", () => {
    const a = {
      path: "a.ts",
      start_line: 1,
      annotation_level: "warning",
      title: "t",
    };
    const fingerprints = (run: ScannerRun, annotations: unknown[]) =>
      value(findingsOf(run, annotations)).map((f) => f.fingerprint);
    const [x, otherText, otherFile] = fingerprints(r, [
      a,
      { ...a, message: "https://x.example/issue=2" },
      { ...a, path: "b.ts" },
    ]);
    const [moved] = fingerprints(r, [{ ...a, start_line: 2, end_line: 2 }]);
    expect(fingerprints({ ...r, id: 10 }, [a])).toEqual(fingerprints(r, [a]));
    expect(moved).toBe(x);
    expect(new Set([x, otherText, otherFile]).size).toBe(3);
  });

  it("gives each same-text finding in one file its own fingerprint, kept when an edit moves them", () => {
    const at = (line: number) => ({
      path: "a.ts",
      start_line: line,
      end_line: line,
      annotation_level: "warning",
      title: "t",
    });
    const fingerprints = (annotations: unknown[]) =>
      value(findingsOf(r, annotations)).map((f) => f.fingerprint);
    const [alone] = fingerprints([at(10)]);
    const [later, first] = fingerprints([at(40), at(10)]);
    expect(first).toBe(alone);
    expect(later).toBe(`${alone}-2`);
    expect(fingerprints([at(12), at(55)])).toEqual([`${alone}`, `${alone}-2`]);
  });

  it("drops notices", () => {
    expect(
      value(
        findingsOf(r, [
          {
            path: "a.ts",
            start_line: 1,
            annotation_level: "notice",
            title: "t",
          },
          { annotation_level: "notice" },
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses a finding without a path, line or text, and a malformed list", () => {
    for (const bad of [
      { start_line: 1, annotation_level: "warning", title: "t" },
      { path: "a.ts", annotation_level: "warning", title: "t" },
      { path: "a.ts", start_line: 1, annotation_level: "warning" },
      { path: "a.ts", start_line: 1, title: "t" },
      null,
    ])
      expect(findingsOf(r, [bad]).ok).toBe(false);
    expect(findingsOf(r, { annotations: [] }).ok).toBe(false);
  });

  it("refuses a level GitHub does not define, rather than dropping it as a notice", () => {
    for (const annotation_level of ["Warning", "error", "info"])
      expect(
        findingsOf(r, [
          { path: "a.ts", start_line: 1, annotation_level, title: "t" },
        ]).ok,
      ).toBe(false);
  });

  it("refuses a line before 1, a malformed line and a reversed range", () => {
    for (const lines of [
      { start_line: 0, end_line: 0 },
      { start_line: 1, end_line: 0 },
      { start_line: "3", end_line: 3 },
      { start_line: 5, end_line: 3 },
    ])
      expect(
        findingsOf(r, [
          { path: "a.ts", annotation_level: "warning", title: "t", ...lines },
        ]).ok,
      ).toBe(false);
  });

  it("refuses a completed run's list that does not hold its reported count", () => {
    const a = {
      path: "a.ts",
      start_line: 1,
      annotation_level: "notice",
      title: "t",
    };
    const counted = { ...r, annotations: 2 };
    expect(findingsOf(counted, [a, a]).ok).toBe(true);
    expect(findingsOf(counted, [a]).ok).toBe(false);
    expect(findingsOf(counted, []).ok).toBe(false);
    expect(findingsOf(counted, [a, a, a]).ok).toBe(false);
    expect(
      findingsOf({ ...counted, completed: false, conclusion: null }, [a]).ok,
    ).toBe(true);
  });
});

describe("suitesCovered", () => {
  it("accepts a count the check-run listing covers, up to the bound", () => {
    expect(value(suitesCovered("3\n"))).toBe(3);
    expect(value(suitesCovered(String(LISTED_SUITES)))).toBe(LISTED_SUITES);
  });

  it("refuses a count past the bound, and one it cannot read", () => {
    for (const raw of [String(LISTED_SUITES + 1), "", "null", "-1", "1.5"])
      expect(suitesCovered(raw).ok).toBe(false);
  });
});

describe("exitFor", () => {
  it("waits while anything is pending, then reports an unanalysed run", () => {
    expect(exitFor({ pending: ["p"], unanalysed: ["u"] })).toBe(3);
    expect(exitFor({ pending: [], unanalysed: ["u"] })).toBe(4);
    expect(exitFor({ pending: [], unanalysed: [] })).toBe(0);
  });
});

describe("flatten", () => {
  it("joins every page's list", () => {
    expect(
      value(
        flatten(
          '[{"total_count":2,"check_runs":[1]},{"total_count":2,"check_runs":[2]}]',
          "check_runs",
        ),
      ),
    ).toEqual([1, 2]);
    expect(
      value(flatten('[{"total_count":0,"check_runs":[]}]', "check_runs")),
    ).toEqual([]);
    expect(value(flatten("[[]]"))).toEqual([]);
    expect(value(flatten("[[1],[2,3]]"))).toEqual([1, 2, 3]);
  });

  it("refuses a page without its list, and anything that is not pages", () => {
    expect(
      flatten('[{"check_runs":[1]},{"message":"x"}]', "check_runs").ok,
    ).toBe(false);
    expect(flatten('[{"message":"x"}]').ok).toBe(false);
    expect(flatten('{"check_runs":[]}', "check_runs").ok).toBe(false);
    expect(flatten("not json").ok).toBe(false);
  });

  it("refuses a result with no page, rather than reading it as an empty listing", () => {
    expect(flatten("[]", "check_runs").ok).toBe(false);
    expect(flatten("[]").ok).toBe(false);
  });

  it("refuses an envelope whose total is missing, differs between pages or is not what the pages hold", () => {
    for (const raw of [
      '[{"check_runs":[]}]',
      '[{"total_count":"1","check_runs":[1]}]',
      '[{"total_count":1,"check_runs":[]}]',
      '[{"total_count":1,"check_runs":[1,2]}]',
      '[{"total_count":2,"check_runs":[1]},{"total_count":3,"check_runs":[2]}]',
    ])
      expect(flatten(raw, "check_runs").ok).toBe(false);
  });
});

describe("list-scanner-annotations.ts", () => {
  const warning = {
    path: "a.ts",
    start_line: 4,
    end_line: 4,
    annotation_level: "warning",
    title: "Do not use an object literal as default for parameter `rules`.",
  };

  /** A fixture whose head carries `runs` (check runs) and each run's annotation pages. */
  function scanned(opts: {
    runs: unknown[];
    annotations?: Record<number, unknown[][]>;
    heads?: string[];
    suites?: string;
    /** The check-run listing's pages, when not one page holding `runs`. */
    envelope?: unknown[];
  }) {
    const fix = writeFixture({});
    writeFileSync(
      join(fix.dir, "scanner-runs.json"),
      JSON.stringify(
        opts.envelope ?? [
          { total_count: opts.runs.length, check_runs: opts.runs },
        ],
      ),
    );
    for (const [id, pages] of Object.entries(opts.annotations ?? {}))
      writeFileSync(
        join(fix.dir, `annotations-${id}.json`),
        JSON.stringify(pages),
      );
    writeFileSync(
      join(fix.dir, "heads"),
      `${(opts.heads ?? [HEAD_A]).join("\n")}\n`,
    );
    if (opts.suites !== undefined)
      writeFileSync(join(fix.dir, "suite-count"), opts.suites);
    return fix;
  }

  const list = (fix: ReturnType<typeof scanned>, args = [fix.pr]) =>
    runScript("list-scanner-annotations.ts", args, fix);

  /** Asserts the listing's exit, with its output in the report on a mismatch. */
  const exits = (r: ReturnType<typeof list>, code: number) =>
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      code,
    );

  it("prints every finding across pages and exits 0 once the scanner analysed the head", () => {
    const fix = scanned({
      runs: [run("sonarqubecloud", 7, "completed", 2), run("other", 8)],
      annotations: {
        7: [[warning], [{ ...warning, start_line: 9, end_line: 9 }]],
      },
    });
    const r = list(fix);
    exits(r, 0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((f) => [f.app, f.checkRunId, f.line])).toEqual([
      ["sonarqubecloud", 7, 4],
      ["sonarqubecloud", 7, 9],
    ]);
  });

  it("exits 0 with nothing printed where the default scanner does not run", () => {
    const r = list(scanned({ runs: [run("other", 8)] }));
    exits(r, 0);
    expect(r.stdout).toBe("");
  });

  it("exits 3 while the scanner is still running", () => {
    const r = list(
      scanned({ runs: [run("sonarqubecloud", 7, "in_progress", 0)] }),
    );
    exits(r, 3);
    expect(r.stderr).toContain("has not completed");
  });

  it("exits 3 when the head moves while listing", () => {
    const r = list(
      scanned({
        runs: [run("sonarqubecloud", 7, "completed", 0)],
        heads: [HEAD_A, HEAD_B],
      }),
    );
    exits(r, 3);
    expect(r.stderr).toContain("the head moved");
  });

  it("exits 4 when the scanner completed without analysing the head", () => {
    const r = list(
      scanned({
        runs: [run("sonarqubecloud", 7, "completed", 0, "cancelled")],
      }),
    );
    exits(r, 4);
  });

  it("exits 1 when the annotations do not hold the count the run reports", () => {
    const r = list(
      scanned({
        runs: [run("sonarqubecloud", 7, "completed", 3)],
        annotations: { 7: [[warning]] },
      }),
    );
    exits(r, 1);
    expect(r.stderr).toContain("reports 3 annotation(s) but lists 1");
  });

  it("exits 1 when the head has more check suites than the listing covers", () => {
    const r = list(scanned({ runs: [], suites: String(LISTED_SUITES + 1) }));
    exits(r, 1);
    expect(r.stderr).toContain("check suites");
  });

  it("refuses a second PR and an unknown flag as usage errors", () => {
    const fix = scanned({ runs: [] });
    exits(list(fix, [fix.pr, "34"]), 2);
    exits(list(fix, ["--all"]), 2);
  });

  it("exits 1 when the check-run listing does not hold the total it reports", () => {
    const r = list(
      scanned({ runs: [], envelope: [{ total_count: 1, check_runs: [] }] }),
    );
    exits(r, 1);
    expect(r.stderr).toContain("reports 1 'check_runs' but holds 0");
  });

  it("exits 1 when the check-run listing holds no page", () => {
    const r = list(scanned({ runs: [], envelope: [] }));
    exits(r, 1);
    expect(r.stderr).toContain("holds no page");
  });
});
