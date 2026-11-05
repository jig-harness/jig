/**
 * Serialized areas: a change area the repository's catalog marks
 * `serialize: true` is one whose pull requests conflict with each other
 * whenever two of them move at once (a migrations folder, a schema, a
 * generated client), so the dispatcher drives them one at a time.
 *
 * Once per tick, from one observation of each fact:
 *
 * 1. the catalog is read from the default branch (`drive.change_areas_catalog`),
 *    as the dispatch section is, through the plugin's one catalog reader;
 * 2. each open pull request the dispatcher reads a drive for gets its
 *    changed files from the forge, and is placed in each serialized area
 *    whose own globs (its `paths` and generator sources: the seeds, never
 *    the `impliedBy` closure) match one of them;
 * 3. each group of two or more is ordered by closeness to merge, read from
 *    the ledger and the forge, never judged: converged and mergeable first,
 *    then a drive in progress (a running driver, or this machine's launch
 *    record still holding it), then the fewest unresolved review threads,
 *    then the most rounds, then the oldest (by its creation, then its
 *    number), so the order is the same at every tick until a fact changes;
 * 4. the first of each group leads it; a pull request in two groups is held
 *    unless it leads both. The order is the same in every group, so the
 *    first pull request of all leads every group it is in, and no two
 *    groups wait on each other.
 *
 * A pull request whose place cannot be told this tick (its files do not
 * read, the catalog does not read, or, in a group of two or more, a
 * member's ledger or threads do not read) is unplaced for the tick, and so
 * is every member of a group whose order cannot be told: no re-arm starts
 * on it, and it is read again at the next tick. The tick never adds an
 * area: what is serialized is the catalog's to say, through a person.
 */
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  loadCatalogText,
  matchesGlob,
} from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { holds, isDrive, type ReadRecord } from "./launches.ts";
import { failureText } from "./text.ts";
import type { DrivenPr, Stage } from "./types.ts";

/** The catalog cannot say which areas are serialized. */
class CatalogReadError extends Error {}

/** Why one pull request waits: the area it is held in, and the pull request leading it. */
export interface Hold {
  area: string;
  leader: number;
}

/** One serialized area's group, as the report shows it. */
export interface SerialGroup {
  area: string;
  /** Its members, closest to merge first, each with the facts that placed it. */
  order: Array<{ target: string; place: string }>;
  /** The member the dispatcher drives; `null` while the order cannot be told. */
  leader: string | null;
  /** Why the order cannot be told this tick. */
  unplaced?: string;
  /** Set when more than one drive runs in the group. */
  drives?: string;
}

/** Serialization's part of a repository's report. */
export interface SerialReport {
  /** Where the catalog was read. */
  catalog: string;
  /** The areas the catalog serializes. */
  areas: string[];
  groups: SerialGroup[];
  /** The re-arms, takeovers and re-drives a hold kept off. */
  held: Array<{ target: string; stage: Stage; reason: string }>;
}

/** What serialization decided for one repository's tick. */
export interface Contention {
  /** `null` where no catalog is configured or none of its areas is serialized. */
  report: SerialReport | null;
  /** The pull requests held this tick, each with why. */
  held: ReadonlyMap<number, Hold>;
  /** The pull requests whose place cannot be told this tick, each with why. */
  unplaced: ReadonlyMap<number, string>;
  /** The pull requests in a serialized group this tick. */
  grouped: ReadonlySet<number>;
  /** The open pull requests the tick placed (or tried to). */
  considered: ReadonlySet<number>;
  /** Whether the tick read what serialization needs: only then does a hold end. */
  decided: boolean;
  /** Why the catalog does not read, when it does not. */
  failure?: string;
}

/** The reads serialization makes, each throwing with its reason. */
export interface ContentionReads {
  /** The catalog's text on the default branch; `null` when the branch has no such file. */
  catalog: (path: string) => Promise<string | null>;
  files: (pr: number) => Promise<string[]>;
  threads: (pr: number) => Promise<number>;
}

export interface ContentionInput {
  /** The configured catalog's repository-relative path; `null` when none is configured. */
  catalogPath: string | null;
  /** Where the catalog is read from, for the report (`owner/name@branch:path`). */
  where: string;
  /** The open pull requests read for a drive. */
  drives: readonly DrivenPr[];
  /** Each pull request's creation time. */
  created: ReadonlyMap<number, string>;
  /** This machine's launch records for the repository. */
  launches: readonly ReadRecord[];
}

const target = (n: number) => `PR #${n}`;

