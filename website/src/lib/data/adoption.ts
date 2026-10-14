/**
 * The two adoption guides: the brownfield ladder, its constraints and the
 * coverage-gate grandfathering pattern (adoption/brownfield.md), and the greenfield kickoff's phases, three moves
 * and reasoning (adoption/greenfield.md).
 */
import {
  leadOf,
  listItems,
  moduleIds,
  paragraphs,
  section,
  sections,
  tableRows,
  withoutTitle,
} from "../source.ts";

export interface Step {
  n: number;
  /** The step's bold lead. */
  lead: string;
  /** The whole step, Markdown, lead included. */
  body: string;
}

const steps = (markdown: string): Step[] =>
  listItems(markdown).map((i) => ({
    n: i.n,
    lead: leadOf(i.text),
    body: i.body,
  }));

export interface Brownfield {
  intro: string;
  ladder: Step[];
  constraints: string;
  grandfathering: string;
}

export function parseBrownfield(markdown: string): Brownfield {
  const parts = sections(markdown);
  return {
    intro: withoutTitle(parts[0]?.body ?? "").trim(),
    ladder: steps(section(parts, "The ladder")),
    constraints: section(parts, "Constraints"),
    grandfathering: section(parts, "Grandfathering a coverage gate"),
  };
}

export interface Phase {
  n: string;
  /** The phase's name, Markdown. */
  name: string;
  produces: string;
  /** The module mapping cell, Markdown, as written. */
  mapsTo: string;
  modules: string[];
  /** The phase runs in a fresh agent session. */
  fresh: boolean;
}

export interface Greenfield {
  intro: string;
  phasesLead: string;
  phases: Phase[];
  /** The paragraph after the phase table: tiers to profiles. */
  tiers: string;
  movesTitle: string;
  moves: Step[];
  whyTitle: string;
  why: string;
}

export function parseGreenfield(markdown: string): Greenfield {
  const parts = sections(markdown);
  const table = section(parts, "The 11 kickoff phases");
  const around = paragraphs(table);
  const moves = parts.find((s) => s.title.startsWith("The shape"));
  const why = parts.find((s) => s.title.startsWith("Why"));
  return {
    intro: withoutTitle(parts[0]?.body ?? "").trim(),
    phasesLead: around[0] ?? "",
    phases: tableRows(table).flatMap(
      ([name = "", produces = "", mapsTo = ""]) => {
        const m = /^(\d+)\.\s+(.*)$/.exec(name);
        if (!m?.[1]) return [];
        return [
          {
            n: m[1],
            name: m[2] ?? "",
            produces,
            mapsTo,
            modules: moduleIds(mapsTo.replace(/\]\([^)]*\)/g, "]")),
            fresh: /fresh session/i.test(name),
          },
        ];
      },
    ),
    tiers: around[1] ?? "",
    movesTitle: moves?.title ?? "",
    moves: steps(moves?.body ?? ""),
    whyTitle: why?.title ?? "",
    why: why?.body ?? "",
  };
}
