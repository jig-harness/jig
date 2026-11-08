/**
 * The Linear adapter's facets. Linear keeps priority in its own priority
 * field, which the adapter reads and writes as it always has; type and size
 * are labels, priority too where `issue_tracker.facets.priority` names the
 * label store, and size is kept in the issue's estimate where
 * `issue_tracker.facets.size` names the native store. Linear has no issue
 * types.
 *
 * The estimate is a number on the team's estimate scale, which the team's
 * settings choose: exponential (1, 2, 4, 8, 16), Fibonacci (1, 2, 3, 5, 8),
 * linear (1 to 5) or T-shirt sizes (XS, S, M, L, XL, kept as 1, 2, 3, 5, 8),
 * each with two more points where the team extends it (32 and 64, 13 and 21,
 * 6 and 7, XXL and XXXL) and 0 where it allows zero. The sizes map onto the
 * scale in order, smallest first and from 1, unless `values` names each
 * size's point (a number, or on a T-shirt scale its name). A team with
 * estimates off, a scale with fewer points than the sizes, or a value that
 * is no point of the scale is refused at the first read or write that needs
 * the estimate, before anything is written. The scale is read once, with
 * the first such read.
 */

import {
  defaultFacets,
  type Facets,
  type ResolvedFacet,
  usable,
} from "./facets/config.ts";
import {
  type CoreFacetReport,
  type CoreIssue,
  type CorePoolIssue,
  type CoreTracker,
  withFacets,
} from "./facets/tracker.ts";
import { TrackerConfigError } from "./config-error.ts";
import { fold, PRIORITY_NAMES } from "./facets/values.ts";
import { type Facet, type Tracker, TrackerRequestError } from "./port.ts";
import { ShapeError } from "./linear-shapes.ts";
import type { LinearTransport } from "./linear.ts";
import { isRecord } from "../../../../../shared/guards.ts";

export type { Facets } from "./facets/config.ts";
export type {
  CoreIssue,
  CorePoolIssue,
  CoreTracker,
} from "./facets/tracker.ts";

/** An issue node's estimate, where the read asked for it. */
export type WithEstimate<T> = T & { estimate?: number | null };

/** The estimate scales Linear offers, by `issueEstimationType`. */
const SCALES: Readonly<
  Record<string, { points: number[]; extended: number[]; names?: string[] }>
> = {
  exponential: { points: [1, 2, 4, 8, 16], extended: [32, 64] },
  fibonacci: { points: [1, 2, 3, 5, 8], extended: [13, 21] },
  linear: { points: [1, 2, 3, 4, 5], extended: [6, 7] },
  tShirt: {
    points: [1, 2, 3, 5, 8],
    extended: [13, 21],
    names: ["XS", "S", "M", "L", "XL", "XXL", "XXXL"],
  },
};

const ESTIMATES_QUERY = `
query TrackerEstimates($key: String!) {
  teams(first: 10, filter: { key: { eq: $key } }) {
    pageInfo { hasNextPage }
    nodes { key issueEstimationType issueEstimationAllowZero issueEstimationExtended }
  }
}`;

/** An issue node's estimate as Linear reports it (a number, or `null` for none); `{}` where it was not read. */
export function readEstimate(
  n: Record<string, unknown>,
  where: string,
): { estimate?: number | null } {
  if (n.estimate === undefined) return {};
  if (n.estimate !== null && typeof n.estimate !== "number")
    throw new ShapeError(`${where}.estimate: expected a number`);
  return { estimate: n.estimate };
}

/** A team's estimate scale: its points, smallest first, and their names on a T-shirt scale. */
interface Scale {
  type: string;
  points: number[];
  names: Map<string, number>;
}

