/**
 * Read one PR's review loop off GitHub: its commits, its reviews, and every
 * review thread with the outcome its replies settled on.
 *
 * This is the measurement substrate for the review loop's metrics. Both
 * consumers need the same four things and neither can get them from durable
 * drive state:
 *
 *   - `loop-metrics.ts` reports one PR's economy in the drive's own terminal
 *     summary, and the drive state it could read instead is per-CLONE — it dies
 *     with the Conductor worktree, and it never existed at all for a PR someone
 *     drove from another machine. Everything here is derived from the PR
 *     itself, so a metric is as available a week after the merge as it is at
 *     round 3.
 *   - `defect-escape.ts` samples ACROSS merged PRs, where no drive state exists
 *     by construction.
 *
 * Resolved threads are included, unlike `list-unresolved-threads.ts`. That
 * script exists to hand a pass work; this one exists to count what a finished
 * loop cost, and every thread the loop answered is exactly the part it has to
 * see.
 */

import {
  categoryOf,
  severityOf,
  TRUSTED_ASSOCIATIONS,
} from "../summary-findings.ts";
import { fail } from "./cli.ts";
import { cachedRepoView } from "./gh-conditional.ts";
import { type Outcome, qualifyingOutcome } from "./outcome.ts";
import { ghCall } from "./proc.ts";
import { type ThreadAutonomy, threadAutonomy } from "./metrics-autonomy.ts";

export interface CommitSample {
  oid: string;
  committedDate: string;
  /**
   * The commit's own diff against its FIRST parent — which is why `parents`
   * below has to travel with it. For an ordinary commit that is the work it
   * authored; for a MERGE commit it is the entire delta of whatever was merged
   * in, and counting that as work this branch authored inflates the churn
   * beyond recognition. Measured: one `Merge remote-tracking branch
   * 'origin/develop'` commit on one PR reports +52,015/-11,463 on a PR whose
   * whole net diff is 222 additions.
   */
  additions: number;
  deletions: number;
  /** 2+ means a merge commit. See `additions`. */
  parents: number;
  /**
   * The oid of the first two parents, in order — empty for a root commit,
   * one entry for an ordinary commit, two for a merge. The SECOND entry is
   * what a merge's ancestry classification is tested against: it is the tip
   * of whatever got merged in, so whether IT is an ancestor of the base ref
   * is what tells a base sync from a sibling-branch merge. See
   * `lib/metrics.ts`'s `classifySiblingCommits`.
   *
   * Capped at two by the query (`parents(first:2)`) even though `parents`
   * above is the true total — an octopus merge's third-and-later parents are
   * not this module's concern. Generalizing `classifySiblingCommits` itself
   * to N parents would need this cap widened too, which is a larger change
   * than a merge shape this repo's own workflow does not produce warrants;
   * `parents` already tells a reader when one is present, and
   * `SizeBlock.octopusMerges` (`lib/metrics.ts`) surfaces it as an explicit
   * caveat on the totals rather than silently trusting them.
   */
  parentOids: string[];
  headline: string;
}

export interface ReviewSample {
  /** The head the review was submitted against — the round's identity. */
  oid: string;
  submittedAt: string;
  author: string;
  isBot: boolean;
  /**
   * The review actually SAID something new, rather than only replying to an
   * existing thread.
   *
   * GitHub records a thread reply as a review, so a bot acknowledging a fix
   * looks identical to a bot reviewing a head. A non-trivial share of the
   * baseline week's bot reviews are reply-only, and they made heads read as
   * "reviewed" when nothing had reviewed them. The proportions are a published
   * baseline RESULT and live in `review-loop-baseline.md` — restating them here
   * is a second home that goes stale silently.
   *
   * True when the review carries a body of its own, or at least one comment
   * that is not a reply — which is what "this review raised something" means.
   *
   * The body is TRIMMED before it counts: a review whose body is `' '` or bare
   * line breaks said nothing, and treating it as initiating inflates
   * `reviewedHeads` and can move `firstReviewedHead` — the commit boundary the
   * whole attribution split hangs off.
   *
   * Reply-only is proven over ALL the review's comments, never a prefix — see
   * `allReviewCommentsOf`. An unreadable top-up fails to `true`: keeping a head
   * that may not have been reviewed costs one over-counted round, where
   * dropping one that WAS reviewed moves the boundary and silently re-attributes
   * every commit between the two heads.
   */
  initiating: boolean;
}

