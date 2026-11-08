/**
 * The change probe's forge reads on GitHub (`change-probe.ts`'s
 * `ProbeForge`), through the signed-in `gh` command-line client under its
 * deadline.
 *
 * One GraphQL call holds two searches over every repository the probe
 * reads, `is:pr repo:a/b repo:c/d …`:
 *
 * - `updated:>=<since>` — the pull requests updated since then, open, merged
 *   or closed: a comment, a review, a label, a push, a merge and a close
 *   each move a pull request's `updatedAt`;
 * - `is:open` — every open pull request's head commit, the state of its
 *   checks (`statusCheckRollup`) and each check's name and result (the first
 *   100), since a check that ends does not move `updatedAt` and the
 *   aggregate state can stay while one of several checks ends.
 *
 * Beside them it looks each repository up, so one the signed-in account
 * cannot see is named (`unseen`) rather than read as a repository where
 * nothing changed: a search leaves such a repository out without an error.
 * A search with more than one page of results is paged in further calls,
 * each holding only the searches that still have pages. GitHub prices each
 * call in its GraphQL points (5,000 an hour), apart from the REST limit; the
 * cost each call reports is returned with what it read, so a probe of one
 * page per search is one call and further pages add calls and points.
 *
 * The call runs from the home directory, outside every checkout, so a `gh`
 * that chooses its account by the checkout's remote uses the account it
 * uses outside one; that account must be able to read every repository.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { ghCall, ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import type {
  ChangedPr,
  OpenPr,
  ProbeForge,
  ProbeRead,
} from "./change-probe.ts";
import { repoTarget } from "./forge.ts";

/** Results per page, GitHub's largest. */
const PAGE = 100;
/** The most pages one search reads: GitHub's search returns 1,000 results at most. */
const MAX_PAGES = 10;
const SLUG = /^[\w.-]+\/[\w.-]+$/;

type Search = "changed" | "open";

const FIELDS: Record<Search, string> = {
  changed: "number updatedAt repository { nameWithOwner }",
  open: "number repository { nameWithOwner } commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }",
};

