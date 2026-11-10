import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";

const root = resolve(import.meta.dir, "..");

// The effective shell depends on step, job and workflow defaults and on the
// runner's platform (a Windows step with no shell runs PowerShell), so a step
// that declares none is scanned under every escape character that could apply.
function usesRawBunTest(command: string, shell?: string): boolean {
  const escapes =
    shell === undefined
      ? ["\\", "`"]
      : [shell === "pwsh" || shell === "powershell" ? "`" : "\\"];
  return escapes.some((escapeChar) => scansRawBunTest(command, escapeChar));
}

function scansRawBunTest(command: string, escapeChar: string): boolean {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let comment = false;
  // PowerShell escapes with a backtick and reads a backslash literally,
  // everything else the reverse.
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
    if (quote) {
      if (character === quote) quote = null;
      else if (
        character === escapeChar &&
        quote === '"' &&
        next !== undefined
      ) {
        word += next;
        index++;
      } else word += character;
      continue;
    }
    if (character === escapeChar) {
      if (next === "\n") {
        index++;
        continue;
      }
      const escaped = command[++index];
      if (escaped) word += escaped;
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
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "(" ||
      character === ")"
    ) {
      finishCommand();
      if (next === character) index++;
      continue;
    }
    word += character;
  }
  finishCommand();

  // Conservative on purpose: any `bun` word, wherever shell grammar puts it
  // (after `then`, `env -u X`, `command`, `!`, a path), that reaches `test`
  // through its options counts. A harmless printed example in a here-document
  // is rewritten rather than taught to this scanner.
  const bunOptionsWithValue = new Set(["--cwd", "--preload", "-r"]);
  return commands.some((tokens) =>
    tokens.some((token, start) => {
      if (token.split("/").pop() !== "bun") return false;
      let next = start + 1;
      while (tokens[next]?.startsWith("-")) {
        if (bunOptionsWithValue.has(tokens[next] ?? "")) next++;
        next++;
      }
      return tokens[next] === "test";
    }),
  );
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
      jobs: Record<string, { steps?: { run?: string; shell?: string }[] }>;
    };
    // Direct Bun test commands bypass the fresh report and the tripwire. The
    // suite contracts in gates.test.ts pin selections and complete shard sets.
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? [])
        expect(usesRawBunTest(step.run ?? "", step.shell)).toBeFalse();
  }
});

test("the suite-runner contract rejects raw Bun spellings", () => {
  for (const command of [
    "bun test scripts/gates.test.ts",
    "bun  test scripts/gates.test.ts",
    "bun --no-env-file test scripts/gates.test.ts",
    "bun --cwd . test scripts/gates.test.ts",
    "if true; then bun test scripts/gates.test.ts; fi",
    "env CI=1 bun test scripts/gates.test.ts",
    "bun --preload ./setup.ts test scripts/gates.test.ts",
    "bun -r ./setup.ts test scripts/gates.test.ts",
    "echo 'C:\\\\'\nbun test scripts/gates.test.ts",
    'bun --cwd "my repo" test scripts/gates.test.ts',
    "CI=1 bun test scripts/gates.test.ts",
    '"bun" test scripts/gates.test.ts',
    ["bun", "test scripts/gates.test.ts"].join(" \\\n"),
    "bun run check\nbun test scripts/gates.test.ts",
    "bun run check | bun test scripts/gates.test.ts",
    "while bun test ./website/; do break; done",
    "! bun test ./website/",
    "(bun test ./website/)",
    "command bun test ./website/",
    "/usr/local/bin/bun test ./website/",
    "env -u CI bun test ./website/",
    "env --unset CI bun test ./website/",
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
  // A backslash-escaped quote is only known to be one under a declared POSIX
  // shell; an undeclared shell is also read as PowerShell and flags it.
  const escapedQuote = 'echo "quoted \\"; bun test ./website/"; echo ok';
  expect(usesRawBunTest(escapedQuote, "bash")).toBeFalse();
  expect(usesRawBunTest(escapedQuote)).toBeTrue();
  for (const shell of [undefined, "pwsh", "powershell"]) {
    expect(
      usesRawBunTest("bun `\ntest scripts/gates.test.ts", shell),
    ).toBeTrue();
    expect(
      usesRawBunTest('Write-Output "C:\\"\nbun test ./website/', shell),
    ).toBeTrue();
    // Only a declared shell settles which escape character reads the quote.
    expect(
      usesRawBunTest('Write-Output "a`"; bun test ./website/"', shell),
    ).toBe(shell === undefined);
  }
});
