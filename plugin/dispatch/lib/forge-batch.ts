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
 * pull requests `PAGE` at a time, or at the smaller size a tick kept for the
 * repository, and asks for the forge's points as it goes (`rateLimit`), which
 * the forge record reports. The forge ends a query after ten seconds, and a
 * page of pull requests that each carry many check results can take longer:
 * a page the forge times out is asked for again at half its size, down to one
 * pull request (`shared/outbound/paging.ts`), and the read reports the size
 * that answered, which the tick keeps (`read-pages.ts`).
 *
 * Where the repository's query does not read, the pull request listing reads
 * the open pull requests' checks here too (`readChecks`), by number, in pages
 * of the size the query last answered at.
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
 * same way, `PAGE` to a query by their numbers (`readComments`), their
 * comments in the same shape.
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
  type Page,
  readPaged,
  TIMED_OUT,
  timedOut,
} from "../../shared/outbound/paging.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import { checksFail } from "./automation.ts";
import type { RepoTarget } from "./types.ts";

/** Pull requests per page at most: the forge charges three points for a page this size. */
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
const CHECKS_QUERY_NAME = "DispatchChecks";

/** What the queries read of a pull request's head commit's checks: one page, and whether there are more. */
const CHECKS = `headRef { target { ... on Commit { statusCheckRollup { contexts(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { __typename ... on CheckRun { conclusion } ... on StatusContext { state } } } } } } }`;

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
        number url title body headRefName createdAt headRefOid baseRefName mergeable isDraft updatedAt
        author { __typename login }
        labels(first: ${ITEMS}) { pageInfo { hasNextPage } nodes { name } }
        ${CHECKS}
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
  /** The pull requests per page the query last answered at: the size to begin the next read with. */
  pageSize: number;
  target: RepoTarget;
  /** The dispatch configuration file on the default branch; `null` when the branch has none. */
  config: string | null;
  /** The open pull requests, as the pull request listing gives them, labels included. */
  open: unknown[];
}

/** A query's answer, or the part of it, that does not read as one. */
type Read<T> = Outcome<T, "unreadable">;

