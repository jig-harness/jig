/**
 * The CLI end to end, in scratch git repositories, spawned with the scratch
 * repository as its working directory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseArgs } from "../scripts/code-stats.ts";
import { repository, runCli, temporary, write } from "./helpers.ts";

/** A repository in four languages with no code_stats configuration. */
function polyglot(): string {
  return repository({
    ".gitattributes": "web/lib/chart.min.js linguist-vendored\n",
    "package.json": '{"name":"shop"}\n',
    "web/src/cart.ts": "export const add = (a: number, b: number) => a + b;\n",
    "web/src/cart.test.ts": "import { add } from './cart';\nadd(1, 2);\n",
    "web/lib/chart.min.js": "var chart=1;\n".repeat(50),
    "api/app/orders.py": "# Orders\ndef total():\n    return 1\n",
    "api/tests/test_orders.py": "def test_total():\n    assert True\n",
    "store/store.go": "package store\n\nfunc Get() int { return 1 }\n",
    "store/store_test.go":
      'package store\n\nimport "testing"\n\nfunc TestGet(t *testing.T) {}\n',
    "parse/src/lib.rs": "pub fn parse() {}\n",
    "parse/tests/round_trip.rs": "#[test]\nfn round_trip() {}\n",
    "notes/todo.unknown": "something\n",
  });
}

interface Json {
  totals: { files: number };
  byKind: Record<string, { files: number }>;
  unclassified: { files: number; filesShare: number; kindOther: number };
  vendored: { included: boolean; excludedFiles: number };
}

