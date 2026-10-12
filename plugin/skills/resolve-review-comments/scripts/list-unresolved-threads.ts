#!/usr/bin/env bun
/**
 * List UNRESOLVED review threads on a PR as NDJSON — one thread per line.
 *
 * Each line: { threadId, confirmedHumanStarted, path, line, startLine,
 *               diffSide, startDiffSide, isResolved, isOutdated, url,
 *               commentsTruncated, comments:[{author,authorAssociation,body,url}] }
 *   - confirmedHumanStarted → whether the thread's OPENING comment is
 *     CONFIRMED human-authored (`__typename === 'User'`). Independent of
 *     `--bots-only`, which only decides INCLUSION in this stream — a
 *     consumer enforcing a policy scoped to human-started threads
 *     (`--leave-open`'s marker exemption) needs this per-thread, not the
 *     stream-level filter. Deliberately NOT the inverse of "bot-started": fails
 *     CLOSED toward `false` on an absent comment, a `null` author, or a
 *     missing/malformed `__typename` alike, so an unreadable opening comment is
 *     never read as "confirmed human" (a first cut computed this as
 *     `__typename !== 'Bot'`, which resolves every one of those unreadable
 *     shapes to `true`). Never redacted, even under `--include-resolved`'s
 *     `historyOnly` mode: it names WHO opened the thread, not a reply-capable
 *     handle.
 *   - startLine → the first line of a MULTI-line comment's range, `null` for
 *     a single-line one (GitHub's own convention: populated only when it
 *     differs from `line`). `line` alone names only the range's endpoint.
 *   - diffSide → GitHub's own `LEFT`/`RIGHT` (or `null` for a thread with no
 *     diff anchor, e.g. a PR-level comment). `line`/`startLine` on a `LEFT`
 *     thread number the PRE-image (the base side of the hunk), not HEAD — a
 *     consumer that blames those numbers against HEAD regardless (drive-pr's
 *     self-inflicted.ts) would blame unrelated current content and could
 *     confidently mislabel it `true`/`false` instead of `null`. Distinct
 *     from `isOutdated`, which only flags a hunk invalidated by a LATER push —
 *     a same-push LEFT-side anchor is not outdated at all.
 *   - startDiffSide → the side of `startLine`, which GitHub allows to differ
 *     from `diffSide` (the side of `line`, the range's END) on a multi-line
 *     comment whose range straddles a hunk boundary. `diffSide` alone
 *     describes only the endpoint, so a consumer blaming the full
 *     `startLine..line` span against HEAD on `diffSide === 'RIGHT'` alone
 *     would blame LEFT-numbered lines in that span against the wrong content.
 *   - isResolved → always false in the default stream (unresolved-only); the
 *     field is meaningful only under --include-resolved, below.
 *   - comments[].url → the INDIVIDUAL comment's permalink, distinct from the
 *     top-level `url` (always the thread's first comment). A consumer that
 *     re-holds based on "the last qualifying reply" (drive-pr's
 *     reconcile-replied-threads.ts) needs to tell "the SAME reply I saw last
 *     time" from "a newer one that happens to share the same outcome word" —
 *     the comment url is the cheap, already-fetched identifier for that,
 *     since GraphQL returns it per comment node regardless.
 *   - threadId → GraphQL node id; the SINGLE key for BOTH reply-to-thread.ts and
 *     resolve-thread.ts (per `/groundwork:resolve-review-comments` § Human threads)
 *   - comments → the thread's replies (finding + any back-and-forth) for the
 *     address/reject call. Capped at 100 and NOT paginated, so a very long
 *     thread can omit its most recent replies — including an outcome already
 *     posted. `commentsTruncated` is true exactly then; do not act automatically
 *     on a truncated thread, because the reply you would be responding to may
 *     not be the last one.
 *   - authorAssociation → GitHub's own "who is this relative to the repo"
 *     verdict (OWNER/MEMBER/COLLABORATOR/…), computed server-side and not
 *     spoofable by comment content. A thread is world-commentable, so a
 *     consumer trusting a comment as evidence of prior triage (e.g. drive-pr's
 *     crash-recovery guard, SKILL.md § 3) must check this before trusting the
 *     comment — mirrors `summary-findings.ts`'s `TRUSTED_ASSOCIATIONS` gate on
 *     the same class of world-writable marker.
 *
 * Usage: bun list-unresolved-threads.ts [PR_NUMBER] [--bots-only] [--include-resolved]
 *   PR_NUMBER   defaults to the PR for the current branch.
 *   --bots-only keeps only threads STARTED by a bot (any GitHub App — CodeRabbit,
 *               Codex, Greptile, a github-actions[bot] shadow reviewer all have
 *               author __typename "Bot"; humans are "User"). Use this for the
 *               `--bots-only` continuous-mode stop condition so intentionally-open
 *               human threads (see SKILL Human threads) don't stop it converging.
 *   --include-resolved also emits RESOLVED threads, each line carrying
 *               `isResolved`. Combined with --bots-only (or RRC_BOTS_ONLY), a
 *               HUMAN thread — resolved or not — is emitted as read-only
 *               history with `threadId: null`, both `url` fields nulled, and
 *               `redacted: true` — its outcome must be visible to the
 *               reversal check, but nothing in the record may be postable
 *               with (a comment permalink carries the REST reply id). An
 *               open human thread is history too: a human may deliberately
 *               leave an acted-on thread open, and its outcome still counts.
 *               This is the only durable record of a prior round's
 *               outcome: the drive-pr held batch is cleared the moment a thread
 *               resolves, so once a round finishes, its `**accepted**` reply
 *               survives on the resolved thread and nowhere else. The
 *               contradictory-findings reversal check (triage rubric) reads it
 *               from here before triaging a finding that would reverse one.
 *               NEVER pass it on a counting path — `await-round.ts` /
 *               `converge.ts` measure open work by line count, and a resolved
 *               thread in that stream reads as work that never clears.
 *
 * Environment (set by converge.ts; both narrow, never widen):
 *   RRC_TARGET_PR  the PR the run is about. Refuses (exit 2) when the PR
 *                  resolved here is a different one — see the guard below.
 *   RRC_BOTS_ONLY  non-empty forces --bots-only on, whatever argv says.
 *
 * Count still-open threads:
 *   bun list-unresolved-threads.ts --bots-only | wc -l
 *
 * Single-shot query, NOT a poller. The loop stop condition lives in
 * await-round.ts, which also distinguishes "zero threads" from "reviewer has not
 * posted yet" — a raw count from this script cannot tell those apart.
 */

