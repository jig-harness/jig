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
 * `autonomy.off_hours` widens it during the hours nobody is there to ask:
 * inside one of its schedule's windows (`off-hours.ts`, the machine's local
 * time) a driver pass runs at `off_hours.level` instead of the chosen level,
 * capped by the same ceiling. Unset `off_hours.level` means off-hours is off;
 * once it is set, the schedule defaults to weekday nights and the weekend.
 * A person's session never runs at the off-hours level: a person is there.
 *
 * The ceiling `max_level` and `park_classes` bound what every agent may
 * decide, so a driver pass reads them from the branch the pull request
 * targets, never from the pull request's own checkout: an edit to them
 * applies to a drive once it is on that branch (for a stacked layer, the
 * layer below), never through the pull request that makes it. The driver resolves the base branch's commit
 * and hands it to itself and its passes in `$DRIVE_PR_POLICY_BASE`; this
 * reader takes `.config/jig.yaml` at that commit, ignoring `JIG_OVERLAY` and
 * the working tree's copy for these fields. When the base cannot be read,
 * the policy fails closed (`readPolicySnapshot`). A person's session reads
 * them from the working tree: the person is there to see what they say.
 *
 * The level is read at each decision point rather than once per run, so a
 * configuration changed mid-drive, or a window that opens mid-drive, applies
 * to the next decision. Nothing here touches the decision classes the
 * human-in-the-loop registry reserves: a level decides who answers the
 * questions outside them.
 *
 * Usage:
 *   autonomy.ts [level] [--json] [--at <instant>]
 *                                  the effective level and where it came from,
 *                                  now or at an ISO-8601 instant
 *   autonomy.ts classes            the park classes, one per line
 *
 * Exit codes: 0 printed, 1 the configuration is invalid, 2 usage.
 */
import { runMain } from "./cli.ts";
import {
  isMapping,
  type LayeredConfig,
  OVERLAY_RELPATH,
  parseConfigText,
  sourceOf,
  valueAt,
} from "./config-layers.ts";
import { consumerRoot, layeredConfig } from "./consumer.ts";
import { spawnSync, withoutLeakyGitEnv } from "./guarded-git-spawn.ts";
import {
  DEFAULT_OFF_HOURS_SCHEDULE,
  OffHoursScheduleError,
  parseSchedule,
  windowAt,
} from "./off-hours.ts";

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

/**
 * The classes kept whatever a repository lists: the two the review arbiter
 * emits, and `human-thread`, which a person's reversal of a provisional
 * decision is parked under.
 */
const KEPT_CLASSES = ["escalated", "human-decision", "human-thread"] as const;

/** A class name: lower-case words joined by hyphens. */
const CLASS_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The variable a driver sets for its passes; unset in a person's session. */
const DRIVER_PASS_VARIABLE = "DRIVE_PR_TARGET";

/**
 * The variable a driver sets, for itself and its passes, to the commit of
 * the pull request's base branch the policy is read from; empty when the
 * driver could not resolve it.
 */
export const POLICY_BASE_VARIABLE = "DRIVE_PR_POLICY_BASE";

type Env = Record<string, string | undefined>;

/**
 * Where a session's policy (`max_level`, `park_classes`, and what the
 * ceiling falls back on) comes from: the working tree in a person's
 * session; the `.config/jig.yaml` at the base branch's commit in a driver
 * pass (`values` empty when the base has no such file); or nowhere, with the
 * reason, when that snapshot cannot be read.
 */
