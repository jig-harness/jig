/**
 * The forge's facts the Ready predicate (`merge-ready.ts`) needs, for a set
 * of pull requests of one repository in one GraphQL query: each one's head,
 * draft state, mergeability and merge state, review decision, author
 * association, labels, review threads' resolution, the head's check contexts
 * (with whether each is required and which app posted it), the review
 * requests and the reviewers' latest reviews; and the repository's merge
 * methods. The dispatcher's board read, the merge-ready announcement and
 * `jig ask` read through it, so all three place a pull request on the same
 * facts.
 *
 * Every connection reads one page. A pull request whose connection reports
 * another page is marked partial with the reason, never read as whole: an
 * unread failing check, thread, approval or reviewer cannot be ruled out, so
 * the predicate places it nowhere it would need them.
 */
import { OVERLAY_RELPATH } from "../../../../shared/config-layers.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  Defect,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import type { ForgeFacts, HeadCheck, HeadReview } from "./merge-ready.ts";
import { ghCall, ghRepoEnv } from "./proc.ts";

/** The query's name, which a fake forge recognises. */
export const BOARD_QUERY_NAME = "DispatchBoard";

/** Entries per connection the query reads. */
const CHECKS = 100;
const THREADS = 100;
const REVIEWS = 20;

/** The most pull requests one query names. */
export const FACTS_PAGE = 20;

/** One pull request's part of the query, aliased by its number. */
function pullFields(n: number): string {
  return `pr${n}: pullRequest(number: ${n}) {
      number headRefOid isDraft mergeable mergeStateStatus reviewDecision authorAssociation isMergeQueueEnabled
      labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
      reviewThreads(first: ${THREADS}) { pageInfo { hasNextPage } nodes { isResolved } }
      reviewRequests(first: ${REVIEWS}) { pageInfo { hasNextPage } nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } ... on Mannequin { login } } } }
      latestReviews(first: ${REVIEWS}) { pageInfo { hasNextPage } nodes { state authorAssociation author { __typename login } commit { oid } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: ${CHECKS}) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { name status conclusion startedAt isRequired(pullRequestNumber: ${n}) checkSuite { app { slug } } }
        ... on StatusContext { context state isRequired(pullRequestNumber: ${n}) }
      } } } } } }
    }`;
}

/** The query over `numbers` of one repository. */
export function factsQuery(numbers: readonly number[]): string {
  return `query ${BOARD_QUERY_NAME}($owner: String!, $name: String!) {
  rateLimit { cost remaining limit }
  repository(owner: $owner, name: $name) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    defaultBranchRef { target { ... on Commit { file(path: "${OVERLAY_RELPATH}") { object { ... on Blob { text isTruncated } } } } } }
    ${numbers.map(pullFields).join("\n    ")}
  }
}`;
}

