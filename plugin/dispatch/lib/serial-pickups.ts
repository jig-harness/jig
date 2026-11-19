/**
 * Serialized areas hold pickups (design/overlap-aware-admission.md § Hard
 * holds stay declared, build step 7). A serialized area of the change-area
 * catalog holds the drives of its pull requests one at a time
 * (`contention.ts`); it also holds a planned pickup whose footprint reaches
 * the area while another piece of work in flight touches it. The hold is
 * declared, not weighed: it applies after the priorities ranking and before
 * overlap weighs the pickups left (`overlap-plan.ts`), and a held pickup
 * leaves the plan's actions for the report's serialized holds, so no slot
 * goes to it this tick.
 *
 * - **Reaching an area.** A footprint reaches an area when a file of it lies
 *   in the area, or a directory or an area of it holds, or is held by, a glob
 *   of the area (`reachesArea`).
 * - **The work in flight** is every open pull request, by its changed files,
 *   every pickup in flight with no linked open pull request, by its footprint
 *   record, and each pickup planned ahead of this one in rank order and not
 *   held itself, since this tick may start it.
 * - **Unknown, on both sides.** A footprint that is unknown, or a batch's
 *   that is partly unknown, cannot exclude an area: such a pickup is held
 *   while another piece of work touches any serialized area (`footprint
 *   unknown`), and such work in flight occupies every serialized area, so a
 *   pickup that reaches one is held behind it (`#N's footprint unknown`).
 *
 * Every hold is read again from this tick's facts, so one ends as soon as
 * they change: the footprint becomes known, the pull request merges or
 * closes, or the pickup ends. A person's hold and a plan's conflict edge keep
 * a pickup out of the plan before this step, and ending a serialized hold
 * never brings one back. Where the catalog is configured and serialization
 * could not be decided this tick, no pickup is placed: each is unplaced with
 * the reason, as the drives are.
 */
import type { ReadRecord } from "./launches.ts";
import { reachesArea, type Footprint, type InFlight } from "./overlap.ts";
import { overlapOf } from "./overlap-config.ts";
import {
  combinedFootprint,
  footprintOf,
  itemLinks,
  pickupsInFlight,
  pullRequestsInFlight,
} from "./overlap-plan.ts";
import { membersOf } from "./priorities-order.ts";
import { configuredCatalog } from "./sources/contention.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { Action } from "./types.ts";

/** One planned pickup as the hold reads it: its action's target, its members' keys and their footprint together. */
export interface SerialCandidate {
  target: string;
  keys: readonly string[];
  footprint: Footprint;
}

/** Why one pickup is held: the area, the work it waits behind, and which side's footprint is unknown, if either. */
export interface PickupSerialHold {
  area: string;
  behind: string;
  unknown: "candidate" | "occupant" | null;
  reason: string;
}

/** Whether a footprint cannot exclude any area: unknown, or a batch's partly unknown. */
const openEnded = (f: Footprint) => !f.known || f.incomplete === true;

function reasonOf(
  area: string,
  behind: string,
  unknown: PickupSerialHold["unknown"],
): string {
  const tail =
    unknown === "candidate"
      ? ", footprint unknown"
      : unknown === "occupant"
        ? `, ${behind}'s footprint unknown`
        : "";
  return `held: serialized behind ${behind} in ${area}${tail}`;
}

/**
 * The work a candidate waits behind in one area: the first that reaches it,
 * else the first whose footprint cannot exclude it; `null` when the area is
 * free of both.
 */
function occupantOf(
  area: string,
  work: readonly InFlight[],
  globs: (area: string) => readonly string[],
): { ref: string; known: boolean } | null {
  const model = { areaGlobs: globs };
  const reaching = work.find((w) => reachesArea(w.footprint, area, model));
  if (reaching !== undefined) return { ref: reaching.ref, known: true };
  const open = work.find((w) => openEnded(w.footprint));
  return open === undefined ? null : { ref: open.ref, known: false };
}

/**
 * Hold each candidate, in rank order, whose footprint reaches a serialized
 * area another piece of work occupies, or cannot exclude one; a candidate
 * not held is counted in flight for those after it. `areas` is in catalog
 * order; `own` names the pull requests that carry a candidate's own items,
 * which never hold it. Pure: every fact arrives as an argument.
 */
