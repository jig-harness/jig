#!/usr/bin/env bun
/**
 * defect-escape.ts — did anything we DECLINED to fix come back?
 *
 * an earlier change proposes cutting review recall: a materiality bar that declines more
 * findings, a wind-down that stops re-admitting polish, round-indexed cutoffs.
 * Every one of those trades recall for rounds, and the trade is only safe if
 * declined findings mostly do NOT come back as defects. Nobody has measured
 * that, so this script produces the sample it would be measured over.
 *
 * The population is `wont-fix` and `deferred` — the outcomes that assert
 * "this finding is REAL and we shipped anyway". `rejected` is deliberately
 * excluded: it asserts the finding was wrong, so there was never anything to
 * escape, and folding it in would inflate the denominator with findings whose
 * non-recurrence proves nothing.
 *
 * Usage:
 *   defect-escape.ts --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--limit N]
 *                    [--ladder-only] [--json]
 *
 *   --since  merged-on-or-after date. One week is enough for a baseline.
 *   --until  merged-on-or-before date. Omit for "up to now", which is right for
 *            a fresh measurement and WRONG for reproducing a recorded one — see
 *            below.
 *   --limit  cap on merged PRs sampled (default 40). Reported when it binds.
 *   --ladder-only
 *            narrow the population to declines carrying the ESCALATING DECLINE
 *            LADDER's public reply marker — the monthly calibration
 *            read behind `.config/review-triage.yaml` § calibration. Matched on
 *            that config's own `reply.marker`, read from the file rather than
 *            hardcoded here, so the two can never disagree about what a ladder
 *            decline looks like. Fails CLOSED: a config it cannot read or a
 *            marker it cannot resolve is exit 1, never an empty sample — a
 *            silent fallback would report "no escapes" about a filter that
 *            never ran (a filter that cannot run fails closed).
 *            The count of declines it excluded is reported, so the narrowed
 *            population is never mistaken for the whole one.
 *
 *            SCOPE OF THE VERDICT: the marker is
 *            PUBLIC text in a GitHub reply body, so a match proves the reply
 *            ENDS WITH the marker — not that `triage-ladder.ts` generated it.
 *            A hand-written `**wont-fix** — ordinary rubric decline.` closing
 *            with the same line is indistinguishable to any recognizer that
 *            can only see the reply, and moving the marker to some richer
 *            string moves the decoy rather than removing it (the
 *            execution-classification residual no recognizer closes). What bounds the
 *            cost is that this narrows a CALIBRATION sample, not a gate —
 *            nothing merges, blocks, or declines on it — and that every run
 *            reports how many admitted declines ALSO carry the macro's own
 *            rendered prose. That ratio is diagnostic evidence, not a bound in
 *            EITHER direction: a hand-written
 *            decline that copies the clause verbatim counts as macro-shaped
 *            too (overcounting), while a genuine macro reply from a config
 *            version whose wording has since moved on does not match
 *            (undercounting). It is reported and never filtered on, both
 *            because it cannot license a bound and because filtering on the
 *            templates' prose orphans replies posted under an older wording
 *            (`review-triage.yaml` § `reply.marker`).
 *            The bias is NOT self-limiting: a copied marker inflates the
 *            escape rate's denominator, making escapes look RARER, and a low
 *            escape rate is what `review-loop-baseline.md` § What this
 *            licenses reads as evidence FOR declining more. Pollution
 *            therefore pushes toward TIGHTENING. The owner of the truth
 *            question is the monthly human read named in
 *            `.config/review-triage.yaml` § calibration; the fix if a series
 *            ever does drift is a provenance log outside the forgeable reply
 *            body.
 *   --json   the full sample, for a report or a spreadsheet. With
 *            --ladder-only, `ladder` also carries a `disclosure` object
 *            stating the same scope/bias/owner caveat the text render
 *            prints — the monthly calibration read (above) runs exactly
 *            `--ladder-only --json`, so the caveat has to survive into this
 *            branch too, not just the human-readable one.
 *
 * ── Why the window needs both ends ─────────────────────────────────────────
 *
 * `review-loop-baseline.md` promises the recorded window can be re-measured
 * retroactively, and every dial is meant to be judged against it
 * like-for-like. A one-sided `merged:>=` cannot do that: it grows with the
 * repository. Measured — the documented 2026-08-06 → 2026-08-13 week is 43
 * merged PRs, and the same one-sided query re-run a day later returned 47, then
 * 50. Past `--limit` it is worse than imprecise: `gh pr list` returns the
 * NEWEST matches, so the original PRs get evicted from their own baseline
 * entirely. `merged:<since>..<until>` reproduces the 43 exactly.
 *
 * ── What it decides, and what it does NOT ──────────────────────────────────
 *
 * "Did this become a bug" is a judgment, and this script does not make it. What
 * it does is the mechanical half a human should never have to do by hand:
 * collect every declined finding in the window, and attach the signals that
 * would make one worth a second look —
 *
 *   RE-FOUND   an `accepted` thread anchored within `PROXIMITY_LINES` of the
 *              decline and RAISED AFTER the decline was settled. The strongest
 *              available signal: a reviewer raised it again at the same place
 *              and that time somebody fixed it.
 *   CONCURRENT proximate, and raised at or before the decline was settled — so
 *              it cannot be that decline coming back. Reported, NOT counted.
 *              Requires BOTH timestamps: a candidate whose ordering cannot be
 *              read is reported separately as unknown-ordering rather than
 *              asserted to be concurrent, which is a claim a missing timestamp
 *              does not support.
 *   SAME FILE  a later `accepted` thread on the same file but nowhere near the
 *              anchor. Reported and NOT counted as an escape — plain same-file
 *              matching calls a large fraction of declines re-found, almost all
 *              of it coincidence on a hot file, and a metric that inflates the
 *              escape rate would push the dials in a direction the
 *              evidence does not support. The measured figures live in
 *              `review-loop-baseline.md` and are deliberately NOT restated here:
 *              this script is the instrument, and an instrument carrying its own
 *              stale readings is how the corrected result acquires a second,
 *              contradictory home.
 *   FOLLOW-UP  an issue key of the consumer's team (`issue_tracker.team`)
 *              anywhere in the decline's FULL settling reply — not
 *              just its first line, since the deferral protocol permits the
 *              issue link to sit further down (`ThreadSample.settledBody`).
 *              `deferred` is only a legitimate outcome when a follow-up issue
 *              exists, so a deferral naming no issue id is itself a finding.
 *   TOUCHED    the anchored file changed after the merge, and at least one of
 *              those commits is a `fix`. Weak on its own — files change for
 *              every reason — so it is reported, never counted.
 *
 * The first two axes — proximity and ordering — are `lib/escape.ts`, which owns
 * why merge order alone cannot decide a recurrence. Read it there rather than
 * here; a second copy of that rule is a copy that drifts.
 *
 * A verdict per finding stays the human's, recorded in the baseline doc
 * (`drive.escape_baseline_doc`, see `lib/escape-baseline.ts`). Automating it would
 * produce a number with the authority of a measurement and the content of a
 * guess, on the one question the whole recall trade rests on.
 *
 * Exit codes:
 *   0  sample printed (including an empty one — no declines in the window is a
 *      real, reportable answer)
 *   1  the PR list or a PR could not be read
 *   2  usage error
 */

import { teamKeyOrNull } from "../../do-item/scripts/lib/tracker/config.ts";
import { fail, isEntryPoint, runMain } from "./lib/cli.ts";
import {
  anchorLine,
  declinedAtOf,
  isRecurrence,
  PROXIMITY_LINES,
  type Refind,
  refindsFor,
  supersededCandidateInOwnPr,
} from "./lib/escape.ts";
import { baselineDocPath } from "./lib/escape-baseline.ts";
import { DECLINED_OUTCOMES, type Outcome } from "./lib/outcome.ts";
import { ghCall, git, gitIdentityEnv } from "./lib/proc.ts";
import {
  type PrSample,
  resolveRepo,
  samplePr,
  type ThreadSample,
} from "./lib/sample.ts";

export interface Decline {
  pr: number;
  prTitle: string;
  mergedAt: string;
  outcome: Outcome;
  path: string | null;
  line: number | null;
  reason: string;
  /** The declined finding's own `🏷️ category:` tag, or `unknown` — see `ThreadSample.category`. */
  category: string;
  url: string | null;
  startedBy: string | null;
  /**
   * The moment this decline was decided — the anchor every recurrence must be
   * later than. `null` only when GitHub gave no timestamp at all, which makes
   * every candidate uncountable.
   */
  declinedAt: string | null;
  /**
   * An `accepted` thread in this decline's OWN PR looks like it could be the
   * same finding re-raised and fixed before merge. A signal for a human, not a
   * reason to drop the decline — see `supersededCandidateInOwnPr`.
   */
  supersededCandidate: boolean;
  /** `accepted` threads on the same path in a LATER-merged PR in the window. */
  refoundIn: Refind[];
  /** Issue keys anywhere in the decline's full settling reply. */
  followUps: string[];
  /** `fix`-prefixed commits touching the same path after this PR merged. */
  laterFixCommits: string[];
}

/** How much of a decline's reason to show before it stops being scannable. */
const REASON_DISPLAY_CHARS = 180;

/**
 * An issue key of `teamKey` (the consumer's `issue_tracker.team`), or of any
 * team when none is configured.
 */
