/**
 * The module map's rows: every module in id order, with each level's state
 * under every profile, and a note per profile. Each cell
 * carries all its states so the profile switch (scripts/map.ts) only moves
 * attributes; without it the map shows the first profile.
 */
import { modules, profiles, skillActor } from "./data/index.ts";
import { LEVEL_NAME, LEVELS, type Level } from "./data/modules.ts";
import { mdInline } from "./markdown.ts";
import { jobTags } from "./view.ts";

type State = "on" | "cond" | "off";

const MEANING: Record<State, string> = {
  on: "target",
  cond: "target when a condition holds",
  off: "not targeted",
};

const rank = (l: Level) => LEVELS.indexOf(l);

function stateOf(id: string, profileIndex: number, level: Level): State {
  const prof = profiles().profiles[profileIndex];
  const target = prof?.targets[id];
  const cond = prof?.conditional[id];
  if (target && rank(level) <= rank(target)) return "on";
  if (cond && rank(level) <= rank(cond.level)) return "cond";
  return "off";
}

function noteOf(id: string, profileIndex: number): string {
  const prof = profiles().profiles[profileIndex];
  if (!prof) return "";
  const target = prof.targets[id];
  const cond = prof.conditional[id];
  if (target) return `${prof.name} aims for ${LEVEL_NAME[target]}`;
  if (cond)
    return `${prof.name}: ${LEVEL_NAME[cond.level]}, only if ${cond.when}`;
  return `Not in ${prof.name}: skip until it hurts`;
}

export async function mapRows() {
  const p = profiles();
  const byId = new Map(modules().map((m) => [m.id, m]));
  const ids = [...p.order].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
  return Promise.all(
    ids.map(async (id) => {
      const m = byId.get(id);
      if (!m)
        throw new Error(
          `profiles.yaml orders ${id}, which modules/README.md does not list`,
        );
      return {
        id,
        title: m.title,
        area: await mdInline(m.area, "modules/README.md"),
        skills: m.skills.map(skillActor),
        jobs: jobTags(id),
        cells: LEVELS.map((level) => {
          const states = p.profiles.map((_, pi) => stateOf(id, pi, level));
          return { level, states, label: MEANING[states[0] ?? "off"] };
        }),
        notes: p.profiles.map((_, pi) => noteOf(id, pi)),
      };
    }),
  );
}

/** Each profile with how many modules it targets, outright and on a condition. */
export function mapSummary() {
  const p = profiles();
  const total = p.order.length;
  return {
    profiles: p.profiles,
    total,
    counts: p.profiles.map((prof) => Object.keys(prof.targets).length),
    lines: p.profiles.map((prof, i) => {
      const count = Object.keys(prof.targets).length;
      const conds = Object.keys(prof.conditional).length;
      const more = conds ? `, ${conds} more if a condition holds` : "";
      const rest = i === 0 ? " Everything else: skip until it hurts." : "";
      return `${prof.name}: ${count} of ${total} modules${more}.${rest}`;
    }),
  };
}
