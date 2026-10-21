/**
 * Evidence gathering for the drive-status decision: reviewer identity, the
 * check-run/commit-status reduction behind the CI verdict, the reviewer's own
 * reviewed-SHA marker, and the work enumerators (threads + summary findings).
 * `evaluate.ts` owns the decision; this module owns the witnesses.
 */

import { parseReviewRound } from "../../summary-findings.ts";
import {
  isReviewerLogin,
  reviewedShaMarker,
  reviewerApp,
  reviewerCheckPattern,
  reviewerExpected,
  stickyMarker,
} from "../overlay.ts";
import { ghCall, run, tsArgv } from "../proc.ts";

// ── Reviewer identity ────────────────────────────────────────────────────────
// Identify the posting reviewer by its GitHub APP SLUG, not by check-run name.
// The name is decoration and there are decoys: this repo carries a permanently
// dormant `AI review` arm owned by github-actions (its `if:` gate is off, so it
// reports SKIPPED forever) whose name matches every reasonable reviewer-name
// pattern. The app slug distinguishes the identity that actually posts findings
// from every reviewer-SHAPED check that does not.
//
// The slug is the consumer's value (`review.reviewer_app`, or the
// `DRIVE_PR_REVIEWER_APP` override; see `lib/overlay.ts`). A repository that
// names none falls back to the check name alone, and to `review.bots` for the
// sticky comment's author: weaker, because a decoy arm with a reviewer-shaped
// name is then indistinguishable, which is why naming the app is recommended.

// Which of that app's checks is the finding-posting one. The app slug alone is
// not an identity: an app may publish several checks on a SHA, and a sibling's
// verdict must not stand in for the reviewer's. Matched as a case-insensitive
// regex so a parenthesised arm suffix such as "(shadow)" is tolerated.
//
// ANCHORED, and the tolerated suffix is only a parenthesised arm. Unanchored,
// the pattern is a substring match: a sibling named "AI review telemetry" from
// the same app matches, and since the reduction below takes the newest matching
// run, that sibling's success can attest a review the posting check never
// performed. The whole point of binding (app, name) is lost if the name half
// matches the siblings it exists to exclude.
const REVIEWER_CHECK_RAW = reviewerCheckPattern();

/** POSIX character classes → JS, so an override written for the bash/jq
 * dialect (`[[:space:]]`) keeps matching under `RegExp`. */
function posixToJs(pattern: string): string {
  return pattern
    .replaceAll("[[:space:]]", "\\s")
    .replaceAll("[[:digit:]]", "\\d")
    .replaceAll("[[:alpha:]]", "[A-Za-z]")
    .replaceAll("[[:alnum:]]", "[A-Za-z0-9]");
}
export const REVIEWER_CHECK = new RegExp(posixToJs(REVIEWER_CHECK_RAW), "i");

// The reviewer stamps the SHA it reviewed into its own sticky comment. That is
// a second, independent witness to the check-run: measured live, the marker
// still named the PREVIOUS commit while the aggregate checks view read settled.
export const SHA_MARKER = reviewedShaMarker();
// Which of the reviewer's comments is the sticky. The reviewer also posts
// inline comments and may post auxiliary ones; any of those quoting or carrying
// a SHA marker would otherwise override the real witness.
export const STICKY_MARKER = stickyMarker();

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
}

export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
}

function parsePages(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
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
): Promise<CheckRun[] | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  const pages = parsePages(r.stdout);
  if (pages === null) return null;
  const runs: CheckRun[] = [];
  for (const page of pages) {
    const list = (page as { check_runs?: unknown[] } | null)?.check_runs ?? [];
    for (const c of list as Array<Record<string, unknown>>) {
      runs.push({
        name: String(c.name ?? ""),
        status: String(c.status ?? ""),
        conclusion: c.conclusion === null ? null : String(c.conclusion ?? ""),
        app: String(
          ((c.app as Record<string, unknown> | null)?.slug ?? "") || "",
        ),
        title: String(
          ((c.output as Record<string, unknown> | null)?.title ?? "") || "",
        ),
        id: Number(c.id ?? 0),
        started:
          c.started_at === null ? null : String(c.started_at ?? "") || null,
      });
    }
  }
  return runs;
}

