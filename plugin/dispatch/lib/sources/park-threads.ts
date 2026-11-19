/**
 * The parked review threads a tick need not read again. A thread's comments
 * are a GraphQL request each, and a parked drive's threads rarely change, so
 * their last reading is kept between ticks and reused while the pull
 * request's review comments are as they were.
 *
 * Whether they are is asked every tick, through the conditional listing of
 * the pull request's review comments (`listReviewCommentsKept`), which costs
 * no rate limit while nothing changed: a reply, an edit or a deletion on any
 * of its threads changes the listing, so an answer is seen by the tick after
 * it is written, as when every thread was read. The listing is read before
 * the threads, so a reply landing between the two is seen by the next tick.
 *
 * The listing and the thread query are answered by different parts of the
 * forge, and the listing can show a reply the query does not return yet. A
 * reading is therefore reused only when it was taken `LISTING_SETTLE_MS` or
 * more after this host last saw the review comments change, a pull request
 * it sees for the first time counting as changed then; until that time each
 * tick reads the thread again. A kept reading is also read again after
 * `THREAD_BACKSTOP_MS`, whatever the listing says.
 *
 * Keeping is only a saving. A listing that does not read, a record that does
 * not parse or a store that fails each leave the tick reading its threads.
 *
 * Costs: one REST request per page of review comments a tick (no primary
 * rate limit when unchanged), and one GraphQL point per thread only when the
 * listing changed lately or the backstop is due.
 */
import { createHash } from "node:crypto";
import { swallow } from "../../../shared/errors.ts";
import { isRecord } from "../../../shared/guards.ts";
import type { Outcome } from "../../../shared/outcome.ts";
import { listReviewCommentsKept } from "../../../shared/records/comment-pages.ts";
import type { Deadline } from "../../../shared/records/forge-claims.ts";
import { currentMs } from "../../../shared/time.ts";
import type { CommentLike } from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import { type PickupReads, pickupReads } from "../pickup-reads.ts";
import { ended, heldRead, secondsLeft, type TickBound } from "./bounded.ts";

/** How long a thread's reading is reused, however unchanged its pull request's review comments look. */
export const THREAD_BACKSTOP_MS = 60 * 60_000;

/** How long after the review comments change a thread's reading may still miss the change. */
export const LISTING_SETTLE_MS = 2 * 60_000;

/** The most the cache probe may take of the tick's time; a quarter of what is left is kept back for the thread reads. */
const PROBE_MAX_SEC = 30;

const KEY_PREFIX = "park-threads:";

/** Under this prefix, one record per pull request of `slug`. */
const repositoryPrefix = (slug: string) => `${KEY_PREFIX}${slug}#`;

interface KeptThread {
  readAt: number;
  comments: CommentLike[];
}

interface KeptRecord {
  /** The review comments the readings were taken against (`signatureOf`). */
  listing: string;
  /** When this host first saw those review comments. */
  changedAt: number;
  threads: Record<string, KeptThread>;
}

/** What one pull request's parked threads may reuse, and what to keep of this tick's reads. */
export interface KeptParkThreads {
  /** The thread's kept comments, where they still stand; `null` when it must be read. */
  held(key: string): CommentLike[] | null;
  keep(key: string, comments: CommentLike[]): void;
  /** Store what the next tick may reuse, where this one changed it. */
  save(): void;
}

export interface ParkThreadDeps {
  listing: (
    target: { repo: string; number: number },
    deadline: Deadline,
  ) => Promise<Outcome<unknown[], "unreadable">>;
  store: Pick<PickupReads, "get" | "set">;
}

const NOTHING_KEPT: KeptParkThreads = {
  held: () => null,
  keep: () => undefined,
  save: () => undefined,
};

