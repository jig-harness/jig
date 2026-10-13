/**
 * The maturity criteria (`criteria/M<n>-<name>.yaml`) and their probes.
 *
 * A probe is a necessary condition the script can test from the tracked
 * files: "some CI configuration exists", "a hook manager is configured". When
 * it does not hold, the criterion cannot be met at any rung, so the script
 * scores it `absent` and the search it ran is the evidence. When it holds, it
 * proves only that the precondition is there: the files it matched become
 * evidence for the agent, which still scores the criterion. A search that
 * could not read a file it needed is unchecked, and the agent scores it.
 */
import { isMapping as isRecord } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import { matchGlob, skillDir, VERSION_PATTERN } from "./repo.ts";

export const LEVELS = ["lite", "standard", "strict"] as const;
export type Level = (typeof LEVELS)[number];
export const REQUIRES = ["convention", "mechanical"] as const;
export type Requires = (typeof REQUIRES)[number];

/** The observed rungs, weakest first, and the score for a practice the repository's shape rules out. */
export const RUNGS = [
  "absent",
  "convention",
  "advisory",
  "mechanical",
] as const;
export const EXPECTED_ABSENT = "expected-absent";
export const SCORES = [...RUNGS, EXPECTED_ABSENT] as const;
export type Score = (typeof SCORES)[number];

export type Probe =
  | { files: string[] }
  | { grep: { files: string[]; pattern: string } }
  | { any: Probe[] }
  | { all: Probe[] };

export interface Criterion {
  /** `M<n>/<id>`, the key the audit record uses. */
  key: string;
  id: string;
  level: Level;
  requires: Requires;
  statement: string;
  observe: string[];
  probe?: Probe;
  since?: string;
}

export interface Module {
  module: string;
  name: string;
  /** One plain-language sentence: what the module solves. */
  purpose: string;
  file: string;
  criteria: Criterion[];
}

export const CRITERIA_DIR = join(skillDir(), "criteria");
export const MODULE_COUNT = 13;

const CRITERION_KEYS = new Set([
  "id",
  "level",
  "requires",
  "statement",
  "observe",
  "probe",
  "since",
]);

const isGlobs = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((g) => typeof g === "string" && g !== "");

function parseGrepProbe(grep: unknown, at: string): Probe {
  if (
    !isRecord(grep) ||
    !isGlobs(grep.files) ||
    typeof grep.pattern !== "string"
  )
    throw new Error(`${at}: grep needs files and a pattern`);
  new RegExp(grep.pattern);
  return { grep: { files: grep.files, pattern: grep.pattern } };
}

