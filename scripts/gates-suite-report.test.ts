import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";

const root = resolve(import.meta.dir, "..");

function usesRawBunTest(command: string): boolean {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let comment = false;
  const finishWord = () => {
    if (word) words.push(word);
    word = "";
  };
  const finishCommand = () => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    const next = command[index + 1];
    if (comment) {
      if (character === "\n") {
        comment = false;
        finishCommand();
      }
      continue;
    }
    if (character === "\\") {
      if (next === "\n") {
        index++;
        continue;
      }
      const escaped = command[++index];
      if (escaped) word += escaped;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && !word) {
      comment = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (character === "\n") finishCommand();
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      finishCommand();
      if (next === character) index++;
      continue;
    }
    word += character;
  }
  finishCommand();

  return commands.some((tokens) => {
    let next = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[next] ?? "")) next++;
    if (tokens[next] !== "bun") return false;
    next++;
    while (tokens[next]?.startsWith("--")) {
      if (tokens[next] === "--cwd") next++;
      next++;
    }
    return tokens[next] === "test";
  });
}

test("every CI suite uses the reporting runner and its executed-test check", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.scripts.test).toBe("bun scripts/test.ts");
  const runner = readFileSync(join(root, "scripts/test.ts"), "utf8");
  expect(runner).toContain('"--reporter=junit"');
  expect(runner).toContain("`--reporter-outfile=$" + "{report}`");
  expect(runner).toContain("checkTestsExecuted([report])");
  for (const file of ["gates.yml", "nightly.yml"]) {
    const workflow = loadYaml(
      readFileSync(join(root, ".github/workflows", file), "utf8"),
    ) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    // Direct Bun test commands bypass the fresh report and the tripwire. The
    // suite contracts in gates.test.ts pin selections and complete shard sets.
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? [])
        expect(usesRawBunTest(step.run ?? "")).toBeFalse();
  }
});

test("the suite-runner contract rejects raw Bun spellings", () => {
  for (const command of [
    "bun test scripts/gates.test.ts",
    "bun  test scripts/gates.test.ts",
    "bun --no-env-file test scripts/gates.test.ts",
    "bun --cwd . test scripts/gates.test.ts",
    'bun --cwd "my repo" test scripts/gates.test.ts',
    "CI=1 bun test scripts/gates.test.ts",
    '"bun" test scripts/gates.test.ts',
    ["bun", "test scripts/gates.test.ts"].join(" \\\n"),
    "bun run check\nbun test scripts/gates.test.ts",
    "bun run check | bun test scripts/gates.test.ts",
  ])
    expect(usesRawBunTest(command)).toBeTrue();
  for (const command of [
    "bun run test scripts/gates.test.ts",
    "bun --no-env-file run test scripts/gates.test.ts",
    "bun --cwd=. run test scripts/gates.test.ts",
    "# bun run test scripts/gates.test.ts\nbun run check",
    'echo "documentation; bun test scripts/gates.test.ts"',
    'echo "documentation & bun test scripts/gates.test.ts"',
    "# documentation; bun test scripts/gates.test.ts",
  ])
    expect(usesRawBunTest(command)).toBeFalse();
});