/**
 * Paginated for the same reason the check-runs query is: a commit can carry
 * more than one page of legacy status contexts, and reading only the first
 * drops the rest from the verdict entirely — a failing or pending context on
 * page 2 leaves `ci: green` and announce-merge-ready then tells a human every
 * non-reviewer check succeeded over one nobody looked at.
 *
 * A failed query stays distinguishable from an empty result (`null` vs `[]`):
 * `[]` is the "no legacy statuses, therefore clean" answer — exactly the
 * fail-open the caller's unknown-verdict branch exists to prevent.
 */
export async function commitStatusesFor(
  owner: string,
  repo: string,
  sha: string,
): Promise<CommitStatus[] | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/commits/${sha}/status?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  const pages = parsePages(r.stdout);
  if (pages === null) return null;
  const statuses: CommitStatus[] = [];
  for (const page of pages) {
    const list = (page as { statuses?: unknown[] } | null)?.statuses ?? [];
    for (const s of list as Array<Record<string, unknown>>) {
      statuses.push({
        context: String(s.context ?? ""),
        state: String(s.state ?? ""),
        description:
          s.description === null ? null : String(s.description ?? ""),
      });
    }
  }
  return statuses;
}

/**
 * Does the head carry any CI evidence besides the reviewer's own? A head
 * certified on the overall verdict alone needs it: with nothing registered
 * yet, that verdict reads green. The combined-status read carries no
 * publisher, so where a reviewer is expected a status whose context reads as
 * the reviewer's check is never counted, whoever published it: a missed
 * independent status only keeps the head waiting, where a counted reviewer
 * status would certify it. With no reviewer named, every status counts.
 */
export function hasNonReviewerCi(
  runs: readonly CheckRun[],
  statuses: readonly CommitStatus[],
): boolean {
  return (
    statuses.some(
      (status) => !reviewerExpected() || !REVIEWER_CHECK.test(status.context),
    ) || runs.some((run) => !isReviewerCheck(run))
  );
}

const appIds = new Map<string, number | null>();

/** The app slug behind a bot account's login; `""` for any other login. */
function botSlug(login: string): string {
  return login.endsWith("[bot]") ? login.slice(0, -5) : "";
}

/** The id of the GitHub App whose bot account is `login`, or `null`. */
async function appIdOfBot(login: string): Promise<number | null> {
  const slug = botSlug(login);
  if (slug === "") return null;
  const known = appIds.get(slug);
  if (known !== undefined) return known;
  const r = await ghCall(
    ["api", `apps/${encodeURIComponent(slug)}`, "-q", ".id"],
    { stderr: "ignore" },
  );
  const id = Number(r.stdout.trim());
  const appId = r.code === 0 && Number.isSafeInteger(id) && id > 0 ? id : null;
  // A failed read is not cached: it is not evidence the app does not exist.
  if (r.code === 0) appIds.set(slug, appId);
  return appId;
}

/**
 * Most bot publishers whose app is looked up for one read. Each lookup is a
 * sequential GitHub call, and `drive-state.ts set-verified`'s whole-process
 * deadline (`finalVerifyTimeoutSeconds`) counts them; more publishers than
 * this fail the read closed rather than outrun that deadline.
 */
export const MAX_STATUS_PUBLISHERS = 4;

/**
 * The newest status of each `contexts` entry from each publisher on `sha`,
 * with the GitHub App that published it, for a required check pinned to an
 * app. State and publisher come from the same status record, so a pinned
 * requirement is judged on that app's own newest status and never on another
 * publisher's state. Contexts compare case-insensitively, as GitHub's status
 * contexts do. `null` when the list cannot be read or names more than
 * `MAX_STATUS_PUBLISHERS` unresolved publishers; a status whose publisher is
 * not an app, or whose app cannot be resolved, carries `appId: null` and so
 * meets no pin.
 */
