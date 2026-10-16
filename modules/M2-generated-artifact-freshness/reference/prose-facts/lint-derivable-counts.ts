#!/usr/bin/env bun
// Derivable counts (module M2): a number in prose that reads as a tally of a
// list the repository holds, with no check behind it.
//
// The problem it finds. "The 6 passes are:", "120 skills", "four templates":
// a number that describes an adjacent list is a hand-written cache of that
// list, and it drifts the moment the list changes. The registered-facts
// check beside this one catches drift of a number that is declared; this
// lint finds the numbers nobody declared. It has no source to compare with,
// so it judges by shape, and a shape is a guess: it runs advisory, never as
// a required check, and a finding is a prompt to drop the number, register
// it, or mark it.
//
// What stays. A number that constrains its content, not a tally: a limit, a
// budget, a retry count, a threshold ("at most 3 retries", "≤ 8000 chars",
// "up to 20 files"), judged by the candidate's own sentence up to its noun
// and by what directly follows it ("3 files or fewer", "8 files per batch").
// A label or
// an ordinal ("step 4", "phase 2", "tier 1"), an identifier (a version, a
// date, an issue key, a section reference, a percentage, "5+"), a list
// marker or a numbered heading, and anything in a code span or a fenced
// block. A line carrying `<!-- measured -->` (a note may follow the word:
// `<!-- measured: ls skills | wc -l -->`), which says the number is a
// constraint or a measurement that stays on purpose. And, with `--registry`,
// a stated copy of a registered fact, which the exact check covers.
//
// Nouns. A candidate is a cardinal (digits from 2, or the words two to
// twelve) followed by a plural noun from the list of things a repository
// counts; the built-in list is a neutral starter and `--nouns <file>`
// (one per line, `#` comments) replaces it with the repository's own.
//
// Exit codes: 0 no finding; 1 a finding; 2 a prose file cannot be read or is
// empty, the nouns file or the registry cannot be read or holds nothing.
//
// Usage: lint-derivable-counts.ts [--nouns <file>] [--registry <facts.yaml>] <prose-file>...
import { resolve } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { blankCode, readRegularFile } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import {
  parseRegistry,
  phrasingPattern,
  readProse,
} from "./check-registered-facts.ts";

/** An argument this lint was given that it cannot use. */
export class InputError extends Error {}

const usage =
  "usage: lint-derivable-counts.ts [--nouns <file>] [--registry <facts.yaml>] <prose-file>...";
const RULE = "derivable-count";

/** Plural nouns a repository counts; a neutral starter, replaced by `--nouns`. */
export const DEFAULT_NOUNS: readonly string[] = [
  "actions",
  "adapters",
  "agents",
  "areas",
  "artifacts",
  "categories",
  "checks",
  "columns",
  "commands",
  "components",
  "criteria",
  "directories",
  "docs",
  "documents",
  "endpoints",
  "entries",
  "examples",
  "fields",
  "files",
  "fixtures",
  "folders",
  "gates",
  "generators",
  "guides",
  "hooks",
  "items",
  "jobs",
  "labels",
  "lenses",
  "migrations",
  "modules",
  "packages",
  "pages",
  "passes",
  "phases",
  "plugins",
  "policies",
  "profiles",
  "prompts",
  "records",
  "repositories",
  "roles",
  "routes",
  "rules",
  "schemas",
  "scripts",
  "sections",
  "services",
  "skills",
  "stages",
  "steps",
  "tables",
  "templates",
  "tests",
  "tools",
  "workflows",
];

