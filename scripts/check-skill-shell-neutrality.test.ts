import { expect, test } from "bun:test";
import { shellFindings } from "./check-skill-shell-neutrality.ts";

test("rejects shell composition and direct native commands in executable blocks", () => {
  for (const command of [
    "bun script.ts | bun next.ts",
    "bun script.ts > result.json",
    "bun script.ts < input.json",
    "bun script.ts && bun next.ts",
    "bun script.ts || true",
    "bun script.ts $(git rev-parse HEAD)",
    "bun script.ts <<'END'",
    "test -f logfile",
    "scratch=$(mktemp -d)",
    "git status",
    "bun script.ts \\",
  ])
    expect(
      shellFindings("fixture.md", `\x60\x60\x60bash\n${command}\n\x60\x60\x60`),
    ).not.toHaveLength(0);
});

test("accepts plain argv, placeholders, quoted jq expressions and comments", () => {
  const source = [
    "```bash",
    "# Read the current result",
    `bun "\${CLAUDE_SKILL_DIR}/script.ts" --input <input-file>`,
    "bun command.ts -- gh api repos/owner/repo --jq '.items | last'",
    "```",
  ].join("\n");
  expect(shellFindings("fixture.md", source)).toEqual([]);
});

test("checks inline bun commands while leaving JSON and explanatory text alone", () => {
  expect(
    shellFindings("fixture.md", "Run `bun script.ts < body.json`."),
  ).toHaveLength(1);
  expect(
    shellFindings(
      "fixture.md",
      '```json\n{"command":"git diff | grep files"}\n```\nThe `&&` operator is shell syntax.',
    ),
  ).toEqual([]);
});

test("PowerShell interpolation is refused even inside double quoted arguments", () => {
  expect(
    shellFindings("fixture.md", '```sh\nbun script.ts "$HEAD"\n```'),
  ).toHaveLength(1);
  expect(
    shellFindings("fixture.md", '```sh\nbun script.ts "`whoami`"\n```'),
  ).toHaveLength(1);
});

test("rejects wildcard expansion, shell escapes, and incompatible quote concatenation", () => {
  for (const command of [
    "bun script.ts *.md",
    "bun script.ts C:\\temp\\data",
    "bun script.ts 'foo''bar'",
    "bun script.ts {first,second}",
    "bun command.ts -- git rev-list --count @{upstream}..HEAD",
  ])
    expect(
      shellFindings("fixture.md", `\x60\x60\x60sh\n${command}\n\x60\x60\x60`),
    ).toHaveLength(1);
});

test("finds composed native inline recipes and blockquoted command fences", () => {
  expect(shellFindings("fixture.md", "Run `git status --short`.")).toHaveLength(
    1,
  );
  expect(
    shellFindings("fixture.md", "Fetch `gh pr view <PR> --json body`."),
  ).toHaveLength(1);
  expect(
    shellFindings("fixture.md", "A `git push` or `gh pr view` call."),
  ).toEqual([]);
  expect(
    shellFindings("fixture.md", "Run `gh secret set KEY < key.pem`."),
  ).toHaveLength(1);
  expect(
    shellFindings("fixture.md", "> ```bash\n> git status\n> ```"),
  ).toHaveLength(1);
});

test("finds inline compositions that start with a directory command or option", () => {
  expect(
    shellFindings(
      "fixture.md",
      "Run `mkdir -p output && bun script.ts > result.json`.",
    ),
  ).toHaveLength(1);
  expect(
    shellFindings("fixture.md", 'Use `--template "$(bun layout.ts)"`.'),
  ).toHaveLength(1);
  expect(shellFindings("fixture.md", "Probe `test -f file`.")).toHaveLength(1);
  expect(
    shellFindings("fixture.md", "Hash `printf %s branch | shasum -a 256`."),
  ).toHaveLength(1);
});

test("checks script recipes and multiline inline spans at their starting line", () => {
  expect(
    shellFindings("fixture.md", "Run `config-fit.ts --json > fit.json`."),
  ).toHaveLength(1);
  expect(
    shellFindings(
      "fixture.md",
      "Context\nRun `gh pr list --base\n main --state open`.",
    ),
  ).toMatchObject([{ line: 2 }]);
  expect(
    shellFindings(
      "fixture.md",
      "```ts\nconst example = `gh pr list --base main`;\n```",
    ),
  ).toEqual([]);
});

test("rejects unquoted skill-cache paths including nested wrapper programs", () => {
  for (const command of [
    "bun <skill-dir>/scripts/decision-sheet.ts template current.html",
    `bun \${CLAUDE_SKILL_DIR}/scripts/decision-sheet.ts template current.html`,
    'bun "<skill-dir>/../../shared/command.ts" -- bun <skill-dir>/scripts/decision-sheet.ts extract current.html',
    `bun "\${CLAUDE_SKILL_DIR}/../../shared/command.ts" -- bun \${CLAUDE_SKILL_DIR}/scripts/decision-sheet.ts extract current.html`,
    "bun --config=<skill-dir>/scripts/bunfig.toml script.ts",
  ]) {
    const findings = shellFindings(
      "fixture.md",
      `\x60\x60\x60sh\n${command}\n\x60\x60\x60`,
    );
    expect(findings).toMatchObject([
      { problem: "skill-cache paths must be quoted" },
    ]);
  }
});

test("accepts quoted skill paths and placeholders inside literal JavaScript arguments", () => {
  for (const command of [
    'bun "<skill-dir>/scripts/decision-sheet.ts" template current.html',
    `bun "\${CLAUDE_SKILL_DIR}/scripts/decision-sheet.ts" template current.html`,
    'bun "<skill-dir>/../../shared/command.ts" -- bun "<skill-dir>/scripts/decision-sheet.ts" extract current.html',
    `bun --config="\${CLAUDE_SKILL_DIR}/scripts/bunfig.toml" "\${CLAUDE_SKILL_DIR}/scripts/review.ts" setup`,
    `bun --eval 'const file = "<skill-dir>/scripts/example.ts"; console.log(file);'`,
    `bun --eval 'const file = "\${CLAUDE_SKILL_DIR}/scripts/example.ts"; console.log(file);'`,
  ])
    expect(
      shellFindings("fixture.md", `\x60\x60\x60sh\n${command}\n\x60\x60\x60`),
    ).toEqual([]);
  expect(
    shellFindings(
      "fixture.md",
      '```ts\nconst path = "<skill-dir>/scripts/example.ts";\n```',
    ),
  ).toEqual([]);
});

test("double-backtick examples cannot hide later unquoted inline skill paths", () => {
  const source = [
    "A ``literal ` backtick`` is explanatory.",
    'Run `bun "<skill-dir>/../../shared/command.ts" -- bun <skill-dir>/scripts/example.ts`.',
  ].join("\n");
  expect(shellFindings("fixture.md", source)).toMatchObject([
    { line: 2, problem: "skill-cache paths must be quoted" },
  ]);
});