function parseProbeList(op: "any" | "all", list: unknown, at: string): Probe {
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${at}: ${op} must list probes`);
  const probes = list.map((p, i) => parseProbe(p, `${at}.${op}[${i}]`));
  return op === "any" ? { any: probes } : { all: probes };
}

function parseProbe(raw: unknown, at: string): Probe {
  if (!isRecord(raw) || Object.keys(raw).length !== 1)
    throw new Error(`${at}: a probe is one of files, grep, any, all`);
  if ("files" in raw) {
    if (!isGlobs(raw.files)) throw new Error(`${at}: files must list globs`);
    return { files: raw.files };
  }
  if ("grep" in raw) return parseGrepProbe(raw.grep, at);
  if ("any" in raw) return parseProbeList("any", raw.any, at);
  if ("all" in raw) return parseProbeList("all", raw.all, at);
  throw new Error(`${at}: a probe is one of files, grep, any, all`);
}

/** Check a criterion's level, bar, statement, observations and version; `at` names it. */
function checkCriterionFields(c: Record<string, unknown>, at: string): void {
  if (!(LEVELS as readonly unknown[]).includes(c.level))
    throw new Error(`${at}: level must be ${LEVELS.join(" | ")}`);
  if (!(REQUIRES as readonly unknown[]).includes(c.requires))
    throw new Error(`${at}: requires must be ${REQUIRES.join(" | ")}`);
  if (typeof c.statement !== "string" || c.statement.trim() === "")
    throw new Error(`${at}: statement is required`);
  if (
    !Array.isArray(c.observe) ||
    c.observe.length === 0 ||
    c.observe.some((o) => typeof o !== "string")
  )
    throw new Error(`${at}: observe must list what to look for`);
  if (
    c.since !== undefined &&
    (typeof c.since !== "string" || !VERSION_PATTERN.test(c.since))
  )
    throw new Error(`${at}: since must be a version such as 1.2.0`);
}

/** Parse one criterion of `module`; `seen` holds the ids before it. */
function parseCriterion(
  c: unknown,
  at: string,
  module: string,
  seen: Set<string>,
): Criterion {
  if (!isRecord(c)) throw new Error(`${at}: must be a mapping`);
  for (const key of Object.keys(c))
    if (!CRITERION_KEYS.has(key)) throw new Error(`${at}: unknown key ${key}`);
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id))
    throw new Error(`${at}: id must be a kebab-case slug`);
  if (seen.has(c.id)) throw new Error(`${at}: duplicate id ${c.id}`);
  seen.add(c.id);
  const named = `${at} (${c.id})`;
  checkCriterionFields(c, named);
  return {
    key: `${module}/${c.id}`,
    id: c.id,
    level: c.level as Level,
    requires: c.requires as Requires,
    statement: (c.statement as string).trim(),
    observe: c.observe as string[],
    ...(c.probe === undefined
      ? {}
      : { probe: parseProbe(c.probe, `${named}.probe`) }),
    ...(c.since === undefined ? {} : { since: c.since as string }),
  };
}

/** Parse one module's criteria file; throws naming the first fault. */
export function parseModule(text: string, file: string): Module {
  const raw = load(text);
  if (!isRecord(raw)) throw new Error(`${file}: must be a mapping`);
  const { module, name, purpose, criteria } = raw;
  if (typeof module !== "string" || !/^M\d+$/.test(module))
    throw new Error(`${file}: module must be M<n>`);
  if (typeof name !== "string" || name === "")
    throw new Error(`${file}: name is required`);
  if (typeof purpose !== "string" || purpose.trim() === "")
    throw new Error(`${file}: purpose is required`);
  if (!Array.isArray(criteria))
    throw new Error(`${file}: criteria must be a list`);
  const seen = new Set<string>();
  const parsed = criteria.map((c, i) =>
    parseCriterion(c, `${file}: criteria[${i}]`, module, seen),
  );
  return { module, name, purpose: purpose.trim(), file, criteria: parsed };
}

function moduleNumber(name: string): number {
  return Number(/^M(\d+)/.exec(name)?.[1] ?? Number.NaN);
}

/**
 * Every module's criteria, in module order. Each file must declare the module
 * and name its file name gives (`M<n>-<name>.yaml`), and no module may have two
 * files: criterion keys would collide.
 */
export function loadModules(dir = CRITERIA_DIR): Module[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`criteria directory not found: ${dir}`);
  const seen = new Map<string, string>();
  return readdirSync(dir)
    .filter((f) => /^M\d+-.+\.ya?ml$/.test(f))
    .sort((a, b) => moduleNumber(a) - moduleNumber(b))
    .map((f) => {
      const module = parseModule(
        readFileSync(join(dir, f), "utf8"),
        join(dir, f),
      );
      if (f.replace(/\.ya?ml$/, "") !== `${module.module}-${module.name}`)
        throw new Error(
          `${join(dir, f)}: declares ${module.module} ${module.name}; name the file ${module.module}-${module.name}.yaml`,
        );
      const other = seen.get(module.module);
      if (other !== undefined)
        throw new Error(
          `${module.module} has two criteria files: ${other} and ${f}`,
        );
      seen.set(module.module, f);
      return module;
    });
}

export interface ProbeResult {
  /** `null` when the search could not read a file it needed. */
  met: boolean | null;
  /** Matched files when met; the search that found nothing when not; what went unread when unchecked. */
  evidence: string;
}

const GREP_LIMIT_BYTES = 1024 * 1024;

/**
 * Paths that hold examples or someone else's code rather than the
 * repository's own practice: test fixtures, copyable templates and vendored
 * or installed dependencies. A sample decision record in a test fixture is not
 * a decision record.
 */
const NOT_OWN_PRACTICE =
  /(^|\/)(fixtures?|__fixtures__|testdata|templates?|node_modules|vendor)\//i;

/** The tracked files a probe reads: the repository's own, not its examples. */
export function probedFiles(tracked: readonly string[]): string[] {
  return tracked.filter((f) => !NOT_OWN_PRACTICE.test(f));
}

/** Test a probe against the repository's tracked files. */
export function evaluateProbe(
  probe: Probe,
  files: readonly string[],
  root: string,
): ProbeResult {
  if ("files" in probe) {
    const matched = files.filter((f) =>
      probe.files.some((g) => matchGlob(g, f)),
    );
    return matched.length > 0
      ? { met: true, evidence: list(matched) }
      : {
          met: false,
          evidence: `no tracked file matches ${probe.files.join(", ")}`,
        };
  }
  if ("grep" in probe) return evaluateGrep(probe.grep, files, root);
  const results = ("any" in probe ? probe.any : probe.all).map((p) =>
    evaluateProbe(p, files, root),
  );
  const decisive = "any" in probe;
  const met = results.some((r) => r.met === decisive)
    ? decisive
    : results.some((r) => r.met === null)
      ? null
      : !decisive;
  const relevant = results.filter((r) => r.met === met);
  return { met, evidence: relevant.map((r) => r.evidence).join("; ") };
}

/** Search the tracked files a grep probe names; a file too large to read leaves it unchecked. */
function evaluateGrep(
  grep: { files: string[]; pattern: string },
  files: readonly string[],
  root: string,
): ProbeResult {
  const pattern = new RegExp(grep.pattern, "m");
  const matched: string[] = [];
  const unread: string[] = [];
  for (const f of files.filter((f) =>
    grep.files.some((g) => matchGlob(g, f)),
  )) {
    const path = join(root, f);
    // A tracked file deleted from the working tree has nothing to match.
    if (!existsSync(path)) continue;
    if (statSync(path).size > GREP_LIMIT_BYTES) unread.push(f);
    else if (pattern.test(readFileSync(path, "utf8"))) matched.push(f);
  }
  if (matched.length > 0) return { met: true, evidence: list(matched) };
  if (unread.length > 0)
    return {
      met: null,
      evidence: `${list(unread)} too large to search for /${grep.pattern}/`,
    };
  return {
    met: false,
    evidence: `no tracked ${grep.files.join(", ")} contains /${grep.pattern}/`,
  };
}

function list(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} (+${paths.length - 5} more)` : shown;
}

