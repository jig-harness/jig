import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const script = join(import.meta.dir, "check-skill-authoring.ts");
const fixtures = join(import.meta.dir, "fixtures", "skills");
const scratch = mkdtempSync(join(tmpdir(), "jig-skill-authoring-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirs = 0;
/** A skills folder holding one skill, `files` relative to the skill. */
function skills(files: Record<string, string>): string {
  const root = join(scratch, `case-${dirs++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "demo", path)), { recursive: true });
    writeFileSync(join(root, "demo", path), text);
  }
  return root;
}

// The variable Claude Code fills in with the skill's folder, written as is.
const skillDir = `\${CLAUDE_SKILL_DIR}`;
const skillFile = (body: string, description = "Demo. Use when testing.") =>
  `---\nname: demo\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
const prose = (n: number) =>
  Array.from({ length: n }, (_, i) => `Line ${i + 1}.`).join("\n");

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Rule → file (relative to the skill) → count, from `--json`. */
function counts(root: string, ...more: string[]) {
  const result = run(["--json", ...more, root]);
  expectSpawnExit(result, 0);
  const parsed = JSON.parse(result.stdout) as {
    counts: Record<string, Record<string, number>>;
  };
  const prefix = `${join(root, "demo").split("\\").join("/")}/`;
  return Object.fromEntries(
    Object.entries(parsed.counts).map(([rule, files]) => [
      rule,
      Object.fromEntries(
        Object.entries(files).map(([f, n]) => [f.replace(prefix, ""), n]),
      ),
    ]),
  );
}

test("the committed fixture follows every rule", () => {
  const result = run([fixtures]);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain(
    "reference-depth 0, reference-toc 0, issue-density 0, time-sensitive 0, negative-trigger 0",
  );
  expectSpawnExit(run(["--strict", fixtures]), 0);
});

describe("reference-depth", () => {
  test("a reference SKILL.md does not name counts, wherever else it is linked", () => {
    const root = skills({
      "SKILL.md": skillFile("Read [a](references/a.md).\n"),
      "references/a.md": "See [b](b.md).\n",
      "references/b.md": "Deep.\n",
    });
    expect(counts(root)).toEqual({
      "reference-depth": { "references/b.md": 1 },
    });
  });

  test("SKILL.md names a reference by link, skill-relative path or folder", () => {
    const root = skills({
      "SKILL.md": skillFile(
        [
          `Read \`${skillDir}/references/a.md\` first,`,
          "then `<skill-dir>/references/b.md`, then `references/c.md`,",
          `and the prompts in \`${skillDir}/references/prompts/\`.`,
          "",
          "[d]: references/d.md",
        ].join("\n"),
      ),
      "references/a.md": "See [b](b.md) and [c](c.md).\n",
      "references/b.md": "B.\n",
      "references/c.md": "C.\n",
      "references/d.md": "D.\n",
      "references/prompts/one.md": "One.\n",
    });
    expect(counts(root)).toEqual({});
  });

  test("a path that ends a sentence or sits in emphasis is named", () => {
    const root = skills({
      "SKILL.md": skillFile(
        "Read references/a.md. Then references/b.md, and **references/c.md**.\n",
      ),
      "references/a.md": "A.\n",
      "references/b.md": "B.\n",
      "references/c.md": "C.\n",
    });
    expect(counts(root)).toEqual({});
  });

  test("naming the skill's folder or one above it names no reference", () => {
    for (const link of ["[Home](.)", "[Parent](..)", "[Root](./)"]) {
      const root = skills({
        "SKILL.md": skillFile(`${link}\n`),
        "references/hidden.md": "Hidden.\n",
      });
      expect(counts(root)).toEqual({
        "reference-depth": { "references/hidden.md": 1 },
      });
    }
  });

  test("a reference named only inside fenced code counts", () => {
    const root = skills({
      "SKILL.md": skillFile("```sh\ncat references/a.md\n```\n"),
      "references/a.md": "A.\n",
    });
    expect(counts(root)).toEqual({
      "reference-depth": { "references/a.md": 1 },
    });
  });
});

describe("reference-toc", () => {
  const named = (reference: string) =>
    skills({
      "SKILL.md": skillFile(`Read [r](references/r.md).\n${prose(150)}\n`),
      "references/r.md": reference,
    });

  test("a reference over 100 lines needs a contents section linking to a heading", () => {
    expect(counts(named(`# R\n${prose(100)}\n`))).toEqual({
      "reference-toc": { "references/r.md": 1 },
    });
    expect(counts(named(`# R\n${prose(99)}\n`))).toEqual({});
    const toc = "# R\n\n## Contents\n\n- [Usage](#usage)\n\n## Usage\n";
    expect(counts(named(`${toc}${prose(100)}\n`))).toEqual({});
  });

  test("a contents section whose links reach no heading does not count", () => {
    const toc = "# R\n\n## Contents\n\n- [Usage](#missing)\n\n## Usage\n";
    expect(counts(named(`${toc}${prose(100)}\n`))).toEqual({
      "reference-toc": { "references/r.md": 1 },
    });
  });

  test("a contents link inside fenced code does not count", () => {
    const toc =
      "# R\n\n## Contents\n\n```md\n- [Usage](#usage)\n```\n\n## Usage\n";
    expect(counts(named(`${toc}${prose(100)}\n`))).toEqual({
      "reference-toc": { "references/r.md": 1 },
    });
  });

  test("the contents section opens the file: after the title, before other headings", () => {
    const usage = `## Usage\n${prose(100)}\n`;
    const contents = "## Contents\n\n- [Usage](#usage)\n\n";
    expect(counts(named(`# R\n\nIntro.\n\n${contents}${usage}`))).toEqual({});
    expect(counts(named(`${contents}${usage}`))).toEqual({});
    expect(counts(named(`# R\n\n${usage}${contents}`))).toEqual({
      "reference-toc": { "references/r.md": 1 },
    });
    expect(counts(named(`## Intro\n\n${contents}${usage}`))).toEqual({
      "reference-toc": { "references/r.md": 1 },
    });
  });

  test("SKILL.md itself needs no contents section", () => {
    expect(
      counts(skills({ "SKILL.md": skillFile(`${prose(300)}\n`) })),
    ).toEqual({});
  });
});

describe("issue-density", () => {
  test("ids past 5 per 100 prose lines count, fenced code not", () => {
    const body = `${prose(20)}\nFixed in ENG-1, ENG-2 and #3.\n\`\`\`\nENG-4 ENG-5 #6\n\`\`\`\n`;
    // 21 prose lines allow one id; three are found.
    expect(counts(skills({ "SKILL.md": skillFile(body) }))).toEqual({
      "issue-density": { "SKILL.md": 2 },
    });
  });

  test("standard and record ids are not issue ids", () => {
    const body = "SHA-256, UTF-8, ISO-8601, RFC-9110 and ADR-0007.\n";
    expect(counts(skills({ "SKILL.md": skillFile(body) }))).toEqual({});
  });

  test("the id pattern and the density are options", () => {
    const root = skills({ "SKILL.md": skillFile(`${prose(20)}\nT1 T2 T3\n`) });
    expect(counts(root, "--ids", "\\bT\\d+\\b")).toEqual({
      "issue-density": { "SKILL.md": 2 },
    });
    expect(counts(root, "--ids", "\\bT\\d+\\b", "--density", "20")).toEqual({});
  });
});

describe("time-sensitive", () => {
  test("each stale marker in prose counts; inline code and fences do not", () => {
    const body = [
      "As of March 2026 the tool supports it.",
      "At the time of writing this is true; it was recently added.",
      "Since January 2025, and as of v2.3, nowadays.",
      "The claim holds as of this head, the merge just changed it.",
      "As of mayhem, decide as of decision time.",
      "`as of March 2026` is an example.",
      "``recently added`` and ``` a `recently added` b ``` are examples too.",
      "```",
      "as of 2026",
      "```",
    ].join("\n");
    expect(counts(skills({ "SKILL.md": skillFile(body) }))).toEqual({
      "time-sensitive": { "SKILL.md": 5 },
    });
  });
});

describe("negative-trigger", () => {
  const body = "Do the thing.\n\n## When not to use\n\nFor other things.\n";

  test("a body-only negative trigger counts", () => {
    expect(counts(skills({ "SKILL.md": skillFile(body) }))).toEqual({
      "negative-trigger": { "SKILL.md": 1 },
    });
  });

  test("a description that carries one does not", () => {
    for (const description of [
      "Do the thing. Not for other things (use other).",
      "Do the thing; for other things use the other skill instead.",
      "Do the thing, unless it is another thing.",
      "Do the thing. Do not use it for other things.",
      "Use when cutting releases, except for single-pull-request notes.",
      "Use when cutting releases, rather than documenting a single pull request.",
      "Use when cutting releases; not suitable for single-pull-request notes.",
      "Use when cutting releases. Never use this skill.",
    ])
      expect(
        counts(skills({ "SKILL.md": skillFile(body, description) })),
      ).toEqual({});
  });

  test("a negative word that excludes nothing still counts", () => {
    for (const description of [
      "Use when drafting release notes instead of writing them manually.",
      "Use when reviewing code to ensure developers do not use deprecated APIs.",
      "Use when refactoring; never use globals and prefer composition instead.",
      "Use when writing prose rather than code.",
    ])
      expect(
        counts(skills({ "SKILL.md": skillFile(body, description) })),
      ).toEqual({ "negative-trigger": { "SKILL.md": 1 } });
  });
});

describe("output and exit codes", () => {
  test("findings are listed with file and line, and fail only under --strict", () => {
    const root = skills({
      "SKILL.md": skillFile("Intro.\n\n## Not this skill\n\nOther.\n"),
    });
    const listed = run([root]);
    expectSpawnExit(listed, 0);
    expect(listed.stdout).toMatch(/demo\/SKILL\.md:7: negative-trigger: /);
    expectSpawnExit(run(["--strict", root]), 1);
    const json = run(["--json", "--strict", root]);
    expectSpawnExit(json, 1);
    expect(JSON.parse(json.stdout).counts["negative-trigger"]).toBeDefined();
  });

  test("measuring a merge base, a folder it predates measures as no findings", () => {
    const history = { RATCHET_HISTORICAL: "1" };
    for (const dir of [
      join(scratch, "missing"),
      skills({ "notes.md": "x\n" }),
    ]) {
      const result = run(["--json", dir], history);
      expectSpawnExit(result, 0);
      expect(JSON.parse(result.stdout)).toEqual({ counts: {} });
    }
    const unreadable = skills({ "SKILL.md": "---\nname: demo\n---\nBody.\n" });
    expectSpawnExit(run(["--json", unreadable], history), 2);
  });

  test("an input it cannot measure is exit 2, never a pass", () => {
    const cases: Record<string, string>[] = [
      { "SKILL.md": "---\nname: demo\nBody.\n" },
      { "SKILL.md": "---\nname: demo\n---\nBody.\n" },
      { "SKILL.md": "---\n---\nBody.\n" },
      { "SKILL.md": "---\ndescription: [unclosed\n---\nBody.\n" },
      { "SKILL.md": skillFile("") },
      { "SKILL.md": skillFile("Body.\n"), "references/r.md": "\n" },
      { "notes.md": "Not a skill.\n" },
    ];
    for (const files of cases) expectSpawnExit(run([skills(files)]), 2);
    expectSpawnExit(run([join(scratch, "missing")]), 2);
    expectSpawnExit(run([]), 2);
    expectSpawnExit(run(["--density", "-1", fixtures]), 2);
    expectSpawnExit(run(["--unknown", fixtures]), 2);
    expectSpawnExit(run(["--ids", "(", fixtures]), 2);
  });
});