export type PolicySnapshot =
  | { from: "working-tree" }
  | { from: "base"; commit: string; values: Record<string, unknown> }
  | { from: "unreadable"; reason: string };

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
   * The off-hours window the level was resolved inside, with the level it
   * sets and where that came from; `null` outside every window, with
   * off-hours off, and in a person's session. `chosen` and `source` then
   * name the off-hours level.
   */
  offHours: { window: string } | null;
  /**
   * Where the ceiling and the park classes came from: the working tree (a
   * person's session), the base branch at `commit`, or nowhere, with the
   * reason, in which case the ceiling is `attended` and every decision is a
   * person's until the policy reads.
   */
  policy:
    | { from: "working-tree" }
    | { from: "base"; commit: string }
    | { from: "unreadable"; reason: string };
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
 * a ceiling another layer could move would be no ceiling. In a driver pass
 * the ceiling comes from the policy snapshot instead (`snapshotCeiling`);
 * the working tree's level is still the repository's choice of level, which
 * that ceiling caps.
 */
function repositoryCeiling(
  config: LayeredConfig,
  policy: PolicySnapshot,
): Ceiling {
  const values = repositoryValues(config, "autonomy.max_level");
  const repository = config.layers.find((l) => l.name === "repository");
  const where = repository?.source ?? config.repositoryPath;
  const repositoryLevel = levelAt(values, "autonomy.level", where);
  if (policy.from !== "working-tree")
    return { repositoryLevel, ...snapshotCeiling(policy) };
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
    ceilingSource: describeCeiling(
      config.repositoryPath,
      declared,
      repositoryLevel,
    ),
  };
}

/** The short form of a commit, for the printed line. */
const short = (commit: string) => commit.slice(0, 12);

/**
 * The ceiling a driver pass works under: the base branch's `max_level`,
 * else the base's own `level`, else `attended`, and never anything from the
 * working tree; `attended` when the snapshot cannot be read. The base's
 * level above the base's own ceiling is an error in the base's file.
 */
function snapshotCeiling(
  policy: Exclude<PolicySnapshot, { from: "working-tree" }>,
): Omit<Ceiling, "repositoryLevel"> {
  if (policy.from === "unreadable")
    return {
      ceiling: DEFAULT_LEVEL,
      ceilingSource: "the base branch's policy, which cannot be read",
    };
  const where = `${OVERLAY_RELPATH} at ${short(policy.commit)} on the base branch`;
  const baseLevel = levelAt(policy.values, "autonomy.level", where);
  const declared = levelAt(policy.values, "autonomy.max_level", where);
  const ceiling = declared ?? baseLevel ?? DEFAULT_LEVEL;
  if (baseLevel !== undefined && rank(baseLevel) > rank(ceiling))
    throw new AutonomyConfigError(
      `autonomy.level ${baseLevel} is above autonomy.max_level ${ceiling}: ${where}`,
    );
  return {
    ceiling,
    ceilingSource: describeCeiling(where, declared, baseLevel),
  };
}

function describeCeiling(
  where: string,
  declared: AutonomyLevel | undefined,
  repositoryLevel: AutonomyLevel | undefined,
): string {
  if (declared !== undefined) return `autonomy.max_level in ${where}`;
  return repositoryLevel !== undefined
    ? `autonomy.level in ${where}, which sets no max_level`
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
      // The layer that supplied the level, not the field's ordinary winner:
      // the repository's file outranks the user's, but its level is not the
      // one chosen here.
      source:
        personal.name === "environment"
          ? sourceOf(config, "autonomy.level")
          : personal.source,
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

interface OffHoursSetting {
  level: AutonomyLevel;
  source: string;
  schedule: readonly string[];
}

const isUnset = (v: unknown): v is undefined | null =>
  v === undefined || v === null;

/**
 * `autonomy.off_hours.schedule`, checked and parsed; the default when unset.
 * `set` says whether the configuration named one.
 */
function offHoursSchedule(config: LayeredConfig): {
  schedule: readonly string[];
  set: boolean;
  where: string;
} {
  const raw = valueAt(config.values, "autonomy.off_hours.schedule");
  const where = sourceOf(config, "autonomy.off_hours.schedule");
  if (isUnset(raw))
    return { schedule: DEFAULT_OFF_HOURS_SCHEDULE, set: false, where };
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((w) => typeof w !== "string")
  )
    throw new AutonomyConfigError(
      `autonomy.off_hours.schedule must be a nonempty list of windows such as "Mon-Fri 20:00-07:00": ${where}`,
    );
  try {
    parseSchedule(raw as string[]);
  } catch (err) {
    if (err instanceof OffHoursScheduleError)
      throw new AutonomyConfigError(`${err.message}: ${where}`);
    throw err;
  }
  return { schedule: raw as string[], set: true, where };
}

