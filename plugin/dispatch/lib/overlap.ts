/**
 * The overlap cost, tier and bound of the pickups a tick wants, against the
 * work in flight (design/overlap-aware-admission.md § The overlap cost, § The
 * overlap bound). Pure: every fact arrives as an argument.
 *
 * - **Shared units.** A file in both footprints is one unit, at its rate. A
 *   directory or an area in either footprint that holds a file, directory or
 *   area of the other is a coarse match; a coarse match whose directory or
 *   area also holds a file match adds nothing beyond that file, and the
 *   coarse matches left are one unit together, at `area_rate`. So a path
 *   repeated, or a directory or an area beside the files it holds, never
 *   changes the cost.
 * - **The chance of a round** between a pickup `C` and one piece of work in
 *   flight `W` is `P(C, W) = 1 − ∏ (1 − rate(u))` over their shared units;
 *   the overlap cost of `C` is the sum over the work in flight. A pickup
 *   whose footprint is unknown costs `unknown_cost`, once.
 * - **The bound.** Starting a pickup would put more than `max_per_file`
 *   pieces of work in flight that change one of its files: only file matches
 *   count, a quiet pull request does not, and `0` turns it off.
 * - **Tiers.** Tier 1 has no overlap, has spent its patience (its
 *   priority's patience times its cost, since it first waited), or was
 *   promoted after waiting in tier 3 longer than `bound_patience`; tier 2
 *   overlaps within the bound; tier 3 is over it.
 *
 * `walkOverlap` takes the pickups in rank order and, as the admission walk
 * would, takes the next one tier by tier (the promoted first, longest waiter
 * first), counts it in flight as if it started, and weighs the rest again:
 * two pickups that overlap each other are never both weighed as if neither
 * existed. The result is a hypothetical admission plan, not the order the
 * tick launches: launching stays in rank order, so a pickup this walk takes
 * first may still start after a higher-ranked one. It reports; it starts
 * nothing.
 */
import { globMatchesUnder, matchesGlob } from "../../shared/glob.ts";
import type { OverlapSettings, PatienceKey } from "./overlap-config.ts";

/** The paths a piece of work is expected to change; `known: false` when nobody predicted them. */
export interface Footprint {
  known: boolean;
  /** Files, repository-relative. */
  files: readonly string[];
  /** Directories, each ending in `/`. */
  dirs: readonly string[];
  /** Areas of the change-area catalog, by key. */
  areas: readonly string[];
  /** A batch's footprint some member's is unknown: the known part is weighed, and `unknown_cost` is added once. */
  incomplete?: boolean;
}

export const UNKNOWN_FOOTPRINT: Footprint = {
  known: false,
  files: [],
  dirs: [],
  areas: [],
};

/** A piece of work in flight: an open pull request, or a pickup with no pull request yet. */
export interface InFlight {
  kind: "pull request" | "pickup";
  ref: string;
  url: string | null;
  state: string;
  footprint: Footprint;
  /** A pull request with no change for `quiet_after`: it counts toward the cost, not the bound. */
  quiet: boolean;
}

/** What the units are weighed with. */
export interface OverlapModel {
  settings: OverlapSettings;
  /** A file's conflict rate. */
  rate(path: string): number;
  /** An area's own globs (its seeds); none when the catalog does not read. */
  areaGlobs(area: string): readonly string[];
  /** A path the catalog marks generated, or `dispatch.overlap.ignore` names. */
  ignored(path: string): boolean;
}

/** One shared unit: a file at its rate, or the coarse matches together at `area_rate`. */
export interface Unit {
  path: string;
  rate: number;
  coarse: boolean;
}

export interface Share {
  work: InFlight;
  units: Unit[];
  chance: number;
}

export interface Evaluation {
  unknown: boolean;
  /** Part of a batch's footprint is unknown: its cost includes `unknown_cost` beside the shares. */
  incomplete: boolean;
  cost: number;
  /** The work in flight it shares a unit with, in the order given. */
  shares: Share[];
  /** The file that puts it over the bound, and the work in flight that changes it; `null` within the bound. */
  bound: { path: string; work: InFlight[] } | null;
  /** Every file over the bound; `bound` remains the representative shown in the wait reason. */
  boundPaths: string[];
}

type Element =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string }
  | { kind: "area"; key: string };

const unique = (values: readonly string[]) => [...new Set(values)];

/** The footprint as weighed: each path once, a generated or ignored file left out. */
export function canonical(
  footprint: Footprint,
  model: OverlapModel,
): Footprint {
  return {
    known: footprint.known,
    ...(footprint.incomplete === true ? { incomplete: true } : {}),
    files: unique(footprint.files).filter(
      (f) => !f.endsWith("/") && !model.ignored(f),
    ),
    dirs: unique([
      ...footprint.dirs,
      ...footprint.files.filter((f) => f.endsWith("/")),
    ]).filter((d) => !model.ignored(`${bare(d)}/`)),
    areas: unique(footprint.areas),
  };
}

