import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  DEFAULT_NOUNS,
  lintProse,
  parseNouns,
  talliesOf,
} from "./lint-derivable-counts.ts";
import { phrasingPattern } from "./check-registered-facts.ts";

const gate = join(import.meta.dir, "lint-derivable-counts.ts"),
  fixture = join(import.meta.dir, "fixture");

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    cwd: fixture,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const cases: [string, string[], number][] = [
  ["tallies of adjacent lists", ["tallies.md"], 1],
  ["constraints, labels, identifiers, code, a marker", ["constraints.md"], 0],
  ["a registered fact without the registry", ["registered.md"], 1],
  [
    "a registered fact with the registry",
    ["--registry", "facts.yaml", "registered.md"],
    0,
  ],
  [
    "several files, one with a tally",
    ["--registry", "facts.yaml", "registered.md", "tallies.md"],
    1,
  ],
  ["the repository's own nouns", ["--nouns", "nouns.txt", "tallies.md"], 0],
  [
    "a malformed registry",
    ["--registry", "facts-malformed.yaml", "registered.md"],
    2,
  ],
  ["a missing nouns file", ["--nouns", "no-such.txt", "tallies.md"], 2],
  ["a missing prose file", ["no-such.md"], 2],
  ["an empty prose file", ["empty.md"], 2],
  ["a prose file that is a directory", ["guides"], 2],
];
for (const [name, args, code] of cases)
  test(`${name} exits ${code}`, () => expectSpawnExit(run(args), code));

test("every tally is a finding with its line and the three remedies", () => {
  const result = run(["tallies.md"]);
  expectSpawnExit(result, 1);
  const lines = result.stderr.trim().split("\n");
  expect(lines.filter((line) => line.includes("[derivable-count]"))).toEqual([
    'tallies.md:3: [derivable-count] "6 passes" reads as a tally of a list the repository holds, with no check behind it',
    'tallies.md:4: [derivable-count] "Twelve skills" reads as a tally of a list the repository holds, with no check behind it',
    'tallies.md:4: [derivable-count] "4 categories" reads as a tally of a list the repository holds, with no check behind it',
    'tallies.md:5: [derivable-count] "three templates" reads as a tally of a list the repository holds, with no check behind it',
  ]);
  expect(lines[1]).toContain("drop the number");
  expect(lines[1]).toContain("register it as a fact");
  expect(lines[1]).toContain("<!-- measured -->");
});

test("the repository's nouns replace the starter list", () => {
  const result = run(["--nouns", "nouns.txt", "registered.md"]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain('"3 guides"');
  expect(result.stderr).not.toContain('"2 tools"');
  expect(run(["--nouns", "empty.md", "tallies.md"]).stderr).toContain(
    "names no noun",
  );
});

test("a pass says what it could not see", () =>
  expect(run(["constraints.md"]).stdout).toContain(
    "OK — no unchecked tally in 1 file(s) (a judgement by shape",
  ));

test("usage errors never pass", () => {
  expectSpawnExit(run([]), 2);
  expectSpawnExit(run(["--nouns"]), 2);
  expectSpawnExit(run(["--registry"]), 2);
  expectSpawnExit(run(["--bogus", "tallies.md"]), 2);
});

const nouns = new Set(DEFAULT_NOUNS);
test("talliesOf: a cardinal before a counted noun", () => {
  expect(talliesOf("The 6 passes are: a, b.", nouns)).toEqual(["6 passes"]);
  expect(talliesOf("Twelve skills, four Modules and 3 lenses", nouns)).toEqual([
    "Twelve skills",
    "four Modules",
    "3 lenses",
  ]);
  expect(talliesOf("3 widgets and 2 of the files", nouns)).toEqual([]);
  expect(talliesOf("1 file, one module, 0 gates", nouns)).toEqual([]);
});

test("talliesOf: a constraint in the candidate's own clause exempts it", () => {
  expect(talliesOf("at most 3 retries and up to 20 files", nouns)).toEqual([]);
  expect(talliesOf("a limit of 8 files per batch", nouns)).toEqual([]);
  expect(talliesOf("send 3 files or fewer", nouns)).toEqual([]);
  expect(talliesOf("send 3 files per batch", nouns)).toEqual([]);
  expect(talliesOf("send 3 files at most", nouns)).toEqual([]);
  expect(talliesOf("the 3 files, then the rest", nouns)).toEqual(["3 files"]);
  expect(talliesOf("the 3 files performed well", nouns)).toEqual(["3 files"]);
  expect(talliesOf("≤ 8000 chars across 3 files", nouns)).toEqual([]);
  // A constraint in another sentence exempts nothing.
  expect(talliesOf("At most 3 retries. The 6 gates are below.", nouns)).toEqual(
    ["6 gates"],
  );
  expect(talliesOf("The 6 gates enforce a max of 3 retries.", nouns)).toEqual([
    "6 gates",
  ]);
});

test("talliesOf: labels, identifiers and list markers are not counts", () => {
  expect(talliesOf("step 4 gates; tier 2 tools; phase 3 jobs", nouns)).toEqual(
    [],
  );
  expect(
    talliesOf(
      "ADR-0012 rules, v2 skills, #44 files, 2026-10 docs, §3 pages",
      nouns,
    ),
  ).toEqual([]);
  expect(talliesOf("80% of files and 5+ files; 2.5 modules", nouns)).toEqual(
    [],
  );
  expect(talliesOf("2. templates come second", nouns)).toEqual([]);
  expect(talliesOf("## 3 gates", nouns)).toEqual(["3 gates"]);
  expect(talliesOf("### 3) gates", nouns)).toEqual([]);
});

test("lintProse: code is blanked, the measured marker exempts the line, a registered phrasing is not a tally", () => {
  const text = [
    "6 passes",
    "`6 passes` and ``7 gates`` here",
    "```",
    "6 passes",
    "```",
    "120 skills <!-- measured: ls skills -->",
    "120 skills <!--measured-->",
    "3 guides total and 4 guides",
  ].join("\n");
  const findings = lintProse(text, "f.md", nouns, [
    /(?<![\w-])(\d+)\s+guides\s+total(?![\w-])/gi,
  ]);
  expect(findings.map((f) => [f.line, f.problem.split('"')[1]])).toEqual([
    [1, "6 passes"],
    [8, "4 guides"],
  ]);
});

test("lintProse: a registered phrasing wrapped across lines is not a tally, and lines stay aligned", () => {
  const text = [
    "There are 3 guides",
    "total here.",
    "And 5 guides",
    "after.",
  ].join("\r\n");
  const findings = lintProse(text, "f.md", nouns, [
    phrasingPattern("N guides total"),
  ]);
  expect(findings.map((f) => [f.line, f.problem.split('"')[1]])).toEqual([
    [3, "5 guides"],
  ]);
});

test("parseNouns lowers case and drops comments, blanks and repeats", () => {
  expect([
    ...parseNouns("Recipes\n guides # also built in\n\n# only\nguides\n"),
  ]).toEqual(["recipes", "guides"]);
  expect(parseNouns("# nothing\n").size).toBe(0);
});
