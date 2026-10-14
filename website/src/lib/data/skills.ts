/**
 * The plugin's skills and agents, from the tables in plugin/README.md: the
 * name, what it does and how it is invoked.
 */
import { tableRows } from "../source.ts";

export interface Skill {
  name: string;
  /** What it does, Markdown. */
  purpose: string;
  /** `/jig:drive-pr`, or `jig:review-arbiter` for an agent. */
  command: string;
  agent: boolean;
  /** The document the table links, from plugin/: its human page. */
  source: string;
}

function rows(markdown: string, header: string, agent: boolean): Skill[] {
  const at = markdown.indexOf(header);
  if (at < 0) return [];
  const table = markdown.slice(at).split(/\n\s*\n/)[0] ?? "";
  return tableRows(table).flatMap(([name = "", purpose = "", invoke = ""]) => {
    const m = /^\[([a-z-]+)\]\(([^)]+)\)$/.exec(name);
    const command = /`([^`]+)`/.exec(invoke)?.[1];
    if (!m?.[1] || !m[2] || !command) return [];
    return [{ name: m[1], purpose, command, agent, source: `plugin/${m[2]}` }];
  });
}

export function parseSkills(pluginReadme: string): Skill[] {
  return [
    ...rows(pluginReadme, "| Skill |", false),
    ...rows(pluginReadme, "| Agent |", true),
  ];
}
