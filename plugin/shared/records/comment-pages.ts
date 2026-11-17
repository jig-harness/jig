/**
 * Every comment on an issue or pull request, read page by page with
 * conditional requests: each page's `ETag` is kept with its body
 * (`gh-conditional.ts`), and a page GitHub answers `304 Not Modified` is the
 * kept body. A `304` does not count against the primary rate limit, and the
 * cost ledger records it as costing nothing (`outbound/gh-ledger.ts`).
 *
 * The listing ends at the first page holding fewer than `PER_PAGE`
 * comments, which is always asked: a new comment lands on it, or opens it,
 * so an unchanged listing is never mistaken for a grown one. A page of
 * another listing never answers for this one: each is kept under the
 * credential, the repository and its own path.
 *
 * Where no cache is kept (`JIG_GH_CACHE=off`, or under test without a
 * directory) there is nothing to revalidate, and the listing is the plain
 * paged read (`listComments`); a listing longer than `MAX_PAGES` pages is
 * that read too.
 *
 * Costs: one request per page; a page that did not change costs no primary
 * rate limit.
 */
import {
  type ConditionalGet,
  type CallContext,
  ghCacheDir,
  ghConditionalGet,
} from "../gh-conditional.ts";
import { failedBy } from "../outbound/failure.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import { currentMs } from "../time.ts";
import { type Deadline, listComments } from "./forge-claims.ts";

/** The comments one page holds; a shorter page is the last. */
const PER_PAGE = 100;
/** The longest listing read page by page. */
const MAX_PAGES = 30;

export interface CommentPagesDeps {
  ghCacheDir: () => string | null;
  ghConditionalGet: (
    path: string,
    ctx?: CallContext,
  ) => Promise<ConditionalGet>;
  /** The plain paged read, for a listing kept nowhere or longer than `MAX_PAGES`. */
  plain: typeof listComments;
}

/** The comment listing over `deps`. */
export function commentPages(
  deps: CommentPagesDeps = {
    ghCacheDir,
    ghConditionalGet,
    plain: listComments,
  },
) {
  return async (
    target: { repo: string; number: number },
    deadline: Deadline = {},
  ): Promise<Outcome<unknown[], "unreadable">> => {
    if (deps.ghCacheDir() === null) return deps.plain(target, deadline);
    const began = currentMs();
    const comments: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const left =
        deadline.timeoutSec === undefined
          ? undefined
          : Math.ceil(deadline.timeoutSec - (currentMs() - began) / 1000);
      if (left !== undefined && left <= 0)
        return failed(
          "unreadable",
          "the comments could not be read (their deadline passed between pages)",
        );
      const read = await deps.ghConditionalGet(
        `repos/${target.repo}/issues/${target.number}/comments?per_page=${PER_PAGE}&page=${page}`,
        {
          repository: target.repo,
          ...(left === undefined ? {} : { timeoutSec: left }),
        },
      );
      if (!read.ok) {
        const reason = `the comments could not be read (${read.reason})`;
        return read.failure === undefined
          ? failed("unreadable", reason)
          : failedBy("unreadable", read.failure, reason);
      }
      let listed: unknown;
      try {
        listed = JSON.parse(read.body);
      } catch {
        return failed("unreadable", "the comment listing is not JSON");
      }
      if (!Array.isArray(listed))
        return failed("unreadable", "the comment listing is not a list");
      comments.push(...listed);
      if (listed.length < PER_PAGE) return ok(comments);
    }
    return deps.plain(target, deadline);
  };
}

/** Every comment on `target`, revalidated page by page against what was kept. */
export const listCommentsKept = commentPages();