import { isEntryPoint, runMain } from "./lib/cli.ts";
import { ghOrExit, repoViewOrExit } from "./lib/gh.ts";

interface ThreadCommentNode {
  url?: string;
  author?: { login?: string; __typename?: string } | null;
  authorAssociation?: string;
  body?: string;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  // The first line of a MULTI-line comment's range; `null` for a single-line
  // one (GitHub's own convention — `startLine` is populated only when it
  // differs from `line`). Consumers that blame `line` alone to decide who
  // wrote it (drive-pr's self-inflicted.ts) would otherwise judge only the
  // range's endpoint and miss PR-authored lines earlier in the same comment.
  startLine: number | null;
  // `LEFT` | `RIGHT` | `null` (a PR-level comment, or a resolved thread
  // GitHub no longer anchors to a diff side). See the header.
  diffSide: string | null;
  // The side of `startLine`, independently of `diffSide` (the side of the
  // range's END, `line`). GitHub lets these differ on a multi-line comment
  // whose range straddles a hunk boundary, so a LEFT-to-RIGHT range is not
  // fully described by `diffSide` alone — a consumer that blames the whole
  // `startLine..line` span against HEAD using only `diffSide` would blame the
  // LEFT-numbered lines against the wrong content.
  startDiffSide: string | null;
  comments: {
    pageInfo: { hasNextPage: boolean };
    nodes: ThreadCommentNode[];
  };
}

/**
 * Strip review-comment ids out of a redacted record's prose. `#discussion_r123`
 * is a REST reply handle, so it must not survive in a stream whose whole point
 * is that nothing in it can be posted with.
 */
