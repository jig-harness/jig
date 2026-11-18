/**
 * The merged pull requests a window's conflict rates count, read from the
 * forge through its governed transport (`ghCall`: the shared budget, the
 * call's deadline, the cost ledger, the closed failure classes).
 *
 * One listing of the repository's merged pull requests, the most recently
 * updated first, each with its merge commit, its head, the files it changed,
 * its commits' subjects and author dates (which tell the first-parent
 * commits of a rebase merge apart) and whether its branch was force-pushed.
 * A merged pull request is updated no earlier than it merged, so the listing
 * stops at the first one updated before the window: every one after it
 * merged before the window too.
 *
 * What a listing read is kept (`CohortCache`), by pull request and merge
 * commit: a merged pull request does not change. The next listing over a
 * window the kept one covers stops at the first pull request updated before
 * the kept listing began, less `RELIST_MARGIN_MS`, and takes the rest from
 * what was kept. A listing that reaches `COHORT_LIMIT` pull requests before
 * it stops is cut, and does not read: a cohort read in part would count too
 * few pull requests for the paths it missed.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { failedBy } from "../../../../shared/outbound/failure.ts";
import { ghRunFailure } from "../../../../shared/outbound/github.ts";
import { readShrinking } from "../../../../shared/outbound/paging.ts";
import { currentMs, isoFromMs, parseMs } from "../../../../shared/time.ts";
import { ghCall, ghRepoEnv } from "../../../drive-pr/scripts/lib/proc.ts";

export const COHORT_SCHEMA = "merged-pr-cohort/v1";

/** The query's name, which the cost ledger records the listing under. */
export const COHORT_QUERY_NAME = "ConflictRatesCohort";

/** The pull requests a page asks for: the forge charges about two points for a page this size. */
export const COHORT_PAGE = 50;

/** The most pull requests one listing reads: the forge lists at most this many for a search, and a listing that reaches it is cut. */
export const COHORT_LIMIT = 1000;

/** How far before the kept listing began the next one reaches again, for a pull request the forge recorded late. */
export const RELIST_MARGIN_MS = 3_600_000;

/** Files and commits read with each pull request; a pull request with more files is marked cut. */
const ITEMS = 100;

const QUERY = `query ${COHORT_QUERY_NAME}($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt limit }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequests(states: MERGED, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt updatedAt mergedAt headRefOid baseRefName
        mergeCommit { oid }
        files(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { path } }
        commits(first: ${ITEMS}) { totalCount nodes { commit { messageHeadline authoredDate committedDate } } }
        timelineItems(first: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { __typename } }
      }
    }
  }
}`;

/** One commit of a pull request's branch, as the forge lists it. */
export interface CohortCommit {
  subject: string;
  authoredAt: string;
  committedAt: string;
}

/** One merged pull request of the cohort. */
export interface CohortPr {
  number: number;
  createdAt: string;
  mergedAt: string;
  /** The commit it landed as on its base branch: the merge commit, the squashed commit, or a rebase merge's last commit. */
  mergeCommit: string | null;
  headRefOid: string | null;
  baseRefName: string;
  /** The files the forge lists for it, at most one page. */
  files: string[];
  /** Whether it changed more files than one page lists. */
  filesCut: boolean;
  commitCount: number;
  /** Its branch's commits, at most one page. */
  commits: CohortCommit[];
  /** Whether the forge records a force-push of its branch, which can hide a rebase's conflicts. */
  forcePushed: boolean;
}

/** What a complete listing read, kept for the next one. */
export interface CohortCache {
  schema: typeof COHORT_SCHEMA;
  repository: string;
  /** The window's start the listing reached back to; null for the whole history. */
  since: string | null;
  /** When the listing began. */
  listedAt: string;
  prs: CohortPr[];
}

export interface CohortListing {
  pages: number;
  /** Pull requests the listing returned, those merged before the window included. */
  listed: number;
  /** Pull requests taken from the kept listing rather than listed again. */
  reused: number;
  /** The forge's points the pages cost, as it reported them; null when it reported none. */
  cost: number | null;
  /** How far back the listing reached: the window's start, or the kept listing's. */
  from: "window" | "previous listing";
}

