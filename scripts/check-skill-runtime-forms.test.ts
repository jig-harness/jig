import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSkillRuntimeForms,
  formFindings,
  skillDirPathsIn,
  withoutFrontmatter,
} from "./check-skill-runtime-forms.ts";

const DIR = "$" + "{CLAUDE_SKILL_DIR}";
const run = DIR + "/scripts/run.ts";
const explained = `${DIR} in the commands below stands for the absolute path of the directory containing this \`SKILL.md\`. Claude Code fills it in. In any other harness, replace it with that path yourself before running a command.`;
const rules = (source: string, file = "plugin/skills/x/SKILL.md") =>
  formFindings(
    file,
    source,
    /^plugin\/skills\/[^/]+\/SKILL\.md$/.test(file),
  ).map((finding) => finding.rule);

test("a skill that uses the skill-directory variable with no harness-neutral form fails", () => {
  expect(rules(`Run:\n\n\`\`\`bash\nbun "${run}"\n\`\`\`\n`)).toEqual([
    "skill-dir-form",
  ]);
  expect(rules(`${DIR} is where the skill lives.\n\nbun "${run}"\n`)).toEqual([
    "skill-dir-form",
  ]);
});

test("the variable passes with the paragraph that says another harness fills it in by hand", () => {
  expect(rules(`${explained}\n\nbun "${run}"\n`)).toEqual([]);
  expect(rules("No commands here.\n")).toEqual([]);
});

test("a reference page defines <skill-dir> instead, and its own variable use must say so", () => {
  const page = "plugin/skills/x/references/y.md";
  expect(
    rules(
      `\`<skill-dir>\` is the directory of the \`x\` skill (\`${DIR}\` in \`SKILL.md\`).\n`,
      page,
    ),
  ).toEqual([]);
  expect(rules(`bun "${run}"\n`, page)).toEqual(["skill-dir-form"]);
  // A SKILL.md gets no such allowance: it must say what another harness does.
  expect(
    rules(
      `\`<skill-dir>\` is the directory of the \`x\` skill (\`${DIR}\` in \`SKILL.md\`).\n`,
    ),
  ).toEqual(["skill-dir-form"]);
});

test("the plugin root variable is held to the same form", () => {
  expect(rules("Hooks use CLAUDE_PLUGIN_ROOT.\n")).toEqual(["skill-dir-form"]);
});

test("a paragraph that names the structured question needs the numbered fallback and its default", () => {
  expect(rules("Ask with `AskUserQuestion`.\n")).toEqual(["question-form"]);
  expect(rules("Ask with `AskUserQuestion`, or in plain text.\n")).toEqual([
    "question-form",
  ]);
  expect(
    rules(
      "Ask with `AskUserQuestion`, or a plain-text numbered question with the recommended option first, marked as the default.\n",
    ),
  ).toEqual([]);
  // The frontmatter grants the tool; it is not a form.
  expect(
    rules("---\nname: x\nallowed-tools: AskUserQuestion\n---\n\nBody.\n"),
  ).toEqual([]);
  // List items are paragraphs of their own.
  expect(
    rules(
      "- Ask with `AskUserQuestion`.\n- A plain-text numbered question with a default.\n",
    ),
  ).toEqual(["question-form"]);
});

test("handing a finding to the review arbiter needs the calling-session fallback", () => {
  const hand = "Hand the finding to `jig:review-arbiter`.\n";
  expect(rules(hand)).toEqual(["subagent-form"]);
  expect(rules("A `jig:review-arbiter` escalation is parked.\n")).toEqual([]);
  expect(
    rules(
      `${hand}\nWith no subagents, the calling session rules with the same rubric.\n`,
    ),
  ).toEqual([]);
});

test("a path under the variable must exist once the directory is filled in", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-forms-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "run.ts"), "");
    const source = `${explained}\n\nbun "${DIR}/scripts/run.ts"\n\nbun "${DIR}/scripts/gone.ts"\n`;
    expect(
      formFindings("plugin/skills/x/SKILL.md", source, true, dir).map(
        (finding) => finding.problem,
      ),
    ).toEqual([expect.stringContaining("/scripts/gone.ts does not exist")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped plugin's skills name a fallback for the skill-directory, question and review-arbiter forms", () => {
  expect(checkSkillRuntimeForms(".")).toBe(0);
});

test("the patterns are strict about what counts as the named fallback", () => {
  // A default that is only mentioned, or "another tool", is no fallback.
  expect(
    rules(
      "Ask with `AskUserQuestion` or a plain-text numbered question; never pick a default.\n",
    ),
  ).toEqual(["question-form"]);
  expect(
    rules(
      `${DIR} is the directory. In another tool, replace it.\n\nbun "${run}"\n`,
    ),
  ).toEqual(["skill-dir-form"]);
  // A page that only says the arbiter is given nothing is no hand-over.
  expect(rules("The `jig:review-arbiter` is given no tools.\n")).toEqual([]);
});