export function followUpPattern(teamKey: string | null): RegExp {
  const team =
    teamKey === null
      ? "[A-Z][A-Z0-9]*"
      : teamKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${team}-[0-9]{1,6}\\b`, "g");
}

function consumerTeamKey(): string | null {
  try {
    return teamKeyOrNull();
  } catch {
    return null;
  }
}

/**
 * Commits touching `path` after `since` whose headline is a conventional `fix`.
 *
 * Walked from `origin/<base>` rather than HEAD: this worktree is on some
 * feature branch, and its HEAD's ancestry stops at whenever it forked — so
 * every fix merged to the base after that point would be invisible, which is
 * exactly the population this looks for.
 *
 * Bounded BELOW by the PR's own merge commit, exclusively, rather than by
 * `--since=<mergedAt>`. That window is inclusive by timestamp, so it caught the
 * PR's own landing commit and reported the very change the finding was declined
 * on as evidence that the finding came back (measured). The `..`
 * exclusion is exact where a timestamp comparison cannot be. `--since` remains
 * the fallback for a merge commit this clone does not have.
 *
 * Local history only, and best-effort in the strong sense: a base ref this
 * clone has not fetched, a shallow clone, or a path since renamed all produce
 * an empty list, and an empty list here means "no local evidence", never "no
 * fix happened". That asymmetry is why this signal is REPORTED and never
 * counted — see the header.
 */
async function laterFixCommits(
  path: string,
  since: string,
  base: string,
  mergeOid: string,
  until: string,
): Promise<string[]> {
  const tip = base === "" ? "HEAD" : `origin/${base}`;
  const haveMerge =
    mergeOid !== "" &&
    (
      await git(["cat-file", "-e", `${mergeOid}^{commit}`], {
        stderr: "ignore",
      })
    ).code === 0;
  const range = haveMerge ? [`${mergeOid}..${tip}`] : [`--since=${since}`, tip];
  // Bounded ABOVE by the recorded window's own end, not by wherever the base
  // branch happens to be now. `tip` is a moving target, so without this a
  // re-run of a `--since`/`--until` window weeks later walks every commit that
  // landed in between and reports a different TOUCHED count for an unchanged
  // window — breaking the reproducibility this script's header promises
  //. Open-ended `--until` keeps the old
  // behaviour, which is correct for a fresh measurement.
  // An explicit UTC instant, never the bare `YYYY-MM-DD`. Git fills an omitted
  // time with the INVOCATION's current time of day and resolves it in local
  // time, so `--until=2026-08-13` silently drops fix commits later on the
  // terminal day and gives a different answer depending on when and where the
  // command runs — in a bound whose entire job is reproducibility.
  // `T23:59:59Z` also matches the `asOf` cutoff used for settling replies, so
  // both ends of the window mean the same thing.
  const upper = until === "" ? [] : [`--until=${until}T23:59:59Z`];
  const r = await git(
    [
      "log",
      ...range,
      ...upper,
      "--format=%h %s",
      // `--` is what keeps a path that looks like a revision from being read as
      // one; `--no-pager` is not needed because `run` never attaches a tty.
      "--",
      path,
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => /^[0-9a-f]+ fix(\([^)]*\))?[:!]/.test(l));
}

/**
 * Every prior name `path` has had on `tip`, tracing renames with git's own
 * `--follow`, oldest evidence last.
 *
 * `refindsFor` compares candidate paths for exact equality by default, which
 * discards a real recurrence whenever the file was renamed between the
 * declining PR and the one that re-raises the same defect — understating the
 * escape rate, the direction that makes the recall trade look safer than it
 * is. This is the git side of the fix: `--name-status` over `path`'s own
 * history lists every status change it has been through, oldest name first
 * in each `R<score>\t<old>\t<new>` record.
 *
 * Local history only and best-effort, the same contract as `laterFixCommits`:
 * a base ref this clone has not fetched, a shallow clone, or a rename outside
 * git's own similarity heuristic all produce an empty list, and an empty list
 * here means "no local evidence of a rename", never "definitely not the same
 * file" — which is exactly why this only WIDENS what counts as a match and
 * never narrows it.
 *
 * Bounded both ABOVE and BELOW, the same fix and the same reason as
 * `laterFixCommits`'s own `--until`: unbounded on either end, a rename
 * committed outside the window relevant to a SPECIFIC (decline, candidate)
 * pair can make two paths that were distinct as of that pair's own moment
 * equivalent on a later rerun, changing `refoundIn` and the escape rate for
 * a window the header promises is reproducible.
 * `until` is the CANDIDATE's own PR's `mergedAt` — tighter than the sweep's
 * whole window when the candidate is not the last PR in it — because a
 * rename dated after the candidate's own accepted thread was posted cannot
 * be what connects `path` to THAT thread: the file the thread was raised
 * against was whatever existed at the candidate's own moment, not whatever
 * the same pathname later became: each candidate is traced at its own
 * revision. `since` is the DECLINING
 * PR's own `mergedAt` — a rename dated before the decline cannot be the one
 * that produced the file the decline was raised against either, since the
 * decline observed `path` as an EXISTING file at its own PR's merge time; a
 * rename record older than that belongs to some earlier, already-superseded
 * incarnation of the same pathname (guarding against reuse of the candidate
 * pathname alone does not guard against reuse of the decline pathname).
 * Empirically confirmed that `--since`
 * combined with `--follow` filters exactly this way rather than merely
 * hiding matching commits from the printed range while still walking through
 * them for rename-following purposes.
 *
 * Open-ended `until` (the empty string, from the sweep's own open `--until`)
 * keeps the "as of now" behaviour, which is correct for a fresh measurement.
 *
 * Stopped at the first non-rename status for the tracked name, rather than
 * trusting the WHOLE `--follow` output: `--follow` does not stop at a
 * delete. Verified empirically (git 2.43.0) — `a.ts` renamed to `b.ts`,
 * `b.ts` deleted, an unrelated file later added fresh at `b.ts` — and
 * `git log --follow --name-status HEAD -- b.ts` still walks past the delete
 * and reports the ORIGINAL `R100 a.ts b.ts`, attributing it to the new,
 * unrelated file. The raw
 * per-commit record sequence for that repro, newest first, is `A b.ts` (the
 * unrelated recreation) / `D b.ts` (the original's deletion) / `R100 a.ts
 * b.ts` (the real rename) / `A a.ts` — so the fix is to walk that sequence
 * ourselves and stop the instant a record for the currently-tracked name is
 * anything other than an `M` (an ordinary edit, chain intact) or the `R` that
 * carries the chain one hop further back: an `A` is genuinely where the
 * CURRENT incarnation began, and a `D` can only mean `--follow` has crossed
 * into an already-severed, unrelated earlier incarnation of the same
 * pathname — both end the walk rather than accept what follows.
 *
 * Cached by `(tip, path)` ONLY — never by `since`/`until` — via
 * `rawRenameLog`: a normal sweep calls this for the same PATH repeatedly
 * across every (decline, candidate) pair that shares it, and keying by the
 * per-pair temporal bounds too made almost every pair's key unique, defeating
 * reuse almost entirely — 155 declines × 1,334 accepted threads in the
 * checked-in baseline is on the order of hundreds of thousands of walks at
 * the file's own measured ~27s/100.
 * The FULL, unbounded `--follow` history is fetched once per `(tip, path)`
 * and the `since`/`until` window is applied afterward, in memory, against
 * that one cached result — see `rawRenameLog` and the filtering loop below.
 */
const RENAME_LOG_CACHE_MAX = 2000;
const renameLogCache = new Map<string, Promise<RawRenameCommit[]>>();

interface RawRenameRecord {
  /** `R100`, `A`, `D`, `M`, `C100`, ... — the raw `--name-status` status token. */
  status: string;
  /** Set only for a two-path record (`R`/`C`): the pre-rename/copy-source path. */
  oldPath: string | null;
  /** The record's own "acted upon" path — the NEW name for `R`/`C`, the sole path otherwise. */
  path: string;
}

interface RawRenameCommit {
  /** Committer date, Unix epoch milliseconds (`%ct` is seconds; scaled). */
  epochMs: number;
  records: RawRenameRecord[];
}

/**
 * Parse the shared `--follow --name-status -z --format=\x01<header>` output
 * into per-commit blocks. `header` is left OPAQUE to this parser — `%ct` for
 * `rawRenameLog`'s committer-date walk, `%H` for `revisionRenameLog`'s
 * ancestry-bounded one — so both walks share the one
 * hand-tested field-splitting loop rather than risking two copies drifting
 * apart on the next `-z`/quoting edge case. See `rawRenameLog`'s own doc,
 * directly below, for why `-z` and the `\x01` block separator are used at
 * all.
 */
function parseNameStatusBlocks(
  stdout: string,
): Array<{ header: string; records: RawRenameRecord[] }> {
  const out: Array<{ header: string; records: RawRenameRecord[] }> = [];
  for (const block of stdout.split("\x01")) {
    if (block === "") continue;
    const fields = block.split("\x00");
    const header = fields[0] ?? "";
    const records: RawRenameRecord[] = [];
    let i = 1;
    while (i < fields.length) {
      const status = (fields[i] ?? "").replace(/^\n/, "");
      i++;
      if (status === "") continue;
      if (/^[RC][0-9]*$/.test(status)) {
        const oldPath = fields[i];
        const newPath = fields[i + 1];
        i += 2;
        if (oldPath === undefined || newPath === undefined) break;
        records.push({ status, oldPath, path: newPath });
      } else {
        const onlyPath = fields[i];
        i += 1;
        if (onlyPath === undefined) break;
        records.push({ status, oldPath: null, path: onlyPath });
      }
    }
    out.push({ header, records });
  }
  return out;
}

/**
 * Every commit `--follow --name-status` reports for `path` on `tip`,
 * UNBOUNDED by any `since`/`until` — the raw material `renameHistoryOf`
 * filters in memory, cached once per `(cwd, tip, path)` so the (comparatively
 * rare) distinct paths in a sweep each pay for exactly one `--follow` walk
 * regardless of how many different (decline, candidate) windows are later
 * applied to it.
 *
 * `\x01%ct` as the commit separator/date, rather than the default record
 * format: `%ct` is the committer date as Unix epoch SECONDS, which — unlike
 * `%cI` (ISO 8601 in the commit's OWN recorded timezone) — is directly and
 * unambiguously comparable as a number regardless of which timezone any
 * given commit was made in, with no string-parsing pitfalls. `\x01` cannot
 * appear in ordinary commit content, so splitting on it cleanly separates
 * commit blocks even though `%ct` alone carries no line-boundary marker of
 * its own.
 *
 * `-z`, rather than the default newline-delimited form: without it, git
 * C-style QUOTES and octal-escapes any path with a non-ASCII or otherwise
 * "unusual" byte — `"b-\303\251.ts"` for `b-é.ts` — and a tab-split regex
 * over that output compares the quoted, escaped literal against the plain
 * tracked name, which can never match, silently discarding a genuine rename
 * chain for such a file. `-z`
 * NUL-terminates each field with no quoting at all, so parsing is a plain
 * split rather than a decode.
 *
 * The `-z` record shape, once a commit block (split on `\x01`) is itself
 * split on `\x00`: `[epochSeconds, "\n"+status, path, ...]`, where a
 * rename/copy record (`status` starting `R`/`C`) carries TWO path fields
 * (old, then new) and every other status carries one. The literal `\n`
 * prefixing the first status token in a block is git's own blank-line
 * separator between the commit header and its diff content, preserved
 * verbatim under `-z`.
 *
 * The promise itself is cached, not just its resolved value, so two calls
 * racing for the same key before either resolves still share one git
 * invocation. Only a SUCCESSFUL walk (`r.code === 0`) is cached — a failed
 * one is never cached, so a later call against the same key after local git
 * state becomes readable is not stuck with a stale negative for the rest of
 * the process. Bounded
 * to `RENAME_LOG_CACHE_MAX` entries with FIFO eviction for the same reason
 * the prior per-result cache was: the
 * keys are driven by a caller-controlled `--limit` with no effective
 * ceiling, and unbounded growth retains a full commit list per entry for the
 * life of the process.
 */
async function rawRenameLog(
  path: string,
  tip: string,
  cwd?: string,
): Promise<RawRenameCommit[]> {
  const key = `${cwd ?? ""} ${tip} ${path}`;
  const cached = renameLogCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<RawRenameCommit[]> => {
    const r = await git(
      [
        "log",
        "--follow",
        "--name-status",
        "-z",
        "--format=\x01%ct",
        tip,
        "--",
        path,
      ],
      {
        stderr: "ignore",
        env: gitIdentityEnv(),
        ...(cwd === undefined ? {} : { cwd }),
      },
    );
    if (r.code !== 0) {
      renameLogCache.delete(key);
      return [];
    }
    const commits: RawRenameCommit[] = [];
    for (const { header, records } of parseNameStatusBlocks(r.stdout)) {
      const epochSeconds = Number.parseInt(header, 10);
      if (!Number.isFinite(epochSeconds)) continue;
      commits.push({ epochMs: epochSeconds * 1000, records });
    }
    return commits;
  })();
  renameLogCache.set(key, promise);
  if (renameLogCache.size > RENAME_LOG_CACHE_MAX) {
    const oldest = renameLogCache.keys().next().value;
    if (oldest !== undefined) renameLogCache.delete(oldest);
  }
  return promise;
}

/**
 * Is `oid` a commit this clone can actually read? Factored out of
 * `revisionRenameLog` so `revisionMatch` can ALSO check `declineHeadOid`
 * with it before trusting either an empty walk or an ancestry answer as a
 * genuine "no" for either side of a comparison.
 *
 * This matters more than it looks: GitHub deletes a PR's branch on merge,
 * and the RAW pre-squash-merge commits that branch pointed at — exactly
 * what `originalCommit.oid` names — become unreachable from `develop` (and
 * typically get pruned from a clone) in short order, even though GraphQL
 * keeps serving that oid for the thread that named it. Measured against
 * this repository: 7 of 7 recently-merged PRs sampled had their
 * `reviewedHeadOid` already unreachable locally. So `false` here is not a
 * rare edge case — it is close to the DEFAULT outcome for a merged PR, and
 * every caller must treat it as "no local evidence", never "definitely no
 * rename" or "definitely not an ancestor".
 *
 * Cached by `(cwd, oid)`, the promise itself (same reuse-a-race pattern as
 * `rawRenameLog`/`revisionRenameLog`) — a full sweep compares the SAME
 * candidate thread's `headOid` against every earlier decline it could be a
 * recurrence of, on the order of the SAME decline-count × candidate-count
 * scale `rawRenameLog`'s own cache doc measures for the checked-in baseline
 * — not restated here as its
 * own numerals, which would be a second hand-maintained copy of a count
 * that already lives at that one comment and would drift from it silently.
 * Unlike those two caches, reachability has no meaningful "failure"
 * distinct from a stable negative answer — a commit that is not in the
 * object store now will not appear mid-process — so BOTH `true` and
 * `false` are cached here, not just a successful walk. Bounded with the
 * same FIFO eviction as the other two caches, for the same reason: an
 * unbounded `--limit` drives an unbounded key count.
 */
const COMMIT_REACHABLE_CACHE_MAX = RENAME_LOG_CACHE_MAX;
const commitReachableCache = new Map<string, Promise<boolean>>();

async function commitReachable(oid: string, cwd?: string): Promise<boolean> {
  const key = `${cwd ?? ""} ${oid}`;
  const cached = commitReachableCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<boolean> => {
    const r = await git(["cat-file", "-e", `${oid}^{commit}`], {
      stderr: "ignore",
      env: gitIdentityEnv(),
      ...(cwd === undefined ? {} : { cwd }),
    });
    return r.code === 0;
  })();
  commitReachableCache.set(key, promise);
  if (commitReachableCache.size > COMMIT_REACHABLE_CACHE_MAX) {
    const oldest = commitReachableCache.keys().next().value;
    if (oldest !== undefined) commitReachableCache.delete(oldest);
  }
  return promise;
}

/**
 * Is this clone SHALLOW (`git clone --depth`)? Checked once per `cwd`, not
 * per commit, and treated as the simplest safe answer for the revision-based
 * path: a shallow clone's `git log --follow` does not error when it runs off
 * the end of the fetched history — it silently STOPS at the grafted boundary
 * commit, exit 0, with fewer commits than the real history has. So a commit
 * whose own object IS present (`commitReachable` sees it as `true`, since
 * the boundary commit itself is a real, if parentless, object) can still
 * have an EARLIER rename sitting just past that boundary, invisible to the
 * walk rather than reported as an error. Determining WHICH commits are past the
 * boundary would need a per-commit check; the whole-repo
 * `--is-shallow-repository` answer is cheaper and sufficient, since
 * `revisionMatch` falling back to `dateMatch` for every pair when the repo is
 * shallow costs only precision on an already-uncommon clone shape, not
 * correctness.
 *
 * Returns `null` — not `false` — when the check itself could not run (a
 * non-zero exit, or output this parser does not recognise): a git version
 * old enough to lack the flag, or any other operational failure, must read
 * as "cannot tell", never as "confirmed NOT shallow" (collapsing a failed
 * check to `false` lets `revisionMatch` trust a walk it has no basis to
 * trust). Callers
 * treat `null` the same as `true`: anything short of a CONFIRMED `false`
 * withholds the revision path.
 *
 * Cached by `cwd`, same reuse-a-race pattern and FIFO bound as this
 * module's other two caches — cardinality is normally tiny (one entry per
 * distinct clone a process touches), but a long-lived process exercising
 * many different `cwd`s (this suite's own per-test temp repos, run in one
 * `bun test` process) should not accumulate an unbounded map either.
 */
const SHALLOW_REPO_CACHE_MAX = RENAME_LOG_CACHE_MAX;
const shallowRepoCache = new Map<string, Promise<boolean | null>>();

async function isShallowRepo(cwd?: string): Promise<boolean | null> {
  const key = cwd ?? "";
  const cached = shallowRepoCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<boolean | null> => {
    const r = await git(["rev-parse", "--is-shallow-repository"], {
      stderr: "ignore",
      env: gitIdentityEnv(),
      ...(cwd === undefined ? {} : { cwd }),
    });
    if (r.code !== 0) return null;
    const out = r.stdout.trim();
    if (out === "true") return true;
    if (out === "false") return false;
    return null;
  })();
  shallowRepoCache.set(key, promise);
  if (shallowRepoCache.size > SHALLOW_REPO_CACHE_MAX) {
    const oldest = shallowRepoCache.keys().next().value;
    if (oldest !== undefined) shallowRepoCache.delete(oldest);
  }
  return promise;
}

/**
 * Every commit `--follow --name-status` reports for `path`, walked from a
 * SPECIFIC commit (`headOid`) rather than `tip` — bounded by ancestry,
 * never by a committer-date heuristic. `git log --follow
 * <headOid>` can only ever visit ancestors of `headOid`, so a commit pushed
 * AFTER the thread `headOid` anchors was raised — however it backdates its
 * own committer date — can never appear here, and a commit already on
 * `headOid` can never be wrongly excluded by one either: that is the exact
 * false-inclusion/false-exclusion pair `rawRenameLog`'s committer-date
 * filtering is exposed to.
 *
 * Returns `null` — not `[]` — both when `headOid` is unreachable (see
 * `commitReachable`) AND when the `git log` walk itself fails (a non-zero
 * exit — permission error, corrupted pack, wedged filesystem): neither is
 * "confirmed, walk ran, found nothing", and folding an operational failure
 * into the same empty array as a genuine empty result let `revisionMatch`
 * treat a git failure as a definitive non-match instead of falling back to
 * `dateMatch` (returning `[]` for both cases would contradict the nullable
 * contract every other lookup in this module already follows). `[]` is reserved
 * for a CONFIRMED empty walk: `git log` exited 0 and reported no commits at all
 * for `path` from `headOid` — a legitimate answer when `path` never existed in
 * that ancestry.
 *
 * Same cache discipline as `rawRenameLog`, for the same reasons: keyed by
 * `(cwd, headOid, path)`, the PROMISE itself cached so two callers racing
 * for the same key share one `git` invocation, only a SUCCESSFUL walk is
 * cached, bounded with FIFO eviction.
 */
const REVISION_RENAME_LOG_CACHE_MAX = RENAME_LOG_CACHE_MAX;
const revisionRenameLogCache = new Map<
  string,
  Promise<RevisionRenameCommit[] | null>
>();

interface RevisionRenameCommit {
  /** The commit's own oid (`%H`) — the ancestry anchor for an earlier change's `since`-equivalent check. */
  oid: string;
  records: RawRenameRecord[];
}

async function revisionRenameLog(
  path: string,
  headOid: string,
  cwd?: string,
): Promise<RevisionRenameCommit[] | null> {
  const key = `${cwd ?? ""} ${headOid} ${path}`;
  const cached = revisionRenameLogCache.get(key);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<RevisionRenameCommit[] | null> => {
    const opts = {
      stderr: "ignore" as const,
      env: gitIdentityEnv(),
      ...(cwd === undefined ? {} : { cwd }),
    };
    if (!(await commitReachable(headOid, cwd))) {
      revisionRenameLogCache.delete(key);
      return null;
    }
    const r = await git(
      [
        "log",
        "--follow",
        "--name-status",
        "-z",
        "--format=\x01%H",
        headOid,
        "--",
        path,
      ],
      opts,
    );
    if (r.code !== 0) {
      revisionRenameLogCache.delete(key);
      return null;
    }
    const commits: RevisionRenameCommit[] = [];
    for (const { header, records } of parseNameStatusBlocks(r.stdout)) {
      if (header === "") continue;
      commits.push({ oid: header, records });
    }
    return commits;
  })();
  revisionRenameLogCache.set(key, promise);
  if (revisionRenameLogCache.size > REVISION_RENAME_LOG_CACHE_MAX) {
    const oldest = revisionRenameLogCache.keys().next().value;
    if (oldest !== undefined) revisionRenameLogCache.delete(oldest);
  }
  return promise;
}

/**
 * Is `ancestor` an ancestor of, or equal to, `descendant`? `git merge-base
 * --is-ancestor` exit code 0 = yes, 1 = no, anything else = undeterminable
 * locally (one OID is not reachable in this clone) — reported as `null`
 * rather than guessed either way, the same fail-neither posture every other
 * best-effort git lookup in this module takes.
 */
async function isAncestor(
  ancestor: string,
  descendant: string,
  cwd?: string,
): Promise<boolean | null> {
  const r = await git(["merge-base", "--is-ancestor", ancestor, descendant], {
    stderr: "ignore",
    env: gitIdentityEnv(),
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

const MERGE_COMMIT_MERGED_AT_CACHE_MAX = RENAME_LOG_CACHE_MAX;
const mergeCommitMergedAtCache = new Map<string, Promise<string | null>>();

/** Wall-clock ms an OPERATIONAL failure (never a well-formed "no match")
 * stays negative-cached before a later call for the exact same key is
 * allowed to retry the network. `revisionMatch` walks candidates and hops
 * sequentially, so several candidates sharing one hop — or one candidate
 * with several hops resolving to the same sha — hit this key back to back;
 * without this, each one pays a fresh `ghCall` deadline for what is almost
 * always the identical transient failure. Short enough that a sweep spanning
 * minutes can still retry after a genuine blip, unlike the unbounded eviction
 * this replaces. FIFO-bounded at `MERGE_COMMIT_MERGED_AT_CACHE_MAX`, same as
 * `mergeCommitMergedAtCache` itself and every other best-effort lookup cache in
 * this module. */
const MERGE_COMMIT_MERGED_AT_FAILURE_TTL_MS = 5_000;
const mergeCommitMergedAtFailedAt = new Map<string, number>();

/** Sweep-level circuit breaker, keyed by `cwd` (production never varies it
 * within one process, so this is one counter per sweep there; tests get one
 * per throwaway repo for free). Once this many OPERATIONAL failures have been
 * observed for the same cwd, every further lookup short-circuits to `null`
 * without spending a fresh deadline at all — bounding this lookup's total
 * added cost to roughly `MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET` deadlines
 * instead of one per distinct hop during a systemic GitHub outage or rate
 * limit, which the per-key TTL above cannot bound on its own (in such an
 * outage, distinct hops necessarily fail likewise).
 * Safe to give up early: every caller already treats this lookup's `null` as
 * "no tiebreaker available", falling back to the WIDENS default rather than a
 * wrong exclusion (see `revisionMatch`'s own header). The trip itself is not
 * permanent — see `MERGE_COMMIT_MERGED_AT_BUDGET_COOLDOWN_MS` below for how
 * it recovers. */
export const MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET = 5;
const mergeCommitMergedAtFailureCounts = new Map<string, number>();

/** Wall-clock ms the breaker above stays tripped before a later call is let
 * through to retry the network. Without this, nothing ever reset the
 * counter — no success path decremented it and there was no TTL on the trip
 * itself — so once five failures accumulated (anywhere in the process's
 * life — which is already this one sweep's entire `--since`/`--until`
 * window, up to `--limit` merged PRs, not merely one hop) every later lookup
 * for that cwd short-circuited to `null` forever, even long after GitHub
 * recovered. A success-only reset cannot
 * fix this on its own: once
 * tripped, the short-circuit above prevents the very network call a success
 * would need to happen — the trip has to expire on its own. Long enough that
 * a genuine burst of failures still costs roughly one budget's worth of
 * deadlines rather than re-opening mid-burst; short enough that a sweep
 * spanning minutes gets a fresh attempt once a transient outage has
 * plausibly cleared. Like the per-key TTL above, this is an operational
 * retry/backoff timestamp, not the business-temporal logic ADR-0017 scopes
 * clock injection to (see `self-inflicted.ts`'s identical, already-settled
 * note on its own `Date.now()` deadline read). */
const MERGE_COMMIT_MERGED_AT_BUDGET_COOLDOWN_MS = 60_000;
const mergeCommitMergedAtBudgetTrippedAt = new Map<string, number>();

/**
 * Is `sha` itself the merge commit GitHub created for some PR — not merely a
 * commit contained in one — and if so, that PR's own `merged_at`? Answers the
 * squash-merge tiebreaker `revisionMatch` needs when ancestry alone cannot
 * order a hop: `merged_at` is set SERVER-SIDE at the moment
 * GitHub performs the merge, unlike a commit's own committer date, which a
 * contributor's raw branch commit fully controls via `GIT_COMMITTER_DATE` —
 * the exact vulnerability an earlier change removed from the ancestry-preferred path,
 * so trusting it here would reopen that vulnerability under a different name.
 *
 * Filtered by `merge_commit_sha === sha` exactly, never merely "this PR's
 * response includes `sha`": "list pull requests associated with a commit"
 * also returns a PR whose OWN raw, pre-squash branch commit equals `sha` —
 * that PR HAS a real `merged_at`, but `sha` there names an ordinary,
 * fully-forgeable branch commit, not the timestamp-bearing merge commit
 * itself, so accepting the match would launder committer-date trust right
 * back in through this endpoint's response.
 *
 * Also filtered by `base.ref === baseRefName` exactly: the endpoint answers
 * "every PR this commit is associated with", not "every PR that merged it into
 * the decline's own branch" — a commit can be the merge commit of a PR that
 * targeted a release or feature branch, with a `merged_at` that predates the
 * decline even though the rename never reached the decline's actual base ref.
 * Trusting `merged_at` without this check reopens exactly the cross-branch
 * confusion the ancestry checks above exist to rule out, just laundered through
 * this endpoint instead. `baseRefName === ''` (the caller could not resolve
 * one) never matches, deliberately: real branch refs are never the empty
 * string, so an unresolvable caller-side base always falls through to the "no
 * entry verified" `null`, never to an accidental match against a malformed
 * same-empty `base.ref` in the response.
 *
 * `null` — never guessed either way — covers every case that leaves this
 * undecided: the `gh api` call failing or hitting `ghCall`'s own deadline, an
 * unparsable response, or a well-formed response with no entry whose
 * `merge_commit_sha` is `sha` AND whose `base.ref` is `baseRefName`. That
 * last case is the COMMON answer, not a failure: most commits `revisionMatch`
 * walks are ordinary in-branch commits a PR author made directly, never
 * anyone's merge commit at all — only a hop inherited from develop's own
 * history predating a candidate's fork can ever resolve here (an earlier change's own
 * worked counterexample).
 *
 * Cached per `(cwd, baseRefName, sha)`, same FIFO-eviction shape as every
 * other best-effort lookup in this module: `revisionMatch` can revisit the
 * same hop across multiple (decline, candidate) pairs within one sweep, and
 * two declines in the same sweep can carry different base refs, so the
 * answer is not a pure function of `(cwd, sha)` alone. Only a CONCLUSIVE
 * answer is retained — the well-formed "no matching, correctly-based merge
 * commit" case above — same as `rawRenameLog`/`revisionRenameLog`: an
 * operational failure (the `gh api` call itself failing, or an unparsable
 * response) is evicted rather than cached outright, so one transient error
 * does not poison this sha for the rest of the sweep. It is, however,
 * negative-cached for `MERGE_COMMIT_MERGED_AT_FAILURE_TTL_MS` and counted
 * against a sweep-wide failure budget — see those constants' own doc — so a
 * burst of candidates or hops sharing one failing lookup, or a systemic
 * outage spanning many distinct ones, cannot each independently pay a fresh
 * `ghCall` deadline.
 */
async function mergeCommitMergedAt(
  sha: string,
  baseRefName: string,
  cwd?: string,
): Promise<string | null> {
  const key = `${cwd ?? ""} ${baseRefName} ${sha}`;
  const cached = mergeCommitMergedAtCache.get(key);
  if (cached !== undefined) return cached;
  const failedAt = mergeCommitMergedAtFailedAt.get(key);
  if (
    failedAt !== undefined &&
    Date.now() - failedAt < MERGE_COMMIT_MERGED_AT_FAILURE_TTL_MS
  ) {
    return null;
  }
  const budgetKey = cwd ?? "";
  const trippedAt = mergeCommitMergedAtBudgetTrippedAt.get(budgetKey);
  if (trippedAt !== undefined) {
    if (Date.now() - trippedAt < MERGE_COMMIT_MERGED_AT_BUDGET_COOLDOWN_MS) {
      return null;
    }
    // Cooldown elapsed — let this call through to retry, with the counter
    // and trip both cleared so a fresh run of failures gets the full budget
    // rather than tripping again on its very first one.
    mergeCommitMergedAtBudgetTrippedAt.delete(budgetKey);
    mergeCommitMergedAtFailureCounts.delete(budgetKey);
  }
  const failureCount = mergeCommitMergedAtFailureCounts.get(budgetKey) ?? 0;
  if (failureCount >= MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET) {
    return null;
  }
  const recordFailure = (): void => {
    mergeCommitMergedAtCache.delete(key);
    mergeCommitMergedAtFailedAt.set(key, Date.now());
    if (mergeCommitMergedAtFailedAt.size > MERGE_COMMIT_MERGED_AT_CACHE_MAX) {
      const oldest = mergeCommitMergedAtFailedAt.keys().next().value;
      if (oldest !== undefined) mergeCommitMergedAtFailedAt.delete(oldest);
    }
    const nextCount = failureCount + 1;
    mergeCommitMergedAtFailureCounts.set(budgetKey, nextCount);
    if (nextCount >= MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET) {
      mergeCommitMergedAtBudgetTrippedAt.set(budgetKey, Date.now());
    }
  };
  // A conclusive response — well-formed JSON, whether it names a match or
  // not — is evidence GitHub has recovered, so it clears the count outright
  // rather than waiting on the cooldown above. This is the fast path back to
  // "closed"; the cooldown is what still guarantees recovery on a cwd whose
  // every call keeps failing, where this can never fire at all.
  const recordSuccess = (): void => {
    if (failureCount === 0) return;
    mergeCommitMergedAtFailureCounts.delete(budgetKey);
    mergeCommitMergedAtBudgetTrippedAt.delete(budgetKey);
  };
  const promise = (async (): Promise<string | null> => {
    const r = await ghCall(
      ["api", `repos/{owner}/{repo}/commits/${sha}/pulls`],
      { stderr: "ignore", ...(cwd === undefined ? {} : { cwd }) },
    );
    if (r.code !== 0) {
      recordFailure();
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      recordFailure();
      return null;
    }
    if (!Array.isArray(parsed)) {
      recordFailure();
      return null;
    }
    recordSuccess();
    for (const raw of parsed) {
      const p = (raw ?? {}) as Record<string, unknown>;
      if (p.merge_commit_sha !== sha) continue;
      const base = (p.base ?? {}) as Record<string, unknown>;
      const baseRef = typeof base.ref === "string" ? base.ref : "";
      if (baseRefName === "" || baseRef !== baseRefName) continue;
      const mergedAt = typeof p.merged_at === "string" ? p.merged_at : "";
      if (mergedAt === "" || epochMsOf(mergedAt) === null) continue;
      return mergedAt;
    }
    return null;
  })();
  mergeCommitMergedAtCache.set(key, promise);
  if (mergeCommitMergedAtCache.size > MERGE_COMMIT_MERGED_AT_CACHE_MAX) {
    const oldest = mergeCommitMergedAtCache.keys().next().value;
    if (oldest !== undefined) mergeCommitMergedAtCache.delete(oldest);
  }
  return promise;
}

/** One rename hop `renameHistoryFromRevision` found — a prior name of the
 * walked path, and the commit that performed the rename. */
export interface RevisionRenameHop {
  /** The prior name at this hop. */
  path: string;
  /** The commit OID that performed this rename — not a timestamp, despite
   * this module's other `*At` fields (`createdAt`, `declinedAt`, …) all
   * being ISO instants; named `renamedIn` rather than `renamedAt` to keep
   * that distinction visible at every call site. */
  renamedIn: string;
}

/**
 * Every prior name `path` has had on the ancestry of `headOid` — the
 * revision-based counterpart to `renameHistoryOf`, sharing its exact
 * stop-condition walk (a rename whose "new" side is not the tracked name
 * ends the chain; a non-`M` single-path record for the tracked name — a
 * fresh `A` or a severed `D` — ends it too) but over `revisionRenameLog`'s
 * ancestry-bounded commit list instead of `rawRenameLog`'s full, tip-wide
 * one. No `since`/`until` filtering happens here at all: every hop returned
 * is, by construction, an ancestor of `headOid`, so the caller's own
 * ancestry check against the OTHER side of the comparison (see
 * `renameEquivalents`) is the only bound left to apply.
 *
 * Returns `null` — never silently reinterpreted as `[]` — when
 * `revisionRenameLog` itself could not vouch for the walk (see its own
 * doc): `headOid` unreachable, or the `git log` call failed outright.
 */
export async function renameHistoryFromRevision(
  path: string,
  headOid: string,
  cwd?: string,
): Promise<RevisionRenameHop[] | null> {
  const commits = await revisionRenameLog(path, headOid, cwd);
  if (commits === null) return null;
  const hops: RevisionRenameHop[] = [];
  let tracked = path;
  for (const commit of commits) {
    for (const record of commit.records) {
      if (record.oldPath !== null) {
        if (!record.status.startsWith("R")) continue;
        if (record.path !== tracked) return hops;
        hops.push({ path: record.oldPath, renamedIn: commit.oid });
        tracked = record.oldPath;
        continue;
      }
      if (record.path === tracked && record.status !== "M") return hops;
    }
  }
  return hops;
}

/** `Date.parse` of a full ISO instant, or `null` for `''`/an unparsable value. */
function epochMsOf(iso: string): number | null {
  if (iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The committer-date-filtered rename walk `renameEquivalents` falls back to
 * when a (decline, candidate) pair has no usable reviewed-head OID on either
 * side — see `renameHistoryFromRevision` for the ancestry-bounded walk it
 * PREFERS whenever both sides carry one. Kept, not replaced: a
 * thread predating the `originalCommit` GraphQL field (or one whose
 * referenced commit has since become unreachable) still needs an answer,
 * and this best-effort heuristic is what this module always gave one before
 * See the parameter docs below for its own reasoning.
 */
export async function renameHistoryOf(
  path: string,
  tip: string,
  since: string,
  /** Already a fully-qualified instant (or `''`) — see `renameEquivalents`. */
  until: string,
  /**
   * The repository to run `git` in — omitted in production (the ambient
   * cwd, this worktree). Only a test passes this, and only against a
   * throwaway temp repo built with its own `git init`.
   *
   * `cwd` ALONE is not sufficient: a git HOOK's exported `GIT_DIR`/
   * `GIT_WORK_TREE` overrides cwd-based repository discovery, so a test
   * running under THIS skill's own `drive-pr-selftest` pre-commit hook saw
   * `renameHistoryOf` silently read the CALLER's real worktree instead of
   * the fixture — passing every check on its own but failing in a way that
   * looked like flaky contention when run inside the suite that IS that
   * hook (measured: the same class `verification-fit.test.ts`'s own header
   * names, easy to miss because `cwd` alone looks sufficient). So when `cwd` is
   * given, every `GIT_*` location variable is scrubbed from the child's
   * environment too — the same `GIT_LOCATION_VARS` list that suite scrubs,
   * restated here rather than imported to keep this module's only
   * dependency on git plumbing self-contained.
   */
  cwd?: string,
): Promise<string[]> {
  const commits = await rawRenameLog(path, tip, cwd);
  const sinceEpochMs = epochMsOf(since);
  const untilEpochMs = epochMsOf(until);
  const names: string[] = [];
  let tracked = path;
  // `git log`'s own traversal order for `--follow` — approximately
  // newest-first, but NOT a guarantee that committer dates are monotonically
  // decreasing: a rebase, a cherry-pick, or plain clock skew can leave an
  // older-dated commit appearing before a younger-dated one in the output
  // (reproduced against git 2.43). Breaking out of this loop at the first
  // commit dated before `since`, trusting that ordering, could skip a
  // legitimate, in-window rename sitting further down the list behind a
  // non-monotonic date. There is no early exit on EITHER bound now: every
  // commit `rawRenameLog` already fetched (and cached) is walked in full,
  // and `since`/`until` only ever gate whether a matched rename's OLD name
  // is ADDED to `names` — never whether a commit is visited at all. This
  // symmetric, no-skip approach is what already lets `until` correctly stop
  // the walk at a delete/recreate boundary regardless of that boundary's own
  // date; the same reasoning applies to
  // `since`.
  //
  // Affordable specifically because `rawRenameLog` is cached per `(cwd, tip,
  // path)`: this loop runs over an already-fetched, in-memory array, not a
  // fresh `git` invocation — the early exit this replaces was never buying
  // anything but a few array iterations.
  for (const commit of commits) {
    const inWindow =
      (sinceEpochMs === null || commit.epochMs >= sinceEpochMs) &&
      (untilEpochMs === null || commit.epochMs <= untilEpochMs);
    for (const record of commit.records) {
      if (record.oldPath !== null) {
        // Two-path record: a rename (`R`) continues the chain; a copy (`C`)
        // is not a rename and is left unrecognized, same as the old
        // tab-delimited regex silently skipped it (neither the rename nor
        // the single-path pattern matched a two-path `C` line).
        if (!record.status.startsWith("R")) continue;
        // A rename whose "new" side is not the name we are currently
        // tracking cannot be the next hop of THIS chain — stop rather than
        // guess which lineage it belongs to.
        if (record.path !== tracked) return names;
        if (inWindow) names.push(record.oldPath);
        tracked = record.oldPath;
        continue;
      }
      // Single-path record (`A`, `D`, `M`, ...) for the tracked name. `M` is
      // an ordinary edit and does not break the chain; anything else — a
      // fresh `A` (true start) or a `D` (a severed, unrelated earlier
      // incarnation, per the header) — ends it, in or out of window alike.
      if (record.path === tracked && record.status !== "M") return names;
    }
  }
  return names;
}

/** One candidate thread's identity: its path and its OWN `createdAt` (a full
 * ISO instant), or `''` when the thread carries no readable timestamp. NEVER
 * deduplicated by `path` alone — see `renameEquivalents`. */
export interface RenameCandidate {
  path: string;
  anchor: string;
  /**
   * The candidate thread's own `reviewedHeadOid` (`ThreadSample`) — when
   * this AND the decline's own OID are both available, `renameEquivalents`
   * prefers the ancestry-bounded `renameHistoryFromRevision` walk over its
   * committer-date fallback.
   *
   * `undefined`/`null` means GitHub itself had no `originalCommit` to
   * report (see `ThreadSample.reviewedHeadOid`'s own doc) — NOT that the
   * referenced commit is locally unreachable, which is a SEPARATE,
   * downstream concern `commitReachable` checks for itself and does NOT
   * make this field null. A candidate whose
   * `headOid` IS a populated string but locally unreachable still falls
   * back to `renameHistoryOf` — it just does so via `revisionMatch`
   * returning `null`, not via this field being absent.
   */
  headOid?: string | null;
}

/** The composite key `renameEquivalents` returns matches under — a candidate
 * is identified by (path, anchor, headOid) together, not by (path, anchor)
 * alone. `headOid` is part of the identity too: it changes
 * whether `revisionMatch` accepts or excludes a candidate, so two comments
 * sharing a literal pathname AND the same to-the-second `createdAt` — not
 * far-fetched for a bot review that posts several inline comments in one
 * batched submission — but carrying DIFFERENT `originalCommit` oids would
 * otherwise collapse onto the same (path, anchor) key and let one
 * candidate's verdict leak onto the other's lookup.
 *
 * `JSON.stringify` of the tuple, not a delimiter-joined string: a bare
 * `${path} ${anchor} ${headOid}` join is not collision-safe, since a git
 * path can itself contain a space — `{path: "a", anchor:
 * "2026-01-01T00:00:00Z"}` and `{path: "a 2026-01-01T00:00:00Z", anchor:
 * ""}` would produce the identical joined string despite being two
 * different candidates. `JSON.stringify`
 * escapes embedded delimiter characters, so the array boundary is never
 * ambiguous the way a plain join's is. `headOid`'s own `?? ''` keeps the
 * key stable for the common case where it is absent on both sides.
 */
export function renameCandidateKey(c: RenameCandidate): string {
  return JSON.stringify([c.path, c.anchor, c.headOid ?? ""]);
}

/**
 * Every (path, anchor) pair in `candidates` whose OWN rename history — traced
 * fresh from `tip`, bounded to that specific candidate's own temporal window
 * — shows `path` as a prior name.
 *
 * Deliberately checks ONLY each candidate's own history, never `path`'s own
 * history for a literal string match against a candidate's NAME. An earlier
 * version did the latter as a shortcut ("`path`'s own history is checked for
 * each candidate too"), and it is unsound: a pathname can be reused for an
 * unrelated file — `old.ts` renamed away to `new.ts`, then a later,
 * unrelated file created at `old.ts` — and `path`'s legitimate rename
 * history still lists `"old.ts"` as a real prior name of ITS OWN lineage.
 * Matching that string against any later occurrence of the same name,
 * without checking whether the later occurrence traces back through the SAME
 * commit lineage, reports a false RE-FOUND recurrence between two unrelated
 * files.
 *
 * `candidateHistory` does not have that failure mode on its own: `--follow`,
 * run against the CANDIDATE's own current identity at `tip`, walks its real
 * content lineage rather than matching names, so a freshly-created,
 * unrelated file has no rename record pointing back to `path` at all — while
 * a genuine rename, in either chronological order relative to the decline
 * and across any number of intermediate hops, always shows up in the
 * candidate's own trace. That subsumes both directions the removed shortcut
 * existed to cover.
 *
 * It is not sufficient BY ITSELF, though — see `renameHistoryOf`'s own
 * `since`/`until` bounding, which is what closes two further residuals:
 * `candidates` carries each candidate THREAD's own `createdAt` precisely so
 * this can pass it through as `renameHistoryOf`'s per-candidate `until`, and
 * `path`'s own declining THREAD's `createdAt` is threaded through as the
 * shared `since`.
 *
 * Candidates are taken as a LIST, never a `Map<path, anchor>` collapsed by
 * pathname: an earlier version did exactly that, and it is unsound for the
 * same reason `path` string-matching is — two threads can share a literal
 * pathname while being different incarnations of it (reused after a
 * rename), and collapsing to one entry per string applies whichever
 * candidate's own anchor happened to win the collapse to EVERY occurrence
 * of that string, silently misjudging the others. The RETURN value is therefore
 * keyed by `renameCandidateKey` (path+anchor together), not by path alone.
 *
 * ── Revision-based match, preferred when available ─────────────
 *
 * `since`/`until`/`tip` above are a committer-date heuristic — a reviewer's
 * point against it, restated here because it is exactly what motivated this
 * section: committer date is author-controlled metadata, not branch/review
 * chronology, so a commit pushed after a thread was raised can be backdated
 * INTO its window, and a commit already on the reviewed head can carry a
 * future date and be wrongly excluded FROM it. `ThreadSample.reviewedHeadOid`
 * (GraphQL's `originalCommit` on a thread's first comment) is the commit the
 * thread was ACTUALLY raised against, so when both the decline and a
 * candidate carry one, `revisionMatch` replaces the date comparison with an
 * ancestry one — see its own doc for the exact check and why the direction
 * is the one it is, which is NOT the naive "declineHeadOid is an ancestor of
 * the rename" reading.
 *
 * `revisionMatch` returns `null`, not `false`, when this clone cannot
 * support an answer either way (a merged PR's raw, pre-squash-merge branch
 * tip is routinely unreachable within days of merge, even though GraphQL
 * keeps serving its oid) — and `null` falls back to the date-based
 * `dateMatch` for that PAIR, same as a candidate carrying no OID at all.
 * Falling back on a `false` verdict instead would have looked identical to
 * "genuinely not the same lineage" and silently dropped the * rename-equivalence signal for most of the population.
 */
export async function renameEquivalents(
  path: string,
  candidates: ReadonlyArray<RenameCandidate>,
  tip: string,
  /** The window's lower bound for the committer-date fallback (`dateMatch`)
   * ONLY — permissive by design: the caller widens this to the containing
   * PR's `mergedAt` when the decline thread carries no readable `createdAt`
   * of its own, matching `renameHistoryOf`'s "widen, never narrow" bias.
   * NEVER pass this to `revisionMatch`'s squash-merge tiebreaker — that
   * comparison DECIDES rather than merely narrows, and a widened stand-in
   * flowing into it can decisively exclude a genuine recurrence (see
   * `declineCreatedAtStrict` below, and `revisionMatch`'s own header). */
  since: string,
  /** The sweep's own `--until` CLI flag — a bare `YYYY-MM-DD`, or `''`. */
  windowUntil: string,
  /** The declining thread's own `reviewedHeadOid` — see the revision-based
   * section above. `null` falls back to the date-based path for every
   * candidate, same as before this parameter existed. */
  declineHeadOid: string | null,
  /** The declining thread's OWN, UNWIDENED `createdAt` — `''` when GitHub
   * reported none, never the containing PR's `mergedAt`. Threaded straight
   * to `revisionMatch`'s squash-merge tiebreaker, which must only decide on
   * a genuinely-observed timestamp. */
  declineCreatedAtStrict: string,
  /** The decline's own PR base ref (bare branch name, e.g. `develop`, or
   * `''` when unresolvable) — threaded to `revisionMatch`'s squash-merge
   * tiebreaker so it can confirm a candidate merge commit's PR actually
   * targeted the decline's own branch, not merely one it also happens to
   * satisfy `merge_commit_sha` for. */
  baseRefName: string,
  /** See `renameHistoryOf`'s own `cwd` — test-only. */
  cwd?: string,
): Promise<ReadonlySet<string>> {
  // A candidate's own `anchor` is already a full instant; the window
  // fallback is a bare date and needs the same end-of-day suffix
  // `laterFixCommits` and the old, window-wide bound both used, so both
  // paths reach `renameHistoryOf` as an equally-qualified `--until` value.
  const windowUntilQualified =
    windowUntil === "" ? "" : `${windowUntil}T23:59:59Z`;
  const out = new Set<string>();
  // Computed ONCE, not inside `revisionMatch` per candidate: `declineHeadOid`,
  // `cwd`, and whether this clone is shallow are all invariant across this
  // whole call, so re-checking any of them per candidate is a redundant git
  // subprocess per pair.
  const declineReachable =
    declineHeadOid != null && declineHeadOid !== ""
      ? await commitReachable(declineHeadOid, cwd)
      : false;
  const shallow = await isShallowRepo(cwd);
  for (const candidate of candidates) {
    if (candidate.path === path) continue;
    const revision =
      declineHeadOid != null &&
      declineHeadOid !== "" &&
      candidate.headOid != null &&
      candidate.headOid !== ""
        ? await revisionMatch(
            path,
            candidate.path,
            candidate.headOid,
            declineHeadOid,
            declineReachable,
            shallow,
            declineCreatedAtStrict,
            baseRefName,
            cwd,
          )
        : null;
    // `null` — no OID on one side, or the revision-based check could not
    // vouch for an answer — falls back to `dateMatch`, never to `false`.
    const matched =
      revision ??
      (await dateMatch(path, candidate, tip, since, windowUntilQualified, cwd));
    if (matched) out.add(renameCandidateKey(candidate));
  }
  return out;
}

/**
 * The revision-based equivalence check for one (decline, candidate) pair.
 * Returns `null` — not `false` — when this clone cannot vouch for an answer
 * either way; see `renameEquivalents`'s own "Revision-based match" section
 * for why that distinction is load-bearing.
 *
 * `declineReachable` is precomputed by the caller (`renameEquivalents`) once
 * per SWEEP-level `declineHeadOid` rather than re-checked here per candidate
 * — see that call site's own comment.
 * `candidateHeadOid` still varies per call, so its own reachability is
 * checked here.
 *
 * The hop where `hop.path === declinePath` is the rename record that turned
 * the decline's own pathname into (eventually) the candidate's. Two
 * ancestry facts are checked for that hop, and they are NOT symmetric in
 * what they prove:
 *
 *   - `isAncestor(hop.renamedIn, declineHeadOid)` — TRUE means the rename
 *     was already part of the develop state `declineHeadOid`'s own PR
 *     branch forked from, i.e. that incarnation of the pathname was already
 *     superseded by the time the decline observed it as a live file. This
 *     is DECISIVE: excluded, the revision-based analogue of
 *     `renameHistoryOf`'s own `since` exclusion, and it is sound under this
 *     repository's squash-merge topology (a PR branch's raw commits —
 *     what `reviewedHeadOid` names — are never an ancestor of anything
 *     downstream, so a positive answer here can only mean the rename
 *     predates the fork, never a false squash-merge artifact).
 *   - `false` is NOT the mirror-image proof that the rename postdates and
 *     RELATES to the decline. It only means the rename is not reachable
 *     from `declineHeadOid`'s own history — which is equally true whether
 *     the rename is a genuine continuation of the SAME finding, or a
 *     completely unrelated, coincidentally-named rename that landed on
 *     `develop` independently after the decline's branch forked and never
 *     touched it (the counterexample: decline forks, develop later renames an
 *     unrelated, reused pathname, decline's own thread is raised later still on
 *     its own untouched branch — ancestry alone cannot order these two).
 *
 * So only the EXCLUDING direction is asserted from ancestry alone. When
 * ancestry cannot decide (`alreadySuperseded === false`), `declineCreatedAt`
 * gives one more chance at a decisive answer before falling back to WIDENS
 *: if `hop.renamedIn` is itself the literal merge commit GitHub
 * created for some already-merged PR THAT TARGETED THIS DECLINE'S OWN
 * `baseRefName` — checked via `mergeCommitMergedAt`, never via this hop's
 * own committer date — that PR's `merged_at` is a SERVER-SET timestamp no
 * contributor could have backdated, unlike the raw branch commit dates
 * an earlier change removed trust from. If that `merged_at` predates
 * `declineCreatedAt`, the rename was already live on the decline's own base
 * branch before the decline's thread was even raised — the same "already
 * superseded" conclusion the ancestor-true branch reaches, just reached via
 * non-forgeable wall-clock order instead of reachability, for the one case
 * (genuinely diverged branches) where reachability alone cannot speak.
 *
 * Both inputs to this tiebreaker must be genuinely OBSERVED, never a
 * permissive stand-in, because unlike every other check in this function it
 * DECIDES rather than merely narrows: `baseRefName`
 * must be the decline's own PR base ref, never left blank or guessed, since
 * `mergeCommitMergedAt` only trusts a `merged_at` whose PR based against
 * that exact ref — a merge commit's `merged_at` for some OTHER branch this
 * commit also happens to satisfy `merge_commit_sha` for proves nothing about
 * when the rename reached the decline's own branch. And `declineCreatedAt`
 * must be the decline thread's own, unwidened `createdAt` (`''` when GitHub
 * reported none) — never `renameEquivalents`'s permissive `since`, which
 * silently substitutes the containing PR's `mergedAt` when the thread's own
 * timestamp is missing (see that function's own `since` vs
 * `declineCreatedAt` parameter docs). A widened stand-in flowing into this
 * NARROWING comparison could exclude a genuine recurrence whose rename
 * actually landed between the thread's real, unobserved `createdAt` and the
 * PR's later merge. `mergeCommitMergedAt` returning `null` — R is not itself
 * a merge commit into this exact base ref, most commonly because it is an
 * ordinary commit the candidate's own PR author made — falls through to the
 * untightened "WIDENS, never NARROWS" bias (see `renameHistoryOf`'s own
 * header, and the SAME FILE / TOUCHED signals `defect-escape.ts` reports
 * without counting): every `renameEquivalents` match feeds a REPORT a human
 * adjudicates, never an automated verdict, so an occasional false RE-FOUND
 * costs one human double-check — the safer failure mode for the * recall trade this script measures, exactly the direction an earlier change itself
 * exists to protect. A postdating (or equal, or unparsable) `merged_at`
 * falls through to the same WIDENS default: postdating is CONSISTENT with a
 * genuine recurrence, not proof of one, so it earns the same
 * human-adjudicated report as the no-tiebreaker-available case, never an
 * automated include. An empty `declineCreatedAt` reaches the identical
 * WIDENS default through `epochMsOf('')`'s own `null` — no separate branch
 * needed to skip the tiebreaker when the thread's own timestamp is unknown.
 *
 * The upper bound (`until`) needs no analogue at all: `hops` only ever
 * contains ancestors of the candidate's own `headOid` in the first place, so
 * nothing postdating the candidate's own revision can appear in it.
 *
 * A `null` from either `isAncestor` call is propagated immediately as this
 * function's own `null` — an undeterminable ancestry answer must fall back
 * to `dateMatch` at the `renameEquivalents` level, not be silently folded
 * into "not a match for this hop", which would contradict this function's
 * own nullable contract. The squash-merge tiebreaker does NOT extend this
 * `null`-propagation contract: an inconclusive `mergeCommitMergedAt` lookup
 * (network failure, no matching merge commit) is exactly the older
 * "ancestry alone cannot decide" case, so it resolves to the WIDENS `true`
 * this function already returned for it, not to a fresh `null`.
 *
 * `shallow` (precomputed once by `renameEquivalents`, same reason as
 * `declineReachable`) short-circuits straight to `null` whenever it is
 * anything but a CONFIRMED `false` — see `isShallowRepo`'s own doc for why
 * object-existence alone is not enough to trust a `--follow` walk's
 * completeness in a shallow clone, and why an undeterminable shallow-check
 * answer must not be read as "confirmed not shallow" either.
 */
async function revisionMatch(
  declinePath: string,
  candidatePath: string,
  candidateHeadOid: string,
  declineHeadOid: string,
  declineReachable: boolean,
  shallow: boolean | null,
  /** The declining thread's OWN, UNWIDENED `createdAt` (already a full ISO
   * instant, or `''` when GitHub reported none) — NEVER
   * `renameEquivalents`'s permissive `since`, which may substitute the
   * containing PR's `mergedAt` for a different purpose. See this function's
   * own header for why the distinction is load-bearing here specifically
   *. */
  declineCreatedAt: string,
  /** The decline's own PR base ref (bare branch name, e.g. `develop`, or
   * `''` when unresolvable) — threaded to `mergeCommitMergedAt` so the
   * squash-merge tiebreaker only trusts a `merged_at` from a PR that
   * actually targeted THIS branch. */
  baseRefName: string,
  cwd?: string,
): Promise<boolean | null> {
  if (!declineReachable || shallow !== false) return null;
  if (!(await commitReachable(candidateHeadOid, cwd))) return null;
  const hops = await renameHistoryFromRevision(
    candidatePath,
    candidateHeadOid,
    cwd,
  );
  if (hops === null) return null;
  for (const hop of hops) {
    if (hop.path !== declinePath) continue;
    const alreadySuperseded = await isAncestor(
      hop.renamedIn,
      declineHeadOid,
      cwd,
    );
    if (alreadySuperseded === null) return null;
    if (alreadySuperseded) continue;
    // Ancestry alone cannot decide — try the non-forgeable squash-merge
    // tiebreaker before falling back to the WIDENS default.
    const declineEpochMs = epochMsOf(declineCreatedAt);
    if (declineEpochMs !== null) {
      const renameMergedAt = await mergeCommitMergedAt(
        hop.renamedIn,
        baseRefName,
        cwd,
      );
      const renameEpochMs =
        renameMergedAt === null ? null : epochMsOf(renameMergedAt);
      if (renameEpochMs !== null && renameEpochMs < declineEpochMs) {
        continue;
      }
    }
    return true;
  }
  return false;
}

/**
 * The older committer-date walk, kept as `renameEquivalents`'s
 * fallback for a pair where either side lacks a reviewed-head OID (a thread
 * predating the `originalCommit` GraphQL field, or one whose referenced
 * commit has since become unreachable). See `renameHistoryOf`'s own header
 * for the full rationale this preserves unchanged.
 */
async function dateMatch(
  declinePath: string,
  candidate: RenameCandidate,
  tip: string,
  since: string,
  windowUntilQualified: string,
  cwd?: string,
): Promise<boolean> {
  const until =
    candidate.anchor === "" ? windowUntilQualified : candidate.anchor;
  const candidateHistory = await renameHistoryOf(
    candidate.path,
    tip,
    since,
    until,
    cwd,
  );
  return candidateHistory.includes(declinePath);
}

export interface MergedPr {
  number: number;
  title: string;
  mergedAt: string;
}

/**
 * Every merged PR in the window, newest first, as `gh pr list` reports them.
 *
 * Exported for `fractal-metrics.ts`, which sweeps the same kind of window and
 * must enumerate it by the identical, validated query rather than a second copy.
 */
export async function mergedPrs(
  since: string,
  until: string,
  limit: number,
): Promise<MergedPr[]> {
  const r = await ghCall(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      // Both ends when we have them — see the header. GitHub's `a..b` range is
      // inclusive at both, which is what reproduces a recorded window.
      until === "" ? `merged:>=${since}` : `merged:${since}..${until}`,
      "--limit",
      String(limit),
      "--json",
      "number,title,mergedAt",
    ],
    { stderr: "ignore" },
  );
  if (r.code !== 0) fail(1, "defect-escape: could not list merged PRs");
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return fail(1, "defect-escape: `gh pr list` returned unparsable JSON");
  }
  // Parseable is not well-shaped. A non-array, or a record whose `number` is
  // not a positive integer, would otherwise reach `samplePr` and fail there as
  // an unreadable PR — the same exit code for a completely different cause, and
  // a message pointing at GitHub rather than at the payload.
  if (!Array.isArray(parsed)) {
    return fail(1, "defect-escape: `gh pr list` did not return a JSON array");
  }
  return parsed.map((raw, i) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    // `typeof` first: `Number("4068")` is a valid integer, and this validator
    // exists precisely to tell a schema-invalid payload from an unreadable PR.
    // Matches `count()`'s contract, which type-checks before coercing.
    const number = typeof p.number === "number" ? p.number : Number.NaN;
    if (!Number.isInteger(number) || number < 1) {
      fail(
        1,
        `defect-escape: \`gh pr list\` entry ${i} has no usable PR number (${JSON.stringify(p.number)})`,
      );
    }
    // `mergedAt` is validated as hard as `number`, because it is load-bearing
    // in the same way: the sample is SORTED by it, and `samples.slice(i + 1)`
    // then defines the later-PR population every recurrence is drawn from. An
    // empty string sorts first, so one malformed field silently moves a PR to
    // the head of the window and adds or omits recurrence candidates while the
    // run still reports a confident baseline.
    const mergedAt = typeof p.mergedAt === "string" ? p.mergedAt : "";
    if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?$/.test(mergedAt)) {
      fail(
        1,
        `defect-escape: \`gh pr list\` entry ${i} (PR #${number}) has no usable \`mergedAt\` (${JSON.stringify(p.mergedAt)}).`,
        "The window is ordered by this field, so a malformed one silently reorders the sample.",
      );
    }
    return {
      number,
      title: typeof p.title === "string" ? p.title : "",
      mergedAt,
    };
  });
}

