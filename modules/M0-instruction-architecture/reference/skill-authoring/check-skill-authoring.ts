#!/usr/bin/env bun
// Skill-authoring rules a script can count, per rule and per file.
//
// A skill's `SKILL.md` is read in full once the skill is invoked; its
// references (`<skill>/references/**/*.md`) are read only when `SKILL.md`
// sends the agent to one. Only the frontmatter is read before invocation.
// The rules counted here keep that progressive loading working:
//
//   reference-depth   each reference SKILL.md does not name, by a link, a
//                     skill-relative path or a folder under references/
//                     holding it, counted on that reference. An agent reads a reference one hop
//                     from SKILL.md reliably; reached only through another
//                     reference, it often reads a part, or nothing.
//                     Cross-links between references SKILL.md names add no
//                     hop.
//   reference-toc     a reference over 100 lines that does not open with a
//                     contents section (a "Contents" heading, preceded by
//                     at most the file's title heading, followed by links to
//                     headings in the file), so an agent reading the top
//                     sees the whole.
//   issue-density     issue and pull-request ids above 5 per 100 prose lines
//                     (blank lines included) of a SKILL.md or reference: each
//                     id past the allowance.
//                     Incident history costs context in every invocation and
//                     belongs in the documents the instructions link to.
//   time-sensitive    phrasing that goes stale with the calendar ("as of
//                     March 2026", "at the time of writing", "recently
//                     added"): each occurrence. State the condition or the
//                     version instead; "as of v2.3" is a version and is not
//                     counted.
//   negative-trigger  a SKILL.md whose body says when not to use the skill
//                     ("When not to use", "Not this skill") while its
//                     description carries no exclusion ("not for", "do not
//                     use", "use X instead", "unless"). Only the
//                     description is read before invocation, so a negative
//                     trigger in the body alone cannot stop a wrong pick.
//
// These are structural signals, not a verdict on whether the instructions are
// right, which review judges. Fenced code is not prose and is not counted;
// time-sensitive phrasing inside an inline code span is an example and is not
// counted either. The time-sensitive patterns catch the common markers only.
//
// Usage: bun check-skill-authoring.ts [--json] [--strict] [--ids <regex>]
//          [--density N] <skills-dir>...
//   <skills-dir>  a folder of skills, each `<skill>/SKILL.md`
//   --json        print `{"counts": {"<rule>": {"<file>": n}}}` and nothing
//                 else, the shape M1's ratchet reads (format "json")
//   --strict      fail on any finding, for a repository that starts at zero;
//                 with --json too
//   --ids         the pattern an issue or pull-request id matches (default:
//                 a tracker key such as ENG-123, or #123; standards and
//                 record ids such as SHA-256, UTF-8, RFC-9110 and ADR-0007
//                 are not ids)
//   --density     ids allowed per 100 prose lines (default 5)
// Exit: 0 measured (findings are reported, not failures, unless --strict);
// 1 a finding under --strict; 2 a usage error, a folder with no skill, or a
// file that cannot be read (unterminated or invalid frontmatter, a SKILL.md
// without a description, an empty body). Measuring a merge base
// (RATCHET_HISTORICAL=1, set by M1's ratchet), a skills folder that does not
// exist yet or holds no skill measures as no findings.
//
// Built-ins only and self-contained, so a repository can copy this one file,
// and M1's ratchet can measure its merge base with the head's copy of it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

/** An input the check cannot measure: a usage error or an unreadable file. */
class InputError extends Error {}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A regular file's text; a link to nothing or a folder is unreadable. */
function readRegularFile(file: string): string {
  const target = statSync(file, { throwIfNoEntry: false });
  if (!target?.isFile())
    throw new InputError(`${file}: not a readable regular file`);
  return readFileSync(file, "utf8");
}

export const RULES = [
  "reference-depth",
  "reference-toc",
  "issue-density",
  "time-sensitive",
  "negative-trigger",
] as const;
export type Rule = (typeof RULES)[number];

export interface Finding {
  file: string;
  rule: Rule;
  line: number;
  message: string;
  /** What the finding adds to its rule's count; 1 unless stated. */
  count: number;
}

