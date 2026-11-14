/**
 * One repository's forge state in one query: which repository a checkout
 * is and its default branch, the dispatch configuration on that branch, and
 * every open pull request with its labels, its description, its head, its
 * mergeability, its checks' rollup, its unresolved review threads, the
 * issues it closes and its comments. A tick reads it once per repository
 * (`tick-reads.ts`), in place of a repository view, a file read, a pull
 * request listing and one comment listing per pull request.
 *
 * The query runs in the checkout with the forge client's `{owner}` and
 * `{repo}` placeholders, so the repository is the one the client's own view
 * of the checkout names, as `repoTarget` reads it. It pages through the open
 * pull requests at most `PAGE` at a time and asks for the forge's points as
 * it goes (`rateLimit`), which the forge record reports.
 *
 * The forge ends a query it has worked on for about ten seconds, and what a
 * page costs it depends on what the pull requests carry: a page of fifty
 * with a hundred check results each does not read at all. A page the forge
 * ran out of time on is therefore asked again at half the size, down to one
 * pull request (`shared/outbound/paging.ts`), and the size the read ended at
 * is kept for the repository (`PageSizes`), so the next tick starts from it.
 *
 * Each pull request's comments come back in the forge's comment listing
 * shape (`restComment`), so every reader of a listing reads them as it reads
 * one: the comment's numeric id, its author's login as the listing spells it
 * (a bot's with `[bot]`), the author's association, its times, its link and
 * its body. A pull request with more comments than one page holds is not
 * given here (`overflow`): its comments are listed on their own, in full.
 * Its pull requests are given in the pull request listing's shape
 * (`listedPullRequest`), labels always among them; the repository's own
 * section decides whether they are used.
 *
 * The merged pull requests whose follow-up markers a tick reads are read the
 * same way, at most `PAGE` to a query by their numbers (`readComments`),
 * their comments in the same shape, a query the forge ran out of time on
 * asked again for half as many.
 *
 * A query that fails, or that reads in part (a file the forge truncates, a
 * pull request with more labels than one page, more pull requests than a
 * listing holds), is a failure value: the tick then reads the same facts one
 * by one, as it would without this.
 */
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import {
  type KeptSize,
  keptSize,
  readShrinking,
  SLOW_MS,
  sizeToKeep,
  startSize,
} from "../../shared/outbound/paging.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import { failedBy } from "../../shared/outbound/failure.ts";
import { ghRunFailure } from "../../shared/outbound/github.ts";
import { checksFail } from "./automation.ts";
import type { RepoTarget } from "./types.ts";

/** The most pull requests a page asks for: the forge charges three points for a page this size. */
export const PAGE = 50;

/** Comments, labels and review threads read with each pull request: a pull request with more comments is listed on its own. */
const ITEMS = 100;

/** The issues read as each pull request's closing references; a partial read remains unknown. */
const CLOSING = 5;

/** The most open pull requests the read takes, as the pull request listing does. */
const PR_LIMIT = 1000;

/** The queries' names, which a fake forge recognises. */
const QUERY_NAME = "DispatchRepository";
const COMMENTS_QUERY_NAME = "DispatchComments";

/** What the queries read of a pull request's comments: one page, and whether there are more. */
const COMMENTS = `comments(first: ${ITEMS}) {
          pageInfo { hasNextPage }
          nodes { databaseId fullDatabaseId url createdAt updatedAt authorAssociation body author { __typename login } }
        }`;

const QUERY = `query ${QUERY_NAME}($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name target { ... on Commit { file(path: "${OVERLAY_RELPATH}") { object { ... on Blob { text isTruncated } } } } } }
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number url title body headRefName isCrossRepository createdAt headRefOid baseRefName mergeable isDraft updatedAt
        author { __typename login }
        labels(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { name } }
        headRef { target { ... on Commit { statusCheckRollup { contexts(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { conclusion } ... on StatusContext { state } } } } } } }
        reviewThreads(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { isResolved } }
        closingIssuesReferences(first: ${CLOSING}) { pageInfo { hasNextPage } nodes { number repository { nameWithOwner } } }
        ${COMMENTS}
      }
    }
  }
}`;

/** The pull requests' comments a query read. */
export interface CommentsRead {
  /** Each pull request's comments, as the comment listing gives them, where one page held them all. */
  comments: Map<number, unknown[]>;
  /** The pull requests with more comments than one page holds, or none read: listed on their own. */
  overflow: number[];
  /** When the query began, in epoch milliseconds. */
  startedAtMs: number;
  pages: number;
  /** The forge's points the pages cost, as the forge counts them. */
  cost: number;
}

