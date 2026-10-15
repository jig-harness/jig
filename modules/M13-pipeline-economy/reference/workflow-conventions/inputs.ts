// The workflow-convention lint's inputs: the parsed workflows and composite
// actions, the repository's own values (`ci.required_checks`, `ci.hold_label`
// and `drive.change_areas_catalog` in `.config/jig.yaml`), the lint's
// configuration (heavy suites and cache groups) and its exception list. Every
// reader throws `Unreadable` on input it cannot read or parse, so the lint
// fails closed (exit 2) instead of passing what it never saw.
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  type ChangeAreaCatalog,
  loadCatalogFile,
} from "../../../../plugin/skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { reasonedEntries, repoPath } from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import {
  actionFiles,
  type Listing,
  readYaml,
  workflowFiles,
  type YamlFile,
} from "../../../../lib/workflows.ts";

/** Input the lint cannot read or parse: the run could not check. */
export class Unreadable extends Error {}

type Map = Record<string, unknown>;

export interface Job {
  id: string;
  def: Map;
}

export interface Workflow {
  /** Path relative to the repository root, as findings print it. */
  file: string;
  /** The file name, as heavy-suite and cache-group entries name it. */
  name: string;
  raw: string;
  doc: Map;
  /** Each trigger by event name, with its filters (`{}` when it has none). */
  on: Record<string, Map>;
  jobs: Job[];
}

export interface Action {
  file: string;
  raw: string;
  steps: unknown[];
  /** `runs.image` of a Docker container action. */
  image?: string | undefined;
}

export interface CacheGroup {
  name: string;
  members: string[];
  /** The environment variables that affect the cache key; all when absent. */
  env?: string[] | undefined;
}

export interface Settings {
  /** `ci.required_checks`, when the repository sets it. */
  requiredChecks?: string[] | undefined;
  /** `ci.hold_label`, when the repository sets it. */
  holdLabel?: string | undefined;
  catalog?: ChangeAreaCatalog | undefined;
  /** The file the repository's values came from, relative to the root. */
  jigConfig: string;
  /** Heavy suites: `<workflow file>` or `<workflow file>#<job id>`. */
  heavy: string[];
  cacheGroups: CacheGroup[];
  /** The lint's configuration file, relative to the root. */
  config: string;
}

export interface ExceptionEntry {
  rule: string;
  file: string;
  job?: string | undefined;
  reason: string;
  line: number;
}

/** A folder's files; a missing folder holds none when it is a default, and
 * could not be checked when the caller named it. */
function listed(listing: Listing, what: string, named: boolean): string[] {
  if ("error" in listing) throw new Unreadable(`${what}: ${listing.error}`);
  if ("missing" in listing) {
    if (named) throw new Unreadable(`${what}: the folder named does not exist`);
    return [];
  }
  return listing.files;
}

/** A parsed YAML file; one that cannot be read or parsed throws, named by
 * its path relative to the root. */
function parsed(path: string, root: string): YamlFile {
  const read = readYaml(path);
  if ("error" in read)
    throw new Unreadable(read.error.replace(path, repoPath(root, path)));
  return read;
}

const list = (value: unknown) =>
  Array.isArray(value) ? value : value === undefined ? [] : undefined;

/** The trigger filters the rules read: each is a list of patterns. */
const PATTERN_FILTERS = [
  "paths",
  "paths-ignore",
  "branches",
  "branches-ignore",
  "tags",
  "tags-ignore",
];

/** `schedule` alone takes a list, of cron entries. No rule reads them, but
 * without one the workflow never runs on it. */
function cronEntries(value: unknown, where: string): Map {
  const cron = (entry: unknown) =>
    isRecord(entry) && typeof entry.cron === "string" && entry.cron !== "";
  if (!Array.isArray(value) || !value.length || !value.every(cron))
    throw new Unreadable(`${where}: not a list of cron entries`);
  return {};
}

/** One event's settings: absent or a map whose filters are lists of
 * patterns. Read as unfiltered, a malformed one would pass a rule that never
 * saw its filter. */
function eventFilters(event: string, value: unknown, where: string): Map {
  if (event === "schedule") return cronEntries(value, where);
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Unreadable(`${where}: not a map`);
  for (const key of PATTERN_FILTERS)
    if (
      key in value &&
      !(
        Array.isArray(value[key]) &&
        value[key].every((p: unknown) => typeof p === "string")
      )
    )
      throw new Unreadable(`${where} ${key}: not a list of patterns`);
  return value;
}

/** A workflow's `on:`, written as one event, a list or a map, as a map. An
 * event named without settings is read as one whose settings are absent, so
 * `schedule`, which cannot run without them, is malformed in every form. */