export interface ThreadSample {
  threadId: string;
  path: string | null;
  /**
   * The thread's anchor on the CURRENT diff — `null` once GitHub marks it
   * outdated, which it does as soon as a later commit rewrites the hunk. Prefer
   * `anchorLine()` over reading this directly; see `originalLine`.
   */
  line: number | null;
  /**
   * The anchor on the commit the thread was opened against, which GitHub keeps
   * after `line` goes null.
   *
   * Load-bearing, not a nicety: an `accepted` thread goes outdated precisely
   * BECAUSE somebody changed the code it pointed at, so the threads most likely
   * to represent a real fix are exactly the ones that lose `line`. Matching on
   * `line` alone is therefore blind in a SKEWED direction rather than a random
   * one, and could only understate re-finds. How much of the population that
   * is, and how reliably `originalLine` survives, are sampling results owned by
   * `review-loop-baseline.md` — restated here they go stale silently, which one
   * such copy already did.
   */
  originalLine: number | null;
  /**
   * Which side of the diff the thread is anchored to — `'RIGHT'` (the head's
   * numbering) or `'LEFT'` (the base's), `null` when GitHub reported neither.
   *
   * Load-bearing for any consumer that blames `originalLine`: a LEFT-side
   * anchor numbers the PRE-image, so blaming it against a head reads unrelated
   * lines and would label them with false confidence — the same reason
   * `self-inflicted.ts` refuses a LEFT thread (`fractal.ts` measures
   * self-inflicted retroactively and needs the same guard).
   */
  diffSide: string | null;
  /** GitHub marked the thread outdated — its `line` is gone, not its anchor. */
  isOutdated: boolean;
  isResolved: boolean;
  /** Who opened it, and whether that author is a GitHub App. */
  startedBy: string | null;
  startedByBot: boolean;
  url: string | null;
  /**
   * The LAST qualifying trusted reply's outcome — `null` when unanswered, and
   * also `null` when `commentsTruncated`, because an outcome read off a partial
   * comment list is a guess and every consumer here treats this field as fact.
   */
  outcome: Outcome | null;
  reason: string | null;
  /**
   * The reviewer's own `🏷️ category:` tag on the RAISING comment (`categoryOf`
   * applied to the first comment's body — the finding as it was originally
   * posted, never a later reply), or `unknown` when the tag is absent — either
   * because the reviewer never emitted one, because the thread has no
   * readable first comment, or
   * because the raising comment was edited after a caller-supplied `asOf` and
   * its body as of that cutoff is unrecoverable from GitHub's always-current
   * payload — the same withholding
   * `settleFrom` applies to a settling reply, applied here to the finding's
   * own comment.
   */
  category: string;
  /**
   * The RAISING comment's own severity token (`severityOf` against the first
   * comment's body, never a later reply), or `unknown` when no recognized
   * shape matched — withheld under an `asOf` cutoff on exactly the same terms
   * as `category`, for the same reason.
   *
   * `unknown` is not a rank; it is the ABSENCE of one, and it is load-bearing
   * downstream: `.config/review-triage.yaml` lists `severity` in
   * `fail_open.inert_when_unknown`, so a reviewer whose format `severityOf`
   * stops recognizing takes the decline ladder inert for ALL of its findings,
   * in EVERY round, with nothing reporting it (a failure mode that once took
   * three rounds to find). Sampling it here is what lets `computeLoopMetrics`
   * publish the `unknown` share per reviewer, which is the observable that
   * separates "this reviewer sometimes omits a severity" from "we stopped
   * understanding this reviewer entirely".
   */
  severity: string;
  /**
   * The FULL body of the qualifying reply that settled `outcome`, where `reason`
   * is only its first line.
   *
   * `defect-escape.ts` mines this for follow-up issue keys, and the deferral
   * protocol permits that link to sit on a later line — `reply-to-thread.ts`
   * accepts a multiline body and only constrains the first one. Searching
   * `reason` alone reported 10 of this window's 84 deferrals as naming no issue
   * when 2 of them linked one further down, inflating the one result on this
   * page that criticises the loop's own discipline.
   */
  settledBody: string | null;
  /**
   * When the finding was RAISED — the first comment's timestamp, `null` when the
   * thread carries no readable comment.
   *
   * Load-bearing for `defect-escape.ts`, which asks whether a later `accepted`
   * thread is the same finding *raised again*. Merge order cannot answer that: a
   * long-running PR can receive its accepted finding days BEFORE a decline was
   * ever posted and still merge after it, and ordering the sample by `mergedAt`
   * alone then reports that earlier finding as a recurrence of the later
   * decline. Only a creation timestamp separates "raised again" from "raised
   * concurrently".
   */
  createdAt: string | null;
  /**
   * When `outcome` was DECIDED — the timestamp of the qualifying reply that
   * settled it, `null` when unanswered.
   *
   * The tighter of the two anchors a recurrence can be measured against: the
   * decline's own decision, rather than the moment its PR happened to merge.
   */
  settledAt: string | null;
  /**
   * The thread's comments could not be read in full, so a later superseding
   * reply may be unread and `outcome` is the best available answer rather than a
   * certain one.
   *
   * A thread over the 100-per-thread page size is topped up by a second,
   * per-thread paginating query (`allCommentsOf`), so this now flags only the
   * residue: an API error on that top-up, or a malformed page. Measured across
   * the five heaviest PRs of the first baseline week (the heaviest at 218
   * threads, the next at 152), no thread hit the cap at all.
   *
   * When it IS set, `outcome` is withheld rather than guessed. A warning was
   * enough when the outcome only moved an accepted-share percentage; it stopped
   * being enough once `supersededInOwnPr` began DROPPING declines from the
   * escape denominator on the strength of one, since every consumer reads
   * `outcome` as settled and none of them can see this flag.
   */
  commentsTruncated: boolean;
  /**
   * The commit this thread's diff view was anchored to when it was FIRST
   * raised — the first comment's `originalCommit.oid` (REST calls the same
   * value `original_commit_id`; GraphQL's `PullRequestReviewComment.commit`
   * is a DIFFERENT field GitHub can move forward as the PR gains commits, so
   * `originalCommit` — not `commit` — is the one pinned to the moment the
   * finding was raised).
   *
   * `null` only when the thread has no readable first comment, or when
   * GitHub itself has no `originalCommit` to report (a very old comment
   * predating this field). A NON-null value here is NOT a promise this
   * CLONE can read the commit — GitHub's GraphQL keeps serving the oid long
   * after it becomes locally unreachable (a merged PR's branch is deleted,
   * and its raw pre-squash-merge commits are typically pruned from a clone
   * within days). That is a SEPARATE, common case `defect-escape.ts` checks
   * for itself (`commitReachable`, measured 7/7 on recently-merged PRs in
   * this repo) before trusting this field for its revision-based rename
   * walk, falling back to its own committer-date heuristic when it cannot.
   * Local unreachability is not part of this field's own null case.
   */
  reviewedHeadOid: string | null;
  /** Provisional replies, their reversals, chat acknowledgements (`metrics-autonomy.ts`). */
  autonomy?: ThreadAutonomy;
}