/**
 * A real calendar date in `YYYY-MM-DD`, or `null`.
 *
 * The shape test alone is not enough, and the failure is silent rather than
 * loud: GitHub's search accepts `2026-99-99` and `2026-02-31` and answers with
 * ZERO results, which this tool would then report as a legitimate
 * no-declines-in-the-window sample — a real, documented answer that happens to
 * be about a window that does not exist (measured against the live API).
 */
export function calendarDate(raw: string): string | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asDate = new Date(Date.UTC(y, mo - 1, d));
  // Round-tripping catches every overflow at once — month 13, February 31, and
  // a non-leap February 29 — rather than re-deriving the calendar here.
  return asDate.getUTCFullYear() === y &&
    asDate.getUTCMonth() === mo - 1 &&
    asDate.getUTCDate() === d
    ? raw
    : null;
}

/**
 * One line's worth of a reason; the full text stays in `--json`.
 *
 * Cut by CODE POINT, not by UTF-16 unit: reasons routinely carry `—`, `→` and
 * the occasional emoji, and `String.slice` at an arbitrary index can land
 * between a surrogate pair and emit a replacement character.
 */
function clip(reason: string): string {
  const flat = reason.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= REASON_DISPLAY_CHARS
    ? flat
    : `${points.slice(0, REASON_DISPLAY_CHARS).join("")}…`;
}

