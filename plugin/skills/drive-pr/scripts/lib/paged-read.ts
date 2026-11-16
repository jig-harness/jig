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
 */
import { ghObservedSlurp } from "./gh-conditional.ts";
import { ghCall, type RunResult } from "./proc.ts";

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
