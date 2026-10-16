import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type Fact,
  parseRegistry,
  phrasingPattern,
  scanProse,
} from "./check-registered-facts.ts";

const gate = join(import.meta.dir, "check-registered-facts.ts"),
  fixture = join(import.meta.dir, "fixture");

function run(args: string[], cwd = fixture) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    cwd,
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
  ["every stated copy agrees", ["facts.yaml", "instructions.md"], 0],
  [
    "several files at once",
    ["facts.yaml", "instructions.md", "registered.md"],
    0,
  ],
  ["a stated copy disagrees", ["facts.yaml", "stated-drift.md"], 1],
  ["a phrasing without N", ["facts-malformed.yaml", "instructions.md"], 2],
  [
    "a registry that declares nothing",
    ["facts-no-facts.yaml", "instructions.md"],
    2,
  ],
  [
    "a derive command that fails",
    ["facts-command-fails.yaml", "instructions.md"],
    2,
  ],
  [
    "a derive command that prints no count",
    ["facts-not-a-count.yaml", "instructions.md"],
    2,
  ],
  [
    "a files glob that matches nothing",
    ["facts-no-match.yaml", "instructions.md"],
    2,
  ],
  ["a missing registry", ["no-such.yaml", "instructions.md"], 2],
  ["a missing prose file", ["facts.yaml", "no-such.md"], 2],
  ["an empty prose file", ["facts.yaml", "empty.md"], 2],
  ["a prose file that is a directory", ["facts.yaml", "guides"], 2],
];
for (const [name, args, code] of cases)
  test(`${name} exits ${code}`, () => expectSpawnExit(run(args), code));

test("drift names the copy, the derived value and the source, once per copy", () => {
  const result = run(["facts.yaml", "stated-drift.md"]);
  expectSpawnExit(result, 1);
  const lines = result.stderr.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(
    'stated-drift.md:3: [registered-fact] states "7 guides total", but guides (guides/**/*.md) has 3',
  );
  expect(lines[1]).toContain("restate it as 3");
  expect(result.stdout).toContain("guides derives to 3 from guides/**/*.md");
  expect(result.stdout).toContain("tools derives to 2 from `echo 2`");
});

test("a pass counts the stated copies; a fact nobody states is not a finding", () => {
  expect(run(["facts.yaml", "instructions.md"]).stdout).toContain(
    "OK — 2 stated copies of 2 fact(s) in 1 file(s); none disagrees",
  );
  expect(run(["facts.yaml", "guides/setup.md"]).stdout).toContain(
    "OK — 0 stated copies of 2 fact(s)",
  );
});

test("--root resolves the registry, the globs, the command and the prose", () => {
  expectSpawnExit(
    run(["--root", fixture, "facts.yaml", "instructions.md"], import.meta.dir),
    0,
  );
  expectSpawnExit(run(["facts.yaml", "instructions.md"], import.meta.dir), 2);
});

test("could-not-check says why", () => {
  expect(run(["facts-no-match.yaml", "instructions.md"]).stderr).toContain(
    "a wrong glob, not an empty set",
  );
  expect(run(["facts-not-a-count.yaml", "instructions.md"]).stderr).toContain(
    'printed "many", not a count',
  );
  expect(run(["facts-past-2-53.yaml", "instructions.md"]).stderr).toContain(
    "printed 9007199254740993, past 2^53",
  );
  expect(run(["facts-command-fails.yaml", "instructions.md"]).stderr).toContain(
    'the command of "tools" exited 3',
  );
});

test("usage errors never pass", () => {
  expectSpawnExit(run([]), 2);
  expectSpawnExit(run(["facts.yaml"]), 2);
  expectSpawnExit(run(["--root"]), 2);
  expectSpawnExit(run(["--bogus", "facts.yaml", "instructions.md"]), 2);
});