export async function statusesByPublisher(
  owner: string,
  repo: string,
  sha: string,
  contexts: readonly string[],
): Promise<(CommitStatus & { appId: number | null })[] | null> {
  const wanted = new Set(contexts.map((context) => context.toLowerCase()));
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  const pages = parsePages(r.stdout);
  if (pages === null) return null;
  const newest = new Map<
    string,
    { id: number; creator: string; status: CommitStatus }
  >();
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    for (const raw of page as Array<Record<string, unknown> | null>) {
      const context = raw?.context;
      const id = raw?.id;
      const state = raw?.state;
      if (
        typeof context !== "string" ||
        typeof id !== "number" ||
        typeof state !== "string"
      )
        return null;
      if (!wanted.has(context.toLowerCase())) continue;
      const creator = raw?.creator as Record<string, unknown> | null;
      const login =
        creator?.type === "Bot" && typeof creator.login === "string"
          ? creator.login
          : "";
      const key = `${context.toLowerCase()}\n${login}`;
      const known = newest.get(key);
      if (known === undefined || id > known.id)
        newest.set(key, {
          id,
          creator: login,
          status: {
            context,
            state,
            description:
              typeof raw?.description === "string" ? raw.description : null,
          },
        });
    }
  }
  const unresolved = new Set(
    [...newest.values()]
      .map((entry) => entry.creator)
      .filter((login) => login !== "" && !appIds.has(botSlug(login))),
  );
  if (unresolved.size > MAX_STATUS_PUBLISHERS) return null;
  // One lookup per publisher, failures included: `appIdOfBot` does not cache
  // a failed read, and one publisher may own many required contexts.
  const resolved = new Map<string, number | null>();
  for (const login of new Set(
    [...newest.values()].map((entry) => entry.creator),
  ))
    resolved.set(login, await appIdOfBot(login));
  return [...newest.values()].map((entry) => ({
    ...entry.status,
    appId: resolved.get(entry.creator) ?? null,
  }));
}

/**
 * Is this check-run the posting reviewer's own check? Never, where the
 * repository names no reviewer: a reviewer-shaped check is then an ordinary
 * check, counted in the CI verdict like any other.
 */
export function isReviewerCheck(run: CheckRun): boolean {
  if (!reviewerExpected()) return false;
  const app = reviewerApp();
  return (app === "" || run.app === app) && REVIEWER_CHECK.test(run.name);
}

/**
 * The newest run per (app, name) pair. One SHA carries MULTIPLE check-runs
 * under the same name whenever a job was re-run or a first attempt was
 * cancelled — measured on this skill's own PR, where `Parse
 * ops-followups block` had a `cancelled` attempt alongside the `success` that
 * superseded it. Reducing to the newest per name matters in both directions:
 * keeping the stale one marks CI failing forever (so announce-merge-ready
 * could never fire), and picking the wrong one for the REVIEWER would judge
 * convergence against a superseded review.
 *
 * Ordered by `id`, NOT by `started_at`. A rerun that is still QUEUED has no
 * `started_at` at all; normalising that to an empty string sorts the new
 * attempt BEFORE the completed one it supersedes, so "latest" picks the stale
 * success — which for the reviewer means declaring CONVERGED while a fresh
 * review is pending. Check-run ids are monotonic per attempt, so a rerun
 * always has the higher one whether or not it has started. (GitHub also
 * returns check-runs newest-FIRST, so trusting the API's order inverts it
 * silently — another reason the ordering is explicit.)
 *
 * Grouped by (app, name), not name alone: two GitHub Apps may publish checks
 * under the same display name, and collapsing those would let one app's newer
 * success discard the other's pending or failing verdict.
 */
export function latestPerName(runs: CheckRun[]): CheckRun[] {
  const byKey = new Map<string, CheckRun>();
  for (const run of runs) {
    const key = JSON.stringify([run.app, run.name]);
    const prev = byKey.get(key);
    if (!prev || run.id >= prev.id) byKey.set(key, run);
  }
  // Groups ordered by (app, name), matching the jq `group_by` the bash
  // implementation reduced with — the joined names in the CI verdict keep the
  // same, deterministic order.
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, run]) => run);
}

