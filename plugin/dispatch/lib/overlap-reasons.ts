/**
 * What a person reads of overlap: the structured reason a waiting pickup
 * carries, the note beside a pickup whose footprint is unknown, the
 * hotspot proposal, and the repository report's overlap part
 * (design/overlap-aware-admission.md § The reason a person sees).
 */
import { isoFromMs } from "../../shared/time.ts";
import type { OverlapReason, OverlapRef } from "./dashboard-contract.ts";
import type { InFlight, Placed, Tier } from "./overlap.ts";

/** One wanted pickup as the overlap walk weighed it. */
export interface OverlapEntry {
  item: string;
  /** Its place in the plan's rank order, from 1. */
  rank: number;
  /** Its place in the walk, tier by tier, from 1. */
  turn: number;
  tier: Tier;
  /** Expected conflict resolution rounds, to two decimals. */
  cost: number;
  promoted?: true;
  patienceSpent?: true;
  /** When it first waited on overlap, while it waits. */
  waitingSince?: string;
  /** Where its footprint came from: `pickup`, `scout`, `planner`, `filing`, `labels` or `unknown`. */
  footprint: string;
  /** `footprint unknown: …` for a footprint unknown or from labels alone. */
  footprintNote?: string;
  reason?: OverlapReason;
}

/** A file that kept work over the overlap bound in enough ticks of one day. */
export interface OverlapHotspot {
  path: string;
  day: string;
  ticks: number;
  proposal: string;
}

/** The repository report's overlap part. Reported only: it changes nothing the tick starts. */
export interface OverlapReport {
  rates: { measuredAt: string | null; defaulted: string | null };
  inFlight: { pullRequests: number; pickups: number; unknown: string[] };
  entries: OverlapEntry[];
  hotspots: OverlapHotspot[];
  /** Facts read short this tick: the catalog, the footprints, the kept waits. */
  notes: string[];
}

/** The ticks of one day a file must keep work over the bound before the receipt proposes serializing it. */
export const HOTSPOT_TICKS = 3;

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function refOf(work: InFlight): OverlapRef {
  return { kind: work.kind, ref: work.ref, state: work.state, url: work.url };
}

function rounds(cost: number): string {
  const shown = Number(cost.toFixed(1)).toString();
  return `${shown} round${shown === "1" ? "" : "s"} expected`;
}

/** A moment as the reason names it: the time of day in UTC, with the date when it is not today's. */
export function whenText(ms: number, nowMs: number): string {
  const at = isoFromMs(ms);
  const day = at.slice(0, 10);
  const time = `${at.slice(11, 16)} UTC`;
  return day === isoFromMs(nowMs).slice(0, 10) ? time : `${day} ${time}`;
}

function overlapReason(p: Placed, nowMs: number): OverlapReason {
  const { evaluation } = p;
  const from =
    p.patienceEndsMs === null
      ? ""
      : `, or from ${whenText(p.patienceEndsMs, nowMs)}`;
  const tail = `${rounds(evaluation.cost)}; first when a slot is free after work that does not overlap${from}`;
  if (evaluation.unknown)
    return {
      relation: "waits on overlap",
      item: p.candidate.item,
      on: [],
      count: 0,
      text: `waits on overlap: its footprint is unknown; ${tail}`,
    };
  const units = new Map<string, number>();
  for (const share of evaluation.shares)
    for (const unit of share.units)
      units.set(unit.path, Math.max(units.get(unit.path) ?? 0, unit.rate));
  const paths = [...units]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([path]) => path);
  const more = paths.length > 1 ? ` (+${paths.length - 1})` : "";
  const on = evaluation.shares.map((s) => refOf(s.work));
  return {
    relation: "waits on overlap",
    item: p.candidate.item,
    on,
    count: on.length,
    text: `waits on overlap: shares ${paths[0] ?? "a path"}${more} with ${list(on.map((r) => `${r.ref} (${r.kind})`))}; ${tail}`,
  };
}