describe("a repository with no configuration", () => {
  const root = polyglot();

  test("--json: test files by convention, vendored left out, unclassified share present", () => {
    const run = runCli(root, ["--json"]);
    expectSpawnExit(run, 0);
    const report = JSON.parse(run.stdout) as Json;
    expect(report.byKind.test?.files).toBe(4);
    expect(report.byKind.vendored).toBeUndefined();
    expect(report.vendored).toMatchObject({
      included: false,
      excludedFiles: 1,
    });
    expect(report.totals.files).toBe(11);
    expect(report.unclassified.kindOther).toBe(1);
    expect(report.unclassified.filesShare).toBeGreaterThan(0);
  });

  test("--include-vendored counts the vendored file", () => {
    const run = runCli(root, ["--json", "--include-vendored"]);
    expectSpawnExit(run, 0);
    const report = JSON.parse(run.stdout) as Json;
    expect(report.byKind.vendored?.files).toBe(1);
    expect(report.totals.files).toBe(12);
  });

  test("the terminal summary shows the unclassified share and the vendored count", () => {
    const run = runCli(root, []);
    expectSpawnExit(run, 0);
    expect(run.stdout).toContain("Unclassified:");
    expect(run.stdout).toContain("Left out: 1 vendored files");
    expect(run.stdout).toContain(": codebase statistics");
  });

  test("--html writes one self-contained report with the unclassified tile", () => {
    const out = join(temporary(), "report.html");
    const run = runCli(root, ["--html", out]);
    expectSpawnExit(run, 0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("'Unclassified'");
    expect(html).not.toContain("__CODE_STATS_DATA__");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/);
  });

  test("--html defaults to .context/code-stats/ in the repository", () => {
    const run = runCli(root, ["--html"]);
    expectSpawnExit(run, 0);
    expect(
      existsSync(join(root, ".context", "code-stats", "code-stats.html")),
    ).toBe(true);
  });

  test("--explain names the deciding rule for every dimension", () => {
    const run = runCli(root, ["--explain", "store/store_test.go"]);
    expectSpawnExit(run, 0);
    expect(run.stdout).toContain("kind:     test — convention: Go *_test.go");
    expect(run.stdout).toContain(
      "area:     production — default_area: no area rule matched",
    );
    expect(run.stdout).toContain("language: Go — extension .go");
    expect(run.stdout).toContain(
      "module:   store — fallback: the first folder",
    );
    const json = runCli(root, ["--explain", "web/lib/chart.min.js", "--json"]);
    expectSpawnExit(json, 0);
    const explained = JSON.parse(json.stdout) as Record<
      string,
      { value: string; rule: string }
    >;
    for (const dimension of ["area", "kind", "language", "module"])
      expect([dimension, explained[dimension]?.rule]).toEqual([
        dimension,
        expect.stringMatching(/\S/),
      ]);
    expect(explained.kind).toEqual({
      value: "vendored",
      rule: "attribute linguist-vendored",
    });
  });

  test.skipIf(process.platform === "win32")(
    "--explain takes an absolute path through a symbolic link to the repository",
    () => {
      const link = join(temporary(), "linked");
      symlinkSync(root, link);
      const run = runCli(root, ["--explain", join(link, "store", "store.go")]);
      expectSpawnExit(run, 0);
      expect(run.stdout).toStartWith("store/store.go\n");
    },
  );

  test("piped output has no colour codes", () => {
    const run = runCli(root, []);
    expectSpawnExit(run, 0);
    expect(run.stdout).not.toContain("\x1b[");
  });

  test("--explain refuses a path that is not tracked", () => {
    const run = runCli(root, ["--explain", "nowhere.ts"]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain("nowhere.ts is not a tracked file");
  });
});

describe("names the terminal must not act on", () => {
  test.skipIf(process.platform === "win32")(
    "control characters in a tracked name are written visibly, and kept in JSON",
    () => {
      const name = "x\x1b[2Jy\rz";
      const root = repository({ [`${name}/a.ts`]: "x;\n" });
      const summary = runCli(root, []);
      expectSpawnExit(summary, 0);
      expect(summary.stdout).not.toContain("\x1b[2J");
      expect(summary.stdout).toContain("x\\u001b[2Jy\\rz");
      const explained = runCli(root, ["--explain", `${name}/a.ts`]);
      expectSpawnExit(explained, 0);
      expect(explained.stdout).toStartWith("x\\u001b[2Jy\\rz/a.ts\n");
      expect(explained.stdout).not.toContain("\r");
      const json = runCli(root, ["--explain", `${name}/a.ts`, "--json"]);
      expectSpawnExit(json, 0);
      expect(JSON.parse(json.stdout).path).toBe(`${name}/a.ts`);
    },
  );

  test.skipIf(process.platform === "win32")(
    "--explain keeps a backslash, a file-name character on POSIX",
    () => {
      const root = repository({ "a\\b.ts": "x;\n" });
      const run = runCli(root, ["--explain", "a\\b.ts"]);
      expectSpawnExit(run, 0);
      expect(run.stdout).toStartWith("a\\b.ts\n");
    },
  );
});

describe("configuration and failures", () => {
  test("code_stats from .config/jig.yaml and the classify command apply", () => {
    const root = repository({
      ".config/jig.yaml": `code_stats:
  areas:
    - name: web
      paths: ["web/**"]
  default_area: other-code
  classify_command: ${JSON.stringify(`"${process.execPath}" classify.ts`)}
`,
      "classify.ts":
        'const lines = (await Bun.stdin.text()).split("\\n").filter(Boolean);\nfor (const p of lines) if (p.endsWith(".gen.txt")) console.log(JSON.stringify({ path: p, kind: "code", area: "web" }));\n',
      "web/a.ts": "x;\n",
      "api/b.gen.txt": "y\n",
    });
    const run = runCli(root, ["--explain", "api/b.gen.txt"]);
    expectSpawnExit(run, 0);
    expect(run.stdout).toContain("area:     web — classify_command");
    expect(run.stdout).toContain("kind:     code — classify_command");
    const other = runCli(root, ["--explain", "classify.ts"]);
    expectSpawnExit(other, 0);
    expect(other.stdout).toContain("area:     other-code — default_area");
  });

  test("a refused configuration names the field and its file", () => {
    const root = repository({
      ".config/jig.yaml": "code_stats:\n  kinds:\n    tests: ['a/**']\n",
      "a.ts": "x;\n",
    });
    const run = runCli(root, ["--json"]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain('code_stats.kinds has unknown kind "tests"');
    expect(run.stderr).toContain(join(".config", "jig.yaml"));
  });

  test("a failing classify command fails the report", () => {
    const root = repository({
      ".config/jig.yaml": `code_stats:\n  classify_command: ${JSON.stringify(`"${process.execPath}" fail.ts`)}\n`,
      "fail.ts": "console.error('no classification');\nprocess.exitCode = 4;\n",
    });
    const run = runCli(root, ["--json"]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain("failed (exit 4: no classification)");
    expect(run.stdout).toBe("");
  });

  test.skipIf(process.platform === "win32")(
    "a tracked path holding a newline is refused when a classify command is set",
    () => {
      const root = repository({
        ".config/jig.yaml": `code_stats:\n  classify_command: ${JSON.stringify(`"${process.execPath}" -e 0`)}\n`,
        "odd\nname.txt": "x\n",
      });
      const run = runCli(root, ["--json"]);
      expectSpawnExit(run, 1);
      expect(run.stderr).toContain(
        "holds a newline, so code_stats.classify_command cannot be given it",
      );
    },
  );

  test("outside a git repository the report is an error, never empty", () => {
    const dir = temporary();
    write(dir, "a.ts", "x;\n");
    const run = runCli(dir, ["--json"]);
    expectSpawnExit(run, 1);
    expect(run.stderr).toContain("git ls-files failed");
  });
});

describe("parseArgs", () => {
  test("modes and flags", () => {
    expect(parseArgs([]).mode).toBe("terminal");
    expect(parseArgs(["--json"]).mode).toBe("json");
    expect(parseArgs(["--html"]).html).toBeNull();
    expect(parseArgs(["--html", "out.html", "--top", "3"])).toMatchObject({
      mode: "html",
      html: "out.html",
      top: 3,
    });
    expect(parseArgs(["--explain", "a.ts", "--json"]).mode).toBe("explain");
  });

  test.each([
    [["--top", "0"], "--top needs a whole number"],
    [["--top"], "--top needs a whole number"],
    [["--explain"], "--explain needs the path"],
    [["--html", "--json"], "--html cannot be combined"],
    [["--frobnicate"], 'unknown argument "--frobnicate"'],
    [["--html", "-h"], "--html takes a file path, not -h"],
    [["--explain", "-x"], "--explain needs the path of a tracked file"],
    [["--top", "-1"], "--top needs a whole number"],
  ])("refuses %j", (args, message) => {
    expect(() => parseArgs(args)).toThrow(message);
  });

  test("a usage error exits 2", () => {
    const run = runCli(temporary(), ["--top", "x"]);
    expectSpawnExit(run, 2);
    expect(run.stderr).toContain("Usage:");
  });
});