export interface Cohort {
  repository: string;
  defaultBranch: string | null;
  /** The pull requests merged inside the window, by number. */
  prs: CohortPr[];
  listing: CohortListing;
  /** What to keep for the next listing. */
  cache: CohortCache;
}

export type CohortCode = "unreadable" | "cut";

/** One page of the listing, `size` pull requests after the cursor `after`. */
export type AskCohortPage = (
  after: string | null,
  size: number,
) => Promise<Outcome<unknown, "unreadable" | "too-costly">>;

function field(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) at = isRecord(at) ? at[key] : undefined;
  return at;
}

const text = (v: unknown): v is string => typeof v === "string";
const instant = (v: unknown): v is string =>
  text(v) && Number.isFinite(parseMs(v));

function commitOf(node: unknown): CohortCommit | null {
  const commit = field(node, "commit");
  const subject = field(commit, "messageHeadline");
  const authoredAt = field(commit, "authoredDate");
  const committedAt = field(commit, "committedDate");
  if (!text(subject) || !instant(authoredAt) || !instant(committedAt))
    return null;
  return { subject, authoredAt, committedAt };
}

function filesOf(node: Record<string, unknown>): string[] | null {
  const nodes = field(node, "files", "nodes");
  if (!Array.isArray(nodes)) return null;
  const paths = nodes.map((f) => field(f, "path"));
  return paths.every((p): p is string => text(p) && p !== "") ? paths : null;
}

function commitsOf(node: Record<string, unknown>): CohortCommit[] | null {
  const nodes = field(node, "commits", "nodes");
  if (!Array.isArray(nodes)) return null;
  const commits = nodes.map(commitOf);
  return commits.every((c): c is CohortCommit => c !== null) ? commits : null;
}

/** One pull request of a page, or null when it does not read. */
export function cohortPrOf(node: unknown): CohortPr | null {
  if (!isRecord(node) || typeof node.number !== "number") return null;
  const { createdAt, mergedAt, headRefOid, baseRefName } = node;
  if (!instant(createdAt) || !instant(mergedAt) || !text(baseRefName))
    return null;
  const files = filesOf(node);
  const commits = commitsOf(node);
  const count = field(node, "commits", "totalCount");
  const pushes = field(node, "timelineItems", "nodes");
  const oid = field(node, "mergeCommit", "oid");
  if (
    files === null ||
    commits === null ||
    typeof count !== "number" ||
    !Array.isArray(pushes)
  )
    return null;
  return {
    number: node.number,
    createdAt,
    mergedAt,
    mergeCommit: text(oid) && oid !== "" ? oid : null,
    headRefOid: text(headRefOid) && headRefOid !== "" ? headRefOid : null,
    baseRefName,
    files,
    filesCut: field(node, "files", "pageInfo", "hasNextPage") === true,
    commitCount: count,
    commits,
    forcePushed: pushes.length > 0,
  };
}

function cachedPr(value: unknown): CohortPr | null {
  if (!isRecord(value)) return null;
  const v = value;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((s) => text(s));
  const commits = Array.isArray(v.commits)
    ? v.commits.map((c) =>
        isRecord(c) &&
        text(c.subject) &&
        instant(c.authoredAt) &&
        instant(c.committedAt)
          ? {
              subject: c.subject,
              authoredAt: c.authoredAt,
              committedAt: c.committedAt,
            }
          : null,
      )
    : null;
  if (
    typeof v.number !== "number" ||
    !instant(v.createdAt) ||
    !instant(v.mergedAt) ||
    !(v.mergeCommit === null || text(v.mergeCommit)) ||
    !(v.headRefOid === null || text(v.headRefOid)) ||
    !text(v.baseRefName) ||
    !strings(v.files) ||
    typeof v.filesCut !== "boolean" ||
    typeof v.commitCount !== "number" ||
    commits === null ||
    commits.some((c) => c === null) ||
    typeof v.forcePushed !== "boolean"
  )
    return null;
  return {
    number: v.number,
    createdAt: v.createdAt,
    mergedAt: v.mergedAt,
    mergeCommit: v.mergeCommit,
    headRefOid: v.headRefOid,
    baseRefName: v.baseRefName,
    files: v.files as string[],
    filesCut: v.filesCut,
    commitCount: v.commitCount,
    commits: commits as CohortCommit[],
    forcePushed: v.forcePushed,
  };
}

