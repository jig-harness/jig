/**
 * Profiles as targets (`profiles.yaml` beside the skill): the level each
 * profile aims for per module, and the order modules are adopted in. A gap is
 * what lies between the level a module attains and its target.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { load } from "../../../../shared/yaml.ts";
import {
  type Attainment,
  attained,
  type Criterion,
  LEVELS,
  type Level,
  meets,
  type Module,
  type Score,
} from "./criteria.ts";
import { skillDir } from "./repo.ts";

export interface Conditional {
  level: Level;
  /** What must hold for the target to apply, in the team's words. */
  when: string;
}

export interface Profile {
  id: string;
  name: string;
  targets: ReadonlyMap<string, Level>;
  conditional: ReadonlyMap<string, Conditional>;
}

export interface Profiles {
  profiles: ReadonlyMap<string, Profile>;
  /** Every module, in adoption order. */
  order: readonly string[];
}

export const PROFILES_FILE = join(skillDir(), "profiles.yaml");

const MODULE = /^M\d+$/;

function level(value: unknown, at: string): Level {
  if (!LEVELS.includes(value as Level))
    throw new Error(`${at}: a level is ${LEVELS.join(", ")}`);
  return value as Level;
}

function parseTargets(raw: unknown, at: string): Map<string, Level> {
  if (raw === undefined) return new Map();
  if (!isMapping(raw)) throw new Error(`${at}: must be a mapping`);
  return new Map(
    Object.entries(raw).map(([m, l]) => {
      if (!MODULE.test(m)) throw new Error(`${at}: ${m} is not a module`);
      return [m, level(l, `${at}.${m}`)];
    }),
  );
}

function parseConditional(raw: unknown, at: string): Map<string, Conditional> {
  if (raw === undefined) return new Map();
  if (!isMapping(raw)) throw new Error(`${at}: must be a mapping`);
  return new Map(
    Object.entries(raw).map(([m, c]) => {
      if (!MODULE.test(m)) throw new Error(`${at}: ${m} is not a module`);
      if (!isMapping(c) || typeof c.when !== "string" || c.when.trim() === "")
        throw new Error(`${at}.${m}: needs a level and a when`);
      return [m, { level: level(c.level, `${at}.${m}.level`), when: c.when }];
    }),
  );
}

function parseProfile(id: string, raw: unknown, at: string): Profile {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
    throw new Error(`${at}: a profile id is a kebab-case slug`);
  if (!isMapping(raw)) throw new Error(`${at}: must be a mapping`);
  if (typeof raw.name !== "string" || raw.name.trim() === "")
    throw new Error(`${at}: name is required`);
  const targets = parseTargets(raw.targets, `${at}.targets`);
  const conditional = parseConditional(raw.conditional, `${at}.conditional`);
  for (const m of conditional.keys())
    if (targets.has(m))
      throw new Error(`${at}: ${m} is both a target and conditional`);
  return { id, name: raw.name, targets, conditional };
}

/** Parse the profiles file; `modules` are the modules the criteria declare. */
export function parseProfiles(
  text: string,
  file: string,
  modules: readonly string[],
): Profiles {
  const raw = load(text);
  if (!isMapping(raw) || raw.version !== 1)
    throw new Error(`${file}: must be a mapping with version: 1`);
  if (!isMapping(raw.profiles))
    throw new Error(`${file}: profiles is required`);
  const profiles = new Map(
    Object.entries(raw.profiles).map(([id, p]) => [
      id,
      parseProfile(id, p, `${file}: profiles.${id}`),
    ]),
  );
  const known = new Set(modules);
  for (const p of profiles.values())
    for (const m of [...p.targets.keys(), ...p.conditional.keys()])
      if (!known.has(m))
        throw new Error(
          `${file}: profiles.${p.id} names ${m}, which has no criteria`,
        );
  const order = raw.order;
  if (
    !Array.isArray(order) ||
    order.length !== known.size ||
    !order.every((m) => typeof m === "string" && known.has(m)) ||
    new Set(order).size !== order.length
  )
    throw new Error(`${file}: order must list every module once`);
  return { profiles, order: order as string[] };
}