function triggers(on: unknown, file: string): Record<string, Map> {
  const bare = (event: string) => [
    event,
    eventFilters(event, undefined, `${file} on: ${event}`),
  ];
  if (typeof on === "string" && on) return Object.fromEntries([bare(on)]);
  if (Array.isArray(on)) {
    if (!on.length || !on.every((event) => typeof event === "string" && event))
      throw new Unreadable(`${file}: \`on:\` is not a list of events`);
    return Object.fromEntries(on.map(bare));
  }
  if (!isRecord(on) || !Object.keys(on).length)
    throw new Unreadable(`${file}: \`on:\` is not an event, a list or a map`);
  return Object.fromEntries(
    Object.entries(on).map(([event, filters]) => [
      event,
      eventFilters(event, filters, `${file} on.${event}`),
    ]),
  );
}

/** An `env:` is absent or a map; read as empty, a malformed one would hide
 * the keys the cache rule compares. */
function envMap(value: unknown, where: string): void {
  if (value !== undefined && value !== null && !isRecord(value))
    throw new Unreadable(`${where}: not a map`);
}

/** The job fields the rules read have their shape: `steps` a list of maps,
 * `needs` a job id or a list of them, `env` a map. Read as empty, a malformed
 * one would let a rule pass what it never saw. */
function jobShape(def: Map, where: string): void {
  const steps = def.steps;
  if (
    steps !== undefined &&
    (!Array.isArray(steps) || !steps.every((step) => isRecord(step)))
  )
    throw new Unreadable(`${where} steps: not a list of steps`);
  const needs = def.needs;
  if (
    needs !== undefined &&
    typeof needs !== "string" &&
    !(Array.isArray(needs) && needs.every((n) => typeof n === "string"))
  )
    throw new Unreadable(`${where} needs: not a job id or a list of them`);
  envMap(def.env, `${where} env`);
}

function workflow(path: string, root: string): Workflow {
  const { raw, doc } = parsed(path, root);
  const file = repoPath(root, path);
  if (!isRecord(doc) || !isRecord(doc.jobs))
    throw new Unreadable(`${file}: not a workflow (no \`jobs:\` map)`);
  if (!Object.keys(doc.jobs).length)
    throw new Unreadable(`${file}: not a workflow (no job under \`jobs:\`)`);
  envMap(doc.env, `${file} env`);
  const jobs = Object.entries(doc.jobs).map(([id, def]) => {
    if (!isRecord(def)) throw new Unreadable(`${file}: job ${id} is not a map`);
    jobShape(def, `${file} job ${id}`);
    return { id, def };
  });
  return {
    file,
    name: basename(path),
    raw,
    doc,
    on: triggers(doc.on, file),
    jobs,
  };
}

/** The `runs:` key each kind of action needs as its entry point; without it
 * there is no definition to check. Undefined for a runtime outside GitHub's
 * set, which is no action. */
function entryPoint(using: string): string | undefined {
  if (using === "composite") return "steps";
  if (using === "docker") return "image";
  return /^node\d+$/.test(using) ? "main" : undefined;
}

const absentOrNamed = (value: unknown) =>
  value === undefined || (typeof value === "string" && value !== "");

function action(path: string, root: string): Action {
  const { raw, doc } = parsed(path, root);
  const file = repoPath(root, path);
  const runs = isRecord(doc) ? doc.runs : undefined;
  if (!isRecord(runs) || typeof runs.using !== "string" || !runs.using)
    throw new Unreadable(
      `${file}: not an action definition (no \`runs:\` map naming \`using\`)`,
    );
  const required = entryPoint(runs.using);
  if (!required)
    throw new Unreadable(
      `${file}: \`runs.using\` '${runs.using}' is not composite, docker or a node runtime`,
    );
  if (runs[required] === undefined)
    throw new Unreadable(
      `${file}: a '${runs.using}' action has no \`runs.${required}\``,
    );
  const steps = list(runs.steps);
  if (!steps?.every((step) => isRecord(step)))
    throw new Unreadable(`${file}: \`runs.steps\` is not a list of steps`);
  if (!absentOrNamed(runs.image))
    throw new Unreadable(`${file}: \`runs.image\` is not an image`);
  if (!absentOrNamed(runs.main))
    throw new Unreadable(`${file}: \`runs.main\` is not a file`);
  return { file, raw, steps, image: runs.image as string | undefined };
}

export interface Folders {
  workflows: string;
  actions: string;
  /** Which of the two the caller named; a named folder must exist. */
  named: { workflows: boolean; actions: boolean };
}

/** Every workflow and action definition under the two folders; a missing
 * default folder holds none, an unreadable or missing named one throws. */
export function readPipelines(
  root: string,
  folders: Folders,
): { workflows: Workflow[]; actions: Action[] } {
  const { workflows, actions, named } = folders;
  return {
    workflows: listed(
      workflowFiles(workflows),
      `workflows ${repoPath(root, workflows)}`,
      named.workflows,
    ).map((p) => workflow(p, root)),
    actions: listed(
      actionFiles(actions),
      `actions ${repoPath(root, actions)}`,
      named.actions,
    ).map((p) => action(p, root)),
  };
}

/** A file the run reads when present: absent is fine for a default path, an
 * error for one the caller named. */
function optional(
  path: string,
  named: boolean,
  root: string,
): YamlFile | undefined {
  return named || existsSync(path) ? parsed(path, root) : undefined;
}

