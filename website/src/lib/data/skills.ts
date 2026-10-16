/**
 * The plugin's skills and agents, from the tables in plugin/README.md: the
 * name, what it does, how it is invoked and how it works with the others. The
 * skills are in family tables, each introduced by a bold line naming the
 * family; the order of the tables and of the rows is the order shown.
 */
import { tableRows } from "../source.ts";

export interface Family {
  name: string;
  /** How the family's skills fit together, Markdown. */
  blurb: string;
}

export interface Skill {
  name: string;
  /** What it does, Markdown. */
  purpose: string;
  /** `/jig:drive-pr`, or `jig:review-arbiter` for an agent. */
  command: string;
  agent: boolean;
  /** The document the table links, from plugin/: its human page. */
  source: string;
  /** How it connects to the other skills, Markdown; empty when the table has no such column. */
  relations: string;
  /** The family table the skill is in; none for an agent. */
  family?: Family;
}

function rows(
  table: string,
  agent: boolean,
  family: Family | undefined,
): Skill[] {
  return tableRows(table).flatMap(
    ([name = "", purpose = "", invoke = "", relations = ""]) => {
      const m = /^\[([a-z-]+)\]\(([^)]+)\)$/.exec(name);
      const command = /`([^`]+)`/.exec(invoke)?.[1];
      if (!m?.[1] || !m[2] || !command) return [];
      return [
        {
          name: m[1],
          purpose,
          command,
          agent,
          source: `plugin/${m[2]}`,
          relations,
          ...(family ? { family } : {}),
        },
      ];
    },
  );
}

export function parseSkills(pluginReadme: string): Skill[] {
  const blocks = pluginReadme.split(/\n\s*\n/);
  const out: Skill[] = [];
  blocks.forEach((block, i) => {
    const head = block.trimStart();
    if (head.startsWith("| Agent |")) out.push(...rows(block, true, undefined));
    if (!head.startsWith("| Skill |")) return;
    const intro = /^\*\*(.+?)\.\*\*\s*([\s\S]*)$/.exec(
      (blocks[i - 1] ?? "").trim(),
    );
    const family = intro?.[1]
      ? { name: intro[1], blurb: (intro[2] ?? "").replace(/\s*\n\s*/g, " ") }
      : undefined;
    out.push(...rows(block, false, family));
  });
  return out;
}
