// The public roadmap (ROADMAP.md) and the maintainers' plan (design/plan.md)
// list the same open work: every roadmap item is in the plan, under the same
// number, in the same group and order, and every unnumbered "Later" entry the
// roadmap names is one the plan names. The plan may hold items the roadmap
// leaves out (work only the maintainers need), but a document the site
// renders may cite only items the roadmap has. Exit 1 on a mismatch, 2 when
// it cannot check: either file is missing or has no items, or a pattern of
// rendered documents matches nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "roadmap-plan";
const ROADMAP = "ROADMAP.md";
const PLAN = "design/plan.md";

/**
 * The documents the site renders, as `website/src/content.config.ts` lists
 * them (its test keeps the two lists equal), without the roadmap itself and
 * the changelog, which is history.
 */
export const RENDERED = [
  "README.md",
  "FACTORY.md",
  "FEATURES.md",
  "GLOSSARY.md",
  "adoption/*.md",
  "profiles/README.md",
  "principles/*.md",
  "modules/README.md",
  "modules/M*/README.md",
  "modules/M*/mappings.md",
  "plugin/README.md",
  "plugin/CONFIGURATION.md",
  "plugin/EXTENDING.md",
  "plugin/skills/*/SKILL.md",
  "plugin/skills/*/README.md",
  "plugin/agents/*.md",
];

interface Entry {
  key: string;
  line: number;
}
interface Group {
  name: string;
  line: number;
  items: Entry[];
  bullets: Entry[];
}

const GROUP = /^## (.+)$/;
const ITEM = /^### (\d+)\. \S/;
const BULLET = /^- \*\*(.+?)\.?\*\*/;
/** A list entry at the left margin, in any marker CommonMark allows. */
const LIST_ENTRY = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A list entry indented one to three spaces, which CommonMark also reads. */
const INDENTED_ENTRY = /^( {1,3})(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A left-margin entry's marker and the spaces before its text. */
const ENTRY_TEXT = /^(?:[-*+]|\d{1,9}[.)]) {1,4}(?! )/;
/** Any `##` or `###` heading CommonMark reads: indented, or a tab after it. */
const GROUP_SHAPE = /^ {0,3}##(?:[ \t]|$)/;
const ITEM_SHAPE = /^ {0,3}###(?:[ \t]|$)/;
/** A fence opener: up to three spaces, then three or more ` or ~. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** What one line of a roadmap-shaped page is to this check. */
type Line =
  | { kind: "group"; name: string }
  | { kind: "item"; key: string }
  | { kind: "bullet"; key: string }
  | { kind: "unsupported" }
  | { kind: "other" };

/**
 * Each line outside fenced code, classified. A fence closes only on the
 * opener's character repeated at least as many times, with nothing after it,
 * as CommonMark has it. Under a group, a list entry outside any item must be
 * a `- **Name.**` entry at the left margin, a `###` heading must be
 * `### N. Title`, and every `##` heading must be `## Group`; anything else
 * CommonMark reads as such a heading or entry (indented, or with a tab after
 * its marker) is `unsupported`, so a form this check does not read is a
 * finding rather than a line it skips. An indented entry that reaches the
 * text column of the left-margin entry above it is that entry's child, part
 * of its text.
 */
function classify(markdown: string): (Line & { line: number })[] {
  const lines: (Line & { line: number })[] = [];
  let fence: string | undefined;
  let grouped = false;
  let inItem = false;
  let nest: number | undefined;
  markdown.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (fence) {
      if (closesFence(text, fence)) fence = undefined;
      return;
    }
    fence = FENCE_OPEN.exec(text)?.[1];
    if (fence) return;
    const kind = classifyLine(text, grouped, inItem, nest);
    if (kind.kind === "group") [grouped, inItem] = [true, false];
    if (kind.kind === "item") inItem = true;
    nest = nextNest(text, kind, nest);
    lines.push({ ...kind, line });
  });
  return lines;
}

function closesFence(text: string, fence: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text)?.[1];
  return !!close && close[0] === fence[0] && close.length >= fence.length;
}

/**
 * The text column of the left-margin entry a later indented entry nests
 * under, if one is open: set by an entry, kept by blank and indented lines,
 * and closed by anything else at the left margin.
 */
function nextNest(
  text: string,
  kind: Line,
  nest: number | undefined,
): number | undefined {
  if (kind.kind === "group" || kind.kind === "item") return undefined;
  const entry = ENTRY_TEXT.exec(text);
  if (entry) return entry[0].length;
  if (LIST_ENTRY.test(text)) return text.search(/\s|$/) + 1;
  return /^\s|^$/.test(text) ? nest : undefined;
}

