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

/** The length of the backtick run that starts at `at`. */
function runLength(text: string, at: number): number {
  let n = 1;
  while (text[at + n] === "`") n += 1;
  return n;
}

/**
 * The backtick runs of one text, indexed once by length: `closeOf(at)` is the
 * index just past the first run of exactly the length of the run that begins
 * at `at` (a run entered after a backslash counts from `at`), found after
 * that run, and `firstFrom(at, n)` the same for `n` ticks at or after `at`;
 * -1 for both when there is none. A longer or shorter run is skipped whole,
 * never entered, and no lookup rescans the text.
 */
function runMatcher(text: string): {
  closeOf: (at: number) => number;
  firstFrom: (at: number, n: number) => number;
} {
  const byLength = new Map<number, number[]>();
  for (let at = text.indexOf("`"); at >= 0; ) {
    const length = runLength(text, at);
    const starts = byLength.get(length);
    if (starts) starts.push(at);
    else byLength.set(length, [at]);
    at = text.indexOf("`", at + length);
  }
  const firstFrom = (at: number, n: number): number => {
    const starts = byLength.get(n);
    if (!starts) return -1;
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((starts[mid] as number) < at) low = mid + 1;
      else high = mid;
    }
    const found = starts[low];
    return found === undefined ? -1 : found + n;
  };
  return {
    closeOf: (at) => {
      const n = runLength(text, at);
      return firstFrom(at + n, n);
    },
    firstFrom,
  };
}

/**
 * Whether a line ends the Markdown paragraph it would continue: a blank line,
 * and, after the paragraph's first line, an ATX heading, a bullet, an ordered
 * item numbered `1` (the interruptions `paragraphs` applies) or a setext
 * underline.
 */
function endsParagraph(line: string, continued: boolean): boolean {
  const content = unquote(line).content;
  if (content.trim() === "") return true;
  return (
    continued &&
    (/^ {0,3}#{1,6}(?:\s|$)/.test(content) ||
      /^ {0,3}[-*+]\s/.test(content) ||
      /^ {0,3}1[.)]\s/.test(content) ||
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(content))
  );
}

/**
 * Where the first comment opener at or after `from` sits on a line (the
 * line's length when there is none), skipping escapes and code spans. A run
 * with no closer on the line but one later in its paragraph opens a span that
 * goes on past the line: `span` is its length then.
 */
function scanToComment(
  line: string,
  from: number,
  runs: ReturnType<typeof runMatcher>,
  closesLater: (n: number) => boolean,
): { at: number; span: number } {
  let i = from;
  while (i < line.length && !line.startsWith("<!--", i)) {
    if (line[i] === "\\") i += 2;
    else if (line[i] === "`") {
      const n = runLength(line, i);
      const close = runs.closeOf(i);
      if (close >= 0) i = close;
      else if (closesLater(n)) return { at: line.length, span: n };
      else i += n;
    } else i += 1;
  }
  return { at: i, span: 0 };
}

/**
 * Blank out HTML comments, which no reader sees, keeping every line break.
 * A comment opens at the first `<!--` that is neither backslash-escaped nor
 * inside a code span (a backtick run closed by a run of the same length, on
 * its line or later in the same paragraph; an unpaired run is literal text).
 * A comment stays opaque until it closes, even across a fence-like line;
 * fenced code outside a comment is left whole, since inside it `<!--` and
 * `-->` are literal text.
 */
function withoutComments(source: string): string {
  const lines = source.split("\n");
  const state: CommentState = { open: false, span: 0 };
  let fence: string | undefined;
  let paragraph = { end: -1, lastWith: new Map<number, number>() };
  // Whether a run of `n` ticks opened on `index` is closed on a later line of
  // its paragraph.
  const closesLater = (index: number, n: number): boolean => {
    if (index >= paragraph.end) paragraph = paragraphRuns(lines, index);
    return (paragraph.lastWith.get(n) ?? -1) > index;
  };
  return lines
    .map((line, index) => {
      if (!state.open) {
        const after = fenceAfter(fence, unquote(line).content);
        if (fence !== undefined || after !== undefined) {
          fence = after;
          state.span = 0;
          return line;
        }
      }
      return maskLine(line, state, (n) => closesLater(index, n));
    })
    .join("\n");
}