/** What one repository's query read. */
export interface RepositoryRead extends CommentsRead {
  target: RepoTarget;
  /** The pull requests a page asked for when the read ended: `PAGE`, or fewer where the forge ran out of time on a larger page. */
  pageSize: number;
  /** The dispatch configuration file on the default branch; `null` when the branch has none. */
  config: string | null;
  /** The open pull requests, as the pull request listing gives them, labels included. */
  open: unknown[];
}

/** A query's answer, or the part of it, that does not read as one. */
type Read<T> = Outcome<T, "unreadable">;

/**
 * One query as the forge answered it: `too-costly` when the forge ran out
 * of time on it, which fewer items to a query may avoid; any other failed
 * call is `unreadable`, carrying its failure class (`failedBy`).
 */
type Asked<T> = Outcome<T, "unreadable" | "too-costly">;

/**
 * Page sizes kept between reads, each under a key its read chooses. A size
 * is a hint: one that is lost or does not read costs a read that starts at
 * `PAGE` again.
 */
export interface PageSizes {
  get(key: string): unknown;
  set(key: string, size: KeptSize): void;
}

/** One page of the repository's query in the checkout at `path`, `size` pull requests after the cursor `after`. */
export type AskPage = (
  path: string,
  after: string | null,
  size: number,
) => Promise<Asked<unknown>>;

/** The comments query over the pull requests `prs` of the repository `owner`/`name`. */
export type AskComments = (
  owner: string,
  name: string,
  prs: readonly number[],
) => Promise<Asked<unknown>>;

/** How a read's pages went: what was kept for it, the size it started from and the size its pages are asked at, how many read, and how long the slowest of those took. */
interface Paging {
  kept: KeptSize | null;
  started: number;
  size: number;
  read: number;
  slowestMs: number;
}

/** A read's paging as it starts: from the size kept under `key`, else `PAGE`. */
function pagingOf(sizes: PageSizes | undefined, key: string): Paging {
  const kept = keptSize(sizes?.get(key), PAGE);
  const started = startSize(kept, PAGE);
  return { kept, started, size: started, read: 0, slowestMs: 0 };
}

/**
 * One request of a paged read, asked at `paging.size` and at half as many
 * each time the forge runs out of time on it; `paging` then holds the size
 * that read. A request the forge ran out of time on at one item does not
 * read.
 */
async function shrinking(
  paging: Paging,
  what: string,
  ask: (size: number) => Promise<Asked<unknown>>,
  most = paging.size,
): Promise<Read<unknown>> {
  const read = await readShrinking(
    Math.min(paging.size, most),
    ask,
    (failure) => failure.code === "too-costly",
  );
  // A request short only because fewer items remain is no shrink to keep.
  if (read.size < Math.min(paging.size, most)) paging.size = read.size;
  if (read.outcome.ok) {
    // Only a request asked at the whole size says how that size fares: a
    // shorter one may not grow or halve it. A slow one still counts against
    // growth, though never as far as a halving.
    if (read.size === paging.size) {
      paging.read += 1;
      paging.slowestMs = Math.max(paging.slowestMs, read.tookMs);
    } else {
      paging.slowestMs = Math.max(
        paging.slowestMs,
        Math.min(read.tookMs, SLOW_MS - 1),
      );
    }
    return read.outcome;
  }
  const { code, reason } = read.outcome.failure;
  return partial(
    code === "too-costly"
      ? `${reason}: the forge ran out of time on ${what}${read.size === 1 ? ", asked one at a time" : ""}`
      : reason,
  );
}

/** Keep the size the next read of `key` starts from, where this one changes it (`sizeToKeep`). */
function keepSize(
  sizes: PageSizes | undefined,
  key: string,
  paging: Paging,
  whole: boolean,
): void {
  const next = sizeToKeep(
    paging.kept,
    {
      started: paging.started,
      size: paging.size,
      pages: paging.read,
      slowestMs: paging.slowestMs,
      whole,
    },
    PAGE,
    Date.now(),
  );
  if (next !== null) sizes?.set(key, next);
}

function partial(reason: string): Read<never> {
  return failed("unreadable", reason);
}

function field(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) at = isRecord(at) ? at[key] : undefined;
  return at;
}

const text = (v: unknown): v is string => typeof v === "string";