/** A kept listing, or null when it does not read: a listing that is not reused. */
export function parseCohortCache(value: unknown): CohortCache | null {
  if (
    !isRecord(value) ||
    value.schema !== COHORT_SCHEMA ||
    !text(value.repository) ||
    !(value.since === null || instant(value.since)) ||
    !instant(value.listedAt) ||
    !Array.isArray(value.prs)
  )
    return null;
  const prs = value.prs.map(cachedPr);
  if (prs.some((p) => p === null)) return null;
  return {
    schema: COHORT_SCHEMA,
    repository: value.repository,
    since: value.since,
    listedAt: value.listedAt,
    prs: prs as CohortPr[],
  };
}

/** Whether a kept listing covers the window: the same repository, reaching back at least as far. */
function covers(
  kept: CohortCache | null,
  repository: string,
  since: number | null,
): kept is CohortCache {
  if (kept === null || kept.repository !== repository) return false;
  if (kept.since === null) return true;
  return since !== null && parseMs(kept.since) <= since;
}

interface Page {
  repository: string;
  defaultBranch: string | null;
  nodes: unknown[];
  next: string | null;
  cost: number | null;
}

function pageOf(answer: unknown): Outcome<Page, "unreadable"> {
  if (isRecord(answer) && answer.errors !== undefined)
    return failed("unreadable", "the forge answered the listing with errors");
  const repository = field(answer, "data", "repository");
  const name = field(repository, "nameWithOwner");
  const listing = field(repository, "pullRequests");
  const nodes = field(listing, "nodes");
  if (!text(name) || !Array.isArray(nodes))
    return failed(
      "unreadable",
      "the merged pull request listing does not read",
    );
  const more = field(listing, "pageInfo", "hasNextPage") === true;
  const cursor = field(listing, "pageInfo", "endCursor");
  if (more && !text(cursor))
    return failed(
      "unreadable",
      "the listing has another page and no cursor to it",
    );
  const branch = field(repository, "defaultBranchRef", "name");
  const cost = field(answer, "data", "rateLimit", "cost");
  return ok({
    repository: name,
    defaultBranch: text(branch) && branch !== "" ? branch : null,
    nodes,
    next: more ? (cursor as string) : null,
    cost: typeof cost === "number" ? cost : null,
  });
}

export interface CohortInput {
  /** The window, milliseconds since the epoch; null is open. */
  since: number | null;
  until: number | null;
  now: number;
  /** The kept listing as it was read from its file; anything that does not read is not reused. */
  cache: unknown;
  ask: AskCohortPage;
  pageSize?: number;
  limit?: number;
}

interface Walk {
  repository: string | null;
  defaultBranch: string | null;
  listed: Map<number, CohortPr>;
  count: number;
  pages: number;
  cost: number | null;
  stopAt: number;
  reusing: boolean;
}

/** Read one page into `walk`; whether the listing is done. */
function takePage(
  walk: Walk,
  page: Page,
  kept: CohortCache | null,
  since: number | null,
): Outcome<boolean, "unreadable"> {
  if (walk.repository === null) {
    walk.repository = page.repository;
    walk.defaultBranch = page.defaultBranch;
    walk.reusing = covers(kept, page.repository, since);
    const floor = since ?? Number.NEGATIVE_INFINITY;
    walk.stopAt =
      walk.reusing && kept !== null
        ? Math.max(floor, parseMs(kept.listedAt) - RELIST_MARGIN_MS)
        : floor;
  }
  walk.pages += 1;
  if (page.cost !== null) walk.cost = (walk.cost ?? 0) + page.cost;
  for (const node of page.nodes) {
    const updated = field(node, "updatedAt");
    if (!instant(updated))
      return failed("unreadable", "a merged pull request has no update time");
    if (parseMs(updated) < walk.stopAt) return ok(true);
    const pr = cohortPrOf(node);
    if (pr === null)
      return failed(
        "unreadable",
        `merged pull request ${String(field(node, "number"))} of the listing does not read`,
      );
    walk.count += 1;
    walk.listed.set(pr.number, pr);
  }
  return ok(page.next === null);
}