export interface PrSample {
  pr: number;
  state: string;
  /** Net diff of the merged/current head against the merge base. */
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  headRefOid: string;
  createdAt: string;
  mergedAt: string | null;
  /**
   * The commit this PR landed as, `''` while it is open. It is the exact lower
   * bound for "what happened AFTER this PR" — a `--since=mergedAt` window
   * includes the PR's own merge commit, which then reports the very fix the
   * decline was declined on as evidence that it came back.
   */
  mergeCommitOid: string;
  title: string;
  commits: CommitSample[];
  reviews: ReviewSample[];
  threads: ThreadSample[];
}

export interface Repo {
  owner: string;
  name: string;
}

/** `{owner, name}` for the current clone's default repository. */
export async function resolveRepo(): Promise<Repo> {
  const r = await cachedRepoView(["--json", "owner,name"], {
    stderr: "ignore",
  });
  if (r.code !== 0) fail(1, "sample: could not resolve the repository");
  try {
    const parsed = JSON.parse(r.stdout) as {
      owner?: { login?: string };
      name?: string;
    };
    const owner = String(parsed.owner?.login ?? "");
    const name = String(parsed.name ?? "");
    if (owner === "" || name === "") throw new Error("empty");
    return { owner, name };
  } catch {
    return fail(1, "sample: could not resolve the repository");
  }
}

/**
 * Run one paginating GraphQL query and return every page's `data` object.
 *
 * `--paginate` follows exactly ONE connection's cursor, so the four things this
 * module needs are four queries rather than one — a single document declaring
 * `$endCursor` against commits, reviews and reviewThreads at once would page
 * only whichever connection consumed the variable and silently truncate the
 * other two.
 *
 * `deadlineFactor` is not available here (that is the sibling skill's `gh.ts`),
 * so a paginating call gets the plain `GH_CALL_TIMEOUT`. That is the right
 * direction for a REPORTING tool: a metrics block that times out costs a
 * missing summary, never a wrong one, and the caller treats a failure as
 * "unavailable" rather than as zero.
 */
async function graphqlPages(
  query: string,
  repo: Repo,
  pr: number,
  paginate = true,
): Promise<unknown[]> {
  const r = await ghCall(
    [
      "api",
      "graphql",
      // `--paginate` is only meaningful for a query that declares `$endCursor`
      // and returns `pageInfo`; asking for it on the scalar meta query is
      // asking gh to follow a cursor that does not exist. It happens to be
      // harmless today, which is precisely the kind of thing a gh release
      // changes without anyone noticing here.
      ...(paginate ? ["--paginate", "--slurp"] : []),
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `repo=${repo.name}`,
      "-F",
      `pr=${pr}`,
      "-f",
      `query=${query}`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) fail(1, `sample: GraphQL query failed for PR #${pr}`);
  let pages: unknown;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return fail(1, `sample: GraphQL returned unparsable JSON for PR #${pr}`);
  }
  return Array.isArray(pages) ? pages : [pages];
}