/** A field of nested records, `undefined` where one is missing. */
function at(value: unknown, ...path: string[]): unknown {
  let v = value;
  for (const key of path) {
    if (!isRecord(v)) return undefined;
    v = v[key];
  }
  return v;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nodes = (v: unknown): unknown[] => {
  const list = at(v, "nodes");
  return Array.isArray(list) ? list : [];
};
const more = (v: unknown): boolean => at(v, "pageInfo", "hasNextPage") === true;

/** A check run's or commit status's state, as the predicate reads it. */
function checkState(node: Record<string, unknown>): HeadCheck["state"] {
  if (node.__typename === "StatusContext") {
    const s = str(node.state);
    return s === "SUCCESS"
      ? "success"
      : s === "PENDING" || s === "EXPECTED"
        ? "pending"
        : "failure";
  }
  if (str(node.status) !== "COMPLETED") return "pending";
  const c = str(node.conclusion);
  if (c === "SUCCESS") return "success";
  if (c === "NEUTRAL") return "neutral";
  if (c === "SKIPPED") return "skipped";
  return "failure";
}

function checkOf(node: unknown): HeadCheck | null {
  if (!isRecord(node)) return null;
  const status = node.__typename === "StatusContext";
  const name = str(status ? node.context : node.name);
  if (name === "") return null;
  const app = status
    ? null
    : str(at(node, "checkSuite", "app", "slug")) || null;
  return {
    name,
    app,
    required: node.isRequired === true,
    state: checkState(node),
    startedAt: str(node.startedAt) || null,
  };
}

function reviewOf(node: unknown): HeadReview | null {
  const author = str(at(node, "author", "login"));
  if (author === "") return null;
  return {
    author,
    person: at(node, "author", "__typename") === "User",
    association: str(at(node, "authorAssociation")),
    state: str(at(node, "state")),
    commit: str(at(node, "commit", "oid")),
  };
}

function requestOf(node: unknown): string {
  const who = at(node, "requestedReviewer");
  return str(at(who, "login")) || str(at(who, "slug"));
}

/** One pull request's facts from its part of the answer; `null` when the forge gave none. */
export function parsePull(
  node: unknown,
  methods: ForgeFacts["methods"],
): ForgeFacts | null {
  if (!isRecord(node) || typeof node.number !== "number") return null;
  const head = str(node.headRefOid);
  if (head === "") return null;
  const commit = nodes(at(node, "commits"))[0];
  const contexts = at(commit, "commit", "statusCheckRollup", "contexts");
  const threads = at(node, "reviewThreads");
  const parts: Array<[string, unknown]> = [
    ["labels", at(node, "labels")],
    ["review threads", threads],
    ["review requests", at(node, "reviewRequests")],
    ["latest reviews", at(node, "latestReviews")],
    ["checks", contexts],
  ];
  const long = parts.filter(([, c]) => more(c)).map(([name]) => name);
  // The checks belong to the head only when the commit they were read on is it.
  const checked = str(at(commit, "commit", "oid"));
  const why = [
    ...(long.length === 0
      ? []
      : [`more ${long.join(", ")} than one read holds`]),
    ...(checked !== "" && checked !== head
      ? ["its checks were read on another commit"]
      : []),
  ];
  return {
    number: node.number,
    head,
    draft: node.isDraft === true,
    mergeable: str(node.mergeable) || "UNKNOWN",
    mergeState: str(node.mergeStateStatus) || "UNKNOWN",
    mergeQueue: node.isMergeQueueEnabled === true,
    reviewDecision: str(node.reviewDecision) || null,
    authorAssociation: str(node.authorAssociation),
    labels: nodes(at(node, "labels"))
      .map((l) => str(at(l, "name")))
      .filter((l) => l !== ""),
    unresolvedThreads: nodes(threads).filter(
      (t) => at(t, "isResolved") !== true,
    ).length,
    checks: nodes(contexts)
      .map(checkOf)
      .filter((c): c is HeadCheck => c !== null),
    reviews: nodes(at(node, "latestReviews"))
      .map(reviewOf)
      .filter((r): r is HeadReview => r !== null),
    requested: nodes(at(node, "reviewRequests"))
      .map(requestOf)
      .filter((r) => r !== ""),
    methods,
    partial: why.length === 0 ? null : why.join("; "),
  };
}

/** What one query read: each pull request's facts, and what the forge charged. */
export interface FactsRead {
  pulls: Map<number, ForgeFacts>;
  cost: number;
  /** The forge's budget left after it, `null` when not given. */
  remaining: number | null;
  limit: number | null;
  /** The repository's configuration on its default branch: its text, `null` when it holds none, `undefined` when it did not read whole. */
  config?: string | null;
}

/** The facts from a whole answer. */
export function parseAnswer(
  answer: unknown,
  numbers: readonly number[],
): FactsRead {
  const repository = at(answer, "data", "repository");
  const methods = {
    squash: at(repository, "squashMergeAllowed") === true,
    merge: at(repository, "mergeCommitAllowed") === true,
    rebase: at(repository, "rebaseMergeAllowed") === true,
  };
  const pulls = new Map<number, ForgeFacts>();
  for (const n of numbers) {
    const facts = parsePull(at(repository, `pr${n}`), methods);
    if (facts !== null) pulls.set(n, facts);
  }
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const blob = at(repository, "defaultBranchRef", "target", "file", "object");
  const config =
    at(repository, "defaultBranchRef", "target", "file") === null
      ? null
      : at(blob, "isTruncated") === false &&
          typeof at(blob, "text") === "string"
        ? (at(blob, "text") as string)
        : undefined;
  return {
    ...(config === undefined ? {} : { config }),
    pulls,
    cost: num(at(answer, "data", "rateLimit", "cost")) ?? 0,
    remaining: num(at(answer, "data", "rateLimit", "remaining")),
    limit: num(at(answer, "data", "rateLimit", "limit")),
  };
}

/**
 * The facts of `numbers` in `slug`, `FACTS_PAGE` to a query, each under
 * `timeoutSec`, or why a query did not read (ADR-0012). With `slug`
 * `null` the repository is the one the forge client's own view of the
 * working directory names (its `{owner}` and `{repo}` placeholders).
 */
export async function readMergeFacts(
  slug: string | null,
  numbers: readonly number[],
  timeoutSec: number,
): Promise<Outcome<FactsRead, "unreadable">> {
  const [owner = "", name = ""] =
    slug === null ? ["{owner}", "{repo}"] : slug.split("/");
  if (numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw new Defect("a pull request number is not a whole number");
  const read: FactsRead = {
    pulls: new Map(),
    cost: 0,
    remaining: null,
    limit: null,
  };
  for (let i = 0; i < numbers.length; i += FACTS_PAGE) {
    const chunk = numbers.slice(i, i + FACTS_PAGE);
    const r = await ghCall(
      [
        "api",
        "graphql",
        "-f",
        `query=${factsQuery(chunk)}`,
        // `-F` fills the forge client's `{owner}` and `{repo}` placeholders; `-f` passes a name as it is.
        slug === null ? "-F" : "-f",
        `owner=${owner}`,
        slug === null ? "-F" : "-f",
        `name=${name}`,
      ],
      { stderr: "pipe", env: ghRepoEnv(), timeoutSec },
    );
    if (r.code !== 0) {
      const tail = r.stderr.trim().split("\n").at(-1) ?? "";
      return failed(
        "unreadable",
        `gh api graphql exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
      );
    }
    let answer: unknown;
    try {
      answer = JSON.parse(r.stdout);
    } catch (error) {
      return failed(
        "unreadable",
        "the board query's answer is not JSON",
        error,
      );
    }
    const part = parseAnswer(answer, chunk);
    for (const [n, f] of part.pulls) read.pulls.set(n, f);
    read.cost += part.cost;
    read.remaining = part.remaining ?? read.remaining;
    read.limit = part.limit ?? read.limit;
    if (part.config !== undefined) read.config = part.config;
  }
  return ok(read);
}