/** `autonomy.off_hours`, checked; `null` when its level is unset (off-hours is off). */
function offHoursSetting(config: LayeredConfig): OffHoursSetting | null {
  const section = valueAt(config.values, "autonomy.off_hours");
  if (isUnset(section)) return null;
  if (!isMapping(section))
    throw new AutonomyConfigError(
      `autonomy.off_hours must be a mapping: ${sourceOf(config, "autonomy.off_hours")}`,
    );
  const where = sourceOf(config, "autonomy.off_hours.level");
  const level = levelAt(config.values, "autonomy.off_hours.level", where);
  const schedule = offHoursSchedule(config);
  if (level === undefined && schedule.set)
    throw new AutonomyConfigError(
      `autonomy.off_hours.schedule is set but autonomy.off_hours.level is not, so off-hours is off: set the level, or remove the schedule: ${schedule.where}`,
    );
  return level === undefined
    ? null
    : { level, source: where, schedule: schedule.schedule };
}

/** Whether `env` is a person's session rather than a driver pass. */
function isInteractive(env: Env): boolean {
  return (env[DRIVER_PASS_VARIABLE] ?? "").trim() === "";
}

/**
 * The effective autonomy level of the repository whose layers `config`
 * holds, for a session whose environment is `env`, at the instant `now`.
 * `policy` is where the ceiling comes from; by default the working tree in
 * a person's session and the base branch's snapshot in a driver pass
 * (`readPolicySnapshot`). A person's session always reads the working tree.
 */
export function resolveAutonomy(
  config: LayeredConfig,
  env: Env = process.env,
  now: Date = new Date(),
  policy: PolicySnapshot = readPolicySnapshot(env),
): Autonomy {
  checkSection(config);
  const interactive = isInteractive(env);
  const snapshot: PolicySnapshot = interactive
    ? { from: "working-tree" }
    : policy;
  const { repositoryLevel, ceiling, ceilingSource } = repositoryCeiling(
    config,
    snapshot,
  );
  const offHours = offHoursSetting(config);
  const window =
    offHours === null || interactive
      ? null
      : windowAt(parseSchedule(offHours.schedule), now);
  const { chosen, source } =
    window === null || offHours === null
      ? chosenLevel(config, repositoryLevel, interactive)
      : { chosen: offHours.level, source: offHours.source };
  const capped = rank(chosen) > rank(ceiling);
  return {
    level: capped ? ceiling : chosen,
    chosen,
    source,
    ceiling,
    ceilingSource,
    capped,
    interactive,
    offHours: window === null ? null : { window: window.text },
    policy:
      snapshot.from === "base"
        ? { from: "base", commit: snapshot.commit }
        : snapshot,
  };
}

/**
 * One line for a round header or a report: the level and where it came from.
 * Inside an off-hours window the level is tagged `(off_hours)` and the line
 * names the window.
 */
export function describeAutonomy(a: Autonomy): string {
  const tag = a.offHours === null ? "" : " (off_hours)";
  const parts = [`autonomy: ${a.level}${tag} (${a.chosen} from ${a.source}`];
  if (a.offHours !== null)
    parts.push(`, inside the off-hours window "${a.offHours.window}"`);
  if (a.capped) parts.push(`, capped at ${a.ceiling} by ${a.ceilingSource}`);
  if (a.policy.from === "base")
    parts.push(`; policy from the base branch at ${short(a.policy.commit)}`);
  const line = `${parts.join("")})`;
  return a.policy.from === "unreadable"
    ? `${line}. The base branch's policy cannot be read (${a.policy.reason}): the ceiling is attended, and every decision is parked under human-decision until it reads`
    : line;
}