/** A string field, kept only when the forge gave one, so an absent fact stays absent. */
function strings(
  node: Record<string, unknown>,
  keys: readonly (readonly [from: string, to: string])[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of keys) {
    const v = node[from];
    if (text(v)) out[to] = v;
  }
  return out;
}

/** An author's login as the comment listing spells it: a bot's carries `[bot]`, and a deleted account reads as `ghost`. */
function listingLogin(author: unknown): string {
  if (!isRecord(author) || !text(author.login)) return "ghost";
  return author.__typename === "Bot" ? `${author.login}[bot]` : author.login;
}

/** A comment's numeric id: the full one where the forge gives it, its short one otherwise. */
function commentId(node: Record<string, unknown>): number | null {
  const full = Number(node.fullDatabaseId);
  if (text(node.fullDatabaseId) && Number.isSafeInteger(full)) return full;
  return typeof node.databaseId === "number" ? node.databaseId : null;
}

/** One comment of the query in the comment listing's shape; `null` when it carries no id. */
export function restComment(node: unknown): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  const id = commentId(node);
  if (id === null) return null;
  return {
    id,
    user: { login: listingLogin(node.author) },
    ...strings(node, [
      ["authorAssociation", "author_association"],
      ["createdAt", "created_at"],
      ["updatedAt", "updated_at"],
      ["url", "html_url"],
      ["body", "body"],
    ]),
  };
}

/** A pull request's author as the pull request listing gives it: a bot's login as `app/<name>`. */
function listedAuthor(
  author: unknown,
): { login: string; is_bot: boolean } | null {
  if (!isRecord(author) || !text(author.login)) return null;
  const bot = author.__typename === "Bot";
  return { login: bot ? `app/${author.login}` : author.login, is_bot: bot };
}

/**
 * How many of a pull request's review threads the query read are
 * unresolved; nothing when they do not read, or when one page held none
 * unresolved and there are more, so the count would be a guess.
 */
function unresolvedOf(node: Record<string, unknown>): {
  unresolvedThreads?: number;
} {
  const nodes = field(node, "reviewThreads", "nodes");
  if (!Array.isArray(nodes)) return {};
  const open = nodes.filter((n) => field(n, "isResolved") === false).length;
  const more = field(node, "reviewThreads", "pageInfo", "hasNextPage");
  return open === 0 && more !== false ? {} : { unresolvedThreads: open };
}

/**
 * The checks on a pull request's head commit in the listing's shape (each a
 * run's `conclusion` or a status's `state`); nothing when they do not read,
 * or when one page held no failure and there are more, so whether one
 * failed would be a guess.
 */
function rollupOf(node: Record<string, unknown>): {
  statusCheckRollup?: unknown[];
} {
  const contexts = field(
    node,
    "headRef",
    "target",
    "statusCheckRollup",
    "contexts",
  );
  const nodes = field(contexts, "nodes");
  if (!Array.isArray(nodes)) return {};
  const more = field(contexts, "pageInfo", "hasNextPage");
  return more !== false && checksFail(nodes) !== true
    ? {}
    : { statusCheckRollup: nodes };
}

/** The issues the forge says a pull request closes, each with its repository; nothing when they do not read. */
function closingOf(node: Record<string, unknown>): {
  closing?: Array<{ number: number; repository: string }>;
} {
  if (
    field(node, "closingIssuesReferences", "pageInfo", "hasNextPage") !== false
  )
    return {};
  const nodes = field(node, "closingIssuesReferences", "nodes");
  if (!Array.isArray(nodes)) return {};
  const closing = nodes.map((n) => ({
    number: field(n, "number"),
    repository: field(n, "repository", "nameWithOwner"),
  }));
  return closing.every(
    (c) => typeof c.number === "number" && text(c.repository),
  )
    ? { closing: closing as Array<{ number: number; repository: string }> }
    : {};
}