function boundReason(p: Placed): OverlapReason {
  const bound = p.evaluation.bound;
  const work = bound?.work ?? [];
  const on = work.map(refOf);
  return {
    relation: "waits on the overlap bound",
    item: p.candidate.item,
    on,
    count: on.length,
    text: `waits on the overlap bound: ${on.length} in flight already change ${bound?.path ?? "one of its files"} (${on.map((r) => r.ref).join(", ")}); starts when no other work can take a slot`,
  };
}

/** Why a pickup waits, for a tier-2 or tier-3 pickup; `null` in tier 1. */
export function reasonOf(p: Placed, nowMs: number): OverlapReason | null {
  if (p.tier === 3) return boundReason(p);
  if (p.tier === 2) return overlapReason(p, nowMs);
  return null;
}

/** The note beside the rank of a pickup whose footprint is unknown or from labels alone; `null` otherwise. */
export function footprintNote(reading: {
  source: string;
  areas: readonly string[];
  reason?: string;
  failure?: { class: string; reason?: string };
}): string | null {
  if (reading.source === "labels")
    return `footprint unknown: no footprint record; derived from its area labels (${reading.areas.join(", ")})`;
  if (reading.source !== "unknown") return null;
  if (reading.failure !== undefined)
    return `footprint unknown: its footprint did not read (${reading.failure.class}${reading.failure.reason === undefined ? "" : `: ${reading.failure.reason}`})`;
  if (reading.reason !== undefined)
    return `footprint unknown: its footprint was not read this tick (${reading.reason})`;
  return "footprint unknown: no footprint record and no area label";
}

/** One placed pickup as the report keeps it. */
export function entryOf(
  p: Placed,
  turn: number,
  footprint: { source: string; note: string | null },
  nowMs: number,
): OverlapEntry {
  const reason = reasonOf(p, nowMs);
  return {
    item: p.candidate.item,
    rank: p.rank + 1,
    turn,
    tier: p.tier,
    cost: Math.round(p.evaluation.cost * 100) / 100,
    ...(p.promoted ? { promoted: true as const } : {}),
    ...(p.patienceSpent ? { patienceSpent: true as const } : {}),
    ...(p.wait === null ? {} : { waitingSince: isoFromMs(p.wait.sinceMs) }),
    footprint: footprint.source,
    ...(footprint.note === null ? {} : { footprintNote: footprint.note }),
    ...(reason === null ? {} : { reason }),
  };
}

/** The receipt's proposal for a file that kept work over the bound in `ticks` ticks of `day`. */
export function hotspotProposal(
  path: string,
  day: string,
  ticks: number,
): string {
  return `${path} kept work over the overlap bound in ${ticks} ticks on ${day}: resolve-conflicts' \`history.ts --propose-serialize\` proposes the serialized area a person may add to the change-area catalog`;
}

/** The overlap part of a repository's report, as the terminal reads it. */
export function overlapLines(o: OverlapReport | undefined): string[] {
  if (o === undefined) return [];
  const rates =
    o.rates.defaulted ??
    `conflict rates measured at ${o.rates.measuredAt ?? "an unknown time"}`;
  const unknown =
    o.inFlight.unknown.length === 0
      ? ""
      : `; footprint unknown: ${o.inFlight.unknown.join(", ")}`;
  return [
    `  overlap  in flight: ${o.inFlight.pullRequests} pull request(s), ${o.inFlight.pickups} pickup(s)${unknown}; ${rates}`,
    ...o.entries.map((e) => {
      const how = e.promoted
        ? ", promoted past the bound"
        : e.patienceSpent
          ? ", patience spent"
          : "";
      const why = e.reason === undefined ? "" : `: ${e.reason.text}`;
      const note = e.footprintNote === undefined ? "" : ` [${e.footprintNote}]`;
      return `  overlap  ${e.item} (rank ${e.rank}) tier ${e.tier}, ${e.cost} round(s)${how}${why}${note}`;
    }),
    ...o.hotspots.map((h) => `  hotspot  ${h.proposal}`),
    ...o.notes.map((n) => `  overlap  ${n}`),
  ];
}
