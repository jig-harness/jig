/** REST observations of a commit, without reading the caller's reviewer settings. */
import { suiteIdOf } from "../ci-hold.ts";
import { type PagedRead, slurpPages } from "../paged-read.ts";

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  app: string;
  title: string;
  id: number;
  /** ISO timestamp, or `null` for a queued attempt that has not started —
   * the same nullability `latestPerName`'s ordering comment already documents.
   * Read by the stranded-check-run bypass to floor how long an
   * `in_progress` run must have been running before its sticky is trusted,
   * distinguishing a genuine in-flight publish (seconds) from a stranded one
   * (measured: 3.5+ hours). */
  started: string | null;
  /** ISO timestamp; absent or `null` until it has completed. */
  completed?: string | null;
  /** The check suite of the workflow run behind it, when it names one. */
  suiteId?: number | null;
}

export function parsePages(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
}

/**
 * Every page of a commit's `check-runs` or `statuses` listing; `null` when
 * unreadable. `fresh` unless the caller only observes (`paged-read.ts`): a
 * CI-green proof or a hold release reads what GitHub says now.
 */
export async function commitPages(
  owner: string,
  repo: string,
  sha: string,
  listing: "check-runs" | "statuses",
  read: PagedRead = "fresh",
  env?: Record<string, string | undefined>,
): Promise<unknown[] | null> {
  const r = await slurpPages(
    `repos/${owner}/${repo}/commits/${sha}/${listing}?per_page=100${
      listing === "check-runs" ? "&filter=all" : ""
    }`,
    read,
    env === undefined ? { stderr: "pipe" } : { stderr: "pipe", env },
  );
  return r.code === 0 ? parsePages(r.stdout) : null;
}

/** What ties a check-run to its workflow run and to when it ended. */
function jobTiming(c: Record<string, unknown>) {
  return {
    completed: typeof c.completed_at === "string" ? c.completed_at : null,
    suiteId: suiteIdOf(c.check_suite),
  };
}

/** One check-run of a listing page, reduced to the fields the decision reads. */
function checkRunOf(c: Record<string, unknown>): CheckRun {
  return {
    name: String(c.name ?? ""),
    status: String(c.status ?? ""),
    conclusion: c.conclusion === null ? null : String(c.conclusion ?? ""),
    app: String(((c.app as Record<string, unknown> | null)?.slug ?? "") || ""),
    title: String(
      ((c.output as Record<string, unknown> | null)?.title ?? "") || "",
    ),
    id: Number(c.id ?? 0),
    started: c.started_at === null ? null : String(c.started_at ?? "") || null,
    ...jobTiming(c),
  };
}

/**
 * Whether a check-run carries, in their own JSON types, the fields that give
 * it authority: its identity, its name, its status and its outcome. A record
 * missing one, or holding one of another type, is not read as a run.
 */
function identified(c: Record<string, unknown>): boolean {
  const app = c.app as { slug?: unknown } | null | undefined;
  return (
    typeof c.id === "number" &&
    Number.isSafeInteger(c.id) &&
    typeof c.name === "string" &&
    c.name !== "" &&
    typeof c.status === "string" &&
    (c.conclusion === null || typeof c.conclusion === "string") &&
    (app === null || app === undefined || typeof app.slug === "string")
  );
}

/**
 * Every check-run on `sha`, across every page (`--paginate --slurp`), reduced
 * to the fields the decision reads. `null` when the API could not be read —
 * the caller decides whether that is INDETERMINATE (a MERGEABLE head) or a
 * degraded-to-unknown verdict (a CONFLICTING one, where no consumer of the
 * runs is reachable).
 */
export async function checkRunsFor(
  owner: string,
  repo: string,
  sha: string,
  read: PagedRead = "fresh",
  env?: Record<string, string | undefined>,
): Promise<CheckRun[] | null> {
  const pages = await commitPages(owner, repo, sha, "check-runs", read, env);
  if (pages === null) return null;
  const runs: CheckRun[] = [];
  for (const page of pages) {
    const list = (page as { check_runs?: unknown } | null)?.check_runs;
    // A missing field, a list that is not one, or entries that are not
    // records, is not a read.
    if (!Array.isArray(list)) return null;
    for (const c of list) {
      if (typeof c !== "object" || c === null || Array.isArray(c)) return null;
      if (!identified(c as Record<string, unknown>)) return null;
      runs.push(checkRunOf(c as Record<string, unknown>));
    }
  }
  return runs;
}