/** Whether an observed score meets a criterion's pass bar. */
export function meets(score: Score, requires: Requires): boolean {
  if (score === EXPECTED_ABSENT) return true;
  const rank = RUNGS.indexOf(score);
  return requires === "convention" ? rank >= 1 : score === "mechanical";
}

/** Rank of a score for comparing two runs; expected-absent sorts with met. */
export function rank(score: Score): number {
  return score === EXPECTED_ABSENT ? RUNGS.length : RUNGS.indexOf(score);
}

/** What a module attains: a level, `none`, or `n/a` when its practice does not apply. */
export type Attainment = Level | "none" | "n/a";

/**
 * The highest level a module attains: every criterion at that level and below
 * meets its bar. `none` when a Lite criterion fails; `n/a` when every
 * criterion is `expected-absent`, since a module whose practice the
 * repository's shape rules out attains nothing, not Strict; `null` when a
 * criterion it needs is not scored.
 */
export function attained(
  module: Module,
  scores: ReadonlyMap<string, Score>,
): Attainment | null {
  if (
    module.criteria.length > 0 &&
    module.criteria.every((c) => scores.get(c.key) === EXPECTED_ABSENT)
  )
    return "n/a";
  let reached: Level | "none" = "none";
  for (const level of LEVELS) {
    for (const c of module.criteria.filter((c) => c.level === level)) {
      const score = scores.get(c.key);
      if (score === undefined) return null;
      if (!meets(score, c.requires)) return reached;
    }
    reached = level;
  }
  return reached;
}
