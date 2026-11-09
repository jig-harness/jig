/**
 * The shared infrastructure rule: a failed job is the infrastructure's only
 * when its runner was lost, or a setup step failed on the network, and its log
 * prints no code diagnostic; everything ambiguous is the code's.
 *
 * `tool-download-504.log` is a real failed run's log, trimmed: two code
 * scanning jobs whose tool download answered 504 in their initialisation step.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInfrastructure } from "../ci-infra.ts";

const DOWNLOAD_504 = readFileSync(
  join(import.meta.dir, "fixtures", "ci-infra", "tool-download-504.log"),
  "utf8",
);

/** Lines of one job's step, the way `gh run view --log-failed` prints them. */
const step = (job: string, name: string, ...texts: string[]): string =>
  texts
    .map((t, i) => `${job}\t${name}\t2026-11-08T10:12:${10 + i}.0000000Z ${t}`)
    .join("\n");

const EXIT = "##[error]Process completed with exit code 1.";

describe("readInfrastructure", () => {
  it("keeps padded code diagnostics beside a runner shutdown out of recovery", () => {
    const gap = " ".repeat(40);
    for (const diagnostic of [
      `src/a.ts(3,7):${gap}error${gap}TS2322:${gap}wrong type`,
      `src/a.ts${gap}lint/suspicious/noExplicitAny${gap}Unexpected any.`,
      `src/a.ts:3:7${gap}error${gap}wrong type`,
      `src/a.test.ts${gap}>${gap}suite > test`,
    ]) {
      expect(
        readInfrastructure(
          step(
            "build",
            "Run tests",
            diagnostic,
            "##[error]The runner has received a shutdown signal.",
            EXIT,
          ),
        ).infrastructure,
      ).toBe(false);
    }
  });

  it("reads a tool download that answered 504 in a setup step as infrastructure", () => {
    const r = readInfrastructure(DOWNLOAD_504);
    expect(r.infrastructure).toBe(true);
    expect(r.jobs.map((j) => [j.job, j.infrastructure])).toEqual([
      ["Analyze (python)", true],
      ["Analyze (actions)", true],
    ]);
    expect(r.jobs[0]?.why).toContain("setup step 'Initialize CodeQL'");
    expect(r.jobs[0]?.why).toContain("504");
  });

  it.each([
    {
      name: "a 504 in a step that runs the repository's commands",
      job: "test",
      stepName: "Run tests",
      messages: [
        "Unexpected HTTP response: 504",
        "##[error]Unable to fetch fixture: Unexpected HTTP response: 504",
        EXIT,
      ],
      reason: "'Run tests', which is not a setup step",
    },
    {
      name: "a code diagnostic beside a network failure",
      job: "build",
      stepName: "Install dependencies",
      messages: [
        "error: GET https://registry.example/pkg - HTTP status code 503",
        "src/cart.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        EXIT,
      ],
      reason: "typescript",
    },
    {
      name: "an error annotation that names no infrastructure failure",
      job: "build",
      stepName: "Set up job",
      messages: [
        "Connection timed out while resolving an action; retrying",
        "##[error]Unable to resolve action `example/setup-tool@v9`, unable to find version `v9`",
      ],
      reason: "names no infrastructure failure",
    },
    {
      name: "a 4xx answer in a checkout",
      job: "build",
      stepName: "Checkout repository",
      messages: [
        "fatal: unable to access 'https://forge.example/repo/': The requested URL returned error: 403",
        EXIT,
      ],
      reason: "permanent HTTP failure",
    },
  ])("reads $name as the code's", ({ job, stepName, messages, reason }) => {
    const r = readInfrastructure(step(job, stepName, ...messages));
    expect(r.infrastructure).toBe(false);
    expect(r.why).toContain(reason);
  });

  it("reads a lost runner as infrastructure in any step", () => {
    const r = readInfrastructure(
      step(
        "test",
        "Run tests",
        "##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
        "##[error]The operation was canceled.",
      ),
    );
    expect(r.infrastructure).toBe(true);
    expect(r.jobs[0]?.why).toContain("the runner was lost");
  });

  it("reads a lost runner after a failing test as the code's", () => {
    const r = readInfrastructure(
      step(
        "test",
        "Run tests",
        "FAIL src/cart/total.test.ts",
        "##[error]The runner has received a shutdown signal.",
      ),
    );
    expect(r.infrastructure).toBe(false);
    expect(r.why).toContain("test_failure");
  });

  it("is the code's when one failed job is", () => {
    const r = readInfrastructure(
      [
        step(
          "lint",
          "Set up job",
          "Failed to download action: HTTP status code 502",
          EXIT,
        ),
        step("test", "Run tests", "FAIL src/a.test.ts", EXIT),
      ].join("\n"),
    );
    expect(r.infrastructure).toBe(false);
    expect(r.jobs.map((j) => j.infrastructure)).toEqual([true, false]);
    expect(r.why).toContain("job 'test'");
  });

  it("reads a failure with no infrastructure signal as the code's", () => {
    const r = readInfrastructure(step("gates", "Run gates", EXIT));
    expect(r.infrastructure).toBe(false);
    expect(r.why).toContain("names no infrastructure failure");
  });

  it("does not place a network failure in a log without job and step prefixes", () => {
    const r = readInfrastructure("Unexpected HTTP response: 504\n");
    expect(r.infrastructure).toBe(false);
    expect(r.why).toContain("no step is named for");
  });

  it("rejects runner loss without job and step provenance", () => {
    for (const log of [
      "The runner has received a shutdown signal.",
      step("", "Run tests", "The runner has received a shutdown signal."),
      step("test", "", "The runner has received a shutdown signal."),
    ])
      expect(readInfrastructure(log).infrastructure).toBe(false);
  });

  it("reads both npm transient service diagnostic spellings as infrastructure", () => {
    for (const spelling of ["npm ERR!", "npm error"])
      expect(
        readInfrastructure(
          step(
            "test",
            "Install dependencies",
            "Unexpected HTTP response: 503",
            `${spelling} code E503`,
            EXIT,
          ),
        ).infrastructure,
      ).toBe(true);
  });

  it("rejects permanent diagnostics beside transient failures", () => {
    for (const diagnostic of [
      "FAILED tests/test_cart.py::test_total",
      "ERROR tests/test_cart.py - ImportError: cannot import name cart",
      "____ ERROR collecting tests/test_cart.py ____",
      "____ ERROR at setup of test_total ____",
      "____ ERROR at teardown of tests/test_cart.py::test_total ____",
      "npm ERR! code E403",
      "npm error code E403",
      "error: HTTP 403 Forbidden",
    ])
      expect(
        readInfrastructure(
          step(
            "test",
            "Install dependencies",
            "Unexpected HTTP response: 503",
            diagnostic,
            "The runner has received a shutdown signal.",
          ),
        ).infrastructure,
      ).toBe(false);
  });

  it("classifies the full error annotation before truncating its display", () => {
    expect(
      readInfrastructure(
        step(
          "build",
          "Download tool",
          `##[error]Unable to download https://example.test/${"a".repeat(250)}: Unexpected HTTP response: 503`,
          EXIT,
        ),
      ).infrastructure,
    ).toBe(true);
  });

  it("reads an empty log as the code's", () => {
    expect(readInfrastructure("").infrastructure).toBe(false);
  });
});
