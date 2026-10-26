/**
 * scanner-annotations.test.ts — reading a scanner app's check-run annotations
 * as findings.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SCANNER_APPS,
  findingsOf,
  scannerRuns,
} from "../scripts/lib/scanner-annotations.ts";

const run = (slug: string, id: number, status = "completed", count = 1) => ({
  id,
  status,
  app: { slug },
  output: { annotations_count: count },
});

describe("scannerRuns", () => {
  it("keeps only the named apps' check runs, case-insensitively", () => {
    const runs = scannerRuns(
      [run("SonarQubeCloud", 1), run("github-actions", 2), run("other", 3)],
      DEFAULT_SCANNER_APPS,
    );
    expect(runs).toEqual([
      { id: 1, app: "sonarqubecloud", completed: true, annotations: 1 },
    ]);
  });

  it("marks a run that has not completed", () => {
    const [r] = scannerRuns(
      [run("sonarqubecloud", 1, "in_progress", 0)],
      ["sonarqubecloud"],
    );
    expect(r?.completed).toBe(false);
  });

  it("ignores malformed entries", () => {
    expect(scannerRuns([null, {}, { id: 1, app: null }], ["x"])).toEqual([]);
    expect(scannerRuns("nope", ["x"])).toEqual([]);
  });
});

describe("findingsOf", () => {
  const r = { id: 9, app: "sonarqubecloud", completed: true, annotations: 3 };

  it("reads a warning with its rule message and the tool's link", () => {
    const found = findingsOf(r, [
      {
        path: "a/b.ts",
        start_line: 81,
        end_line: 81,
        annotation_level: "warning",
        title: "Do not use an object literal as default for parameter `rules`.",
        message:
          "\nSee more on https://sonarcloud.io/project/issues?id=x&open=Y",
      },
    ]);
    expect(found).toEqual([
      {
        app: "sonarqubecloud",
        checkRunId: 9,
        path: "a/b.ts",
        line: 81,
        startLine: null,
        level: "warning",
        title: "Do not use an object literal as default for parameter `rules`.",
        url: "https://sonarcloud.io/project/issues?id=x&open=Y",
      },
    ]);
  });

  it("records the start of a multi-line range", () => {
    const [f] = findingsOf(r, [
      {
        path: "a.ts",
        start_line: 3,
        end_line: 5,
        annotation_level: "failure",
        title: "t",
      },
    ]);
    expect(f?.line).toBe(5);
    expect(f?.startLine).toBe(3);
    expect(f?.url).toBeNull();
  });

  it("drops notices and annotations without a path, line or text", () => {
    expect(
      findingsOf(r, [
        { path: "a.ts", start_line: 1, annotation_level: "notice", title: "t" },
        { start_line: 1, annotation_level: "warning", title: "t" },
        { path: "a.ts", annotation_level: "warning", title: "t" },
        { path: "a.ts", start_line: 1, annotation_level: "warning" },
      ]),
    ).toEqual([]);
  });
});