function empty(decided: boolean, considered: Iterable<number>): Contention {
  return {
    report: null,
    held: new Map(),
    unplaced: new Map(),
    grouped: new Set(),
    considered: new Set(considered),
    decided,
  };
}

/** What a forge read that failed leaves: nothing decided, no hold begun or ended. */
export const UNREAD_CONTENTION: Contention = empty(false, []);

/** The facts that place one member of a group. */
interface Member {
  pr: DrivenPr;
  /** Its ledger stopped converged at the head the drive verified, and the forge reports it mergeable. */
  mergeable: boolean;
  /** A driver runs on it, or this machine's launch record still holds it. */
  driving: boolean;
  rounds: number;
  createdAt: string | null;
  /** Its unresolved review threads; read only in a group of two or more. */
  threads: number | null;
}

function memberOf(
  pr: DrivenPr,
  input: ContentionInput,
): Omit<Member, "threads"> {
  const recordHolds = input.launches.some(
    (r) => isDrive(r.record) && r.record.pr === pr.number && holds(r.state),
  );
  const round = pr.evidence.round;
  return {
    pr,
    mergeable: pr.class === "done" && pr.evidence.exit === DRIVE_EXIT.CONVERGED,
    driving: pr.class === "driven" || pr.class === "silent" || recordHolds,
    rounds: typeof round === "number" ? round : 0,
    createdAt: input.created.get(pr.number) ?? null,
  };
}

/** Oldest first; a pull request whose creation time is unknown follows every dated one, so the order stays total. */
function byAge(a: Member, b: Member): number {
  if (a.createdAt === null || b.createdAt === null)
    return Number(a.createdAt === null) - Number(b.createdAt === null);
  return a.createdAt.localeCompare(b.createdAt);
}

/** Closest to merge first; a tie is broken by age, then number, so the order is stable. */
function closer(a: Member, b: Member): number {
  const keys = [
    Number(b.mergeable) - Number(a.mergeable),
    Number(b.driving) - Number(a.driving),
    (a.threads ?? 0) - (b.threads ?? 0),
    b.rounds - a.rounds,
    byAge(a, b),
    a.pr.number - b.pr.number,
  ];
  return keys.find((k) => k !== 0) ?? 0;
}

function placeOf(m: Member): string {
  const parts = [
    m.mergeable ? "converged and mergeable" : m.pr.class,
    ...(m.driving ? ["a drive in progress"] : []),
    ...(m.threads === null ? [] : [`${m.threads} unresolved thread(s)`]),
    `${m.rounds} round(s)`,
    `opened ${m.createdAt ?? `as #${m.pr.number}`}`,
  ];
  return parts.join(", ");
}

/** Every drive unplaced for one reason: the catalog cannot be read. */
function catalogFailed(input: ContentionInput, failure: string): Contention {
  const why = `whether it touches a serialized area cannot be told this tick: ${failure}`;
  return {
    ...empty(
      false,
      input.drives.map((d) => d.number),
    ),
    unplaced: new Map(input.drives.map((d) => [d.number, why])),
    failure,
  };
}

/** The serialized areas' globs, by area, in catalog order; throws with why the catalog does not read. */
async function serializedAreas(
  input: ContentionInput & { catalogPath: string },
  reads: ContentionReads,
): Promise<Map<string, string[]>> {
  const text = await reads.catalog(input.catalogPath);
  if (text === null)
    throw new CatalogReadError(
      `drive.change_areas_catalog names ${input.catalogPath}, which the default branch does not have`,
    );
  const catalog = loadCatalogText(text, input.where);
  return new Map(
    [...catalog].filter(([, a]) => a.serialize).map(([k, a]) => [k, a.globs]),
  );
}

/** Each drive's serialized areas, and the drives whose files did not read. */
async function placeDrives(
  drives: readonly DrivenPr[],
  areas: Map<string, string[]>,
  reads: ContentionReads,
): Promise<{ groups: Map<string, DrivenPr[]>; failed: Map<number, string> }> {
  const groups = new Map<string, DrivenPr[]>();
  const failed = new Map<number, string>();
  for (const drive of drives) {
    let files: string[];
    try {
      files = await reads.files(drive.number);
    } catch (error) {
      failed.set(
        drive.number,
        `its changed files do not read, so whether it touches a serialized area cannot be told this tick: ${failureText(error)}`,
      );
      continue;
    }
    for (const [area, globs] of areas)
      if (files.some((f) => globs.some((g) => matchesGlob(f, g))))
        groups.set(area, [...(groups.get(area) ?? []), drive]);
  }
  return { groups, failed };
}

