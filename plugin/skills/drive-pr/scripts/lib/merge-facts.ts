/**
 * The forge's facts the Ready predicate (`merge-ready.ts`) needs, for a set
 * of pull requests of one repository in one GraphQL query: each one's head,
 * draft state, mergeability and merge state, review decision, author
 * association, login and fork flag, its base branch, labels, review threads'
 * resolution, the head's check contexts
 * (with whether each is required and which app posted it), the review
 * requests and the reviewers' latest reviews; and the repository's merge
 * methods. The dispatcher's board read, the merge-ready announcement and
 * `jig ask` read through it, so all three place a pull request on the same
 * facts.
 *
 * Each connection that continues is followed by cursor across bounded
 * pages under the same deadline: the head's check contexts on the head
 * commit, the pull request's labels, review threads, review requests and
 * latest reviews on the pull request while its head is unchanged. The
 * predicate keeps a pull request partial when one is still incomplete, since
 * it cannot rule out an unread failing check, thread, approval or reviewer.
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
import { ghRepoEnvFor } from "../../../../shared/gh-repo-env.ts";
import { ghCall } from "./proc.ts";
import { authorLogin } from "./trusted-automation.ts";
import { currentMs } from "../../../../shared/time.ts";

/** The query's name, which a fake forge recognises. */
export const BOARD_QUERY_NAME = "DispatchBoard";

/** Entries per connection the query reads. */
const CHECKS = 100;
/** Maximum check contexts per pull request: 4 pages of up to CHECKS each. */
const CHECK_PAGES = 4;
const THREADS = 100;
const REVIEWS = 20;

/** The most pull requests one query names. */
export const FACTS_PAGE = 20;

/** The same check fields on the board and every continuation page. */
function checkContexts(number: number, after = ""): string {
  return `statusCheckRollup { contexts(first: ${CHECKS}${after}) { pageInfo { hasNextPage endCursor } nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion startedAt completedAt isRequired(pullRequestNumber: ${number}) checkSuite { app { slug } } }
    ... on StatusContext { context state isRequired(pullRequestNumber: ${number}) }
  } } }`;
}

/** A pull request's own connection the reader follows past its first page. */
interface PullConnection {
  /** The field of the pull request. */
  field: string;
  /** Its name in a partial-read reason. */
  label: string;
  /** The entries on its first page; each later page reads `PAGE`. */
  first: number;
  /** The fields of each entry. */
  entry: string;
  /** Whether an entry holds every fact the predicate reads from it. */
  readable: (entry: Record<string, unknown>) => boolean;
}

/** Entries per continuation page of a pull request's own connection. */
const PAGE = 100;
/** Maximum pages per pull request connection, including the first. */
const PULL_PAGES = 3;

const PULL_CONNECTIONS: readonly PullConnection[] = [
  {
    field: "labels",
    label: "labels",
    first: 100,
    entry: "name",
    readable: (e) => str(e.name) !== "",
  },
  {
    field: "reviewThreads",
    label: "review threads",
    first: THREADS,
    entry: "isResolved",
    readable: (e) => typeof e.isResolved === "boolean",
  },
  {
    field: "reviewRequests",
    label: "review requests",
    first: REVIEWS,
    entry:
      "requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } ... on Mannequin { login } }",
    readable: (e) => requestOf(e) !== "",
  },
  {
    field: "latestReviews",
    label: "latest reviews",
    first: REVIEWS,
    entry: "state authorAssociation author { __typename login } commit { oid }",
    readable: (e) => str(e.state) !== "" && reviewOf(e) !== null,
  },
];

function connectionFields(
  c: PullConnection,
  first: number,
  after = "",
): string {
  return `${c.field}(first: ${first}${after}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${c.entry} } }`;
}

/** One pull request's part of the query, aliased by its number. */
function pullFields(n: number): string {
  return `pr${n}: pullRequest(number: ${n}) {
      number headRefOid baseRefOid isDraft mergeable mergeStateStatus reviewDecision authorAssociation isMergeQueueEnabled
      author { __typename login } isCrossRepository
      ${PULL_CONNECTIONS.map((c) => connectionFields(c, c.first)).join("\n      ")}
      commits(last: 1) { nodes { commit { oid ${checkContexts(n)} } } }
    }`;
}