/** One call's query: the searches still to read, after their cursors, and on the first call each repository's lookup. */
export function probeQuery(
  searches: readonly Search[],
  lookups: readonly string[],
): string {
  const variables = searches
    .map((s) => `$${s}: String!, $${s}After: String`)
    .join(", ");
  const parts = searches.map(
    (s) =>
      `${s}: search(type: ISSUE, query: $${s}, first: ${PAGE}, after: $${s}After) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${FIELDS[s]} } } }`,
  );
  const repos = lookups.map((slug, i) => {
    const [owner, name] = slug.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner }`;
  });
  return `query(${variables}) { rateLimit { cost remaining } ${[...parts, ...repos].join(" ")} }`;
}

/** The two search strings for `slugs`, the first from `since` (an ISO time to the second). */
export function probeSearches(
  slugs: readonly string[],
  since: string,
): Record<Search, string> {
  const repos = slugs.map((slug) => `repo:${slug}`).join(" ");
  return {
    changed: `is:pr ${repos} updated:>=${since}`,
    open: `is:pr is:open ${repos}`,
  };
}

interface Page {
  cost: number;
  remaining: number | null;
  nodes: Record<Search, unknown[]>;
  next: Partial<Record<Search, string>>;
  unseen: string[];
}

/** A GraphQL error that only says a looked-up repository is not there (or not visible). */
function lookupMiss(error: unknown, lookups: readonly string[]): string | null {
  if (!isRecord(error) || error.type !== "NOT_FOUND") return null;
  const path = Array.isArray(error.path) ? error.path : [];
  const match = path.length === 1 ? /^r(\d+)$/.exec(String(path[0])) : null;
  return match === null ? null : (lookups[Number(match[1])] ?? null);
}

/** The answer's errors: each repository a lookup did not find, or the first other error as a failure. */
function answerErrors(
  errors: unknown,
  lookups: readonly string[],
): Outcome<Set<string>, "unreadable"> {
  const unseen = new Set<string>();
  for (const error of Array.isArray(errors) ? errors : []) {
    const miss = lookupMiss(error, lookups);
    if (miss !== null) {
      unseen.add(miss);
      continue;
    }
    const message =
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : JSON.stringify(error);
    return failed("unreadable", `the forge refused the search: ${message}`);
  }
  return ok(unseen);
}

/** One search's nodes and, when it has a next page, its cursor. */
function searchResult(
  result: unknown,
  search: Search,
): Outcome<{ nodes: unknown[]; next?: string }, "unreadable"> {
  const nodes = isRecord(result) ? result.nodes : undefined;
  const info =
    isRecord(result) && isRecord(result.pageInfo) ? result.pageInfo : null;
  if (!Array.isArray(nodes) || info === null)
    return failed("unreadable", `the ${search} search did not read`);
  const count = isRecord(result) ? result.issueCount : undefined;
  if (typeof count !== "number")
    return failed(
      "unreadable",
      `the ${search} search did not say how many it matched`,
    );
  if (count > MAX_PAGES * PAGE)
    return failed(
      "unreadable",
      `the ${search} search matched ${count} pull requests and GitHub returns at most ${MAX_PAGES * PAGE}`,
    );
  if (info.hasNextPage !== true) return ok({ nodes });
  return typeof info.endCursor === "string"
    ? ok({ nodes, next: info.endCursor })
    : failed(
        "unreadable",
        `the ${search} search has a next page and no cursor`,
      );
}

/** The answer's JSON object, or why it is not one. */
function answerBody(
  stdout: string,
): Outcome<Record<string, unknown>, "unreadable"> {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return failed("unreadable", "the forge's answer is not JSON");
  }
  return isRecord(body)
    ? ok(body)
    : failed("unreadable", "the forge's answer is not an object");
}

/** One answer, read: its searches' nodes and cursors and its repositories not seen; or why it does not read. */
export function readPage(
  stdout: string,
  searches: readonly Search[],
  lookups: readonly string[],
): Outcome<Page, "unreadable"> {
  const body = answerBody(stdout);
  if (!body.ok) return body;
  const unseen = answerErrors(body.value.errors, lookups);
  if (!unseen.ok) return unseen;
  const data = isRecord(body.value.data) ? body.value.data : null;
  if (data === null)
    return failed("unreadable", "the forge's answer holds no data");
  const rate = isRecord(data.rateLimit) ? data.rateLimit : {};
  const page: Page = {
    cost: typeof rate.cost === "number" ? rate.cost : 0,
    remaining: typeof rate.remaining === "number" ? rate.remaining : null,
    nodes: { changed: [], open: [] },
    next: {},
    unseen: [],
  };
  for (const search of searches) {
    const result = searchResult(data[search], search);
    if (!result.ok) return result;
    page.nodes[search] = result.value.nodes;
    if (result.value.next !== undefined) page.next[search] = result.value.next;
  }
  lookups.forEach((slug, i) => {
    if (!isRecord(data[`r${i}`])) unseen.value.add(slug);
  });
  page.unseen = [...unseen.value];
  return ok(page);
}

function slugOf(node: Record<string, unknown>): string | null {
  const repo = isRecord(node.repository) ? node.repository.nameWithOwner : null;
  return typeof repo === "string" && SLUG.test(repo) ? repo : null;
}

/** A pull request the updated search found, or `null` for a node that is not one. */
export function changedPr(node: unknown): ChangedPr | null {
  if (!isRecord(node)) return null;
  const slug = slugOf(node);
  const { number, updatedAt } = node;
  if (
    slug === null ||
    typeof number !== "number" ||
    typeof updatedAt !== "string"
  )
    return null;
  return Number.isNaN(Date.parse(updatedAt))
    ? null
    : { slug, number, updatedAt };
}

/** An open pull request's head and checks, or `null` for a node that is not one. */
export function openPr(node: unknown): OpenPr | null {
  if (!isRecord(node)) return null;
  const slug = slugOf(node);
  if (slug === null || typeof node.number !== "number") return null;
  const commits = isRecord(node.commits) ? node.commits.nodes : null;
  const head =
    Array.isArray(commits) && isRecord(commits[0]) ? commits[0].commit : null;
  if (!isRecord(head) || typeof head.oid !== "string") return null;
  const roll = isRecord(head.statusCheckRollup) ? head.statusCheckRollup : null;
  const rollup = roll === null ? null : roll.state;
  return {
    slug,
    number: node.number,
    head: head.oid,
    checks: typeof rollup === "string" ? rollup : "NONE",
    detail: checkDigest(roll),
  };
}

/** A string order that does not depend on the locale. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A short digest of each check's name and result in a rollup, and of how many
 * there are; `-` without any. It covers the first hundred checks the query
 * reads: a rollup with more says so (`+n` omitted checks) and a change only
 * among the omitted ones is left to the sweep's own timer.
 */
function checkDigest(roll: Record<string, unknown> | null): string {
  const contexts =
    roll !== null && isRecord(roll.contexts) ? roll.contexts : null;
  const nodes =
    contexts !== null && Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const lines = nodes.flatMap((node) => {
    if (!isRecord(node)) return [];
    const name = String(node.name ?? node.context ?? "");
    return [
      `${name}=${String(node.status ?? "")}/${String(node.conclusion ?? node.state ?? "")}`,
    ];
  });
  if (lines.length === 0) return "-";
  const total =
    typeof contexts?.totalCount === "number"
      ? contexts.totalCount
      : lines.length;
  const digest = createHash("sha256")
    .update(`${total}\n${lines.sort(byCode).join("\n")}`)
    .digest("hex")
    .slice(0, 12);
  return total > lines.length ? `${digest}+${total - lines.length}` : digest;
}

/** Runs one call; `gh` exits 1 for an answer with errors, which `readPage` still reads. */
async function call(
  searches: readonly Search[],
  lookups: readonly string[],
  strings: Record<Search, string>,
  after: Partial<Record<Search, string>>,
): Promise<Outcome<Page, "unreadable">> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${probeQuery(searches, lookups)}`,
  ];
  for (const search of searches) {
    args.push("-f", `${search}=${strings[search]}`);
    const cursor = after[search];
    if (cursor !== undefined) args.push("-f", `${search}After=${cursor}`);
  }
  const r = await ghCall(args, {
    stderr: "pipe",
    env: ghRepoEnv(),
    cwd: homedir(),
  });
  if (r.spawnFailed)
    return failed("unreadable", `gh did not start: ${r.stderr.trim()}`);
  const page = readPage(r.stdout, searches, lookups);
  if (page.ok || r.code === 0) return page;
  const tail = r.stderr.trim().split("\n").at(-1) ?? "";
  return failed(
    "unreadable",
    `gh api graphql exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
  );
}

/** Add one page to what the search has read. */
function gather(read: ProbeRead, page: Page): void {
  read.calls++;
  read.cost += page.cost;
  read.remaining = page.remaining;
  read.unseen.push(...page.unseen);
  for (const pr of page.nodes.changed.map(changedPr))
    if (pr !== null) read.changed.push(pr);
  for (const pr of page.nodes.open.map(openPr))
    if (pr !== null) read.open.push(pr);
}

/** Every page of both searches, or why one did not read: a read in part is never decided from. */
async function searchForge(
  slugs: readonly string[],
  since: string,
): Promise<Outcome<ProbeRead, "unreadable">> {
  const strings = probeSearches(slugs, since);
  const read: ProbeRead = {
    changed: [],
    open: [],
    unseen: [],
    cost: 0,
    remaining: null,
    calls: 0,
  };
  let searches: Search[] = ["changed", "open"];
  let after: Partial<Record<Search, string>> = {};
  for (let page = 0; searches.length > 0; page++) {
    if (page === MAX_PAGES)
      return failed(
        "unreadable",
        `the search has more than ${MAX_PAGES * PAGE} results`,
      );
    const answer = await call(
      searches,
      page === 0 ? slugs : [],
      strings,
      after,
    );
    if (!answer.ok) return answer;
    gather(read, answer.value);
    searches = searches.filter((s) => answer.value.next[s] !== undefined);
    after = answer.value.next;
  }
  return ok(read);
}

/** GitHub, through `gh`: the forge the probe reads by default. */
export const githubProbeForge: ProbeForge = {
  async slug(path) {
    try {
      const target = await repoTarget(path);
      return target.ok ? ok(target.value.slug) : target;
    } catch (error) {
      return failed(
        "unreadable",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  search: searchForge,
};
