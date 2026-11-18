/**
 * The conflict rates (`merge-conflict-rates/v1`): for each path, how many
 * merged pull requests of a window changed it, and how many of those met a
 * conflict before they merged. The dispatcher's admission reads them
 * (`dispatch/lib/conflict-rates.ts`) as the chance that a change to a path
 * costs a round of conflict resolution.
 *
 * A merged pull request is one entry of the forge's cohort (`cohort.ts`),
 * with the files it changed: the forge's list of them, and the files of each
 * first-parent commit of the integration branch it accounts for. A merge
 * commit and a squashed commit are one such commit; a rebase merge puts
 * several on the branch, its merge commit last, and they are one pull
 * request. A first-parent commit no pull request of the cohort accounts for
 * is unknown and counts nowhere.
 *
 * Each pull request is sorted as M11's conflict metric sorts the
 * scoreboard's cohort (`drive-pr/scripts/lib/fractal-conflicts.ts`):
 * conflicted when a conflicted replayed merge or a live conflict event names
 * it or lies in its own history; observed clean when the replay reached its
 * head, replayed every merge of its history and found none, and the forge
 * records no force-push of its branch; unknown otherwise. An unknown pull
 * request is left out of both counts of every path it changed, so a rate is
 * not pulled down by what was not observed; it is counted apart, as the
 * path's `unknown`.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { parseMs } from "../../../../shared/time.ts";
import {
  type Ancestry,
  type ConflictEvidence,
  directlyConflicted,
  historyConflicted,
  replayComplete,
} from "../../../drive-pr/scripts/lib/fractal-conflicts.ts";
import type { CohortListing, CohortPr } from "./cohort.ts";
import type { Range } from "./report.ts";

export const RATES_SCHEMA = "merge-conflict-rates/v1";

/** The first-parent commits no pull request accounts for that the file lists by name; the count holds them all. */
const UNKNOWN_COMMITS_LISTED = 100;

export type Observation = "conflicted" | "clean" | "unknown";

/** One commit of the integration branch's first-parent history. */
export interface FirstParent {
  commit: string;
  parents: string[];
  subject: string;
  /** Author date, seconds since the epoch: a rebase keeps it. */
  authorTime: number;
}

export interface PathRate {
  path: string;
  /** Observed pull requests (conflicted or clean) that changed the path. */
  merged: number;
  /** Of those, the ones that met a conflict before they merged. */
  conflicted: number;
  /** Pull requests that changed it whose conflicts were not observed, in neither count. */
  unknown: number;
}

export interface RatedPr {
  number: number;
  mergedAt: string;
  observation: Observation;
  /** The first-parent commits it accounts for, newest first. */
  commits: string[];
  /** How many files it counts for. */
  files: number;
}

export interface Rates {
  schema: typeof RATES_SCHEMA;
  generatedAt: string;
  repository: string;
  range: Range;
  cohort: {
    pullRequests: number;
    conflicted: number;
    clean: number;
    unknown: number;
    /** Pull requests whose changed files were read in part: more than the forge lists on one page, with no commit of theirs in the clone. */
    filesCut: number;
    listing: CohortListing;
  };
  /** The window's first-parent commits of the integration branch; null when the clone has no such branch. */
  commits: {
    firstParent: number;
    mapped: number;
    unknown: number;
    unknownCommits: string[];
  } | null;
  /** Whether the replay ran in a shallow clone, which leaves pull requests unknown. */
  shallow: boolean;
  pullRequests: RatedPr[];
  /** Most changed first, then by name. */
  paths: PathRate[];
  limits: string[];
}

export const RATES_LIMITS = [
  "A pull request counts as conflicted when a replayed merge or a live conflict event names it or lies in its history; as clean only when the replay reached its head, replayed every merge of its history and the forge records no force-push. Every other one is unknown and counts toward no rate.",
  "A conflict resolved during a rebase, a cherry-pick or a revert in another clone leaves nothing to replay or record here.",
  "A rate counts pull requests, not conflicts: one that met a conflict on any path counts as conflicted for every path it changed.",
];

/** Whether a forge headline is a git subject, the forge's cut-short form included. */
function sameSubject(subject: string, headline: string): boolean {
  if (headline === subject) return true;
  return headline.endsWith("…") && subject.startsWith(headline.slice(0, -1));
}

/** Whether `commit` is one of `pr`'s branch commits, by subject and author date. */
function rebasedFrom(pr: CohortPr, commit: FirstParent): boolean {
  return pr.commits.some(
    (c) =>
      Math.floor(parseMs(c.authoredAt) / 1000) === commit.authorTime &&
      sameSubject(commit.subject, c.subject),
  );
}

/**
 * Each pull request's first-parent commits, newest first, and the commits
 * no pull request accounts for. A pull request accounts for its merge
 * commit, and, when that commit has one parent and the branch had more than
 * one commit, for the commits just before it that are its branch's commits
 * rebased (same subject and author date), up to its commit count: a rebase
 * merge's. Another pull request's merge commit ends the run.
 */