/** One group ordered, or why its order cannot be told. */
async function orderGroup(
  members: DrivenPr[],
  input: ContentionInput,
  threads: (pr: number) => Promise<number | string>,
): Promise<Member[] | string> {
  const placed: Member[] = [];
  for (const pr of members) {
    const base = memberOf(pr, input);
    if (members.length === 1) {
      placed.push({ ...base, threads: null });
      continue;
    }
    if (pr.class === "unplaced")
      return `${target(pr.number)}'s drive cannot be placed this tick (${pr.why}), so the group's order cannot be told`;
    const count = await threads(pr.number);
    if (typeof count === "string")
      return `${target(pr.number)}'s review threads do not read (${count}), so the group's order cannot be told`;
    placed.push({ ...base, threads: count });
  }
  return placed.sort(closer);
}

/**
 * Decide serialization for one repository's tick: the groups, their
 * order, who leads, who is held and who cannot be placed.
 */
export async function readContention(
  input: ContentionInput,
  reads: ContentionReads,
): Promise<Contention> {
  const considered = input.drives.map((d) => d.number);
  const path = input.catalogPath;
  if (path === null) return empty(true, considered);
  let areas: Map<string, string[]>;
  try {
    areas = await serializedAreas({ ...input, catalogPath: path }, reads);
  } catch (error) {
    return catalogFailed(input, failureText(error));
  }
  if (areas.size === 0) return empty(true, considered);

  const { groups, failed } = await placeDrives(input.drives, areas, reads);
  const unplaced = new Map(failed);
  const counts = new Map<number, number | string>();
  const threads = async (pr: number) => {
    if (!counts.has(pr))
      counts.set(
        pr,
        await reads.threads(pr).catch((error: unknown) => failureText(error)),
      );
    return counts.get(pr) as number | string;
  };
  const report: SerialReport = {
    catalog: input.where,
    areas: [...areas.keys()],
    groups: [],
    held: [],
  };
  const leaders = new Map<string, number>();
  const ordered = new Map<string, Member[]>();
  for (const area of areas.keys()) {
    const members = groups.get(area);
    if (members === undefined) continue;
    // A pull request whose files did not read may belong here: the order cannot be told.
    const why =
      failed.size > 0
        ? `the changed files of ${[...failed.keys()].map(target).join(", ")} do not read, so whether they belong to this group cannot be told`
        : await orderGroup(members, input, threads);
    if (typeof why === "string") {
      for (const m of members) unplaced.set(m.number, `${area}: ${why}`);
      report.groups.push({
        area,
        order: members.map((m) => ({
          target: target(m.number),
          place: m.class,
        })),
        leader: null,
        unplaced: why,
      });
      continue;
    }
    ordered.set(area, why);
    leaders.set(area, (why[0] as Member).pr.number);
  }
  const held = heldOf(ordered, leaders, unplaced);
  for (const [area, members] of ordered)
    report.groups.push(groupReport(area, members));
  return {
    report,
    held,
    unplaced,
    grouped: new Set([...groups.values()].flat().map((d) => d.number)),
    considered: new Set(considered),
    decided: true,
  };
}

/** Each member that does not lead every group it is in, with the first such group in catalog order. */
function heldOf(
  ordered: ReadonlyMap<string, Member[]>,
  leaders: ReadonlyMap<string, number>,
  unplaced: ReadonlyMap<number, string>,
): Map<number, Hold> {
  const held = new Map<number, Hold>();
  for (const [area, members] of ordered) {
    const leader = leaders.get(area) as number;
    for (const m of members) {
      const n = m.pr.number;
      if (n !== leader && !held.has(n) && !unplaced.has(n))
        held.set(n, { area, leader });
    }
  }
  return held;
}

function groupReport(area: string, members: Member[]): SerialGroup {
  const driving = members
    .filter((m) => m.driving)
    .map((m) => target(m.pr.number));
  return {
    area,
    order: members.map((m) => ({
      target: target(m.pr.number),
      place: placeOf(m),
    })),
    leader: target((members[0] as Member).pr.number),
    ...(driving.length > 1
      ? {
          drives: `${driving.length} drives run in this group (${driving.join(", ")}): the dispatcher starts one at a time, and a drive a person armed on a held pull request is reported, never stopped`,
        }
      : {}),
  };
}

/** The reason a held pull request's action is reported with. */
export function heldReason(hold: Hold): string {
  return `held: serialized behind #${hold.leader} in ${hold.area}`;
}
