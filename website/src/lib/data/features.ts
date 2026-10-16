/**
 * FEATURES.md: what a team gets from Jig, one section per feature. Each
 * section is Markdown prose followed by a list of fields: the skills that run
 * it, the practice (the modules that state it) and what is not built yet.
 * The field list closes the section. Not built yet is entries separated by
 * semicolons, each naming its roadmap work in parentheses, and its
 * parentheses hold nothing else: items by number ("item 4", "items 14 and
 * 15") or a group by name ("Later").
 */
import {
  listItems,
  moduleIds,
  paragraphs,
  sections,
  withoutTitle,
} from "../source.ts";

export interface Feature {
  title: string;
  /** The prose before the fields, Markdown. */
  body: string;
  /** Skill and agent names the Skills field links to, in order. */
  skills: string[];
  /** The Practice field, Markdown. */
  practice: string;
  /** Module ids the Practice field names, in order. */
  modules: string[];
  /** The Not built yet field, Markdown; empty when the feature is whole. */
  notBuilt: string;
  /** Roadmap item numbers the Not built yet field names. */
  roadmapItems: string[];
  /** Roadmap group names the Not built yet field names ("Later"). */
  roadmapGroups: string[];
}

export interface Features {
  /** The text before the first feature, Markdown. */
  intro: string;
  features: Feature[];
}

const FIELDS = ["Skills", "Practice", "Not built yet"] as const;
type Field = (typeof FIELDS)[number];

/** A field list item: `**Skills:** …` -> its name and the rest. */
function fieldOf(item: string): { field: Field; text: string } {
  const m = /^\*\*([^*]+?):\*\*\s*([\s\S]*)$/.exec(item);
  const field = FIELDS.find((f) => f === m?.[1]);
  if (!m || !field)
    throw new Error(
      `FEATURES.md: a field must be one of ${FIELDS.join(", ")}: ${item.split("\n")[0]}`,
    );
  return { field, text: m[2].replace(/\s*\n\s*/g, " ").trim() };
}

/**
 * The Skills field: Markdown links only, each labelled with the skill's name
 * and pointing into its folder or at the agent's file.
 */
function skillNames(title: string, text: string): string[] {
  const names: string[] = [];
  const rest = text.replace(
    /\[([^\]]*)\]\(([^)\s]*)\)/g,
    (link, label, dest) => {
      const m = /^plugin\/(?:skills\/([^/]+)\/[^/]+|agents\/([^/]+)\.md)$/.exec(
        dest,
      );
      const name = m?.[1] ?? m?.[2];
      if (!name || label !== `\`${name}\``)
        throw new Error(
          `FEATURES.md: "${title}" Skills must link \`name\` to plugin/skills/<name>/… or plugin/agents/<name>.md: ${link}`,
        );
      names.push(name);
      return "";
    },
  );
  if (!/^[\s,]*$/.test(rest))
    throw new Error(
      `FEATURES.md: "${title}" Skills holds more than links: ${rest.trim()}`,
    );
  return [...new Set(names)];
}

const ITEMS = /^items? ((?:\d+(?:,? and |, ))*\d+)$/;

/**
 * The roadmap work the Not built yet field names. The field is entries
 * separated by semicolons; every entry names its work in at least one
 * parenthetical, every parenthetical is a reference (item numbers or a
 * group), and every parenthesis is matched, so no entry renders without its
 * roadmap link.
 */
function roadmapRefs(
  title: string,
  text: string,
): { items: string[]; groups: string[] } {
  const items: string[] = [];
  const groups: string[] = [];
  const fail = (what: string) =>
    new Error(
      `FEATURES.md: "${title}" Not built yet must name roadmap work as (item N), (items N and M) or (Group): ${what}`,
    );
  for (const entry of text.split(";").map((e) => e.trim())) {
    if (!entry) continue;
    const parens = [...entry.matchAll(/\(([^()]*)\)/g)];
    if (!parens.length || /[()]/.test(entry.replace(/\([^()]*\)/g, "")))
      throw fail(entry);
    for (const [paren, inner = ""] of parens) {
      const ref = inner.trim();
      const m = ITEMS.exec(ref);
      if (m) items.push(...(m[1]?.match(/\d+/g) ?? []));
      else if (/^[A-Z][a-z]+$/.test(ref)) groups.push(ref);
      else throw fail(paren);
    }
  }
  return { items: [...new Set(items)], groups: [...new Set(groups)] };
}

/** What `listItems` (source.ts) starts an item on, at column zero. */
const ITEM = /^(?:[-*]|\d+\.)\s/;
/**
 * A line that Markdown would read as a list item (any CommonMark marker: `-`,
 * `*`, `+`, or one to nine digits with `.` or `)`, then a space or the end of
 * the line) or that opens a bold field label.
 */
const FIELD_SHAPED = /^(?:(?:[-*+]|\d{1,9}[.)])(?:\s|$)|\*\*[^*]+:\*\*)/;

/**
 * Splits a section at its field list, which must close it. The whole section
 * is a closed line grammar. Before the list, a line is prose at column zero
 * or a blank line; the first line that is indented, list-shaped or opens a
 * field label starts the list and must be a field item. In the list, a line
 * is a field item at column zero, an indented continuation of plain text, or
 * a blank line. A continuation that looks like a list item or a field fails,
 * so no field can hide before the list or inside another field.
 */
function fieldList(
  title: string,
  body: string,
): { prose: string; list: string } {
  const lines = body.split("\n");
  const at = lines.findIndex(
    (l) => /^\s+\S/.test(l) || FIELD_SHAPED.test(l.trim()),
  );
  if (at < 0) return { prose: body, list: "" };
  if (!ITEM.test(lines[at] ?? ""))
    throw new Error(
      `FEATURES.md: "${title}" has a list item, field or indented line in its prose: ${lines[at]}`,
    );
  for (const l of lines.slice(at)) {
    if (!l.trim() || ITEM.test(l)) continue;
    if (/^\S/.test(l))
      throw new Error(
        `FEATURES.md: "${title}" has text after its field list: ${l}`,
      );
    if (FIELD_SHAPED.test(l.trim()))
      throw new Error(
        `FEATURES.md: "${title}" continues a field with a list item or field: ${l}`,
      );
  }
  return {
    prose: lines.slice(0, at).join("\n"),
    list: lines.slice(at).join("\n"),
  };
}

function feature(title: string, body: string): Feature {
  const { prose: head, list } = fieldList(title, body);
  const fields = new Map<Field, string>();
  for (const item of listItems(list)) {
    const { field, text } = fieldOf(item.body);
    if (fields.has(field))
      throw new Error(`FEATURES.md: "${title}" has two ${field} fields`);
    fields.set(field, text);
  }
  const practice = fields.get("Practice") ?? "";
  if (!practice) throw new Error(`FEATURES.md: "${title}" has no Practice`);
  const notBuilt = fields.get("Not built yet") ?? "";
  const prose = paragraphs(head).join("\n\n");
  if (!prose) throw new Error(`FEATURES.md: "${title}" has no prose`);
  const refs = roadmapRefs(title, notBuilt);
  return {
    title,
    body: prose,
    skills: skillNames(title, fields.get("Skills") ?? ""),
    practice,
    modules: moduleIds(practice),
    notBuilt,
    roadmapItems: refs.items,
    roadmapGroups: refs.groups,
  };
}

export function parseFeatures(markdown: string): Features {
  const [head, ...rest] = sections(markdown);
  return {
    intro: withoutTitle(head?.body ?? "").trim(),
    features: rest.map((s) => feature(s.title, s.body)),
  };
}
