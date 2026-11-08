/**
 * What one tick reads once and shares between its repositories' observe
 * phases: each repository's query (`forge-batch.ts`: the repository, its
 * configuration, its open pull requests and their comments), each pull
 * request's comments (`tick-comments.ts`, filled from that query where it
 * read them in full), the forge's login, the runtime's host-wide listings, and the forge's budget. The
 * login and the listings are the host's, not a repository's: each is read
 * once, the first time a repository needs it, and every repository is
 * answered from that read, a failed one failing each repository's record as
 * a read of its own would. The budget is read once, as the tick starts: it
 * decides whether the optional reads run (`lowBudget`), and every
 * repository's report says what was left then.
 *
 * The observe phase runs its reads through one bounded pool (`pool.ts`),
 * the comment listings among them, so the listings of many pull requests
 * are read at once with no more than the pool's size in flight.
 *
 * None of these serves a read just before a launch: those go to the forge
 * and the runtime (`tick-apply.ts`).
 */
import { resolveLogin } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { listComments } from "../../shared/records/forge-claims.ts";
import type { SharedBudget } from "../../shared/records/shared.ts";
import { failed, type Outcome } from "../../shared/outcome.ts";
import { forgeShared } from "../../shared/records/shared-forge.ts";
import {
  type CommentsRead,
  readComments,
  readRepository,
  type RepositoryRead,
} from "./forge-batch.ts";
import { forgetMergeRead } from "./merge-reads.ts";
import { type Pool, pool } from "./pool.ts";
import type { SessionRuntime, SessionsReader } from "./runtime/port.ts";
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
}

/**
 * The runtime's sessions reader, made the first time a repository reads
 * sessions, so a runtime whose `sessionsOnce` throws fails that read inside
 * the repository's boundary rather than the tick's start.
 */
function lazySessions(runtime: SessionRuntime): SessionsReader {
  let reader: SessionsReader | null = null;
  return async (repo, join) => {
    reader ??= runtime.sessionsOnce?.() ?? ((r, j) => runtime.sessions(r, j));
    return await reader(repo, join);
  };
}

/** The forge's core budget; a read that fails is the reason it does not read. */
async function readBudget(): Promise<TickBudget> {
  try {
    const read = await forgeShared({ login: null }).budget();
    return read.ok ? read.value : { unreadable: read.failure.reason };
  } catch (error) {
    return { unreadable: failureText(error) };
  }
}

/** A repository's query, its comments read in full held as the tick's listings; a query that throws is one that did not read. */
async function queryRepository(
  path: string,
  comments: TickComments,
): Promise<RepositoryOutcome> {
  let read: RepositoryOutcome;
  try {
    read = await readRepository(path);
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
): Promise<CommentsOutcome> {
  let read: CommentsOutcome;
  try {
    read = await readComments(slug, prs);
  } catch (error) {
    return failed("unreadable", failureText(error));
  }
  if (read.ok)
    for (const [pr, listing] of read.value.comments)
      comments.seed(slug, pr, listing, read.value.startedAtMs);
  return read;
}

/** One tick's shared reads, its pool `poolSize` reads wide; a write the tick makes on a merged pull request drops its kept marker read too. */
export function tickReads(
  runtime: SessionRuntime,
  poolSize?: number,
): TickReads {
  let login: Promise<string | null> | null = null;
  let budget: Promise<TickBudget> | null = null;
  const reads = pool(poolSize);
  const comments = tickComments({
    list: (target) => reads.run(() => listComments(target, {})),
    written: (repo, pr) => forgetMergeRead(repo, pr),
  });
  const repositories = new Map<string, Promise<RepositoryOutcome>>();
  return {
    repository: (path) => {
      let read = repositories.get(path);
      if (read === undefined) {
        read = reads.run(() => queryRepository(path, comments));
        repositories.set(path, read);
      }
      return read;
    },
    pullRequestComments: (slug, prs) =>
      reads.run(() => queryComments(slug, prs, comments)),
    comments,
    login: () => {
      login ??= reads.run(() => resolveLogin());
      return login;
    },
    sessions: lazySessions(runtime),
    budgets: [],
    budget: () => {
      budget ??= reads.run(readBudget);
      return budget;
    },
    pool: reads,
  };
}

/** Put the forge's budget, as the tick started, on each report that wants it. */
export async function fillBudgets(reads: TickReads): Promise<void> {
  if (reads.budgets.length === 0) return;
  const budget = await reads.budget();
  for (const report of reads.budgets) report.budget = budget;
}
