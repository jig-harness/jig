/**
 * What one tick reads once and shares between its repositories' observe
 * phases: each repository's query (`forge-batch.ts`: the repository, its
 * configuration, its open pull requests and their comments), each pull
 * request's comments (`tick-comments.ts`, filled from that query where it
 * read them in full, the rest revalidated page by page against what an
 * earlier tick read, `records/comment-pages.ts`), the forge's login, the runtime's host-wide listings, and the forge's budget. The
 * login and the listings are the host's, not a repository's: each is read
 * once, the first time a repository needs it, and every repository is
 * answered from that read, a failed one failing each repository's record as
 * a read of its own would. The queries start from the page size the last
 * tick's read ended at (`pageSizes`), so a repository whose pull requests
 * the forge cannot answer fifty at a time is not asked that way every tick.
 * The budget is read once, as the tick starts, from the machine's budget
 * record (`shared/outbound/github-budget.ts`), which every process's forge
 * calls keep current; only a record whose core window no answer has reported in the last
 * minute is refreshed first, by one read of the `rate_limit` endpoint. It
 * decides whether the optional reads run (`lowBudget`), and every
 * repository's report says what was left then.
 *
 * The observe phase runs its reads through one bounded pool (`pool.ts`),
 * the comment listings among them, so the listings of many pull requests
 * are read at once with no more than the pool's size in flight.
 *
 * In a tick its launcher bounds, the forge reads here keep to the tick's
 * bound (`sources/bounded.ts`): one the bound ended before it left the
 * pool is not started, and answers as a read that failed; a paged query
 * asks no page after the bound ends; a comment listing is given no more
 * time than the bound has left.
 *
 * None of these serves a read just before a launch: those go to the forge
 * and the runtime (`tick-apply.ts`).
 */
import { coalesce } from "../../shared/outbound/coalesce.ts";
import { OutboundError } from "../../shared/outbound/failure.ts";
import { resolveLogin } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { listCommentsKept } from "../../shared/records/comment-pages.ts";
import type { SharedBudget } from "../../shared/records/shared.ts";
import { failed, type Outcome } from "../../shared/outcome.ts";
import { forgeShared } from "../../shared/records/shared-forge.ts";
import type { BudgetWindow } from "../../shared/outbound/budget.ts";
import { githubBalances } from "../../shared/outbound/github-budget.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";
import {
  type CommentsRead,
  type PageSizes,
  readComments,
  readRepository,
  type RepositoryRead,
} from "./forge-batch.ts";
import { forgetMergeRead } from "./merge-reads.ts";
import { pickupReads } from "./pickup-reads.ts";
import { type Pool, pool } from "./pool.ts";
import type { SessionRuntime, SessionsReader } from "./runtime/port.ts";
import {
  ended,
  passedBefore,
  secondsLeft,
  type TickBound,
  unlessEnded,
} from "./sources/bounded.ts";
import type { ServedViews } from "./sources/served-reads.ts";
import { failureText } from "./text.ts";
import { type TickComments, tickComments } from "./tick-comments.ts";
import type { SharedReport } from "./types.ts";

/** The forge's budget as the tick started, or why it did not read. */
export type TickBudget = SharedBudget | { unreadable: string };

/** Below this share of its limit left, the forge's budget is low and the optional reads are skipped. */
const LOW_BUDGET_SHARE = 0.1;

/** The reads a tick skips while the forge's budget is low. */
export const OPTIONAL_READS = [
  "thread samples",
  "serialization's changed files and threads",
  "the steward's linked pull requests and check histories",
];

/** Whether `budget` is low: under `LOW_BUDGET_SHARE` of its limit left. One that does not read is not. */
export function lowBudget(budget: TickBudget): budget is SharedBudget {
  return (
    "remaining" in budget && budget.remaining < budget.limit * LOW_BUDGET_SHARE
  );
}

/** A repository's query as the tick read it, or why it did not read in full. */
export type RepositoryOutcome = Outcome<RepositoryRead, "unreadable">;

