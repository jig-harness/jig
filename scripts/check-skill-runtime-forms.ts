/**
 * A skill's text may use a form only one harness provides (Claude Code's
 * skill-directory variable, its structured-question tool, the plugin's
 * review-arbiter agent) when it names the fallback beside it, so a harness
 * without the form can still run the skill
 * ([plugin/AGENTS.md](../plugin/AGENTS.md#rules), ADR-0026). Four rules:
 *
 * - `skill-dir-form`: a file that names `${CLAUDE_SKILL_DIR}` (or the plugin
 *   root variable) says in one paragraph that another harness fills it in by
 *   hand.
 * - `question-form`: a paragraph that names `AskUserQuestion` also names the
 *   plain-text numbered question and the default it states.
 * - `subagent-form`: a file that hands work to the plugin's review-arbiter
 *   agent says the calling session rules where the harness has no subagents.
 * - `skill-dir-path`: a path written under the skill-directory variable
 *   exists once the directory is filled in by hand.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { cli } from "../lib/cli.ts";
import { walk } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const SKILL_DIR = `\${CLAUDE_SKILL_DIR}`;
const PLUGIN_ROOT = "CLAUDE_PLUGIN_ROOT";
const TOOL = "AskUserQuestion";

/** A paragraph of a file: its text, joined on one line, and where it starts. */
interface Paragraph {
  text: string;
  line: number;
}

/** The file without its YAML frontmatter, which grants tools and is no form. */
function withoutFrontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return source;
  const end = lines.indexOf("---", 1);
  if (end < 0) return source;
  return [...Array(end + 1).fill(""), ...lines.slice(end + 1)].join("\n");
}

/** Blank-line separated blocks, fenced code kept whole, with 1-based lines. */
function paragraphs(source: string): Paragraph[] {
  const result: Paragraph[] = [];
  let current: string[] = [];
  let start = 0;
  const flush = (): void => {
    if (current.length)
      result.push({
        text: current.join(" ").replace(/\s+/g, " "),
        line: start,
      });
    current = [];
  };
  let fence: string | null = null;
  source.split(/\r?\n/).forEach((raw, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (marker) {
      // A fence is one block of its own: its blank lines and list-like
      // lines do not split it, and its text never joins a neighbour.
      if (fence === null) {
        flush();
        fence = marker[1] as string;
      } else if (marker[1]?.startsWith(fence)) fence = null;
      if (current.length === 0) start = index + 1;
      current.push(raw.trim());
      if (fence === null) flush();
      return;
    }
    if (fence !== null) {
      current.push(raw.trim());
      return;
    }
    if (raw.trim() === "") {
      flush();
      return;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(raw)) flush();
    if (current.length === 0) start = index + 1;
    current.push(raw.trim());
  });
  flush();
  return result;
}

const OTHER_HARNESS = /\b(?:other|another) (?:harness|runtime)\b/i;
const BY_HAND = /\b(?:replace|substitut\w*)\b/i;

/**
 * `SKILL.md` is the one page Claude Code fills the variable into, so it says
 * how another harness does. A reference page is never substituted: it writes
 * `<skill-dir>` and says which directory that is.
 */
function explainsDirectory(text: string, isSkillPage: boolean): boolean {
  if (OTHER_HARNESS.test(text) && BY_HAND.test(text)) return true;
  return (
    !isSkillPage && text.includes("<skill-dir>") && /\bdirectory\b/.test(text)
  );
}

function skillDirFindings(
  file: string,
  blocks: Paragraph[],
  isSkillPage: boolean,
): Finding[] {
  const uses = blocks.find(
    ({ text }) => text.includes(SKILL_DIR) || text.includes(PLUGIN_ROOT),
  );
  if (!uses) return [];
  const explained = blocks.some(
    ({ text }) =>
      (text.includes(SKILL_DIR) || text.includes(PLUGIN_ROOT)) &&
      explainsDirectory(text, isSkillPage),
  );
  return explained
    ? []
    : [
        {
          rule: "skill-dir-form",
          file,
          line: uses.line,
          problem: `names ${SKILL_DIR} but no paragraph says that, in another harness, the agent replaces it with the skill's directory`,
          remedy: `in SKILL.md add the paragraph every skill opens its commands with: "${SKILL_DIR} in the commands below stands for the absolute path of the directory containing this SKILL.md. Claude Code fills it in. In any other harness, replace it with that path yourself before running a command"; in a reference page write <skill-dir> and say which directory it is (plugin/AGENTS.md)`,
        },
      ];
}

