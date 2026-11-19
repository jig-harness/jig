/**
 * How a reader lists a paged REST resource of the pull request.
 *
 * - `observed`: an observation the evaluation reports on. Every ask in one
 *   evaluation (`withObservedEvaluation`) shares one reading, and each page
 *   is revalidated with its ETag, so an unchanged pull request costs `304`s
 *   (`shared/outbound/observed-pages.ts`).
 * - `fresh`: a read that guards a write, a thread resolve, a ledger write, a
 *   CI-green proof or an announcement. It reads the forge whole with its own
 *   call and never takes a reading another module took earlier: what it
 *   authorizes must rest on what GitHub says now.
 *
 * A head's check-runs listing is the one paged read here that outgrows a
 * single call's deadline: a large matrix runs to many pages. Each of its pages
 * keeps `GH_CALL_TIMEOUT`, the whole listing has `checkRunListingSeconds()`,
 * and the forge client reads at most `PAGE_CAP` pages. GitHub's default
 * `filter=latest` already leaves out the earlier attempts of a re-run, so the
 * listing asks for no narrower set.
 */
import { PAGE_CAP } from "../../../../shared/outbound/gh-paginate.ts";
import { attempt } from "../../../../shared/outcome.ts";
import { ghObservedSlurp } from "./gh-conditional.ts";
import {
  checkRunListingSeconds,
  ghCall,
  ghCallTimeoutSeconds,
  type RunResult,
} from "./proc.ts";

export type PagedRead = "observed" | "fresh";

/** What `gh api --paginate --slurp <path>` prints, read as `read` says. */
export function slurpPages(
  path: string,
  read: PagedRead,
  opts?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stderr?: "pipe" | "inherit" | "ignore";
  },
): Promise<RunResult> {
  if (read === "observed") return ghObservedSlurp(path, opts);
  const args = ["api", "--paginate", "--slurp", path];
  return opts === undefined ? ghCall(args) : ghCall(args, opts);
}

/** Why a check-runs listing the forge was answering could not be read whole. */
export interface ListingCutShort {
  /** The pages read before it stopped; `null` when gh paged it and did not say. */
  pagesRead: number | null;
  /** It has more pages than a read takes, so reading it again cannot help. */
  atBound: boolean;
  reason: string;
}

/** Every page of `sha`'s check-runs listing, each within its own deadline. */
export function slurpCheckRuns(
  owner: string,
  repo: string,
  sha: string,
  read: PagedRead,
  opts: { stderr?: "pipe" | "inherit" | "ignore" } = {},
): Promise<RunResult> {
  const path = `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`;
  const wholeSec = checkRunListingSeconds();
  return read === "observed"
    ? ghObservedSlurp(path, { ...opts, timeoutSec: wholeSec })
    : ghCall(["api", "--paginate", "--slurp", path], {
        ...opts,
        pagedWholeSec: wholeSec,
      });
}

/**
 * How `sha`'s check-runs listing was cut short: a deadline it ran into, or
 * the bound on its pages. `null` for a read that failed any other way, which
 * more time would not mend.
 */
export function listingCutShort(
  sha: string,
  result: RunResult,
): ListingCutShort | null {
  const refused = result.held?.code === "too-costly" ? result.held : null;
  if (!result.timedOut && refused === null) return null;
  const pagesRead = result.pagesRead ?? null;
  const atBound =
    !result.timedOut && pagesRead !== null && pagesRead >= PAGE_CAP;
  const pages =
    pagesRead === null ? "an unknown number of pages" : `${pagesRead} page(s)`;
  const how = result.timedOut
    ? "at a deadline"
    : atBound
      ? "at its page bound"
      : `because ${refused?.reason ?? "the forge client refused a page"}`;
  const limits = `each page may take ${ghCallTimeoutSeconds()}s, the listing ${checkRunListingSeconds()}s and ${PAGE_CAP} pages`;
  return {
    pagesRead,
    atBound,
    reason: `the check-runs listing of ${sha} stopped after ${pages}, ${how} (${limits})`,
  };
}

/** All items from array-valued pages; null for an unreadable or malformed list. */
export async function readArrayPages(
  path: string,
  read: PagedRead,
): Promise<unknown[] | null> {
  const result = await slurpPages(path, read);
  if (result.code !== 0) return null;
  const decoded = attempt("unreadable", "paged list JSON", (): unknown =>
    JSON.parse(result.stdout),
  );
  const pages = decoded.ok ? decoded.value : null;
  return Array.isArray(pages) && pages.every(Array.isArray)
    ? pages.flat()
    : null;
}