export interface Options {
  ids: RegExp;
  density: number;
}

const NOT_IDS =
  "SHA|UTF|ISO|IEC|RFC|CVE|CWE|ADR|TLS|SSL|HTTP|ES|AES|RSA|MD|UTC|GMT|ECMA";
const DEFAULT_IDS = String.raw`\b(?!(?:${NOT_IDS})-)[A-Z][A-Z0-9]+-\d+\b|(?<![\w&/#])#\d+\b`;
const TOC_LINE_LIMIT = 100;
const MONTH =
  "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\b\\.?";
const TIME_SENSITIVE = [
  /\bat the time of (?:writing|this writing)\b/gi,
  new RegExp(
    `\\bas of (?:today|now|this (?:writing|week|month|quarter|year)|${MONTH}|q[1-4]\\b|(?:19|20)\\d\\d\\b)`,
    "gi",
  ),
  /\b(?:recently|newly) (?:added|introduced|released|renamed|changed|shipped|launched)\b/gi,
  /\b(?:coming|available|arriving|landing) soon\b/gi,
  new RegExp(
    `\\b(?:in|since|until|before|after|from) (?:early |mid-|late )?${MONTH} (?:19|20)\\d\\d\\b`,
    "gi",
  ),
  /\b(?:nowadays|these days)\b/gi,
];
const NOT_THIS_SKILL =
  /^(?:when not to\b|not this skill\b|do not use\b|don['’]t use\b|when to use something else\b)/i;
// An exclusion, not any negative word: "instead of writing them by hand"
// describes the work and stops no wrong pick.
const NEGATIVE_CUE =
  /\b(?:not (?:for|when|if|on|to use)|(?:do not|don['’]t|never) use|unless|instead(?! of\b))\b/i;
const CONTENTS = /^(?:table of contents|contents|toc)$/i;

interface Document {
  file: string;
  /** Body lines, frontmatter removed. */
  lines: string[];
  /** Line number in the file of `lines[0]`. */
  offset: number;
  /** Whether each body line is inside fenced code (fences included). */
  code: boolean[];
  description: string | undefined;
}

/** Split off YAML frontmatter; an unterminated or invalid block throws. */
export function parseDocument(file: string, source: string): Document {
  let body = source;
  let offset = 1;
  let description: string | undefined;
  if (/^---\r?\n/.test(source)) {
    const match = source.match(
      /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/,
    );
    if (!match) throw new InputError(`${file}: unterminated frontmatter`);
    let fields: unknown;
    try {
      fields = Bun.YAML.parse(match[1] ?? "");
    } catch (error) {
      throw new InputError(`${file}: invalid frontmatter: ${message(error)}`);
    }
    if (fields !== null && typeof fields === "object" && !Array.isArray(fields))
      description = stringField(fields, "description");
    body = source.slice(match[0].length);
    offset = match[0].split("\n").length;
  }
  if (!body.trim()) throw new InputError(`${file}: empty Markdown body`);
  const lines = body.trimEnd().split(/\r?\n/);
  return { file, lines, offset, code: fencedLines(lines), description };
}

function stringField(fields: object, key: string): string | undefined {
  const value = (fields as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** A closing fence: the opening's character, at least as long, alone. */
function closes(fence: string, marker: string | undefined, line: string) {
  return (
    marker !== undefined &&
    marker[0] === fence[0] &&
    marker.length >= fence.length &&
    /^\s*[`~]+\s*$/.test(line)
  );
}

/** Mark lines inside fenced code, the fence lines themselves included. */
function fencedLines(lines: string[]): boolean[] {
  const code: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    code.push(fence !== undefined || marker !== undefined);
    if (fence === undefined) fence = marker;
    else if (closes(fence, marker, line)) fence = undefined;
  }
  return code;
}

/** The length of the run of backticks starting at `from`. */
function backticks(line: string, from: number): number {
  let end = from;
  while (line[end] === "`") end++;
  return end - from;
}

/** The end of the backtick run exactly `run` long after `from`, or -1. */
function closingRun(line: string, from: number, run: number): number {
  for (let i = from; i < line.length; ) {
    const n = backticks(line, i);
    if (n === run) return i + n;
    i += n || 1;
  }
  return -1;
}

/** The line without its code spans: a backtick run up to the next as long. */
function withoutInlineCode(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; ) {
    const run = backticks(line, i);
    if (!run) {
      out += line[i++];
      continue;
    }
    const end = closingRun(line, i + run, run);
    if (end < 0) out += line.slice(i, i + run);
    i = end < 0 ? i + run : end;
  }
  return out;
}

/** Heading text as a renderer slugs it (GitHub's rules), duplicates numbered. */
function headingSlugs(doc: Document): { slugs: Set<string>; toc: number[] } {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  const toc: number[] = [];
  let before = 0;
  doc.lines.forEach((line, i) => {
    const heading = headingText(line);
    if (heading === undefined || doc.code[i]) return;
    const text = plainText(heading);
    const opening = before === 0 || (before === 1 && isTitle(doc));
    before++;
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\- _]/gu, "")
      .replaceAll(" ", "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (CONTENTS.test(text)) {
      if (opening) toc.push(i);
    } else slugs.add(n ? `${base}-${n}` : base);
  });
  return { slugs, toc };
}

/** Whether the document's first heading is a level-1 title. */
function isTitle(doc: Document): boolean {
  const first = doc.lines.findIndex((l, i) => !doc.code[i] && headingDepth(l));
  return first >= 0 && headingDepth(doc.lines[first] ?? "") === 1;
}

/** Trailing characters from `set` removed, without a backtracking pattern. */
function trimTrailing(text: string, set: string): string {
  let end = text.length;
  while (end > 0 && set.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** An ATX heading's text without its markers, or undefined for any other line. */
function headingText(line: string): string | undefined {
  const depth = headingDepth(line);
  if (!depth) return undefined;
  const text = line.slice(depth).trim();
  // A closing run of `#` counts only after a space: "C#" keeps its own.
  const closed = trimTrailing(text, "#");
  return closed === "" || /\s$/.test(closed) ? closed.trim() : text;
}

/** Link text kept, link targets, images' bangs, code and emphasis marks dropped. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\]\([^)]*\)/g, "")
    .replaceAll("![", "")
    .replace(/[[\]`*]/g, "")
    .trim();
}

function headingDepth(line: string): number {
  return /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;
}

/** A percent-escaped link part, decoded; a malformed escape kept as written. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The prose lines under the heading at `start`, up to the next as high or higher. */
function section(doc: Document, start: number): string[] {
  const depth = headingDepth(doc.lines[start] ?? "");
  const end = doc.lines.findIndex((line, i) => {
    if (i <= start || doc.code[i]) return false;
    const d = headingDepth(line);
    return d > 0 && d <= depth;
  });
  return doc.lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((_, k) => !doc.code[start + 1 + k]);
}

/** A contents section at the top: a contents heading, then a link to a heading here. */
function hasContents(doc: Document): boolean {
  const { slugs, toc } = headingSlugs(doc);
  const reachesHeading = (line: string) =>
    [...line.matchAll(/\]\(#([^)\s]+)\)/g)].some((m) =>
      slugs.has(decoded(m[1] ?? "").toLowerCase()),
    );
  return toc.some((start) => section(doc, start).some(reachesHeading));
}

/** Link targets and skill-relative paths in prose. */
function targets(doc: Document): string[] {
  const out: string[] = [];
  doc.lines.forEach((line, i) => {
    if (doc.code[i]) return;
    const found = [
      ...[...line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
        (m) => m[1],
      ),
      /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line)?.[1],
      ...[
        ...line.matchAll(
          /(?:(?:<skill-dir>|\$\{CLAUDE_SKILL_DIR\})\/|(?<![\w./-]))(references\/[^\s`'")<>]*)/g,
        ),
      ].map((m) => `<skill>/${trimTrailing(m[1] ?? "", ".,;:!?*_")}`),
    ];
    for (const target of found) if (target) out.push(target);
  });
  return out;
}

/** The files and folders a document names, as absolute paths. */
function named(doc: Document, skillRoot: string): Set<string> {
  const out = new Set<string>();
  for (const target of targets(doc)) {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue;
    const clean = decoded(target.split(/[?#]/)[0] ?? "");
    out.add(
      clean.startsWith("<skill>/")
        ? resolve(skillRoot, clean.slice("<skill>/".length))
        : resolve(dirname(doc.file), clean),
    );
  }
  return out;
}

/**
 * A reference SKILL.md does not name, by its path or by a folder under
 * references/ holding it, sits more than one hop away: reached through another reference, or not
 * at all. Cross-links between references SKILL.md names add no hop.
 */
function referenceDepth(
  reference: string,
  fromSkill: Set<string>,
  skillRoot: string,
): Finding[] {
  const path = resolve(reference);
  const folders = resolve(skillRoot, "references");
  // A folder names what it holds only from references/ down: naming the
  // skill's own folder, or one above it, sends the agent to no reference.
  const holds = (folder: string) =>
    (folder === folders || folder.startsWith(`${folders}${sep}`)) &&
    path.startsWith(`${folder}${sep}`);
  for (const p of fromSkill)
    if (path === p || holds(trimTrailing(p, "\\/"))) return [];
  return [
    {
      file: reference,
      rule: "reference-depth",
      line: 1,
      message: `SKILL.md does not name ${slash(relative(skillRoot, path))}; link it from SKILL.md, saying when to read it`,
      count: 1,
    },
  ];
}

function issueDensity(doc: Document, options: Options): Finding[] {
  const prose = doc.lines.filter((_, i) => !doc.code[i]);
  const ids = new RegExp(options.ids.source, "g");
  const found = prose.reduce((n, l) => n + (l.match(ids)?.length ?? 0), 0);
  const allowed = Math.floor((prose.length * options.density) / 100);
  if (found <= allowed) return [];
  return [
    {
      file: doc.file,
      rule: "issue-density",
      line: doc.offset,
      message: `${found} issue or pull-request ids in ${prose.length} prose lines, ${found - allowed} over ${options.density} per 100; keep the rule, move the history to a linked document`,
      count: found - allowed,
    },
  ];
}

function timeSensitive(doc: Document): Finding[] {
  const out: Finding[] = [];
  doc.lines.forEach((line, i) => {
    if (doc.code[i]) return;
    const text = withoutInlineCode(line);
    for (const pattern of TIME_SENSITIVE)
      for (const m of text.matchAll(pattern))
        out.push({
          file: doc.file,
          rule: "time-sensitive",
          line: doc.offset + i,
          message: `"${m[0]}" goes stale; state the condition or the version`,
          count: 1,
        });
  });
  return out;
}

function negativeTrigger(doc: Document): Finding[] {
  const heading = doc.lines.findIndex((line, i) => {
    const text = headingText(line);
    return (
      !doc.code[i] && text !== undefined && NOT_THIS_SKILL.test(plainText(text))
    );
  });
  if (heading < 0 || NEGATIVE_CUE.test(doc.description ?? "")) return [];
  return [
    {
      file: doc.file,
      rule: "negative-trigger",
      line: doc.offset + heading,
      message:
        "the body says when not to use this skill and the description does not; only the description is read before invocation",
      count: 1,
    },
  ];
}

/** The rules every instruction file shares. */
function scanFile(doc: Document, options: Options): Finding[] {
  return [...issueDensity(doc, options), ...timeSensitive(doc)];
}

function referenceToc(doc: Document): Finding[] {
  if (doc.lines.length <= TOC_LINE_LIMIT || hasContents(doc)) return [];
  return [
    {
      file: doc.file,
      rule: "reference-toc",
      line: doc.offset,
      message: `${doc.lines.length} lines and no contents section linking to its headings`,
      count: 1,
    },
  ];
}

export interface Skill {
  /** The skill's folder. */
  root: string;
  /** Its `SKILL.md`. */
  file: string;
  /** Every Markdown file under its `references/`. */
  references: string[];
}

/** Every rule's findings for one skill, `SKILL.md` and its references. */
export function scanSkill(
  skill: Skill,
  read: (file: string) => string,
  options: Options,
): Finding[] {
  const doc = parseDocument(skill.file, read(skill.file));
  if (doc.description === undefined || !doc.description.trim())
    throw new InputError(`${skill.file}: no description in the frontmatter`);
  const fromSkill = named(doc, skill.root);
  const findings = [...scanFile(doc, options), ...negativeTrigger(doc)];
  for (const file of skill.references) {
    const reference = parseDocument(file, read(file));
    findings.push(
      ...referenceDepth(file, fromSkill, skill.root),
      ...referenceToc(reference),
      ...scanFile(reference, options),
    );
  }
  return findings;
}

const slash = (path: string) => path.split(sep).join("/");

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Each `<dir>/<skill>/SKILL.md` with its `references/**\/*.md`, sorted. A
 * `historical` tree (a merge base) may predate the folder or its first skill.
 */
export function inventory(dir: string, historical = false): Skill[] {
  if (!isDirectory(dir)) {
    if (historical && !statSync(dir, { throwIfNoEntry: false })) return [];
    throw new InputError(`not a readable directory: ${dir}`);
  }
  const out: Skill[] = [];
  for (const entry of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const root = join(dir, entry);
    const file = join(root, "SKILL.md");
    if (!statSync(file, { throwIfNoEntry: false })) continue;
    const folder = join(root, "references");
    const references = isDirectory(folder)
      ? (readdirSync(folder, { recursive: true }) as string[])
          .filter((rel) => /\.md$/i.test(rel))
          .sort((a, b) => a.localeCompare(b))
          .map((rel) => slash(join(folder, rel)))
      : [];
    out.push({ root, file: slash(file), references });
  }
  if (!out.length && !historical)
    throw new InputError(`${dir}: no skill to measure`);
  return out;
}

/** Findings of every skill in the skills folders. */
export function measure(
  dirs: string[],
  options: Options,
  historical = false,
): Finding[] {
  return dirs.flatMap((dir) =>
    inventory(dir, historical).flatMap((skill) =>
      scanSkill(skill, readRegularFile, options),
    ),
  );
}

/** Rule → file → count, the shape M1's ratchet reads. */
export function counts(
  findings: Finding[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const f of findings) {
    const files = out[f.rule] ?? {};
    files[f.file] = (files[f.file] ?? 0) + f.count;
    out[f.rule] = files;
  }
  return out;
}

const USAGE =
  "usage: check-skill-authoring.ts [--json] [--strict] [--ids <regex>] [--density N] <skills-dir>...";

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        strict: { type: "boolean" },
        ids: { type: "string" },
        density: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new InputError(`${message(error)}\n${USAGE}`);
  }
}

export function checkSkillAuthoring(argv: string[]): number {
  const { values, positionals } = parse(argv);
  if (!positionals.length) throw new InputError(USAGE);
  const density = Number(values.density ?? 5);
  if (!Number.isFinite(density) || density < 0)
    throw new InputError(`--density must be a number of at least 0\n${USAGE}`);
  if (values.ids === "")
    throw new InputError(`--ids needs a pattern\n${USAGE}`);
  const options = { ids: new RegExp(values.ids ?? DEFAULT_IDS), density };
  const historical = process.env.RATCHET_HISTORICAL === "1";
  const findings = measure(positionals, options, historical);
  const failed = values.strict && findings.length ? 1 : 0;
  if (values.json) {
    console.log(JSON.stringify({ counts: counts(findings) }));
    return failed;
  }
  for (const f of findings)
    console.log(`${f.file}:${f.line}: ${f.rule}: ${f.message}`);
  const totals = counts(findings);
  console.log(
    `Skill authoring: ${RULES.map((r) => `${r} ${Object.values(totals[r] ?? {}).reduce((a, b) => a + b, 0)}`).join(", ")}`,
  );
  return failed;
}

// An input it cannot measure is exit 2, never a pass.
if (import.meta.main) {
  try {
    process.exitCode = checkSkillAuthoring(process.argv.slice(2));
  } catch (error) {
    console.error(message(error));
    process.exitCode = 2;
  }
}