function elements(footprint: Footprint): Element[] {
  return [
    ...footprint.files.map((path) => ({ kind: "file" as const, path })),
    ...footprint.dirs.map((path) => ({ kind: "dir" as const, path })),
    ...footprint.areas.map((key) => ({ kind: "area" as const, key })),
  ];
}

const bare = (dir: string) => dir.replace(/\/+$/, "");

/** The directory part of a glob before its first wildcard segment. */
function staticDir(glob: string): string {
  const segments = glob.split("/");
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}]/.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join("/");
}

/** Whether two globs can match one file, read through each one's fixed directory. */
function globsMeet(a: string, b: string): boolean {
  const da = staticDir(a);
  const db = staticDir(b);
  if (da === "" || db === "") return true;
  return globMatchesUnder(a, db) || globMatchesUnder(b, da);
}

/** Whether a coarse element `x` (a directory or an area) holds, or reaches into, the element `y`. */
function holds(x: Element, y: Element, model: OverlapModel): boolean {
  if (x.kind === "file") return false;
  if (x.kind === "dir") {
    if (y.kind === "file" || y.kind === "dir") return y.path.startsWith(x.path);
    return model
      .areaGlobs(y.key)
      .some((g) => globMatchesUnder(g, bare(x.path)));
  }
  const globs = model.areaGlobs(x.key);
  if (y.kind === "file") return globs.some((g) => matchesGlob(y.path, g));
  if (y.kind === "dir")
    return globs.some((g) => globMatchesUnder(g, bare(y.path)));
  if (x.key === y.key) return true;
  const other = model.areaGlobs(y.key);
  return globs.some((g) => other.some((h) => globsMeet(g, h)));
}

function describe(e: Element): string {
  return e.kind === "area" ? `area ${e.key}` : e.path;
}

/** The canonical shared units of two weighed footprints. */
export function sharedUnits(
  c: Footprint,
  w: Footprint,
  model: OverlapModel,
): Unit[] {
  const theirs = new Set(w.files);
  const files = c.files.filter((f) => theirs.has(f));
  const matched = files.map((path) => ({ kind: "file" as const, path }));
  const holdsMatch = (e: Element) =>
    e.kind !== "file" && matched.some((m) => holds(e, m, model));
  const coarse: string[] = [];
  const ours = elements(c);
  const others = elements(w);
  const consider = (x: Element, y: Element) => {
    if (x.kind === "file" || !holds(x, y, model)) return;
    if (holdsMatch(x) || holdsMatch(y)) return;
    coarse.push(describe(x));
  };
  for (const x of ours) for (const y of others) consider(x, y);
  for (const x of others) for (const y of ours) consider(x, y);
  const units: Unit[] = files.map((path) => ({
    path,
    rate: model.rate(path),
    coarse: false,
  }));
  if (coarse.length > 0)
    units.push({
      path: [...new Set(coarse)].sort()[0] as string,
      rate: model.settings.areaRate,
      coarse: true,
    });
  return units;
}

/** `P(C, W)`: the chance of a conflict resolution round between two pieces of work sharing `units`. */
export function roundChance(units: readonly Unit[]): number {
  return 1 - units.reduce((left, u) => left * (1 - u.rate), 1);
}

/** One candidate's cost and bound against the work in flight. */
export function evaluate(
  candidate: Footprint,
  inFlight: readonly InFlight[],
  model: OverlapModel,
): Evaluation {
  if (!candidate.known)
    return {
      unknown: true,
      incomplete: false,
      cost: model.settings.unknownCost,
      shares: [],
      bound: null,
      boundPaths: [],
    };
  const c = canonical(candidate, model);
  const shares: Share[] = [];
  for (const work of inFlight) {
    if (!work.footprint.known) continue;
    const units = sharedUnits(c, canonical(work.footprint, model), model);
    if (units.length === 0) continue;
    const chance = roundChance(units);
    if (chance > 0) shares.push({ work, units, chance });
  }
  const incomplete = candidate.incomplete === true;
  const cost =
    shares.reduce((sum, s) => sum + s.chance, 0) +
    (incomplete ? model.settings.unknownCost : 0);
  const bounds = boundsOf(c, inFlight, model);
  return {
    unknown: false,
    incomplete,
    cost,
    shares,
    bound: bounds[0] ?? null,
    boundPaths: bounds.map((bound) => bound.path),
  };
}

/** The file of `c` the most work in flight changes, when that work already reaches `max_per_file`. */
function boundsOf(
  c: Footprint,
  inFlight: readonly InFlight[],
  model: OverlapModel,
): Array<NonNullable<Evaluation["bound"]>> {
  const max = model.settings.maxPerFile;
  if (max === 0) return [];
  const bounds: Array<NonNullable<Evaluation["bound"]>> = [];
  for (const path of c.files) {
    const work = inFlight.filter(
      (w) =>
        !w.quiet &&
        w.footprint.known &&
        canonical(w.footprint, model).files.includes(path),
    );
    if (work.length >= max) bounds.push({ path, work });
  }
  return bounds.sort(
    (a, b) => b.work.length - a.work.length || a.path.localeCompare(b.path),
  );
}