/**
 * The `pullRequest` object out of one page, refusing rather than shrugging when
 * it is absent.
 *
 * GraphQL answers a bad PR number — or a good one against a repository
 * `$GH_REPO` / `gh repo set-default` points somewhere else — with a VALID
 * response carrying `pullRequest: null`. An optional chain would turn that into
 * an empty thread list, and zero threads is a number this module's consumers
 * report as a measurement. Reporting a clean loop for a pull request nobody
 * could read is the single worst answer available here.
 */
function pullRequestOf(page: unknown, pr: number): Record<string, unknown> {
  const shaped = page as {
    data?: {
      repository?: { pullRequest?: Record<string, unknown> | null } | null;
    };
  };
  if (shaped?.data?.repository == null) {
    fail(1, `sample: the repository could not be read for PR #${pr}`);
  }
  const node = shaped.data.repository.pullRequest;
  if (node == null) {
    fail(
      1,
      `sample: PR #${pr} does not exist in the resolved repository.`,
      "Check the number, and check that $GH_REPO / `gh repo set-default` agree with",
      "the repository the PR actually lives in.",
    );
  }
  return node;
}

/**
 * A count GitHub is REQUIRED to have answered, refusing rather than defaulting.
 *
 * This used to coerce anything unparseable to `0`, which is the failure mode the
 * surrounding validation exists to prevent: a parseable-but-malformed response
 * produced a clean-looking, wrong baseline instead of an error. The damage is
 * not uniform either — a missing `parents.totalCount` read as `0`, and `0 < 2`,
 * so a commit of unknown shape was counted as AUTHORED churn, which is exactly
 * the +52,015-line mistake `sizeOf` was written to avoid.
 *
 * Zero itself is legitimate and stays legitimate — a root commit really does
 * have no parents, and a PR really can have no changed files. The test is
 * "is this a finite non-negative integer", not "is this truthy".
 */
export function count(v: unknown, field: string, pr: number): number {
  // `typeof` FIRST, and not merely for tidiness: `Number(null)` and `Number('')`
  // are both `0`, so a coerce-then-validate order lets exactly the two shapes a
  // missing GraphQL field actually arrives as slip through as a valid count —
  // which is the whole defect, still present, wearing a validator. GraphQL
  // returns JSON numbers for these fields; anything else is malformed.
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    fail(
      1,
      `sample: PR #${pr} returned no usable \`${field}\` (${JSON.stringify(v)}).`,
      "A malformed count would be silently read as 0 and reported as a measurement.",
    );
  }
  return n;
}

const META_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      number title state additions deletions changedFiles
      baseRefName headRefOid createdAt mergedAt
      mergeCommit{ oid }
    }
  }
}`;

const COMMITS_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      commits(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ commit{ oid committedDate additions deletions messageHeadline parents(first:2){ totalCount nodes{ oid } } } }
      }
    }
  }
}`;

