/**
 * scanner-annotations.test.ts — reading a scanner app's check-run annotations
 * as findings.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SCANNER_APPS,
  exitFor,
  findingsOf,
  flatten,
  type ScannerRun,
  scannerRuns,
  unsettled,
} from "../scripts/lib/scanner-annotations.ts";

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
    annotations: 3,
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

  it("gives the same finding the same fingerprint, and another a different one", () => {
    const a = {
      path: "a.ts",
      start_line: 1,
      annotation_level: "warning",
      title: "t",
    };
    const [x] = value(findingsOf(r, [a]));
    const [y] = value(findingsOf({ ...r, id: 10 }, [a]));
    const [z] = value(findingsOf(r, [{ ...a, start_line: 2 }]));
    const [w] = value(
      findingsOf(r, [{ ...a, message: "https://x.example/issue=2" }]),
    );
    expect(x?.fingerprint).toBe(y?.fingerprint ?? "");
    expect(x?.fingerprint).not.toBe(z?.fingerprint ?? "");
    expect(x?.fingerprint).not.toBe(w?.fingerprint ?? "");
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
      value(flatten('[{"check_runs":[1]},{"check_runs":[2]}]', "check_runs")),
    ).toEqual([1, 2]);
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
});