function mapping(value: unknown, where: string): Map {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Unreadable(`${where}: not a map`);
  return value;
}

/** A list of distinct, non-blank strings; `[]` is a deliberate empty list,
 * not an absent one. */
function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Unreadable(`${where}: expected a list of strings`);
  if (value.some((v) => !v.trim()))
    throw new Unreadable(`${where}: holds a blank entry`);
  const repeated = value.find((v, i) => value.indexOf(v) !== i);
  if (repeated !== undefined)
    throw new Unreadable(`${where}: '${repeated}' is listed twice`);
  return value as string[];
}

function catalogAt(value: unknown, root: string, where: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value)
    throw new Unreadable(`${where}: expected a path`);
  const path = isAbsolute(value) ? value : join(root, value);
  try {
    return loadCatalogFile(path);
  } catch (e) {
    throw new Unreadable(e instanceof Error ? e.message : String(e));
  }
}

/** The repository's own values the lint reads from `.config/jig.yaml`. */
function repositoryValues(path: string, named: boolean, root: string) {
  const file = repoPath(root, path);
  const doc = mapping(optional(path, named, root)?.doc, file);
  const ci = mapping(doc.ci, `${file} ci`);
  const hold = ci.hold_label;
  if (hold !== undefined && hold !== null && typeof hold !== "string")
    throw new Unreadable(`${file} ci.hold_label: expected a label`);
  return {
    jigConfig: file,
    requiredChecks: strings(ci.required_checks, `${file} ci.required_checks`),
    holdLabel: typeof hold === "string" && hold ? hold : undefined,
    catalog: catalogAt(
      mapping(doc.drive, `${file} drive`).change_areas_catalog,
      root,
      `${file} drive.change_areas_catalog`,
    ),
  };
}

const ENTRY = /^[^\s#]+(?:#[^\s#]+)?$/;
const MEMBER = /^[^\s#]+#[^\s#]+$/;

function entries(value: unknown, where: string, shape: RegExp): string[] {
  const out = strings(value, where) ?? [];
  const bad = out.find((entry) => !shape.test(entry));
  if (bad !== undefined)
    throw new Unreadable(
      `${where}: '${bad}' is not ${shape === MEMBER ? "<workflow file>#<job id>" : "<workflow file>[#<job id>]"}`,
    );
  return out;
}

function cacheGroup(value: unknown, where: string): CacheGroup {
  const group = mapping(value, where);
  const unknown = Object.keys(group).find(
    (key) => !["name", "members", "env"].includes(key),
  );
  if (unknown) throw new Unreadable(`${where}: unknown key '${unknown}'`);
  if (typeof group.name !== "string" || !group.name)
    throw new Unreadable(`${where}: needs a name`);
  const members = entries(group.members, `${where} members`, MEMBER);
  if (members.length < 2)
    throw new Unreadable(`${where}: needs at least two members`);
  return { name: group.name, members, env: strings(group.env, `${where} env`) };
}

/** The lint's own configuration: heavy suites and cache groups. */
function lintConfig(path: string, named: boolean, root: string) {
  const file = repoPath(root, path);
  const doc = mapping(optional(path, named, root)?.doc, file);
  const unknown = Object.keys(doc).find(
    (key) => !["heavy", "cache_groups"].includes(key),
  );
  if (unknown) throw new Unreadable(`${file}: unknown key '${unknown}'`);
  const groups = list(doc.cache_groups);
  if (!groups) throw new Unreadable(`${file} cache_groups: expected a list`);
  return {
    config: file,
    heavy: entries(doc.heavy, `${file} heavy`, ENTRY),
    cacheGroups: groups.map((g, i) =>
      cacheGroup(g, `${file} cache_groups[${i}]`),
    ),
  };
}

export interface Paths {
  jigConfig: string;
  config: string;
  /** Which of the two the caller named; a named file must exist. */
  named: { jigConfig: boolean; config: boolean };
}

export function readSettings(root: string, paths: Paths): Settings {
  return {
    ...repositoryValues(paths.jigConfig, paths.named.jigConfig, root),
    ...lintConfig(paths.config, paths.named.config, root),
  };
}

/** The exception list: one `<rule> <file> [<job>]` per line, each group of
 * entries under the `#` comment lines that give its reason. */
export function readExceptions(
  path: string,
  named: boolean,
  root: string,
  rules: readonly string[],
): ExceptionEntry[] {
  if (!named && !existsSync(path)) return [];
  const list = repoPath(root, path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Unreadable(`cannot read ${list}: ${String(e)}`);
  }
  return reasonedEntries(text).map(({ text: entry, line, reason }) => {
    const [rule = "", file = "", job, ...rest] = entry.trim().split(/\s+/);
    if (!file || rest.length)
      throw new Unreadable(
        `${list}:${line}: expected '<rule> <file> [<job>]', got '${entry.trim()}'`,
      );
    if (!rules.includes(rule))
      throw new Unreadable(`${list}:${line}: unknown rule '${rule}'`);
    return { rule, file, job, reason, line };
  });
}
