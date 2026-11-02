/**
 * The lens contract: one Markdown file per review lens, its frontmatter
 * checked here, read by `review` and by any reviewer that loads the same
 * file.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import { load } from "../../../shared/yaml.ts";

/** A configuration error: `review` stops and names it rather than run without the lens. */
export class LensConfigError extends Error {
  override name = "LensConfigError";
}

/** Where a lens comes from: the plugin's seed lenses, or the repository's own directory. */
export type LensSource = "seed" | "repository";

export const TRIGGER_KEYS = [
  "paths",
  "exclude",
  "added_lines",
  "removed_lines",
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];
export type Trigger = Record<TriggerKey, string[]>;

export interface Lens {
  id: string;
  version: number;
  rules: string[];
  lever: string | null;
  trigger: Trigger;
  evidence: string;
  /** The lens file's absolute path. */
  file: string;
  source: LensSource;
}

/** The prefix only a seed lens's id carries. */
export const SEED_PREFIX = "jig.";
const KEYS = ["id", "version", "rules", "lever", "trigger", "evidence"];
const SECTIONS = ["## Look for", "## Not a finding", "## Evidence"];
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPOSITORY_ID = /^LENS-[0-9]{3,}$/;

/** Whether `path`, with every symbolic link followed, lies inside `root`'s real path. */
export function realInside(root: string, path: string): boolean {
  const part = relative(realpathSync(root), realpathSync(path));
  return (
    part === "" ||
    (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
  );
}

function problem(where: string, detail: string): LensConfigError {
  return new LensConfigError(`${where}: ${detail}`);
}

/** A list of nonempty strings, or the empty list when absent. */
export function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry !== "")
  )
    throw problem(where, "must be a list of nonempty strings");
  return value;
}

/** Refuse a key outside `known`: a misspelt key would otherwise do nothing. */
export function onlyKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value))
    if (!known.includes(key))
      throw problem(where, `unknown key ${key} (known: ${known.join(", ")})`);
}

/** A trigger, or the additions to one, with every key it may hold checked. */
export function triggerOf(value: unknown, where: string): Trigger {
  if (!isRecord(value)) throw problem(where, "must be a mapping");
  onlyKeys(value, TRIGGER_KEYS, where);
  const trigger = Object.fromEntries(
    TRIGGER_KEYS.map((key) => [key, stringList(value[key], `${where}.${key}`)]),
  ) as Trigger;
  for (const key of ["added_lines", "removed_lines"] as const)
    for (const pattern of trigger[key]) compilePattern(pattern, where);
  return trigger;
}

/** A line pattern as the regular expression selection matches with. */
export function compilePattern(pattern: string, where: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw problem(
      where,
      `pattern ${pattern} is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function frontmatter(text: string, file: string): Record<string, unknown> {
  const block = FRONTMATTER.exec(text)?.[1];
  if (block === undefined) throw problem(file, "has no frontmatter");
  let data: unknown;
  try {
    data = load(block);
  } catch (error) {
    throw problem(
      file,
      `frontmatter does not parse (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isRecord(data)) throw problem(file, "frontmatter must be a mapping");
  onlyKeys(data, KEYS, file);
  return data;
}

function lensId(value: unknown, file: string, source: LensSource): string {
  if (typeof value !== "string" || !ID.test(value))
    throw problem(file, "id must be letters, digits, '.', '_' or '-'");
  if ((source === "seed") !== value.startsWith(SEED_PREFIX))
    throw problem(
      file,
      source === "seed"
        ? `a seed lens's id starts with ${SEED_PREFIX}`
        : `the ${SEED_PREFIX} prefix is for seed lenses; a repository lens keeps its own numbering (LENS-NNN)`,
    );
  if (source === "repository" && !REPOSITORY_ID.test(value))
    throw problem(
      file,
      `a repository lens's id is LENS-NNN (three or more digits), not ${value}`,
    );
  return value;
}

function rulesOf(value: unknown, file: string, source: LensSource): string[] {
  const rules = stringList(value, `${file}: rules`);
  if (source === "seed" && rules.length === 0)
    throw problem(file, "a seed lens lists at least one rule");
  for (const rule of rules)
    if (!/^https:\/\/\S+$/.test(rule))
      throw problem(file, `rule ${rule} must be an absolute https URL`);
  return rules;
}

function leverOf(
  value: unknown,
  file: string,
  source: LensSource,
): string | null {
  if (value === undefined || value === null) return null;
  if (source === "seed") throw problem(file, "a seed lens's lever is ~");
  if (typeof value !== "string" || value === "")
    throw problem(file, "lever must be a lever number or ~");
  return value;
}

/** The lens a file holds, every field and body section checked. */
export function parseLens(
  text: string,
  file: string,
  source: LensSource,
): Lens {
  const data = frontmatter(text, file);
  const version = data.version;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw problem(file, "version must be a whole number of at least 1");
  if (typeof data.evidence !== "string" || data.evidence.trim() === "")
    throw problem(file, "evidence must name the field every finding fills");
  const trigger = triggerOf(data.trigger, `${file}: trigger`);
  if (trigger.paths.length === 0)
    throw problem(file, "trigger.paths must name at least one glob");
  for (const section of SECTIONS)
    if (!text.split(/\r?\n/).includes(section))
      throw problem(file, `the body has no "${section}" section`);
  return {
    id: lensId(data.id, file, source),
    version,
    rules: rulesOf(data.rules, file, source),
    lever: leverOf(data.lever, file, source),
    trigger,
    evidence: data.evidence,
    file,
    source,
  };
}

/** Code-unit order: the same on every host, whatever its locale. */
export function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/** Whether `name` is a lens file's name: Markdown, and not the folder's README. */
export function isLensFileName(name: string): boolean {
  return name.endsWith(".md") && name !== "README.md";
}

/**
 * Every lens directly inside `dir`, in name order; none when it does not
 * exist. With `within`, a lens file whose real path leaves that folder is
 * refused: a link would otherwise load a file the snapshot does not hold.
 */
export function readLensDir(
  dir: string,
  source: LensSource,
  within?: string,
): Lens[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .filter(isLensFileName)
    .sort(byCodeUnit)
    .map((name) => {
      const file = join(dir, name);
      if (within !== undefined && !realInside(within, file))
        throw problem(file, "is a link that leaves the base snapshot");
      return parseLens(readFileSync(file, "utf8"), file, source);
    });
}