/**
 * The classes a park may name: `autonomy.park_classes` from the repository's
 * own file when it sets them, else the registry template's rows; `escalated`
 * and `human-decision` always, since the review arbiter emits them. No other
 * layer may set the list: a person or a run that could widen it could park
 * whatever they liked. In a driver pass the list comes from the base
 * branch's snapshot (`policy`), never the pull request's own checkout.
 */
export function parkClasses(
  config: LayeredConfig,
  env: Env = process.env,
  policy: PolicySnapshot = readPolicySnapshot(env),
): string[] {
  const own = repositoryValues(config, "autonomy.park_classes");
  const snapshot: PolicySnapshot = isInteractive(env)
    ? { from: "working-tree" }
    : policy;
  // An unreadable policy keeps only the classes kept whatever a repository
  // lists, and the pass parks every decision under `human-decision`: the
  // default list could be weaker than the repository's own, which may name
  // a class the defaults leave to the agent, so no list stands in for it.
  if (snapshot.from === "unreadable") return [...KEPT_CLASSES];
  return classesIn(snapshot.from === "base" ? snapshot.values : own);
}

/** The park classes `values` (one repository file's) name, checked. */
function classesIn(values: Record<string, unknown>): string[] {
  const raw = valueAt(values, "autonomy.park_classes");
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
  return [...classes, ...KEPT_CLASSES.filter((c) => !classes.includes(c))];
}

/** Seconds one git call reading the snapshot may take: `GIT_CALL_TIMEOUT`, else 30. */
function gitTimeoutMs(env: Env): number {
  const raw = (env.GIT_CALL_TIMEOUT ?? "").trim();
  const seconds = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  return (seconds > 0 ? seconds : 30) * 1000;
}