test("a fenced block is one block and never joins the text beside it", () => {
  const fence = (body: string[]) => ["```text", ...body, "```"].join("\n");
  const named = fence(["Ask with `AskUserQuestion`."]);
  const fallback = "A plain-text numbered question, marked as the default.";
  // The fallback beside the fence is not in the fence's block.
  expect(rules(`${named}\n${fallback}\n`)).toEqual(["question-form"]);
  expect(rules(`${fallback}\n${named}\n`)).toEqual(["question-form"]);
  // A blank line inside the fence does not split what the fence holds.
  expect(
    rules(fence(["Ask with `AskUserQuestion`.", "", `- ${fallback}`])),
  ).toEqual([]);
});

test("a sentence's closing period is not part of the path it ends", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-forms-"));
  try {
    mkdirSync(join(dir, "scripts"));
    const source = `${explained}\n\nThe scripts live under ${DIR}/scripts.\n`;
    expect(formFindings("plugin/skills/x/SKILL.md", source, true, dir)).toEqual(
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each variable needs its own explanation, and + and 1) items are separate blocks", () => {
  const root = "$" + "{CLAUDE_PLUGIN_ROOT}";
  expect(rules(`${explained}\n\nbun "${root}/x.ts"\n`)).toEqual([
    "skill-dir-form",
  ]);
  const q = "AskUserQuestion";
  const fallback =
    "a plain-text numbered question, the recommended option marked as the default";
  for (const marker of ["+", "1)"])
    expect(rules(`${marker} Use ${q}.\n${marker} Also ${fallback}.\n`)).toEqual(
      ["question-form"],
    );
  expect(
    rules("Delegate contested findings to `jig:review-arbiter`.\n"),
  ).toEqual(["subagent-form"]);
});

test("block boundaries follow Markdown: quotes, indented fences, comments, tables, ordered items", () => {
  const q = "AskUserQuestion";
  const fallback = "a plain-text numbered question, marked as the default";
  // A quote-only `>` line separates two quoted paragraphs.
  expect(rules(`> Use ${q}.\n>\n> Also ${fallback}.\n`)).toEqual([
    "question-form",
  ]);
  // A fence marker indented four spaces is indented code, not a fence.
  expect(rules(`    \`\`\`\n\nUse ${q}.\n\nElsewhere, ${fallback}.\n`)).toEqual(
    ["question-form"],
  );
  // A fallback in an HTML comment is not visible.
  expect(rules(`Use ${q}. <!-- ${fallback} -->\n`)).toEqual(["question-form"]);
  // Table rows without a leading pipe are separate blocks.
  expect(rules(`a | b\n--|--\n${q} | x\n${fallback} | y\n`)).toEqual([
    "question-form",
  ]);
  // `2)` cannot interrupt a paragraph, so the fallback stays with it.
  expect(rules(`Use ${q}\n2) or ${fallback}.\n`)).toEqual([]);
});

test("asking the person after an arbiter ruling is no hand-over; delegating to its file is", () => {
  expect(
    rules(
      "After a `jig:review-arbiter` escalation, ask the person to decide.\n",
    ),
  ).toEqual([]);
  expect(
    rules(
      "Delegate it to the [Review Arbiter](../../agents/review-arbiter.md).\n",
    ),
  ).toEqual(["subagent-form"]);
});

test("a hand-over needs the arbiter as its recipient", () => {
  for (const text of [
    "Send contested threads to `jig:review-arbiter`.\n",
    "Request a ruling from `jig:review-arbiter`.\n",
  ])
    expect(rules(text)).toEqual(["subagent-form"]);
  for (const text of [
    "Ask the [maintainer](maintainers.md) about the `jig:review-arbiter` escalation.\n",
    "Give feedback on `review-arbiter.md` in the issue.\n",
  ])
    expect(rules(text)).toEqual([]);
});

test("the recipient is the exact agent, through links, and also after `go to`", () => {
  const real =
    "a thread the rubric does not decide goes to the [**Review Arbiter**](https://example.test/GLOSSARY.md) agent (`jig:review-arbiter`, shipped with the plugin; in Codex, see the [Codex notes](../../README.md#codex-notes)).\n";
  expect(rules(real)).toEqual(["subagent-form"]);
  for (const text of [
    "Contested findings go to `jig:review-arbiter`.\n",
    "Contested findings goes to `jig:review-arbiter`.\n",
    "Send the finding to the [arbiter](../x.md) agent `jig:review-arbiter`.\n",
    "Spawn a fresh `jig:review-arbiter` for the thread.\n",
    "Invoke the configured `jig:review-arbiter` agent.\n",
    "Hand the finding to the __jig:review-arbiter__ agent.\n",
    "Send the finding to the [Review Arbiter](../../GLOSSARY.md#review-arbiter) agent (`jig:review-arbiter`).\n",
  ])
    expect(rules(text)).toEqual(["subagent-form"]);
  for (const text of [
    "Contested findings goe to `jig:review-arbiter`.\n",
    "Ask the author about `jig:review-arbiter`'s earlier ruling.\n",
    "Ask the maintainer to review `review-arbiter.md`.\n",
    "Invoke `jig:review-arbiter-sandbox`.\n",
    "Invoke `archived-review-arbiter.md`.\n",
    "Invoke `review-arbiter.md.bak`.\n",
    "Send [the transcript](transcript.md) to `jig:review-arbiter`'s maintainer.\n",
  ])
    expect(rules(text)).toEqual([]);
});