/** A query of named pull requests' comments, or why it did not read. */
export type CommentsOutcome = Outcome<CommentsRead, "unreadable">;

export interface TickReads {
  /** The query of the checkout at `path`, read once per tick; the open pull requests' comments it read in full fill `comments`. */
  repository(path: string): Promise<RepositoryOutcome>;
  /** The comments of the pull requests `prs` of `slug` read in queries of `forge-batch.ts`'s `PAGE` each; those it read in full fill `comments`. */
  pullRequestComments(
    slug: string,
    prs: readonly number[],
  ): Promise<CommentsOutcome>;
  comments: TickComments;
  /** The login the forge client is signed in as, read once per tick. */
  login(): Promise<string | null>;
  /** The runtime's sessions for one repository, its host-wide listings read once per tick. */
  sessions: SessionsReader;
  /** The shared reports that want the budget, filled when the tick closes (`fillBudgets`). */
  budgets: SharedReport[];
  /** The forge's budget as the tick started, read once. */
  budget(): Promise<TickBudget>;
  /** The pool every read of the observe phase runs through. */
  pool: Pool;
  /** The served queues read this tick, one per tracker, team and person, shared by the repositories that name them. */
  servedViews?: ServedViews;
  /** The tick's bound, which every read of the observe phase keeps to; absent for a tick no launcher bounds. */
  bound?: TickBound;
}

/**
 * The runtime's sessions reader, made the first time a repository reads
 * sessions, so a runtime whose `sessionsOnce` throws fails that read inside
 * the repository's boundary rather than the tick's start.
 */
function lazySessions(runtime: SessionRuntime): SessionsReader {
  let reader: SessionsReader | null = null;
  return async (repo, join, signal) => {
    reader ??=
      runtime.sessionsOnce?.() ?? ((r, j, s) => runtime.sessions(r, j, s));
    return await reader(repo, join, signal);
  };
}

/** How old the record's core balance may be for the tick to read it without asking the forge. */
const FRESH_RECORD_MS = 60_000;

/** The core balance the machine's record holds now, when an answer updated it within `FRESH_RECORD_MS`; `null` otherwise. */
export function recordedBudget(
  now: number,
  balances: ReturnType<typeof githubBalances>,
): SharedBudget | null {
  if (balances === null) return null;
  const core: BudgetWindow = balances.core;
  // The core window's own last report: spending that other windows' answers
  // or reservations recorded does not make the balance current.
  if (core.answeredAt == null || now - core.answeredAt > FRESH_RECORD_MS)
    return null;
  if (core.remaining === null || core.limit === null || core.resetAt === null)
    return null;
  const reset = core.resetAt <= now;
  return {
    remaining: reset ? core.limit : Math.max(0, Math.floor(core.remaining)),
    limit: core.limit,
    resetAt: isoFromMs(core.resetAt),
  };
}

/**
 * The forge's core budget from the machine's record; a record too old to
 * read is refreshed by one `rate_limit` read, whose answer the forge
 * client records. A read that fails is the reason it does not read.
 */
async function readBudget(): Promise<TickBudget> {
  try {
    const held = recordedBudget(currentMs(), githubBalances());
    if (held !== null) return held;
    const read = await forgeShared({ login: null }).budget();
    if (!read.ok) return { unreadable: read.failure.reason };
    return recordedBudget(currentMs(), githubBalances()) ?? read.value;
  } catch (error) {
    return { unreadable: failureText(error) };
  }
}

/** The page sizes the forge queries read at, kept between ticks with the dispatch state's other kept reads. */
const pageSizes: PageSizes = {
  get: (key) => pickupReads.get<unknown>(`forge:page:${key}`),
  set: (key, size) => pickupReads.set(`forge:page:${key}`, size),
};