export function mapFirstParents(
  prs: readonly CohortPr[],
  firstParents: readonly FirstParent[],
): { byPr: Map<number, string[]>; unknown: string[] } {
  const position = new Map(firstParents.map((c, i) => [c.commit, i]));
  const merges = new Set(
    prs.flatMap((pr) => (pr.mergeCommit === null ? [] : [pr.mergeCommit])),
  );
  const owner = new Map<string, number>();
  const byPr = new Map<number, string[]>();
  for (const pr of prs) {
    const at =
      pr.mergeCommit === null ? undefined : position.get(pr.mergeCommit);
    if (at === undefined) continue;
    const last = firstParents[at] as FirstParent;
    const commits = [last.commit];
    if (last.parents.length === 1)
      for (let i = at + 1; commits.length < pr.commitCount; i++) {
        const next = firstParents[i];
        if (
          next === undefined ||
          next.parents.length !== 1 ||
          merges.has(next.commit) ||
          owner.has(next.commit) ||
          !rebasedFrom(pr, next)
        )
          break;
        commits.push(next.commit);
      }
    for (const commit of commits) owner.set(commit, pr.number);
    byPr.set(pr.number, commits);
  }
  return {
    byPr,
    unknown: firstParents.map((c) => c.commit).filter((c) => !owner.has(c)),
  };
}

/** How one pull request met its merge, by M11's rule. */
export function observe(
  pr: CohortPr,
  evidence: ConflictEvidence,
  ancestry: Ancestry,
  replayed: ReadonlySet<string>,
): Observation {
  const sample = { mergeCommitOid: pr.mergeCommit ?? "" };
  if (
    directlyConflicted(
      { number: pr.number, mergedAt: pr.mergedAt },
      evidence,
    ) ||
    historyConflicted(sample, ancestry, evidence)
  )
    return "conflicted";
  if (!replayComplete(ancestry, evidence, replayed)) return "unknown";
  return pr.headRefOid !== null && !pr.forcePushed ? "clean" : "unknown";
}

export interface RatesInput {
  repository: string;
  range: Range;
  generatedAt: string;
  prs: readonly CohortPr[];
  listing: CohortListing;
  /** The window's first-parent commits of the integration branch, newest first; null when the clone has none. */
  firstParents: readonly FirstParent[] | null;
  evidence: ConflictEvidence;
  /** A pull request's own history in the clone, or null when its head or merge commit is not there. */
  ancestry: (pr: CohortPr) => Ancestry;
  /** The files a first-parent commit changed against its first parent; null when the clone does not hold it. */
  commitFiles: (commit: string) => string[] | null;
}

/** The rates of one window. */
export function buildRates(input: RatesInput): Rates {
  const { evidence } = input;
  const replayed = new Set(
    (evidence.report?.merges ?? []).map((m) => m.commit),
  );
  const mapped = mapFirstParents(input.prs, input.firstParents ?? []);
  const byPath = new Map<string, PathRate>();
  const counts = { conflicted: 0, clean: 0, unknown: 0, filesCut: 0 };
  const pullRequests: RatedPr[] = [];
  for (const pr of [...input.prs].sort((a, b) => a.number - b.number)) {
    const observation = observe(pr, evidence, input.ancestry(pr), replayed);
    counts[observation] += 1;
    const commits = mapped.byPr.get(pr.number) ?? [];
    const local = commits.map(input.commitFiles);
    const files = new Set(pr.files);
    for (const list of local) for (const f of list ?? []) files.add(f);
    if (pr.filesCut && local.every((l) => l === null)) counts.filesCut += 1;
    for (const path of files) {
      const rate = byPath.get(path) ?? {
        path,
        merged: 0,
        conflicted: 0,
        unknown: 0,
      };
      byPath.set(path, rate);
      if (observation === "unknown") rate.unknown += 1;
      else {
        rate.merged += 1;
        if (observation === "conflicted") rate.conflicted += 1;
      }
    }
    pullRequests.push({
      number: pr.number,
      mergedAt: pr.mergedAt,
      observation,
      commits,
      files: files.size,
    });
  }
  const parents = input.firstParents;
  return {
    schema: RATES_SCHEMA,
    generatedAt: input.generatedAt,
    repository: input.repository,
    range: input.range,
    cohort: {
      pullRequests: pullRequests.length,
      ...counts,
      listing: input.listing,
    },
    commits:
      parents === null
        ? null
        : {
            firstParent: parents.length,
            mapped: parents.length - mapped.unknown.length,
            unknown: mapped.unknown.length,
            unknownCommits: mapped.unknown.slice(0, UNKNOWN_COMMITS_LISTED),
          },
    shallow: evidence.report?.shallow ?? false,
    pullRequests,
    paths: [...byPath.values()].sort(
      (a, b) => b.merged - a.merged || a.path.localeCompare(b.path),
    ),
    limits: RATES_LIMITS,
  };
}

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function pathRateOf(v: unknown): PathRate | null {
  if (
    !isRecord(v) ||
    typeof v.path !== "string" ||
    v.path === "" ||
    !count(v.merged) ||
    !count(v.conflicted) ||
    !count(v.unknown) ||
    v.conflicted > v.merged
  )
    return null;
  return {
    path: v.path,
    merged: v.merged,
    conflicted: v.conflicted,
    unknown: v.unknown,
  };
}

/**
 * A rates file as it was read, or null when it is not one this reader
 * knows: another schema, or a path whose counts do not read. Only the paths
 * and the header are checked; the rest is carried as written.
 */
export function parseRates(value: unknown): Rates | null {
  if (
    !isRecord(value) ||
    value.schema !== RATES_SCHEMA ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(parseMs(value.generatedAt)) ||
    typeof value.repository !== "string" ||
    !Array.isArray(value.paths)
  )
    return null;
  const paths = value.paths.map(pathRateOf);
  if (paths.some((p) => p === null)) return null;
  return { ...(value as unknown as Rates), paths: paths as PathRate[] };
}
