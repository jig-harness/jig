#!/usr/bin/env bun
// Lifecycle map gate — every owner the stage map names resolves.
//
// A repository publishes its delivery loop as one stage map (templates/LIFECYCLE.md):
// a table with one row per stage, a `Stage`, an `Owner` and a `Hands on`
// column. The owner is the skill, command or document that runs the stage;
// "hands on" is the artifact the next stage picks up. A map that names a skill
// nobody ships, or a script the package no longer has, sends a reader to
// something that is not there, and a stage whose owner was never written down
// is a stage nobody can find by asking "what comes next".
//
// What it checks, in the order a reader meets it:
//   * the file holds a table with `Stage`, `Owner` and `Hands on` columns;
//   * a stage has a name that is not a number (a number goes stale the day a
//     stage is added), a name no other stage has, an owner and a handoff,
//     and none of them is an unfilled `<placeholder>`;
//   * every code span in an owner resolves: `/name` or `/namespace:name` to a
//     skill directory (`<dir>/<name>/SKILL.md`) or a command file
//     (`<dir>/<name>.md`) under a `--skills` directory; `<pm> run <script>` to a
//     package.json script (or, for `bun run`, a file); a path, or `bun <path>`,
//     to a file that exists;
//     anything else to a tool declared with `--external`;
//   * every relative link in an owner, inline or by reference, reaches a file
//     that exists;
//   * with `--cover <dir>`, every skill under the directory owns a stage or is
//     in the table of skills outside the loop, so a skill that exists but no
//     stage reaches is found here;
//   * with `--scan <file>`, every `/namespace:name` span of a namespace given
//     to `--skills` in that file resolves, so process documents name only
//     skills that exist;
//   * with `--linked-from <file>`, that file (the always-loaded instructions)
//     links to the map, so it is one hop away.
// Whether the stages are in the right order is a reviewer's call, not this
// gate's.
//
// Exit codes: 0 every check holds, 1 a violation, 2 usage or an input that
// cannot be read.
//
// Usage:
//   check-lifecycle-map.ts <map.md> [--root <dir>] [--skills [namespace=]<dir>]...
//     [--package-json <file>] [--external <command>]... [--cover <dir>]...
//     [--scan <file>]... [--linked-from <file>]
// `--root` (default: the working directory) is where `bun <path>` and a bare
// path are looked up; `--package-json` defaults to <root>/package.json.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { fenceAfter, readRegularFile } from "../../../../lib/files.ts";
import {
  type Finding,
  couldNotCheck,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";

const GATE = "check-lifecycle-map.ts";
const usage = `usage: ${GATE} <map.md> [--root <dir>] [--skills [namespace=]<dir>]... [--package-json <file>] [--external <command>]... [--cover <dir>]... [--scan <file>]... [--linked-from <file>]`;

/** A skill directory and the namespace its skills are invoked under ("" for none). */
export interface SkillDir {
  namespace: string;
  dir: string;
}

export interface MapOptions {
  /** The map file. */
  map: string;
  root: string;
  skills: SkillDir[];
  packageJson?: string | undefined;
  external: string[];
  cover: string[];
  scan: string[];
  linkedFrom?: string | undefined;
}

/** One stage of the map: the cells of a row, with the line it is on. */
export interface Stage {
  line: number;
  stage: string;
  owner: string;
  handsOn: string;
}

/** Input the gate cannot read or does not understand; never a pass. */
export class MapInputError extends Error {}

/** The part of `line` a reader sees, given whether an HTML comment is open before it. */
function outsideComments(
  line: string,
  open: boolean,
): { text: string; open: boolean } {
  let text = "";
  let at = 0;
  let inComment = open;
  while (at <= line.length) {
    const next = line.indexOf(inComment ? "-->" : "<!--", at);
    if (next < 0) {
      if (!inComment) text += line.slice(at);
      break;
    }
    if (!inComment) text += line.slice(at, next);
    at = next + (inComment ? 3 : 4);
    inComment = !inComment;
  }
  return { text, open: inComment };
}

/** Lines of `text` as a reader sees them: fenced blocks and HTML comments blanked, so line numbers hold. */
export function visibleLines(text: string): string[] {
  let fence: string | undefined;
  let comment = false;
  return text.split("\n").map((line) => {
    if (!comment) {
      const before = fence;
      fence = fenceAfter(before, line);
      if (before !== undefined || fence !== undefined) return "";
    }
    const seen = outsideComments(line, comment);
    comment = seen.open;
    return seen.text;
  });
}

/** The cells of a table row: split on unescaped pipes, outer pipes dropped. */
function cells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]?.trim() === "") parts.pop();
  return parts.map((c) => c.replaceAll("\\|", "|").trim());
}

const isSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) &&
  line.includes("-");

const CODE_SPAN = /(`+)(.+?)\1(?!`)/g;

/** The inline code spans of `text`, without their backticks. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(CODE_SPAN)].map((m) => (m[2] ?? "").trim());
}

/** A link reference definition, `[label]: target`, which renders as nothing. */
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?/;

const label = (text: string): string =>
  text.trim().replaceAll(/\s+/g, " ").toLowerCase();

/** The link reference definitions of `lines`, by their normalized label. */
export function linkDefinitions(lines: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of lines) {
    const m = DEFINITION.exec(line);
    if (m && !found.has(label(m[1] ?? "")))
      found.set(label(m[1] ?? ""), m[2] ?? "");
  }
  return found;
}

/**
 * The targets of the Markdown links in `text`: inline links, and reference
 * links whose label `definitions` defines. A link written inside a code span
 * renders as code, so it is not one.
 */
export function linkTargets(
  text: string,
  definitions: Map<string, string> = new Map(),
): string[] {
  const prose = text
    .replaceAll(CODE_SPAN, " ")
    .split("\n")
    .filter((line) => !DEFINITION.test(line))
    .join("\n");
  const targets: string[] = [];
  for (const m of prose.matchAll(
    /\[([^\]]*)\](?:\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]*)\])?/g,
  )) {
    if (m[2] !== undefined) targets.push(m[2]);
    else {
      const target = definitions.get(label(m[3] || (m[1] ?? "")));
      if (target !== undefined) targets.push(target);
    }
  }
  return targets;
}

/** A Markdown table: its header cells, and each body row's cells with the line it is on. */
interface Table {
  header: string[];
  rows: { line: number; cells: string[] }[];
}

/** The tables of `text` a reader sees: none inside a fenced block or an HTML comment. */
function tables(text: string): Table[] {
  const lines = visibleLines(text);
  const isRow = (at: number) => (lines[at] ?? "").trim().startsWith("|");
  const found: Table[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(i) || !isSeparator(lines[i + 1] ?? "")) continue;
    const table: Table = { header: cells(lines[i] ?? ""), rows: [] };
    let j = i + 2;
    for (; isRow(j); j++)
      table.rows.push({ line: j + 1, cells: cells(lines[j] ?? "") });
    found.push(table);
    i = j - 1;
  }
  return found;
}

const columnOf = (table: Table, name: string): number =>
  table.header.findIndex((c) => c.toLowerCase() === name);

/** The stages of every table whose header has `Stage`, `Owner` and `Hands on` columns. */
export function parseStages(text: string): Stage[] {
  return tables(text).flatMap((table) => {
    const [stage, owner, handsOn] = ["stage", "owner", "hands on"].map((n) =>
      columnOf(table, n),
    );
    if (stage === undefined || owner === undefined || handsOn === undefined)
      return [];
    if (stage < 0 || owner < 0 || handsOn < 0) return [];
    return table.rows.map((row) => ({
      line: row.line,
      stage: row.cells[stage] ?? "",
      owner: row.cells[owner] ?? "",
      handsOn: row.cells[handsOn] ?? "",
    }));
  });
}

/** The code spans in the `Skill` column of every table that has one (the skills outside the loop). */
function skillTableSpans(text: string): { line: number; span: string }[] {
  return tables(text).flatMap((table) => {
    const skill = columnOf(table, "skill");
    if (skill < 0) return [];
    return table.rows.flatMap((row) =>
      codeSpans(row.cells[skill] ?? "").map((span) => ({
        line: row.line,
        span,
      })),
    );
  });
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/**
 * The skills directly under `dir`: a directory holding a SKILL.md file, or a
 * command file. A link is followed, so a linked skill directory counts.
 */
export function skillNames(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const entry = statSync(path, { throwIfNoEntry: false });
      if (entry?.isDirectory())
        return isFile(join(path, "SKILL.md")) ? [name] : [];
      return entry?.isFile() && name.endsWith(".md") ? [name.slice(0, -3)] : [];
    })
    .sort();
}

const SKILL_SPAN =
  /^\/([a-z0-9][a-z0-9_-]*)(?::([a-z0-9][a-z0-9_-]*))?(?=\s|$)/;