const NUMBER_WORDS = new Map<string, number>([
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);

/** A word before the number that makes it a label, not a count. */
const LABEL_WORDS = new Set([
  "appendix",
  "article",
  "chapter",
  "clause",
  "day",
  "exit",
  "figure",
  "item",
  "level",
  "line",
  "milestone",
  "option",
  "page",
  "part",
  "phase",
  "port",
  "priority",
  "round",
  "rung",
  "section",
  "stage",
  "step",
  "table",
  "tier",
  "version",
  "wave",
  "week",
]);

/** Number carriers that are identifiers, blanked before a candidate is read. */
const IDENTIFIERS: readonly RegExp[] = [
  /\b[A-Z][A-Z0-9]+-\d+\b/g, // an issue or decision key
  /\bv\d+(?:\.\d+)*\b/gi, // a version
  /\b\d+\.\d+(?:\.\d+)*\b/g, // a dotted version or number
  /\b\d{4}-\d{2}(?:-\d{2})?\b/g, // a date
  /#\d+/g, // a pull request or issue reference
  /§\s*\d+(?:\.\d+)*/g, // a section reference
  /\b\d+(?:[.,]\d+)*\s*%/g, // a proportion
  /\b\d+(?:[.,]\d+)*\s*\+/g, // a threshold: "5+ files" is "5 or more"
];

/** A list marker or a numbered heading opening the line. */
const LIST_MARKER =
  /^\s*(?:\|\s*)?(?:#{1,6}\s+)?\*{0,2}\d+\*{0,2}\s*(?:[.)]|[—–:])\s+/;
const MEASURED = /<!--\s*measured\b/;
const CANDIDATE =
  /(?<![\w-])(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([a-z][a-z-]*)(?![\w-])/gi;
const CONSTRAINT =
  /≤|≥|<=|>=|[<>]\s?\d|\bmax(?:imum)?\b|\bmin(?:imum)?\b|\blimits?\b|\bbudgets?\b|\bretr(?:y|ies)\b|\btimeouts?\b|\bthresholds?\b|\btop-|\bat least\b|\bat most\b|\bup to\b|\bper\s|\bmore than\b|\bless than\b|\bfewer than\b|\bor more\b|\bor fewer\b|\bor less\b|\bno more than\b|\bwithin\b/i;
const SENTENCE_END = /[.!?;]/;
const LOOKBEHIND = 32;
/** A constraint that follows its number and noun ("3 files or fewer", "8 files per batch"). */
const CONSTRAINT_AFTER =
  /^\s*(?:or (?:more|fewer|less)\b|per\s|max(?:imum)?\b|min(?:imum)?\b|at (?:most|least)\b)/i;

/** The candidate's own clause: back to the last sentence end, up to the noun. */
function clauseBefore(line: string, start: number, end: number): string {
  const before = line.slice(Math.max(0, start - LOOKBEHIND), start);
  let from = 0;
  for (let i = before.length - 1; i >= 0; i--)
    if (SENTENCE_END.test(before[i] ?? "")) {
      from = i + 1;
      break;
    }
  return before.slice(from) + line.slice(start, end);
}

/** A candidate a label names ("step 4") or a constraint governs, in its clause or right after it. */
function exempt(text: string, start: number, end: number): boolean {
  const label = /([a-z]+)\s*$/i.exec(text.slice(0, start))?.[1];
  if (label && LABEL_WORDS.has(label.toLowerCase())) return true;
  return (
    CONSTRAINT.test(clauseBefore(text, start, end)) ||
    CONSTRAINT_AFTER.test(text.slice(end))
  );
}

/** `text` with each match of `pattern` blanked, its line breaks kept so lines still align. */
function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => match.replace(/[^\r\n]/g, " "));
}

/** The tallies of one line of prose, already blanked of code. */
export function talliesOf(line: string, nouns: Set<string>): string[] {
  let text = blank(line, LIST_MARKER);
  for (const pattern of IDENTIFIERS) text = blank(text, pattern);
  const found: string[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const [whole, number = "", noun = ""] = match;
    if (!nouns.has(noun.toLowerCase())) continue;
    const value = /^\d+$/.test(number)
      ? Number.parseInt(number, 10)
      : (NUMBER_WORDS.get(number.toLowerCase()) ?? 0);
    if (value < 2) continue;
    const start = match.index ?? 0;
    if (!exempt(text, start, start + whole.length)) found.push(whole);
  }
  return found;
}

/** The names of a list: one per line, `#` comments and blank lines dropped. */
export function parseNouns(text: string): Set<string> {
  const nouns = new Set<string>();
  for (const raw of text.split("\n")) {
    const noun = raw.replace(/#.*/, "").trim().toLowerCase();
    if (noun) nouns.add(noun);
  }
  return nouns;
}

/** Every finding in one file's prose. */
export function lintProse(
  content: string,
  file: string,
  nouns: Set<string>,
  registered: RegExp[],
): Finding[] {
  const raw = content.split("\n");
  const findings: Finding[] = [];
  // Registered copies are blanked over the whole text, as the exact check
  // matches them, so a phrasing wrapped across lines is seen as one copy.
  let prose = blankCode(content);
  for (const pattern of registered) prose = blank(prose, pattern);
  prose.split("\n").forEach((line, index) => {
    if (MEASURED.test(raw[index] ?? "")) return;
    for (const tally of talliesOf(line, nouns))
      findings.push({
        rule: RULE,
        file,
        line: index + 1,
        problem: `"${tally}" reads as a tally of a list the repository holds, with no check behind it`,
        remedy:
          "drop the number and let the list speak; register it as a fact so a check derives it; or, if it constrains, mark the line <!-- measured -->",
      });
  });
  return findings;
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

interface Options {
  nounsPath?: string;
  registryPath?: string;
  files: string[];
}

function parseArgs(args: string[]): Options {
  const options: Options = { files: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--nouns" || arg === "--registry") {
      const value = args[++i];
      if (!value) throw new InputError(usage);
      if (arg === "--nouns") options.nounsPath = value;
      else options.registryPath = value;
    } else if (arg.startsWith("-")) throw new InputError(usage);
    else options.files.push(arg);
  }
  if (!options.files.length) throw new InputError(usage);
  return options;
}

/** The repository's nouns, the starter list without a file, or why not. */
function loadNouns(path: string | undefined): Set<string> | Error {
  if (!path) return new Set(DEFAULT_NOUNS);
  let nouns: Set<string>;
  try {
    nouns = parseNouns(readRegularFile(path));
  } catch (error) {
    return new Error(`cannot read ${path}: ${reason(error)}`);
  }
  return nouns.size ? nouns : new Error(`${path} names no noun`);
}

/** The patterns of every registered phrasing, none without a registry, or why not. */
function loadRegistered(path: string | undefined): RegExp[] | Error {
  if (!path) return [];
  try {
    return parseRegistry(readRegularFile(path)).flatMap((fact) =>
      fact.phrasings.map(phrasingPattern),
    );
  } catch (error) {
    return new Error(`${path}: ${reason(error)}`);
  }
}

function main(args: string[]): number {
  const { nounsPath, registryPath, files } = parseArgs(args);
  const nouns = loadNouns(nounsPath);
  if (nouns instanceof Error) return couldNotCheck(RULE, nouns.message);
  const registered = loadRegistered(registryPath);
  if (registered instanceof Error)
    return couldNotCheck(RULE, registered.message);
  const root = process.cwd();
  const findings: Finding[] = [];
  for (const file of files) {
    const content = readProse(file);
    if (content instanceof Error) return couldNotCheck(RULE, content.message);
    findings.push(
      ...lintProse(content, repoPath(root, resolve(file)), nouns, registered),
    );
  }
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — no unchecked tally in ${files.length} file(s) (a judgement by shape: a false negative is possible)`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
