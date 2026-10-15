#!/usr/bin/env bun
// Skill and agent discovery metadata stays inside its per-item and aggregate
// budgets.
//
// A runtime lists every model-invocable skill's name and description in each
// session, before any skill runs, so that text is always-loaded context. The
// budgets, each overridable:
//
//   --hard 1024       a description's ceiling in the agent-skills
//                     specification, in Unicode code points. Over it fails.
//   --soft 512        past this, trigger accuracy stops improving while the
//                     cost per session keeps rising. Over it is reported;
//                     --fail-soft makes it fail.
//   --combined 1536   Claude Code caps description + " - " + when_to_use per
//                     entry. Over it fails.
//   --listing 8000    Claude Code's aggregate skill listing: about 1% of a
//                     200,000-token context window at 4 characters a token.
//                     Over it fails.
//
// The listing cost of a skill is what Claude Code prints for it, counted in
// UTF-16 code units as its calculator counts: "- " + name + ": " +
// description (+ " - " + when_to_use), with a newline between entries. A
// skill with `disable-model-invocation: true` is not listed and costs
// nothing there, though its own description is still capped. A skill with
// `paths:` is counted as listed: it joins the listing once a matching file is
// read, so a listing measured without it turns red mid-session.
//
// Agent files (`<dir>/*.md`, README.md excepted) get the same per-item caps,
// since their descriptions are discovery text paid in every session too. No
// runtime documents an aggregate allowance for agents, so their total is
// reported and not gated.
//
// Frontmatter is parsed as YAML with Bun's built-in parser, so folded and
// literal block descriptions are measured by their value, and so the check
// runs before dependencies are installed. Each physical file is measured
// once, however many symbolic links reach it, and a definition that is not
// a regular file (a link to nothing, a FIFO, a link to a device) fails as
// unreadable without being read. An independent recursive census of
// each skills directory must find no SKILL.md the measurement did not reach,
// so a skipped skill fails instead of shrinking the aggregate; the same
// census of each agents directory fails any nested agent file, README.md
// excepted, that only the top level was searched for.
//
// Scope: the directories named. Not measured: skills a person or another
// plugin adds, the runtime's own built-in entries, and MCP server
// instructions, none of which a repository file shows.
//
// Usage: bun check-discovery-budget.ts [--skills <dir>]... [--agents <dir>]...
//          [--bare-skills <dir>]... [--namespace <plugin>] [--hard N]
//          [--soft N] [--combined N] [--listing N] [--fail-soft]
//   --namespace    the plugin name a runtime prefixes to each --skills name
//                  (`<plugin>:<skill>`), counted in the listing
//   --bare-skills  skills listed by their bare name in the same session as
//                  the --skills ones (a repository's own skills beside an
//                  installed plugin's), so both count in one listing
// Exit: 0 within budget (an agents directory with no agent is noted); 1 over
// a budget, unusable frontmatter, an unreadable definition, a file the
// census found but the measurement missed, a duplicate skill name, or a
// skills directory with no skill; 2 usage error or an unreadable directory.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile } from "../../../../lib/files.ts";

type Budgets = {
  hard: number;
  soft: number;
  combined: number;
  listing: number;
  failSoft: boolean;
};

type Item = {
  kind: "skill" | "agent";
  label: string;
  /** The name as listed, with its plugin namespace when it has one. */
  name: string;
  /** Description length in Unicode code points. */
  length: number;
  /** Description (+ " - " + when_to_use) length in UTF-16 code units. */
  combined: number;
  /** Listing cost in UTF-16 code units; 0 when not listed. */
  listing: number;
  scoped: boolean;
};

type Found = { label: string; file: string; fallbackName: string };

const USAGE =
  "usage: check-discovery-budget.ts [--skills <dir>]... [--agents <dir>]... [--bare-skills <dir>]... [--namespace <plugin>] [--hard N] [--soft N] [--combined N] [--listing N] [--fail-soft]";

function frontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("no YAML frontmatter block");
  const parsed: unknown = Bun.YAML.parse(match[1] ?? "");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("frontmatter is not a mapping");
  return parsed as Record<string, unknown>;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validPaths(paths: unknown): boolean {
  if (paths === undefined || isNonEmpty(paths)) return true;
  return Array.isArray(paths) && paths.length > 0 && paths.every(isNonEmpty);
}

type Metadata = {
  name: string;
  description: string;
  whenToUse: string | undefined;
  listed: boolean;
  scoped: boolean;
};

