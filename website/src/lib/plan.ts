/**
 * A profile's plan: the modules it targets, in the order to adopt them,
 * each with its level (or the condition under which it applies), and what
 * it leaves for later.
 */
import { modules, profiles } from "./data/index.ts";
import { LEVEL_NAME, type Level } from "./data/modules.ts";
import { levelRank } from "./view.ts";

export interface PlanRow {
  pos: number;
  id: string;
  title: string;
  level: Level;
  label: string;
  rank: number;
  when: string;
}

export interface Plan {
  id: string;
  name: string;
  rows: PlanRow[];
  skipped: { id: string; title: string }[];
  countNote: string;
}

export function plans(): Plan[] {
  const p = profiles();
  const title = new Map(modules().map((m) => [m.id, m.title]));
  return p.profiles.map((prof) => {
    const rows: PlanRow[] = [];
    const skipped: { id: string; title: string }[] = [];
    for (const id of p.order) {
      const target = prof.targets[id];
      const cond = prof.conditional[id];
      const level = target ?? cond?.level;
      if (!level) {
        skipped.push({ id, title: title.get(id) ?? id });
        continue;
      }
      rows.push({
        pos: rows.length + 1,
        id,
        title: title.get(id) ?? id,
        level,
        label: LEVEL_NAME[level],
        rank: levelRank(level),
        when: !target && cond ? cond.when : "",
      });
    }
    return {
      id: prof.id,
      name: prof.name,
      rows,
      skipped,
      countNote: `${rows.length} of ${p.order.length} modules, in the default order`,
    };
  });
}
