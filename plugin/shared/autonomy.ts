#!/usr/bin/env bun
/**
 * The autonomy level: how far an agent may decide without asking a person.
 *
 * The `autonomy` section of the configuration sets it. The repository sets
 * the default `level` and the ceiling `max_level`; the user layer and the
 * environment layer may choose a level up to that ceiling and never above
 * it, so a person's machine can run more autonomously than the team's
 * default without any layer raising what the team allowed. A session with a
 * person in it (an interactive run, not a driver pass) reads `attended`
 * unless that person chose a level in their own layer or the environment.
 *
 * The level is read at each decision point rather than once per run, so a
 * configuration changed mid-drive applies to the next decision. Nothing here
 * touches the decision classes the human-in-the-loop registry reserves: a
 * level decides who answers the questions outside them.
 *
 * Usage:
 *   autonomy.ts [level] [--json]   the effective level and where it came from
 *   autonomy.ts classes            the park classes, one per line
 *
 * Exit codes: 0 printed, 1 the configuration is invalid, 2 usage.
 */
import { runMain } from "./cli.ts";
import {
  isMapping,
  type LayeredConfig,
  OVERLAY_RELPATH,
  sourceOf,
  valueAt,
} from "./config-layers.ts";
import { layeredConfig } from "./consumer.ts";

