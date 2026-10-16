import { describe, expect, test } from "bun:test";
import { pluginMessages } from "./grit-fixtures.ts";

// The harness's failure branches never run in a green rule suite, so each is
// probed here on a recorded shape of Biome's JSON report.

const finding = (severity: string) => ({
  severity,
  category: "plugin",
  message: "jig/rule: a finding",
});

const run = (exitCode: number | null, diagnostics: unknown[]) => ({
  exitCode,
  stdout: JSON.stringify({ diagnostics }),
  stderr: "stderr-marker",
});

describe("pluginMessages", () => {
  test("plugin findings are returned, a warning with exit 0", () => {
    expect(pluginMessages("r", run(0, [finding("warning")]))).toEqual([
      "jig/rule: a finding",
    ]);
  });

  test("error-severity findings explain the findings exit status", () => {
    expect(pluginMessages("r", run(1, [finding("error")]))).toHaveLength(1);
  });

  test("a fixture that does not parse fails the run", () => {
    const parse = { severity: "error", category: "parse", message: "x" };
    expect(() => pluginMessages("r", run(1, [parse]))).toThrow(
      /could not check the file/,
    );
  });

  test("a non-plugin error fails the run, even beside findings", () => {
    const config = { severity: "error", category: "configuration" };
    expect(() =>
      pluginMessages("r", run(1, [finding("error"), config])),
    ).toThrow(/could not check the file/);
  });

  test("an exit status lint findings do not explain fails the run", () => {
    expect(() => pluginMessages("r", run(1, []))).toThrow(
      /exited with 1: stderr-marker/,
    );
    expect(() => pluginMessages("r", run(2, [finding("error")]))).toThrow(
      /exited with 2/,
    );
    expect(() => pluginMessages("r", run(null, []))).toThrow(
      /exited with null/,
    );
  });

  test("output that is not a report fails the run", () => {
    expect(() =>
      pluginMessages("r", { exitCode: 1, stdout: "", stderr: "no plugin" }),
    ).toThrow(/no JSON report: no plugin/);
    expect(() =>
      pluginMessages("r", { exitCode: 0, stdout: "{}", stderr: "" }),
    ).toThrow(/no diagnostics list/);
  });
});