/** What an answer depends on of each review comment, so a change elsewhere (a reaction) reads nothing again. */
function signatureOf(listing: readonly unknown[]): string {
  const facts = listing
    .filter(isRecord)
    .map((c) => [
      c.id,
      c.updated_at,
      c.author_association,
      isRecord(c.user) ? c.user.login : null,
      c.body,
    ]);
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function isComment(value: unknown): value is CommentLike {
  return (
    isRecord(value) &&
    typeof value.author === "string" &&
    typeof value.association === "string" &&
    typeof value.at === "string" &&
    typeof value.url === "string" &&
    typeof value.body === "string" &&
    (value.editedAt === undefined ||
      value.editedAt === null ||
      typeof value.editedAt === "string")
  );
}

function isThread(value: unknown): value is KeptThread {
  return (
    isRecord(value) &&
    typeof value.readAt === "number" &&
    Array.isArray(value.comments) &&
    value.comments.every(isComment)
  );
}

/** The record as stored, where it reads as one. */
function recordOf(value: unknown): KeptRecord | null {
  return isRecord(value) &&
    typeof value.listing === "string" &&
    typeof value.changedAt === "number" &&
    isRecord(value.threads) &&
    Object.values(value.threads).every(isThread)
    ? (value as unknown as KeptRecord)
    : null;
}

/** Each review comment's URL, under the URL of the comment its thread starts with. */
function threadUrlsIn(listing: readonly unknown[]): Map<string, Set<string>> {
  const rows = listing.filter(isRecord);
  const rootUrl = new Map<unknown, string>();
  for (const c of rows) {
    if (c.in_reply_to_id == null && typeof c.html_url === "string") {
      rootUrl.set(c.id, c.html_url);
    }
  }
  const threads = new Map<string, Set<string>>();
  for (const c of rows) {
    if (typeof c.html_url !== "string") continue;
    const root =
      c.in_reply_to_id == null ? c.html_url : rootUrl.get(c.in_reply_to_id);
    if (root === undefined) continue;
    const urls = threads.get(root) ?? new Set<string>();
    urls.add(c.html_url);
    threads.set(root, urls);
  }
  return threads;
}

/** Whether the thread read holds every comment the listing shows for it, and no other. */
function confirms(
  threads: Map<string, Set<string>>,
  comments: readonly CommentLike[],
): boolean {
  const first = comments[0];
  if (first === undefined) return false;
  const expected = threads.get(first.url);
  if (expected === undefined || expected.size !== comments.length) return false;
  return comments.every((c) => expected.has(c.url));
}

/**
 * The parked threads of pull request `pr` as the forge's review comments
 * leave them. Read before the threads, once per pull request and tick.
 */
export async function keptParkThreads(
  slug: string,
  pr: number,
  bound?: TickBound,
  deps: ParkThreadDeps = {
    listing: listReviewCommentsKept,
    store: pickupReads,
  },
): Promise<KeptParkThreads> {
  if (ended(bound)) return NOTHING_KEPT;
  const left = secondsLeft(bound);
  const probeSec =
    left === undefined
      ? PROBE_MAX_SEC
      : Math.min(PROBE_MAX_SEC, Math.max(1, Math.floor(left / 4)));
  const listed = await heldRead(
    bound,
    `the review comments of ${slug}#${pr} were listed`,
    () => deps.listing({ repo: slug, number: pr }, { timeoutSec: probeSec }),
  );
  if (!listed.ok) {
    swallow(
      listed.failure.cause ?? listed.failure,
      `list the review comments of ${slug}#${pr}: ${listed.failure.reason}; reading its parked threads instead`,
    );
    return NOTHING_KEPT;
  }
  const key = `${repositoryPrefix(slug)}${pr}`;
  const listing = signatureOf(listed.value);
  const record = recordOf(deps.store.get<unknown>(key));
  const standing = record?.listing === listing ? record.threads : {};
  // Taken before any thread is read: a reading is never younger than it says.
  const now = currentMs();
  const changedAt = record?.listing === listing ? record.changedAt : now;
  const threads: Record<string, KeptThread> = {};
  let changed = record?.listing !== listing;
  const urlsOfThread = threadUrlsIn(listed.value);
  return {
    held(thread) {
      const kept = standing[thread];
      if (kept === undefined) return null;
      const age = now - kept.readAt;
      if (age < 0 || age >= THREAD_BACKSTOP_MS) return null;
      if (kept.readAt - changedAt < LISTING_SETTLE_MS) return null;
      threads[thread] = kept;
      return kept.comments;
    },
    keep(thread, comments) {
      // A reading the listing does not confirm is not kept, so the next tick reads again.
      if (confirms(urlsOfThread, comments)) {
        threads[thread] = { readAt: now, comments };
      } else {
        delete threads[thread];
      }
      changed = true;
    },
    save() {
      if (
        changed ||
        Object.keys(threads).length !== Object.keys(standing).length
      )
        deps.store.set(key, { listing, changedAt, threads });
    },
  };
}

/** Drop the kept threads of `slug`'s pull requests that are no longer open; `open` is the whole list. */
export function forgetClosedParkThreads(
  slug: string,
  open: readonly number[],
  store: Pick<typeof pickupReads, "prune"> = pickupReads,
): void {
  const prefix = repositoryPrefix(slug);
  store.prune(
    prefix,
    open.map((pr) => `${prefix}${pr}`),
  );
}