function classifyLine(
  text: string,
  grouped: boolean,
  inItem: boolean,
  nest: number | undefined,
): Line {
  const group = GROUP.exec(text)?.[1];
  if (group) return { kind: "group", name: group.trim() };
  if (GROUP_SHAPE.test(text)) return UNSUPPORTED;
  if (grouped) return groupedLine(text, inItem, nest);
  return ITEM_SHAPE.test(text) || BULLET.test(text) ? UNSUPPORTED : OTHER;
}

/** A line under a group: an item, an entry, or text. */
function groupedLine(
  text: string,
  inItem: boolean,
  nest: number | undefined,
): Line {
  const item = ITEM.exec(text)?.[1];
  if (item) return { kind: "item", key: item };
  if (ITEM_SHAPE.test(text)) return UNSUPPORTED;
  return inItem ? OTHER : entryLine(text, nest);
}

/** A line under a group, outside any item, that is not a heading. */
function entryLine(text: string, nest: number | undefined): Line {
  const indent = INDENTED_ENTRY.exec(text)?.[1]?.length;
  if (indent !== undefined) return indent >= (nest ?? 4) ? OTHER : UNSUPPORTED;
  if (!LIST_ENTRY.test(text)) return OTHER;
  const bullet = BULLET.exec(text)?.[1];
  return bullet ? { kind: "bullet", key: bullet } : UNSUPPORTED;
}

const UNSUPPORTED: Line = { kind: "unsupported" };
const OTHER: Line = { kind: "other" };

/** The `##` groups of a roadmap-shaped page, with their items and entries. */
export function parseGroups(markdown: string): Group[] {
  const groups: Group[] = [];
  for (const entry of classify(markdown)) {
    if (entry.kind === "group")
      groups.push({
        name: entry.name,
        line: entry.line,
        items: [],
        bullets: [],
      });
    const current = groups.at(-1);
    if (entry.kind === "item") current?.items.push(entry);
    if (entry.kind === "bullet") current?.bullets.push(entry);
  }
  return groups;
}

/** Lines shaped like roadmap structure that `parseGroups` does not read. */
export function unsupportedLines(markdown: string): Entry[] {
  const lines = markdown.split("\n");
  return classify(markdown)
    .filter((entry) => entry.kind === "unsupported")
    .map(({ line }) => ({ key: lines[line - 1] ?? "", line }));
}

/** A complete list of item numbers: "3", "3 and 4", "3, 4, and 999". */
const NUMBERS = String.raw`\d+(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)\d+)*`;
const EXPLICIT = new RegExp(
  String.raw`\b(?:ROADMAP\.md(?:\]\([^)]*\))?|roadmap)(?:'s)?,?\s+items?\s+(${NUMBERS})`,
  "gid",
);
const ANCHOR = /ROADMAP\.md#(\d+)-/dgi;
const BARE = new RegExp(String.raw`\bitems?\s+(${NUMBERS})`, "gid");
/** "Step 4a item 1", "§ 3 item 2": an item of a procedure, not the roadmap. */
const QUALIFIED = /(?:\b(?:step|section|phase|stage)\s+|§\s*)[\w.]+,?\s*$/i;
/**
 * A link target or file name. Only a Markdown document can be the subject of
 * an item number: a web page or a source file has no items.
 */
const DOCUMENT = /\]\(([^)\s]*)\)|([\w./-]+\.md)\b/g;

/**
 * Item numbers a document cites as roadmap items, with their lines. A
 * citation is explicit ("ROADMAP.md item N", the file name possibly a link;
 * "roadmap item N"; a link to an item's heading, `ROADMAP.md#N-title`), or
 * the shorthand "item N". The shorthand takes its subject from the nearest
 * document named before it in its block (the text between blank lines): it
 * cites the roadmap after the roadmap, and nothing after another Markdown
 * document. With no document named before it in its block, the shorthand
 * cites the roadmap inside parentheses, the convention of the rendered
 * documents, and nothing in running text. A step or section qualifying it
 * ("Step 4a item 1") gives it that subject instead. A citation may wrap onto
 * the next line, and a list of numbers is read to its end.
 */
export function citedItems(markdown: string): Entry[] {
  const starts = [0];
  for (const newline of markdown.matchAll(/\n/g))
    starts.push((newline.index ?? 0) + 1);
  const lineAt = (offset: number) =>
    starts.findLastIndex((start) => start <= offset) + 1;
  const cited = new Map<string, Entry & { at: number }>();
  const cite = (match: RegExpMatchArray) => {
    const from = match.indices?.[1]?.[0] ?? 0;
    for (const n of (match[1] ?? "").matchAll(/\d+/g)) {
      const at = from + (n.index ?? 0);
      const line = lineAt(at);
      cited.set(`${line}:${n[0]}`, { key: n[0], line, at });
    }
  };
  for (const pattern of [EXPLICIT, ANCHOR])
    for (const match of markdown.matchAll(pattern)) cite(match);
  const citesRoadmap = shorthandSubject(markdown);
  for (const match of markdown.matchAll(BARE))
    if (citesRoadmap(match.index ?? 0)) cite(match);
  return [...cited.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ key, line }) => ({ key, line }));
}