test("parseRegistry refuses what it cannot derive or recognize", () => {
  const bad = (text: string, reason: string) =>
    expect(() => parseRegistry(text)).toThrow(reason);
  bad("", "empty");
  bad("facts: [", "not YAML");
  bad("other: 1", "non-empty `facts:` list");
  bad("facts:\n  - files: a\n    phrasings: [N a]", "needs an id");
  bad(
    "facts:\n  - id: a\n    phrasings: [N a]",
    "exactly one of files, command",
  );
  bad(
    "facts:\n  - id: a\n    files: a\n    command: b\n    phrasings: [N a]",
    "exactly one of files, command",
  );
  bad("facts:\n  - id: a\n    files: a\n    phrasings: []", "phrasings");
  bad(
    "facts:\n  - id: a\n    files: a\n    phrasings: [N a N]",
    "exactly one N",
  );
  bad(
    "facts:\n  - id: a\n    files: a\n    phrasings: [N a]\n    extra: 1",
    "unknown field extra",
  );
  bad(
    "facts:\n  - id: a\n    files: a\n    phrasings: [N a]\n  - id: a\n    files: b\n    phrasings: [N b]",
    "declared twice",
  );
  bad(
    "facts:\n  - id: a\n    command: echo 1\n    exclude: [x]\n    phrasings: [N a]",
    "exclude goes with files",
  );
  const [fact] = parseRegistry(
    "facts:\n  - id: a\n    files: a/*.md\n    phrasings: [N a total]",
  );
  expect(fact?.source).toEqual({ files: ["a/*.md"], exclude: [] });
});

test("a phrasing matches whole words, any case and spacing, and captures the number", () => {
  const match = (phrasing: string, text: string) =>
    [...text.matchAll(phrasingPattern(phrasing))].map((m) => m[1]);
  expect(match("N guides total", "3 guides total; 13  Guides Total")).toEqual([
    "3",
    "13",
  ]);
  expect(match("N guides total", "13 guides totals; 3 guides-total")).toEqual(
    [],
  );
  expect(match("a total of N guides", "a total of 4 guides")).toEqual(["4"]);
  expect(match("N (approx.) guides", "7 (approx.) guides")).toEqual(["7"]);
});

test("scanProse skips code and reports every drifted copy", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { stated, findings } = scanProse(
    "3 guides total\n`9 guides total` 8 guides total\n```\n7 guides total\n```\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(stated).toBe(2);
  expect(findings.map((f) => [f.line, f.problem])).toEqual([
    [2, 'states "8 guides total", but g (g) has 3'],
  ]);
});

test("each files glob must match a file, not only their union", () => {
  const result = run(["facts-glob-partly-wrong.yaml", "instructions.md"]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain('the files glob "recpies/**/*.md"');
});

test("a derive command is one string, never a list", () => {
  const result = run(["facts-command-list.yaml", "instructions.md"]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("must be one command, as a string");
});

test("N beside punctuation is a placeholder in both validation and matching", () => {
  const match = (phrasing: string, text: string) =>
    [...text.matchAll(phrasingPattern(phrasing))].map((m) => m[1]);
  expect(match("(N) guides total", "(7) guides total")).toEqual(["7"]);
  expect(match("N, guides total", "7, guides total")).toEqual(["7"]);
  expect(match("N: guides", "7: guides; 17: guides")).toEqual(["7", "17"]);
  const [fact] = parseRegistry(
    "facts:\n  - id: a\n    files: a\n    phrasings: ['(N) a']",
  );
  expect(fact?.phrasings).toEqual(["(N) a"]);
});

test("scanProse compares a stated number exactly, past 2^53 too", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { findings } = scanProse(
    "9007199254740993 guides total. 007 guides total.",
    new Map([[fact, 9007199254740992]]),
    "f.md",
  );
  expect(findings.map((f) => f.problem)).toEqual([
    'states "9007199254740993 guides total", but g (g) has 9007199254740992',
    'states "007 guides total", but g (g) has 9007199254740992',
  ]);
});

test("scanProse sees a phrasing wrapped across lines and counts a copy once", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total", "There are N guides total"],
  };
  const { stated, findings } = scanProse(
    "Intro.\nThere are 7 guides\ntotal, and 7\nguides total.\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(stated).toBe(2);
  expect(findings.map((f) => [f.line, f.problem])).toEqual([
    [2, 'states "7 guides total", but g (g) has 3'],
    [3, 'states "7 guides total", but g (g) has 3'],
  ]);
});