/** `#N` for each distinct PR, ascending. */
function prNumbers(refinds: Refind[]): string[] {
  return [...new Set(refinds.map((r) => r.pr))]
    .sort((a, b) => a - b)
    .map((n) => `#${n}`);
}

/** `--ladder-only`'s narrowing, reported so the sample is never over-read. */
export interface LadderScope {
  marker: string;
  /** Declines excluded because their reply carries no ladder marker. */
  excluded: number;
  /**
   * Of the declines that DID carry the marker, how many also carry
   * `triage-ladder.ts`'s own rendered prose — a diagnostic the reader
   * spot-checks, never a filter.
   *
   * The distinction is load-bearing. Matching the full rendered template was
   * tried as the FILTER and reverted (`.config/review-triage.yaml` §
   * `reply.marker`): rewording `wont_fix`/`deferred` is
   * ordinary copy maintenance, and tying the filter to that prose silently
   * orphaned every reply already posted under the old wording. As a REPORTED
   * number the same match costs nothing — a reword makes this count drop
   * without removing a single decline from the sample, and the line says to
   * read the remainder by hand rather than to trust it.
   *
   * It is also the only per-run evidence against the pollution
   * `ladderDeclinePatterns` cannot rule out by construction — but
   * it is not a BOUND in either direction.
   * `MACRO_PROSE` is an unanchored substring match against the CURRENT
   * template wording: a hand-written decline that copies the whole macro
   * clause still counts here, overcounting genuine macro output, while a
   * genuine macro-rendered reply from a config version whose wording has
   * since moved on does not match, undercounting it. Read the ratio only as
   * the spot-check prompt it is.
   */
  macroShaped: number;
}