const REVIEWS_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviews(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id submittedAt body commit{ oid } author{ login __typename }
          comments(first:100){
            pageInfo{ hasNextPage }
            nodes{ replyTo{ id } }
          }
        }
      }
    }
  }
}`;

const THREADS_QUERY = `
query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:50, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line originalLine diffSide
          comments(first:100){
            pageInfo{ hasNextPage }
            nodes{ url authorAssociation createdAt lastEditedAt author{ login __typename } body originalCommit{ oid } }
          }
        }
      }
    }
  }
}`;

/**
 * One thread's comments, paginated on their OWN cursor.
 *
 * `THREADS_QUERY` pages the `reviewThreads` connection, and `--paginate` follows
 * exactly one cursor — so a thread whose comments exceed the page size returns a
 * prefix, and the outcome read off that prefix can be superseded by a reply
 * nobody read. Warning about it does not stop the measurement using it, so this
 * reads the rest instead.
 */
const THREAD_COMMENTS_QUERY = `
query($threadId:ID!,$endCursor:String){
  node(id:$threadId){
    ... on PullRequestReviewThread {
      comments(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ url authorAssociation createdAt lastEditedAt author{ login __typename } body originalCommit{ oid } }
      }
    }
  }
}`;

/**
 * One REVIEW's comments, paginated on their OWN cursor.
 *
 * Same defect as `THREAD_COMMENTS_QUERY` fixes for threads, on the other nested
 * connection: `REVIEWS_QUERY` pages the outer `reviews` connection only, so a
 * review with more than 100 comments returns a prefix. `initiating` is read off
 * that prefix, and a review whose only non-reply comment sits past it reads as
 * reply-only — dropping a genuinely reviewed head, and moving
 * `firstReviewedHead` when the dropped one was the earliest.
 *
 * Only `replyTo` is selected: the sole question asked of these nodes is whether
 * any comment is not a reply.
 */
const REVIEW_COMMENTS_QUERY = `
query($reviewId:ID!,$endCursor:String){
  node(id:$reviewId){
    ... on PullRequestReview {
      comments(first:100, after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ replyTo{ id } }
      }
    }
  }
}`;

type CommentNode = Record<string, unknown>;

/**
 * Every comment on one thread, or `null` when they could not all be read.
 *
 * Deliberately NOT routed through `graphqlPages`: that one hardcodes the
 * owner/repo/pr variables this query does not take, and — more importantly — it
 * `fail`s the whole process on an unreadable answer. A top-up is an improvement
 * on a prefix that is already in hand, so its failure must degrade to "still
 * truncated" rather than abort a sweep across a week of PRs. `null` is that
 * degradation, and every caller treats it as "keep the prefix, keep the flag".
 */
async function allCommentsOf(threadId: string): Promise<CommentNode[] | null> {
  if (threadId === "") return null;
  const r = await ghCall(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `threadId=${threadId}`,
      "-f",
      `query=${THREAD_COMMENTS_QUERY}`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  let pages: unknown;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const out: CommentNode[] = [];
  for (const page of Array.isArray(pages) ? pages : [pages]) {
    const nodes = (
      page as {
        data?: { node?: { comments?: { nodes?: unknown[] } | null } | null };
      }
    )?.data?.node?.comments?.nodes;
    // Fail CLOSED on a shape this does not recognise: a page silently read as
    // zero comments would DROP replies the prefix already had, turning a
    // partial answer into a wrong one.
    if (!Array.isArray(nodes)) return null;
    out.push(...(nodes as CommentNode[]));
  }
  return out.length === 0 ? null : out;
}

/**
 * What the FIRST page of a review's comments settles about `initiating`, if
 * anything.
 *
 * Separated from the network so both of its rules are pinnable in a test: the
 * body is trimmed before it counts, and a prefix with no non-reply is
 * `'unresolved'` rather than `false` whenever more comments exist.
 *
 * `true`/`false` are final. `'unresolved'` means the prefix cannot answer it and
 * the caller must read the rest — never "probably false", which is the read that
 * dropped a reviewed head.
 */
export function initiatingFromPrefix(
  body: unknown,
  comments: ReadonlyArray<{ replyTo?: unknown }>,
  hasMoreComments: boolean,
): boolean | "unresolved" {
  if (String(body ?? "").trim() !== "") return true;
  if (comments.some((c) => c.replyTo == null)) return true;
  return hasMoreComments ? "unresolved" : false;
}

/**
 * Does this review have at least one comment that is NOT a reply, read over
 * ALL its comments rather than the first page?
 *
 * `null` when that could not be established — an unreadable top-up, an
 * unrecognised page shape, a review with no id. Callers fail to "initiating",
 * per `ReviewSample.initiating`: the asymmetric cost is what picks that
 * direction, not optimism.
 */
async function reviewHasNonReply(reviewId: string): Promise<boolean | null> {
  if (reviewId === "") return null;
  const r = await ghCall(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `reviewId=${reviewId}`,
      "-f",
      `query=${REVIEW_COMMENTS_QUERY}`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  let pages: unknown;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  let found = false;
  for (const page of Array.isArray(pages) ? pages : [pages]) {
    const nodes = (
      page as {
        data?: { node?: { comments?: { nodes?: unknown[] } | null } | null };
      }
    )?.data?.node?.comments?.nodes;
    // Fail CLOSED on an unrecognised shape, exactly as `allCommentsOf` does: a
    // page read as zero comments would answer "no non-reply" from a page that
    // was never read, which is the wrong answer stated confidently.
    if (!Array.isArray(nodes)) return null;
    for (const c of nodes as Array<{ replyTo?: unknown }>) {
      if (c.replyTo == null) found = true;
    }
  }
  return found;
}

/**
 * The outcome a comment list settled on, with the moment it was decided.
 *
 * The LAST qualifying trusted reply wins, not the first: a thread can be
 * answered, reopened by the reviewer and re-answered differently, and the outcome
 * that stands is the one nothing superseded. Same "last qualifying reply" rule
 * `reconcile-replied-threads.ts` re-holds on.
 */
function settledFrom(
  commentNodes: readonly CommentNode[],
): { outcome: Outcome; reason: string; at: string; body: string } | null {
  let settled: {
    outcome: Outcome;
    reason: string;
    at: string;
    body: string;
  } | null = null;
  for (const c of commentNodes) {
    if (!TRUSTED_ASSOCIATIONS.has(String(c.authorAssociation ?? ""))) continue;
    const body = String(c.body ?? "");
    const q = qualifyingOutcome(body);
    if (q !== null) settled = { ...q, at: String(c.createdAt ?? ""), body };
  }
  return settled;
}

/** A timestamp string, or `null` for one GitHub did not give us. */
/**
 * An ISO-8601 UTC instant, or `null`.
 *
 * VALIDATED, not merely non-empty. Every consumer compares these
 * lexicographically — which is exact for ISO-8601 UTC and meaningless for
 * anything else — so a parseable-but-malformed payload like `"zzz"` sorts
 * after every real timestamp and can manufacture a recurrence out of nothing.
 * An unrecognised shape is `null`, which
 * every caller already treats as "ordering unreadable" and refuses to count.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function stamp(v: unknown): string | null {
  return typeof v === "string" && ISO_INSTANT.test(v) ? v : null;
}

/**
 * A `stamp()`-validated instant, as epoch milliseconds — `null` if `Date.parse`
 * cannot resolve it (a structurally ISO-8601-shaped but calendrically invalid
 * value; `ISO_INSTANT` checks digit shape, not that e.g. month 13 is real).
 *
 * `recoverableAsOf`/`usableAsOf` need this rather than the raw string:
 * `ISO_INSTANT` permits an arbitrary-length fractional-second suffix, so two
 * valid instants at different precisions (`...00Z` vs `...00.5Z`) do not
 * compare correctly as strings — lexicographic order agrees with chronological
 * order only when every compared value shares the same fractional width.
 * Parsing to epoch numbers removes the precision
 * dependency entirely.
 */
function epochOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether a comment's CURRENT body still reflects what it said `asOf` a given
 * cutoff, ASSUMING it already existed by then — the "was it edited since"
 * half only. GitHub always returns the current body, never a historical one,
 * so a comment edited after the cutoff has no way to recover what it said as
 * of that cutoff — it must be treated as unusable rather than read at either
 * version. Callers that have not already established the comment predates
 * `asOf` want `usableAsOf` below, which checks both halves.
 */
function recoverableAsOf(n: { lastEditedAt?: unknown }, asOf: string): boolean {
  const edited = n.lastEditedAt;
  if (edited === null || edited === undefined) return true;
  const editedAt = stamp(edited);
  if (editedAt === null) return false;
  const editedMs = epochOf(editedAt);
  const asOfMs = epochOf(asOf);
  return editedMs !== null && asOfMs !== null && editedMs <= asOfMs;
}

/**
 * Whether a comment's CURRENT body is usable as a stand-in for its body `asOf`
 * a cutoff at ALL — both halves: it must have existed by then (`createdAt <=
 * asOf`, on a readable timestamp) and, per `recoverableAsOf`, not have been
 * edited afterward. `recoverableAsOf` alone answers only the second half; a
 * comment created AFTER `asOf` — nothing requires a thread's first comment to
 * predate an arbitrary later cutoff — with a null `lastEditedAt` (never edited)
 * passes `recoverableAsOf` vacuously, which is exactly the gap the category
 * guard below had on its own: it checked `recoverableAsOf` but not `createdAt`,
 * so a raising comment posted after the cutoff still contributed its current
 * category to a supposedly `asOf`-frozen sample.
 */
function usableAsOf(
  n: { createdAt?: unknown; lastEditedAt?: unknown },
  asOf: string,
): boolean {
  const at = stamp(n.createdAt);
  if (at === null) return false;
  const atMs = epochOf(at);
  const asOfMs = epochOf(asOf);
  if (atMs === null || asOfMs === null || atMs > asOfMs) return false;
  return recoverableAsOf(n, asOf);
}

/**
 * Shape one thread node plus its (possibly topped-up) comment list.
 *
 * Exported and pure so the WITHHOLDING rule below is testable without a
 * network. It is not decoration: a test that merely hands consumers a
 * `{outcome: null, commentsTruncated: true}` fixture pins how they treat a
 * withheld outcome and says nothing about whether this function withholds one
 * — which was exactly the gap, caught by mutating this line and watching the
 * suite stay green.
 */
export function threadFrom(
  t: Record<string, unknown>,
  commentNodes: readonly CommentNode[],
  truncated: boolean,
  asOf?: string,
): ThreadSample {
  // Withheld, not guessed, while the list is incomplete — see
  // `ThreadSample.commentsTruncated`. An unread later reply can supersede
  // anything the visible prefix says, and no consumer of `outcome` is in a
  // position to discount it.
  //
  // `asOf` bounds which replies may settle it (see `SampleOptions.asOf`). A
  // comment with no readable timestamp is EXCLUDED under a cutoff rather than
  // admitted: it cannot be shown to predate the boundary, and admitting it
  // would reintroduce exactly the drift the cutoff exists to stop.
  const settleFrom =
    asOf === undefined
      ? commentNodes
      : commentNodes.filter((c) => {
          const n = c as { createdAt?: unknown; lastEditedAt?: unknown };
          // `createdAt` alone does not freeze anything. GitHub keeps the
          // original creation time when a comment is EDITED and returns the
          // current body, so a qualifying reply written before the cutoff and
          // reworded after it would smuggle the post-window outcome into a
          // supposedly reproducible denominator; disclosing that limitation is
          // not enough, it has to be closed.
          //
          // An edit after the cutoff makes the body unusable AS OF the cutoff:
          // the text that stood then is not recoverable from this payload, so
          // the comment is dropped rather than read at either version. An
          // unreadable `lastEditedAt` on a comment that reports having been
          // edited is dropped for the same reason.
          return usableAsOf(n, asOf);
        });
  const settled = truncated ? null : settledFrom(settleFrom);
  const first = commentNodes[0];
  const firstAuthor = first?.author as
    | { login?: string; __typename?: string }
    | null
    | undefined;
  const firstOriginalCommit = first?.originalCommit as
    | { oid?: string }
    | null
    | undefined;
  return {
    threadId: String(t.id ?? ""),
    path: typeof t.path === "string" ? t.path : null,
    line: typeof t.line === "number" ? t.line : null,
    originalLine: typeof t.originalLine === "number" ? t.originalLine : null,
    diffSide: typeof t.diffSide === "string" ? t.diffSide : null,
    isOutdated: t.isOutdated === true,
    isResolved: t.isResolved === true,
    startedBy: firstAuthor?.login ?? null,
    startedByBot: firstAuthor?.__typename === "Bot",
    url: typeof first?.url === "string" ? first.url : null,
    outcome: settled?.outcome ?? null,
    reason: settled?.reason ?? null,
    settledBody: settled?.body ?? null,
    createdAt: stamp(first?.createdAt),
    settledAt: settled === null ? null : stamp(settled.at),
    commentsTruncated: truncated,
    category:
      asOf !== undefined &&
      first !== undefined &&
      !usableAsOf(
        first as { createdAt?: unknown; lastEditedAt?: unknown },
        asOf,
      )
        ? "unknown"
        : categoryOf(typeof first?.body === "string" ? first.body : ""),
    // Same guard, same expression, same reason as `category` directly above:
    // a raising comment edited after the cutoff has no recoverable as-of body,
    // so its severity is withheld rather than read at the current version.
    //
    // `firstAuthor?.login` is threaded through so `severityOf`'s CodeRabbit
    // path only ever fires on a comment CodeRabbit actually posted — a
    // shape-only match is defeated by any reviewer's prose that happens to
    // land on the same three-field pipe-delimited form (see `severityOf`'s
    // own doc).
    severity:
      asOf !== undefined &&
      first !== undefined &&
      !usableAsOf(
        first as { createdAt?: unknown; lastEditedAt?: unknown },
        asOf,
      )
        ? "unknown"
        : severityOf(
            typeof first?.body === "string" ? first.body : "",
            firstAuthor?.login ?? null,
          ),
    reviewedHeadOid:
      typeof firstOriginalCommit?.oid === "string" &&
      firstOriginalCommit.oid !== ""
        ? firstOriginalCommit.oid
        : null,
    autonomy: threadAutonomy(commentNodes, truncated),
  };
}

export interface SampleOptions {
  /**
   * Fetch the commit and review connections. Only `loop-metrics.ts` needs them
   * — they exist to attribute code growth to rounds — and each is its own
   * paginating round-trip per PR.
   *
   * `defect-escape.ts` sweeps a whole week of merged PRs and reads nothing but
   * threads, so skipping these halves its wall-clock. Default `true`, because
   * silently returning empty arrays is the kind of default that turns a metric
   * into a lie; a caller opts OUT knowing it will not read them.
   */
  history?: boolean;
  /**
   * Settle every thread's outcome as of this ISO instant, ignoring replies
   * posted after it. Omit for "as of now", which is right for a live drive.
   *
   * A recorded window is supposed to re-measure identically at any time, and
   * without this it does not: a trusted participant who adds or edits an
   * outcome reply after a PR merged silently rewrites that PR's outcome mix,
   * declined denominator and escape rate on every later run — the same moving
   * -target defect `laterFixCommits` had with its upper bound.
   *
   * Bounds SETTLEMENT only. The thread's own `createdAt` and authorship are
   * left alone: they describe when the finding was raised, which no later
   * comment changes.
   */
  asOf?: string;
}

/** Everything `loop-metrics.ts` and `defect-escape.ts` read about one PR. */
export async function samplePr(
  pr: number,
  repo: Repo,
  opts: SampleOptions = {},
): Promise<PrSample> {
  const history = opts.history !== false;
  const metaPages = await graphqlPages(META_QUERY, repo, pr, false);
  const meta = pullRequestOf(metaPages[0], pr);

  const commits: CommitSample[] = [];
  for (const page of history
    ? await graphqlPages(COMMITS_QUERY, repo, pr)
    : []) {
    const node = pullRequestOf(page, pr);
    const nodes = ((node.commits as { nodes?: unknown[] } | undefined)?.nodes ??
      []) as Array<{ commit?: Record<string, unknown> }>;
    for (const n of nodes) {
      const c = n.commit ?? {};
      const parentsConn = c.parents as
        | { totalCount?: number; nodes?: Array<{ oid?: unknown }> }
        | undefined;
      commits.push({
        oid: String(c.oid ?? ""),
        committedDate: String(c.committedDate ?? ""),
        additions: count(c.additions, "commit.additions", pr),
        deletions: count(c.deletions, "commit.deletions", pr),
        parents: count(
          parentsConn?.totalCount,
          "commit.parents.totalCount",
          pr,
        ),
        parentOids: (parentsConn?.nodes ?? [])
          .map((p) => (typeof p.oid === "string" ? p.oid : ""))
          .filter((oid) => oid !== ""),
        headline: String(c.messageHeadline ?? ""),
      });
    }
  }

  const reviews: ReviewSample[] = [];
  for (const page of history
    ? await graphqlPages(REVIEWS_QUERY, repo, pr)
    : []) {
    const node = pullRequestOf(page, pr);
    const nodes = ((node.reviews as { nodes?: unknown[] } | undefined)?.nodes ??
      []) as Array<Record<string, unknown>>;
    for (const n of nodes) {
      const author = n.author as
        | { login?: string; __typename?: string }
        | null
        | undefined;
      const rvCommentsConn = n.comments as
        | {
            pageInfo?: { hasNextPage?: boolean };
            nodes?: Array<{ replyTo?: unknown }>;
          }
        | undefined;
      const rvComments = (rvCommentsConn?.nodes ?? []) as Array<{
        replyTo?: unknown;
      }>;
      // The extra round-trip is spent ONLY on the genuinely ambiguous case — a
      // bodiless review whose whole first page is replies and which has more.
      // A body, or one non-reply in the prefix, settles it for free.
      const prefix = initiatingFromPrefix(
        n.body,
        rvComments,
        rvCommentsConn?.pageInfo?.hasNextPage === true,
      );
      const initiating =
        prefix === "unresolved"
          ? ((await reviewHasNonReply(String(n.id ?? ""))) ?? true)
          : prefix;
      reviews.push({
        oid: String((n.commit as { oid?: string } | null)?.oid ?? ""),
        submittedAt: String(n.submittedAt ?? ""),
        author: String(author?.login ?? ""),
        isBot: author?.__typename === "Bot",
        initiating,
      });
    }
  }

  const threads: ThreadSample[] = [];
  for (const page of await graphqlPages(THREADS_QUERY, repo, pr)) {
    const node = pullRequestOf(page, pr);
    const nodes = ((node.reviewThreads as { nodes?: unknown[] } | undefined)
      ?.nodes ?? []) as Array<Record<string, unknown>>;
    for (const t of nodes) {
      const comments = t.comments as
        | {
            pageInfo?: { hasNextPage?: boolean };
            nodes?: Array<Record<string, unknown>>;
          }
        | undefined;
      const threadId = String(t.id ?? "");
      let commentNodes: readonly CommentNode[] = comments?.nodes ?? [];
      // Fail CLOSED: only an explicit `false` clears the flag, so a missing or
      // malformed pageInfo reads as "there may be a reply past the cap" rather
      // than as a settled answer.
      let truncated =
        (comments?.pageInfo as { hasNextPage?: boolean } | undefined)
          ?.hasNextPage !== false;
      if (truncated) {
        // Read the rest rather than measuring off a prefix. Only the residual
        // failure keeps the flag — see `ThreadSample.commentsTruncated`.
        const full = await allCommentsOf(threadId);
        if (full !== null) {
          commentNodes = full;
          truncated = false;
        }
      }
      threads.push(threadFrom(t, commentNodes, truncated, opts.asOf));
    }
  }

  return {
    pr: count(meta.number, "number", pr),
    title: String(meta.title ?? ""),
    state: String(meta.state ?? ""),
    additions: count(meta.additions, "additions", pr),
    deletions: count(meta.deletions, "deletions", pr),
    changedFiles: count(meta.changedFiles, "changedFiles", pr),
    baseRefName: String(meta.baseRefName ?? ""),
    headRefOid: String(meta.headRefOid ?? ""),
    createdAt: String(meta.createdAt ?? ""),
    mergedAt: typeof meta.mergedAt === "string" ? meta.mergedAt : null,
    mergeCommitOid: String(
      (meta.mergeCommit as { oid?: string } | null)?.oid ?? "",
    ),
    commits,
    reviews,
    threads,
  };
}