const RUN_SPAN = /^(bun|npm|pnpm|yarn)\s+run\s+(\S+)/;
const FILE_WORD = /\/|\.[a-z0-9]+$/i;

/** A skill reference in a span: the namespace ("" for none) and the name. */
export function skillRef(
  span: string,
): { namespace: string; name: string } | undefined {
  const m = SKILL_SPAN.exec(span);
  if (!m) return undefined;
  return m[2] === undefined
    ? { namespace: "", name: m[1] ?? "" }
    : { namespace: m[1] ?? "", name: m[2] };
}

function skillResolves(
  skills: SkillDir[],
  namespace: string,
  name: string,
): boolean {
  return skills.some(
    (s) =>
      s.namespace === namespace &&
      (isFile(join(s.dir, name, "SKILL.md")) ||
        isFile(join(s.dir, `${name}.md`))),
  );
}

/** The package file's scripts that run something: a name with a command that is a string with text in it. */
function readPackageScripts(
  path: string,
  required: boolean,
): Set<string> | undefined {
  if (!existsSync(path)) {
    if (required) throw new MapInputError(`cannot read --package-json ${path}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(path, "--package-json"));
  } catch (error) {
    if (error instanceof MapInputError) throw error;
    throw new MapInputError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scripts = isRecord(parsed) ? parsed.scripts : undefined;
  if (scripts === undefined) return new Set();
  if (!isRecord(scripts))
    throw new MapInputError(`${path}: "scripts" is not an object`);
  return new Set(
    Object.entries(scripts)
      .filter(
        ([, command]) => typeof command === "string" && command.trim() !== "",
      )
      .map(([name]) => name),
  );
}

const invocation = (namespace: string, name: string): string =>
  namespace ? `/${namespace}:${name}` : `/${name}`;

/** Why a skill reference does not resolve, or undefined when it does. */
function skillProblem(
  skill: { namespace: string; name: string },
  skills: SkillDir[],
): string | undefined {
  if (skillResolves(skills, skill.namespace, skill.name)) return undefined;
  const invoked = invocation(skill.namespace, skill.name);
  if (skills.some((s) => s.namespace === skill.namespace))
    return `${invoked} is not a skill or command under the --skills directories`;
  const served = skill.namespace
    ? `the namespace "${skill.namespace}"`
    : "a skill with no namespace";
  return `${invoked} names ${served}, which no --skills directory serves`;
}

/** Why a `<pm> run <target>` span does not resolve, or undefined when it does. */
function runProblem(
  run: RegExpExecArray,
  root: string,
  scripts: Set<string> | undefined,
): string | undefined {
  const target = run[2] ?? "";
  if (scripts?.has(target)) return undefined;
  // `bun run` also runs a file; the other package managers run only scripts.
  if (
    run[1] === "bun" &&
    FILE_WORD.test(target) &&
    isFile(resolve(root, target))
  )
    return undefined;
  return scripts
    ? `${run[1]} run ${target} is not a script in the package file`
    : `${run[1]} run ${target} needs a package.json, and none was read`;
}

/** Why a path-like span (a file, or `bun <file>`) does not resolve, or undefined when it does. */
function pathProblem(span: string, root: string): string | undefined {
  const words = span.split(/\s+/);
  const first = words[0] ?? "";
  const path = first === "bun" ? (words[1] ?? "") : first;
  if (!FILE_WORD.test(path) || path.startsWith("-"))
    return `\`${span}\` is not a skill, a package script, an existing file or a declared --external command`;
  return isFile(resolve(root, path))
    ? undefined
    : `${path} is not a file under the root`;
}

/** Why one command or skill reference does not resolve, or undefined when it does. */
function segmentProblem(
  span: string,
  opts: MapOptions,
  scripts: Set<string> | undefined,
): string | undefined {
  const skill = skillRef(span);
  if (skill) return skillProblem(skill, opts.skills);
  const run = RUN_SPAN.exec(span);
  if (run) return runProblem(run, opts.root, scripts);
  if (opts.external.some((e) => span === e || span.startsWith(`${e} `)))
    return undefined;
  return pathProblem(span, opts.root);
}

/**
 * The commands of a chain: `a && b`, `a || b`, `a; b` and `a | b` split into
 * their commands, an operator inside quotes staying part of its argument.
 */
export function commandSegments(span: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let at = 0; at < span.length; at++) {
    const c = span[at] ?? "";
    if (quote !== undefined || c === "'" || c === '"') {
      if (quote === undefined) quote = c;
      else if (c === quote) quote = undefined;
      current += c;
      continue;
    }
    const operator = /^(?:&&|\|\||;|\|)/.exec(span.slice(at))?.[0];
    if (operator === undefined) {
      current += c;
      continue;
    }
    segments.push(current.trim());
    current = "";
    at += operator.length - 1;
  }
  segments.push(current.trim());
  return segments;
}

/** The skills a span names, one per command of a chain. */
function skillRefs(span: string): { namespace: string; name: string }[] {
  return commandSegments(span).flatMap((segment) => skillRef(segment) ?? []);
}

/** Why `span` does not resolve, or undefined when it does; `a && b` and `a; b` are each resolved. */
function unresolved(
  span: string,
  opts: MapOptions,
  scripts: Set<string> | undefined,
): string | undefined {
  for (const segment of commandSegments(span)) {
    const why = segmentProblem(segment, opts, scripts);
    if (why !== undefined) return why;
  }
  return undefined;
}

function readText(path: string, what: string): string {
  try {
    return readRegularFile(path);
  } catch (error) {
    throw new MapInputError(
      `cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The file a link target names, or undefined for a web address or an anchor in the same page. */
function linkedFile(
  target: string,
  from: string,
  root: string,
): string | undefined {
  if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return undefined;
  const path = target.split("#")[0] ?? "";
  if (path === "") return undefined;
  return path.startsWith("/")
    ? resolve(root, `.${path}`)
    : resolve(dirname(from), path);
}

/** A template placeholder: a whole `<...>`, or a skill name written as `/<...>`. */
const isPlaceholder = (span: string): boolean =>
  /^<[^>]*>$/.test(span) || /^\/<[^>]*>/.test(span);

/** Text in angle brackets that is neither an HTML tag Markdown prose uses nor an autolink. */
const PLACEHOLDER_IN_PROSE =
  /<(?!\/|!--|https?:|(?:a|abbr|b|br|code|del|em|i|img|ins|kbd|mark|p|q|s|small|span|strong|sub|sup|u)\b)[^>]*>/i;

/** The findings one check adds, each anchored to a file and, for a stage, its line. */
type Add = (finding: Omit<Finding, "file">, file?: string) => void;

const posix = (path: string): string => path.replaceAll("\\", "/");

/** Why a stage's name is wrong, or undefined when it is a name nobody else has. */
function nameProblem(
  name: string,
): { problem: string; remedy: string; rule?: string } | undefined {
  if (name === "")
    return {
      problem: "a stage has no name",
      remedy: "name the stage in the first column",
    };
  if (
    /^(stage|step|phase)?\s*#?\d+\s*([.):-]|\s|$)/i.test(
      name.replaceAll(/[*_`]/g, ""),
    )
  )
    return {
      problem: `stage "${name}" is numbered`,
      remedy:
        "name stages, never number them: a number is wrong the day a stage is added",
    };
  if (PLACEHOLDER_IN_PROSE.test(name.replaceAll("`", "")))
    return {
      rule: "placeholder",
      problem: `stage "${name}" is still a placeholder`,
      remedy: "name the stage, or drop it if the repository has none",
    };
  return undefined;
}