/** The fields a runtime lists; throws a message naming an unusable one. */
function metadata(fields: Record<string, unknown>, fallback: string): Metadata {
  const name = fields.name ?? fallback;
  const { description, when_to_use: whenToUse, paths } = fields;
  const explicitOnly = fields["disable-model-invocation"];
  const problems: [boolean, string][] = [
    [!isNonEmpty(description), "no non-empty description"],
    [!isNonEmpty(name), "name must be a non-empty string"],
    [
      whenToUse !== undefined && typeof whenToUse !== "string",
      "when_to_use must be a string",
    ],
    [
      explicitOnly !== undefined && typeof explicitOnly !== "boolean",
      "disable-model-invocation must be true or false",
    ],
    [!validPaths(paths), "paths must be a non-empty glob or list of globs"],
  ];
  const problem = problems.find(([failed]) => failed);
  if (problem) throw new Error(problem[1]);
  return {
    name: name as string,
    description: description as string,
    whenToUse: whenToUse as string | undefined,
    listed: explicitOnly !== true,
    scoped: paths !== undefined,
  };
}

function readDefinition(file: string): string {
  try {
    return readRegularFile(file);
  } catch (error) {
    throw new Error(`unreadable (${(error as Error).message})`);
  }
}

/** Measure one file; throws a message naming what makes it unusable. */
function measure(
  kind: Item["kind"],
  found: Found,
  namespace: string | undefined,
): Item {
  const fields = frontmatter(readDefinition(found.file));
  const meta = metadata(fields, found.fallbackName);
  const text = meta.whenToUse
    ? `${meta.description} - ${meta.whenToUse}`
    : meta.description;
  const listedName = namespace ? `${namespace}:${meta.name}` : meta.name;
  return {
    kind,
    label: found.label,
    name: listedName,
    length: [...meta.description].length,
    combined: text.length,
    listing: meta.listed ? listedName.length + 4 + text.length : 0,
    scoped: meta.scoped,
  };
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * A definition candidate: any entry at the path except a directory. A link
 * that resolves to nothing or an entry that is not a regular file is a
 * candidate, so it is reported as unreadable instead of passed over as
 * absent; the measurement checks the kind before it reads.
 */
function isCandidate(path: string): boolean {
  return (
    lstatSync(path, { throwIfNoEntry: false }) !== undefined &&
    !isDirectory(path)
  );
}

/** The physical file a candidate reaches; undefined for a broken link. */
function physicalPath(path: string): string | undefined {
  return statSync(path, { throwIfNoEntry: false }) && realpathSync(path);
}

function listDirectory(dir: string): string[] {
  if (!isDirectory(dir)) throw new Error(`not a readable directory: ${dir}`);
  return readdirSync(dir).sort();
}

const isSkillFile = (name: string) => name.toLowerCase() === "skill.md";
const isAgentFile = (name: string) =>
  /\.md$/i.test(name) && !/^readme\.md$/i.test(name);

/** `<dir>/<skill>/SKILL.md`, following links to skill directories. */
function skillFiles(dir: string): Found[] {
  return listDirectory(dir)
    .filter((entry) => isDirectory(join(dir, entry)))
    .map((entry) => ({
      label: join(dir, entry, "SKILL.md"),
      file: join(dir, entry, "SKILL.md"),
      fallbackName: entry,
    }))
    .filter((found) => isCandidate(found.file));
}

/** `<dir>/*.md` agent definitions; a README documents the folder. */
function agentFiles(dir: string): Found[] {
  return listDirectory(dir)
    .filter(isAgentFile)
    .map((entry) => ({
      label: join(dir, entry),
      file: join(dir, entry),
      fallbackName: entry.replace(/\.md$/i, ""),
    }))
    .filter((found) => isCandidate(found.file));
}

/** Every matching entry under the directory, found without the loops above. */
function census(dir: string, matches: (name: string) => boolean): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => matches(basename(rel)))
    .map((rel) => join(dir, rel))
    .filter(isCandidate);
}

class Corpus {
  readonly items: Item[] = [];
  readonly errors: string[] = [];
  private readonly seen = new Set<string>();

  add(kind: Item["kind"], dir: string, found: Found[], namespace?: string) {
    for (const entry of found) {
      const physical = physicalPath(entry.file);
      if (physical === undefined) {
        this.seen.add(entry.file);
        this.errors.push(`${entry.label}: unreadable (a link to nothing)`);
        continue;
      }
      if (this.seen.has(physical)) continue;
      this.seen.add(physical);
      try {
        this.items.push(measure(kind, entry, namespace));
      } catch (error) {
        this.errors.push(`${entry.label}: ${(error as Error).message}`);
      }
    }
    // A skills folder with nothing in it is a wrong path; an agents folder
    // may legitimately be empty.
    if (found.length) return;
    if (kind === "skill") this.errors.push(`${dir}: no skill to measure`);
    else console.log(`  note ${dir}: no agent to measure`);
  }

  checkCensus(kind: Item["kind"], dir: string) {
    const [matches, shape] =
      kind === "skill"
        ? [isSkillFile, "<dir>/<skill>/SKILL.md"]
        : [isAgentFile, "<dir>/*.md"];
    for (const file of census(dir, matches))
      if (!this.seen.has(physicalPath(file) ?? file))
        this.errors.push(
          `${file}: ${kind} definition never reached by the measurement (only ${shape} is measured)`,
        );
  }

