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
 * while `comments-query-fail` exists. A pull request whose comment listing
 * `forge-fails.json` refuses has more comments than the query gives, so the
 * tick lists them on their own. `review-comments-<pr>.json` holds a pull
 * request's review comments as their listing gives them, each naming its
 * `thread`: the conditional listing and a parked thread's query read it.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  /** A review comment's thread, which the forge's listing does not name: the fake's own link to the thread's query. */
  thread?: string;
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
  /** Whether `forge-fails.json` refuses the listing of a pull request's comments: the query then leaves them to that listing. */
  const refused = (pr: number) =>
    has("forge-fails.json") &&
    (json("forge-fails.json") as Array<{ match: string }>).some((r) =>
      r.match.includes(`issues/${pr}/comments`),
    );
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
      totalCount: listed.length,
      pageInfo: {
        hasNextPage: listed.length > COMMENTS_PAGE || refused(pr),
      },
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
  return {
    data: { rateLimit: { cost: 1, remaining: 4990 }, repository },
    ...(has("comments-query-partial")
      ? { errors: [{ message: "The comment query was incomplete" }] }
      : {}),
  };
}

/** One page of a REST comment listing, a pull request's own or its review comments, with a validator that follows its contents. */
export function replyConditionalCommentPage(dir: string, args: string[]): void {
  const match =
    /\/(issues|pulls)\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(
      args.at(-1) ?? "",
    );
  if (match === null) return;
  const [, listing, pr, page] = match;
  const { has, json } = files(dir);
  const review = listing === "pulls";
  const specific = `${review ? "review-comments" : "comments"}-${pr}.json`;
  const all = (
    has(specific) ? json(specific) : review ? [] : json("comments.json")
  ) as unknown[];
  const start = (Number(page) - 1) * COMMENTS_PAGE;
  const body = JSON.stringify(all.slice(start, start + COMMENTS_PAGE));
  const tag = '"' + Bun.hash(body).toString(16) + '"';
  const unchanged = args.includes("If-None-Match: " + tag);
  const status = unchanged ? "304 Not Modified" : "200 OK";
  appendFileSync(
    `${dir}/comment-page-responses.log`,
    `${review ? "review " : ""}${pr} ${unchanged ? "304" : "200"}\n`,
  );
  process.stdout.write(
    `HTTP/2.0 ${status}\r\nEtag: ${tag}\r\n\r\n${unchanged ? "" : body}`,
  );
  if (unchanged) process.stderr.write("gh: HTTP 304\n");
  process.exit(unchanged ? 1 : 0);
}

/**
 * A parked review thread's query, answered from the review comments that name the thread; a thread none names is left to the next fake.
 * A node-id query names no repository, so on a host with several accounts it runs as the default login: while `thread-needs-gh-repo` holds a repository, the answer is `NOT_FOUND` unless `GH_REPO` names it, and while `thread-not-found` exists every thread is.
 */
export function replyParkedThread(dir: string, args: string[]): void {
  if (!args.some((a) => a.includes("on PullRequestReviewThread"))) return;
  const id = (args.find((a) => a.startsWith("id=")) ?? "").slice("id=".length);
  const needs = existsSync(join(dir, "thread-needs-gh-repo"))
    ? readFileSync(join(dir, "thread-needs-gh-repo"), "utf8").trim()
    : null;
  if (
    existsSync(join(dir, "thread-not-found")) ||
    (needs !== null && process.env.GH_REPO !== needs)
  ) {
    process.stderr.write(
      `gh: Could not resolve to a node with the global id '${id}' (HTTP 404)\n`,
    );
    process.exit(1);
  }
  const { json } = files(dir);
  const nodes = readdirSync(dir)
    .filter((name) => /^review-comments-\d+\.json$/.test(name))
    .flatMap((name) => json(name) as RestComment[])
    .filter((c) => c.thread === id);
  if (nodes.length === 0) return;
  process.stdout.write(
    JSON.stringify({
      data: {
        node: {
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: nodes.map((c) => ({
              url: c.html_url,
              author: { login: c.user?.login },
              authorAssociation: c.author_association,
              createdAt: c.created_at,
              lastEditedAt: c.updated_at === c.created_at ? null : c.updated_at,
              body: c.body,
            })),
          },
        },
      },
    }),
  );
  process.exit(0);
}

/** The query's answer, or `null` for a query that fails. */
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
  const after = arg("after") === "" ? 0 : Number(arg("after"));
  const query = arg("query");
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
      ...(query.includes("statusCheckRollup") ? { headRef: headRef(p) } : {}),
      ...(query.includes("reviewThreads")
        ? { reviewThreads: threads(p.number) }
        : {}),
      ...(query.includes("comments(first:")
        ? { comments: comments(p.number) }
        : {}),
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
  const answer = {
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
  // Published once the answer is complete: a test changing the files after seeing the marker changes what a later read sees, never this one.
  appendFileSync(`${dir}/repository-answered.log`, "answered\n");
  return answer;
}
