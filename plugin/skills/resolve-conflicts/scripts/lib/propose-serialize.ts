/**
 * The serialized areas the history report proposes (`history.ts
 * --propose-serialize`): each conflict hotspot that exactly one area of the
 * repository's change-area catalog holds points at that area, and an area
 * one or more hotspots point at, not yet serialized, is printed as the
 * catalog lines a person would add (`serialize: true`), each with the
 * hotspots behind it. A hotspot no area holds, or more than one does, is
 * listed beside them, since which area its conflicts belong to is a
 * person's call. Nothing is written: the catalog changes through a person,
 * and the dispatcher never adds an area of its own.
 */
import {
  areasOf,
  type ChangeAreaCatalog,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { PathSummary } from "./report.ts";

/** One area to serialize, and the hotspots that point at it. */
interface ProposedArea {
  area: string;
  hotspots: Array<{ path: string; merges: number }>;
}

export interface Proposal {
  /** The catalog the areas are proposed for. */
  catalog: string;
  /** The areas to serialize, in catalog order. */
  propose: ProposedArea[];
  /** Areas hotspots point at that the catalog already serializes. */
  already: string[];
  /** Hotspots no single area holds, each with why. */
  unplaced: Array<{ path: string; why: string }>;
}

/** The areas to propose from the report's hotspots. */
export function proposeSerialize(
  paths: readonly PathSummary[],
  catalog: ChangeAreaCatalog,
  where: string,
): Proposal {
  const pointed = new Map<string, ProposedArea["hotspots"]>();
  const unplaced: Proposal["unplaced"] = [];
  for (const p of paths.filter((x) => x.hotspot)) {
    const areas = areasOf(p.path, catalog);
    if (areas.length === 1) {
      const area = areas[0] as string;
      pointed.set(area, [
        ...(pointed.get(area) ?? []),
        { path: p.path, merges: p.merges },
      ]);
    } else
      unplaced.push({
        path: p.path,
        why:
          areas.length === 0
            ? "no area of the catalog holds it"
            : `more than one area holds it (${areas.join(", ")})`,
      });
  }
  const order = [...catalog.keys()].filter((k) => pointed.has(k));
  return {
    catalog: where,
    propose: order
      .filter((k) => catalog.get(k)?.serialize !== true)
      .map((area) => ({ area, hotspots: pointed.get(area) ?? [] })),
    already: order.filter((k) => catalog.get(k)?.serialize === true),
    unplaced,
  };
}

const merges = (n: number) => `${n} merge${n === 1 ? "" : "s"}`;

/** The proposal as the catalog lines a person would add, and what it leaves out. */
export function renderProposal(proposal: Proposal, range: string): string {
  const lines: string[] = [];
  if (proposal.propose.length === 0)
    lines.push(`No area to propose serializing from the hotspots of ${range}.`);
  else {
    lines.push(
      `Areas to serialize, from the hotspots of ${range}. Add these lines under each area in ${proposal.catalog}; nothing was written:`,
      "",
      "areas:",
    );
    for (const p of proposal.propose)
      lines.push(
        `  ${p.area}:`,
        `    serialize: true  # hotspots: ${p.hotspots.map((h) => `${h.path} (${merges(h.merges)})`).join(", ")}`,
      );
  }
  if (proposal.already.length > 0)
    lines.push("", `Already serialized: ${proposal.already.join(", ")}.`);
  if (proposal.unplaced.length > 0) {
    lines.push("", "Hotspots no single area holds (not proposed):");
    for (const u of proposal.unplaced) lines.push(`  ${u.path}: ${u.why}`);
  }
  return lines.join("\n");
}