/** The next page of one of a pull request's own connections, with its head to pin it. */
function pullPageQuery(number: number, c: PullConnection): string {
  return `query MergePullConnection($owner: String!, $name: String!, $after: String!) {
  rateLimit { cost remaining limit }
  repository(owner: $owner, name: $name) {
    pull: pullRequest(number: ${number}) { headRefOid ${connectionFields(c, PAGE, ", after: $after")} }
  }
}`;
}

function checkPageQuery(number: number): string {
  return `query MergeCheckContexts($owner: String!, $name: String!, $head: GitObjectID!, $after: String!) {
  rateLimit { cost remaining limit }
  repository(owner: $owner, name: $name) {
    head: object(oid: $head) { ... on Commit { oid ${checkContexts(number, ", after: $after")} } }
  }
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

/** Keep forge diagnostics useful without letting them control operator output. */
function ghDiagnostic(stderr: string): string {
  const lastLine = stderr.trim().split("\n").at(-1) ?? "";
  const plain = Array.from(lastLine)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join("")
    .trim();
  const maxLength = 500;
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1)}…` : plain;
}
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
    id:
      typeof node.databaseId === "number" &&
      Number.isSafeInteger(node.databaseId)
        ? node.databaseId
        : null,
    required: node.isRequired === true,
    state: checkState(node),
    startedAt: str(node.startedAt) || null,
    completedAt: str(node.completedAt) || null,
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
  return {
    number: node.number,
    head,
    ...(typeof node.baseRefOid === "string" ? { base: node.baseRefOid } : {}),
    ...states(node),
    labels: nodes(at(node, "labels"))
      .map((l) => str(at(l, "name")))
      .filter((l) => l !== ""),
    labelsPartial: more(at(node, "labels")),
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
    partial: partialOf(node, head, commit, contexts),
  };
}

/** A pull request's states, an absent one read as not known. */
function states(
  node: Record<string, unknown>,
): Pick<
  ForgeFacts,
  | "draft"
  | "mergeable"
  | "mergeState"
  | "mergeQueue"
  | "reviewDecision"
  | "authorAssociation"
  | "author"
  | "crossRepository"
  | "baseOid"
> {
  const cross = node.isCrossRepository;
  return {
    draft: node.isDraft === true,
    mergeable: str(node.mergeable) || "UNKNOWN",
    mergeState: str(node.mergeStateStatus) || "UNKNOWN",
    mergeQueue: node.isMergeQueueEnabled === true,
    reviewDecision: str(node.reviewDecision) || null,
    authorAssociation: str(node.authorAssociation),
    author: authorLogin(
      str(at(node, "author", "__typename")),
      str(at(node, "author", "login")),
    ),
    crossRepository: typeof cross === "boolean" ? cross : null,
    baseOid: str(node.baseRefOid),
  };
}

/** Why a pull request did not read whole, or `null` when it did. */
function partialOf(
  node: Record<string, unknown>,
  head: string,
  commit: unknown,
  contexts: unknown,
): string | null {
  const parts: Array<[string, unknown]> = [
    ...PULL_CONNECTIONS.map((c): [string, unknown] => [
      c.label,
      at(node, c.field),
    ]),
    ["checks", contexts],
  ];
  const long = parts.filter(([, c]) => more(c)).map(([name]) => name);
  const why =
    long.length === 0 ? [] : [`more ${long.join(", ")} than one read holds`];
  if (initialChecksIncomplete(commit, contexts))
    why.push("its first check page was incomplete");
  // The checks belong to the head only when the commit they were read on is it.
  const checked = str(at(commit, "commit", "oid"));
  if (checked !== head)
    why.push(
      checked === ""
        ? "its checks were not read on the head commit"
        : "its checks were read on another commit",
    );
  return why.length === 0 ? null : why.join("; ");
}

/** A null rollup is a complete head with no check contexts; any other absent or malformed connection is incomplete. */
function initialChecksIncomplete(commit: unknown, contexts: unknown): boolean {
  if (at(commit, "commit", "statusCheckRollup") === null) return false;
  return (
    checkPageNodes(contexts) === null ||
    typeof at(contexts, "pageInfo", "hasNextPage") !== "boolean"
  );
}

