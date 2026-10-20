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
//     and neither is an unfilled `<placeholder>`;
//   * every code span in an owner resolves: `/name` or `/namespace:name` to a
//     skill directory (`<dir>/<name>/SKILL.md`) or a command file
//     (`<dir>/<name>.md`) under a `--skills` directory; `<pm> run <script>` to a
//     package.json script; a path, or `bun <path>`, to a file that exists;
//     anything else to a tool declared with `--external`;
//   * every relative link in an owner reaches a file that exists;
//   * with `--cover <dir>`, every skill under the directory is named somewhere
//     in the map (in a stage, or in the table of skills outside the loop), so
//     a skill that exists but no stage reaches is found here;
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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import {
  type Finding,
  couldNotCheck,
  reportFindings,
} from "../../../../lib/findings.ts";

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

/** Lines of `text` with the fenced code blocks blanked, so line numbers hold. */
function outsideFences(text: string): string[] {
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = marker;
      return marker !== undefined ? "" : line;
    }
    if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    )
      fence = undefined;
    return "";
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

/** The inline code spans of `text`, without their backticks. */
export function codeSpans(text: string): string[] {
  return [...text.matchAll(/(`+)(.+?)\1(?!`)/g)].map((m) =>
    (m[2] ?? "").trim(),
  );
}

/** The targets of the Markdown links in `text`. */
export function linkTargets(text: string): string[] {
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
    (m) => m[1] ?? "",
  );
}

interface Columns {
  stage: number;
  owner: number;
  handsOn: number;
}

/** The index of each stage-map column in a table header, or undefined when one is missing. */
function stageColumns(header: string): Columns | undefined {
  const names = cells(header).map((c) => c.toLowerCase());
  const columns = {
    stage: names.indexOf("stage"),
    owner: names.indexOf("owner"),
    handsOn: names.indexOf("hands on"),
  };
  return Object.values(columns).every((i) => i >= 0) ? columns : undefined;
}

/** The stages of every table whose header has `Stage`, `Owner` and `Hands on` columns. */
export function parseStages(text: string): Stage[] {
  const lines = outsideFences(text);
  const isRow = (at: number) => (lines[at] ?? "").trim().startsWith("|");
  const stages: Stage[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(i) || !isSeparator(lines[i + 1] ?? "")) continue;
    const columns = stageColumns(lines[i] ?? "");
    let j = i + 2;
    for (; isRow(j); j++) {
      if (!columns) continue;
      const row = cells(lines[j] ?? "");
      stages.push({
        line: j + 1,
        stage: row[columns.stage] ?? "",
        owner: row[columns.owner] ?? "",
        handsOn: row[columns.handsOn] ?? "",
      });
    }
    i = j - 1;
  }
  return stages;
}

/** The skills (directories with a SKILL.md, or command files) directly under `dir`. */
export function skillNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) =>
      e.isDirectory()
        ? existsSync(join(dir, e.name, "SKILL.md"))
        : e.name.endsWith(".md"),
    )
    .map((e) => (e.isDirectory() ? e.name : e.name.slice(0, -3)))
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
      (existsSync(join(s.dir, name, "SKILL.md")) ||
        existsSync(join(s.dir, `${name}.md`))),
  );
}

function readPackageScripts(path: string): Set<string> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MapInputError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scripts =
    typeof parsed === "object" && parsed !== null && "scripts" in parsed
      ? parsed.scripts
      : undefined;
  return new Set(
    typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [],
  );
}

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;

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
  if (FILE_WORD.test(target) && isFile(resolve(root, target))) return undefined;
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

/** Why `span` does not resolve, or undefined when it does. */
function unresolved(
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

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new MapInputError(
      `cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRelativeTarget(target: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
}

const isPlaceholder = (span: string): boolean => /^<[^>]*>$/.test(span);

/** The findings one check adds, each anchored to a file and, for a stage, its line. */
type Add = (finding: Omit<Finding, "file">, file?: string) => void;

const posix = (path: string): string => path.replaceAll("\\", "/");

/** Why a stage's name is wrong, or undefined when it is a name nobody else has. */
function nameProblem(
  name: string,
): { problem: string; remedy: string } | undefined {
  if (name === "")
    return {
      problem: "a stage has no name",
      remedy: "name the stage in the first column",
    };
  if (/^(stage\s*)?\d+\s*[.):-]?(\s|$)/i.test(name))
    return {
      problem: `stage "${name}" is numbered`,
      remedy:
        "name stages, never number them: a number is wrong the day a stage is added",
    };
  return undefined;
}

/** A stage's name: present, not a number, and not another stage's. */
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
  const prose = value.replace(/(`+)(.+?)\1/g, (_w, _t, inner: string) =>
    isPlaceholder(inner.trim()) ? "<>" : "",
  );
  if (/<[^>]*>/.test(prose))
    add({
      ...at,
      rule: "placeholder",
      problem: `stage "${s.stage}" still has a placeholder in ${column}`,
      remedy: "fill it in, or drop the stage if the repository has none",
    });
}

/** What an owner names: each code span must resolve, each relative link must reach a file. */
function checkOwner(
  s: Stage,
  opts: MapOptions,
  scripts: Set<string> | undefined,
  add: Add,
): number {
  const spans = codeSpans(s.owner).filter((span) => !isPlaceholder(span));
  const links = linkTargets(s.owner);
  const at = { line: s.line, rule: "owner-unresolved" };
  if (s.owner !== "" && codeSpans(s.owner).length + links.length === 0)
    add({
      line: s.line,
      rule: "owner-missing",
      problem: `stage "${s.stage}" names its owner in words only`,
      remedy:
        "put the skill or command in a code span, or link the document that owns the stage, so it can be resolved",
    });
  let resolved = 0;
  for (const span of spans) {
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
  for (const target of links.filter(isRelativeTarget)) {
    const path = target.split("#")[0] ?? "";
    if (path === "") continue;
    if (existsSync(resolve(dirname(opts.map), path))) resolved++;
    else
      add({
        ...at,
        problem: `stage "${s.stage}": the link ${target} reaches no file`,
        remedy: "fix the link or the document's name",
      });
  }
  return resolved;
}

/** With `--cover`: every skill under each directory is named somewhere in the map. */
function checkCover(mapText: string, opts: MapOptions, add: Add): void {
  const named = outsideFences(mapText).flatMap((l) => codeSpans(l));
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
      const mentioned = named.some((span) => {
        const ref = skillRef(span);
        return ref?.name === name && ref.namespace === namespace;
      });
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
    outsideFences(readText(file, "--scan file")).forEach((line, index) => {
      for (const span of codeSpans(line)) {
        const ref = skillRef(span);
        if (!ref || ref.namespace === "" || !namespaces.has(ref.namespace))
          continue;
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
  const from = readText(linkedFrom, "--linked-from file");
  const linked = linkTargets(from).some(
    (t) =>
      isRelativeTarget(t) &&
      resolve(dirname(linkedFrom), t.split("#")[0] ?? "") === resolve(opts.map),
  );
  if (!linked)
    add(
      {
        rule: "map-not-linked",
        problem: `${mapFile} is not linked from this always-loaded file, so a session does not find the map in one hop`,
        remedy: `link ${mapFile} where the file says what to read next`,
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
  );
  const seen = new Map<string, number>();
  let resolved = 0;
  for (const s of stages) {
    checkName(s, seen, add);
    checkCell(s, "Owner", s.owner, add);
    checkCell(s, "Hands on", s.handsOn, add);
    resolved += checkOwner(s, opts, scripts, add);
  }
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