export function serialPickupHolds(input: {
  areas: readonly string[];
  globs: (area: string) => readonly string[];
  candidates: readonly SerialCandidate[];
  inFlight: readonly InFlight[];
  own?: (keys: readonly string[]) => ReadonlySet<string>;
}): Map<string, PickupSerialHold> {
  const held = new Map<string, PickupSerialHold>();
  const work: InFlight[] = [...input.inFlight];
  const model = { areaGlobs: input.globs };
  for (const c of input.candidates) {
    const own = input.own?.(c.keys) ?? new Set<string>();
    const others = work.filter(
      (w) => w.kind !== "pull request" || !own.has(w.ref),
    );
    const hold = input.areas.flatMap((area): PickupSerialHold[] => {
      const reaches = reachesArea(c.footprint, area, model);
      if (!reaches && !openEnded(c.footprint)) return [];
      const occupant = occupantOf(area, others, input.globs);
      if (occupant === null) return [];
      const unknown = !reaches
        ? "candidate"
        : occupant.known
          ? null
          : "occupant";
      return [
        {
          area,
          behind: occupant.ref,
          unknown,
          reason: reasonOf(area, occupant.ref, unknown),
        },
      ];
    })[0];
    if (hold !== undefined) {
      held.set(c.target, hold);
      continue;
    }
    work.push({
      kind: "pickup",
      ref: c.target,
      url: null,
      state: "planned ahead of it",
      footprint: c.footprint,
      quiet: false,
    });
  }
  return held;
}

/** The planned pickups in rank order, one per action target, each batch with its members' footprints together. */
function candidatesOf(
  pickups: readonly Action[],
  observation: RepoObservation,
): SerialCandidate[] {
  const readings = observation.overlap?.readings;
  const seen = new Set<string>();
  return pickups.flatMap((a) => {
    if (seen.has(a.target)) return [];
    const keys = membersOf(a).filter((key) => !seen.has(key));
    for (const key of keys) seen.add(key);
    return [
      {
        target: a.target,
        keys,
        footprint: combinedFootprint(
          keys.map((key) => footprintOf(readings?.get(key))),
        ),
      },
    ];
  });
}

/**
 * Apply the serialized areas' hold to one planned repository's pickups:
 * each held pickup leaves the plan's actions for the report's serialized
 * holds, with its reason; where serialization was not decided this tick and
 * a catalog is configured, every pickup is unplaced instead.
 */
export function holdSerialPickups(
  observation: RepoObservation,
  records: readonly ReadRecord[],
  nowMs: number,
): void {
  const { opened, serialized } = observation;
  const { report } = opened;
  const pickups = report.actions.filter((a) => a.stage === "pickup");
  if (pickups.length === 0) return;
  const catalog = observation.overlap?.catalog ?? null;
  const areas = serialized.report?.areas ?? [];
  const configured = configuredCatalog(opened.values) !== null;
  const undecided = !serialized.decided || (areas.length > 0 && !catalog);
  if (configured && undecided) {
    const why = `whether it reaches a serialized area cannot be told this tick: ${serialized.failure ?? "the catalog or the open pull requests were not read whole"}`;
    report.actions = report.actions.filter((a) => a.stage !== "pickup");
    for (const a of pickups)
      report.unplaced.push({ target: a.target, record: "forge", reason: why });
    return;
  }
  if (areas.length === 0 || catalog === null) return;
  const candidates = candidatesOf(pickups, observation);
  const keys = new Set(candidates.flatMap((c) => c.keys));
  const links = itemLinks(observation);
  const held = serialPickupHolds({
    areas,
    globs: (area) => catalog.get(area)?.globs ?? [],
    candidates,
    inFlight: [
      ...pullRequestsInFlight(observation, overlapOf(opened.section), nowMs),
      ...pickupsInFlight(observation, keys, records),
    ],
    own: (members) =>
      new Set(
        members.flatMap((k) =>
          (links?.prsOf(k) ?? []).map((p) => `#${p.number}`),
        ),
      ),
  });
  if (held.size === 0) return;
  report.actions = report.actions.filter(
    (a) => a.stage !== "pickup" || !held.has(a.target),
  );
  const reported = new Set<string>();
  for (const a of pickups) {
    const hold = held.get(a.target);
    if (hold === undefined || reported.has(a.target)) continue;
    reported.add(a.target);
    report.serialized?.held.push({
      target: a.target,
      stage: "pickup",
      reason: `${hold.reason}; without it the tick would pick it up: ${a.reason}`,
    });
  }
}