/** A stage's name: present, not a number, not a placeholder, and not another stage's. */
function checkName(s: Stage, seen: Map<string, number>, add: Add): void {
  const at = { line: s.line, rule: "stage-name" };
  const wrong = nameProblem(s.stage);
  if (wrong) return void add({ ...at, ...wrong });
  const key = s.stage.toLowerCase();
  const first = seen.get(key);
  if (first === undefined) seen.set(key, s.line);
  else
    add({
      ...at,
      problem: `stage "${s.stage}" is also on line ${first}`,
      remedy: "give each stage its own name",
    });
}

/** An owner or a handoff cell: present, and no unfilled template placeholder. */
function checkCell(
  s: Stage,
  column: "Owner" | "Hands on",
  value: string,
  add: Add,
): void {
  const at = { line: s.line };
  if (value === "")
    return void add({
      ...at,
      rule: column === "Owner" ? "owner-missing" : "handoff-missing",
      problem: `stage "${s.stage}" has no ${column.toLowerCase()}`,
      remedy:
        column === "Owner"
          ? "name the skill, command or document that runs the stage"
          : "name the artifact the next stage picks up",
    });
  // An owner's command may take an argument written as `<PR>`; a whole span
  // that is a placeholder is still one. A handoff has no arguments, so a
  // placeholder anywhere in it counts.
  const prose =
    column === "Owner"
      ? value.replace(/(`+)(.+?)\1/g, (_w, _t, inner: string) =>
          isPlaceholder(inner.trim()) ? "<>" : "",
        )
      : value.replaceAll("`", "");
  if (PLACEHOLDER_IN_PROSE.test(prose))
    add({
      ...at,
      rule: "placeholder",
      problem: `stage "${s.stage}" still has a placeholder in ${column}`,
      remedy: "fill it in, or drop the stage if the repository has none",
    });
}

/** What an owner names: each code span must resolve, each link to a file must reach it, and something must be named. */
function checkOwner(
  s: Stage,
  opts: MapOptions,
  scripts: Set<string> | undefined,
  definitions: Map<string, string>,
  add: Add,
): number {
  const spans = codeSpans(s.owner);
  const files = linkTargets(s.owner, definitions)
    .map((target) => ({
      target,
      file: linkedFile(target, opts.map, opts.root),
    }))
    .filter((link) => link.file !== undefined);
  const at = { line: s.line, rule: "owner-unresolved" };
  if (s.owner !== "" && spans.length + files.length === 0)
    add({
      line: s.line,
      rule: "owner-missing",
      problem: `stage "${s.stage}" names its owner in words only, or by a web address no check can resolve`,
      remedy:
        "put the skill or command in a code span, or link the document in the repository that owns the stage, so it can be resolved",
    });
  let resolved = 0;
  for (const span of spans.filter((span) => !isPlaceholder(span))) {
    const why = unresolved(span, opts, scripts);
    if (why === undefined) resolved++;
    else
      add({
        ...at,
        problem: `stage "${s.stage}": ${why}`,
        remedy:
          "fix the name, add the missing skill or script, or remove the stage's claim on it",
      });
  }
  for (const { target, file } of files) {
    if (file !== undefined && existsSync(file)) resolved++;
    else
      add({
        ...at,
        problem: `stage "${s.stage}": the link ${target} reaches no file`,
        remedy: "fix the link or the document's name",
      });
  }
  return resolved;
}

/** The skills named in the `Skill` column of the table of skills outside the loop must exist too. */
function checkSkillTable(
  mapText: string,
  opts: MapOptions,
  scripts: Set<string> | undefined,
  add: Add,
): void {
  for (const { line, span } of skillTableSpans(mapText)) {
    if (isPlaceholder(span)) {
      add({
        line,
        rule: "placeholder",
        problem: `skills outside the loop: \`${span}\` is still a placeholder`,
        remedy: "name the skill, or drop the row",
      });
      continue;
    }
    const why = unresolved(span, opts, scripts);
    if (why !== undefined)
      add({
        line,
        rule: "owner-unresolved",
        problem: `skills outside the loop: ${why}`,
        remedy: "fix the name, or drop the row if the skill is gone",
      });
  }
}

/** With `--cover`: every skill under each directory owns a stage or is in the table of skills outside the loop. */
function checkCover(mapText: string, opts: MapOptions, add: Add): void {
  const named = [
    ...parseStages(mapText).flatMap((s) => codeSpans(s.owner)),
    ...skillTableSpans(mapText).map((s) => s.span),
  ].flatMap(skillRefs);
  for (const dir of opts.cover) {
    const namespace =
      opts.skills.find((s) => resolve(s.dir) === resolve(dir))?.namespace ?? "";
    let names: string[];
    try {
      names = skillNames(dir);
    } catch (error) {
      throw new MapInputError(
        `cannot list --cover ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const name of names) {
      const mentioned = named.some(
        (ref) => ref.name === name && ref.namespace === namespace,
      );
      if (!mentioned)
        add({
          rule: "skill-not-in-map",
          problem: `${invocation(namespace, name)} exists under ${posix(relative(opts.root, dir)) || dir} and the map never names it`,
          remedy:
            "make it the owner of a stage, or list it in the map's table of skills outside the loop",
        });
    }
  }
}

/** With `--scan`: a document names only skills that exist, in the namespaces served. */
function checkScan(opts: MapOptions, add: Add): void {
  const namespaces = new Set(opts.skills.map((s) => s.namespace));
  for (const file of opts.scan) {
    const rel = posix(relative(opts.root, file));
    visibleLines(readText(file, "--scan file")).forEach((line, index) => {
      for (const ref of codeSpans(line).flatMap(skillRefs)) {
        if (ref.namespace === "" || !namespaces.has(ref.namespace)) continue;
        if (!skillResolves(opts.skills, ref.namespace, ref.name))
          add(
            {
              line: index + 1,
              rule: "skill-unresolved",
              problem: `${invocation(ref.namespace, ref.name)} is not a skill under the --skills directories`,
              remedy:
                "fix the name, or remove the mention if the skill is gone",
            },
            rel,
          );
      }
    });
  }
}

/** With `--linked-from`: the always-loaded file links the map, one hop away. */
function checkLinked(
  mapFile: string,
  linkedFrom: string,
  opts: MapOptions,
  add: Add,
): void {
  const visible = visibleLines(readText(linkedFrom, "--linked-from file"));
  const linked = linkTargets(visible.join("\n"), linkDefinitions(visible)).some(
    (t) => linkedFile(t, linkedFrom, opts.root) === resolve(opts.map),
  );
  if (!linked)
    add(
      {
        rule: "map-not-linked",
        problem: `${mapFile} is not linked from this always-loaded file, so a session does not find the map in one hop`,
        remedy: `link ${mapFile} with a Markdown link where the file says what to read next`,
      },
      posix(relative(opts.root, linkedFrom)),
    );
}

/** Check the map; the findings, and how many owner references were resolved. */
export function checkMap(opts: MapOptions): {
  findings: Finding[];
  stages: number;
  resolved: number;
} {
  const mapText = readText(opts.map, "the map");
  const mapFile = posix(relative(opts.root, opts.map));
  const findings: Finding[] = [];
  const add: Add = (f, file = mapFile) => findings.push({ ...f, file });
  const stages = parseStages(mapText);
  if (stages.length === 0)
    add({
      rule: "stage-table",
      problem:
        "no table with the columns Stage, Owner and Hands on, so there is no stage map to check",
      remedy:
        "write the loop as one table, one row per stage (templates/LIFECYCLE.md)",
    });

  const scripts = readPackageScripts(
    opts.packageJson ?? join(opts.root, "package.json"),
    opts.packageJson !== undefined,
  );
  const definitions = linkDefinitions(visibleLines(mapText));
  const seen = new Map<string, number>();
  let resolved = 0;
  for (const s of stages) {
    checkName(s, seen, add);
    checkCell(s, "Owner", s.owner, add);
    checkCell(s, "Hands on", s.handsOn, add);
    resolved += checkOwner(s, opts, scripts, definitions, add);
  }
  checkSkillTable(mapText, opts, scripts, add);
  checkCover(mapText, opts, add);
  checkScan(opts, add);
  if (opts.linkedFrom !== undefined)
    checkLinked(mapFile, opts.linkedFrom, opts, add);
  return { findings, stages: stages.length, resolved };
}

/** Check the map and report: the exit code (0 clean, 1 violations, 2 could not check). */
export function runMap(opts: MapOptions, label = opts.map): number {
  try {
    const { findings, stages, resolved } = checkMap(opts);
    if (findings.length > 0) {
      reportFindings(findings);
      return 1;
    }
    console.log(
      `${label}: ${stages} stages, ${resolved} owner references resolve`,
    );
    return 0;
  } catch (error) {
    if (error instanceof MapInputError)
      return couldNotCheck(GATE, error.message);
    throw error;
  }
}

function skillDir(value: string): SkillDir {
  const at = value.indexOf("=");
  return at < 0
    ? { namespace: "", dir: value }
    : { namespace: value.slice(0, at), dir: value.slice(at + 1) };
}

export function main(args = process.argv.slice(2)): number {
  const { values, positionals } = strictOptions(
    {
      args,
      options: {
        root: { type: "string" },
        skills: { type: "string", multiple: true },
        "package-json": { type: "string" },
        external: { type: "string", multiple: true },
        cover: { type: "string", multiple: true },
        scan: { type: "string", multiple: true },
        "linked-from": { type: "string" },
      },
      allowPositionals: true,
    },
    usage,
  );
  const [map, ...extra] = positionals;
  if (map === undefined || extra.length > 0)
    throw new MapInputError(`one map file is required\n${usage}`);
  return runMap(
    {
      map: resolve(map),
      root: resolve(values.root ?? "."),
      skills: (values.skills ?? []).map(skillDir).map((s) => ({
        ...s,
        dir: resolve(s.dir),
      })),
      packageJson: values["package-json"],
      external: values.external ?? [],
      cover: (values.cover ?? []).map((d) => resolve(d)),
      scan: (values.scan ?? []).map((f) => resolve(f)),
      linkedFrom:
        values["linked-from"] === undefined
          ? undefined
          : resolve(values["linked-from"]),
    },
    map,
  );
}

if (import.meta.main) cli(() => main());