/** Where size is kept in the estimate: the field reads add, and the map onto the team's scale. */
export interface EstimateStore {
  /** What an issue read adds: ` estimate` where size is kept in it, else nothing. */
  readonly fields: string;
  /** What a write of `size` sets: the estimate, `null` to clear it; nothing where size is not kept there. */
  input(
    size: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<{ estimate?: number | null }>;
  /** The tracker its core makes, every read giving the size its estimate holds. */
  wrap(core: CoreTracker): CoreTracker;
}

const at = "issue_tracker.facets.size";

/**
 * Refuse a Linear facet configuration the adapter cannot honour. Pure, so the
 * audit refuses what the adapter refuses without opening a tracker.
 */
export function checkLinearFacets(facets: Facets): void {
  // Linear's own priority numbers are written and read as they are, so a map
  // onto other numbers could not be honoured in either direction.
  if (facets.priority.store === "native")
    for (const [i, name] of PRIORITY_NAMES.entries())
      if (facets.priority.map?.toTracker(name) !== String(i + 1))
        throw new TrackerConfigError(
          "issue_tracker.facets.priority.values",
          "issue_tracker.facets.priority.values cannot remap Linear's native priority, which is always urgent 1 to low 4; keep priority in labels to name other values",
        );
  const size = facets.size;
  if (!usable(size) || size.store !== "native") return;
  const named = namedPoints(size);
  if (named.length > 0 && named.length < size.values.length)
    throw new TrackerConfigError(
      `${at}.values`,
      `${at}.values names the estimate of ${named.map(([v]) => v).join(", ")} but not of ${size.values.filter((v) => !named.some(([n]) => n === v)).join(", ")}; name every size's estimate, or none to map the sizes onto the team's scale in order`,
    );
  for (const [v, t] of named)
    if (
      !/^\d+$/.test(t.trim()) &&
      !SCALES.tShirt?.names?.some((n) => fold(n) === fold(t))
    )
      throw new TrackerConfigError(
        `${at}.values.${v}`,
        `${at}.values.${v} is '${t}'; an estimate is a whole number, or on a T-shirt scale a size name (XS to XXXL)`,
      );
}

/** The team's estimate scale, read from its settings; refused where estimates are off. */
async function readScale(
  transport: LinearTransport,
  team: string,
  signal?: AbortSignal,
): Promise<Scale> {
  const data = await transport(ESTIMATES_QUERY, { key: team }, signal);
  const teams = isRecord(data) && isRecord(data.teams) ? data.teams : null;
  const nodes = Array.isArray(teams?.nodes) ? teams.nodes : null;
  const node = nodes?.find((n) => isRecord(n) && n.key === team);
  if (!isRecord(node) || typeof node.issueEstimationType !== "string")
    throw new ShapeError(`the estimate settings of team ${team}: unreadable`);
  const type = node.issueEstimationType;
  if (type === "notUsed")
    throw new TrackerRequestError(
      "unresolved",
      `${at} keeps size in the estimate, but team ${team} has estimates off; turn them on in the team's settings, or keep size in labels (store: label)`,
    );
  const scale = SCALES[type];
  if (scale === undefined)
    throw new TrackerRequestError(
      "unresolved",
      `team ${team} estimates on the scale '${type}', which this adapter does not know; keep size in labels (store: label)`,
    );
  const extended = node.issueEstimationExtended === true;
  const upper = [...scale.points, ...(extended ? scale.extended : [])];
  const names = new Map(
    (scale.names ?? [])
      .slice(0, upper.length)
      .map((n, i) => [fold(n), upper[i] as number]),
  );
  return {
    type,
    points: [...(node.issueEstimationAllowZero === true ? [0] : []), ...upper],
    names,
  };
}

/** The sizes `values` names, each with the point it names. */
function namedPoints(size: ResolvedFacet): Array<readonly [string, string]> {
  return (size.map?.entries ?? []).filter(([v]) =>
    (size.named ?? []).includes(v),
  );
}

/** Each size's point on `scale`: named in `values`, else the sizes in order from 1. */
function sizePoints(
  facets: Facets,
  scale: Scale,
  team: string,
): ReadonlyArray<readonly [string, number]> {
  const size = facets.size as Exclude<Facets["size"], { store: null }>;
  const named = namedPoints(size);
  const shown = `team ${team}'s ${scale.type} scale (${scale.points.join(", ")})`;
  if (named.length === 0) {
    const upper = scale.points.filter((p) => p > 0);
    if (upper.length < size.values.length)
      throw new TrackerRequestError(
        "unresolved",
        `${at} keeps ${size.values.length} sizes in the estimate, but ${shown} has fewer points; extend the scale, name each size's point in ${at}.values, or keep size in labels (store: label)`,
      );
    return size.values.map((v, i) => [v, upper[i] as number] as const);
  }
  const out = named.map(([v, t]) => {
    const n = /^\d+$/.test(t.trim()) ? Number(t) : scale.names.get(fold(t));
    if (n === undefined || !scale.points.includes(n))
      throw new TrackerRequestError(
        "unresolved",
        `${at}.values.${v} is '${t}', which is no point of ${shown}`,
      );
    return [v, n] as const;
  });
  if (new Set(out.map(([, n]) => n)).size !== out.length)
    throw new TrackerRequestError(
      "unresolved",
      `${at}.values gives two sizes one point of ${shown}`,
    );
  return out;
}

/** Where size is kept on a Linear team: in the estimate where `facets` say so. */
export function estimateStore(
  facets: Facets | undefined,
  transport: LinearTransport,
  team: string,
): EstimateStore {
  const kept =
    facets !== undefined &&
    usable(facets.size) &&
    facets.size.store === "native"
      ? facets
      : null;
  let points: Promise<ReadonlyArray<readonly [string, number]>> | undefined;
  function map(signal?: AbortSignal) {
    // Called only where size is kept in the estimate.
    const sized = kept as Facets;
    points ??= (async () =>
      sizePoints(sized, await readScale(transport, team, signal), team))();
    points.catch(() => {
      points = undefined;
    });
    return points;
  }

  /** The size an estimate holds; an estimate no size has is unmapped. */
  async function sizeOf(
    estimate: number | null | undefined,
  ): Promise<{ size: string | null; unmapped: boolean }> {
    if (estimate === undefined)
      throw new ShapeError("an issue was read without its estimate");
    if (estimate === null) return { size: null, unmapped: false };
    const found = (await map()).find(([, n]) => n === estimate)?.[0] ?? null;
    return { size: found, unmapped: found === null };
  }

  /** The issue a read returns, its estimate read as its size. */
  async function issueOf(issue: WithEstimate<CoreIssue>): Promise<CoreIssue> {
    const { estimate, ...rest } = issue;
    return { ...rest, size: (await sizeOf(estimate)).size };
  }
  async function pool(
    issue: WithEstimate<CorePoolIssue>,
  ): Promise<CorePoolIssue> {
    const { estimate, ...rest } = issue;
    const { size, unmapped } = await sizeOf(estimate);
    const facets: Facet[] = [...(rest.unmappedFacets ?? []), "size"];
    return { ...rest, size, ...(unmapped ? { unmappedFacets: facets } : {}) };
  }
  const pools = (issues: WithEstimate<CorePoolIssue>[]) =>
    Promise.all(issues.map(pool));

  return {
    fields: kept === null ? "" : " estimate",
    async input(size, signal) {
      if (kept === null || size === undefined) return {};
      if (size === null) return { estimate: null };
      const found = (await map(signal)).find(([v]) => fold(v) === fold(size));
      if (found === undefined)
        throw new TrackerRequestError(
          "invalid",
          `'${size}' is not a size of this repository`,
        );
      return { estimate: found[1] };
    },
    wrap(core) {
      if (kept === null) return core;
      return {
        ...core,
        async getIssue(key) {
          const issue = await core.getIssue(key);
          return issue === null ? null : issueOf(issue);
        },
        openIssues: async (query) => pools(await core.openIssues(query)),
        openChildren: async (key) => pools(await core.openChildren(key)),
        async poolIssue(key, signal) {
          const issue = await core.poolIssue(key, signal);
          return issue === null ? null : pool(issue);
        },
        assignedIssues: async (identity, states, signal) =>
          pools(await core.assignedIssues(identity, states, signal)),
        openPopulation: async (signal) =>
          pools(await core.openPopulation(signal)),
        async facetReport(): Promise<CoreFacetReport> {
          let health: { status: "ok" } | { status: "failed"; error: string };
          try {
            await map();
            health = { status: "ok" };
          } catch (err) {
            health = {
              status: "failed",
              error: (err instanceof Error ? err.message : String(err)).slice(
                0,
                300,
              ),
            };
          }
          return {
            facets: { size: { health } },
            discovery: {
              status: "none",
              reason: "the linear adapter discovers no organization's fields",
            },
          };
        },
      };
    },
  };
}

/** The Linear tracker its core makes, with `facets` (default: the adapter's defaults). */
export function linearFacets(
  core: CoreTracker,
  facets: Facets = defaultFacets("linear"),
  estimates?: EstimateStore,
): Tracker {
  checkLinearFacets(facets);
  const own = new Set<Facet>(
    facets.priority.store === "native" ? ["priority"] : [],
  );
  if (usable(facets.size) && facets.size.store === "native") own.add("size");
  return withFacets(estimates?.wrap(core) ?? core, facets, own);
}