/** The reviewer's own newest matching check-run on this head, if any. */
export function reviewerRun(runs: CheckRun[]): CheckRun | null {
  const candidates = runs.filter(isReviewerCheck).sort((x, y) => x.id - y.id);
  return candidates.at(-1) ?? null;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Every non-reviewer verdict, reduced to one string — used for
 * merge-readiness, NEVER for convergence: an unrelated failing test suite is a
 * normal mid-review state and says nothing about whether the reviewer posted.
 *
 * The reviewer's own check is excluded, but NOT everything its app publishes:
 * the app can emit siblings (a coverage-telemetry check, say) — the reviewer
 * identity is (app, name), so excluding the whole app drops those siblings
 * from the verdict entirely and a pending or failing one reads as green.
 *
 * A run that is `completed` with a NULL conclusion is an indeterminate result,
 * not a pass — grouped with pending, which is the conservative bucket
 * (announce-merge-ready requires exactly `green`).
 */
export function ciVerdictOf(
  runs: CheckRun[],
  statuses: CommitStatus[] | null,
  runsUnreadable: boolean,
  head: string,
): string {
  if (runsUnreadable) {
    // An empty stand-in for an unread set is not evidence of a clean one — the
    // substitution exists only so a conflicting head can still reach
    // PR_CONFLICTING, never to manufacture a green verdict from a failed query.
    return `unknown: could not read check-runs for ${head}`;
  }
  const latest = latestPerName(runs.filter((r) => !isReviewerCheck(r)));
  const failingChecks = latest
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== null &&
        !PASSING_CONCLUSIONS.has(r.conclusion),
    )
    .map((r) => r.name)
    .join(", ");
  const pendingChecks = latest
    .filter((r) => r.status !== "completed" || r.conclusion === null)
    .map((r) => r.name)
    .join(", ");
  if (statuses === null) {
    return `unknown: could not read commit statuses for ${head}`;
  }
  const failingStatuses = statuses
    .filter((s) => s.state !== "success" && s.state !== "pending")
    .map((s) => s.context)
    .join(", ");
  // `pending` is excluded from the FAILING set, so it has to be picked up here
  // or a still-running legacy status context lands in neither bucket and the
  // verdict reads green while CI is mid-flight.
  const pendingStatuses = statuses
    .filter((s) => s.state === "pending")
    .map((s) => s.context)
    .join(", ");
  const joined = (a: string, b: string): string =>
    `${a}${a !== "" && b !== "" ? "; " : ""}${b}`;
  if (failingChecks !== "" || failingStatuses !== "") {
    return `failing: ${joined(failingChecks, failingStatuses)}`;
  }
  if (pendingChecks !== "" || pendingStatuses !== "") {
    return `pending: ${joined(pendingChecks, pendingStatuses)}`;
  }
  return "green";
}

/**
 * The failing names sourced from CHECK-RUNS only — never legacy commit
 * statuses. This is the subset `completedRequiredCi` (ci-hold.ts) actually
 * establishes freshness for: that predicate reads `CheckRunLite[]` alone and
 * has no notion of a commit status at all, so the freshness ambiguity
 * `finalCi.code === 4` encodes (a required check-run whose watermark/timing
 * could not be confirmed fresh) can only ever apply to a name in THIS array. A
 * caller deciding whether a required-named failure is merely "possibly stale" —
 * rather than a real, actionable failure — must intersect against this set, not
 * `failingNames`'s merged one: a legacy commit-status context happening to
 * share a required check's name carries no such ambiguity and is fresh evidence
 * regardless of `finalCi.code`.
 *
 * `null` mirrors `failingNames`'s own `runsUnreadable` case: the query
 * failed, so there is nothing to enumerate.
 */
export function failingCheckRunNames(
  runs: CheckRun[],
  runsUnreadable: boolean,
): string[] | null {
  if (runsUnreadable) return null;
  const latest = latestPerName(runs.filter((r) => !isReviewerCheck(r)));
  return latest
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion !== null &&
        !PASSING_CONCLUSIONS.has(r.conclusion),
    )
    .map((r) => r.name);
}