/** A document named at an offset, and whether it is the roadmap. */
interface Subject {
  at: number;
  roadmap: boolean;
}

/** Whether a bare "item N" at an offset cites the roadmap (see citedItems). */
function shorthandSubject(markdown: string): (at: number) => boolean {
  const subjects = namedDocuments(markdown);
  const blockAt = blockIndex(markdown);
  const openAt = parenOpen(markdown);
  return (at) => {
    if (QUALIFIED.test(markdown.slice(Math.max(0, at - 40), at))) return false;
    const subject = subjects.findLast(
      (s) => s.at < at && blockAt(s.at) === blockAt(at),
    );
    return subject ? subject.roadmap : openAt(at) !== undefined;
  };
}

/** Every document a page names, in order: explicit citations and documents. */
function namedDocuments(markdown: string): Subject[] {
  const subjects: Subject[] = [];
  for (const pattern of [EXPLICIT, ANCHOR])
    for (const match of markdown.matchAll(pattern))
      subjects.push({ at: match.index ?? 0, roadmap: true });
  for (const match of markdown.matchAll(DOCUMENT)) {
    const target = (match[1] ?? match[2] ?? "").replace(/[#?].*$/, "");
    if (/\.md$/i.test(target))
      subjects.push({
        at: match.index ?? 0,
        roadmap: /(?:^|\/)ROADMAP\.md$/i.test(target),
      });
  }
  return subjects.sort((a, b) => a.at - b.at);
}

/** The index of the block (text between blank lines) an offset falls in. */
function blockIndex(markdown: string): (offset: number) => number {
  const breaks = [...markdown.matchAll(/\n[ \t]*\n/g)].map((m) => m.index ?? 0);
  return (offset) => breaks.filter((at) => at < offset).length;
}

/**
 * Where the innermost parenthesis open at an offset begins, counted within
 * its block; `undefined` outside parentheses.
 */
function parenOpen(markdown: string): (offset: number) => number | undefined {
  const opens: (number | undefined)[] = [];
  const blank = /[ \t]*\n/y;
  const stack: number[] = [];
  for (let at = 0; at < markdown.length; at++) {
    opens.push(stack.at(-1));
    const char = markdown[at];
    blank.lastIndex = at + 1;
    if (char === "(") stack.push(at);
    else if (char === ")") stack.pop();
    else if (char === "\n" && blank.test(markdown)) stack.length = 0;
  }
  return (offset) => opens[offset];
}

/** Group names and item numbers a page gives twice, and lines it cannot read. */
function structure(file: string, markdown: string, groups: Group[]): Finding[] {
  const findings: Finding[] = [];
  const once = (entries: Entry[], what: (key: string) => string) => {
    const first = new Map<string, number>();
    for (const { key, line } of entries) {
      const earlier = first.get(key);
      if (earlier === undefined) first.set(key, line);
      else
        findings.push({
          rule: RULE,
          file,
          line,
          problem: `${what(key)} appears twice (first on line ${earlier})`,
          remedy: "give every group its own name and every item its own number",
        });
    }
  };
  once(
    groups.map((g) => ({ key: g.name, line: g.line })),
    (name) => `group "${name}"`,
  );
  once(
    groups.flatMap((g) => g.items),
    (n) => `item ${n}`,
  );
  for (const { key, line } of unsupportedLines(markdown))
    findings.push({
      rule: RULE,
      file,
      line,
      problem: `"${key}" is not a form this check reads`,
      remedy:
        'write items as "### N. Title" and the entries outside items as "- **Name.**", under a "## Group" heading',
    });
  return findings;
}

/** Roadmap groups the plan orders differently. */
function groupOrder(roadmapGroups: Group[], planGroups: Group[]): Finding[] {
  const planOrder = planGroups.map((g) => g.name);
  const shared = roadmapGroups.filter((g) => planOrder.includes(g.name));
  const expected = planOrder.filter((name) =>
    shared.some((g) => g.name === name),
  );
  return shared
    .filter((group, at) => group.name !== expected[at])
    .map((group) => ({
      rule: RULE,
      file: ROADMAP,
      line: group.line,
      problem: `group "${group.name}" is out of the plan's order (${expected.join(", ")})`,
      remedy: "order the roadmap's groups as the plan orders them",
    }));
}

/** A roadmap group's items and entries against the plan's group of that name. */
function groupContents(group: Group, twin: Group): Finding[] {
  const finding = (line: number, problem: string, remedy: string) => ({
    rule: RULE,
    file: ROADMAP,
    line,
    problem,
    remedy,
  });
  const planOrder = twin.items.map((i) => i.key);
  const missing = group.items
    .filter((item) => !planOrder.includes(item.key))
    .map((item) =>
      finding(
        item.line,
        `item ${item.key} is not under "${group.name}" in the plan`,
        `give ${PLAN} item ${item.key} under "## ${group.name}", or move it here to the group the plan has it in`,
      ),
    );
  const shared = group.items.filter((i) => planOrder.includes(i.key));
  const expected = planOrder.filter((n) => shared.some((i) => i.key === n));
  const misordered = shared
    .filter((item, at) => item.key !== expected[at])
    .map((item) =>
      finding(
        item.line,
        `item ${item.key} is out of the plan's order under "${group.name}" (${expected.join(", ")})`,
        "order the roadmap's items as the plan orders them",
      ),
    );
  const planBullets = twin.bullets.map((b) => b.key);
  const unnamed = group.bullets
    .filter((bullet) => !planBullets.includes(bullet.key))
    .map((bullet) =>
      finding(
        bullet.line,
        `"${bullet.key}" is not under "${group.name}" in the plan`,
        `name it in ${PLAN} under "## ${group.name}" with the same bold lead-in`,
      ),
    );
  return [...missing, ...misordered, ...unnamed];
}

/** Citations in rendered pages of items the roadmap does not have. */
function citations(
  rendered: { file: string; text: string }[],
  onRoadmap: Set<string>,
  inPlan: Set<string>,
): Finding[] {
  return rendered.flatMap(({ file, text }) =>
    citedItems(text)
      .filter((cite) => !onRoadmap.has(cite.key))
      .map((cite) => ({
        rule: RULE,
        file,
        line: cite.line,
        problem: inPlan.has(cite.key)
          ? `cites roadmap item ${cite.key}, which only the maintainers' plan has`
          : `cites roadmap item ${cite.key}, which neither the roadmap nor the plan has`,
        remedy: inPlan.has(cite.key)
          ? `put item ${cite.key} on ${ROADMAP} for the site's readers, or cite ${PLAN} instead`
          : "cite an open item, or drop the citation",
      })),
  );
}

const itemKeys = (groups: Group[]) =>
  new Set(groups.flatMap((g) => g.items.map((i) => i.key)));

/** What the roadmap and the plan disagree on, and what rendered pages cite wrongly. */
export function compare(
  roadmap: string,
  plan: string,
  rendered: { file: string; text: string }[] = [],
): Finding[] {
  const planGroups = parseGroups(plan);
  const roadmapGroups = parseGroups(roadmap);
  const contents = roadmapGroups.flatMap((group): Finding[] => {
    const twin = planGroups.find((g) => g.name === group.name);
    if (twin) return groupContents(group, twin);
    return [
      {
        rule: RULE,
        file: ROADMAP,
        line: group.line,
        problem: `the plan has no "${group.name}" group`,
        remedy: `add "## ${group.name}" to ${PLAN}, or move the roadmap's entries to a group the plan has`,
      },
    ];
  });
  return [
    ...structure(ROADMAP, roadmap, roadmapGroups),
    ...structure(PLAN, plan, planGroups),
    ...groupOrder(roadmapGroups, planGroups),
    ...contents,
    ...citations(rendered, itemKeys(roadmapGroups), itemKeys(planGroups)),
  ];
}

export function checkRoadmap(root = "."): number {
  for (const file of [ROADMAP, PLAN])
    if (!existsSync(join(root, file)))
      return couldNotCheck(RULE, `${file} is missing under ${root}`);
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  for (const file of [ROADMAP, PLAN])
    if (!parseGroups(read(file)).some((g) => g.items.length))
      return couldNotCheck(
        RULE,
        `${file} has no "### N. Title" item under a "## Group" heading`,
      );
  const files: string[] = [];
  for (const pattern of RENDERED) {
    const matched = [...new Bun.Glob(pattern).scanSync({ cwd: root })].sort();
    if (!matched.length)
      return couldNotCheck(
        RULE,
        `no rendered document matches ${pattern} under ${root}`,
      );
    files.push(...matched);
  }
  const rendered = files.map((file) => ({ file, text: read(file) }));
  const findings = compare(read(ROADMAP), read(PLAN), rendered);
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — every item on ${ROADMAP} is in ${PLAN} in the same group and order, and the ${rendered.length} rendered documents cite only roadmap items`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkRoadmap(process.argv[2]));