/** One open pull request of the query in the pull request listing's shape; `unreadable` when it or its labels read in part. */
export function listedPullRequest(
  node: unknown,
): Read<Record<string, unknown>> {
  if (!isRecord(node)) return partial("a pull request is unreadable");
  const more = field(node, "labels", "pageInfo", "hasNextPage");
  if (more === true)
    return partial(
      `PR #${String(node.number)} has more labels than one read holds`,
    );
  const labels = field(node, "labels", "nodes");
  if (typeof node.number !== "number" || !text(node.headRefName))
    return partial("a pull request lacks its number or head branch");
  if (
    more !== false ||
    !Array.isArray(labels) ||
    !labels.every((l) => isRecord(l) && text(l.name))
  )
    return partial(`PR #${node.number} has unreadable labels`);
  const author = listedAuthor(node.author);
  return ok({
    number: node.number,
    ...strings(
      node,
      [
        "url",
        "title",
        "body",
        "headRefName",
        "createdAt",
        "headRefOid",
        "baseRefName",
        "mergeable",
        "updatedAt",
      ].map((k) => [k, k] as const),
    ),
    ...(typeof node.isDraft === "boolean" ? { isDraft: node.isDraft } : {}),
    ...(typeof node.isCrossRepository === "boolean"
      ? { isCrossRepository: node.isCrossRepository }
      : {}),
    ...(author === null ? {} : { author }),
    ...rollupOf(node),
    ...unresolvedOf(node),
    ...closingOf(node),
    labels,
  });
}

/** The configuration file the default branch holds, `null` when none; `unreadable` when the forge cut it short. */
function configOf(repository: unknown): Read<string | null> {
  const file = field(
    repository,
    "defaultBranchRef",
    "target",
    "file",
    "object",
  );
  if (file === undefined || file === null) return ok(null);
  if (field(file, "isTruncated") === true || !text(field(file, "text")))
    return partial(`${OVERLAY_RELPATH} came back cut short or not text`);
  return ok(field(file, "text") as string);
}

/** One query's answer, run in `cwd` where it names the repository by the checkout. */
async function graphql(args: string[], cwd?: string): Promise<Asked<unknown>> {
  const began = Date.now();
  const r = await ghCall(["api", "graphql", ...args], {
    stderr: "pipe",
    env: ghRepoEnv(),
    ...(cwd === undefined ? {} : { cwd }),
  });
  const failure = ghRunFailure(r, Date.now() - began);
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
    return failed("unreadable", "the query's answer is not JSON", error);
  }
}