/**
 * The failing names sourced from legacy COMMIT STATUSES only — never
 * check-runs. The complement of `failingCheckRunNames`, and needed for the same
 * reason: a caller that must tell whether a required-named failure is ONLY a
 * possibly-stale check-run, or ALSO a fresh, unambiguous commit-status failure
 * sharing that name, cannot answer that from `failingNames`'s merged,
 * provenance-free output — a name-only membership test there cannot distinguish
 * "this occurrence came from the check-run list" from "this occurrence came
 * from the status list", so a required check failing in BOTH sources under one
 * name reads as wholly check-run-sourced (measured with `failingCheckNames:
 * ['Schema gate', 'Schema gate']` from one failing check-run plus one failing
 * legacy status, both named `Schema gate`;
 * `failingCheckRunNames.includes('Schema gate')` was true, so EVERY merged
 * entry — including the status-sourced one — satisfied `drive.ts`'s
 * `staleRequiredFailure` predicate, which then deferred a fresh, actionable
 * legacy-status failure to the witness wait instead of dispatching CI repair).
 *
 * `null` mirrors `failingNames`'s own `statuses === null` case: the query
 * failed, so there is nothing to enumerate.
 */
export function failingStatusNames(
  statuses: CommitStatus[] | null,
): string[] | null {
  if (statuses === null) return null;
  return statuses
    .filter((s) => s.state !== "success" && s.state !== "pending")
    .map((s) => s.context);
}

/**
 * The individual failing check-run and commit-status names, unparsed — the
 * structured counterpart to `ciVerdictOf`'s rendered string. A caller that
 * needs to test one of these names for exact membership (the required checks,
 * say) must use this rather than re-splitting `ciVerdictOf`'s output on
 * `,`/`;`: a name that itself contains either delimiter cannot round-trip
 * through that split — e.g. a non-required check literally named `Schema gate,
 * shard 1` would split into `['Schema gate', 'shard 1']` and falsely satisfy an
 * exact-match check against the required `Schema gate`.
 *
 * This MERGES check-run and commit-status names, and deliberately carries no
 * provenance of which source a given name came from — a caller that needs to
 * know that (the staleness exemption in drive.ts) reads
 * `failingCheckRunNames` and `failingStatusNames` instead, never this
 * one.
 *
 * Mirrors `ciVerdictOf`'s own filtering predicates — keep the two in sync.
 * `null` mirrors its two `unknown:` cases: the query failed, so there is
 * nothing to enumerate.
 */
export function failingNames(
  runs: CheckRun[],
  statuses: CommitStatus[] | null,
  runsUnreadable: boolean,
): string[] | null {
  if (runsUnreadable || statuses === null) return null;
  const failingChecks = failingCheckRunNames(runs, runsUnreadable) ?? [];
  const failingStatuses = failingStatusNames(statuses) ?? [];
  return [...failingChecks, ...failingStatuses];
}

/**
 * The reviewer's own record of what it reviewed, read from the newest STICKY
 * comment it posted. Restricted to comments carrying the sticky marker: the
 * reviewer posts inline comments and can post auxiliary ones, and any of those
 * quoting or carrying a marker would otherwise override the real witness.
 *
 * Returns the marker SHA ('' when the reviewer has posted no sticky), or
 * `null` when the query itself failed. The distinction is the whole point of
 * the second witness. Collapsing a failed request into "no marker exists"
 * makes the caller fall back to the check-run — which is queried BY the head
 * and therefore always agrees — so a timeout or a 403 would let a stale sticky
 * marker slip past the one check that catches it.
 */