test("a long run of asterisks before a missing agent fails fast", () => {
  const started = performance.now();
  expect(rules(`Send it to ${"*".repeat(60)}x\n`)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("an open comment stays opaque across a fence-like line", () => {
  const source = "<!--\n```\nbun a.ts\n```\n-->\nvisible\n";
  expect(withoutFrontmatter(source)).toBe(
    `    \n${" ".repeat(3)}\n${" ".repeat(8)}\n${" ".repeat(3)}\n${" ".repeat(3)}\nvisible\n`,
  );
});

test("a nested references/SKILL.md is a reference page, not an entry page", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-forms-role-"));
  try {
    const skill = join(root, "plugin", "skills", "x");
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `${explained}\n`);
    writeFileSync(
      join(skill, "references", "SKILL.md"),
      `Write <skill-dir>, the directory of the skill; ${DIR} is only named here.\n`,
    );
    expect(checkSkillRuntimeForms(root)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTML comment delimiters inside a fence are literal text", () => {
  const fenced = "```sh\necho '<!--'\nbun a.ts\necho '-->'\nbun b.ts\n```\n";
  expect(withoutFrontmatter(fenced)).toBe(fenced);
  expect(withoutFrontmatter("a <!-- hidden --> b\n")).toBe(
    `a ${" ".repeat(15)} b\n`,
  );
});

test("a period before a closing quote belongs to the path", () => {
  expect(skillDirPathsIn(`run "${DIR}/scripts/run.ts." now`)).toEqual([
    "/scripts/run.ts.",
  ]);
  expect(skillDirPathsIn(`see ${DIR}/scripts/run.ts.`)).toEqual([
    "/scripts/run.ts",
  ]);
});

test("the gate entry point exits 1 on a violation and 2 with no pages", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-forms-gate-"));
  try {
    const skill = join(root, "plugin", "skills", "x");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), `bun "${run}"\n`);
    expect(checkSkillRuntimeForms(root)).toBe(1);
    rmSync(join(skill, "SKILL.md"));
    writeFileSync(join(skill, "README.md"), "# x\n");
    expect(checkSkillRuntimeForms(root)).toBe(2);
    // Notes in a reference directory and a README at the skills root are no
    // skill entry page.
    mkdirSync(join(skill, "references"));
    writeFileSync(join(skill, "references", "notes.md"), "Plain prose.\n");
    writeFileSync(join(root, "plugin", "skills", "README.md"), "# skills\n");
    rmSync(join(skill, "README.md"));
    expect(checkSkillRuntimeForms(root)).toBe(2);
    // A `SKILL.md` nested under a reference directory is no entry page.
    writeFileSync(join(skill, "references", "SKILL.md"), "Plain prose.\n");
    expect(checkSkillRuntimeForms(root)).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const arbiter = (text: string) => rules(text, "plugin/skills/x/SKILL.md");

test("the recipient is recognised through links, emphasis and descriptive labels", () => {
  for (const text of [
    "Send the finding to the [Review Arbiter](../../GLOSSARY.md#review-arbiter) agent `jig:review-arbiter`.\n",
    "Hand it to [agent for contested reviews](../../agents/review-arbiter.md).\n",
    "Hand it to the [Review Arbiter](../how-to-review.md) **`jig:review-arbiter`**.\n",
  ])
    expect(arbiter(text)).toEqual(["subagent-form"]);
});

test("a clause that only mentions the arbiter hands nothing to it", () => {
  for (const text of [
    "Ask the maintainer whether `jig:review-arbiter` already ruled.\n",
    "Send the finding to the maintainer if `jig:review-arbiter` is unavailable.\n",
    "Invoke `jig:review-arbiter_sandbox`.\n",
    "Invoke `archived_review-arbiter.md`.\n",
    "Ask `review-arbiter.md`'s maintainer.\n",
  ])
    expect(arbiter(text)).toEqual([]);
});

test("a comment opener in inline code or after an escape hides nothing", () => {
  const instruction = "Ask with AskUserQuestion.\n";
  for (const opener of ["`<!--`", "\\<!--"])
    expect(
      arbiter(`Write ${opener} to start a comment. ${instruction}`),
    ).toEqual(["question-form"]);
});

test("a reference page named SKILL.md is judged as a reference", () => {
  expect(
    formFindings("plugin/skills/x/references/SKILL.md", "Plain.\n", false),
  ).toEqual([]);
});