/** A query's answer, or why it did not read: `timed-out` when the forge or the deadline gave up on it, so a smaller page may read. */
type Answer = Outcome<unknown, "unreadable" | typeof TIMED_OUT>;

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
async function graphql(args: string[], cwd?: string): Promise<Answer> {
  const r = await ghCall(["api", "graphql", ...args], {
    stderr: "pipe",
    env: ghRepoEnv(),
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (r.code !== 0) {
    const tail = r.stderr.trim().split("\n").at(-1) ?? "";
    const reason = r.timedOut
      ? "gh api graphql passed its deadline"
      : `gh api graphql exited ${r.code}${tail === "" ? "" : `: ${tail}`}`;
    return failed(
      timedOut(r.stderr, r.timedOut) ? TIMED_OUT : "unreadable",
      reason,
    );
  }
  try {
    return ok(JSON.parse(r.stdout));
  } catch (error) {
    return failed("unreadable", "the query's answer is not JSON", error);
  }
}

/** One page of `size` of the repository's query, as the forge answered it in the checkout at `path`. */
function page(
  path: string,
  after: string | null,
  size: number,
): Promise<Answer> {
  return graphql(
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
}

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

/** A page's failure under the code a read's caller knows: a timeout at a page of one is a read that did not read. */
function unread(failure: { code: string; reason: string }): Read<never> {
  return partial(
    failure.code === TIMED_OUT
      ? `the forge timed out: ${failure.reason}`
      : failure.reason,
  );
}

/** Where the next page of the repository's query starts: after a cursor, or at the start. */
interface At {
  after: string | null;
}

/**
 * The repository of the checkout at `path`, read in one query of as many
 * pages as its open pull requests need, beginning at pages of `size`; or why
 * it did not read in full.
 */
export async function readRepository(
  path: string,
  size = PAGE,
): Promise<Outcome<RepositoryRead, "unreadable">> {
  const startedAtMs = Date.now();
  let read: RepositoryRead | null = null;
  const fetch = async (
    first: number,
    at: At,
  ): Promise<Outcome<Page<null, At>, "unreadable" | typeof TIMED_OUT>> => {
    const answer = await page(path, at.after, first);
    if (!answer.ok) return answer;
    if (read === null) {
      const repository = field(answer.value, "data", "repository");
      const target = targetOf(path, repository);
      if (!target.ok) return target;
      const config = configOf(repository);
      if (!config.ok) return config;
      read = {
        target: target.value,
        config: config.value,
        open: [],
        comments: new Map(),
        overflow: [],
        startedAtMs,
        pages: 0,
        cost: 0,
        pageSize: first,
      };
    }
    const before = read.open.length;
    const next = addPage(read, answer.value);
    if (!next.ok) return next;
    return ok({
      value: null,
      items: read.open.length - before,
      next: next.value === null ? null : { after: next.value },
    });
  };
  const paged = await readPaged({ start: { after: null }, size, fetch });
  if (!paged.ok) return unread(paged.failure);
  const done = read as RepositoryRead | null;
  if (done === null) return partial("the repository query read no page");
  done.pageSize = paged.value.size;
  return ok(done);
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

/** The comments of the pull requests `prs` of `slug`, read `PAGE` to a query; or why they did not read. */
export async function readComments(
  slug: string,
  prs: readonly number[],
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
  for (let at = 0; at < prs.length; at += PAGE) {
    const chunk = prs.slice(at, at + PAGE);
    const answer = await graphql([
      "-f",
      `query=${commentsQuery(chunk)}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]);
    if (!answer.ok) return unread(answer.failure);
    const repository = field(answer.value, "data", "repository");
    for (const n of chunk)
      addComments(read, n, field(repository, `pr${n}`, "comments"));
    addCost(read, answer.value);
  }
  return ok(read);
}

/** The checks query over `prs`, each aliased by its number. */
function checksQuery(prs: readonly number[]): string {
  const each = prs.map(
    (n) => `pr${n}: pullRequest(number: ${n}) { ${CHECKS} }`,
  );
  return `query ${CHECKS_QUERY_NAME}($owner: String!, $name: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
      ${each.join("\n      ")}
  }
}`;
}

/** The checks of named pull requests a query read. */
export interface ChecksRead {
  /** Each pull request's checks in the listing's shape, where they read (`rollupOf`). */
  checks: Map<number, unknown[]>;
  /** The pull requests per query that last answered. */
  pageSize: number;
}

/**
 * The checks on the head commits of the pull requests `prs` of `slug`,
 * `size` pull requests to a query, the page halving where the forge times
 * out; or why they did not read.
 */
export async function readChecks(
  slug: string,
  prs: readonly number[],
  size = PAGE,
): Promise<Outcome<ChecksRead, "unreadable">> {
  const [owner = "", name = ""] = slug.split("/");
  if (prs.some((n) => !Number.isSafeInteger(n) || n <= 0))
    return partial("a pull request number is not a whole number");
  const checks = new Map<number, unknown[]>();
  if (prs.length === 0) return ok({ checks, pageSize: size });
  const paged = await readPaged({
    start: 0,
    size,
    fetch: async (
      first: number,
      at: number,
    ): Promise<
      Outcome<Page<null, number>, "unreadable" | typeof TIMED_OUT>
    > => {
      const chunk = prs.slice(at, at + first);
      const answer = await graphql([
        "-f",
        `query=${checksQuery(chunk)}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
      ]);
      if (!answer.ok) return answer;
      const repository = field(answer.value, "data", "repository");
      for (const n of chunk) {
        const node = field(repository, `pr${n}`);
        const rollup = isRecord(node)
          ? rollupOf(node).statusCheckRollup
          : undefined;
        if (rollup !== undefined) checks.set(n, rollup);
      }
      const next = at + chunk.length;
      return ok({
        value: null,
        items: chunk.length,
        next: next < prs.length ? next : null,
      });
    },
  });
  if (!paged.ok) return unread(paged.failure);
  return ok({ checks, pageSize: paged.value.size });
}