/** Whether a comment, or a code span running on from an earlier line, is open. */
interface CommentState {
  open: boolean;
  span: number;
}

/**
 * The paragraph that starts at line `from`: where it ends and the last line
 * holding a backtick run of each length.
 */
function paragraphRuns(
  lines: string[],
  from: number,
): { end: number; lastWith: Map<number, number> } {
  let end = from;
  while (end < lines.length && !endsParagraph(lines[end] as string, end > from))
    end++;
  const lastWith = new Map<number, number>();
  for (let j = from; j < end; j++) {
    const line = lines[j] as string;
    for (let at = line.indexOf("`"); at >= 0; ) {
      const n = runLength(line, at);
      lastWith.set(n, j);
      at = line.indexOf("`", at + n);
    }
  }
  return { end, lastWith };
}

/** One line with its comments blanked, updating what stays open past it. */
function maskLine(
  line: string,
  state: CommentState,
  closesLater: (n: number) => boolean,
): string {
  const runs = runMatcher(line);
  let out = "";
  let pos = 0;
  for (;;) {
    let end: number;
    if (state.open) {
      end = line.indexOf("-->", pos);
      if (end < 0) return out + " ".repeat(line.length - pos);
      out += " ".repeat(end + 3 - pos);
      pos = end + 3;
      state.open = false;
    } else if (state.span > 0) {
      end = runs.firstFrom(pos, state.span);
      if (end < 0) return out + line.slice(pos);
      out += line.slice(pos, end);
      pos = end;
      state.span = 0;
    } else {
      const found = scanToComment(line, pos, runs, closesLater);
      state.span = found.span;
      if (found.span > 0 || found.at >= line.length)
        return out + line.slice(pos);
      out += `${line.slice(pos, found.at)}    `;
      pos = found.at + 4;
      state.open = true;
    }
  }
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

/** Whether a line is a table's header row, given the line after it. */
function startsTable(content: string, next: string | undefined): boolean {
  return (
    content.includes("|") &&
    DELIMITER_ROW.test(next ? unquote(next).content : "")
  );
}

/** The ordered number (as text) or `-` of a list item line, if it is one. */
function listMarker(content: string): string | undefined {
  const ordered = /^\s*(\d+)[.)]\s/.exec(content);
  if (ordered) return ordered[1];
  return /^\s*[-*+]\s/.test(content) ? "-" : undefined;
}

/**
 * Whether a line ends the paragraph before it: a bullet, a heading, or an
 * ordered item numbered `1`, one that opens a block or one in a list.
 */