/** A repository's query, its comments read in full held as the tick's listings; a query that throws is one that did not read. */
async function queryRepository(
  path: string,
  comments: TickComments,
  bound: TickBound | undefined,
): Promise<RepositoryOutcome> {
  let read: RepositoryOutcome;
  try {
    read = await readRepository(path, pageSizes, undefined, bound);
  } catch (error) {
    return failed("unreadable", failureText(error));
  }
  if (read.ok) {
    const { target, startedAtMs } = read.value;
    for (const [pr, listing] of read.value.comments)
      comments.seed(target.slug, pr, listing, startedAtMs);
  }
  return read;
}

/** Named pull requests' comments, held as the tick's listings where the query read them in full; a query that throws is one that did not read. */
async function queryComments(
  slug: string,
  prs: readonly number[],
  comments: TickComments,
  bound: TickBound | undefined,
): Promise<CommentsOutcome> {
  let read: CommentsOutcome;
  try {
    read = await readComments(slug, prs, pageSizes, undefined, bound);
  } catch (error) {
    return failed("unreadable", failureText(error));
  }
  if (read.ok)
    for (const [pr, listing] of read.value.comments)
      comments.seed(slug, pr, listing, read.value.startedAtMs);
  return read;
}

/** A comment listing's own deadline: the forge client's, or the whole seconds `bound` has left where that is sooner. */
function listingDeadline(bound: TickBound | undefined): {
  timeoutSec?: number;
} {
  if (bound === undefined) return {};
  const left = Math.ceil((bound.deadline - currentMs()) / 1000);
  return { timeoutSec: Math.max(1, left) };
}

/**
 * The login the forge names, held to `bound`: a deadline that passed before
 * the read, or while it ran (whatever the clock says of the signal's event
 * not yet delivered), is an `unreachable` rejection, never a missing login.
 */
function readLogin(bound: TickBound | undefined): Promise<string | null> {
  const passed = (what: string) =>
    Promise.reject(new OutboundError("unreachable", what));
  if (ended(bound)) return passed(passedBefore("the login was read"));
  return resolveLogin(secondsLeft(bound), bound?.signal).then((login) =>
    ended(bound) && login === null
      ? passed("the tick's deadline passed during the login read")
      : login,
  );
}

/**
 * One tick's shared reads, its pool `poolSize` reads wide, its forge reads
 * kept to `bound` where the tick has one; a write the tick makes on a
 * merged pull request drops its kept marker read too.
 */
export function tickReads(
  runtime: SessionRuntime,
  poolSize?: number,
  bound?: TickBound,
): TickReads {
  const singletonReads = new Map<string, Promise<unknown>>();
  const reads = pool(poolSize);
  const comments = tickComments({
    list: (target) =>
      reads.run(() =>
        unlessEnded(
          bound,
          `the comments of #${target.number} were listed`,
          () => listCommentsKept(target, listingDeadline(bound)),
        ),
      ),
    written: (repo, pr) => forgetMergeRead(repo, pr),
  });
  const repositories = new Map<string, Promise<RepositoryOutcome>>();
  return {
    repository: (path) =>
      coalesce(repositories, path, () =>
        reads.run(() =>
          unlessEnded(bound, "the repository's query was read", () =>
            queryRepository(path, comments, bound),
          ),
        ),
      ),
    pullRequestComments: (slug, prs) =>
      reads.run(() =>
        unlessEnded(bound, "the merged pull requests' comments were read", () =>
          queryComments(slug, prs, comments, bound),
        ),
      ),
    comments,
    login: () =>
      coalesce(singletonReads, "login", () =>
        reads.run(() => readLogin(bound)),
      ) as Promise<string | null>,
    sessions: lazySessions(runtime),
    budgets: [],
    budget: () =>
      coalesce(singletonReads, "budget", () =>
        reads.run(readBudget),
      ) as Promise<TickBudget>,
    pool: reads,
    servedViews: Object.assign(new Map(), bound === undefined ? {} : { bound }),
    ...(bound === undefined ? {} : { bound }),
  };
}

/** Put the forge's budget, as the tick started, on each report that wants it. */
export async function fillBudgets(reads: TickReads): Promise<void> {
  if (reads.budgets.length === 0) return;
  const budget = await reads.budget();
  for (const report of reads.budgets) report.budget = budget;
}