/** One git call in `root`, bounded; its output, or the reason it failed. */
function gitIn(
  root: string,
  args: string[],
  env: Env,
): { out: string } | { error: string } {
  // `--no-replace-objects`: a `refs/replace/*` ref in the clone would
  // otherwise substitute another object for the base commit's tree or file.
  const r = spawnSync("git", ["--no-replace-objects", "-C", root, ...args], {
    env: withoutLeakyGitEnv(process.env),
    timeout: gitTimeoutMs(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error !== undefined)
    return { error: `git ${args[0]} failed: ${r.error.message}` };
  if (r.status !== 0)
    return {
      error: `git ${args[0]} exited ${r.status ?? r.signal}: ${(r.stderr ?? "").trim()}`,
    };
  return { out: r.stdout };
}

/**
 * The policy snapshot for a session whose environment is `env`: the working
 * tree in a person's session; in a driver pass, the repository's
 * `.config/jig.yaml` at the base branch's commit the driver named in
 * `$DRIVE_PR_POLICY_BASE`, read from the repository at `root`. A base with
 * no such file is a readable snapshot that sets nothing. The snapshot is
 * unreadable, with the reason, when the variable names no commit, the
 * commit is not in the clone, git fails or runs out of time, or the file
 * does not parse or names an invalid ceiling or class list: the policy then
 * fails closed, so a broken base never lets a pass decide more.
 */
export function readPolicySnapshot(
  env: Env = process.env,
  root: string = consumerRoot(process.cwd(), env),
): PolicySnapshot {
  if (isInteractive(env)) return { from: "working-tree" };
  const commit = (env[POLICY_BASE_VARIABLE] ?? "").trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    return {
      from: "unreadable",
      reason:
        commit === ""
          ? `the driver named no base-branch commit in $${POLICY_BASE_VARIABLE}`
          : `$${POLICY_BASE_VARIABLE} is not a commit id`,
    };
  const listed = gitIn(
    root,
    ["ls-tree", "--full-tree", "--name-only", commit, "--", OVERLAY_RELPATH],
    env,
  );
  if ("error" in listed) return { from: "unreadable", reason: listed.error };
  if (listed.out.trim() === "") return { from: "base", commit, values: {} };
  const text = gitIn(
    root,
    ["cat-file", "blob", `${commit}:${OVERLAY_RELPATH}`],
    env,
  );
  if ("error" in text) return { from: "unreadable", reason: text.error };
  let values: Record<string, unknown>;
  try {
    values = parseConfigText(
      text.out,
      `${OVERLAY_RELPATH} at ${short(commit)}`,
    );
  } catch (err) {
    return { from: "unreadable", reason: failureReason(err, PARSE_ERRORS) };
  }
  const snapshot: PolicySnapshot = { from: "base", commit, values };
  try {
    const section = values.autonomy;
    if (section !== undefined && section !== null && !isMapping(section))
      throw new AutonomyConfigError(
        `autonomy must be a mapping: ${OVERLAY_RELPATH} at ${short(commit)} on the base branch`,
      );
    snapshotCeiling(snapshot);
    classesIn(values);
  } catch (err) {
    return { from: "unreadable", reason: failureReason(err, []) };
  }
  return snapshot;
}

/**
 * The names of the errors the configuration parser throws for a file it
 * refuses: a plain `Error` for text that does not parse or is not a mapping,
 * `ConfigFieldError` for a field it cannot use.
 */
const PARSE_ERRORS = ["Error", "ConfigFieldError"];

/**
 * Why the snapshot did not read, from what was thrown reading it. A refusal
 * of the base's file (an `AutonomyConfigError`, or one of `expected`) is its
 * message; anything else carries its name too, so a defect in the reader
 * never reads as a bad file on the base branch. Either way the policy fails
 * closed: rethrowing would let a caller that reports and carries on decide
 * without it.
 */
function failureReason(err: unknown, expected: readonly string[]): string {
  if (!(err instanceof Error)) return `a non-error was thrown: ${String(err)}`;
  return err instanceof AutonomyConfigError || expected.includes(err.name)
    ? err.message
    : `${err.name}: ${err.message}`;
}

/** The effective level for the repository the working directory is in. */
export function currentAutonomy(
  env: Env = process.env,
  now: Date = new Date(),
): Autonomy {
  return resolveAutonomy(layeredConfig(undefined, env), env, now);
}

/** `--at <instant>` taken out of `args`; `undefined` when absent. */
function takeAt(args: string[]): Date | undefined | "invalid" {
  const i = args.indexOf("--at");
  if (i < 0) return undefined;
  const [, value = ""] = args.splice(i, 2);
  const at = new Date(value);
  return value === "" || Number.isNaN(at.getTime()) ? "invalid" : at;
}

/** What the command line asks for; `null` for a usage error. */
function parseCommand(
  args: string[],
): { command: string; json: boolean; at: Date | undefined } | null {
  const at = takeAt(args);
  const rest = args.filter((a) => a !== "--json");
  const command = rest[0] ?? "level";
  const known = command === "level" || command === "classes";
  return at === "invalid" || rest.length > 1 || !known
    ? null
    : { command, json: args.includes("--json"), at };
}

function printLevel(json: boolean, at: Date | undefined): void {
  const a = currentAutonomy(process.env, at);
  process.stdout.write(
    json ? `${JSON.stringify(a)}\n` : `${describeAutonomy(a)}\n`,
  );
}

async function main(): Promise<number> {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed === null) {
    console.error(
      "usage: autonomy.ts [level] [--json] [--at <ISO-8601 instant>] | autonomy.ts classes",
    );
    return 2;
  }
  try {
    if (parsed.command === "classes")
      for (const c of parkClasses(layeredConfig(), process.env))
        process.stdout.write(`${c}\n`);
    else printLevel(parsed.json, parsed.at);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) runMain("autonomy", main);