/** One page of the repository's query, as the forge answered it in the checkout at `path`. */
const page: AskPage = (path, after, size) =>
  graphql(
    [
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
    path,
  );

/** Hold one pull request's comments in `read`, or count it among those listed on their own. */
function addComments(
  read: CommentsRead,
  number: number,
  connection: unknown,
): void {
  const all = field(connection, "nodes");
  const mapped = Array.isArray(all) ? all.map(restComment) : [];
  const whole =
    field(connection, "pageInfo", "hasNextPage") === false &&
    Array.isArray(all) &&
    mapped.every((c) => c !== null);
  if (whole) read.comments.set(number, mapped as Record<string, unknown>[]);
  else read.overflow.push(number);
}

/** Count one page's points and the page itself in `read`. */
function addCost(read: CommentsRead, answer: unknown): void {
  const cost = field(answer, "data", "rateLimit", "cost");
  if (typeof cost === "number") read.cost += cost;
  read.pages += 1;
}

/** The repository the first page names, or why it does not read. */
function targetOf(path: string, repository: unknown): Read<RepoTarget> {
  const slug = field(repository, "nameWithOwner");
  const branch = field(repository, "defaultBranchRef", "name");
  if (!text(slug) || !/^[\w.-]+\/[\w.-]+$/.test(slug))
    return partial("the repository query names no owner/name");
  if (!text(branch) || branch === "")
    return partial(`${slug} reports no default branch`);
  return ok({ path, slug, defaultBranch: branch });
}

/** Add one page's pull requests and their comments to `read`; the cursor of the next page, or `null` at the last. */
function addPage(read: RepositoryRead, answer: unknown): Read<string | null> {
  const prs = field(answer, "data", "repository", "pullRequests");
  const nodes = field(prs, "nodes");
  if (!Array.isArray(nodes))
    return partial("the repository query lists no pull requests");
  for (const node of nodes) {
    const listed = listedPullRequest(node);
    if (!listed.ok) return listed;
    read.open.push(listed.value);
    const number = listed.value.number;
    if (typeof number === "number")
      addComments(read, number, field(node, "comments"));
  }
  if (read.open.length >= PR_LIMIT)
    return partial(
      `${read.target.slug} lists ${PR_LIMIT} or more pull requests, more than one read holds`,
    );
  addCost(read, answer);
  const more = field(prs, "pageInfo", "hasNextPage");
  if (more === false) return ok(null);
  const next = field(prs, "pageInfo", "endCursor");
  if (more !== true || !text(next) || next === "")
    return partial(
      "the repository query's page info names neither the last page nor the next",
    );
  return ok(next);
}

/**
 * The repository of the checkout at `path`, read in one query of as many
 * pages as its open pull requests need, each page as large as the forge
 * answers in time; or why it did not read in full. `sizes` keeps the page
 * size between reads, and `ask` is the forge.
 */
export async function readRepository(
  path: string,
  sizes?: PageSizes,
  ask: AskPage = page,
): Promise<Outcome<RepositoryRead, "unreadable">> {
  const key = `repository:${path}`;
  const paging = pagingOf(sizes, key);
  const read = await readPages(path, paging, ask);
  keepSize(sizes, key, paging, read.ok);
  return read;
}

/** The repository's pages, each asked at `paging`'s size as it stands. */
async function readPages(
  path: string,
  paging: Paging,
  ask: AskPage,
): Promise<Outcome<RepositoryRead, "unreadable">> {
  const startedAtMs = Date.now();
  const pageAfter = (after: string | null) =>
    shrinking(paging, "a page of pull requests", (size) =>
      ask(path, after, size),
    );
  const first = await pageAfter(null);
  if (!first.ok) return first;
  const repository = field(first.value, "data", "repository");
  const target = targetOf(path, repository);
  if (!target.ok) return target;
  const config = configOf(repository);
  if (!config.ok) return config;
  const read: RepositoryRead = {
    target: target.value,
    config: config.value,
    open: [],
    comments: new Map(),
    overflow: [],
    startedAtMs,
    pages: 0,
    cost: 0,
    pageSize: paging.size,
  };
  let cursor = addPage(read, first.value);
  while (cursor.ok && cursor.value !== null) {
    const next = await pageAfter(cursor.value);
    if (!next.ok) return next;
    cursor = addPage(read, next.value);
  }
  read.pageSize = paging.size;
  return cursor.ok ? ok(read) : cursor;
}

/** The comments query over `prs`, each aliased by its number. */
function commentsQuery(prs: readonly number[]): string {
  const each = prs.map(
    (n) => `pr${n}: pullRequest(number: ${n}) {
        ${COMMENTS}
      }`,
  );
  return `query ${COMMENTS_QUERY_NAME}($owner: String!, $name: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
      ${each.join("\n      ")}
  }
}`;
}

/** The comments query as the forge answers it. */
const comments: AskComments = (owner, name, prs) =>
  graphql([
    "-f",
    `query=${commentsQuery(prs)}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);

/**
 * The comments of the pull requests `prs` of `slug`, read at most `PAGE`
 * to a query, as many as the forge answers in time; or why they did not
 * read. `sizes` keeps that number between reads, and `ask` is the forge.
 */
export async function readComments(
  slug: string,
  prs: readonly number[],
  sizes?: PageSizes,
  ask: AskComments = comments,
): Promise<Outcome<CommentsRead, "unreadable">> {
  const key = `comments:${slug}`;
  const paging = pagingOf(sizes, key);
  const read = await readChunks(slug, prs, paging, ask);
  keepSize(sizes, key, paging, read.ok);
  return read;
}

/** The comments queries over `prs`, each over as many as `paging`'s size as it stands. */
async function readChunks(
  slug: string,
  prs: readonly number[],
  paging: Paging,
  ask: AskComments,
): Promise<Outcome<CommentsRead, "unreadable">> {
  const [owner = "", name = ""] = slug.split("/");
  const read: CommentsRead = {
    comments: new Map(),
    overflow: [],
    startedAtMs: Date.now(),
    pages: 0,
    cost: 0,
  };
  if (prs.some((n) => !Number.isSafeInteger(n) || n <= 0))
    return partial("a pull request number is not a whole number");
  for (let at = 0; at < prs.length; ) {
    // The query that read says how many it read: a smaller one reads fewer.
    let chunk: readonly number[] = [];
    const answer = await shrinking(
      paging,
      "pull requests' comments",
      (size) => {
        // A final short chunk must begin at its remaining size, otherwise a
        // timeout retries the same query while only the nominal size shrinks.
        chunk = prs.slice(at, at + Math.min(size, prs.length - at));
        return ask(owner, name, chunk);
      },
      prs.length - at,
    );
    if (!answer.ok) return answer;
    const repository = field(answer.value, "data", "repository");
    for (const n of chunk)
      addComments(read, n, field(repository, `pr${n}`, "comments"));
    addCost(read, answer.value);
    at += chunk.length;
  }
  return ok(read);
}