function initialCheckPageNodes(
  commit: unknown,
  contexts: unknown,
): unknown[] | null {
  return initialChecksIncomplete(commit, contexts)
    ? null
    : checkPageNodes(contexts);
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

/** Run a `gh api` call and decode its JSON answer, returning `unreadable` on exit or parse failure. */
export async function ghApiJson(
  args: readonly string[],
  slug: string | null,
  timeoutSec: number,
  callLabel: string,
  answerLabel: string = callLabel,
): Promise<Outcome<unknown, "unreadable">> {
  const r = await ghCall(["api", ...args], {
    stderr: "pipe",
    env: ghRepoEnvFor(slug),
    timeoutSec,
  });
  if (r.code !== 0) {
    const tail = ghDiagnostic(r.stderr);
    return failed(
      "unreadable",
      `gh api ${callLabel} exited ${r.code}${tail === "" ? "" : `: ${tail}`}`,
    );
  }
  try {
    return ok(JSON.parse(r.stdout));
  } catch (error) {
    return failed("unreadable", `the ${answerLabel} answer is not JSON`, error);
  }
}

/** One bounded GraphQL read through the forge transport. */
async function queryGraphql(
  slug: string | null,
  query: string,
  timeoutSec: number,
  fields: readonly string[] = [],
): Promise<Outcome<unknown, "unreadable">> {
  const [owner = "", name = ""] =
    slug === null ? ["{owner}", "{repo}"] : slug.split("/");
  // `-F` fills the forge client's `{owner}` and `{repo}` placeholders; `-f` passes a name as it is.
  const flag = slug === null ? "-F" : "-f";
  return ghApiJson(
    [
      "graphql",
      "-f",
      `query=${query}`,
      flag,
      `owner=${owner}`,
      flag,
      `name=${name}`,
      ...fields,
    ],
    slug,
    timeoutSec,
    "graphql",
    "merge facts query's",
  );
}

/** `part` added into `read`. */
function addPart(read: FactsRead, part: FactsRead): void {
  for (const [n, f] of part.pulls) read.pulls.set(n, f);
  read.cost += part.cost;
  read.remaining = part.remaining ?? read.remaining;
  read.limit = part.limit ?? read.limit;
  if (part.config !== undefined) read.config = part.config;
}

/** An unreadable entry withholds the whole check connection. */
function checkPageNodes(page: unknown): unknown[] | null {
  const entries = at(page, "nodes");
  if (!Array.isArray(entries)) return null;
  const known = entries.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.isRequired === "boolean" &&
      (entry.__typename === "CheckRun"
        ? str(entry.status) !== ""
        : entry.__typename === "StatusContext" && str(entry.state) !== "") &&
      checkOf(entry) !== null,
  );
  return known ? entries : null;
}

interface Page {
  entries: unknown[];
  after: string | null;
  /** The connection's size as this page saw it, `null` when it reported none. */
  total: number | null;
}

/** One connection's continuation: how to ask for its next page, and where the answer holds it. */
interface Continuation {
  /** The page's name in a reason, such as "check page". */
  what: string;
  query: string;
  /** The query's variables besides `after`, as forge-client flags. */
  fields: readonly string[];
  /** Whether the answer read on the head the first page was read on. */
  pinned: (answer: unknown) => boolean;
  page: (answer: unknown) => unknown;
  /** The page's entries, `null` when one is unreadable. */
  entries: (page: unknown) => unknown[] | null;
}

/** The remaining shared deadline, passed to the transport without rounding up. */
function secondsLeft(deadline: number): number {
  return (deadline - currentMs()) / 1000;
}

/** Read a continuation pinned to the original head, using the board's deadline. */
async function readPage(
  slug: string | null,
  c: Continuation,
  read: FactsRead,
  after: string,
  deadline: number,
): Promise<Outcome<Page, "unreadable">> {
  const leftSec = secondsLeft(deadline);
  if (leftSec <= 0)
    return failed(
      "unreadable",
      `the merge facts deadline left no time for another ${c.what}`,
    );
  const next = await queryGraphql(slug, c.query, leftSec, [
    ...c.fields,
    "-f",
    `after=${after}`,
  ]);
  // The forge charged a completed response even when it arrived too late for
  // this shared read. Keep that observation before rejecting its evidence.
  if (next.ok) addPart(read, parseAnswer(next.value, []));
  if (currentMs() >= deadline)
    return failed(
      "unreadable",
      `the merge facts deadline expired while reading the next ${c.what}`,
    );
  if (!next.ok)
    return failed(
      "unreadable",
      `the forge did not return the next ${c.what}: ${next.failure.reason}`,
    );
  if (at(next.value, "errors") !== undefined)
    return failed(
      "unreadable",
      `the forge answered the next ${c.what} with an error`,
    );
  if (!c.pinned(next.value))
    return failed(
      "unreadable",
      `the next ${c.what} did not read on the original head`,
    );
  const page = c.page(next.value);
  const entries = c.entries(page);
  const hasNext = at(page, "pageInfo", "hasNextPage");
  if (entries === null || typeof hasNext !== "boolean")
    return failed("unreadable", `the next ${c.what} was incomplete`);
  return ok({
    entries,
    after: hasNext ? str(at(page, "pageInfo", "endCursor")) : null,
    total: totalOf(page),
  });
}