/**
 * The scope statement for `--ladder-only`, factored out of `render()`
 * so `--json` carries the identical caveat instead of a silently drifting
 * second copy of the prose: `--json` is
 * the monthly calibration read's own invocation
 * (`triage-rubric.md` § Calibrating the ladder), not a side channel the
 * disclosure can afford to skip.
 */
export interface LadderDisclosure {
  /** Marker presence, not ladder provenance — the caveat in full. */
  scopeCaveat: string;
  /** The direction pollution biases the sample toward. Always tightening. */
  bias: "tightening";
  /** Where the truth question (a drifting series) is actually owned. */
  owner: string;
  /** `${macroShaped}/${declineCount}`. */
  macroShapedRatio: string;
  /** What the ratio does, and does not, establish at this value. */
  macroShapedNote: string;
}

export function ladderDisclosureOf(
  ladder: LadderScope,
  declineCount: number,
): LadderDisclosure {
  const matchesTemplateShape =
    declineCount > 0 && ladder.macroShaped === declineCount;
  return {
    scopeCaveat:
      "derives MARKER PRESENCE, not ladder provenance — the marker is public reply text, so a hand-written decline closing with the same line is counted here too, inflating the denominator of the escape rate and making escapes look RARER — the direction that licenses declining MORE, not less.",
    bias: "tightening",
    owner: ".config/review-triage.yaml § calibration",
    macroShapedRatio: `${ladder.macroShaped}/${declineCount}`,
    macroShapedNote: matchesTemplateShape
      ? "(matches the rendered template shape — NOT proof against pollution; a hand-copied clause matches this too)"
      : "— READ THE REMAINDER BY HAND",
  };
}