/** The levels, least autonomous first. */
export const AUTONOMY_LEVELS = ["attended", "unattended", "wide"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The level a repository that sets nothing runs at: today's behaviour. */
export const DEFAULT_LEVEL: AutonomyLevel = "attended";

/**
 * The decision classes a drive may park on when a repository sets no
 * `autonomy.park_classes`: the rows of the human-in-the-loop registry
 * template, then `escalated` (a product or stakeholder call the review
 * arbiter or `decide` escalates) and `human-decision` (a value the pull
 * request records as a person's decision, or a rule in a human-decided span).
 */
export const DEFAULT_PARK_CLASSES: readonly string[] = [
  "ready",
  "merge",
  "release",
  "scope",
  "human-thread",
  "reviewer-posture",
  "next-item",
  "reopen-or-waive",
  "dark-dial",
  "rules",
  "destructive",
  "legal",
  "copy",
  "escalated",
  "human-decision",
];

/** The classes the review arbiter emits, kept whatever a repository lists. */
const ARBITER_CLASSES = ["escalated", "human-decision"] as const;

/** A class name: lower-case words joined by hyphens. */
const CLASS_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The variable a driver sets for its passes; unset in a person's session. */
const DRIVER_PASS_VARIABLE = "DRIVE_PR_TARGET";

type Env = Record<string, string | undefined>;

export interface Autonomy {
  /** The level the decision points act on. */
  level: AutonomyLevel;
  /** The level the configuration names, before the ceiling; may be above `level`. */
  chosen: AutonomyLevel;
  /** Where `chosen` came from: a file, a variable, the default or the session. */
  source: string;
  /** The repository's ceiling, and where it came from. */
  ceiling: AutonomyLevel;
  ceilingSource: string;
  /** Whether the ceiling lowered the chosen level. */
  capped: boolean;
  /** Whether this is a person's session rather than a driver pass. */
  interactive: boolean;
  /**
   * `wide` names step-five behaviour not built yet: it acts as `unattended`.
   * `level` already says so; this says why.
   */
  wideActsAsUnattended: boolean;
}

/** A configuration value that cannot be read as an autonomy setting. */
export class AutonomyConfigError extends Error {
  override name = "AutonomyConfigError";
}

function isLevel(value: unknown): value is AutonomyLevel {
  return (
    typeof value === "string" &&
    (AUTONOMY_LEVELS as readonly string[]).includes(value)
  );
}

function rank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

function levelAt(
  values: Record<string, unknown>,
  field: string,
  where: string,
): AutonomyLevel | undefined {
  const value = valueAt(values, field);
  if (value === undefined || value === null) return undefined;
  if (!isLevel(value))
    throw new AutonomyConfigError(
      `${field} must be one of ${AUTONOMY_LEVELS.join(", ")} (got ${JSON.stringify(value)}): ${where}`,
    );
  return value;
}

function checkSection(config: LayeredConfig): void {
  for (const layer of config.layers) {
    const section = layer.values.autonomy;
    if (section === undefined || section === null) continue;
    if (!isMapping(section))
      throw new AutonomyConfigError(
        `autonomy must be a mapping: ${sourceOf(config, "autonomy")}`,
      );
  }
}

interface Ceiling {
  /** The level the repository's own file names, if any. */
  repositoryLevel: AutonomyLevel | undefined;
  ceiling: AutonomyLevel;
  ceilingSource: string;
}

/**
 * The repository layer's values, for a field only the repository's file may
 * set: the user file refuses it when it is read (`REPOSITORY_ONLY_FIELDS`),
 * and an environment variable for it is refused here, so no layer but the
 * repository's can move it.
 */
function repositoryValues(
  config: LayeredConfig,
  field: string,
): Record<string, unknown> {
  for (const layer of config.layers)
    if (
      layer.name !== "repository" &&
      valueAt(layer.values, field) !== undefined
    )
      throw new AutonomyConfigError(
        `${field} is the repository's to set, so ${sourceOf(config, field)} cannot set it: set it in the repository's ${OVERLAY_RELPATH}`,
      );
  return config.layers.find((l) => l.name === "repository")?.values ?? {};
}

/**
 * The repository's level and its ceiling, from the repository's file alone:
 * a ceiling another layer could move would be no ceiling.
 */
function repositoryCeiling(config: LayeredConfig): Ceiling {
  const values = repositoryValues(config, "autonomy.max_level");
  const repository = config.layers.find((l) => l.name === "repository");
  const where = repository?.source ?? config.repositoryPath;
  const repositoryLevel = levelAt(values, "autonomy.level", where);
  const declared = levelAt(values, "autonomy.max_level", where);
  // A repository that names a level and no ceiling allows what it named.
  const ceiling = declared ?? repositoryLevel ?? DEFAULT_LEVEL;
  if (repositoryLevel !== undefined && rank(repositoryLevel) > rank(ceiling))
    throw new AutonomyConfigError(
      `autonomy.level ${repositoryLevel} is above autonomy.max_level ${ceiling}: ${where}`,
    );
  return {
    repositoryLevel,
    ceiling,
    ceilingSource: describeCeiling(config, declared, repositoryLevel),
  };
}

function describeCeiling(
  config: LayeredConfig,
  declared: AutonomyLevel | undefined,
  repositoryLevel: AutonomyLevel | undefined,
): string {
  if (declared !== undefined)
    return `autonomy.max_level in ${config.repositoryPath}`;
  return repositoryLevel !== undefined
    ? `autonomy.level in ${config.repositoryPath}, which sets no max_level`
    : "the default, which allows attended only";
}

/**
 * The level the layers choose, before the ceiling: a person's own layer
 * (the user file or the environment) first, then, in a driver pass, the
 * repository's; a person's session with no level of its own reads
 * `attended`.
 */
function chosenLevel(
  config: LayeredConfig,
  repositoryLevel: AutonomyLevel | undefined,
  interactive: boolean,
): { chosen: AutonomyLevel; source: string } {
  const personal = [...config.layers]
    .reverse()
    .find(
      (l) =>
        (l.name === "user" || l.name === "environment") &&
        valueAt(l.values, "autonomy.level") !== undefined,
    );
  if (personal !== undefined)
    return {
      chosen:
        levelAt(personal.values, "autonomy.level", personal.source) ??
        DEFAULT_LEVEL,
      source: sourceOf(config, "autonomy.level"),
    };
  if (interactive)
    return {
      chosen: "attended",
      source:
        "an interactive session, which reads attended unless its person sets a level",
    };
  return repositoryLevel === undefined
    ? { chosen: DEFAULT_LEVEL, source: "the default" }
    : { chosen: repositoryLevel, source: sourceOf(config, "autonomy.level") };
}

/**
 * The effective autonomy level of the repository whose layers `config`
 * holds, for a session whose environment is `env`.
 */
export function resolveAutonomy(
  config: LayeredConfig,
  env: Env = process.env,
): Autonomy {
  checkSection(config);
  const { repositoryLevel, ceiling, ceilingSource } = repositoryCeiling(config);
  const interactive = (env[DRIVER_PASS_VARIABLE] ?? "").trim() === "";
  const { chosen, source } = chosenLevel(config, repositoryLevel, interactive);
  const capped = rank(chosen) > rank(ceiling);
  const named = capped ? ceiling : chosen;
  const wideActsAsUnattended = named === "wide";
  return {
    level: wideActsAsUnattended ? "unattended" : named,
    chosen,
    source,
    ceiling,
    ceilingSource,
    capped,
    interactive,
    wideActsAsUnattended,
  };
}

/** One line for a round header or a report: the level and where it came from. */
export function describeAutonomy(a: Autonomy): string {
  const parts = [`autonomy: ${a.level} (${a.chosen} from ${a.source}`];
  if (a.capped) parts.push(`, capped at ${a.ceiling} by ${a.ceilingSource}`);
  if (a.wideActsAsUnattended)
    parts.push(", wide is not built yet and acts as unattended");
  return `${parts.join("")})`;
}

/**
 * The classes a park may name: `autonomy.park_classes` from the repository's
 * own file when it sets them, else the registry template's rows; `escalated`
 * and `human-decision` always, since the review arbiter emits them. No other
 * layer may set the list: a person or a run that could widen it could park
 * whatever they liked.
 */
export function parkClasses(config: LayeredConfig): string[] {
  const raw = valueAt(
    repositoryValues(config, "autonomy.park_classes"),
    "autonomy.park_classes",
  );
  if (raw === undefined || raw === null) return [...DEFAULT_PARK_CLASSES];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((c) => typeof c !== "string" || !CLASS_NAME.test(c)) ||
    new Set(raw).size !== raw.length
  )
    throw new AutonomyConfigError(
      "autonomy.park_classes must be a nonempty list of distinct class names (lower-case words joined by hyphens)",
    );
  const classes = raw as string[];
  return [...classes, ...ARBITER_CLASSES.filter((c) => !classes.includes(c))];
}

/** The effective level for the repository the working directory is in. */
export function currentAutonomy(env: Env = process.env): Autonomy {
  return resolveAutonomy(layeredConfig(undefined, env), env);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const command = rest[0] ?? "level";
  if (rest.length > 1 || (command !== "level" && command !== "classes")) {
    console.error("usage: autonomy.ts [level] [--json] | autonomy.ts classes");
    return 2;
  }
  try {
    if (command === "classes") {
      for (const c of parkClasses(layeredConfig()))
        process.stdout.write(`${c}\n`);
      return 0;
    }
    const a = currentAutonomy();
    process.stdout.write(
      json ? `${JSON.stringify(a)}\n` : `${describeAutonomy(a)}\n`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) runMain("autonomy", main);