const totalOf = (page: unknown): number | null => {
  const total = at(page, "totalCount");
  return typeof total === "number" && Number.isSafeInteger(total)
    ? total
    : null;
};

/**
 * Follow `initial` from its first page's `entries` for at most `pages` pages
 * in all, replacing its entries only when the connection was read to its
 * end; otherwise why it was not, the connection left as first read.
 */
async function follow(
  slug: string | null,
  c: Continuation,
  initial: Record<string, unknown>,
  entries: unknown[],
  pages: number,
  read: FactsRead,
  deadline: number,
  cap: string,
): Promise<string | null> {
  let after = str(at(initial, "pageInfo", "endCursor"));
  const all = [...entries];
  const cursors = new Set<string>();
  // Cursor paging can skip an entry when the list changes between pages, and
  // the head's oid does not pin these lists: a size that moves, or that the
  // entries read do not add up to, means the pages are not one reading.
  const total = totalOf(initial);
  for (let pageNumber = 1; pageNumber < pages; pageNumber++) {
    if (after === "" || cursors.has(after))
      return `the next ${c.what} had no usable cursor`;
    cursors.add(after);
    const result = await readPage(slug, c, read, after, deadline);
    if (!result.ok) return result.failure.reason;
    all.push(...result.value.entries);
    if (total !== null && result.value.total !== total)
      return `the ${c.what} count changed while it was read`;
    if (result.value.after === null) {
      if (total !== null && all.length !== total)
        return `the ${c.what} entries did not add up to the ${total} the forge counted`;
      initial.nodes = all;
      initial.pageInfo = { hasNextPage: false };
      return null;
    }
    after = result.value.after;
  }
  return `the ${cap} read reached its ${pages}-page cap`;
}

function checkContinuation(facts: ForgeFacts): Continuation {
  const head = (answer: unknown) => at(answer, "data", "repository", "head");
  return {
    what: "check page",
    query: checkPageQuery(facts.number),
    fields: ["-f", `head=${facts.head}`],
    pinned: (answer) => at(head(answer), "oid") === facts.head,
    page: (answer) => at(head(answer), "statusCheckRollup", "contexts"),
    entries: checkPageNodes,
  };
}

/** Follow the head's check contexts; why they did not read whole, `null` when they did or need no follow-up. */
async function completeChecks(
  slug: string | null,
  pull: unknown,
  facts: ForgeFacts,
  read: FactsRead,
  deadline: number,
): Promise<string | null> {
  const commit = at(nodes(at(pull, "commits"))[0], "commit");
  const initial = at(commit, "statusCheckRollup", "contexts");
  if (!more(initial) || at(commit, "oid") !== facts.head || !isRecord(initial))
    return null;
  const entries = initialCheckPageNodes(commit, initial);
  if (entries === null) return "the first check page was incomplete";
  return follow(
    slug,
    checkContinuation(facts),
    initial,
    entries,
    CHECK_PAGES,
    read,
    deadline,
    "check",
  );
}

/** A page's entries, `null` when the list or one entry is unreadable. */
function connectionNodes(c: PullConnection, page: unknown): unknown[] | null {
  const entries = at(page, "nodes");
  return Array.isArray(entries) &&
    entries.every((entry) => isRecord(entry) && c.readable(entry))
    ? entries
    : null;
}

function pullContinuation(facts: ForgeFacts, c: PullConnection): Continuation {
  const pull = (answer: unknown) => at(answer, "data", "repository", "pull");
  return {
    what: `${c.label} page`,
    query: pullPageQuery(facts.number, c),
    fields: [],
    pinned: (answer) => at(pull(answer), "headRefOid") === facts.head,
    page: (answer) => at(pull(answer), c.field),
    entries: (page) => connectionNodes(c, page),
  };
}