export async function reviewedShaFromComments(
  owner: string,
  repo: string,
  pr: string,
): Promise<string | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  const pages = parsePages(r.stdout);
  if (pages === null) return null;
  const markerRe = new RegExp(
    `<!--\\s*${SHA_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
    "g",
  );
  // The SHA is extracted per comment IN ORDER, and the last match anywhere
  // wins — "the newest comment's marker", never "a marker in an older body
  // that happened to sit on a later line".
  let last = "";
  for (const page of pages) {
    const comments = Array.isArray(page) ? page : [];
    for (const c of comments as Array<Record<string, unknown>>) {
      const login = String(
        ((c.user as Record<string, unknown> | null)?.login ?? "") || "",
      );
      const body = String(c.body ?? "");
      if (!isReviewerLogin(login)) continue;
      if (!body.includes(STICKY_MARKER)) continue;
      for (const m of body.matchAll(markerRe)) last = m[1] ?? "";
    }
  }
  return last;
}

export interface ReviewerSticky {
  /** The `ai-reviewed-sha` marker from the newest STICKY comment, or `''`
   * when the reviewer has posted no sticky. */
  sha: string;
  /** The `ai-review-round` marker from that SAME comment, or `null` when the
   * sticky carries no round marker. */
  round: number | null;
  /**
   * That SAME comment's own `updated_at`, or `''` when there is no sticky.
   *
   * The reviewer edits its one sticky in place each round rather than posting a
   * new one, so this is when the marker content above was last written — the
   * only readable proxy for "when did this evidence come into being". The
   * stranded-check-run bypass needs precisely that: the check-run's own
   * `started_at` says when the RUN began, which is a different quantity and
   * cannot distinguish a sticky written moments ago mid-run from one written by
   * an earlier, already-completed run on the same head.
   */
  updatedAt: string;
}

/**
 * The reviewer's SHA, round and last-updated markers read TOGETHER off the same
 * newest STICKY comment `reviewedShaFromComments` reads — added for the
 * stranded-check-run bypass, which needs every field off the SAME comment:
 * pairing a fresh round from one comment with a stale SHA from another would
 * misreport what the reviewer actually witnessed. The fields are therefore
 * assigned TOGETHER, from the same matching comment, never independently — a
 * comment carrying no SHA marker updates none of them, so a later sticky-marked
 * reply with no `ai-reviewed-sha` (an auxiliary comment, say) cannot pair its
 * own round against an EARLIER comment's SHA. `updatedAt` joins that same
 * assignment for the same reason: a timestamp taken off a different comment
 * than the SHA would date evidence that comment never carried.
 *
 * The SHA extraction mirrors `reviewedShaFromComments`'s own regex and
 * last-match-wins semantics exactly (matchAll, not `.match`), rather than
 * importing `summary-findings.ts`'s `reviewedShaFrom` (first-match-wins) — two
 * functions in this file must not disagree with each other about which marker
 * occurrence wins within one body, even though a body carries at most one in
 * practice today. `parseReviewRound` IS imported: unlike the SHA regex, this
 * file has no round-parsing precedent of its own to stay consistent with, so
 * reusing `summary-findings.ts`'s parser avoids re-deriving that grammar a
 * second time (parse with one parser, or pin the shape — never a second
 * hand-rolled recognizer).
 *
 * `null` when the query itself failed — fail closed, same distinction
 * `reviewedShaFromComments` makes. `{ sha: '', round: null, updatedAt: '' }`
 * is the "no sticky posted yet" case, not a failed read.
 */
export async function reviewerStickyMarkers(
  owner: string,
  repo: string,
  pr: string,
): Promise<ReviewerSticky | null> {
  const r = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return null;
  const pages = parsePages(r.stdout);
  if (pages === null) return null;
  const markerRe = new RegExp(
    `<!--\\s*${SHA_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([0-9a-f]{7,40})\\s*-->`,
    "g",
  );
  let sha = "";
  let round: number | null = null;
  let updatedAt = "";
  for (const page of pages) {
    const comments = Array.isArray(page) ? page : [];
    for (const c of comments as Array<Record<string, unknown>>) {
      const login = String(
        ((c.user as Record<string, unknown> | null)?.login ?? "") || "",
      );
      const body = String(c.body ?? "");
      if (!isReviewerLogin(login)) continue;
      if (!body.includes(STICKY_MARKER)) continue;
      let bodySha = "";
      for (const m of body.matchAll(markerRe)) bodySha = m[1] ?? "";
      if (bodySha === "") continue;
      sha = bodySha;
      round = parseReviewRound(body);
      // Absent/malformed reads as `''`, never as "now" — a caller flooring on
      // this must fail closed on an undatable sticky rather than treat it as
      // freshly written.
      updatedAt = String(c.updated_at ?? "");
    }
  }
  return { sha, round, updatedAt };
}

export interface UnresolvedThread {
  threadId: string;
  [extra: string]: unknown;
}

/**
 * The thread enumerator — `list-unresolved-threads.ts` from
 * /resolve-review-comments, the one canonical implementation — bounded by the
 * helper deadline like every other network reach. `null` on any failure.
 */
export async function unresolvedThreads(
  listScript: string,
  pr: string,
  botsOnly: boolean,
  timeoutSec: number,
): Promise<UnresolvedThread[] | null> {
  // `--no-alerts`: the status reads threads, never their code scanning
  // alerts, so it spends no alert read per poll.
  const args = [pr, "--no-alerts", ...(botsOnly ? ["--bots-only"] : [])];
  const r = await run(tsArgv(listScript, args), {
    timeoutSec,
    stderr: "ignore",
  });
  if (r.code !== 0) return null;
  const threads: UnresolvedThread[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      // Shape-checked, not merely parsed. `JSON.parse` hands back `any`, so a
      // line that is valid JSON but not a thread — `null`, `5`, `"x"` — became
      // a COUNTED thread, and evaluate.ts derives threadsOpen/liveThreads from
      // this length: a stray line changed the convergence verdict instead of
      // failing the read. summaryFindings
      // below already shape-checks its payload.
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { threadId?: unknown }).threadId !== "string"
      )
        return null;
      threads.push(parsed as UnresolvedThread);
    } catch {
      return null;
    }
  }
  return threads;
}

export interface SummaryReportLite {
  total: number;
  // `path` feeds `structuralEscalationDue` alongside `fingerprint` — a
  // summary-only finding creates no thread, so the recurrence signal needs its
  // own anchor file just as much as a thread's does. Shape-checked below on the
  // same "checked, not merely parsed" basis `listUnresolvedThreads` above
  // states for its own payload.
  unaddressed: Array<{ fingerprint: string; path: string }>;
}

/**
 * The summary-finding enumerator, same deadline. `null` on any failure.
 * `--configured-reviewer-only`: where no AI reviewer is named, the drive reads
 * no reviewer sticky, matching the gate taking no reviewer evidence.
 */
export async function summaryFindings(
  summaryScript: string,
  pr: string,
  timeoutSec: number,
): Promise<SummaryReportLite | null> {
  const r = await run(
    tsArgv(summaryScript, [pr, "--json", "--configured-reviewer-only"]),
    {
      timeoutSec,
      stderr: "ignore",
    },
  );
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as SummaryReportLite;
    if (typeof parsed.total !== "number" || !Array.isArray(parsed.unaddressed))
      return null;
    if (
      parsed.unaddressed.some(
        (f) =>
          typeof (f as { fingerprint?: unknown }).fingerprint !== "string" ||
          typeof (f as { path?: unknown }).path !== "string",
      )
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * `statuses`, plus each publisher's own newest status for every `pinned`
 * context, so a pinned requirement can be met by a status its app
 * published. The combined statuses carry no `appId` and so meet no pin. No
 * read when nothing pinned has a status; `null` when the publishers cannot
 * be read.
 */
export async function attributeStatuses(
  owner: string,
  repo: string,
  sha: string,
  statuses: readonly CommitStatus[],
  pinned: readonly string[],
): Promise<(CommitStatus & { appId?: number | null })[] | null> {
  const contexts = [...new Set(pinned)].filter((context) =>
    statuses.some((status) => sameContext(status.context, context)),
  );
  if (contexts.length === 0) return [...statuses];
  const published = await statusesByPublisher(owner, repo, sha, contexts);
  if (published === null) return null;
  return [...statuses, ...published];
}

/** Status contexts are case-insensitive on GitHub. */
export function sameContext(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