test("a backtick run with a backtick in its info string is a code span, not a fence", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { findings } = scanProse(
    "```example```\n7 guides total\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(findings.map((f) => f.line)).toEqual([2]);
});

test("a code span may cross a line but not a blank one", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { findings } = scanProse(
    "see `7\nguides total` here\n7 guides total\n\n`7 guides\n\ntotal`\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(findings.map((f) => f.line)).toEqual([3, 5]);
});

test("a code span crosses one line however the line ends", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  for (const end of ["\n", "\r\n", "\r"]) {
    const { findings } = scanProse(
      `see \`7${end}guides total\` here${end}`,
      new Map([[fact, 3]]),
      "f.md",
    );
    expect(findings).toEqual([]);
  }
});

test("a code span stops at a blank line however the lines end", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  for (const end of ["\r\n", "\r"]) {
    const { findings } = scanProse(
      `intro \`${end}${end}7 guides total${end}${end}end \`${end}`,
      new Map([[fact, 3]]),
      "f.md",
    );
    expect(findings.map((f) => f.problem)).toEqual([
      'states "7 guides total", but g (g) has 3',
    ]);
  }
});

test("a code span stays within its block", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const blocks = [
    "# `Heading\n7 guides total\nend`\n",
    "a `b\n# 7 guides total `\n",
    "a `b\n***\n7 guides total `\n",
    "a `b\n| 7 guides total ` |\n| --- |\n",
    "| a |\n| --- |\n| `b |\n| 7 guides total ` |\n",
    "- a `b\n- 7 guides total `\n",
    "a `b\n1. 7 guides total `\n",
    "- a `b\n2. 7 guides total `\n",
    "> a `b\n> - 7 guides total `\n",
    "> > a `b\n> 2. 7 guides total `\n",
    "a `b\n- \n7 guides total `\n",
    "a `b\n> 7 guides total `\n",
    "a `b\n===\n7 guides total `\n",
  ];
  for (const text of blocks) {
    const { findings } = scanProse(text, new Map([[fact, 3]]), "f.md");
    expect(findings.length).toBe(1);
  }
  const within = [
    "- a `b\n  7 guides total `\n",
    "> a `b\n> 7 guides total `\n",
    "> a `b\n7 guides total `\n",
    "Example: `sample\n2. 7 guides total\nend`\n",
    "a `b\n| 7 guides total\nend `\n",
    "a `b\n| 7 guides total ` |\n",
    "> a `b\n> 2. 7 guides total `\n",
  ];
  for (const text of within) {
    const { findings } = scanProse(text, new Map([[fact, 3]]), "f.md");
    expect(findings).toEqual([]);
  }
});

test("a fence opened and closed on CRLF lines is code", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { findings } = scanProse(
    "~~~\r\n7 guides total\r\n~~~\r\n7 guides total\r\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(findings.map((f) => f.line)).toEqual([4]);
});

test("an escaped backtick opens no code span, and an escaped backslash does not escape it", () => {
  const fact: Fact = {
    id: "g",
    source: { files: ["g"], exclude: [] },
    phrasings: ["N guides total"],
  };
  const { findings } = scanProse(
    "a \\` 7 guides total \\` b\nc \\\\` 7 guides total ` d\n",
    new Map([[fact, 3]]),
    "f.md",
  );
  expect(findings.map((f) => f.line)).toEqual([1]);
});
