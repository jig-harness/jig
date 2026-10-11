/**
 * The CI log parser: every error category, the fix-priority order, the
 * deduplication and truncation rules, and the run-resolution paths through
 * `gh` and `git` (faked through the `Runner` seam).
 *
 * The `*.log` fixtures are synthetic. Each `*.expected.json` pins the whole
 * output for its log, so a change in any field, in key order or in sort order
 * shows up as a diff.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CommandResult,
  main,
  PRIORITY,
  parseArgs,
  parseCiErrors,
  type Runner,
} from "../scripts/parse-ci-log.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** One prefixed log line, the way `gh run view --log-failed` prints it. */
const gh = (text: string) => `job\tstep\t2026-03-02T10:00:00.0000000Z ${text}`;
const only = (text: string) => parseCiErrors(gh(text)).errors;
/** The provenance `gh` gives every entry. */
const AT = { job: "job", step: "step" };

describe("pinned outputs", () => {
  for (const name of ["mixed", "clean", "encodings"])
    it(`${name}.log parses to ${name}.expected.json`, () => {
      expect(
        JSON.stringify(parseCiErrors(fixture(`${name}.log`), "4242"), null, 2),
      ).toBe(fixture(`${name}.expected.json`).trimEnd());
    });
});

describe("categories", () => {
  it("typescript: file, position, code and message", () => {
    expect(
      only(
        "src/cart/total.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ),
    ).toEqual([
      {
        category: "typescript",
        ...AT,
        raw: "src/cart/total.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        file: "src/cart/total.ts",
        line: 12,
        column: 7,
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
  });

  it("biome_lint: a rule-named diagnostic keeps the rule", () => {
    expect(
      only("src/a.ts lint/suspicious/noExplicitAny  Unexpected any."),
    ).toMatchObject([
      {
        category: "biome_lint",
        file: "src/a.ts",
        rule: "lint/suspicious/noExplicitAny",
        message: "Unexpected any.",
      },
    ]);
  });

  it("biome_lint: a positioned diagnostic has no rule", () => {
    expect(
      only("src/a.tsx:4:2 format error Formatter would have printed"),
    ).toMatchObject([
      {
        category: "biome_lint",
        file: "src/a.tsx",
        rule: "",
        message: "Formatter would have printed",
      },
    ]);
  });

  it("biome_lint: the cross marker as mis-decoded bytes", () => {
    expect(only("src/a.ts:1:1 lint \xc3\x97 Unused import.")).toMatchObject([
      { category: "biome_lint", file: "src/a.ts", message: "Unused import." },
    ]);
  });

  it("test_failure: a FAIL line names the file", () => {
    expect(only("FAIL src/cart/total.test.ts")).toEqual([
      {
        category: "test_failure",
        ...AT,
        raw: "FAIL src/cart/total.test.ts",
        file: "src/cart/total.test.ts",
        message: "",
      },
    ]);
  });

  it("test_failure: an assertion path joins its parts", () => {
    expect(only("src/a.spec.tsx > suite > case > boom")).toEqual([
      {
        category: "test_failure",
        ...AT,
        raw: "src/a.spec.tsx > suite > case > boom",
        file: "src/a.spec.tsx",
        message: "suite > case > boom",
      },
    ]);
  });

  it("build_error: missing modules", () => {
    expect(only("Cannot find module '@shop/money'")).toMatchObject([
      { category: "build_error", message: "Cannot find module '@shop/money'" },
    ]);
    expect(only("Module not found: Can't resolve './x'")).toMatchObject([
      { category: "build_error" },
    ]);
  });

  it("schema_drift: points at the regeneration commands", () => {
    for (const line of [
      "Schema drift detected",
      "schema drift in schema.sql",
      "schema:check failed",
    ])
      expect(only(line)).toEqual([
        {
          category: "schema_drift",
          ...AT,
          raw: line,
          message:
            "Schema drift detected - regenerate the schema (fix_ci.regenerate_commands)",
        },
      ]);
  });

  it("drift_check: generated-artifact drift in its several spellings", () => {
    for (const line of [
      "openapi.json: drift detected",
      "client is out-of-sync",
      "OpenAPI drift found",
      "type surface drift",
      "error code drift",
      "Eden coverage is incomplete",
      "please regenerate the spec",
      "run `pnpm openapi:generate`",
      "run 'npm run api:sync'",
      "run bun run types:generate",
      "run yarn client:sync",
    ])
      expect(only(line)).toEqual([
        { category: "drift_check", ...AT, raw: line, message: line },
      ]);
  });

  it("gate_failure: error annotations and markers at the start of a line", () => {
    for (const line of [
      "::error file=a.ts::no direct fetch",
      "##[error]Unable to process file command",
      "❌ ratchet rose",
      "✗ placeholder check",
      "Error: something broke",
      "FAILED: link check",
    ])
      expect(only(line)).toEqual([
        { category: "gate_failure", ...AT, raw: line, message: line },
      ]);
    expect(only("this mentions error: midway")).toEqual([]);
  });

  it("process_exit: the runner's generic step-exit note is not a gate diagnostic", () => {
    const line = "##[error]Process completed with exit code 1.";
    expect(only(line)).toEqual([
      { category: "process_exit", ...AT, raw: line, message: line },
    ]);
  });

  it("a line matching several patterns goes to the first", () => {
    // Both a TypeScript error and an `error:` annotation; TypeScript wins.
    expect(only("a.ts(1,1): error TS1005: ';' expected.")[0]?.category).toBe(
      "typescript",
    );
  });
});

describe("output rules", () => {
  it("sorts by fix priority and counts per category", () => {
    const r = parseCiErrors(
      [
        gh("FAIL a.test.ts"),
        gh("::error::gate"),
        gh("a.ts(1,1): error TS2304: Cannot find name 'x'."),
        gh("Schema drift detected"),
      ].join("\n"),
      "7",
    );
    expect(r.errors.map((e) => e.category)).toEqual([
      "schema_drift",
      "typescript",
      "test_failure",
      "gate_failure",
    ]);
    expect(r.summary).toEqual({
      schema_drift: 1,
      typescript: 1,
      test_failure: 1,
      gate_failure: 1,
    });
    expect(r.run_id).toBe("7");
    expect(r.errors_found).toBe(4);
    expect(r.files_affected).toEqual(["a.test.ts", "a.ts"]);
    const ranks = r.errors.map((e) => PRIORITY[e.category]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("drops duplicates and keeps the first", () => {
    const line = gh("a.ts(1,1): error TS2304: Cannot find name 'x'.");
    expect(parseCiErrors(`${line}\n${line}\n`).errors_found).toBe(1);
  });

  it("keeps one exit note per step, each naming its job and step", () => {
    const exit =
      "2026-03-02T10:00:00.0Z ##[error]Process completed with exit code 1.";
    const r = parseCiErrors(
      [
        `lint\tRun biome\t${exit}`,
        `lint\tRun biome\t${exit}`,
        `lint\tGrep gates\t${exit}`,
        `test\tRun biome\t${exit}`,
      ].join("\n"),
    );
    expect(r.errors.map((e) => [e.category, e.job, e.step])).toEqual([
      ["process_exit", "lint", "Run biome"],
      ["process_exit", "lint", "Grep gates"],
      ["process_exit", "test", "Run biome"],
    ]);
  });

  it("an unprefixed line carries no job or step", () => {
    const [entry] = parseCiErrors("::error::gate").errors;
    expect(entry).toEqual({
      category: "gate_failure",
      raw: "::error::gate",
      message: "::error::gate",
    });
  });

  it("keeps distinct diagnostics that share a file and a message prefix", () => {
    const prefix = "x".repeat(60);
    const r = parseCiErrors(
      [
        gh("a.ts(1,1): error TS2304: Cannot find name 'x'."),
        gh("a.ts(2,1): error TS2304: Cannot find name 'x'."),
        gh(`error: ${prefix} first`),
        gh(`error: ${prefix} second`),
        gh("Schema drift detected in users"),
        gh("Schema drift detected in orders"),
      ].join("\n"),
    );
    expect(r.summary).toEqual({
      schema_drift: 2,
      typescript: 2,
      gate_failure: 2,
    });
  });

  it("truncates raw text to 200 characters, counting emoji as one", () => {
    const long = `error: ${"🛒".repeat(250)}`;
    const [e] = only(long);
    expect(Array.from(e?.raw ?? "").length).toBe(200);
    expect(e?.message).toBe(e?.raw);
  });

  it("treats CRLF and a lone CR as line breaks", () => {
    expect(
      parseCiErrors("FAIL a.test.ts\r\nlone\r::error::x\r\n").errors_found,
    ).toBe(2);
  });

  it("reads lines without the gh prefix too", () => {
    expect(parseCiErrors("FAIL a.test.ts").errors_found).toBe(1);
  });

  it("an empty log has no errors", () => {
    expect(parseCiErrors("")).toEqual({
      run_id: "",
      errors_found: 0,
      summary: {},
      files_affected: [],
      errors: [],
    });
  });
});

describe("arguments", () => {
  it("accepts a run ID, a PR in either spelling, a branch and a saved log", () => {
    expect(parseArgs(["123"])).toMatchObject({ runId: "123" });
    expect(parseArgs(["--pr", "45"])).toMatchObject({ pr: "45" });
    expect(parseArgs(["--pr", "#45"])).toMatchObject({ pr: "45" });
    expect(parseArgs(["#45"])).toMatchObject({ pr: "45" });
    expect(parseArgs(["feature/x"])).toMatchObject({ branch: "feature/x" });
    expect(parseArgs(["--branch", "main"])).toMatchObject({ branch: "main" });
    expect(parseArgs(["--log", "ci.log", "9"])).toMatchObject({
      logFile: "ci.log",
      runId: "9",
    });
  });

  it("refuses a missing value, an unknown flag and a non-numeric PR", () => {
    expect(parseArgs(["--pr"])).toBeString();
    expect(parseArgs(["--nope"])).toBeString();
    expect(parseArgs(["--pr", "abc"])).toBeString();
  });
});

/** A fake `gh`/`git`: answers by the command's leading words. */
function fakeRunner(answers: Record<string, CommandResult>): {
  runner: Runner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: Runner = async (argv) => {
    const call = argv.join(" ");
    calls.push(call);
    const key = Object.keys(answers).find((k) => call.startsWith(k));
    return key === undefined
      ? { code: 1, stdout: "", stderr: `unexpected: ${call}` }
      : (answers[key] as CommandResult);
  };
  return { runner, calls };
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

async function capture(
  argv: string[],
  runner: Runner,
  files: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, runner, {
    out: (t) => {
      out += `${t}\n`;
    },
    err: (t) => {
      err += `${t}\n`;
    },
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  });
  return { code, out, err };
}

describe("run resolution", () => {
  const log = ok(gh("FAIL src/a.test.ts"));

  it("no arguments: the current branch's latest failed run", async () => {
    const { runner, calls } = fakeRunner({
      "git branch --show-current": ok("feature/cart\n"),
      "gh run list --branch feature/cart": ok('[{"databaseId":555}]'),
      "gh run view 555 --log-failed": log,
    });
    const r = await capture([], runner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ run_id: "555", errors_found: 1 });
    expect(calls).toHaveLength(3);
  });

  it("--pr: the PR branch's latest failed run", async () => {
    const { runner } = fakeRunner({
      "gh pr view 12": ok("feature/pay\n"),
      "gh run list --branch feature/pay": ok('[{"databaseId":77}]'),
      "gh run view 77 --log-failed": log,
    });
    const r = await capture(["--pr", "12"], runner);
    expect(JSON.parse(r.out)).toMatchObject({ run_id: "77", errors_found: 1 });
  });

  it("an explicit run ID skips the lookup", async () => {
    const { runner, calls } = fakeRunner({
      "gh run view 9 --log-failed": log,
    });
    await capture(["9"], runner);
    expect(calls).toEqual(["gh run view 9 --log-failed"]);
  });

  it("an unknown PR reports it and exits 0", async () => {
    const { runner } = fakeRunner({
      "gh pr view 404": {
        code: 1,
        stdout: "",
        stderr:
          "GraphQL: Could not resolve to a PullRequest with the number of 404.",
      },
    });
    const r = await capture(["#404"], runner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      error: "PR #404 not found",
      errors_found: 0,
      errors: [],
    });
  });

  it("no failed run reports no_failed_runs and exits 0", async () => {
    const { runner } = fakeRunner({
      "gh run list --branch main": ok("[]"),
    });
    const r = await capture(["--branch", "main"], runner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      error: "no_failed_runs",
      errors_found: 0,
      errors: [],
    });
  });

  it("a failed PR lookup exits 1 with gh's message", async () => {
    const { runner } = fakeRunner({
      "gh pr view 12": {
        code: 4,
        stdout: "",
        stderr: "gh auth login required",
      },
    });
    const r = await capture(["--pr", "12"], runner);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("gh auth login required");
  });

  it("a failed or unreadable run list exits 1, not no_failed_runs", async () => {
    for (const answer of [
      { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" },
      ok("<html>"),
      ok('{"message":"rate limited"}'),
      ok('[{"name":"ci"}]'),
    ]) {
      const { runner } = fakeRunner({ "gh run list --branch main": answer });
      const r = await capture(["--branch", "main"], runner);
      expect(r.code).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("gh run list --branch main");
    }
  });

  it("a detached HEAD without arguments is a usage error", async () => {
    const { runner } = fakeRunner({ "git branch --show-current": ok("\n") });
    const r = await capture([], runner);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no current branch");
  });

  it("a log that cannot be fetched exits 1 with gh's message", async () => {
    const { runner } = fakeRunner({
      "gh run view 5 --log-failed": {
        code: 1,
        stdout: "",
        stderr: "run 5 is still in progress",
      },
    });
    const r = await capture(["5"], runner);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("still in progress");
  });

  it("--log parses a saved file without calling gh", async () => {
    const { runner, calls } = fakeRunner({});
    const r = await capture(["--log", "ci.log", "4242"], runner, {
      "ci.log": fixture("mixed.log"),
    });
    expect(calls).toEqual([]);
    expect(r.out.trimEnd()).toBe(fixture("mixed.expected.json").trimEnd());
  });

  it("--log on a missing file exits 1", async () => {
    const { runner } = fakeRunner({});
    expect((await capture(["--log", "nope.log"], runner)).code).toBe(1);
  });
});