/** Follow one of the pull request's own connections, as `completeChecks` does the head's checks. */
async function completeConnection(
  slug: string | null,
  pull: unknown,
  facts: ForgeFacts,
  c: PullConnection,
  read: FactsRead,
  deadline: number,
): Promise<string | null> {
  const initial = at(pull, c.field);
  // A connection that does not continue is still one partial pull request's
  // evidence: its entries and its pageInfo must read whole before the
  // pull request is called complete.
  if (
    !isRecord(initial) ||
    typeof at(initial, "pageInfo", "hasNextPage") !== "boolean"
  )
    return `the first ${c.label} page was incomplete`;
  const entries = connectionNodes(c, initial);
  if (entries === null) return `the first ${c.label} page was incomplete`;
  if (!more(initial)) return null;
  return follow(
    slug,
    pullContinuation(facts, c),
    initial,
    entries,
    PULL_PAGES,
    read,
    deadline,
    c.label,
  );
}

/**
 * A partial pull request's facts after following each connection that
 * continues, with why one still did not read whole. The first connection
 * left unread keeps the pull request partial, so the rest are not read.
 */
async function completePull(
  slug: string | null,
  pull: unknown,
  facts: ForgeFacts,
  read: FactsRead,
  deadline: number,
): Promise<ForgeFacts> {
  const steps = [
    () => completeChecks(slug, pull, facts, read, deadline),
    ...PULL_CONNECTIONS.map(
      (c) => () => completeConnection(slug, pull, facts, c, read, deadline),
    ),
  ];
  let why: string | null = null;
  for (const step of steps) {
    why = await step();
    if (why !== null) break;
  }
  const reread = parsePull(pull, facts.methods) ?? facts;
  if (why === null) return reread;
  return { ...reread, partial: `${reread.partial ?? facts.partial}; ${why}` };
}

interface FactsPage {
  facts: FactsRead;
  answer: unknown;
}

/** Read one board page without accepting a response that outlived the shared deadline. */
async function readFactsPage(
  slug: string | null,
  numbers: readonly number[],
  deadline: number,
): Promise<Outcome<FactsPage, "unreadable">> {
  const leftSec = secondsLeft(deadline);
  if (leftSec <= 0)
    return failed("unreadable", "the merge facts deadline expired");
  const answer = await queryGraphql(slug, factsQuery(numbers), leftSec);
  if (!answer.ok) return answer;
  if (currentMs() >= deadline)
    return failed("unreadable", "the merge facts deadline expired");
  return ok({
    facts: parseAnswer(answer.value, numbers),
    answer: answer.value,
  });
}

/**
 * The facts of `numbers` in `slug`, `FACTS_PAGE` to a query, each under
 * one shared `timeoutSec` deadline, or why a query did not read (ADR-0012). With `slug`
 * `null` the repository is the one the forge client's own view of the
 * working directory names (its `{owner}` and `{repo}` placeholders).
 */
export async function readMergeFacts(
  slug: string | null,
  numbers: readonly number[],
  timeoutSec: number,
): Promise<Outcome<FactsRead, "unreadable">> {
  if (numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw new Defect("a pull request number is not a whole number");
  const read: FactsRead = {
    pulls: new Map(),
    cost: 0,
    remaining: null,
    limit: null,
  };
  const deadline = currentMs() + timeoutSec * 1000;
  const partialPulls = new Map<number, unknown>();
  for (let i = 0; i < numbers.length; i += FACTS_PAGE) {
    const chunk = numbers.slice(i, i + FACTS_PAGE);
    const next = await readFactsPage(slug, chunk, deadline);
    if (!next.ok) return next;
    const part = next.value.facts;
    addPart(read, part);
    for (const [n, facts] of part.pulls) {
      if (facts.partial !== null)
        partialPulls.set(
          n,
          at(next.value.answer, "data", "repository", `pr${n}`),
        );
    }
  }
  for (const [n, pull] of partialPulls) {
    const facts = read.pulls.get(n);
    if (facts !== undefined)
      read.pulls.set(n, await completePull(slug, pull, facts, read, deadline));
  }
  return ok(read);
}
