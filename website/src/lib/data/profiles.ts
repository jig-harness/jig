/**
 * The profiles: their targets and the adoption order from the audit skill's
 * profiles.yaml, and their choosing question and reasoning from
 * profiles/README.md.
 */
import { parse } from "yaml";
import type { Level } from "./modules.ts";
import { section, sections, tableRows } from "../source.ts";
import { isRecord } from "../../../../lib/record.ts";

export interface Conditional {
  level: Level;
  when: string;
}

export interface Profile {
  /** `team-standard` */
  id: string;
  /** `Team/Standard` */
  name: string;
  targets: Record<string, Level>;
  conditional: Record<string, Conditional>;
  /** The choosing table's question, Markdown. */
  question: string;
  /** The reasoning section, Markdown. */
  rationale: string;
}

export interface Profiles {
  profiles: Profile[];
  /** Every module, in the order to adopt them. */
  order: string[];
  /** The README's text before its first section, Markdown. */
  intro: string;
  /** The line under the choosing table. */
  graduate: string;
}

/**
 * A target level. An unknown one fails the build: the plan and the map read a
 * module without a target as one to skip, so dropping it would publish a
 * lighter plan than the profile sets.
 */
function asLevel(v: unknown, where: string): Level {
  if (v === "lite" || v === "standard" || v === "strict") return v;
  throw new Error(`profiles.yaml: ${where} has level ${JSON.stringify(v)}`);
}

/** A module key a profile names: one the criteria declare. */
function moduleKey(id: string, where: string, known: Set<string>): string {
  if (!known.has(id))
    throw new Error(
      `profiles.yaml: ${where} names ${id}, which has no criteria`,
    );
  return id;
}

/** A profile's targets; the field is optional, as the audit reads it. */
function targetsOf(
  raw: unknown,
  profile: string,
  known: Set<string>,
): Record<string, Level> {
  if (raw === undefined) return {};
  if (!isRecord(raw))
    throw new Error(`profiles.yaml: ${profile}.targets is not a map`);
  const out: Record<string, Level> = {};
  for (const [id, level] of Object.entries(raw))
    out[moduleKey(id, `${profile}.targets`, known)] = asLevel(
      level,
      `${profile}.targets.${id}`,
    );
  return out;
}

function conditionalOf(
  raw: unknown,
  profile: string,
  known: Set<string>,
): Record<string, Conditional> {
  if (raw === undefined) return {};
  if (!isRecord(raw))
    throw new Error(`profiles.yaml: ${profile}.conditional is not a map`);
  const out: Record<string, Conditional> = {};
  for (const [id, c] of Object.entries(raw)) {
    const where = `${profile}.conditional.${id}`;
    moduleKey(id, `${profile}.conditional`, known);
    if (!isRecord(c) || typeof c.when !== "string" || !c.when.trim())
      throw new Error(
        `profiles.yaml: ${where} needs a \`level\` and a \`when\``,
      );
    out[id] = { level: asLevel(c.level, where), when: c.when };
  }
  return out;
}

/**
 * The adoption order: every module the criteria declare, once. The plan is
 * assembled by walking it, so a missing module would drop out of every plan
 * and a repeated one would be planned twice.
 */
function orderOf(raw: unknown, known: Set<string>): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length !== known.size ||
    !raw.every((m) => typeof m === "string" && known.has(m)) ||
    new Set(raw).size !== raw.length
  )
    throw new Error("profiles.yaml: `order` must list every module once");
  return raw as string[];
}

/**
 * The profiles file, held to the audit's own contract for it (its loader,
 * plugin/skills/audit/scripts/lib/profiles.ts, is the test oracle);
 * `modules` are the modules the criteria declare.
 */
export function parseProfiles(
  yamlText: string,
  readme: string,
  modules: readonly string[],
): Profiles {
  const doc: unknown = parse(yamlText);
  if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.profiles))
    throw new Error("profiles.yaml needs `version: 1` and a `profiles` map");
  const known = new Set(modules);
  const parts = sections(readme);
  const choosing = section(parts, "Choosing");
  const questions = tableRows(choosing);
  const profiles = Object.entries(doc.profiles).map(([id, p]) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
      throw new Error(`profiles.yaml: ${id} is not a kebab-case profile id`);
    if (!isRecord(p)) throw new Error(`profiles.yaml: ${id} is not a map`);
    if (typeof p.name !== "string" || !p.name.trim())
      throw new Error(`profiles.yaml: ${id} has no \`name\``);
    const name = p.name;
    const targets = targetsOf(p.targets, id, known);
    const conditional = conditionalOf(p.conditional, id, known);
    const both = Object.keys(conditional).find((m) => m in targets);
    if (both)
      throw new Error(
        `profiles.yaml: ${id} has ${both} as both a target and conditional`,
      );
    return {
      id,
      name,
      targets,
      conditional,
      question:
        questions.find(([, answer = ""]) => answer.startsWith(name))?.[0] ?? "",
      rationale: parts.find((s) => s.title === name)?.body ?? "",
    };
  });
  const graduate =
    choosing
      .split("\n")
      .find((l) => l.startsWith("Graduate"))
      ?.trim() ?? "";
  return {
    profiles,
    order: orderOf(doc.order, known),
    intro: (parts[0]?.body ?? "").replace(/^# .+\n/, "").trim(),
    graduate,
  };
}