function interrupts(
  content: string,
  marker: string | undefined,
  empty: boolean,
  inList: boolean,
): boolean {
  if (marker === "-" || /^\s*#{1,6}\s/.test(content)) return true;
  return marker !== undefined && (marker === "1" || empty || inList);
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
    if (!table && startsTable(content, lines[index + 1])) {
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
    const list = listMarker(content);
    if (interrupts(content, list, current.length === 0, inList)) {
      flush();
      inList = list !== undefined;
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

// The exact agent: its ID, or the basename of its file, never a longer name
// (`jig:review-arbiter-sandbox`, `review-arbiter_sandbox`, `archived-review-arbiter.md`,
// `review-arbiter.md.bak`) and never a possessive (`jig:review-arbiter's`).
// Run on text `recipientText` has already reduced to plain words.
const AGENT = String.raw`(?<![\w-])(?:jig:review-arbiter|review-arbiter\.md)(?![\w-]|\.\w|['\u2019]s\b)`;
// The words that may name the recipient before its ID: an article, and the
// words agent or Review Arbiter. Anything else (a maintainer, a clause such as
// `whether` or `if`) means the ID is only mentioned, not handed to.
const LEAD = String.raw`\(?(?:(?:the|a|an|our|this|fresh|new|configured|read-only|plugin['\u2019]s|plugin|jig|review[- ]arbiter|arbiter|agent|subagent)\s+\(?){0,6}`;
// A path to the agent's file may stand in for its name.
const PATH = String.raw`(?:[\w.~-]*/)*`;
// A sentence's own words: a period inside a path or a name is not its end.
const GAP = String.raw`(?:[^.!?]|\.(?=\S)){0,80}?`;
// The agent is the recipient: it follows the verb directly (`invoke`), or the
// `to`/`from` the verb takes, through nothing but the lead-in above.
const HANDS_OVER = new RegExp(
  String.raw`\b(?:(?:spawn|invoke|ask)\s+|(?:delegate|hand|give|send|route|pass)\b${GAP}\bto\s+|delegate\s+to\s+|request\b${GAP}\bfrom\s+|go(?:es)?\s+to\s+)${LEAD}${PATH}${AGENT}`,
  "i",
);

const UNDERSCORE = /(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g;

/** Whether a link destination names the agent's own file, by its whole basename. */
function namesAgentFile(destination: string): boolean {
  const target = (
    destination.trim().replace(/^</, "").split(/[\s>]/)[0] ?? ""
  ).split(/[#?]/)[0] as string;
  return (
    target.slice(target.lastIndexOf("/") + 1).toLowerCase() ===
    "review-arbiter.md"
  );
}

/**
 * Every code span of a text as `[start, end)` ranges, in one left-to-right
 * pass: a backslash escapes the next character outside a span, and a run with
 * no closer of its length is literal.
 */
function codeSpans(
  text: string,
  runs: ReturnType<typeof runMatcher>,
): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === "`") {
      const close = runs.closeOf(i);
      if (close >= 0) {
        spans.push([i, close]);
        i = close;
      } else i += runLength(text, i);
    } else i += 1;
  }
  return spans;
}

/** The end of the double-quoted string opening at `at`, or -1 if it never closes. */
function titleEnd(text: string, at: number): number {
  for (let end = at + 1; end < text.length; end++) {
    if (text[end] === '"') return end;
    if (text[end] === "\\") end += 1;
  }
  return -1;
}

/** Which characters are inside a code span or are a backslash and what it escapes. */
function inertCharacters(text: string, spans: [number, number][]): Uint8Array {
  const inert = new Uint8Array(text.length);
  for (const [start, end] of spans) inert.fill(1, start, end);
  for (let i = 0; i < text.length; i++) {
    if (inert[i] || text[i] !== "\\") continue;
    inert.fill(1, i, i + 2);
    i += 1;
  }
  return inert;
}

/** `at`, or the end of the link title that opens there: a quote after whitespace. */
function afterTitle(text: string, at: number): number {
  if (text[at] !== '"' || !/\s/.test(text[at - 1] ?? "")) return at;
  const end = titleEnd(text, at);
  return end < 0 ? at : end;
}

/**
 * Each `open` character's matching `close` index, by one stack pass that
 * skips backslash escapes and code spans: nested pairs balance, an unmatched
 * one is absent. With `titles`, a double-quoted string after whitespace
 * inside an open pair (a link title) is skipped whole.
 */
function pairsOf(
  text: string,
  spans: [number, number][],
  open: string,
  close: string,
  titles: boolean,
): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const inert = inertCharacters(text, spans);
  for (let i = 0; i < text.length; i++) {
    if (inert[i]) continue;
    const c = text[i];
    if (c === open) stack.push(i);
    else if (c === close) {
      const start = stack.pop();
      if (start !== undefined) pairs.set(start, i);
    } else if (titles && stack.length) i = afterTitle(text, i);
  }
  return pairs;
}

/** A code span's text as a reader sees it: one padding space on each side goes. */
function spanText(raw: string): string {
  return raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw)
    ? raw.slice(1, -1)
    : raw;
}

/**
 * The links of a text by the index of their `[`, as `[label end, destination
 * end]`. A label holding another link is no link (CommonMark does not nest
 * them), so only the innermost count.
 */
function innermostLinks(
  brackets: Map<number, number>,
  parens: Map<number, number>,
): Map<number, [number, number]> {
  const links = new Map<number, [number, number]>();
  for (const [start, label] of [...brackets].sort((a, b) => a[0] - b[0])) {
    const paren = parens.get(label + 1);
    if (paren !== undefined) links.set(start, [label, paren]);
  }
  const starts = [...links.keys()];
  const inner = new Map<number, [number, number]>();
  starts.forEach((start, k) => {
    const next = starts[k + 1];
    const link = links.get(start) as [number, number];
    if (next === undefined || next >= link[0]) inner.set(start, link);
  });
  return inner;
}

/**
 * A paragraph reduced to the words a reader sees, for recognising a recipient,
 * in one left-to-right pass: a link to the agent's own file becomes that
 * file's name (its label is prose), any other link keeps its label and loses
 * its destination, a code span keeps its contents minus the padding Markdown
 * removes, and emphasis marks outside code are dropped, so none of them
 * breaks the phrase between a verb and its recipient. Brackets and
 * parentheses are paired once for the whole text, outside code spans and link
 * titles, nested pairs included; the pass never recurses, so nesting depth
 * costs no stack.
 */
export function recipientText(text: string): string {
  const runs = runMatcher(text);
  const spans = codeSpans(text, runs);
  const links = innermostLinks(
    pairsOf(text, spans, "[", "]", false),
    pairsOf(text, spans, "(", ")", true),
  );
  // A label's closing bracket, mapped to where its link's destination ends.
  const skipFrom = new Map<number, number>();
  let out = "";
  let plain = "";
  const flush = () => {
    out += plain.replace(/\*+/g, "").replace(UNDERSCORE, "");
    plain = "";
  };
  const step = (i: number): number => {
    const skip = skipFrom.get(i);
    if (skip !== undefined) return skip;
    const c = text[i] as string;
    if (c === "\\") {
      plain += text.slice(i, i + 2);
      return i + 2;
    }
    if (c === "`") return codeAt(i);
    const link = c === "[" ? links.get(i) : undefined;
    if (link === undefined) {
      plain += c;
      return i + 1;
    }
    flush();
    if (namesAgentFile(text.slice(link[0] + 2, link[1]))) {
      out += "review-arbiter.md";
      return link[1] + 1;
    }
    skipFrom.set(link[0], link[1] + 1);
    return i + 1;
  };
  const codeAt = (i: number): number => {
    const n = runLength(text, i);
    const close = runs.closeOf(i);
    if (close < 0) {
      plain += text.slice(i, i + n);
      return i + n;
    }
    flush();
    out += spanText(text.slice(i + n, close - n));
    return close;
  };
  for (let i = 0; i < text.length; ) i = step(i);
  flush();
  return out;
}

const NO_SUBAGENTS = /\bno subagents?\b/i;
const CALLING_SESSION = /\bcalling session\b/i;

function subagentFindings(file: string, blocks: Paragraph[]): Finding[] {
  const hands = blocks.find(({ text }) => HANDS_OVER.test(recipientText(text)));
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
  isEntryPage: boolean,
  skillDir?: string,
): Finding[] {
  const blocks = paragraphs(withoutFrontmatter(source));
  return [
    ...skillDirFindings(file, blocks, isEntryPage),
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
    const isEntry = (file: string): boolean =>
      file.split(sep).length === 2 && basename(file) === "SKILL.md";
    if (!pages.some(isEntry))
      return couldNotCheck("skill-runtime-forms", "no skill pages found");
    const findings = pages.flatMap((file) => {
      const skillDir = join(base, file.split(sep)[0] as string);
      return formFindings(
        repoPath(root, join(base, file)),
        readFileSync(join(base, file), "utf8"),
        isEntry(file),
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