const redactReplyIds = (body: string | null | undefined): string | null =>
  body == null
    ? null
    : body.replace(/#discussion_r\d+/g, "#discussion_r[redacted]");

const gh = (
  args: string[],
  opts?: { deadlineFactor?: number },
): Promise<string> => ghOrExit("list-unresolved-threads", args, opts);

// Gated behind isEntryPoint rather than run at module scope, like every
// other script in this family: importing this module used to spawn `gh` and
// print a PR's threads as a side effect of the import alone (first seen in
// unresolve-thread.ts, true of all three).
async function main(): Promise<number> {
  let pr = "";
  let botsOnly = false;
  let includeResolved = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--bots-only") botsOnly = true;
    else if (a === "--include-resolved") includeResolved = true;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      return 2;
    } else pr = a;
  }
  if (pr === "")
    pr = (await gh(["pr", "view", "--json", "number", "-q", ".number"])).trim();

  // $RRC_TARGET_PR and $RRC_BOTS_ONLY are converge.ts's out-of-band statement of
  // which PR the run is about and whether the pass is scoped to bot threads.
  // This script is the chokepoint that makes both assertions rather than
  // inferences: a threadId is obtainable nowhere else, and reply-to-thread.ts
  // and resolve-thread.ts both require one, so a pass that cannot enumerate a
  // PR cannot touch it either.
  //
  // converge.ts's own argv tests cannot decide either question — they inspect an
  // opaque pass command, where `codex exec "/resolve-review-comments 999"
  // --label 123` satisfies the delimited-token test for 123 while targeting 999,
  // and `... do not use --bots-only` satisfies the scope test while asking for
  // the opposite. A dedicated non-prompt
  // channel sidesteps that, exactly as $DRIVE_PR_TARGET does for drive-pr.
  const target = process.env.RRC_TARGET_PR ?? "";
  if (target !== "" && target !== pr) {
    console.error(
      `list-unresolved-threads: the run is working PR #${target}, but this pass resolved PR #${pr}.`,
    );
    console.error(
      "Enumerating here would hand the pass thread ids on a different pull request.",
    );
    return 2;
  }
  // Widening the scope the run is counting is what lets a pass resolve human
  // threads await-round.ts deliberately excluded, so the env var only ever
  // narrows: it turns the filter ON and can never turn an explicit --bots-only
  // off.
  if ((process.env.RRC_BOTS_ONLY ?? "") !== "") botsOnly = true;
  // `gh -F` gives a leading `@` file-reference semantics — `-F pr=@some/path`
  // makes gh READ that file and send its contents as the value. `pr` reaches the
  // `-F` below, so it is constrained to what a PR number can be before it gets
  // there rather than after. `resolve-thread.ts`
  // passes its id through `-f`, which is literal, so it needs no counterpart.
  if (!/^[0-9]+$/.test(pr)) {
    console.error(`list-unresolved-threads: PR must be a number (got '${pr}')`);
    return 2;
  }

  const repoLine = (
    await repoViewOrExit("list-unresolved-threads", [
      "--json",
      "owner,name",
      "-q",
      '.owner.login + " " + .name',
    ])
  ).trim();
  const [owner, repo] = repoLine.split(" ");

  // gh auto-paginates a GraphQL query that declares $endCursor + returns pageInfo;
  // `--slurp` collects the per-page documents into one JSON array, so no manual
  // cursor loop is needed and no concatenated-document parsing either. The
  // thread's FIRST comment author decides bot-vs-human (that's who opened it).
  const pagesRaw = await gh(
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `owner=${owner}`,
      "-f",
      `repo=${repo}`,
      "-F",
      `pr=${pr}`,
      "-f",
      `query=
  query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String){
    repository(owner:$owner, name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:100, after:$endCursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id isResolved isOutdated path line startLine diffSide startDiffSide
            comments(first:100){ pageInfo{ hasNextPage } nodes{ url author{ login __typename } authorAssociation body } }
          }
        }
      }
    }
  }`,
    ],
    // The one paginating call here: N requests inside one `gh` process, so it
    // gets N requests' worth of deadline rather than one's.
    { deadlineFactor: 4 },
  );

  let pages: unknown;
  try {
    pages = JSON.parse(pagesRaw);
  } catch {
    console.error("list-unresolved-threads: gh returned unparsable JSON");
    return 1;
  }
  const pageList = Array.isArray(pages) ? pages : [pages];
  for (const page of pageList) {
    const shaped = page as {
      data?: {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: ThreadNode[] } } | null;
        } | null;
      };
    };
    // A PR that does not exist in the RESOLVED repository is not "a PR with no
    // open threads". GraphQL answers a bad number — or a good number against a
    // repository `$GH_REPO` / `gh repo set-default` pointed somewhere else —
    // with a valid response carrying `pullRequest: null`, and the optional
    // chain turned that into an empty thread list and exit 0.
    //
    // Zero threads is the CONVERGENCE signal for everything downstream — the
    // `--bots-only` stop condition, drive-status's thread count — so silently
    // emitting it for a PR nobody could read is the single worst answer this
    // script can give: it reports a finished review of a pull request it never
    // looked at. Refuse loudly instead.
    if (shaped?.data?.repository == null) {
      console.error(
        `list-unresolved-threads: repository ${owner}/${repo} could not be read — refusing to report zero threads`,
      );
      return 1;
    }
    if (shaped.data.repository.pullRequest == null) {
      console.error(
        `list-unresolved-threads: PR #${pr} does not exist in ${owner}/${repo} — refusing to report zero threads.`,
      );
      console.error(
        "Check the number, and check that $GH_REPO / `gh repo set-default` agree with",
        "the repository the PR actually lives in.",
      );
      return 1;
    }
    const nodes: ThreadNode[] =
      shaped.data.repository.pullRequest.reviewThreads?.nodes ?? [];
    for (const t of nodes) {
      // Default stream is unresolved-only — every counting consumer depends on
      // that. `--include-resolved` widens it for the reversal check, which
      // needs the prior round's outcome reply and can find it nowhere else.
      // Fail CLOSED on a non-boolean `isResolved`: only an explicit `false`
      // means open, so a malformed node can never inflate the open-work count.
      if (!includeResolved && t.isResolved !== false) continue;
      const startedByBot = t.comments.nodes[0]?.author?.__typename === "Bot";
      // Deliberately NOT the same expression as `startedByBot` above: that
      // boolean is `=== 'Bot'`, which quietly resolves an ABSENT comment, a
      // `null` author, or a missing/malformed `__typename` to `false` — read
      // by a consumer as "confirmed human" when it is actually "cannot tell".
      // `--bots-only`'s own inclusion decision (`historyOnly` below) wants
      // exactly that lenient direction — treat "cannot tell" as possibly
      // human, so an ambiguous thread is excluded from an actionable
      // bots-only stream rather than risk exposing a real human thread to
      // one. A consumer gating a HUMAN-only privilege (`--leave-open`'s
      // marker exemption, `isThreadTriaged`/`isLeftOpenThread`) needs the
      // opposite direction: fail closed toward NOT granting it, i.e. require
      // explicit confirmation of a `'User'` typename, treating anything else
      // — bot, absent, malformed — as "not confirmed human" (an input that
      // cannot be read never counts as a pass). One boolean cannot fail closed
      // for both consumers at once, so this is a second, independent field,
      // never a rename of the first.
      const confirmedHumanStarted =
        t.comments.nodes[0]?.author?.__typename === "User";
      // `--bots-only` exists so a pass is never handed an ACTIONABLE human
      // thread id. A RESOLVED thread is not actionable work — it is history —
      // and dropping it here silently blinded the reversal check to exactly
      // the case it matters most for: a bot finding reversing an accepted
      // HUMAN outcome, under the continuous `--bots-only` flow where
      // converge.ts exports RRC_BOTS_ONLY=1. So a resolved human thread passes
      // through as read-only history, with every reply-capable handle REDACTED:
      // the reversal check needs the outcome text and the construct (path,
      // line, bodies, authorAssociation), never anything it could post with.
      // That means the GraphQL id AND both `url` fields — a comment permalink
      // carries the numeric review-comment id in its `#discussion_r…` fragment,
      // which the REST replies endpoint accepts, so nulling the id alone left
      // the record actionable. Under --include-resolved a human thread is
      // history whatever its resolved state: a human may deliberately leave an
      // acted-on thread open (SKILL "Human threads"), and that thread can carry
      // the prior trusted outcome the reversal check needs — dropping it let a
      // bot finding reverse a human decision undetected. It is safe precisely
      // because `historyOnly` redacts every reply-capable handle below, so
      // nothing about it is actionable either way.
      const historyOnly = botsOnly && !startedByBot;
      if (historyOnly && !includeResolved) continue;
      process.stdout.write(
        `${JSON.stringify({
          threadId: historyOnly ? null : t.id,
          redacted: historyOnly || undefined,
          // Whether the OPENING comment (never redacted; not a reply-capable
          // handle) is CONFIRMED human-authored (`__typename === 'User'`) —
          // a consumer deciding whether a policy scoped to human-started
          // threads (e.g. `--leave-open`'s marker exemption) legitimately
          // applies needs this independent of `--bots-only`'s own filtering,
          // which only decides stream INCLUSION. Deliberately fail-closed
          // toward `false` — an absent comment, a `null` author, or a
          // missing/malformed `__typename` all read as "not confirmed human",
          // never as bot-started's own lenient inverse (see
          // `confirmedHumanStarted`'s own definition above).
          confirmedHumanStarted,
          path: t.path,
          line: t.line,
          startLine: t.startLine,
          diffSide: t.diffSide,
          startDiffSide: t.startDiffSide,
          isResolved: t.isResolved !== false,
          isOutdated: t.isOutdated,
          url: historyOnly ? null : (t.comments.nodes[0]?.url ?? null),
          commentsTruncated: t.comments.pageInfo.hasNextPage,
          comments: t.comments.nodes.map((c) => ({
            author: c.author?.login ?? null,
            authorAssociation: c.authorAssociation ?? null,
            // A BODY can carry a reply-capable id too: cross-linking a review
            // comment embeds `#discussion_r<id>`, which the REST replies
            // endpoint accepts, so nulling the url fields alone still left a
            // usable handle in the text. Scrub the id and keep the sentence
            // readable — the reversal check reads prose, never permalinks.
            body: historyOnly ? redactReplyIds(c.body) : (c.body ?? null),
            url: historyOnly ? null : (c.url ?? null),
          })),
        })}\n`,
      );
    }
  }
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("list-unresolved-threads", main);