/** A pickup the tick wants, in rank order. */
export interface Candidate {
  item: string;
  url: string | null;
  priority: PatienceKey;
  footprint: Footprint;
}

/** What the state database keeps of a wanted pickup's wait on overlap (`overlap-waits.ts`). */
export interface Wait {
  sinceMs: number;
  /** When it was first in tier 3; `null` until it was. */
  tier3SinceMs: number | null;
  /** When it waited in tier 3 past `bound_patience`; it stays in tier 1 from then. */
  promotedMs: number | null;
}

export type Tier = 1 | 2 | 3;

/** One candidate as the walk weighed it at its turn. */
export interface Placed {
  candidate: Candidate;
  rank: number;
  evaluation: Evaluation;
  /** The tier before patience and promotion: what puts it in `overlap_waits`. */
  raw: Tier;
  tier: Tier;
  promoted: boolean;
  patienceSpent: boolean;
  /** When its patience is spent, for a tier-2 pickup still waiting. */
  patienceEndsMs: number | null;
  /** Its wait as it stands after this tick. */
  wait: Wait | null;
}

/** The wait a candidate keeps after this tick, given its raw tier. */
function nextWait(
  previous: Wait | undefined,
  raw: Tier,
  nowMs: number,
  settings: OverlapSettings,
): Wait | null {
  if (previous === undefined && raw === 1) return null;
  const wait: Wait = previous ?? {
    sinceMs: nowMs,
    tier3SinceMs: null,
    promotedMs: null,
  };
  const tier3SinceMs = wait.tier3SinceMs ?? (raw === 3 ? nowMs : null);
  const promotedMs =
    wait.promotedMs ??
    (raw === 3 &&
    tier3SinceMs !== null &&
    nowMs - tier3SinceMs > settings.boundPatienceMs
      ? nowMs
      : null);
  return { sinceMs: wait.sinceMs, tier3SinceMs, promotedMs };
}

function place(
  candidate: Candidate,
  rank: number,
  evaluation: Evaluation,
  previous: Wait | undefined,
  nowMs: number,
  settings: OverlapSettings,
): Placed {
  const raw: Tier = evaluation.bound !== null ? 3 : evaluation.cost > 0 ? 2 : 1;
  const wait = nextWait(previous, raw, nowMs, settings);
  const promoted = wait?.promotedMs != null;
  let patienceEndsMs: number | null = null;
  let patienceSpent = false;
  if (!promoted && raw === 2 && wait !== null) {
    patienceEndsMs = Math.ceil(
      wait.sinceMs + settings.patienceMs[candidate.priority] * evaluation.cost,
    );
    patienceSpent = nowMs >= patienceEndsMs;
  }
  const tier: Tier = promoted || patienceSpent ? 1 : raw;
  return {
    candidate,
    rank,
    evaluation,
    raw,
    tier,
    promoted,
    patienceSpent,
    patienceEndsMs: patienceSpent ? null : patienceEndsMs,
    wait,
  };
}

/** The candidate the walk takes next: the promoted, longest waiter first; then tier by tier, in rank order. */
function next(placed: readonly Placed[]): Placed | undefined {
  const promoted = placed
    .filter((p) => p.promoted)
    .sort(
      (a, b) =>
        (a.wait?.sinceMs ?? 0) - (b.wait?.sinceMs ?? 0) || a.rank - b.rank,
    );
  if (promoted[0] !== undefined) return promoted[0];
  for (const tier of [1, 2, 3] as const) {
    const first = placed.find((p) => p.tier === tier);
    if (first !== undefined) return first;
  }
  return undefined;
}

/**
 * Weigh the candidates, in rank order, against the work in flight: each
 * takes its turn by tier, and counts in flight for those after it as a
 * pickup that would be admitted ahead of them. Returns them in the order the walk takes
 * them, each as it stood at its turn.
 */
export function walkOverlap(
  candidates: readonly Candidate[],
  inFlight: readonly InFlight[],
  waits: ReadonlyMap<string, Wait>,
  model: OverlapModel,
  nowMs: number,
): Placed[] {
  let remaining = candidates.map((candidate, rank) => ({ candidate, rank }));
  const ahead: InFlight[] = [];
  const out: Placed[] = [];
  while (remaining.length > 0) {
    const work = [...inFlight, ...ahead];
    const placed = remaining.map(({ candidate, rank }) =>
      place(
        candidate,
        rank,
        evaluate(candidate.footprint, work, model),
        waits.get(candidate.item),
        nowMs,
        model.settings,
      ),
    );
    const taken = next(placed);
    if (taken === undefined) break;
    out.push(taken);
    ahead.push({
      kind: "pickup",
      ref: taken.candidate.item,
      url: taken.candidate.url,
      state: "would be admitted ahead of it",
      footprint: taken.candidate.footprint,
      quiet: false,
    });
    remaining = remaining.filter((r) => r.rank !== taken.rank);
  }
  return out;
}