  checkDuplicates() {
    const names = new Set<string>();
    for (const item of this.items.filter((i) => i.kind === "skill")) {
      if (names.has(item.name))
        this.errors.push(`${item.label}: duplicate skill name ${item.name}`);
      names.add(item.name);
    }
  }
}

function budgetsFrom(
  values: Record<string, string | string[] | boolean | undefined>,
): Budgets {
  const read = (key: string, fallback: number): number => {
    const value = Number(values[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`--${key} must be a positive integer`);
    return value;
  };
  return {
    hard: read("hard", 1024),
    soft: read("soft", 512),
    combined: read("combined", 1536),
    listing: read("listing", 8000),
    failSoft: values["fail-soft"] === true,
  };
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      skills: { type: "string", multiple: true },
      "bare-skills": { type: "string", multiple: true },
      agents: { type: "string", multiple: true },
      namespace: { type: "string" },
      hard: { type: "string" },
      soft: { type: "string" },
      combined: { type: "string" },
      listing: { type: "string" },
      "fail-soft": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const skills = values.skills ?? [];
  const bareSkills = values["bare-skills"] ?? [];
  const agents = values.agents ?? [];
  if (
    positionals.length ||
    !(skills.length || bareSkills.length || agents.length)
  )
    throw new Error(USAGE);
  return {
    skills,
    bareSkills,
    agents,
    namespace: values.namespace,
    budgets: budgetsFrom(values),
  };
}

export function checkDiscoveryBudget(argv: string[]): number {
  const { skills, bareSkills, agents, namespace, budgets } = parse(argv);
  for (const dir of [...skills, ...bareSkills, ...agents]) listDirectory(dir);
  const corpus = new Corpus();
  for (const dir of skills)
    corpus.add("skill", dir, skillFiles(dir), namespace);
  for (const dir of bareSkills) corpus.add("skill", dir, skillFiles(dir));
  for (const dir of agents) corpus.add("agent", dir, agentFiles(dir));
  for (const dir of [...skills, ...bareSkills])
    corpus.checkCensus("skill", dir);
  for (const dir of agents) corpus.checkCensus("agent", dir);
  corpus.checkDuplicates();
  return report(corpus, budgets);
}

function listingCost(listed: Item[]): number {
  return (
    listed.reduce((sum, i) => sum + i.listing, 0) +
    Math.max(0, listed.length - 1)
  );
}

function summarize(items: Item[], budgets: Budgets): void {
  const skills = items.filter((i) => i.kind === "skill");
  const listed = skills.filter((i) => i.listing > 0);
  const scoped = listed.filter((i) => i.scoped).length;
  const agents = items.filter((i) => i.kind === "agent");
  const agentChars = agents.reduce((sum, i) => sum + i.combined, 0);
  console.log(
    `Discovery budget: ${skills.length} skill(s), ${listed.length} listed (${scoped} path-scoped), ${agents.length} agent(s)`,
  );
  console.log(
    `  skill listing ${listingCost(listed)} / ${budgets.listing} chars; agent descriptions ${agentChars} chars (reported, not gated)`,
  );
  const longest = [...items].sort((a, b) => b.length - a.length)[0];
  if (longest)
    console.log(
      `  longest description ${longest.length} chars (${longest.label}); hard ${budgets.hard}, soft ${budgets.soft}`,
    );
}

function listingFailures(items: Item[], budgets: Budgets): string[] {
  const listed = items.filter((i) => i.kind === "skill" && i.listing > 0);
  const cost = listingCost(listed);
  if (cost <= budgets.listing) return [];
  const largest = [...listed]
    .sort((a, b) => b.listing - a.listing)
    .slice(0, 5)
    .map((i) => `${i.name} ${i.listing}`);
  return [
    `skill listing is ${cost - budgets.listing} chars over ${budgets.listing}; largest entries: ${largest.join(", ")}`,
  ];
}

/** Hard and combined caps fail; the soft target fails only with --fail-soft. */
function itemFailures(item: Item, budgets: Budgets): string[] {
  const { label, length, combined } = item;
  const failures: string[] = [];
  if (length > budgets.hard)
    failures.push(
      `${label}: description ${length} chars, over the ${budgets.hard}-char hard limit`,
    );
  else if (length > budgets.soft) {
    const note = `${label}: description ${length} chars, over the ${budgets.soft}-char soft target`;
    if (budgets.failSoft) failures.push(note);
    else console.log(`  note ${note}`);
  }
  if (combined > budgets.combined)
    failures.push(
      `${label}: description + when_to_use ${combined} chars, over ${budgets.combined}`,
    );
  return failures;
}

function report(corpus: Corpus, budgets: Budgets): number {
  summarize(corpus.items, budgets);
  const failures = [
    ...corpus.errors,
    ...listingFailures(corpus.items, budgets),
    ...corpus.items.flatMap((item) => itemFailures(item, budgets)),
  ];
  for (const failure of failures) console.error(`FAIL ${failure}`);
  return failures.length ? 1 : 0;
}

if (import.meta.main) cli(() => checkDiscoveryBudget(process.argv.slice(2)));
