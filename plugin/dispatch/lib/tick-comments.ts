/**
 * The comments each pull request carries, listed at most once per tick and
 * shared by every record the observe phase reads from them: the drive
 * ledger, the park answers, the launch claims and the follow-up markers.
 * One listing per pull request is filled through one promise, so readers
 * that ask for the same pull request at once share the one read, and a
 * listing that failed is the answer for the rest of the tick too.
 *
 * Only the observe phase reads through it. Every read just before a launch
 * goes to the forge (a drive read again, a follow-up's markers read again, a
 * claim posted and read back, a claim's end), since the guards against a
 * second launch depend on what the forge says now. A write this tick makes
 * on a pull request (a claim posted, an end written, a claim released)
 * drops that pull request's listing, and tells `written`, so nothing after
 * it reads the comments as they were before it.
 */
import type { Outcome } from "../../shared/outcome.ts";
import {
  type Deadline,
  listComments,
} from "../../shared/records/forge-claims.ts";
import type {
  SharedOp,
  SharedRecords,
  SharedTarget,
} from "../../shared/records/shared.ts";
import {
  listEach,
  sharedClaimsFrom,
} from "../../shared/records/shared-forge.ts";

/** A pull request's comments as the forge listed them, or why they did not read. */
export type Listing = Outcome<unknown[], "unreadable">;

export interface TickComments {
  /** The comments of `pr` in `repo`, listed at most once this tick. */
  read(repo: string, pr: number): Promise<Listing>;
  /**
   * When the listing of `pr` began, in epoch milliseconds, or `null` when
   * none is held. A listing certifies a kept read only for a pull request
   * observation made before it began.
   */
  startedAt(repo: string, pr: number): number | null;
  /** Drop the listing of a pull request this tick wrote on. */
  forget(repo: string, pr: number): void;
}

const keyOf = (repo: string, pr: number) => `${repo}#${pr}`;

/** A tick's comment listings; `list` reads one from the forge, `written` is told of each pull request a write dropped. */
export function tickComments(
  options: {
    list?: (target: { repo: string; number: number }) => Promise<Listing>;
    written?: (repo: string, pr: number) => void;
  } = {},
): TickComments {
  const list =
    options.list ?? ((target) => listComments(target, {} satisfies Deadline));
  const listings = new Map<string, Promise<Listing>>();
  const started = new Map<string, number>();
  return {
    read(repo, pr) {
      const key = keyOf(repo, pr);
      let listing = listings.get(key);
      if (listing === undefined) {
        started.set(key, Date.now());
        listing = list({ repo, number: pr });
        listings.set(key, listing);
      }
      return listing;
    },
    startedAt(repo, pr) {
      return started.get(keyOf(repo, pr)) ?? null;
    },
    forget(repo, pr) {
      listings.delete(keyOf(repo, pr));
      started.delete(keyOf(repo, pr));
      options.written?.(repo, pr);
    },
  };
}

/**
 * The shared records as the observe phase reads them: `list` and
 * `listRepository` from the tick's listings, as `records` would read them,
 * each read reported to `note`; everything else is `records`' own.
 */
export function listingReader(
  records: SharedRecords,
  comments: TickComments,
  self: string | null,
  note: (op: SharedOp) => void,
): SharedRecords {
  const list: SharedRecords["list"] = async (target, stage) => {
    const listing = await comments.read(target.repo, target.pr);
    note({ op: "list", target: `PR #${target.pr}`, ok: listing.ok });
    return listing.ok
      ? {
          ok: true,
          value: sharedClaimsFrom(stage, listing.value, target, self),
        }
      : listing;
  };
  return { ...records, list, listRepository: listEach(list) };
}

/** The shared records with every write dropping its pull request's listing, whatever the write's answer. */
export function forgettingWrites(
  records: SharedRecords,
  comments: TickComments,
): SharedRecords {
  const after = async <T>(target: SharedTarget, write: Promise<T>) => {
    try {
      return await write;
    } finally {
      comments.forget(target.repo, target.pr);
    }
  };
  return {
    ...records,
    claim: (target, draft, rule) =>
      after(target, records.claim(target, draft, rule)),
    end: (target, stage, own, ended, host) =>
      after(target, records.end(target, stage, own, ended, host)),
    release: (target, own) => after(target, records.release(target, own)),
  };
}
