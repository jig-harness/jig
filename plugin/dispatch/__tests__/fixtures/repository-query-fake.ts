/**
 * The fake forge's answer to the repository's query (`forge-batch.ts`),
 * loaded by the world's `gh` (fixtures.ts) from the files the world keeps:
 * the repository view (a checkout named `other` is another repository),
 * `jig.yaml`, `prs-open.json` paged as the query asks, and each pull
 * request's comments as its listing holds them, turned into the forge's
 * query shapes. `batch-comments-<pr>.json` stands in for a pull request's
 * comments in the query alone: a write landing between the query and a
 * later listing. A pull request's listed checks (`statusCheckRollup`) come
 * back as its head commit's rollup contexts, and its unresolved review threads as
 * many as `threads-<pr>` says (none without it). The query fails while `prs-open-fail` or
 * `repository-query-fail` exists. The comments query over named pull
 * requests (`commentsQuery`) answers each from the same files, and fails
 * while `comments-query-fail` exists. While `query-times-out-above` holds a
 * number, a page of the repository's query asking for more pull requests
 * than it says times out, as the forge does on a page that takes too long. The
 * checks query over named pull requests (`checksQuery`) answers each from
 * `prs-open.json`'s listed checks, and fails while `checks-query-fail`
 * exists.
 */
import { existsSync, readFileSync } from "node:fs";

/** How many comments one page of the query holds. */
const COMMENTS_PAGE = 100;

interface Listed {
  number: number;
  author?: { login: string; is_bot?: boolean };
  labels?: unknown;
  [key: string]: unknown;
}

interface RestComment {
  id: number;
  user?: { login: string };
  author_association?: string;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  body?: string;
}

const actor = (login: string, bot: boolean) =>
  bot ? { __typename: "Bot", login } : { __typename: "User", login };

/** A comment of the listing as the query gives it: a bot's login without `[bot]`. */
function queryComment(c: RestComment) {
  const login = c.user?.login;
  return {
    databaseId: c.id,
    fullDatabaseId: String(c.id),
    url: c.html_url ?? null,
    createdAt: c.created_at ?? null,
    updatedAt: c.updated_at ?? null,
    authorAssociation: c.author_association ?? null,
    body: c.body ?? null,
    author:
      login === undefined
        ? null
        : login.endsWith("[bot]")
          ? actor(login.slice(0, -"[bot]".length), true)
          : actor(login, false),
  };
}

/** A listed pull request's head commit as the query gives it, its listed checks as the rollup's contexts; no rollup when it lists none. */
function headRef(p: Listed) {
  const checks = p.statusCheckRollup;
  if (!Array.isArray(checks)) return { target: { statusCheckRollup: null } };
  return {
    target: {
      statusCheckRollup: {
        contexts: { pageInfo: { hasNextPage: false }, nodes: checks },
      },
    },
  };
}

/** The files the fake forge keeps in `dir`: whether one exists, and one read as JSON. */
function files(dir: string) {
  const has = (name: string) => existsSync(`${dir}/${name}`);
  const json = (name: string): unknown =>
    JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
  /** A pull request's unresolved review threads as the query gives them: as many as `threads-<pr>` says. */
  const threads = (pr: number) => ({
    pageInfo: { hasNextPage: false },
    nodes: Array.from(
      {
        length: has(`threads-${pr}`)
          ? Number(readFileSync(`${dir}/threads-${pr}`, "utf8"))
          : 0,
      },
      () => ({ isResolved: false }),
    ),
  });
  /** A pull request's comments as the query gives them: one page, and whether there are more. */
  const comments = (pr: number) => {
    const listed = json(
      [
        `batch-comments-${pr}.json`,
        `comments-${pr}.json`,
        "comments.json",
      ].find(has) as string,
    ) as RestComment[];
    return {
      pageInfo: { hasNextPage: listed.length > COMMENTS_PAGE },
      nodes: listed.slice(0, COMMENTS_PAGE).map(queryComment),
    };
  };
  return { has, json, comments, threads };
}

/** The comments query's answer, each pull request it names under its alias; `null` for a query that fails. */
export function commentsQuery(dir: string, args: string[]): unknown {
  const { has, comments } = files(dir);
  if (has("comments-query-fail")) return null;
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  const repository: Record<string, unknown> = {};
  for (const [, n] of query.matchAll(/pr(\d+): pullRequest\(number: \d+\)/g))
    repository[`pr${n}`] = { comments: comments(Number(n)) };
  return { data: { rateLimit: { cost: 1, remaining: 4990 }, repository } };
}

/** The checks query's answer, each pull request it names under its alias; `null` for a query that fails. */
export function checksQuery(dir: string, args: string[]): unknown {
  const { has, json } = files(dir);
  if (has("checks-query-fail")) return null;
  const all = json("prs-open.json") as Listed[];
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  const repository: Record<string, unknown> = {};
  for (const [, n] of query.matchAll(/pr(\d+): pullRequest\(number: \d+\)/g)) {
    const listed = all.find((p) => p.number === Number(n));
    repository[`pr${n}`] =
      listed === undefined ? null : { headRef: headRef(listed) };
  }
  return { data: { rateLimit: { cost: 1, remaining: 4990 }, repository } };
}

/** The query's answer, `"timeout"` for a page the forge times out, or `null` for a query that fails. */
export function repositoryQuery(
  dir: string,
  args: string[],
  cwd: string,
): unknown {
  const { has, json, comments, threads } = files(dir);
  if (has("prs-open-fail") || has("repository-query-fail")) return null;
  const arg = (key: string) =>
    (args.find((a) => a.startsWith(`${key}=`)) ?? "").slice(key.length + 1);
  const first = Number(arg("first"));
  if (
    has("query-times-out-above") &&
    first > Number(readFileSync(`${dir}/query-times-out-above`, "utf8"))
  )
    return "timeout";
  const after = arg("after") === "" ? 0 : Number(arg("after"));
  const all = json("prs-open.json") as Listed[];
  const nodes = all.slice(after, after + first).map((p) => {
    return {
      ...p,
      author:
        p.author === undefined
          ? null
          : actor(
              p.author.login.replace(/^app\//, ""),
              p.author.is_bot === true,
            ),
      labels: { pageInfo: { hasNextPage: false }, nodes: p.labels },
      headRef: headRef(p),
      reviewThreads: threads(p.number),
      comments: comments(p.number),
    };
  });
  const more = after + first < all.length;
  const file = has("jig.yaml")
    ? {
        object: {
          text: readFileSync(`${dir}/jig.yaml`, "utf8"),
          isTruncated: false,
        },
      }
    : null;
  return {
    data: {
      rateLimit: { cost: 1, remaining: 4990 },
      repository: {
        nameWithOwner: cwd.endsWith("/other")
          ? "example-org/other-repo"
          : "example-org/example-repo",
        defaultBranchRef: { name: "main", target: { file } },
        pullRequests: {
          pageInfo: {
            hasNextPage: more,
            endCursor: more ? String(after + first) : null,
          },
          nodes,
        },
      },
    },
  };
}