const PLAIN_QUESTION = /plain[- ]text numbered/i;
const STATED_DEFAULT = /\bmarked as the default\b/i;

function questionFindings(file: string, blocks: Paragraph[]): Finding[] {
  return blocks
    .filter(({ text }) => text.includes(TOOL))
    .filter(
      ({ text }) => !(PLAIN_QUESTION.test(text) && STATED_DEFAULT.test(text)),
    )
    .map(({ line }) => ({
      rule: "question-form",
      file,
      line,
      problem: `names ${TOOL} without the plain-text numbered fallback and the default it states`,
      remedy:
        "name the fallback in the same paragraph: a plain-text numbered question, the recommended option first and marked as the default, and with nobody to answer, stop and state the question (plugin/AGENTS.md)",
    }));
}

const AGENT_ID = /jig:review-arbiter/;
const HANDS_OVER = /\b(?:spawn|invoke|hand|give|goes to|go to|route)\b/i;
const NO_SUBAGENTS = /\bno subagents?\b/i;
const CALLING_SESSION = /\bcalling session\b/i;

function subagentFindings(file: string, blocks: Paragraph[]): Finding[] {
  const hands = blocks.find(
    ({ text }) => AGENT_ID.test(text) && HANDS_OVER.test(text),
  );
  if (!hands) return [];
  const covered = blocks.some(
    ({ text }) => NO_SUBAGENTS.test(text) && CALLING_SESSION.test(text),
  );
  return covered
    ? []
    : [
        {
          rule: "subagent-form",
          file,
          line: hands.line,
          problem:
            "hands work to jig:review-arbiter without saying who rules where the harness has no subagents",
          remedy:
            "say that with no subagents the calling session rules with the same rubric (plugin/AGENTS.md)",
        },
      ];
}

/** The literal paths a file writes under the skill-directory variable. */
function skillDirPaths(blocks: Paragraph[]): { path: string; line: number }[] {
  const found: { path: string; line: number }[] = [];
  for (const { text, line } of blocks)
    for (const match of text.matchAll(
      /\$\{CLAUDE_SKILL_DIR\}((?:\/[\w.-]+)+)(?=$|["'`\s),;:])/g,
    ))
      found.push({ path: (match[1] as string).replace(/\.+$/, ""), line });
  return found;
}

function pathFindings(
  file: string,
  skillDir: string,
  blocks: Paragraph[],
): Finding[] {
  return skillDirPaths(blocks)
    .filter(({ path }) => !existsSync(resolve(skillDir, `.${path}`)))
    .map(({ path, line }) => ({
      rule: "skill-dir-path",
      file,
      line,
      problem: `${SKILL_DIR}${path} does not exist when the skill's directory is filled in by hand`,
      remedy: "write a path that exists beside the skill, or move the file",
    }));
}

/** Findings for one skill document; `skillDir` is the skill's directory. */
export function formFindings(
  file: string,
  source: string,
  skillDir?: string,
): Finding[] {
  const blocks = paragraphs(withoutFrontmatter(source));
  return [
    ...skillDirFindings(file, blocks, basename(file) === "SKILL.md"),
    ...questionFindings(file, blocks),
    ...subagentFindings(file, blocks),
    ...(skillDir ? pathFindings(file, skillDir, blocks) : []),
  ];
}

/** The pages an agent reads: `SKILL.md` and the references, not the README. */
function agentPages(base: string): string[] {
  return walk(base, ["__tests__", "fixtures", "templates"]).filter(
    (file) => file.endsWith(".md") && !file.endsWith(`${sep}README.md`),
  );
}

export function checkSkillRuntimeForms(root = "."): number {
  try {
    const base = join(root, "plugin", "skills");
    if (!readdirSync(base).length)
      return couldNotCheck("skill-runtime-forms", "no skills found");
    const findings = agentPages(base).flatMap((file) => {
      const skillDir = join(base, file.split(sep)[0] as string);
      return formFindings(
        repoPath(root, join(base, file)),
        readFileSync(join(base, file), "utf8"),
        skillDir,
      );
    });
    if (findings.length) {
      reportFindings(findings);
      return 1;
    }
    console.log(
      "skill-runtime-forms: OK — every runtime-specific form names its fallback",
    );
    return 0;
  } catch (error) {
    return couldNotCheck(
      "skill-runtime-forms",
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (import.meta.main) cli(() => checkSkillRuntimeForms(process.argv[2]));
