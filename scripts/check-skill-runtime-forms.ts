/**
 * A skill's text may use a form only one harness provides (Claude Code's
 * skill-directory variable, its structured-question tool, the plugin's
 * review-arbiter agent) when it names the fallback beside it, so a harness
 * without the form can still run the skill
 * ([plugin/AGENTS.md](../plugin/AGENTS.md#rules), ADR-0026). It is a heuristic
 * over the shapes the plugin writes, not a proof of every phrasing. Its rules:
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
import { fenceAfter, walk } from "../lib/files.ts";
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

/** Blank out HTML comments, which no reader sees, keeping every line break. */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * The file without its YAML frontmatter, which grants tools and is no form,
 * and without HTML comments, which nobody reads.
 */
export function withoutFrontmatter(source: string): string {
  const lines = source.split(/\r?\n/);
  let body = source;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end >= 0)
      body = [...Array(end + 1).fill(""), ...lines.slice(end + 1)].join("\n");
  }
  return withoutComments(body);
}

const QUOTE = /^ {0,3}>[ \t]?/;
const DELIMITER_ROW =
  /^[ \t]*(?=[^|]*\|)\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A line's block-quote depth and the content inside the quotes. */
function unquote(line: string): { depth: number; content: string } {
  let depth = 0;
  let content = line;
  while (QUOTE.test(content)) {
    content = content.replace(QUOTE, "");
    depth += 1;
  }
  return { depth, content };
}

/**
 * Blank-line separated blocks with 1-based lines. Fenced code is kept whole
 * (the top-level grammar of `fenceAfter`, applied inside quotes), a change of
 * quote depth or a table row starts a block, and only `1.` or `1)` interrupts
 * a paragraph that is not a list.
 */
function paragraphs(source: string): Paragraph[] {
  const result: Paragraph[] = [];
  let current: string[] = [];
  let start = 0;
  let inList = false;
  const flush = (): void => {
    if (current.length)
      result.push({
        text: current.join(" ").replace(/\s+/g, " "),
        line: start,
      });
    current = [];
    inList = false;
  };
  const lines = source.split(/\r?\n/);
  let fence: string | undefined;
  let depth = 0;
  let table = false;
  lines.forEach((raw, index) => {
    const quote = unquote(raw);
    const content = quote.content;
    const after = fenceAfter(fence, content);
    if (fence !== undefined || after !== undefined) {
      // A fence is one block of its own: its blank lines and list-like
      // lines do not split it, and its text never joins a neighbour.
      if (fence === undefined) flush();
      if (current.length === 0) start = index + 1;
      current.push(content.trim());
      fence = after;
      depth = quote.depth;
      if (fence === undefined) flush();
      return;
    }
    if (quote.depth !== depth) flush();
    depth = quote.depth;
    if (content.trim() === "") {
      table = false;
      flush();
      return;
    }
    if (
      !table &&
      content.includes("|") &&
      DELIMITER_ROW.test(
        lines[index + 1] ? unquote(lines[index + 1] as string).content : "",
      )
    ) {
      flush();
      table = true;
    }
    if (table) {
      flush();
      start = index + 1;
      current.push(content.trim());
      flush();
      return;
    }
    const ordered = /^\s*(\d+)[.)]\s/.exec(content);
    const bullet = /^\s*[-*+]\s/.test(content);
    if (
      bullet ||
      /^\s*#{1,6}\s/.test(content) ||
      (ordered && (ordered[1] === "1" || current.length === 0 || inList))
    ) {
      flush();
      inList = Boolean(ordered || bullet);
    }
    if (current.length === 0) start = index + 1;
    current.push(content.trim());
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
  const out: Finding[] = [];
  for (const [name, variable] of [
    ["skill directory", SKILL_DIR],
    ["plugin root", PLUGIN_ROOT],
  ] as const) {
    const uses = blocks.find(({ text }) => text.includes(variable));
    if (!uses) continue;
    const explained = blocks.some(
      ({ text }) =>
        text.includes(variable) && explainsDirectory(text, isSkillPage),
    );
    if (!explained)
      out.push({
        rule: "skill-dir-form",
        file,
        line: uses.line,
        problem: `names ${variable} (the ${name}) but no paragraph naming it says that, in another harness, the agent replaces it by hand`,
        remedy: `in SKILL.md add a paragraph naming ${variable}: it stands for the absolute path of the ${name === "plugin root" ? "plugin's root directory" : "directory containing this SKILL.md"}, Claude Code fills it in, and in any other harness the agent replaces it with that path before running a command; in a reference page write <skill-dir> and say which directory it is (plugin/AGENTS.md)`,
      });
  }
  return out;
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

const AGENT = String.raw`(?:jig:review-arbiter|review-arbiter\.md)`;
// The agent is the recipient: a hand-over verb, then (in the same sentence,
// with no other link between) a `to`/`from` where the verb needs one, then the
// agent.
const GAP = String.raw`(?:(?!\]\((?![^)]*review-arbiter))[^.!?]){0,80}?`;
const HANDS_OVER = new RegExp(
  String.raw`\b(?:(?:spawn|invoke|delegate|ask)\b${GAP}|(?:hand|give|send|route|pass)\b${GAP}\bto\b${GAP}|request\b${GAP}\bfrom\b${GAP}|goes? to\b${GAP})(?:\]\((?:[^)]*\/)?)?\x60?${AGENT}`,
  "i",
);
const NO_SUBAGENTS = /\bno subagents?\b/i;
const CALLING_SESSION = /\bcalling session\b/i;

function subagentFindings(file: string, blocks: Paragraph[]): Finding[] {
  const hands = blocks.find(({ text }) => HANDS_OVER.test(text));
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

/**
 * The literal paths a text writes under the skill-directory variable. A
 * period closing a sentence is not part of an unquoted path; one before a
 * closing quote is.
 */
export function skillDirPathsIn(text: string): string[] {
  return [
    ...text.matchAll(
      /\$\{CLAUDE_SKILL_DIR\}((?:\/[\w.-]+)+)(?=$|["'`\s),;:])/gm,
    ),
  ].map((match) => {
    const path = match[1] as string;
    const next = text[(match.index ?? 0) + match[0].length] ?? "";
    return /["'`]/.test(next) ? path : path.replace(/(?<=\w)\.$/, "");
  });
}

function skillDirPaths(blocks: Paragraph[]): { path: string; line: number }[] {
  return blocks.flatMap(({ text, line }) =>
    skillDirPathsIn(text).map((path) => ({ path, line })),
  );
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
    (file) => file.endsWith(".md") && basename(file) !== "README.md",
  );
}

export function checkSkillRuntimeForms(root = "."): number {
  try {
    const base = join(root, "plugin", "skills");
    if (!readdirSync(base).length)
      return couldNotCheck("skill-runtime-forms", "no skills found");
    const pages = agentPages(base);
    if (!pages.some((file) => basename(file) === "SKILL.md"))
      return couldNotCheck("skill-runtime-forms", "no skill pages found");
    const findings = pages.flatMap((file) => {
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
      "skill-runtime-forms: OK — the skill-directory, question and review-arbiter forms name their fallback",
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