/**
 * `triage-ladder.ts`'s rendered `wont_fix`/`deferred` prose, as emitted from
 * `.config/review-triage.yaml`'s templates. Deliberately loose about the
 * placeholders and about the sentence AROUND this clause: the point is to
 * distinguish "the macro wrote this" from "someone pasted the marker line",
 * not to re-pin the templates' full wording, which would tie the count to
 * ordinary copy maintenance. A reword of the surrounding sentences leaves this intact; a
 * reword of this clause itself makes the reported count drop, which reads as
 * a prompt to look rather than as a lost decline.
 */
export const MACRO_PROSE =
  /declined (?:by|for THIS PR by) the [^(]+\([^)]*band `[^`]+`, round \d+\)/;

export function render(
  declines: Decline[],
  since: string,
  until: string,
  scanned: number,
  capped: boolean,
  superseded: number,
  withheld: number,
  tiedPairs: number,
  ladder: LadderScope | null,
): string {
  const lines: string[] = [];
  lines.push(
    `── defect-escape sample — merged ${until === "" ? `since ${since} (open-ended: NOT reproducible — pass --until)` : `${since} → ${until}`} ──`,
  );
  if (ladder !== null) {
    lines.push(
      `  --ladder-only: population narrowed to replies carrying '${ladder.marker}';`,
    );
    lines.push(
      `    ${ladder.excluded} other declined finding(s) in this window are NOT in the counts below.`,
    );
    // The scope of the verdict belongs in the OUTPUT, not only in the source
    // comment — the reader who over-reads this sample is reading the
    // summary. Printed on
    // every `--ladder-only` run, including a clean one, and it names the
    // owner (the monthly calibration read) rather than stopping at the
    // disclaimer.
    //
    // Built from `ladderDisclosureOf` — the single source `--json` reads too
    // — rather than a hand-maintained
    // second copy of this prose, which is exactly how the two drift.
    const disclosure = ladderDisclosureOf(ladder, declines.length);
    lines.push(`    This narrowing ${disclosure.scopeCaveat}`);
    lines.push(
      `    Spot-check the macro-prose count below; the series is owned by the`,
    );
    lines.push(`    monthly read in ${disclosure.owner}.`);
    lines.push(
      `    ${disclosure.macroShapedRatio} carry triage-ladder.ts's rendered prose as well as the marker ${disclosure.macroShapedNote}.`,
    );
  }
  lines.push(
    `  ${scanned} merged PR(s) scanned${capped ? " (--limit bound; widen it to cover the whole window)" : ""}`,
  );
  lines.push(
    `  ${declines.length} declined finding(s): wont-fix ${declines.filter((d) => d.outcome === "wont-fix").length}, deferred ${declines.filter((d) => d.outcome === "deferred").length}`,
  );
  if (superseded > 0) {
    lines.push(
      `  ${superseded} possibly re-raised and fixed in their own PR (reported, NOT excluded — adjudicate by hand)`,
    );
  }
  // A thread whose comments could not all be read has its outcome WITHHELD
  // rather than guessed, so a declined one is invisible to the loop above and
  // silently leaves the denominator. Unreported, that turns an incomplete
  // sample into a confident escape rate.
  // Reported rather than fatal: a top-up failure on one thread should not void
  // a whole week's sweep, and the reader needs the magnitude to judge it.
  // Not a footnote: excluding ties is what stops an unestablished order
  // manufacturing a recurrence, and an unreported exclusion reads as "nothing
  // came back" (the "no silent caps" rule).
  if (tiedPairs > 0) {
    lines.push(
      `  ${tiedPairs} PR pair(s) share a merge timestamp — neither is treated as later than`,
    );
    lines.push(
      "    the other, so a recurrence between them is not counted in either direction.",
    );
  }
  if (withheld > 0) {
    lines.push(
      `  ⚠ ${withheld} thread(s) had an UNREADABLE outcome (comments truncated, top-up failed) —`,
    );
    lines.push(
      "    any decline among them is missing from the counts above, so treat this",
    );
    lines.push("    sample as a LOWER BOUND on declines and on escape.");
  }
  const refound = declines.filter((d) => d.refoundIn.some(isRecurrence));
  const otherSignal = declines.filter(
    (d) => d.refoundIn.length > 0 && !d.refoundIn.some(isRecurrence),
  );
  const deferredNoIssue = declines.filter(
    (d) => d.outcome === "deferred" && d.followUps.length === 0,
  );
  lines.push(
    `  ${refound.length} re-found near the same anchor AFTER the decline · ${otherSignal.length} with a weaker match only (not counted) · ${deferredNoIssue.length} deferral(s) naming no follow-up issue`,
  );
  if (declines.length === 0) {
    lines.push("");
    lines.push(
      "  No declined findings in this window. That is a real answer, not an empty",
    );
    lines.push(
      "  one — it means the loop accepted or rejected everything it was shown.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  for (const d of declines) {
    lines.push(
      `  #${d.pr} [${d.outcome}/${d.category}] ${d.path ?? "(unanchored)"}${d.line === null ? "" : `:${d.line}`}`,
    );
    lines.push(`      by ${d.startedBy ?? "unknown"} — ${clip(d.reason)}`);
    if (d.url !== null) lines.push(`      ${d.url}`);
    // Deduped by PR: one later PR can carry several accepted threads on the
    // same file, and listing `#42` five times says nothing the first said.
    // The three buckets partition `refoundIn` exactly, so a candidate is always
    // visible and only the recurrences are counted.
    // `after` is false for two different reasons — genuinely raised earlier, or
    // an ordering that could not be READ because a timestamp was missing — and
    // the concurrent bucket used to assert the first for both. "Raised at or
    // before this decline" is a claim, and it is not one an absent timestamp
    // supports. Ordering is only established when both
    // ends exist; otherwise the candidate is reported as unknown-ordering.
    // Still uncounted either way: only `isRecurrence` counts.
    const ordered = (r: Refind): boolean =>
      r.raisedAt !== null && d.declinedAt !== null;
    const near = prNumbers(d.refoundIn.filter(isRecurrence));
    const concurrent = prNumbers(
      d.refoundIn.filter((r) => r.proximate && ordered(r) && !r.after),
    );
    const unknownOrder = prNumbers(
      d.refoundIn.filter((r) => r.proximate && !ordered(r)),
    );
    const far = prNumbers(d.refoundIn.filter((r) => !r.proximate));
    if (near.length > 0) {
      lines.push(
        `      RE-FOUND: accepted within ${PROXIMITY_LINES} lines of this anchor, raised after the decline, in ${near.join(", ")}`,
      );
      // A rename-traced match matched a DIFFERENT path string than the
      // decline's own — disclosed rather than presented identically to a
      // same-name match, per this file's own rule for every other derived
      // signal.
      const renamedTo = [
        ...new Set(
          d.refoundIn
            .filter(
              (r) => isRecurrence(r) && r.path !== null && r.path !== d.path,
            )
            .map((r) => r.path as string),
        ),
      ];
      if (renamedTo.length > 0) {
        lines.push(
          `        traced through a rename — now ${renamedTo.join(", ")}`,
        );
      }
    }
    if (concurrent.length > 0) {
      lines.push(
        `      same anchor but raised at or before this decline — concurrent, not counted: ${concurrent.join(", ")}`,
      );
    }
    if (unknownOrder.length > 0) {
      lines.push(
        `      same anchor, ORDERING UNREADABLE (a timestamp is missing) — not counted: ${unknownOrder.join(", ")}`,
      );
    }
    if (far.length > 0) {
      lines.push(`      same file (not counted): ${far.join(", ")}`);
    }
    if (d.followUps.length > 0) {
      lines.push(`      FOLLOW-UP: ${d.followUps.join(", ")}`);
    } else if (d.outcome === "deferred") {
      lines.push(
        "      FOLLOW-UP: none named — a deferral without an issue is itself a finding",
      );
    }
    if (d.laterFixCommits.length > 0) {
      lines.push(
        `      TOUCHED: ${d.laterFixCommits.length} later fix commit(s) on this file — weak signal, check by hand`,
      );
      for (const c of d.laterFixCommits.slice(0, 3)) {
        lines.push(`        ${c}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "  A verdict per finding is yours. Record it in the baseline doc:",
  );
  lines.push(`    ${baselineDocPath()}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The `--json` payload. Factored out of `main()` so a test can call the exact
 * function the CLI's `--json` branch calls, rather than a hand-written
 * re-implementation of it that could pass while the real branch drifts
 * (a suite that only exercises `render()` directly cannot fail if `--json`
 * stops carrying the ladder's scope disclosure).
 */
export interface JsonPayload {
  since: string;
  until: string;
  limit: number;
  capped: boolean;
  scanned: number;
  superseded: number;
  withheld: number;
  tiedPairs: number;
  ladder: (LadderScope & { disclosure: LadderDisclosure }) | null;
  declines: Decline[];
}

export function buildJsonPayload(
  declines: Decline[],
  since: string,
  until: string,
  limit: number,
  scanned: number,
  capped: boolean,
  superseded: number,
  withheld: number,
  tiedPairs: number,
  ladder: LadderScope | null,
): JsonPayload {
  return {
    since,
    until,
    limit,
    capped,
    scanned,
    superseded,
    withheld,
    tiedPairs,
    ladder:
      ladder === null
        ? null
        : {
            ...ladder,
            disclosure: ladderDisclosureOf(ladder, declines.length),
          },
    declines,
  };
}

async function main(): Promise<number> {
  let since = "";
  let until = "";
  let limit = 40;
  let json = false;
  let ladderOnly = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--ladder-only") ladderOnly = true;
    else if (a === "--since") {
      since = argv[++i] ?? "";
    } else if (a === "--until") {
      until = argv[++i] ?? "";
    } else if (a === "--limit") {
      const raw = argv[++i] ?? "";
      const parsed = Number.parseInt(raw, 10);
      // `Number.isSafeInteger`, not just the digit shape: a long enough run of
      // digits parses to `Infinity` or to a value past 2^53 that has already
      // lost precision, and `limit + 1` then reaches `gh pr list` as something
      // it never asked for.
      //
      // Bounded BELOW `MAX_SAFE_INTEGER` rather than at it, because the fetch
      // asks for `limit + 1` (see `main`): accepting the very top of the safe
      // range would hand `gh pr list` precisely the unsafe value this check
      // exists to keep away from it, turning a formally accepted CLI input into
      // a GitHub-invocation failure instead of a usage error.
      if (
        !/^[0-9]+$/.test(raw) ||
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed >= Number.MAX_SAFE_INTEGER
      ) {
        fail(2, "--limit takes a whole number of PRs, at least 1");
      }
      limit = parsed;
    } else fail(2, `unknown argument: ${a}`);
  }
  // The dates go straight into GitHub's search syntax, so each is constrained
  // to the one shape that syntax means rather than trusted: a free string would
  // silently become a qualifier of its own and change what the whole search
  // matches, and an impossible-but-well-shaped one returns an empty window that
  // reads as a real answer (see `calendarDate`).
  const USAGE = [
    "usage: defect-escape.ts --since YYYY-MM-DD [--until YYYY-MM-DD] [--limit N] [--ladder-only] [--json]",
    "A week is enough for the baseline. Pass --until to reproduce a",
    "RECORDED window — without it the window grows with the repository.",
  ] as const;
  if (calendarDate(since) === null) {
    fail(2, ...USAGE);
  }
  if (until !== "" && calendarDate(until) === null) {
    fail(2, ...USAGE);
  }
  if (until !== "" && until.localeCompare(since) < 0) {
    fail(2, `--until ${until} is before --since ${since}`, ...USAGE);
  }

  // Resolved BEFORE the sweep: a marker that cannot be read makes the whole
  // run meaningless, and discovering that after a week's worth of GitHub
  // round-trips wastes them. Dynamically imported so a drive-pr copy installed
  // without its sibling skill still runs every OTHER mode — a static import
  // would fail at module load for callers that never pass this flag.
  let ladderMarkerText = "";
  let ladderPatterns: RegExp[] = [];
  if (ladderOnly) {
    let resolved: {
      patterns: RegExp[] | null;
      marker: string | null;
      anomaly: string;
    };
    try {
      const mod = await import(
        "../../resolve-review-comments/scripts/lib/ladder.ts"
      );
      resolved = await mod.ladderDeclinePatterns();
    } catch (err) {
      return fail(
        1,
        `defect-escape: --ladder-only needs the resolve-review-comments skill's ladder module, which could not be loaded (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    if (
      resolved.patterns === null ||
      resolved.marker === null ||
      resolved.marker === ""
    ) {
      return fail(
        1,
        `defect-escape: --ladder-only could not resolve the ladder's reply marker (${resolved.anomaly || "empty marker"}).`,
        'Refusing to sample: an unfiltered or empty population would read as "no escapes".',
      );
    }
    ladderMarkerText = resolved.marker;
    ladderPatterns = resolved.patterns;
  }

  const repo = await resolveRepo();
  const followUp = followUpPattern(consumerTeamKey());
  // One MORE than asked for, so "the cap bound" is witnessed by an extra result
  // rather than inferred from `length === limit` — a window holding exactly
  // `limit` PRs is complete, and reporting it as truncated tells a reader to
  // widen a bound that is not binding.
  const listed = await mergedPrs(since, until, limit + 1);
  const capped = listed.length > limit;
  const prs = listed.slice(0, limit);

  // Sampled oldest-first so "re-found in a LATER PR" can be answered from
  // what has already been read, with no second pass over the window.
  //
  // Sorted for a DETERMINISTIC iteration order, tie-broken on PR number so a
  // rerun visits the window identically. `mergedAt` has finite precision and
  // `gh pr list` hands us newest-first, so without the tie-break an equal pair
  // kept its input order.
  //
  // The sort no longer decides WHO IS LATER, and that distinction is the whole
  // point. Slicing with `samples.slice(i + 1)` would make the tie-break define
  // the later-PR population — so a same-second PR with a higher number could be
  // counted as a recurrence of the other, on an order the timestamps never
  // established. Downstream strictness does not prevent that, because
  // thread-level ordering only filters WITHIN the candidate set while
  // membership was already decided here.
  //
  // `laterThan` therefore requires a STRICTLY greater `mergedAt`, which is the
  // same strict-ordering discipline `isRecurrence` and the CONCURRENT bucket
  // already apply. Ties are excluded in both directions — symmetric, so neither
  // PR is asserted to follow the other — and counted, because a silently
  // dropped candidate reads as "nothing came back".
  const ordered = [...prs].sort(
    (a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number,
  );
  const samples: PrSample[] = [];
  for (const p of ordered) {
    // `history: false` — this sweep reads threads only, and the commit and
    // review connections are two more paginating round-trips per PR across a
    // whole week's worth of them.
    // `asOf` freezes outcomes at the window's own end, so a reply added or
    // edited after the recorded window cannot rewrite its outcome mix,
    // denominator or escape rate on a later re-run. Open-ended `--until` means
    // "as of now", which is right for a fresh measurement and is exactly the
    // case the header already warns is not reproducible.
    samples.push(
      await samplePr(p.number, repo, {
        history: false,
        ...(until === "" ? {} : { asOf: `${until}T23:59:59Z` }),
      }),
    );
  }

  // Strictly-later PRs only; see the sort's comment. `samples[j]` is the sample
  // for `ordered[j]`, so the index is the join between the two.
  // Counted ONCE over the window, not inside `laterThan` — that runs per
  // decline, so counting there would multiply one tie by the number of
  // declined findings in the PR and report a tally of the wrong thing.
  let tiedPairs = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      if ((ordered[i]?.mergedAt ?? "") === (ordered[j]?.mergedAt ?? "")) {
        tiedPairs += 1;
      }
    }
  }

  const laterThan = (i: number): PrSample[] => {
    const mine = ordered[i]?.mergedAt ?? "";
    const out: PrSample[] = [];
    for (let j = 0; j < samples.length; j++) {
      if (j === i) continue;
      if ((ordered[j]?.mergedAt ?? "") > mine) out.push(samples[j] as PrSample);
    }
    return out;
  };

  const declines: Decline[] = [];
  let superseded = 0;
  let withheld = 0;
  let ladderExcluded = 0;
  let ladderMacroShaped = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as PrSample;
    const merged = ordered[i]?.mergedAt ?? s.mergedAt ?? "";
    for (const t of s.threads) {
      // Withheld, not absent: `commentsTruncated` means the outcome could not
      // be read, so this thread may be a decline that never reaches the
      // denominator. Counted here and reported, per `render`.
      if (t.outcome === null && t.commentsTruncated) withheld += 1;
      if (t.outcome === null || !DECLINED_OUTCOMES.has(t.outcome)) continue;
      // `--ladder-only`: the FULL settling reply, same field the follow-up
      // scan reads, because the marker sits in the macro's body rather than
      // its first line. Filtered here — before the rename/refind work — so a
      // narrowed run is cheaper as well as narrower. Matched against the
      // template's own text boundaries (`ladderDeclinePatterns`), not a bare
      // marker substring — a reply merely mentioning the ladder in prose is
      // not a ladder decline.
      if (
        ladderOnly &&
        !ladderPatterns.some((p) => p.test(t.settledBody ?? t.reason ?? ""))
      ) {
        ladderExcluded += 1;
        continue;
      }
      // Kept as a DIAGNOSTIC on the admitted decline, never as a second
      // filter: a marker-carrying decline that does not also carry the
      // macro's prose stays in the sample and is reported for a human to
      // look at. See `LadderScope.macroShaped` for why reporting is safe
      // where filtering on this same match was reverted.
      if (ladderOnly && MACRO_PROSE.test(t.settledBody ?? t.reason ?? "")) {
        ladderMacroShaped += 1;
      }
      // Possibly re-raised and fixed inside its own PR, which would mean it
      // never shipped. REPORTED, never dropped — the same proximity heuristic
      // is only ~1-in-4 precise here, so letting it silently remove a decline
      // would move the published denominator on a coin flip. See
      // `supersededCandidateInOwnPr`.
      const supersededCandidate = supersededCandidateInOwnPr(t, s.threads);
      if (supersededCandidate) superseded += 1;
      const later = laterThan(i);
      // Every `accepted` candidate path in the later population that failed
      // an exact match against this decline's own path, mapped to that
      // candidate THREAD's OWN `createdAt` — the population `renameEquivalents`
      // checks for a shared rename history, each bounded to its own temporal
      // window rather than the sweep's whole one. Built
      // fresh per decline: `t.path` varies, so a list built once for the
      // whole sweep would have to be keyed by it anyway.
      //
      // Every distinct (path, thread) OCCURRENCE, never deduplicated to one
      // entry per pathname: two threads can share a literal pathname while
      // being different incarnations of it, and collapsing to a single entry
      // per string would apply whichever occurrence's own anchor happened to
      // win the collapse to every OTHER occurrence too, silently misjudging
      // them.
      //
      // THE THREAD's own `createdAt`, not its PR's `mergedAt`: a rename can
      // land LATER in the same PR, after the accepted thread was already
      // raised against whatever the file was at THAT moment — bounding by the
      // whole PR's merge time still let a same-PR, later rename manufacture a
      // match against a thread that predates it. Falls back to `''` (the
      // sweep's own open window) when the thread carries no readable
      // `createdAt`, NOT to the containing PR's `mergedAt` — `samePath` below
      // re-derives this same anchor from the bare `ThreadSample` alone (no
      // `PrSample` in scope there), so both computations must agree exactly for
      // the composite lookup key to match; a PR-level fallback only available
      // here would silently diverge from the fallback `samePath` can actually
      // compute.
      const candidates: RenameCandidate[] = [];
      for (const ls of later) {
        for (const lt of ls.threads) {
          if (
            lt.outcome === "accepted" &&
            lt.path !== null &&
            lt.path !== t.path
          ) {
            candidates.push({
              path: lt.path,
              anchor: lt.createdAt ?? "",
              headOid: lt.reviewedHeadOid,
            });
          }
        }
      }
      const tip = s.baseRefName === "" ? "HEAD" : `origin/${s.baseRefName}`;
      // The decline THREAD's own `createdAt`, not its PR's `mergedAt` — the
      // same precision fix as the candidate side. Deliberately `createdAt`
      // rather than `declinedAtOf` (settled, else raised): the decline first
      // presented `path` as this specific file the moment the comment was
      // POSTED, and `createdAt` is never later than `settledAt` — using the
      // earlier of the two keeps `since` as permissive as the underlying
      // fact supports, matching `renameHistoryOf`'s own "widen, never
      // narrow" bias rather than needlessly excluding a rename that landed
      // between the thread being raised and it being settled.
      const since = t.createdAt ?? merged;
      const renamed =
        t.path === null
          ? new Set<string>()
          : await renameEquivalents(
              t.path,
              candidates,
              tip,
              since,
              until,
              t.reviewedHeadOid,
              // Deliberately NOT `since` — the squash-merge tiebreaker needs
              // the thread's own, unwidened timestamp, never the `?? merged`
              // fallback. See `renameEquivalents`'s own parameter doc.
              t.createdAt ?? "",
              s.baseRefName,
            );
      const samePath = (candidate: ThreadSample): boolean =>
        candidate.path === t.path ||
        (candidate.path !== null &&
          renamed.has(
            renameCandidateKey({
              path: candidate.path,
              anchor: candidate.createdAt ?? "",
              headOid: candidate.reviewedHeadOid,
            }),
          ));
      const refoundIn: Refind[] = refindsFor(t, later, samePath);
      declines.push({
        pr: s.pr,
        prTitle: s.title,
        mergedAt: merged,
        outcome: t.outcome,
        path: t.path,
        line: anchorLine(t),
        reason: t.reason ?? "",
        category: t.category,
        url: t.url,
        startedBy: t.startedBy,
        declinedAt: declinedAtOf(t),
        supersededCandidate,
        refoundIn,
        // The FULL settling reply, not just its first line: the deferral
        // protocol permits the issue link to sit further down, and
        // `reason` is only line one. See `ThreadSample.settledBody`.
        followUps: [
          ...new Set((t.settledBody ?? t.reason ?? "").match(followUp) ?? []),
        ],
        laterFixCommits:
          t.path === null || merged === ""
            ? []
            : await laterFixCommits(
                t.path,
                merged,
                s.baseRefName,
                s.mergeCommitOid,
                until,
              ),
      });
    }
  }

  const ladder: LadderScope | null = ladderOnly
    ? {
        marker: ladderMarkerText,
        excluded: ladderExcluded,
        macroShaped: ladderMacroShaped,
      }
    : null;
  process.stdout.write(
    json
      ? `${JSON.stringify(
          buildJsonPayload(
            declines,
            since,
            until,
            limit,
            prs.length,
            capped,
            superseded,
            withheld,
            tiedPairs,
            ladder,
          ),
          null,
          2,
        )}\n`
      : render(
          declines,
          since,
          until,
          prs.length,
          capped,
          superseded,
          withheld,
          tiedPairs,
          ladder,
        ),
  );
  return 0;
}

// Gated behind isEntryPoint rather than run at module scope: this module's
// side effect is a live GitHub sweep, so importing it unconditionally — the
// pattern this family's pure helpers otherwise support — would run it for
// real. The predicate is `lib/cli.ts`'s, no longer inlined here — see
// round-plan.ts's note for the symlink case the inline form got wrong
//. This is what lets `renameHistoryOf`/
// `renameEquivalents` be imported and tested directly against a real git
// repo without triggering the CLI ("the claimed
// rename-following coverage only injects a hand-written predicate and never
// exercises the new Git-backed resolver").
if (isEntryPoint(import.meta.url)) runMain("defect-escape", main);