/** The shipped profiles. */
export function loadProfiles(
  modules: readonly Module[],
  file = PROFILES_FILE,
): Profiles {
  return parseProfiles(
    readFileSync(file, "utf8"),
    file,
    modules.map((m) => m.module),
  );
}

/**
 * The level each module aims for: the profile's targets, plus each
 * conditional target whose module is in `conditions`.
 */
export function targetsFor(
  profile: Profile,
  conditions: readonly string[] = [],
): Map<string, Level> {
  const targets = new Map(profile.targets);
  for (const m of conditions) {
    const c = profile.conditional.get(m);
    if (c) targets.set(m, c.level);
  }
  return targets;
}

export interface ModuleGap {
  module: Module;
  attained: Attainment | null;
  /** `null` when the profile sets no target, or the module does not apply. */
  target: Level | null;
  /** The criteria at or below the target that do not meet their bar yet. */
  missing: Criterion[];
}

/** Each module's gap to its target, in adoption order. */
export function gaps(
  modules: readonly Module[],
  scores: ReadonlyMap<string, Score>,
  targets: ReadonlyMap<string, Level>,
  order: readonly string[],
): ModuleGap[] {
  const rank = (m: Module) => order.indexOf(m.module);
  return [...modules]
    .sort((a, b) => rank(a) - rank(b))
    .map((module) => {
      const reached = attained(module, scores);
      const wanted = targets.get(module.module) ?? null;
      const target = reached === "n/a" ? null : wanted;
      const upTo = target === null ? -1 : LEVELS.indexOf(target);
      const missing = module.criteria.filter((c) => {
        if (LEVELS.indexOf(c.level) > upTo) return false;
        const score = scores.get(c.key);
        return score === undefined || !meets(score, c.requires);
      });
      return { module, attained: reached, target, missing };
    });
}

/**
 * The level each module must be examined to under `profile`: its targets
 * with the conditions that apply, raised to `heading`'s where the profile the
 * project grows toward reaches further. A criterion beyond these may be left
 * `not-examined`; one within them must be scored.
 */
export function examinedTargets(
  profile: Profile,
  conditions: readonly string[] = [],
  heading?: Profile,
): Map<string, Level> {
  const targets = targetsFor(profile, conditions);
  if (heading)
    for (const [m, l] of targetsFor(heading, conditions)) {
      const own = targets.get(m);
      if (own === undefined || LEVELS.indexOf(l) > LEVELS.indexOf(own))
        targets.set(m, l);
    }
  return targets;
}

/** Whether `criterion` lies beyond `targets`: its module has none, or aims lower. */
export function beyondTarget(
  criterion: Criterion,
  targets: ReadonlyMap<string, Level>,
): boolean {
  const target = targets.get(criterion.key.split("/")[0] ?? "");
  return (
    target === undefined ||
    LEVELS.indexOf(criterion.level) > LEVELS.indexOf(target)
  );
}

/**
 * The profiles a selection names, or why it does not hold: an unknown
 * profile, or a condition neither the profile nor the heading-to profile
 * makes conditional.
 */
export function selectProfiles(
  profiles: Profiles,
  selection: {
    profile: string;
    conditions?: readonly string[];
    heading_to?: string;
  },
): { profile: Profile; heading?: Profile } | { error: string } {
  const known = [...profiles.profiles.keys()].join(", ");
  const profile = profiles.profiles.get(selection.profile);
  if (!profile)
    return { error: `profile ${selection.profile} is not one of ${known}` };
  const heading =
    selection.heading_to === undefined
      ? undefined
      : profiles.profiles.get(selection.heading_to);
  if (selection.heading_to !== undefined && !heading)
    return {
      error: `heading-to ${selection.heading_to} is not one of ${known}`,
    };
  const stray = (selection.conditions ?? []).filter(
    (m) => !profile.conditional.has(m) && !heading?.conditional.has(m),
  );
  if (stray.length > 0)
    return {
      error: `${heading ? `neither ${profile.name} nor ${heading.name} has a` : `${profile.name} has no`} conditional target for ${stray.join(", ")}`,
    };
  return heading ? { profile, heading } : { profile };
}