/** Ask one page, at half the size each time the forge runs out of time on it. */
async function askPage(
  ask: AskCohortPage,
  after: string | null,
  size: number,
): Promise<Outcome<Page, "unreadable">> {
  const read = await readShrinking(
    size,
    (n) => ask(after, n),
    (failure) => failure.code === "too-costly",
  );
  if (!read.outcome.ok) {
    const { failure } = read.outcome;
    return failure.code === "too-costly"
      ? failed(
          "unreadable",
          `${failure.reason}: the forge ran out of time on one merged pull request`,
          failure,
        )
      : (read.outcome as Outcome<never, "unreadable">);
  }
  return pageOf(read.outcome.value);
}

const inWindow = (pr: CohortPr, since: number | null, until: number | null) => {
  const at = parseMs(pr.mergedAt);
  return (since === null || at >= since) && (until === null || at < until);
};

/**
 * The cohort of the window `[since, until)`: what the listing reads, and what
 * the kept listing holds where this one did not reach. `cut` when the listing
 * reaches its bound first, `unreadable` when a page does not read.
 */
export async function readCohort(
  input: CohortInput,
): Promise<Outcome<Cohort, CohortCode>> {
  const { since, until, now, ask } = input;
  const size = input.pageSize ?? COHORT_PAGE;
  const limit = input.limit ?? COHORT_LIMIT;
  const kept = parseCohortCache(input.cache);
  const walk: Walk = {
    repository: null,
    defaultBranch: null,
    listed: new Map(),
    count: 0,
    pages: 0,
    cost: null,
    stopAt: Number.NEGATIVE_INFINITY,
    reusing: false,
  };
  let after: string | null = null;
  for (;;) {
    if (walk.count >= limit)
      return failed(
        "cut",
        `the merged pull request listing reached its bound of ${limit} pull requests before it reached the window's start`,
      );
    const page = await askPage(ask, after, Math.min(size, limit - walk.count));
    if (!page.ok) return page;
    const done = takePage(walk, page.value, kept, since);
    if (!done.ok) return done;
    if (done.value) break;
    after = page.value.next;
  }
  const repository = walk.repository as string;
  const all = new Map<number, CohortPr>();
  if (walk.reusing && kept !== null)
    for (const pr of kept.prs)
      if (inWindow(pr, since, null)) all.set(pr.number, pr);
  for (const [n, pr] of walk.listed)
    if (inWindow(pr, since, null)) all.set(n, pr);
  const keep = [...all.values()].sort((a, b) => a.number - b.number);
  const prs = keep.filter((pr) => inWindow(pr, since, until));
  return ok({
    repository,
    defaultBranch: walk.defaultBranch,
    prs,
    listing: {
      pages: walk.pages,
      listed: walk.count,
      reused: prs.filter((pr) => !walk.listed.has(pr.number)).length,
      cost: walk.cost,
      from: walk.reusing ? "previous listing" : "window",
    },
    cache: {
      schema: COHORT_SCHEMA,
      repository,
      since: since === null ? null : isoFromMs(since),
      listedAt: isoFromMs(now),
      prs: keep,
    },
  });
}

/**
 * The forge's listing, one page at a time, through `ghCall` in the checkout
 * at `cwd`, whose repository the forge client's `{owner}` and `{repo}` name.
 */
export function askCohortPage(cwd: string): AskCohortPage {
  return async (after, size) => {
    const began = currentMs();
    const r = await ghCall(
      [
        "api",
        "graphql",
        "-f",
        `query=${QUERY}`,
        "-F",
        "owner={owner}",
        "-F",
        "name={repo}",
        "-F",
        `first=${size}`,
        ...(after === null ? [] : ["-f", `after=${after}`]),
      ],
      { stderr: "pipe", env: ghRepoEnv(), cwd },
    );
    const failure = ghRunFailure(r, currentMs() - began);
    if (failure !== null) {
      const tail = r.stderr.trim().split("\n").at(-1) ?? "";
      return failedBy(
        failure.code === "too-costly" ? "too-costly" : "unreadable",
        failure,
        `gh api graphql exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
      );
    }
    try {
      return ok(JSON.parse(r.stdout));
    } catch (error) {
      return failed("unreadable", "the listing's answer is not JSON", error);
    }
  };
}
